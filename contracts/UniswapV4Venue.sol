// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ISwapVenue} from "./Mandate.sol";

/**
 * @title UniswapV4Venue
 * @notice A Mandate exchange adapter that swaps through a Uniswap v4 pool.
 *
 * One exact-input swap per call, on a route (pool) fixed for each token pair.
 * Routes can be set once and never changed, so whoever deploys the venue can't
 * later point a pair at a different pool. The Mandate still checks every fill
 * against its oracle; this contract only has to move tokens honestly.
 *
 * Flow: pull `tokenIn` from the caller, unlock the PoolManager, swap, pay the
 * pool what it's owed, take the output straight to `to`, and revert unless at
 * least `minOut` arrived.
 */

struct PoolKey {
    address currency0;
    address currency1;
    uint24 fee;
    int24 tickSpacing;
    address hooks;
}

struct SwapParams {
    bool zeroForOne;
    int256 amountSpecified; // negative = exact input
    uint160 sqrtPriceLimitX96;
}

interface IPoolManager {
    function unlock(bytes calldata data) external returns (bytes memory);
    function swap(PoolKey memory key, SwapParams memory params, bytes calldata hookData) external returns (int256);
    function sync(address currency) external;
    function settle() external payable returns (uint256);
    function take(address currency, address to, uint256 amount) external;
}

interface IVenueToken {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract UniswapV4Venue is ISwapVenue {
    uint160 private constant MIN_SQRT_PRICE_PLUS_ONE = 4295128740;
    uint160 private constant MAX_SQRT_PRICE_MINUS_ONE = 1461446703485210103287273052203988822378723970341;

    IPoolManager public immutable poolManager;
    address public immutable admin;

    mapping(bytes32 => PoolKey) private _routes;

    event RouteSet(address indexed tokenA, address indexed tokenB, uint24 fee, int24 tickSpacing, address hooks);
    event Swapped(address indexed tokenIn, address indexed tokenOut, uint256 amountIn, uint256 amountOut, address to);

    error NotAdmin();
    error RouteExists();
    error NoRoute();
    error NotPoolManager();
    error BadRoute();
    error InsufficientOutput(uint256 out, uint256 minOut);
    error TransferFailed();

    constructor(IPoolManager poolManager_, address admin_) {
        poolManager = poolManager_;
        admin = admin_;
    }

    /// Fix the pool used for a pair. Once set, it can never change.
    function setRoute(address tokenA, address tokenB, uint24 fee, int24 tickSpacing, address hooks) external {
        if (msg.sender != admin) revert NotAdmin();
        if (tokenA == tokenB || tokenA == address(0) || tokenB == address(0)) revert BadRoute();
        bytes32 id = _pairId(tokenA, tokenB);
        if (_routes[id].currency0 != address(0)) revert RouteExists();
        (address c0, address c1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        _routes[id] = PoolKey({currency0: c0, currency1: c1, fee: fee, tickSpacing: tickSpacing, hooks: hooks});
        emit RouteSet(tokenA, tokenB, fee, tickSpacing, hooks);
    }

    function routeOf(address tokenA, address tokenB) external view returns (PoolKey memory) {
        return _routes[_pairId(tokenA, tokenB)];
    }

    function swap(address tokenIn, address tokenOut, uint256 amountIn, uint256 minOut, address to)
        external
        override
        returns (uint256 amountOut)
    {
        PoolKey memory key = _routes[_pairId(tokenIn, tokenOut)];
        if (key.currency0 == address(0)) revert NoRoute();
        if (!IVenueToken(tokenIn).transferFrom(msg.sender, address(this), amountIn)) revert TransferFailed();

        bytes memory result = poolManager.unlock(abi.encode(key, tokenIn, tokenOut, amountIn, to));
        amountOut = abi.decode(result, (uint256));
        if (amountOut < minOut) revert InsufficientOutput(amountOut, minOut);
        emit Swapped(tokenIn, tokenOut, amountIn, amountOut, to);
    }

    /// Called by the PoolManager inside `unlock`.
    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (PoolKey memory key, address tokenIn, address tokenOut, uint256 amountIn, address to) =
            abi.decode(data, (PoolKey, address, address, uint256, address));

        bool zeroForOne = tokenIn == key.currency0;
        int256 delta = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? MIN_SQRT_PRICE_PLUS_ONE : MAX_SQRT_PRICE_MINUS_ONE
            }),
            ""
        );

        int128 amount0 = int128(delta >> 128);
        int128 amount1 = int128(delta);
        (int128 owed, int128 got) = zeroForOne ? (amount0, amount1) : (amount1, amount0);

        // Pay what the pool is owed (owed is negative), then take the output.
        uint256 pay = uint256(uint128(-owed));
        poolManager.sync(tokenIn);
        if (!IVenueToken(tokenIn).transfer(address(poolManager), pay)) revert TransferFailed();
        poolManager.settle();

        uint256 out = uint256(uint128(got));
        poolManager.take(tokenOut, to, out);

        // A partial fill (price limit hit) leaves input behind: return it to the payer.
        if (pay < amountIn) {
            if (!IVenueToken(tokenIn).transfer(to, amountIn - pay)) revert TransferFailed();
        }
        return abi.encode(out);
    }

    function _pairId(address a, address b) private pure returns (bytes32) {
        return a < b ? keccak256(abi.encode(a, b)) : keccak256(abi.encode(b, a));
    }
}
