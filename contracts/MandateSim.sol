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

    /**
     * The same path as `run`, one stage at a time, each in its own try/catch.
     * Returns the first stage that failed (0 = none) and its revert data, so a
     * revert with no message can still be located.
     *   1 venue  2 route  3 agent  4 mandate  5 approve  6 deposit
     *   7 feed   8 buy    9 sell back
     */
    function diagnose(Setup calldata s) external returns (uint8 stage, bytes memory reason, uint256 got) {
        UniswapV4Venue venue;
        try new UniswapV4Venue(IPoolManager(s.poolManager), address(this)) returns (UniswapV4Venue v) { venue = v; }
        catch (bytes memory e) { return (1, e, 0); }
        try venue.setRoute(s.usdc, s.foreign, s.fee, s.tickSpacing, address(0)) {}
        catch (bytes memory e) { return (2, e, 0); }
        SimAgent agent;
        try new SimAgent() returns (SimAgent a) { agent = a; }
        catch (bytes memory e) { return (3, e, 0); }

        address[] memory tokens = new address[](1);
        tokens[0] = s.foreign;
        IPriceFeed[] memory feeds = new IPriceFeed[](1);
        feeds[0] = IPriceFeed(s.foreignFeed);
        Mandate m;
        try new Mandate(address(this), address(agent), IMandateToken(s.usdc), ISwapVenue(address(venue)), _rules(s.tradeSize), tokens, feeds)
            returns (Mandate mm) { m = mm; }
        catch (bytes memory e) { return (4, e, 0); }

        try IMandateToken(s.usdc).approve(address(m), s.tradeSize * 2) {}
        catch (bytes memory e) { return (5, e, 0); }
        try m.deposit(s.tradeSize * 2) {}
        catch (bytes memory e) { return (6, e, 0); }
        try IPriceFeed(s.foreignFeed).latestRoundData() returns (uint80, int256 answer, uint256, uint256, uint80) { got = uint256(answer); }
        catch (bytes memory e) { return (7, e, 0); }
        uint256 out;
        try agent.trade(m, s.usdc, s.foreign, s.tradeSize) returns (uint256 o) { out = o; }
        catch (bytes memory e) { return (8, e, got); }
        try agent.trade(m, s.foreign, s.usdc, out) returns (uint256 back) { got = back; }
        catch (bytes memory e) { return (9, e, out); }
        return (0, "", got);
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
