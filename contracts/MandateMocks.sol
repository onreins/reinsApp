// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPriceFeed, ISwapVenue, Mandate} from "./Mandate.sol";

/// Test scaffolding for Mandate. Never deployed outside local tests.

contract MockToken {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory symbol_, uint8 decimals_) {
        name = symbol_;
        symbol = symbol_;
        decimals = decimals_;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
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
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        allowance[from][msg.sender] = a - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) private {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// A Chainlink-shaped feed whose answer and timestamp tests control.
contract MockFeed is IPriceFeed {
    uint8 public immutable override decimals;
    int256 public answer;
    uint256 public updatedAt;

    constructor(uint8 decimals_, int256 answer_) {
        decimals = decimals_;
        answer = answer_;
        updatedAt = block.timestamp;
    }

    function set(int256 answer_) external {
        answer = answer_;
        updatedAt = block.timestamp;
    }

    function setUpdatedAt(uint256 t) external {
        updatedAt = t;
    }

    function latestRoundData() external view override returns (uint80, int256, uint256, uint256, uint80) {
        return (1, answer, updatedAt, updatedAt, 1);
    }
}

/**
 * An exchange that fills at the oracle price, shifted by `edgeBps` against the
 * trader (0 = perfectly fair, 300 = 3% worse). It holds its own inventory.
 * `base` is priced at exactly $1, like the mandate assumes.
 */
contract OracleVenue is ISwapVenue {
    address public immutable base;
    mapping(address => IPriceFeed) public feedOf;
    mapping(address => uint8) public decOf;
    uint16 public edgeBps;

    constructor(address base_, uint8 baseDecimals) {
        base = base_;
        decOf[base_] = baseDecimals;
    }

    function list(address token, IPriceFeed feed, uint8 dec) external {
        feedOf[token] = feed;
        decOf[token] = dec;
    }

    function setEdge(uint16 bps) external {
        edgeBps = bps;
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address to)
        external
        override
        returns (uint256 amountOut)
    {
        require(MockToken(tokenIn).transferFrom(msg.sender, address(this), amountIn), "pull");
        uint256 usd = _usd(tokenIn, amountIn); // 1e18-scaled dollars
        amountOut = (_amount(tokenOut, usd) * (10_000 - edgeBps)) / 10_000;
        require(amountOut >= minOut, "venue: slippage");
        require(MockToken(tokenOut).transfer(to, amountOut), "push");
    }

    function _usd(address token, uint256 amount) private view returns (uint256) {
        uint256 scale = 10 ** decOf[token];
        if (token == base) return (amount * 1e18) / scale;
        (, int256 p,,,) = feedOf[token].latestRoundData();
        return (amount * uint256(p) * 1e18) / (scale * 10 ** feedOf[token].decimals());
    }

    function _amount(address token, uint256 usd) private view returns (uint256) {
        uint256 scale = 10 ** decOf[token];
        if (token == base) return (usd * scale) / 1e18;
        (, int256 p,,,) = feedOf[token].latestRoundData();
        return (usd * scale * 10 ** feedOf[token].decimals()) / (uint256(p) * 1e18);
    }
}

/// A hostile venue: while holding the approval, it calls back into the mandate.
contract ReenteringVenue is ISwapVenue {
    Mandate public target;
    address public tokenA;
    address public tokenB;

    function aim(Mandate target_, address a, address b) external {
        target = target_;
        tokenA = a;
        tokenB = b;
    }

    function swap(address, address, uint256, uint256, address) external override returns (uint256) {
        target.trade(tokenA, tokenB, 1, 0);
        return 0;
    }
}

/// A venue that takes the tokens and sends nothing back, while claiming it did.
contract ThiefVenue is ISwapVenue {
    function swap(address tokenIn, address, uint256 amountIn, uint256, address) external override returns (uint256) {
        require(MockToken(tokenIn).transferFrom(msg.sender, address(this), amountIn), "pull");
        return type(uint256).max;
    }
}
