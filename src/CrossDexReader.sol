// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title CrossDexReader
/// @notice Reference rules for job 9 of the Pons Arb UI (js/cross-dex-reader.js): the read-only
///         cross-DEX price and LP-depth reader for Robinhood Chain (4663). Each function is the
///         JavaScript rule stated once in Solidity so the Foundry tests pin it independently of the page:
///         token sorting, the two factory keys (fee for SushiSwap V3, tick spacing for the Ramses CL
///         factory), the eth_call payloads and reply decoding, the row status matrix, the keep-last-good
///         rule, the "best Uniswap V3 price" choice and the spread against it.
/// @dev All functions are internal and pure: nothing is deployed, called or held. The page never sends.
library CrossDexReader {
    /// @notice Token A and Token B are the same address.
    error SameToken();
    /// @notice One of the tokens is the zero address.
    error ZeroToken();
    /// @notice getPool is keyed by the sorted pair; the caller passed them the other way round.
    error UnsortedTokens();
    /// @notice The fee tier is not one the SushiSwap V3 configuration reads.
    error UnsupportedFee(uint24 fee);
    /// @notice The tick spacing is not one the Ramses CL factory has enabled.
    error UnsupportedTickSpacing(int24 tickSpacing);
    /// @notice No Uniswap V3 pool of the pair is priced: the Spread column shows "—".
    error NoUniReference();
    /// @notice An eth_call reply is shorter than the words the decoder needs.
    error ShortReply(uint256 length);
    /// @notice The price and liquidity lists given to bestUniPrice differ in length.
    error LengthMismatch();

    /// @notice The Status column: OK (priced), "no pool" (zero address or uninitialised), "error" (read failed).
    enum Status {
        OK,
        NoPool,
        Error
    }

    /// @dev The brief's two factories on Robinhood Chain (4663).
    address internal constant SUSHI_V3_FACTORY = 0xE51960f1B45f1C9FB6D166E6a884F866fC70433B;
    address internal constant RAMSES_CL_FACTORY = 0xE0c4ceb92d08CA985bB70fe0a22fEb121A9854A8;
    /// @dev The brief's live-test pair.
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    /// @dev SushiSwap V3 is a UniswapV3Factory: getPool(address,address,uint24 fee).
    bytes4 internal constant GET_POOL_BY_FEE = bytes4(keccak256("getPool(address,address,uint24)"));
    /// @dev The Ramses factory at RAMSES_CL_FACTORY is tick-spacing keyed: getPool(address,address,int24).
    ///      Its runtime does not contain the fee-keyed selector at all (verified live, 2026-11-10).
    bytes4 internal constant GET_POOL_BY_TICK_SPACING = bytes4(keccak256("getPool(address,address,int24)"));
    bytes4 internal constant SLOT0 = bytes4(keccak256("slot0()"));
    bytes4 internal constant LIQUIDITY = bytes4(keccak256("liquidity()"));
    bytes4 internal constant FEE = bytes4(keccak256("fee()"));

    /// @dev Fee tiers read on SushiSwap V3 (the brief's array), in display order.
    uint24 internal constant SUSHI_FEE_0 = 100;
    uint24 internal constant SUSHI_FEE_1 = 500;
    uint24 internal constant SUSHI_FEE_2 = 3000;
    uint256 internal constant SUSHI_FEE_COUNT = 3;
    /// @dev Tick spacings the Ramses CL factory has enabled (tickSpacingInitialFee(ts) != 0, read live).
    uint256 internal constant RAMSES_TICK_SPACING_COUNT = 7;
    /// @dev Both DEXes together, as the DEXES array in js/cross-dex-reader.js.
    uint256 internal constant DEX_COUNT = 2;
    /// @dev The page polls every 30 s, the cadence of the existing monitor.
    uint256 internal constant POLL_INTERVAL_SECONDS = 30;

    uint256 internal constant ONE = 1e18;
    uint256 internal constant HUNDRED_PERCENT = 100e18;

    // ------------------------------------------------------------------ configuration

    /// @notice The i-th SushiSwap fee tier (0, 1, 2).
    function sushiFee(uint256 index) internal pure returns (uint24) {
        if (index == 0) return SUSHI_FEE_0;
        if (index == 1) return SUSHI_FEE_1;
        if (index == 2) return SUSHI_FEE_2;
        revert UnsupportedFee(0);
    }

    /// @notice The i-th enabled Ramses tick spacing (0..6): 1, 5, 10, 50, 100, 200, 500.
    function ramsesTickSpacing(uint256 index) internal pure returns (int24) {
        if (index == 0) return 1;
        if (index == 1) return 5;
        if (index == 2) return 10;
        if (index == 3) return 50;
        if (index == 4) return 100;
        if (index == 5) return 200;
        if (index == 6) return 500;
        revert UnsupportedTickSpacing(0);
    }

    /// @notice True for the three fee tiers the SushiSwap V3 entry reads.
    function isSupportedFee(uint24 fee) internal pure returns (bool) {
        return fee == SUSHI_FEE_0 || fee == SUSHI_FEE_1 || fee == SUSHI_FEE_2;
    }

    /// @notice Reverts with UnsupportedFee for any other tier (the 1.00% tier is not configured).
    function requireSupportedFee(uint24 fee) internal pure {
        if (!isSupportedFee(fee)) revert UnsupportedFee(fee);
    }

    /// @notice True for the seven tick spacings the Ramses CL factory has enabled.
    function isSupportedTickSpacing(int24 tickSpacing) internal pure returns (bool) {
        return tickSpacing == 1 || tickSpacing == 5 || tickSpacing == 10 || tickSpacing == 50 || tickSpacing == 100
            || tickSpacing == 200 || tickSpacing == 500;
    }

    /// @notice Reverts with UnsupportedTickSpacing for any other spacing.
    function requireSupportedTickSpacing(int24 tickSpacing) internal pure {
        if (!isSupportedTickSpacing(tickSpacing)) revert UnsupportedTickSpacing(tickSpacing);
    }

    // ------------------------------------------------------------------ pair

    /// @notice token0 is the lower address (the page's BigInt comparison). Rejects zero and equal tokens.
    function sortTokens(address tokenA, address tokenB) internal pure returns (address token0, address token1) {
        if (tokenA == address(0) || tokenB == address(0)) revert ZeroToken();
        if (tokenA == tokenB) revert SameToken();
        return uint160(tokenA) < uint160(tokenB) ? (tokenA, tokenB) : (tokenB, tokenA);
    }

    // ------------------------------------------------------------------ eth_call payloads

    /// @notice factory.getPool(token0, token1, fee) for a fee-keyed (UniswapV3Factory-shaped) factory.
    function getPoolByFeeCalldata(address token0, address token1, uint24 fee) internal pure returns (bytes memory) {
        if (uint160(token0) >= uint160(token1)) revert UnsortedTokens();
        requireSupportedFee(fee);
        return abi.encodeWithSelector(GET_POOL_BY_FEE, token0, token1, fee);
    }

    /// @notice factory.getPool(token0, token1, tickSpacing) for the Ramses CL factory.
    function getPoolByTickSpacingCalldata(address token0, address token1, int24 tickSpacing)
        internal
        pure
        returns (bytes memory)
    {
        if (uint160(token0) >= uint160(token1)) revert UnsortedTokens();
        requireSupportedTickSpacing(tickSpacing);
        return abi.encodeWithSelector(GET_POOL_BY_TICK_SPACING, token0, token1, tickSpacing);
    }

    /// @notice pool.slot0() payload.
    function slot0Calldata() internal pure returns (bytes memory) {
        return abi.encodeWithSelector(SLOT0);
    }

    /// @notice pool.liquidity() payload.
    function liquidityCalldata() internal pure returns (bytes memory) {
        return abi.encodeWithSelector(LIQUIDITY);
    }

    /// @notice pool.fee() payload (CL pools: the fee is per pool and can change, so it is read, not configured).
    function feeCalldata() internal pure returns (bytes memory) {
        return abi.encodeWithSelector(FEE);
    }

    // ------------------------------------------------------------------ reply decoding

    /// @notice The pool address of a getPool reply; found = false for the zero address (that tier is skipped).
    function decodePoolAddress(bytes memory reply) internal pure returns (address pool, bool found) {
        if (reply.length < 32) revert ShortReply(reply.length);
        pool = abi.decode(reply, (address));
        found = pool != address(0);
    }

    /// @notice sqrtPriceX96 and tick: the first two words of slot0(), whatever follows them (Uniswap V3's
    ///         seven outputs, the CL pools' seven, or the six the manual mode declares).
    function decodeSlot0(bytes memory reply) internal pure returns (uint160 sqrtPriceX96, int24 tick) {
        if (reply.length < 64) revert ShortReply(reply.length);
        (sqrtPriceX96, tick) = abi.decode(reply, (uint160, int24));
    }

    /// @notice The uint128 of a liquidity() reply.
    function decodeLiquidity(bytes memory reply) internal pure returns (uint128) {
        if (reply.length < 32) revert ShortReply(reply.length);
        return abi.decode(reply, (uint128));
    }

    /// @notice The uint24 of a fee() reply.
    function decodeFee(bytes memory reply) internal pure returns (uint24) {
        if (reply.length < 32) revert ShortReply(reply.length);
        return abi.decode(reply, (uint24));
    }

    // ------------------------------------------------------------------ price

    /// @notice token1 per token0 in base units, scaled by 1e18, from sqrtPriceX96: (sqrt / 2^96)^2.
    /// @dev The page shows 1.0001^tick (as the existing V3 reads do); this is the same quantity to within
    ///      one tick (0.01%) and is what the tests compare the recorded live reads against.
    function priceE18FromSqrtPriceX96(uint160 sqrtPriceX96) internal pure returns (uint256) {
        uint256 reduced = uint256(sqrtPriceX96) >> 32; // < 2^128, so the square fits
        uint256 squared = (reduced * reduced) >> 64; // < 2^192, so times 1e18 fits
        return (squared * ONE) >> 64; // the remaining 2^(192 - 64 - 64) = 2^64 of the X192 scale
    }

    // ------------------------------------------------------------------ row rules

    /// @notice The Status column of one (DEX, tier) row.
    /// @param found getPool returned a non-zero address
    /// @param readOk slot0() and liquidity() both answered
    /// @param sqrtPriceX96 the pool's current sqrt price (0 = created but never initialised)
    function rowStatus(bool found, bool readOk, uint160 sqrtPriceX96) internal pure returns (Status) {
        if (!found) return Status.NoPool;
        if (!readOk) return Status.Error;
        if (sqrtPriceX96 == 0) return Status.NoPool;
        return Status.OK;
    }

    /// @notice A zero getPool address is skipped silently: no row is added for it.
    function isDisplayed(bool found, bool seenBefore) internal pure returns (bool) {
        return found || seenBefore;
    }

    /// @notice On a failed read the row keeps its last good price and liquidity.
    function keepLastGood(uint256 lastPrice, uint128 lastLiquidity, uint256 newPrice, uint128 newLiquidity, bool readOk)
        internal
        pure
        returns (uint256 price, uint128 liquidity)
    {
        return readOk ? (newPrice, newLiquidity) : (lastPrice, lastLiquidity);
    }

    // ------------------------------------------------------------------ Uniswap reference and spread

    /// @notice The reference price: the priced Uniswap V3 pool of the pair with the greatest active
    ///         liquidity (ties: the earlier entry, i.e. the lower fee tier). found = false with none priced.
    function bestUniPrice(uint256[] memory prices, uint128[] memory liquidities)
        internal
        pure
        returns (uint256 price, bool found)
    {
        if (prices.length != liquidities.length) revert LengthMismatch();
        uint128 best = 0;
        for (uint256 i = 0; i < prices.length; i++) {
            if (prices[i] == 0 || liquidities[i] == 0) continue;
            if (!found || liquidities[i] > best) {
                best = liquidities[i];
                price = prices[i];
                found = true;
            }
        }
    }

    /// @notice (DEX price − best Uni price) / best Uni price × 100, as a percentage scaled by 1e18.
    function spreadVsUniE18(uint256 dexPriceE18, uint256 uniPriceE18) internal pure returns (int256) {
        if (uniPriceE18 == 0) revert NoUniReference();
        return (int256(dexPriceE18) - int256(uniPriceE18)) * int256(HUNDRED_PERCENT) / int256(uniPriceE18);
    }

    /// @notice True when a Uni V3 reference exists; otherwise the Spread column shows "—".
    function hasUniReference(uint256 uniPriceE18) internal pure returns (bool) {
        return uniPriceE18 != 0;
    }

    /// @notice A fee in hundredths of a bip (500) as basis points × 100 for the "0.05%" display: 500 → 5.
    function feeToBps(uint24 fee) internal pure returns (uint256) {
        return uint256(fee) / 100;
    }
}
