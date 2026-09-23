// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title AgenticCommerce
 * @notice ERC-8183 job escrow, deployed for Arc.
 *
 * One agent hires another. The client escrows USDC, the provider delivers, and
 * a named evaluator decides whether the work was good enough to release the
 * money. Three roles, six states, no arbitration — reject and expire are final.
 *
 * ## Why this exists
 *
 * ERC-8183 is not deployed on Arc. The registries the standard leans on
 * (ERC-8004) exist on Arc testnet and are absent from mainnet entirely, so
 * there is currently nowhere on Arc for two agents to transact this way. This
 * is that place.
 *
 * ## The evaluator problem, and what this contract does about it
 *
 * The standard lets the client name *anyone* as evaluator, including
 * themselves. A client who evaluates their own purchase can reject good work
 * and reclaim the escrow, which no provider should accept once real money is
 * involved. The contract cannot fix that by fiat without breaking the
 * standard, so instead it makes the choice legible: `JobCreated` publishes the
 * evaluator, and `selfEvaluated()` tells any provider, in one call, whether
 * they are being asked to trust the buyer to mark their own homework.
 *
 * ## Arc notes
 *
 * - Value moves as ERC-20 USDC (6 decimals). Arc's native USDC is the same
 *   balance viewed at 18 decimals; ERC-8183 moves value by
 *   approve/transferFrom, so the ERC-20 interface is the right one here.
 * - `expiredAt` is a timestamp, per the standard. Arc guarantees timestamps
 *   are non-decreasing rather than strictly increasing, which is sufficient
 *   for a deadline — it can only move toward expiry, never away from it. A
 *   *challenge window* would need block numbers instead, because that requires
 *   guaranteed forward progress; see RatchetVault, which does exactly that.
 * - Arc reverts on value transfers to the zero address, so every payout target
 *   is checked rather than assumed.
 */

/// @notice Optional extension point, per ERC-8183.
interface IACPHook {
    function beforeAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
    function afterAction(uint256 jobId, bytes4 selector, bytes calldata data) external;
}

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract AgenticCommerce {
    // ---------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------

    enum JobStatus {
        Open,
        Funded,
        Submitted,
        Completed,
        Rejected,
        Expired
    }

    struct Job {
        uint256 id;
        address client;
        address provider;
        address evaluator;
        string description;
        uint256 budget;
        uint256 expiredAt;
        JobStatus status;
        address hook;
    }

    // ---------------------------------------------------------------------
    // Immutables
    // ---------------------------------------------------------------------

    /// @notice The settlement asset. USDC on Arc, in its 6-decimal ERC-20 form.
    IERC20 public immutable token;

    /// @notice Protocol fee in basis points, taken from the budget on completion.
    uint16 public immutable feeBps;

    /// @notice Where the fee goes.
    address public immutable feeRecipient;

    /// @dev Hard ceiling on the fee, enforced at construction. There is no
    ///      owner and no setter: whatever is deployed is what is charged,
    ///      forever. A protocol that can raise its own rake is not one an
    ///      autonomous agent can safely commit funds to.
    uint16 public constant MAX_FEE_BPS = 250; // 2.5%

    /// @dev Gas forwarded to a hook. A hostile or broken hook must not be able
    ///      to burn the caller's whole gas budget or block settlement.
    uint256 private constant HOOK_GAS = 150_000;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    uint256 public nextJobId = 1;

    mapping(uint256 => Job) private _jobs;

    /// @notice The deliverable hash a provider committed to, per job.
    mapping(uint256 => bytes32) public deliverableOf;

    /// @notice Escrow actually held per job, so accounting never relies on
    ///         this contract's total balance (which anyone can inflate).
    mapping(uint256 => uint256) public escrowOf;

    uint256 private _locked = 1;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event JobCreated(
        uint256 indexed jobId,
        address indexed client,
        address indexed provider,
        address evaluator,
        uint256 expiredAt,
        address hook
    );
    event JobFunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event JobSubmitted(uint256 indexed jobId, address indexed provider, bytes32 deliverable);
    event JobCompleted(uint256 indexed jobId, address indexed evaluator, bytes32 reason);
    event JobRejected(uint256 indexed jobId, address indexed rejector, bytes32 reason);
    event JobExpired(uint256 indexed jobId);
    event PaymentReleased(uint256 indexed jobId, address indexed provider, uint256 amount);
    event FeeCollected(uint256 indexed jobId, address indexed recipient, uint256 amount);
    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);
    event ProviderSet(uint256 indexed jobId, address indexed provider);
    event BudgetSet(uint256 indexed jobId, uint256 amount);
    event HookFailed(uint256 indexed jobId, bytes4 selector, bool isBefore);

    // ---------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------

    error NotClient();
    error NotProvider();
    error NotEvaluator();
    error BadStatus();
    error Expired();
    error NotYetExpired();
    error ZeroAddress();
    error ZeroBudget();
    error DeadlineInPast();
    error FeeTooHigh();
    error TransferFailed();
    error Reentrancy();

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(IERC20 token_, uint16 feeBps_, address feeRecipient_) {
        if (address(token_) == address(0)) revert ZeroAddress();
        if (feeBps_ > MAX_FEE_BPS) revert FeeTooHigh();
        if (feeBps_ != 0 && feeRecipient_ == address(0)) revert ZeroAddress();

        token = token_;
        feeBps = feeBps_;
        feeRecipient = feeRecipient_;
    }

    // ---------------------------------------------------------------------
    // Lifecycle
    // ---------------------------------------------------------------------

    /**
     * @notice Post a job. The provider may be left unset and named later.
     * @param evaluator Who decides whether the work is acceptable. May be the
     *        client — see `selfEvaluated`.
     * @param expiredAt Unix timestamp after which an unfinished job refunds.
     */
    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external returns (uint256 jobId) {
        if (evaluator == address(0)) revert ZeroAddress();
        if (expiredAt <= block.timestamp) revert DeadlineInPast();

        jobId = nextJobId++;
        _jobs[jobId] = Job({
            id: jobId,
            client: msg.sender,
            provider: provider,
            evaluator: evaluator,
            description: description,
            budget: 0,
            expiredAt: expiredAt,
            status: JobStatus.Open,
            hook: hook
        });

        emit JobCreated(jobId, msg.sender, provider, evaluator, expiredAt, hook);
    }

    /// @notice Name or change the provider, before funding.
    function setProvider(uint256 jobId, address provider) external {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.client) revert NotClient();
        if (job.status != JobStatus.Open) revert BadStatus();
        if (provider == address(0)) revert ZeroAddress();

        job.provider = provider;
        emit ProviderSet(jobId, provider);
    }

    /// @notice The provider quotes the job.
    function setBudget(uint256 jobId, uint256 amount, bytes calldata optParams) external {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.provider) revert NotProvider();
        if (job.status != JobStatus.Open) revert BadStatus();
        if (amount == 0) revert ZeroBudget();

        _hook(job.hook, jobId, this.setBudget.selector, optParams, true);
        job.budget = amount;
        emit BudgetSet(jobId, amount);
        _hook(job.hook, jobId, this.setBudget.selector, optParams, false);
    }

    /**
     * @notice The client escrows the quoted budget.
     * @dev Credits escrow from the balance actually received, so a
     *      fee-on-transfer or rebasing token cannot leave the contract
     *      promising more than it holds.
     */
    function fund(uint256 jobId, bytes calldata optParams) external nonReentrant {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.client) revert NotClient();
        if (job.status != JobStatus.Open) revert BadStatus();
        if (job.budget == 0) revert ZeroBudget();
        if (block.timestamp > job.expiredAt) revert Expired();
        if (job.provider == address(0)) revert ZeroAddress();

        _hook(job.hook, jobId, this.fund.selector, optParams, true);

        uint256 before = token.balanceOf(address(this));
        if (!token.transferFrom(msg.sender, address(this), job.budget)) revert TransferFailed();
        uint256 received = token.balanceOf(address(this)) - before;

        escrowOf[jobId] = received;
        job.budget = received;
        job.status = JobStatus.Funded;

        emit JobFunded(jobId, msg.sender, received);
        _hook(job.hook, jobId, this.fund.selector, optParams, false);
    }

    /**
     * @notice The provider commits to a deliverable.
     * @dev The hash binds the content: whatever is served off-chain must hash
     *      to this, or it is not what was submitted. That is what lets a
     *      neutral evaluator verify the work without trusting either party.
     */
    function submit(uint256 jobId, bytes32 deliverable, bytes calldata optParams) external {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.provider) revert NotProvider();
        if (job.status != JobStatus.Funded) revert BadStatus();
        if (block.timestamp > job.expiredAt) revert Expired();

        _hook(job.hook, jobId, this.submit.selector, optParams, true);

        deliverableOf[jobId] = deliverable;
        job.status = JobStatus.Submitted;

        emit JobSubmitted(jobId, msg.sender, deliverable);
        _hook(job.hook, jobId, this.submit.selector, optParams, false);
    }

    /**
     * @notice The evaluator accepts the work; escrow pays the provider.
     * @param reason A hash identifying the verdict, so the decision is
     *        auditable off-chain rather than merely asserted.
     */
    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams)
        external
        nonReentrant
    {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.evaluator) revert NotEvaluator();
        if (job.status != JobStatus.Submitted) revert BadStatus();

        _hook(job.hook, jobId, this.complete.selector, optParams, true);

        uint256 amount = escrowOf[jobId];
        escrowOf[jobId] = 0;
        job.status = JobStatus.Completed;

        uint256 fee = (amount * feeBps) / 10_000;
        uint256 net = amount - fee;

        address provider = job.provider;
        if (net != 0) _send(provider, net);
        if (fee != 0) {
            _send(feeRecipient, fee);
            emit FeeCollected(jobId, feeRecipient, fee);
        }

        emit JobCompleted(jobId, msg.sender, reason);
        emit PaymentReleased(jobId, provider, net);
        _hook(job.hook, jobId, this.complete.selector, optParams, false);
    }

    /**
     * @notice The evaluator refuses the work. The client reclaims separately.
     * @dev Deliberately does not push funds: a refund that ran inside the
     *      evaluator's transaction would let a hostile client contract revert
     *      and strand the decision.
     */
    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.evaluator) revert NotEvaluator();
        if (job.status != JobStatus.Submitted) revert BadStatus();

        _hook(job.hook, jobId, this.reject.selector, optParams, true);

        job.status = JobStatus.Rejected;

        emit JobRejected(jobId, msg.sender, reason);
        _hook(job.hook, jobId, this.reject.selector, optParams, false);
    }

    /**
     * @notice Client reclaims escrow from a rejected job, or one that ran out
     *         of time without a verdict.
     * @dev Anyone may call it; the money always goes to the client. That means
     *      a stalled job can be cleaned up by a keeper without the client
     *      needing to be online.
     */
    function claimRefund(uint256 jobId) external nonReentrant {
        Job storage job = _jobs[jobId];
        if (job.client == address(0)) revert BadStatus();

        if (job.status == JobStatus.Funded || job.status == JobStatus.Submitted) {
            // An evaluator who never shows up must not be able to hold the
            // money hostage: expiry releases it back to the client.
            if (block.timestamp <= job.expiredAt) revert NotYetExpired();
            job.status = JobStatus.Expired;
            emit JobExpired(jobId);
        } else if (job.status != JobStatus.Rejected) {
            revert BadStatus();
        }

        uint256 amount = escrowOf[jobId];
        if (amount == 0) revert BadStatus();
        escrowOf[jobId] = 0;

        _send(job.client, amount);
        emit Refunded(jobId, job.client, amount);
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _jobs[jobId];
    }

    /**
     * @notice True when the client is also the evaluator.
     * @dev The standard permits this and Circle's own quickstart does it, but
     *      it means the buyer marks their own homework — they can reject good
     *      work and reclaim the escrow. A provider should check this before
     *      doing any work, which is why it is one call rather than something
     *      you have to reason out from `getJob`.
     */
    function selfEvaluated(uint256 jobId) external view returns (bool) {
        Job storage job = _jobs[jobId];
        return job.client != address(0) && job.client == job.evaluator;
    }

    /// @notice What the provider would actually receive, net of protocol fee.
    function netPayout(uint256 jobId) external view returns (uint256) {
        uint256 amount = escrowOf[jobId];
        return amount - (amount * feeBps) / 10_000;
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    /**
     * @dev Call a hook without letting it break settlement.
     *
     * Hooks are third-party contracts named by the client. A reverting or
     * gas-hungry hook must not be able to freeze escrow, so failures are
     * logged and ignored rather than bubbled. Callers who need a hook to be
     * authoritative should enforce that in the hook's own protocol, not here.
     */
    function _hook(
        address hook,
        uint256 jobId,
        bytes4 selector,
        bytes calldata data,
        bool isBefore
    ) private {
        if (hook == address(0)) return;

        bytes memory payload = isBefore
            ? abi.encodeCall(IACPHook.beforeAction, (jobId, selector, data))
            : abi.encodeCall(IACPHook.afterAction, (jobId, selector, data));

        (bool ok,) = hook.call{gas: HOOK_GAS}(payload);
        if (!ok) emit HookFailed(jobId, selector, isBefore);
    }

    /// @dev Arc reverts on transfers to the zero address, so check before sending.
    function _send(address to, uint256 amount) private {
        if (to == address(0)) revert ZeroAddress();
        if (!token.transfer(to, amount)) revert TransferFailed();
    }
}
