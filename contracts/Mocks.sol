// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * Local stand-ins for the agent-economy contracts.
 *
 * ERC-8183 (Agentic Commerce) and the ERC-8004 ValidationRegistry are deployed
 * on Arc testnet but NOT on mainnet, so there is nothing to integration-test
 * against. These implement the published interfaces faithfully enough to
 * exercise the evaluator end to end. They are test scaffolding — the real
 * deployments are addressed by configuration, and nothing here ships.
 *
 * Interfaces follow EIP-8183 and EIP-8004 as published.
 */

// ---------------------------------------------------------------------------
// Minimal USDC, in its 6-decimal ERC-20 form (how ERC-8183 moves value).
// ---------------------------------------------------------------------------

contract MockUSDC {
    string public constant name = "USD Coin";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    /// @dev Real USDC can blocklist an address, after which transfers to it
    ///      revert. An escrow contract has to survive that happening mid-job.
    mapping(address => bool) public blocked;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    error Blocked();

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function setBlocked(address who, bool isBlocked) external {
        blocked[who] = isBlocked;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        require(allowed >= amount, "allowance");
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        if (blocked[from] || blocked[to]) revert Blocked();
        require(balanceOf[from] >= amount, "balance");
        unchecked {
            balanceOf[from] -= amount;
        }
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

// ---------------------------------------------------------------------------
// ERC-8183: Agentic Commerce
// ---------------------------------------------------------------------------

contract MockAgenticCommerce {
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

    MockUSDC public immutable token;
    uint256 public nextJobId = 1;

    mapping(uint256 => Job) private _jobs;
    mapping(uint256 => bytes32) public deliverableOf;

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
    event Refunded(uint256 indexed jobId, address indexed client, uint256 amount);

    error NotClient();
    error NotProvider();
    error NotEvaluator();
    error BadStatus();
    error Expired();

    constructor(MockUSDC token_) {
        token = token_;
    }

    function createJob(
        address provider,
        address evaluator,
        uint256 expiredAt,
        string calldata description,
        address hook
    ) external returns (uint256 jobId) {
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

    /// @dev The provider quotes the job.
    function setBudget(uint256 jobId, uint256 amount, bytes calldata) external {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.provider) revert NotProvider();
        if (job.status != JobStatus.Open) revert BadStatus();
        job.budget = amount;
    }

    /// @dev The client escrows the quoted budget.
    function fund(uint256 jobId, bytes calldata) external {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.client) revert NotClient();
        if (job.status != JobStatus.Open) revert BadStatus();

        require(token.transferFrom(msg.sender, address(this), job.budget), "transferFrom");
        job.status = JobStatus.Funded;
        emit JobFunded(jobId, msg.sender, job.budget);
    }

    /// @dev The provider commits to a deliverable. The hash binds the content:
    ///      whatever is served off-chain must hash to this, or it is not the
    ///      thing that was submitted.
    function submit(uint256 jobId, bytes32 deliverable, bytes calldata) external {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.provider) revert NotProvider();
        if (job.status != JobStatus.Funded) revert BadStatus();
        if (block.timestamp > job.expiredAt) revert Expired();

        deliverableOf[jobId] = deliverable;
        job.status = JobStatus.Submitted;
        emit JobSubmitted(jobId, msg.sender, deliverable);
    }

    function complete(uint256 jobId, bytes32 reason, bytes calldata) external {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.evaluator) revert NotEvaluator();
        if (job.status != JobStatus.Submitted) revert BadStatus();

        job.status = JobStatus.Completed;
        require(token.transfer(job.provider, job.budget), "transfer");

        emit JobCompleted(jobId, msg.sender, reason);
        emit PaymentReleased(jobId, job.provider, job.budget);
    }

    function reject(uint256 jobId, bytes32 reason, bytes calldata) external {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.evaluator) revert NotEvaluator();
        if (job.status != JobStatus.Submitted) revert BadStatus();

        job.status = JobStatus.Rejected;
        emit JobRejected(jobId, msg.sender, reason);
    }

    function claimRefund(uint256 jobId) external {
        Job storage job = _jobs[jobId];
        if (msg.sender != job.client) revert NotClient();

        if (job.status == JobStatus.Funded && block.timestamp > job.expiredAt) {
            job.status = JobStatus.Expired;
            emit JobExpired(jobId);
        }
        if (job.status != JobStatus.Rejected && job.status != JobStatus.Expired) {
            revert BadStatus();
        }

        uint256 amount = job.budget;
        job.budget = 0;
        require(token.transfer(job.client, amount), "transfer");
        emit Refunded(jobId, job.client, amount);
    }

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _jobs[jobId];
    }
}

// ---------------------------------------------------------------------------
// ERC-8004: ValidationRegistry
// ---------------------------------------------------------------------------

contract MockValidationRegistry {
    struct Validation {
        address validatorAddress;
        uint256 agentId;
        uint8 response;
        bytes32 responseHash;
        string tag;
        uint256 lastUpdate;
        bool exists;
    }

    mapping(bytes32 => Validation) private _validations;
    mapping(uint256 => bytes32[]) private _agentValidations;
    mapping(address => bytes32[]) private _validatorRequests;

    event ValidationRequest(
        address indexed validatorAddress,
        uint256 indexed agentId,
        string requestURI,
        bytes32 indexed requestHash
    );
    event ValidationResponse(
        address indexed validatorAddress,
        uint256 indexed agentId,
        bytes32 indexed requestHash,
        uint8 response,
        string responseURI,
        bytes32 responseHash,
        string tag
    );

    error UnknownRequest();
    error NotTheValidator();
    error ResponseOutOfRange();

    function validationRequest(
        address validatorAddress,
        uint256 agentId,
        string calldata requestURI,
        bytes32 requestHash
    ) external {
        _validations[requestHash] = Validation({
            validatorAddress: validatorAddress,
            agentId: agentId,
            response: 0,
            responseHash: bytes32(0),
            tag: "",
            lastUpdate: block.number,
            exists: true
        });
        _agentValidations[agentId].push(requestHash);
        _validatorRequests[validatorAddress].push(requestHash);

        emit ValidationRequest(validatorAddress, agentId, requestURI, requestHash);
    }

    function validationResponse(
        bytes32 requestHash,
        uint8 response,
        string calldata responseURI,
        bytes32 responseHash,
        string calldata tag
    ) external {
        Validation storage v = _validations[requestHash];
        if (!v.exists) revert UnknownRequest();
        if (v.validatorAddress != msg.sender) revert NotTheValidator();
        if (response > 100) revert ResponseOutOfRange();

        v.response = response;
        v.responseHash = responseHash;
        v.tag = tag;
        v.lastUpdate = block.number;

        emit ValidationResponse(msg.sender, v.agentId, requestHash, response, responseURI, responseHash, tag);
    }

    function getValidationStatus(bytes32 requestHash)
        external
        view
        returns (
            address validatorAddress,
            uint256 agentId,
            uint8 response,
            bytes32 responseHash,
            string memory tag,
            uint256 lastUpdate
        )
    {
        Validation storage v = _validations[requestHash];
        if (!v.exists) revert UnknownRequest();
        return (v.validatorAddress, v.agentId, v.response, v.responseHash, v.tag, v.lastUpdate);
    }

    function getAgentValidations(uint256 agentId) external view returns (bytes32[] memory) {
        return _agentValidations[agentId];
    }

    function getValidatorRequests(address validatorAddress) external view returns (bytes32[] memory) {
        return _validatorRequests[validatorAddress];
    }
}

// ---------------------------------------------------------------------------
// A hostile ERC-8183 hook
// ---------------------------------------------------------------------------

interface ICommerce {
    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
}

/**
 * @notice A hook that tries to re-enter the escrow from inside another call.
 *
 * An audit pointed out that a reentrancy mutex only blocks re-entering a lock
 * that is already engaged. If a state-changing function is left unguarded, the
 * hook it fires can call a guarded function for the first time in the stack and
 * sail straight through — paying out, and then having the outer call overwrite
 * the status afterwards.
 *
 * This reproduces that: it is installed as the hook on a job whose evaluator is
 * this same contract, and when `reject` fires its before-hook it calls
 * `complete` on the way past.
 */
contract ReenteringHook {
    ICommerce public immutable commerce;
    uint256 public jobId;
    bool public armed;
    bool public fired;

    constructor(ICommerce commerce_) {
        commerce = commerce_;
    }

    function arm(uint256 jobId_) external {
        jobId = jobId_;
        armed = true;
        fired = false;
    }

    function beforeAction(uint256, bytes4, bytes calldata) external {
        if (!armed || fired) return;
        fired = true;
        commerce.complete(jobId, bytes32(uint256(0xdead)), "");
    }

    function afterAction(uint256, bytes4, bytes calldata) external {}

    /// @dev Lets this contract act as evaluator and call reject itself.
    function rejectVia(address target, uint256 jobId_, bytes32 reason) external {
        (bool ok, bytes memory data) = target.call(
            abi.encodeWithSignature("reject(uint256,bytes32,bytes)", jobId_, reason, "")
        );
        if (!ok) {
            assembly {
                revert(add(data, 32), mload(data))
            }
        }
    }
}
