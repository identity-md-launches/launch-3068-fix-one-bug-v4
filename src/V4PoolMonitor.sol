// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {V4SwapCalldata} from "./V4SwapCalldata.sol";

/// @title V4PoolMonitor
/// @notice Reference arithmetic for the live pool monitor in js/v4-arb-encoder.js: pool ids of
///         the seven fee tiers of a pair, spread / fee / net in basis points, the 0.5% slippage
///         applied to a quote, and the decoding of the router's price-check revert that the page
///         uses as an exact-input quote. Follow-up 3.5 adds the window bounds, the Slot0 storage
///         slot and word layout, staleness colours and the pool status that gates spreads.
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
    /// @notice A log window outside MIN_WINDOW_BLOCKS to MAX_WINDOW_BLOCKS.
    error WindowOutOfRange();

    /// @notice Colour of the Last Swap column.
    enum StalenessColor {
        Green,
        Yellow,
        Red
    }

    /// @notice Why a pool is or is not tradeable. Only Ok reaches the spreads and auto mode.
    enum PoolStatus {
        Inactive,
        Ok,
        Stale,
        Empty,
        Unknown
    }

    /// @notice One active pool's readings from a poll.
    /// @param active The pool has a swap in the window.
    /// @param slot0Read The slot0 read succeeded.
    /// @param sqrtPriceX96 The slot0 price; meaningful only when slot0Read.
    /// @param timestampRead The swap block's timestamp read succeeded.
    /// @param elapsedSeconds Latest block timestamp minus swap block timestamp; meaningful only when timestampRead.
    struct PoolHealth {
        bool active;
        bool slot0Read;
        uint160 sqrtPriceX96;
        bool timestampRead;
        uint256 elapsedSeconds;
    }

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
    uint256 internal constant LOG_WINDOW_BLOCKS = 3000;
    uint256 internal constant MIN_WINDOW_BLOCKS = 50;
    uint256 internal constant MAX_WINDOW_BLOCKS = 50_000;
    uint256 internal constant MAX_STALENESS_SECONDS = 7200;
    uint256 internal constant STALENESS_YELLOW_SECONDS = 1800;
    uint256 internal constant STALENESS_RED_SECONDS = 7200;
    /// @dev The storage slot of PoolManager's `pools` mapping, used by Uniswap's StateLibrary. The
    ///      deployed PoolManager has no getSlot0(bytes32), so the page reads Slot0 through extsload.
    uint256 internal constant POOLS_SLOT = 6;

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

    /// @notice fromBlock of the eth_getLogs call: the window ends at `latest` and includes it.
    function windowStart(uint256 latest, uint256 blocks) internal pure returns (uint256) {
        if (blocks < MIN_WINDOW_BLOCKS || blocks > MAX_WINDOW_BLOCKS) revert WindowOutOfRange();
        return latest >= blocks - 1 ? latest - (blocks - 1) : 0;
    }

    /// @notice The PoolManager storage slot holding a pool's Slot0 word.
    function slot0Slot(bytes32 id) internal pure returns (bytes32) {
        return keccak256(abi.encode(id, POOLS_SLOT));
    }

    /// @notice Unpacks Slot0, from the low bits: sqrtPriceX96 (160), tick (24), protocolFee (24), lpFee (24).
    function decodeSlot0(bytes32 word)
        internal
        pure
        returns (int24 tick, uint160 sqrtPriceX96, uint24 protocolFee, uint24 lpFee)
    {
        uint256 packed = uint256(word);
        // casting is safe because each value is masked to the width of its target type
        // forge-lint: disable-next-line(unsafe-typecast)
        sqrtPriceX96 = uint160(packed & type(uint160).max);
        // forge-lint: disable-next-line(unsafe-typecast)
        tick = int24(uint24((packed >> 160) & type(uint24).max));
        // forge-lint: disable-next-line(unsafe-typecast)
        protocolFee = uint24((packed >> 184) & type(uint24).max);
        // forge-lint: disable-next-line(unsafe-typecast)
        lpFee = uint24((packed >> 208) & type(uint24).max);
    }

    /// @notice Green below 30 minutes, yellow from 30 minutes to 2 hours, red above 2 hours.
    function stalenessColor(uint256 elapsedSeconds) internal pure returns (StalenessColor) {
        if (elapsedSeconds < STALENESS_YELLOW_SECONDS) return StalenessColor.Green;
        return elapsedSeconds > STALENESS_RED_SECONDS ? StalenessColor.Red : StalenessColor.Yellow;
    }

    /// @notice A definite fact (Empty, Stale) is reported ahead of a failed read (Unknown).
    function poolStatus(PoolHealth memory pool, uint256 maxStalenessSeconds) internal pure returns (PoolStatus) {
        if (!pool.active) return PoolStatus.Inactive;
        if (pool.slot0Read && pool.sqrtPriceX96 == 0) return PoolStatus.Empty;
        if (pool.timestampRead && pool.elapsedSeconds > maxStalenessSeconds) return PoolStatus.Stale;
        if (!pool.slot0Read || !pool.timestampRead) return PoolStatus.Unknown;
        return PoolStatus.Ok;
    }

    /// @notice The tick of a PoolManager Swap log, from its six-word data.
    function decodeSwapTick(bytes memory data) internal pure returns (int24 tick) {
        if (data.length != 6 * 32) revert MalformedSwapLog();
        (,,,, tick,) = abi.decode(data, (int128, int128, uint160, uint128, int24, uint24));
    }
}
