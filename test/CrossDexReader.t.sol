// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {CrossDexReader} from "../src/CrossDexReader.sol";

/// @dev External wrappers so the reverting paths can be checked with vm.expectRevert from non-view tests.
contract CrossDexReaderHarness {
    function sortTokens(address a, address b) external pure returns (address, address) {
        return CrossDexReader.sortTokens(a, b);
    }

    function requireSupportedFee(uint24 fee) external pure {
        CrossDexReader.requireSupportedFee(fee);
    }

    function requireSupportedTickSpacing(int24 tickSpacing) external pure {
        CrossDexReader.requireSupportedTickSpacing(tickSpacing);
    }

    function getPoolByFeeCalldata(address t0, address t1, uint24 fee) external pure returns (bytes memory) {
        return CrossDexReader.getPoolByFeeCalldata(t0, t1, fee);
    }

    function getPoolByTickSpacingCalldata(address t0, address t1, int24 ts) external pure returns (bytes memory) {
        return CrossDexReader.getPoolByTickSpacingCalldata(t0, t1, ts);
    }

    function decodePoolAddress(bytes memory reply) external pure returns (address, bool) {
        return CrossDexReader.decodePoolAddress(reply);
    }

    function decodeSlot0(bytes memory reply) external pure returns (uint160, int24) {
        return CrossDexReader.decodeSlot0(reply);
    }

    function decodeLiquidity(bytes memory reply) external pure returns (uint128) {
        return CrossDexReader.decodeLiquidity(reply);
    }

    function decodeFee(bytes memory reply) external pure returns (uint24) {
        return CrossDexReader.decodeFee(reply);
    }

    function bestUniPrice(uint256[] memory prices, uint128[] memory liquidities) external pure returns (uint256, bool) {
        return CrossDexReader.bestUniPrice(prices, liquidities);
    }

    function spreadVsUniE18(uint256 dexPrice, uint256 uniPrice) external pure returns (int256) {
        return CrossDexReader.spreadVsUniE18(dexPrice, uniPrice);
    }

    function sushiFee(uint256 index) external pure returns (uint24) {
        return CrossDexReader.sushiFee(index);
    }

    function ramsesTickSpacing(uint256 index) external pure returns (int24) {
        return CrossDexReader.ramsesTickSpacing(index);
    }
}

contract CrossDexReaderTest is Test {
    using CrossDexReader for *;

    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant PONS = 0x39dBED3a2bd333467115dE45665cC57F813C4571;

    // Live reads of 2026-11-10 (block 0x69da8ae), WETH/USDG, recorded in docs/cross-dex-live.json.
    address internal constant SUSHI_POOL_500 = 0x9B050cb1F265094b0977160a2BD7dA8C9E529c3C;
    uint160 internal constant SUSHI_500_SQRT = 3554505806984652282396672;
    int24 internal constant SUSHI_500_TICK = -200248;
    uint128 internal constant SUSHI_500_LIQUIDITY = 0x1e58d3c397a1133;
    address internal constant RAMSES_POOL_TS1 = 0xFAE65eAa11943f45E83D5B45DC7A7C801C51bfB0;
    uint160 internal constant RAMSES_TS1_SQRT = 3558756836972367431527520;
    int24 internal constant RAMSES_TS1_TICK = -200224;
    uint160 internal constant UNI_500_SQRT = 3556392679920231423772973;
    uint128 internal constant UNI_500_LIQUIDITY = 0x47c91b14a554962;
    uint160 internal constant UNI_100_SQRT = 3556757575284533098549268;
    uint128 internal constant UNI_100_LIQUIDITY = 0x453851b6c173986;

    CrossDexReaderHarness internal harness;

    function setUp() public {
        harness = new CrossDexReaderHarness();
    }

    // ------------------------------------------------------------------ configuration

    function test_Configuration() public pure {
        assertEq(CrossDexReader.DEX_COUNT, 2);
        assertEq(CrossDexReader.SUSHI_FEE_COUNT, 3);
        assertEq(CrossDexReader.sushiFee(0), 100);
        assertEq(CrossDexReader.sushiFee(1), 500);
        assertEq(CrossDexReader.sushiFee(2), 3000);
        assertEq(CrossDexReader.RAMSES_TICK_SPACING_COUNT, 7);
        int24[7] memory spacings = [int24(1), 5, 10, 50, 100, 200, 500];
        for (uint256 i = 0; i < spacings.length; i++) {
            assertEq(CrossDexReader.ramsesTickSpacing(i), spacings[i]);
            assertTrue(CrossDexReader.isSupportedTickSpacing(spacings[i]));
        }
        assertEq(CrossDexReader.POLL_INTERVAL_SECONDS, 30, "same cadence as the existing monitor");
        assertEq(CrossDexReader.SUSHI_V3_FACTORY, 0xE51960f1B45f1C9FB6D166E6a884F866fC70433B);
        assertEq(CrossDexReader.RAMSES_CL_FACTORY, 0xE0c4ceb92d08CA985bB70fe0a22fEb121A9854A8);
    }

    function test_Selectors() public pure {
        assertEq(CrossDexReader.GET_POOL_BY_FEE, bytes4(0x1698ee82));
        assertEq(CrossDexReader.GET_POOL_BY_TICK_SPACING, bytes4(0x28af8d0b), "the selector in the Ramses runtime");
        assertEq(CrossDexReader.SLOT0, bytes4(0x3850c7bd));
        assertEq(CrossDexReader.LIQUIDITY, bytes4(0x1a686502));
        assertEq(CrossDexReader.FEE, bytes4(0xddca3f43));
        assertEq(CrossDexReader.slot0Calldata(), abi.encodeWithSelector(bytes4(0x3850c7bd)));
        assertEq(CrossDexReader.liquidityCalldata(), abi.encodeWithSelector(bytes4(0x1a686502)));
        assertEq(CrossDexReader.feeCalldata(), abi.encodeWithSelector(bytes4(0xddca3f43)));
    }

    function test_SupportedFeesAreTheBriefsThree() public pure {
        assertTrue(CrossDexReader.isSupportedFee(100));
        assertTrue(CrossDexReader.isSupportedFee(500));
        assertTrue(CrossDexReader.isSupportedFee(3000));
        assertFalse(CrossDexReader.isSupportedFee(10000), "the 1.00% tier is not configured");
        assertFalse(CrossDexReader.isSupportedFee(0));
        assertFalse(CrossDexReader.isSupportedFee(2500));
    }

    function test_RevertWhen_UnsupportedFee() public {
        vm.expectRevert(abi.encodeWithSelector(CrossDexReader.UnsupportedFee.selector, uint24(10000)));
        harness.requireSupportedFee(10000);
        vm.expectRevert(abi.encodeWithSelector(CrossDexReader.UnsupportedFee.selector, uint24(0)));
        harness.sushiFee(3);
    }

    function test_RevertWhen_UnsupportedTickSpacing() public {
        vm.expectRevert(abi.encodeWithSelector(CrossDexReader.UnsupportedTickSpacing.selector, int24(60)));
        harness.requireSupportedTickSpacing(60);
        vm.expectRevert(abi.encodeWithSelector(CrossDexReader.UnsupportedTickSpacing.selector, int24(0)));
        harness.ramsesTickSpacing(7);
    }

    function testFuzz_UnsupportedFeeAlwaysReverts(uint24 fee) public {
        vm.assume(fee != 100 && fee != 500 && fee != 3000);
        vm.expectRevert(abi.encodeWithSelector(CrossDexReader.UnsupportedFee.selector, fee));
        harness.requireSupportedFee(fee);
    }

    // ------------------------------------------------------------------ pair

    function test_SortTokensPutsWethFirstForTheLiveTestPair() public pure {
        (address t0, address t1) = CrossDexReader.sortTokens(WETH, USDG);
        assertEq(t0, WETH, "WETH is the lower address");
        assertEq(t1, USDG);
        (t0, t1) = CrossDexReader.sortTokens(USDG, WETH);
        assertEq(t0, WETH, "the order of the fields does not matter");
        assertEq(t1, USDG);
        (t0, t1) = CrossDexReader.sortTokens(PONS, USDG);
        assertEq(t0, PONS);
        assertEq(t1, USDG);
    }

    function testFuzz_SortTokensIsOrderIndependentAndAscending(address a, address b) public pure {
        vm.assume(a != address(0) && b != address(0) && a != b);
        (address t0, address t1) = CrossDexReader.sortTokens(a, b);
        (address u0, address u1) = CrossDexReader.sortTokens(b, a);
        assertEq(t0, u0);
        assertEq(t1, u1);
        assertLt(uint160(t0), uint160(t1));
        assertTrue((t0 == a && t1 == b) || (t0 == b && t1 == a));
    }

    function test_RevertWhen_SortTokensGivenZeroOrEqual() public {
        vm.expectRevert(CrossDexReader.ZeroToken.selector);
        harness.sortTokens(address(0), USDG);
        vm.expectRevert(CrossDexReader.ZeroToken.selector);
        harness.sortTokens(WETH, address(0));
        vm.expectRevert(CrossDexReader.SameToken.selector);
        harness.sortTokens(WETH, WETH);
    }

    // ------------------------------------------------------------------ payloads

    function test_GetPoolByFeeCalldataMatchesTheLiveCall() public pure {
        bytes memory data = CrossDexReader.getPoolByFeeCalldata(WETH, USDG, 500);
        assertEq(data.length, 4 + 3 * 32);
        assertEq(bytes4(data), bytes4(0x1698ee82));
        assertEq(data, abi.encodeWithSelector(bytes4(0x1698ee82), WETH, USDG, uint24(500)));
        // The exact bytes sent live to the SushiSwap factory (test/scratch probe, 2026-11-10).
        assertEq(
            data,
            hex"1698ee820000000000000000000000000bd7d308f8e1639fab988df18a8011f41eacad73"
            hex"0000000000000000000000005fc5360d0400a0fd4f2af552add042d716f1d168"
            hex"00000000000000000000000000000000000000000000000000000000000001f4"
        );
    }

    function test_GetPoolByTickSpacingCalldataMatchesTheLiveCall() public pure {
        bytes memory data = CrossDexReader.getPoolByTickSpacingCalldata(WETH, USDG, 1);
        assertEq(data.length, 4 + 3 * 32);
        assertEq(data, abi.encodeWithSelector(bytes4(0x28af8d0b), WETH, USDG, int24(1)));
    }

    function test_RevertWhen_PayloadTokensUnsortedOrTierUnsupported() public {
        vm.expectRevert(CrossDexReader.UnsortedTokens.selector);
        harness.getPoolByFeeCalldata(USDG, WETH, 500);
        vm.expectRevert(CrossDexReader.UnsortedTokens.selector);
        harness.getPoolByFeeCalldata(WETH, WETH, 500);
        vm.expectRevert(abi.encodeWithSelector(CrossDexReader.UnsupportedFee.selector, uint24(10000)));
        harness.getPoolByFeeCalldata(WETH, USDG, 10000);
        vm.expectRevert(CrossDexReader.UnsortedTokens.selector);
        harness.getPoolByTickSpacingCalldata(USDG, WETH, 1);
        vm.expectRevert(abi.encodeWithSelector(CrossDexReader.UnsupportedTickSpacing.selector, int24(60)));
        harness.getPoolByTickSpacingCalldata(WETH, USDG, 60);
    }

    // ------------------------------------------------------------------ decoding

    function test_DecodePoolAddressFoundAndZero() public pure {
        (address pool, bool found) = CrossDexReader.decodePoolAddress(abi.encode(SUSHI_POOL_500));
        assertEq(pool, SUSHI_POOL_500);
        assertTrue(found);
        (pool, found) = CrossDexReader.decodePoolAddress(abi.encode(address(0)));
        assertEq(pool, address(0));
        assertFalse(found, "a zero address is skipped silently");
    }

    function test_DecodeSlot0AcceptsSevenAndSixWordLayouts() public pure {
        // The live Sushi 0.05% reply: seven outputs (UniswapV3Pool).
        bytes memory seven =
            abi.encode(SUSHI_500_SQRT, SUSHI_500_TICK, uint16(26), uint16(64), uint16(64), uint8(0x44), true);
        (uint160 sqrt, int24 tick) = CrossDexReader.decodeSlot0(seven);
        assertEq(sqrt, SUSHI_500_SQRT);
        assertEq(tick, SUSHI_500_TICK);
        // Six words (the manual mode's declaration) decode the same first two.
        bytes memory six = abi.encode(RAMSES_TS1_SQRT, RAMSES_TS1_TICK, uint24(0), uint24(0), uint8(0), true);
        (sqrt, tick) = CrossDexReader.decodeSlot0(six);
        assertEq(sqrt, RAMSES_TS1_SQRT);
        assertEq(tick, RAMSES_TS1_TICK);
        // Exactly two words are enough.
        (sqrt, tick) = CrossDexReader.decodeSlot0(abi.encode(uint160(1), int24(-5)));
        assertEq(sqrt, 1);
        assertEq(tick, -5);
    }

    function test_DecodeLiquidityAndFee() public pure {
        assertEq(CrossDexReader.decodeLiquidity(abi.encode(uint128(SUSHI_500_LIQUIDITY))), SUSHI_500_LIQUIDITY);
        assertEq(CrossDexReader.decodeLiquidity(abi.encode(uint128(0))), 0, "liquidity 0 is a valid read");
        assertEq(CrossDexReader.decodeFee(abi.encode(uint24(1000))), 1000, "the Ramses ts=1 pool charges 0.10% now");
        assertEq(CrossDexReader.decodeFee(abi.encode(uint24(500))), 500);
    }

    function test_RevertWhen_ReplyTooShort() public {
        vm.expectRevert(abi.encodeWithSelector(CrossDexReader.ShortReply.selector, uint256(0)));
        harness.decodePoolAddress(hex"");
        vm.expectRevert(abi.encodeWithSelector(CrossDexReader.ShortReply.selector, uint256(32)));
        harness.decodeSlot0(abi.encode(uint256(1)));
        vm.expectRevert(abi.encodeWithSelector(CrossDexReader.ShortReply.selector, uint256(31)));
        harness.decodeLiquidity(new bytes(31));
        vm.expectRevert(abi.encodeWithSelector(CrossDexReader.ShortReply.selector, uint256(4)));
        harness.decodeFee(hex"deadbeef");
    }

    function test_RevertWhen_LiquidityDoesNotFitUint128() public {
        vm.expectRevert();
        harness.decodeLiquidity(abi.encode(uint256(type(uint128).max) + 1));
    }

    function testFuzz_DecodeRoundTrips(address pool, uint160 sqrt, int24 tick, uint128 liquidity, uint24 fee)
        public
        pure
    {
        (address decodedPool, bool found) = CrossDexReader.decodePoolAddress(abi.encode(pool));
        assertEq(decodedPool, pool);
        assertEq(found, pool != address(0));
        (uint160 s, int24 t) =
            CrossDexReader.decodeSlot0(abi.encode(sqrt, tick, uint16(1), uint16(1), uint16(1), uint8(0), true));
        assertEq(s, sqrt);
        assertEq(t, tick);
        assertEq(CrossDexReader.decodeLiquidity(abi.encode(liquidity)), liquidity);
        assertEq(CrossDexReader.decodeFee(abi.encode(fee)), fee);
    }

    // ------------------------------------------------------------------ price

    function test_PriceFromSqrtMatchesTheLiveTicks() public pure {
        // 1.0001^-200248 = 2.01268e-9 token1 per token0 base unit (2012.68 USDG per WETH after 18-6 decimals).
        uint256 sushi = CrossDexReader.priceE18FromSqrtPriceX96(SUSHI_500_SQRT);
        assertApproxEqRel(sushi, 2_012_679_683, 2e14, "within 0.02% of 1.0001^tick");
        // 1.0001^-200237 = 2.01489e-9 (Uniswap V3 0.05%).
        uint256 uni = CrossDexReader.priceE18FromSqrtPriceX96(UNI_500_SQRT);
        assertApproxEqRel(uni, 2_014_894_738, 2e14);
        // Ramses ts=1: 1.0001^-200224 = 2.01752e-9.
        uint256 ramses = CrossDexReader.priceE18FromSqrtPriceX96(RAMSES_TS1_SQRT);
        assertApproxEqRel(ramses, 2_017_515_674, 2e14);
        assertLt(sushi, uni, "Sushi quoted below Uniswap at that block");
        assertGt(ramses, uni, "Ramses quoted above it");
    }

    function test_PriceFromSqrtAtUnityAndZero() public pure {
        assertEq(CrossDexReader.priceE18FromSqrtPriceX96(uint160(1) << 96), 1e18, "sqrtPriceX96 = 2^96 is price 1");
        assertEq(CrossDexReader.priceE18FromSqrtPriceX96(uint160(2) << 96), 4e18);
        assertEq(CrossDexReader.priceE18FromSqrtPriceX96(0), 0);
    }

    function testFuzz_PriceFromSqrtIsMonotonic(uint160 a, uint160 b) public pure {
        vm.assume(a <= b);
        assertLe(CrossDexReader.priceE18FromSqrtPriceX96(a), CrossDexReader.priceE18FromSqrtPriceX96(b));
    }

    // ------------------------------------------------------------------ row rules

    function test_RowStatusMatrix() public pure {
        assertEq(uint256(CrossDexReader.rowStatus(true, true, SUSHI_500_SQRT)), uint256(CrossDexReader.Status.OK));
        assertEq(
            uint256(CrossDexReader.rowStatus(false, true, 0)), uint256(CrossDexReader.Status.NoPool), "zero address"
        );
        assertEq(uint256(CrossDexReader.rowStatus(false, false, 0)), uint256(CrossDexReader.Status.NoPool));
        assertEq(uint256(CrossDexReader.rowStatus(true, false, 0)), uint256(CrossDexReader.Status.Error), "read failed");
        assertEq(
            uint256(CrossDexReader.rowStatus(true, false, SUSHI_500_SQRT)),
            uint256(CrossDexReader.Status.Error),
            "a failed read is an error even with a last good price"
        );
        assertEq(
            uint256(CrossDexReader.rowStatus(true, true, 0)), uint256(CrossDexReader.Status.NoPool), "uninitialised"
        );
    }

    function testFuzz_RowStatusIsOkOnlyWhenFoundReadAndPriced(bool found, bool readOk, uint160 sqrt) public pure {
        CrossDexReader.Status status = CrossDexReader.rowStatus(found, readOk, sqrt);
        assertEq(status == CrossDexReader.Status.OK, found && readOk && sqrt != 0);
        assertEq(status == CrossDexReader.Status.Error, found && !readOk);
    }

    function test_ZeroAddressIsSkippedSilentlyUnlessSeenBefore() public pure {
        assertFalse(CrossDexReader.isDisplayed(false, false), "no row for a tier without a pool");
        assertTrue(CrossDexReader.isDisplayed(true, false));
        assertTrue(CrossDexReader.isDisplayed(true, true));
        assertTrue(CrossDexReader.isDisplayed(false, true), "a row that existed stays, marked no pool");
    }

    function test_KeepLastGoodOnError() public pure {
        (uint256 price, uint128 liquidity) = CrossDexReader.keepLastGood(10, 20, 30, 40, true);
        assertEq(price, 30);
        assertEq(liquidity, 40);
        (price, liquidity) = CrossDexReader.keepLastGood(10, 20, 30, 40, false);
        assertEq(price, 10, "a failed read keeps the last good price");
        assertEq(liquidity, 20);
        (price, liquidity) = CrossDexReader.keepLastGood(0, 0, 0, 0, false);
        assertEq(price, 0, "with no last good data the row stays empty");
    }

    function testFuzz_KeepLastGood(uint256 lp, uint128 ll, uint256 np, uint128 nl, bool ok) public pure {
        (uint256 price, uint128 liquidity) = CrossDexReader.keepLastGood(lp, ll, np, nl, ok);
        assertEq(price, ok ? np : lp);
        assertEq(liquidity, ok ? nl : ll);
    }

    // ------------------------------------------------------------------ Uniswap reference and spread

    function test_BestUniPriceIsTheDeepestPool() public pure {
        uint256[] memory prices = new uint256[](4);
        uint128[] memory liquidities = new uint128[](4);
        // Uniswap V3 WETH/USDG at the live block: 0.01%, 0.05%, 0.30%, 1.00%.
        prices[0] = CrossDexReader.priceE18FromSqrtPriceX96(UNI_100_SQRT);
        liquidities[0] = UNI_100_LIQUIDITY;
        prices[1] = CrossDexReader.priceE18FromSqrtPriceX96(UNI_500_SQRT);
        liquidities[1] = UNI_500_LIQUIDITY;
        prices[2] = 2_009_462_131;
        liquidities[2] = 0xd4bf29c4b96d7b;
        prices[3] = 2_024_184_139;
        liquidities[3] = 0x10978a73bd9357;
        (uint256 price, bool found) = CrossDexReader.bestUniPrice(prices, liquidities);
        assertTrue(found);
        assertEq(price, prices[1], "the 0.05% pool holds the most liquidity");
    }

    function test_BestUniPriceSkipsUnpricedAndEmptyPools() public pure {
        uint256[] memory prices = new uint256[](3);
        uint128[] memory liquidities = new uint128[](3);
        prices[0] = 0;
        liquidities[0] = type(uint128).max; // no price: skipped however deep
        prices[1] = 7;
        liquidities[1] = 0; // empty: skipped
        prices[2] = 9;
        liquidities[2] = 1;
        (uint256 price, bool found) = CrossDexReader.bestUniPrice(prices, liquidities);
        assertTrue(found);
        assertEq(price, 9);
        liquidities[2] = 0;
        (price, found) = CrossDexReader.bestUniPrice(prices, liquidities);
        assertFalse(found, "nothing priced: the Spread column shows a dash");
        assertEq(price, 0);
        (price, found) = CrossDexReader.bestUniPrice(new uint256[](0), new uint128[](0));
        assertFalse(found, "no Uniswap pool at all");
    }

    function test_BestUniPriceTiesGoToTheLowerTier() public pure {
        uint256[] memory prices = new uint256[](2);
        uint128[] memory liquidities = new uint128[](2);
        prices[0] = 5;
        liquidities[0] = 100;
        prices[1] = 6;
        liquidities[1] = 100;
        (uint256 price,) = CrossDexReader.bestUniPrice(prices, liquidities);
        assertEq(price, 5);
    }

    function test_RevertWhen_BestUniPriceListsMismatch() public {
        vm.expectRevert(CrossDexReader.LengthMismatch.selector);
        harness.bestUniPrice(new uint256[](2), new uint128[](1));
    }

    function testFuzz_BestUniPricePicksTheGreatestLiquidity(uint256[4] memory p, uint128[4] memory l) public pure {
        uint256[] memory prices = new uint256[](4);
        uint128[] memory liquidities = new uint128[](4);
        uint128 best = 0;
        uint256 expected = 0;
        bool any = false;
        for (uint256 i = 0; i < 4; i++) {
            prices[i] = p[i];
            liquidities[i] = l[i];
            if (p[i] != 0 && l[i] != 0 && (!any || l[i] > best)) {
                best = l[i];
                expected = p[i];
                any = true;
            }
        }
        (uint256 price, bool found) = CrossDexReader.bestUniPrice(prices, liquidities);
        assertEq(found, any);
        assertEq(price, expected);
    }

    function test_SpreadVsUniMatchesTheLiveReads() public pure {
        uint256 sushi = CrossDexReader.priceE18FromSqrtPriceX96(SUSHI_500_SQRT);
        uint256 uni = CrossDexReader.priceE18FromSqrtPriceX96(UNI_500_SQRT);
        int256 spread = CrossDexReader.spreadVsUniE18(sushi, uni);
        // Exact prices: (3554505806984652282396672 / 3556392679920231423772973)^2 - 1 = -0.1061%.
        // From the ticks alone (-200248 vs -200237) the page shows about -0.11%: a tick is 0.01% wide.
        assertLt(spread, 0);
        assertApproxEqAbs(spread, int256(-0.1061e18), 0.001e18);
        uint256 ramses = CrossDexReader.priceE18FromSqrtPriceX96(RAMSES_TS1_SQRT);
        spread = CrossDexReader.spreadVsUniE18(ramses, uni);
        assertGt(spread, 0);
        assertApproxEqAbs(spread, int256(0.133e18), 0.001e18);
        assertEq(CrossDexReader.spreadVsUniE18(uni, uni), 0, "the same price is a 0.00% spread");
        assertEq(CrossDexReader.spreadVsUniE18(2e18, 1e18), 100e18, "double the reference is +100%");
        assertEq(CrossDexReader.spreadVsUniE18(1e18, 2e18), -50e18, "half of it is -50%");
    }

    function test_RevertWhen_NoUniReference() public {
        assertFalse(CrossDexReader.hasUniReference(0));
        assertTrue(CrossDexReader.hasUniReference(1));
        vm.expectRevert(CrossDexReader.NoUniReference.selector);
        harness.spreadVsUniE18(1e18, 0);
    }

    function testFuzz_SpreadSignFollowsThePrices(uint128 dex, uint128 uni) public pure {
        vm.assume(uni != 0);
        int256 spread = CrossDexReader.spreadVsUniE18(dex, uni);
        // A difference below 1e-18 of the reference rounds to 0, so the sign check is non-strict.
        if (dex > uni) assertGe(spread, 0);
        else if (dex < uni) assertLe(spread, 0);
        else assertEq(spread, 0);
        assertGe(spread, -100e18, "a price can never be more than 100% below the reference");
    }

    function test_FeeToBps() public pure {
        assertEq(CrossDexReader.feeToBps(100), 1);
        assertEq(CrossDexReader.feeToBps(500), 5);
        assertEq(CrossDexReader.feeToBps(3000), 30);
        assertEq(CrossDexReader.feeToBps(1000), 10);
    }
}
