// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title VerdictRuling
 * @notice Verify a Verdict ruling attestation on-chain.
 *
 * The arbiter API (arbiter/app.js) signs this EIP-712 struct for the escrow
 * contract named in the request:
 *
 *   Ruling(bytes32 caseId, uint8 outcome, uint8 score,
 *          bytes32 rulingHash, bytes32 termsHash, bytes32 deliveryHash)
 *
 * with the domain { name: "Verdict", version: "1", chainId, verifyingContract }.
 * Because the domain names the verifying contract, an attestation made for one
 * escrow cannot be replayed against another, or on another chain.
 *
 * Drop this library into any escrow: store the arbiter's address and the two
 * commitments per case, then check `signer(ruling, sig) == arbiter` and that
 * the ruling's termsHash and deliveryHash equal what the parties committed.
 */
library VerdictRuling {
    uint8 internal constant PASSED = 1;
    uint8 internal constant FAILED = 2;
    uint8 internal constant ABSTAIN = 3;

    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant RULING_TYPEHASH = keccak256(
        "Ruling(bytes32 caseId,uint8 outcome,uint8 score,bytes32 rulingHash,bytes32 termsHash,bytes32 deliveryHash)"
    );

    /// secp256k1n / 2. Signatures with a higher `s` are malleable twins and are refused.
    uint256 private constant HALF_ORDER = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    struct Ruling {
        bytes32 caseId;
        uint8 outcome;
        uint8 score;
        bytes32 rulingHash;
        bytes32 termsHash;
        bytes32 deliveryHash;
    }

    /// The EIP-712 domain separator for `verifyingContract` on this chain.
    function domainSeparator(address verifyingContract) internal view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("Verdict"), keccak256("1"), block.chainid, verifyingContract)
        );
    }

    function digest(Ruling memory r, address verifyingContract) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(RULING_TYPEHASH, r.caseId, r.outcome, r.score, r.rulingHash, r.termsHash, r.deliveryHash)
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(verifyingContract), structHash));
    }

    /**
     * @notice Who signed this ruling for the calling contract.
     * @return The signer, or address(0) for a malformed or malleable signature.
     * @dev Internal library functions are inlined, so `address(this)` is the
     *      escrow calling it, which is exactly the verifying contract we want.
     */
    function signer(Ruling memory r, bytes memory sig) internal view returns (address) {
        if (sig.length != 65) return address(0);
        bytes32 sigR;
        bytes32 sigS;
        uint8 v;
        assembly {
            sigR := mload(add(sig, 0x20))
            sigS := mload(add(sig, 0x40))
            v := byte(0, mload(add(sig, 0x60)))
        }
        if (uint256(sigS) > HALF_ORDER) return address(0);
        if (v != 27 && v != 28) return address(0);
        return ecrecover(digest(r, address(this)), v, sigR, sigS);
    }
}

interface IVerdictToken {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

/**
 * @title ArbitratedEscrow
 * @notice A minimal reference escrow that settles on a Verdict ruling.
 *
 * It exists to prove the integration end to end, and as a template for escrow
 * protocols: buyer locks funds against committed terms, seller commits a
 * delivery, and anyone can submit the arbiter's signed ruling to settle.
 *
 *   passed   → seller is paid
 *   failed   → buyer is refunded
 *   abstain  → nothing moves; the deadline decides (buyer can reclaim)
 *
 * No owner, no admin, no fee. The arbiter can only choose between the two
 * outcomes the parties already agreed to; it can never take the money.
 */
contract ArbitratedEscrow {
    enum Status {
        None,
        Open,
        Delivered,
        Paid,
        Refunded
    }

    struct Case {
        address buyer;
        address seller;
        address arbiter;
        uint256 amount;
        bytes32 termsHash;
        bytes32 deliveryHash;
        uint64 deadline;
        Status status;
    }

    /// After a delivery, the arbiter is guaranteed this long past the deadline
    /// to rule before the buyer may reclaim. Mirrors AgenticCommerce.
    uint64 public constant EVALUATION_WINDOW = 1 days;

    IVerdictToken public immutable token;
    uint256 public caseCount;
    mapping(bytes32 => Case) public cases;
    mapping(address => uint256) public withdrawable;
    uint256 private _locked = 1;

    event Opened(
        bytes32 indexed caseId,
        address indexed buyer,
        address indexed seller,
        address arbiter,
        uint256 amount,
        bytes32 termsHash,
        uint64 deadline
    );
    event Delivered(bytes32 indexed caseId, bytes32 deliveryHash);
    event Settled(bytes32 indexed caseId, uint8 outcome, bytes32 rulingHash, address paidTo);
    event Reclaimed(bytes32 indexed caseId);
    event PayoutDeferred(address indexed to, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error NotNeutral();
    error DeadlineInPast();
    error TransferFailed();
    error BadStatus();
    error NotSeller();
    error Expired();
    error BadSignature();
    error CommitmentMismatch();
    error DoesNotSettle();
    error TooEarly();
    error NothingToWithdraw();
    error Reentrancy();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(IVerdictToken token_) {
        if (address(token_) == address(0)) revert ZeroAddress();
        token = token_;
    }

    /// @notice Lock `amount` for `seller`, to be decided by `arbiter` against `termsHash`.
    function open(address seller, address arbiter, uint256 amount, bytes32 termsHash, uint64 deadline)
        external
        nonReentrant
        returns (bytes32 caseId)
    {
        if (seller == address(0) || arbiter == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        // The whole point: the judge is neither party.
        if (arbiter == msg.sender || arbiter == seller || seller == msg.sender) revert NotNeutral();
        if (deadline <= block.timestamp) revert DeadlineInPast();

        caseId = keccak256(abi.encode(block.chainid, address(this), ++caseCount));
        cases[caseId] = Case({
            buyer: msg.sender,
            seller: seller,
            arbiter: arbiter,
            amount: amount,
            termsHash: termsHash,
            deliveryHash: bytes32(0),
            deadline: deadline,
            status: Status.Open
        });
        emit Opened(caseId, msg.sender, seller, arbiter, amount, termsHash, deadline);

        if (!token.transferFrom(msg.sender, address(this), amount)) revert TransferFailed();
    }

    /// @notice The seller commits to exactly what they delivered.
    function deliver(bytes32 caseId, bytes32 deliveryHash) external nonReentrant {
        Case storage c = cases[caseId];
        if (msg.sender != c.seller) revert NotSeller();
        if (c.status != Status.Open) revert BadStatus();
        if (block.timestamp >= c.deadline) revert Expired();
        c.deliveryHash = deliveryHash;
        c.status = Status.Delivered;
        emit Delivered(caseId, deliveryHash);
    }

    /// @notice Settle with the arbiter's signed ruling. Anyone may submit it.
    function settle(VerdictRuling.Ruling calldata ruling, bytes calldata sig) external nonReentrant {
        Case storage c = cases[ruling.caseId];
        if (c.status != Status.Delivered) revert BadStatus();
        if (VerdictRuling.signer(ruling, sig) != c.arbiter) revert BadSignature();
        if (ruling.termsHash != c.termsHash || ruling.deliveryHash != c.deliveryHash) revert CommitmentMismatch();

        address to;
        if (ruling.outcome == VerdictRuling.PASSED) {
            c.status = Status.Paid;
            to = c.seller;
        } else if (ruling.outcome == VerdictRuling.FAILED) {
            c.status = Status.Refunded;
            to = c.buyer;
        } else {
            // Abstain (or anything unknown) moves no money. The deadline decides.
            revert DoesNotSettle();
        }
        emit Settled(ruling.caseId, ruling.outcome, ruling.rulingHash, to);
        _send(to, c.amount);
    }

    /**
     * @notice Return the funds to the buyer once nobody can settle any more:
     *         after the deadline if nothing was delivered, or after the
     *         evaluation window if a delivery is still unruled.
     * @dev Right at the end of the window, a buyer's reclaim and a seller's
     *      settle can race in the mempool, and whichever is mined first wins.
     *      That is transaction ordering, not something code can remove; the
     *      defence is the window's length. A seller holding a passing ruling
     *      should submit it promptly rather than at the last block.
     */
    function reclaim(bytes32 caseId) external nonReentrant {
        Case storage c = cases[caseId];
        if (c.status == Status.Open) {
            if (block.timestamp < c.deadline) revert TooEarly();
        } else if (c.status == Status.Delivered) {
            if (block.timestamp < uint256(c.deadline) + EVALUATION_WINDOW) revert TooEarly();
        } else {
            revert BadStatus();
        }
        c.status = Status.Refunded;
        emit Reclaimed(caseId);
        _send(c.buyer, c.amount);
    }

    /// @notice Collect a payout that could not be pushed (e.g. a blocklisted address).
    function withdraw() external nonReentrant {
        uint256 amount = withdrawable[msg.sender];
        if (amount == 0) revert NothingToWithdraw();
        withdrawable[msg.sender] = 0;
        if (!token.transfer(msg.sender, amount)) revert TransferFailed();
    }

    /// Push, or credit for later if the push fails: settlement must never be blockable.
    function _send(address to, uint256 amount) private {
        try token.transfer(to, amount) returns (bool ok) {
            if (ok) return;
        } catch {
            // fall through to the credit below
        }
        withdrawable[to] += amount;
        emit PayoutDeferred(to, amount);
    }
}
