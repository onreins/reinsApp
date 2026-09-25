// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Mandate, IMandateToken, IPriceFeed, ISwapVenue} from "./Mandate.sol";
import {UniswapV4Venue, IPoolManager} from "./UniswapV4Venue.sol";

/**
 * Proof harness, never deployed. Its code is injected at an address inside a
 * single `eth_call` against Arc mainnet state (with a USDC balance override),
 * so the whole path runs against the real Uniswap v4 pool and the real
 * Chainlink feed without broadcasting a transaction or spending anything.
 */

contract SimAgent {
    function trade(Mandate m, address tokenIn, address tokenOut, uint256 amountIn) external returns (uint256) {
        return m.trade(tokenIn, tokenOut, amountIn, 0);
    }
}

contract MandateSim {
    struct Result {
        uint256 deposited;
        uint256 foreignOut; // EURC received for the USDC
        uint256 baseBack; // USDC received for that EURC
        uint256 equityAfterFirst;
        uint256 equityEnd;
        uint256 oraclePrice; // feed answer, 8 decimals
    }

    struct Setup {
        address poolManager;
        address usdc;
        address foreign;
        address foreignFeed;
        uint24 fee;
        int24 tickSpacing;
        uint256 tradeSize;
    }

    function run(Setup calldata s) external returns (Result memory r) {
        (Mandate m, SimAgent agent) = _build(s);

        r.deposited = s.tradeSize * 2;
        IMandateToken(s.usdc).approve(address(m), r.deposited);
        m.deposit(r.deposited);

        (, int256 answer,,,) = IPriceFeed(s.foreignFeed).latestRoundData();
        r.oraclePrice = uint256(answer);

        r.foreignOut = agent.trade(m, s.usdc, s.foreign, s.tradeSize);
        r.equityAfterFirst = m.equity();
        r.baseBack = agent.trade(m, s.foreign, s.usdc, r.foreignOut);
        r.equityEnd = m.equity();
    }

    function _build(Setup calldata s) private returns (Mandate m, SimAgent agent) {
        UniswapV4Venue venue = new UniswapV4Venue(IPoolManager(s.poolManager), address(this));
        venue.setRoute(s.usdc, s.foreign, s.fee, s.tickSpacing, address(0));
        agent = new SimAgent();

        address[] memory tokens = new address[](1);
        tokens[0] = s.foreign;
        IPriceFeed[] memory feeds = new IPriceFeed[](1);
        feeds[0] = IPriceFeed(s.foreignFeed);

        m = new Mandate(address(this), address(agent), IMandateToken(s.usdc), ISwapVenue(address(venue)), _rules(s.tradeSize), tokens, feeds);
    }

    function _rules(uint256 tradeSize) private view returns (Mandate.Rules memory) {
        return Mandate.Rules({
            maxTradeValue: tradeSize,
            maxDrawdownBps: 1_000,
            maxSlippageBps: 100,
            expiresAt: uint64(block.timestamp + 1 days),
            maxPriceAge: 2 days
        });
    }
}
