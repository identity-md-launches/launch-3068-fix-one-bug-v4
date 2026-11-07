// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {V4SwapCalldata} from "./V4SwapCalldata.sol";

/// @title V4PoolMonitor
/// @notice Reference arithmetic for the live pool monitor in js/v4-arb-encoder.js: pool ids of
///         the seven fee tiers of a pair, spread / fee / net in basis points, the 0.5% slippage
///         applied to a quote, and the decoding of the router's price-check revert that the page
///         uses as an exact-input quote.
/// @dev All functions are internal and pure: nothing is deployed, called or held. Prices are
///      unitless fixed-point numbers at any common scale (the JavaScript uses 1.0001^tick as a
///      float); only their ratio matters to the spread.
library V4PoolMonitor {
    /// @notice Token A and Token B are the same address.
    error IdenticalTokens();
    /// @notice A token address is zero; the monitor watches ERC20 pairs only.
    error ZeroToken();
    /// @notice A price is zero; the spread of an empty pool is undefined.
    error ZeroPrice();
    /// @notice Slippage above 100%.
    error SlippageTooHigh();
    /// @notice The revert data is not V4TooLittleReceivedPerHopSingle(uint256,uint256).
    error NotPriceRevert();
    /// @notice A Swap log's data is not the six-word layout of the PoolManager event.
    error MalformedSwapLog();

    /// @dev PoolManager Swap(PoolId indexed id, address indexed sender, int128 amount0, int128 amount1,
    ///      uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee).
    bytes32 internal constant SWAP_TOPIC = 0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    /// @dev V4TooLittleReceivedPerHopSingle(uint256 minHopPriceX36, uint256 actualPriceX36).
    bytes4 internal constant QUOTE_REVERT_SELECTOR = 0x4713c18b;
    uint256 internal constant X36 = 1e36;
    uint256 internal constant BPS = 10_000;
    /// @dev LP fees are in hundredths of a basis point (1e-6): 3000 = 0.30% = 30 bps.
    uint256 internal constant FEE_PIPS_PER_BP = 100;
    uint256 internal constant SLIPPAGE_BPS = 50;
    uint256 internal constant TIER_COUNT = 7;
    uint256 internal constant LOG_WINDOW_BLOCKS = 100;

    /// @notice The seven fee / tick spacing combinations the monitor scans, in the brief's order.
    function feeTiers() internal pure returns (uint24[TIER_COUNT] memory fees, int24[TIER_COUNT] memory spacings) {
        fees = [uint24(0), 0, 500, 2500, 3000, 10000, 30000];
        spacings = [int24(1), 10, 10, 25, 60, 200, 600];
    }

    /// @notice currency0 is the numerically lower address, as the PoolManager requires.
    function sortPair(address tokenA, address tokenB) internal pure returns (address currency0, address currency1) {
        if (tokenA == tokenB) revert IdenticalTokens();
        if (tokenA == address(0) || tokenB == address(0)) revert ZeroToken();
        (currency0, currency1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
    }

    /// @notice The seven hookless pool keys of a sorted pair.
    function poolKeys(address currency0, address currency1)
        internal
        pure
        returns (V4SwapCalldata.PoolKey[TIER_COUNT] memory keys)
    {
        if (currency0 >= currency1) revert V4SwapCalldata.CurrenciesNotSorted();
        (uint24[TIER_COUNT] memory fees, int24[TIER_COUNT] memory spacings) = feeTiers();
        for (uint256 i = 0; i < TIER_COUNT; ++i) {
            keys[i] = V4SwapCalldata.PoolKey({
                currency0: currency0, currency1: currency1, fee: fees[i], tickSpacing: spacings[i], hooks: address(0)
            });
        }
    }

    /// @notice PoolId = keccak256(abi.encode(currency0, currency1, fee, tickSpacing, hooks)).
    function poolId(V4SwapCalldata.PoolKey memory key) internal pure returns (bytes32) {
        return keccak256(abi.encode(key));
    }

    /// @notice |priceA - priceB| as basis points of the lower price.
    function spreadBps(uint256 priceA, uint256 priceB) internal pure returns (uint256) {
        if (priceA == 0 || priceB == 0) revert ZeroPrice();
        (uint256 low, uint256 high) = priceA <= priceB ? (priceA, priceB) : (priceB, priceA);
        return (high - low) * BPS / low;
    }

    /// @notice The two LP fees of a round trip in basis points: (feeA + feeB) / 100.
    function feeCostBps(uint24 feeA, uint24 feeB) internal pure returns (uint256) {
        return (uint256(feeA) + uint256(feeB)) / FEE_PIPS_PER_BP;
    }

    /// @notice spread minus fee cost, in basis points; negative when fees eat the whole gap.
    function netBps(uint256 priceA, uint256 priceB, uint24 feeA, uint24 feeB) internal pure returns (int256) {
        // casting is safe because both terms are far below 2^255: spread < 1e4 * 2^256 / low is bounded by the
        // caller's price scale and fee cost is at most 2 * type(uint24).max / 100
        // forge-lint: disable-next-line(unsafe-typecast)
        return int256(spreadBps(priceA, priceB)) - int256(feeCostBps(feeA, feeB));
    }

    /// @notice GREEN when the net is strictly above the threshold (default threshold 50 bps = 0.5%).
    function isGreen(int256 net, uint256 thresholdBps) internal pure returns (bool) {
        // casting is safe because a threshold above 2^255 bps is meaningless and only makes the check false
        // forge-lint: disable-next-line(unsafe-typecast)
        return thresholdBps <= uint256(type(int256).max) && net > int256(thresholdBps);
    }

    /// @notice amount * (10000 - bps) / 10000, rounded down: the bridge amount of a quote.
    function applySlippage(uint256 amount, uint256 bps) internal pure returns (uint256) {
        if (bps > BPS) revert SlippageTooHigh();
        return amount * (BPS - bps) / BPS;
    }

    /// @notice amountOut recovered from the router's price-check revert for an exact-input swap of
    ///         `amountIn`: actualPriceX36 = amountOut * 1e36 / amountIn, so amountOut is
    ///         actualPriceX36 * amountIn / 1e36 (exact up to one base unit for amountIn <= 1e36).
    function decodeQuoteRevert(bytes memory revertData, uint256 amountIn) internal pure returns (uint256 amountOut) {
        if (revertData.length != 4 + 64) revert NotPriceRevert();
        // casting is safe because the length is checked above; bytes4 takes the first four bytes
        // forge-lint: disable-next-line(unsafe-typecast)
        if (bytes4(revertData) != QUOTE_REVERT_SELECTOR) revert NotPriceRevert();
        bytes memory args = new bytes(64);
        for (uint256 i = 0; i < 64; ++i) {
            args[i] = revertData[i + 4];
        }
        (, uint256 actualPriceX36) = abi.decode(args, (uint256, uint256));
        amountOut = actualPriceX36 * amountIn / X36;
    }

    /// @notice The tick of a PoolManager Swap log, from its six-word data.
    function decodeSwapTick(bytes memory data) internal pure returns (int24 tick) {
        if (data.length != 6 * 32) revert MalformedSwapLog();
        (,,,, tick,) = abi.decode(data, (int128, int128, uint160, uint128, int24, uint24));
    }
}
