// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title Mandate
 * @notice Give an AI agent a USDC budget with rules it cannot break.
 *
 * The owner deposits USDC and names an agent key. The agent may only trade,
 * only between assets the owner allowed, only through the exchange the owner
 * chose, and only within these limits, all enforced here rather than trusted:
 *
 *   - max trade size        no single trade worth more than `maxTradeValue`
 *   - fair prices           every fill is checked against a Chainlink price;
 *                           anything worse than `maxSlippageBps` reverts
 *   - max loss              a trade that would leave equity below
 *                           baseline × (1 − maxDrawdownBps) reverts, and
 *                           anyone can freeze the mandate if the market alone
 *                           pushes it past that line (a public stop-loss)
 *   - expiry                no trading after `expiresAt`
 *   - no exits              the agent has no way to move funds anywhere but
 *                           back into this contract
 *
 * The owner can withdraw anything, swap the agent, or revoke it at any time.
 *
 * Why the price check matters: for a dishonest agent, "trade at a terrible
 * price into a pool I control" is the obvious way to drain a budget. Checking
 * every fill against an oracle bounds that leak to `maxSlippageBps` of each
 * trade, and the drawdown limit bounds the total. The worst case is a known
 * number the owner chose, not the whole balance.
 */

interface IMandateToken {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address who) external view returns (uint256);
    function decimals() external view returns (uint8);
}

/// Chainlink AggregatorV3 subset.
interface IPriceFeed {
    function decimals() external view returns (uint8);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// An exchange adapter. It pulls `amountIn` of `tokenIn` from the caller and
/// sends at least `minOut` of `tokenOut` to `to`. The mandate never trusts the
/// return value; it measures its own balances.
interface ISwapVenue {
    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address to)
        external
        returns (uint256 amountOut);
}

contract Mandate {
    struct Asset {
        IPriceFeed feed;
        uint8 decimals;
        bool allowed;
    }

    struct Rules {
        uint256 maxTradeValue; // in base units
        uint16 maxDrawdownBps;
        uint16 maxSlippageBps;
        uint64 expiresAt;
        uint32 maxPriceAge; // seconds a price may be old before it's refused
    }

    uint16 public constant BPS = 10_000;

    address public immutable owner;
    IMandateToken public immutable base; // USDC: the unit equity is measured in
    ISwapVenue public immutable venue;
    uint256 public immutable maxTradeValue;
    uint16 public immutable maxDrawdownBps;
    uint16 public immutable maxSlippageBps;
    uint64 public immutable expiresAt;
    uint32 public immutable maxPriceAge;
    uint8 private immutable _baseDecimals;

    address public agent;
    bool public frozen;
    /// Equity the drawdown limit is measured against. Deposits raise it,
    /// withdrawals shrink it in proportion, and the owner can re-base it.
    uint256 public baseline;

    address[] private _assetList;
    mapping(address => Asset) public assets;
    uint256 private _locked = 1;

    event Deposited(uint256 amount, uint256 baseline);
    event Withdrawn(address indexed token, uint256 amount, uint256 baseline);
    event AgentChanged(address indexed agent);
    event Traded(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, uint256 equity);
    event Frozen(uint256 equity, uint256 floor);
    event Unfrozen(uint256 baseline);
    event AssetRemoved(address indexed token, uint256 amount, uint256 baseline);

    error NotOwner();
    error NotAgent();
    error IsFrozen();
    error MandateExpired();
    error AssetNotAllowed();
    error SameAsset();
    error TradeTooLarge(uint256 value, uint256 max);
    error PriceTooLow(uint256 received, uint256 floor);
    error OverSpent();
    error DrawdownLimit(uint256 equity, uint256 floor);
    error StalePrice(address token);
    error BadPrice(address token);
    error NotBreached();
    error BadConfig();
    error TransferFailed();
    error Reentrancy();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier nonReentrant() {
        if (_locked != 1) revert Reentrancy();
        _locked = 2;
        _;
        _locked = 1;
    }

    constructor(
        address owner_,
        address agent_,
        IMandateToken base_,
        ISwapVenue venue_,
        Rules memory rules,
        address[] memory tokens,
        IPriceFeed[] memory feeds
    ) {
        if (owner_ == address(0) || address(base_) == address(0) || address(venue_) == address(0)) revert BadConfig();
        if (agent_ == owner_) revert BadConfig();
        if (tokens.length != feeds.length || tokens.length > 16) revert BadConfig();
        if (rules.maxDrawdownBps == 0 || rules.maxDrawdownBps > BPS) revert BadConfig();
        if (rules.maxSlippageBps > 1_000) revert BadConfig(); // never tolerate more than 10% off the oracle
        if (rules.maxTradeValue == 0 || rules.maxPriceAge == 0) revert BadConfig();
        if (rules.expiresAt <= block.timestamp) revert BadConfig();

        owner = owner_;
        agent = agent_;
        base = base_;
        venue = venue_;
        maxTradeValue = rules.maxTradeValue;
        maxDrawdownBps = rules.maxDrawdownBps;
        maxSlippageBps = rules.maxSlippageBps;
        expiresAt = rules.expiresAt;
        maxPriceAge = rules.maxPriceAge;
        _baseDecimals = base_.decimals();

        for (uint256 i; i < tokens.length; ++i) {
            address t = tokens[i];
            if (t == address(base_) || t == address(0) || assets[t].allowed) revert BadConfig();
            if (address(feeds[i]) == address(0)) revert BadConfig();
            assets[t] = Asset({feed: feeds[i], decimals: IMandateToken(t).decimals(), allowed: true});
            _assetList.push(t);
        }
    }

    // ------------------------------------------------------------------ owner

    function deposit(uint256 amount) external onlyOwner nonReentrant {
        _pull(address(base), msg.sender, address(this), amount);
        baseline += amount;
        emit Deposited(amount, baseline);
    }

    /// Withdraw any token at any time. The drawdown baseline shrinks by the
    /// same fraction of equity, so taking money out never looks like a loss.
    ///
    /// Valued leniently: an asset whose feed is stale or broken counts as zero
    /// on both sides of the ratio instead of reverting. The owner's exit must
    /// never depend on an oracle being healthy.
    function withdraw(address token, uint256 amount) external onlyOwner nonReentrant {
        uint256 before = _equity(false);
        _send(token, owner, amount);
        uint256 afterEq = _equity(false);
        baseline = before == 0 ? 0 : (baseline * afterEq) / before;
        emit Withdrawn(token, amount, baseline);
    }

    /// Drop one asset from the mandate: its whole balance goes to the owner
    /// and the agent can no longer trade it. The remedy for a feed that has
    /// been deprecated or has gone permanently stale.
    function removeAsset(address token) external onlyOwner nonReentrant {
        if (!assets[token].allowed) revert AssetNotAllowed();
        uint256 before = _equity(false);
        uint256 bal = IMandateToken(token).balanceOf(address(this));
        delete assets[token];
        for (uint256 i; i < _assetList.length; ++i) {
            if (_assetList[i] == token) {
                _assetList[i] = _assetList[_assetList.length - 1];
                _assetList.pop();
                break;
            }
        }
        if (bal != 0) _send(token, owner, bal);
        uint256 afterEq = _equity(false);
        baseline = before == 0 ? 0 : (baseline * afterEq) / before;
        emit AssetRemoved(token, bal, baseline);
    }

    /// Everything back to the owner, and the agent removed, in one call.
    function withdrawAll() external onlyOwner nonReentrant {
        agent = address(0);
        emit AgentChanged(address(0));
        _sweep(address(base));
        for (uint256 i; i < _assetList.length; ++i) _sweep(_assetList[i]);
        baseline = 0;
    }

    /// Replace or revoke (address(0)) the agent.
    function setAgent(address agent_) external onlyOwner {
        if (agent_ == owner) revert BadConfig();
        agent = agent_;
        emit AgentChanged(agent_);
    }

    /// Resume after a freeze, measuring future losses from today's equity.
    function unfreeze() external onlyOwner nonReentrant {
        frozen = false;
        baseline = equity();
        emit Unfrozen(baseline);
    }

    // ------------------------------------------------------------------ agent

    /**
     * @notice Trade `amountIn` of `tokenIn` for `tokenOut` through the venue.
     * @param minOut the agent's own minimum; the contract also enforces the
     *        oracle floor and uses whichever is higher.
     */
    function trade(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut)
        external
        nonReentrant
        returns (uint256 received)
    {
        if (msg.sender != agent || agent == address(0)) revert NotAgent();
        if (frozen) revert IsFrozen();
        if (block.timestamp >= expiresAt) revert MandateExpired();
        if (tokenIn == tokenOut) revert SameAsset();
        if (!_tradable(tokenIn) || !_tradable(tokenOut)) revert AssetNotAllowed();

        // Rounded up, so dust can't slip under the size limit.
        uint256 valueIn = _valueOf(tokenIn, amountIn, true);
        if (valueIn > maxTradeValue) revert TradeTooLarge(valueIn, maxTradeValue);

        // The fair amount at the oracle price, less the tolerated slippage.
        // Rounded up: protective floors must never round in the agent's favour.
        uint256 floorOut = _mulDiv(_amountFor(tokenOut, valueIn), BPS - maxSlippageBps, BPS, true);
        uint256 minEffective = minOut > floorOut ? minOut : floorOut;

        uint256 inBefore = IMandateToken(tokenIn).balanceOf(address(this));
        uint256 outBefore = IMandateToken(tokenOut).balanceOf(address(this));

        _allow(tokenIn, address(venue), amountIn);
        venue.swap(tokenIn, tokenOut, amountIn, minEffective, address(this));
        _allow(tokenIn, address(venue), 0);

        // Measure, don't trust: what actually left and what actually arrived.
        if (inBefore - IMandateToken(tokenIn).balanceOf(address(this)) > amountIn) revert OverSpent();
        received = IMandateToken(tokenOut).balanceOf(address(this)) - outBefore;
        if (received < minEffective) revert PriceTooLow(received, minEffective);

        uint256 eq = equity();
        uint256 fl = _floor();
        if (eq < fl) revert DrawdownLimit(eq, fl);

        emit Traded(tokenIn, tokenOut, amountIn, received, eq);
    }

    // ----------------------------------------------------------------- public

    /// The public stop-loss. Anyone may freeze a mandate whose equity has
    /// fallen past its limit, so the owner doesn't have to be watching.
    /// Guarded so it can't run mid-swap, when balances are momentarily low.
    function checkpoint() external nonReentrant {
        if (frozen) revert IsFrozen();
        uint256 eq = equity();
        uint256 fl = _floor();
        if (eq >= fl) revert NotBreached();
        frozen = true;
        emit Frozen(eq, fl);
    }

    /// Everything the mandate holds, valued in base units at oracle prices.
    /// Reverts if any held asset's price is stale: trading and the stop-loss
    /// must never act on a number that can't be trusted.
    function equity() public view returns (uint256) {
        return _equity(true);
    }

    function assetList() external view returns (address[] memory) {
        return _assetList;
    }

    function floor() external view returns (uint256) {
        return _floor();
    }

    // --------------------------------------------------------------- internal

    function _floor() private view returns (uint256) {
        return (baseline * (BPS - maxDrawdownBps)) / BPS;
    }

    function _tradable(address token) private view returns (bool) {
        return token == address(base) || assets[token].allowed;
    }

    /// Equity. `strict` reverts on any unusable price; lenient values such an
    /// asset at zero (used only where the owner's exit must not depend on it).
    function _equity(bool strict) private view returns (uint256 total) {
        total = base.balanceOf(address(this));
        for (uint256 i; i < _assetList.length; ++i) {
            address t = _assetList[i];
            uint256 bal = IMandateToken(t).balanceOf(address(this));
            if (bal == 0) continue;
            if (strict) {
                total += _valueOf(t, bal, false);
            } else {
                (bool ok, uint256 p, uint8 fd) = _tryPrice(t);
                if (ok) total += _mulDiv(bal * p, 10 ** _baseDecimals, 10 ** (uint256(assets[t].decimals) + fd), false);
            }
        }
    }

    /// Oracle price of one whole `token`, or ok=false if it's stale, invalid,
    /// or the feed call itself fails.
    function _tryPrice(address token) private view returns (bool ok, uint256 price, uint8 feedDecimals) {
        Asset storage a = assets[token];
        try a.feed.latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            if (answer <= 0) return (false, 0, 0);
            if (updatedAt > block.timestamp || block.timestamp - updatedAt > maxPriceAge) return (false, 0, 0);
            try a.feed.decimals() returns (uint8 d) {
                return (true, uint256(answer), d);
            } catch {
                return (false, 0, 0);
            }
        } catch {
            return (false, 0, 0);
        }
    }

    /// Oracle price of one whole `token`, after staleness and sanity checks.
    function _price(address token) private view returns (uint256 price, uint8 feedDecimals) {
        Asset storage a = assets[token];
        (, int256 answer,, uint256 updatedAt,) = a.feed.latestRoundData();
        if (answer <= 0) revert BadPrice(token);
        if (updatedAt > block.timestamp || block.timestamp - updatedAt > maxPriceAge) revert StalePrice(token);
        return (uint256(answer), a.feed.decimals());
    }

    /// Value of `amount` of `token` in base units (base is treated as $1).
    function _valueOf(address token, uint256 amount, bool roundUp) private view returns (uint256) {
        if (token == address(base)) return amount;
        (uint256 p, uint8 fd) = _price(token);
        return _mulDiv(amount * p, 10 ** _baseDecimals, 10 ** (uint256(assets[token].decimals) + fd), roundUp);
    }

    /// Amount of `token` worth `value` base units at the oracle price, rounded up.
    function _amountFor(address token, uint256 value) private view returns (uint256) {
        if (token == address(base)) return value;
        (uint256 p, uint8 fd) = _price(token);
        return _mulDiv(value, 10 ** (uint256(assets[token].decimals) + fd), p * (10 ** _baseDecimals), true);
    }

    function _mulDiv(uint256 a, uint256 b, uint256 d, bool roundUp) private pure returns (uint256 r) {
        r = (a * b) / d;
        if (roundUp && mulmod(a, b, d) != 0) r += 1;
    }

    // ------------------------------------------------------------- token calls

    /**
     * ERC-20s in the wild disagree about return values. Most return a bool;
     * USDT and a number of tokenized securities return nothing at all, and
     * decoding a bool from an empty return reverts. So decode only when there
     * is something to decode.
     *
     * A token that reverts — an allowlist refusing this contract, say — has its
     * own reason bubbled up, because that reason is the useful one.
     */
    function _call(address token, bytes memory data) private {
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
        if (ret.length != 0 && !abi.decode(ret, (bool))) revert TransferFailed();
    }

    function _send(address token, address to, uint256 amount) private {
        _call(token, abi.encodeCall(IMandateToken.transfer, (to, amount)));
    }

    function _pull(address token, address from, address to, uint256 amount) private {
        _call(token, abi.encodeCall(IMandateToken.transferFrom, (from, to, amount)));
    }

    function _allow(address token, address spender, uint256 amount) private {
        _call(token, abi.encodeCall(IMandateToken.approve, (spender, amount)));
    }

    function _sweep(address token) private {
        uint256 bal = IMandateToken(token).balanceOf(address(this));
        if (bal != 0) _send(token, owner, bal);
    }
}

/**
 * @title MandateFactory
 * @notice Deploys mandates and announces them, so an arena or dashboard can
 *         find every mandate from events alone.
 */
contract MandateFactory {
    event MandateCreated(address indexed mandate, address indexed owner, address indexed agent, string name);

    function create(
        string calldata name,
        address agent,
        IMandateToken base,
        ISwapVenue venue,
        Mandate.Rules calldata rules,
        address[] calldata tokens,
        IPriceFeed[] calldata feeds
    ) external returns (Mandate m) {
        m = new Mandate(msg.sender, agent, base, venue, rules, tokens, feeds);
        emit MandateCreated(address(m), msg.sender, agent, name);
    }
}
