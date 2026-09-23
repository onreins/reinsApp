// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title RatchetVault
 * @notice Unidirectional payment channels for metered, pay-per-call API usage on Arc.
 *
 * A payer opens a channel to a single provider and funds it with native USDC.
 * On every API call the payer signs an off-chain EIP-712 voucher naming the
 * *cumulative* amount owed so far. Vouchers only ever ratchet upward, so the
 * provider can discard every voucher but the latest: redeeming that one settles
 * the entire history in a single transaction.
 *
 * Thousands of paid calls therefore cost two on-chain transactions, not two thousand.
 *
 * Arc-specific notes:
 *  - The native token is USDC with 18 decimals. All amounts here are 18-decimal USDC.
 *    (The ERC-20 view of the same balance uses 6 decimals; divide by 1e12 to display.)
 *  - Arc block timestamps are only guaranteed non-decreasing, never strictly
 *    increasing, so every deadline in this contract is denominated in block numbers.
 *  - Arc forbids value transfers to the zero address, so payout targets are never unset.
 */
contract RatchetVault {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    struct Channel {
        address payer;
        address provider;
        uint256 deposit; // total USDC ever funded into this channel
        uint256 claimed; // cumulative USDC already pulled by the provider
        uint64 challengeBlocks; // cooldown the payer must wait out to reclaim funds
        uint64 closeAtBlock; // 0 while open; else the block the payer may sweep at
    }

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    /// @dev Arc produces a block roughly every 0.48s, so ~7,500 blocks is about an hour.
    ///      This floor guarantees a provider always has time to redeem outstanding
    ///      vouchers before a payer can walk away with the balance.
    uint64 public constant MIN_CHALLENGE_BLOCKS = 7_500;

    /// @dev Roughly a year at 0.5s blocks. Without a ceiling, a payer could open
    ///      a channel whose `block.number + challengeBlocks` overflows uint64,
    ///      which makes `initiateClose` revert forever and strands their own
    ///      remainder. Checked arithmetic turns that into a permanent brick
    ///      rather than a wrap, so it is refused at the door.
    uint64 public constant MAX_CHALLENGE_BLOCKS = 63_072_000;

    /// @dev Gas forwarded to a payout recipient. Anything needing more than this gets
    ///      credited to `withdrawable` instead, so one awkward recipient can never
    ///      block the counterparty's settlement.
    uint256 private constant PAYOUT_GAS = 100_000;

    bytes32 private constant VOUCHER_TYPEHASH =
        keccak256("Voucher(bytes32 channelId,uint256 cumulativeAmount)");

    bytes32 private constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    mapping(bytes32 => Channel) private _channels;

    /// @notice Funds owed to an address whose direct payout could not be delivered.
    mapping(address => uint256) public withdrawable;

    /// @dev Strictly increasing, never reset. Guarantees channel ids are unique for the
    ///      lifetime of the contract, so a voucher from a closed channel can never be
    ///      replayed against a later one.
    uint256 private _channelSalt;

    uint256 private _locked = 1;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event ChannelOpened(
        bytes32 indexed channelId,
        address indexed payer,
        address indexed provider,
        uint256 deposit,
        uint64 challengeBlocks
    );
    event ChannelToppedUp(bytes32 indexed channelId, uint256 amount, uint256 newDeposit);
    event Claimed(
        bytes32 indexed channelId, address indexed provider, uint256 amount, uint256 cumulative
    );
    event CloseInitiated(bytes32 indexed channelId, uint64 closeAtBlock);
    event ChannelClosed(bytes32 indexed channelId, uint256 refunded);
    event Withdrawn(address indexed account, uint256 amount);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error ChannelNotFound();
    error NotPayer();
    error ZeroProvider();
    error ProviderIsPayer();
    error EmptyDeposit();
    error ChallengeTooShort();
    error ChallengeTooLong();
    error NotProvider();
    error AlreadyClosing();
    error NotClosing();
    error ChallengeNotElapsed();
    error VoucherNotAscending();
    error ExceedsDeposit();
    error BadSignature();
    error NothingToWithdraw();
    error Reentrancy();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    // ---------------------------------------------------------------------
    // Channel lifecycle
    // ---------------------------------------------------------------------

    /**
     * @notice Open and fund a channel to `provider`.
     * @param provider The only address that can ever be paid out of this channel.
     * @param challengeBlocks How long the provider has to redeem vouchers after the
     *        payer signals a close. Must be at least `MIN_CHALLENGE_BLOCKS`.
     * @return channelId The identifier to sign vouchers against.
     */
    function open(address provider, uint64 challengeBlocks)
        external
        payable
        returns (bytes32 channelId)
    {
        if (provider == address(0)) revert ZeroProvider();
        if (provider == msg.sender) revert ProviderIsPayer();
        if (msg.value == 0) revert EmptyDeposit();
        if (challengeBlocks < MIN_CHALLENGE_BLOCKS) revert ChallengeTooShort();
        if (challengeBlocks > MAX_CHALLENGE_BLOCKS) revert ChallengeTooLong();

        unchecked {
            channelId = keccak256(abi.encode(++_channelSalt, msg.sender, provider, block.chainid));
        }

        _channels[channelId] = Channel({
            payer: msg.sender,
            provider: provider,
            deposit: msg.value,
            claimed: 0,
            challengeBlocks: challengeBlocks,
            closeAtBlock: 0
        });

        emit ChannelOpened(channelId, msg.sender, provider, msg.value, challengeBlocks);
    }

    /// @notice Add more USDC to an open channel. Anyone may fund; only the payer benefits.
    function topUp(bytes32 channelId) external payable {
        Channel storage ch = _channels[channelId];
        if (ch.payer == address(0)) revert ChannelNotFound();
        if (ch.closeAtBlock != 0) revert AlreadyClosing();
        if (msg.value == 0) revert EmptyDeposit();

        ch.deposit += msg.value;
        emit ChannelToppedUp(channelId, msg.value, ch.deposit);
    }

    /**
     * @notice Redeem a voucher, paying the provider everything owed so far.
     * @dev Callable by anyone (relayers included); funds always go to `channel.provider`.
     *      The channel stays open, so metering can continue against the same deposit.
     */
    function claim(bytes32 channelId, uint256 cumulativeAmount, bytes calldata signature)
        external
        nonReentrant
    {
        Channel storage ch = _channels[channelId];
        uint256 owed = _applyVoucher(ch, channelId, cumulativeAmount, signature);
        address provider = ch.provider;
        _payout(provider, owed);
        emit Claimed(channelId, provider, owed, cumulativeAmount);
    }

    /**
     * @notice Redeem a final voucher and close the channel immediately.
     * @dev The cooperative exit: settles what is owed and returns the remainder to
     *      the payer in the same transaction, with no challenge wait.
     *
     *      Provider-only, and that restriction is load-bearing. Closing skips
     *      the challenge window and deletes the channel, which makes every
     *      voucher the provider is still holding unredeemable. Only the party
     *      giving up that protection may waive it.
     *
     *      Leaving this open to any caller was a real hole. The payer is the
     *      sole signer of vouchers, so they could mint a minimal ascending one,
     *      close the channel themselves, and destroy an unsettled voucher for
     *      work already delivered — paying a single wei for it. Relaying on the
     *      provider's behalf would need a separate provider-signed
     *      authorisation, not an open door on msg.sender.
     */
    function claimAndClose(bytes32 channelId, uint256 cumulativeAmount, bytes calldata signature)
        external
        nonReentrant
    {
        Channel storage ch = _channels[channelId];
        if (msg.sender != ch.provider) revert NotProvider();

        uint256 owed = _applyVoucher(ch, channelId, cumulativeAmount, signature);

        address provider = ch.provider;
        address payer = ch.payer;
        uint256 refund = ch.deposit - ch.claimed;

        delete _channels[channelId];

        if (owed != 0) _payout(provider, owed);
        if (refund != 0) _payout(payer, refund);

        emit Claimed(channelId, provider, owed, cumulativeAmount);
        emit ChannelClosed(channelId, refund);
    }

    /**
     * @notice Payer signals intent to close, starting the challenge window.
     * @dev The provider must redeem any outstanding vouchers before the window ends.
     */
    function initiateClose(bytes32 channelId) external {
        Channel storage ch = _channels[channelId];
        if (ch.payer == address(0)) revert ChannelNotFound();
        if (ch.payer != msg.sender) revert NotPayer();
        if (ch.closeAtBlock != 0) revert AlreadyClosing();

        uint64 closeAt = uint64(block.number) + ch.challengeBlocks;
        ch.closeAtBlock = closeAt;
        emit CloseInitiated(channelId, closeAt);
    }

    /**
     * @notice After the challenge window, return the unclaimed remainder to the payer.
     * @dev Callable by anyone; funds always go to `channel.payer`.
     */
    function sweep(bytes32 channelId) external nonReentrant {
        Channel storage ch = _channels[channelId];
        if (ch.payer == address(0)) revert ChannelNotFound();
        if (ch.closeAtBlock == 0) revert NotClosing();
        if (block.number < ch.closeAtBlock) revert ChallengeNotElapsed();

        address payer = ch.payer;
        uint256 refund = ch.deposit - ch.claimed;

        delete _channels[channelId];

        if (refund != 0) _payout(payer, refund);
        emit ChannelClosed(channelId, refund);
    }

    /// @notice Collect funds from a payout that could not be delivered directly.
    function withdraw() external nonReentrant {
        uint256 amount = withdrawable[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        withdrawable[msg.sender] = 0;

        (bool ok,) = msg.sender.call{value: amount}("");
        if (!ok) {
            withdrawable[msg.sender] = amount;
            revert NothingToWithdraw();
        }
        emit Withdrawn(msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getChannel(bytes32 channelId) external view returns (Channel memory) {
        Channel memory ch = _channels[channelId];
        if (ch.payer == address(0)) revert ChannelNotFound();
        return ch;
    }

    /// @notice USDC still available to be metered against this channel.
    function remaining(bytes32 channelId) external view returns (uint256) {
        Channel storage ch = _channels[channelId];
        if (ch.payer == address(0)) revert ChannelNotFound();
        return ch.deposit - ch.claimed;
    }

    function domainSeparator() public view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes("Ratchet")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    /// @notice The EIP-712 digest a payer signs to authorise `cumulativeAmount`.
    function voucherHash(bytes32 channelId, uint256 cumulativeAmount)
        public
        view
        returns (bytes32)
    {
        bytes32 structHash = keccak256(abi.encode(VOUCHER_TYPEHASH, channelId, cumulativeAmount));
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    /// @dev Validates a voucher against a channel and ratchets `claimed` forward.
    ///      Returns the delta now owed to the provider.
    function _applyVoucher(
        Channel storage ch,
        bytes32 channelId,
        uint256 cumulativeAmount,
        bytes calldata signature
    ) private returns (uint256 owed) {
        if (ch.payer == address(0)) revert ChannelNotFound();
        if (cumulativeAmount <= ch.claimed) revert VoucherNotAscending();
        if (cumulativeAmount > ch.deposit) revert ExceedsDeposit();

        if (_recover(voucherHash(channelId, cumulativeAmount), signature) != ch.payer) {
            revert BadSignature();
        }

        owed = cumulativeAmount - ch.claimed;
        ch.claimed = cumulativeAmount;
    }

    /// @dev Pays `to`, falling back to a withdrawable credit if delivery fails or the
    ///      recipient is gas-hungry. Never reverts on the recipient's behalf.
    function _payout(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount, gas: PAYOUT_GAS}("");
        if (!ok) {
            withdrawable[to] += amount;
        }
    }

    /// @dev ECDSA recovery rejecting the malleable upper half of the curve order.
    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address) {
        if (signature.length != 65) revert BadSignature();

        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }

        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) {
            revert BadSignature();
        }
        if (v != 27 && v != 28) revert BadSignature();

        address signer = ecrecover(digest, v, r, s);
        if (signer == address(0)) revert BadSignature();
        return signer;
    }
}
