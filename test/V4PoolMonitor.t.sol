// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {V4SwapCalldata} from "../src/V4SwapCalldata.sol";
import {V4PoolMonitor} from "../src/V4PoolMonitor.sol";

/// @dev External entry points so reverts can be expected.
contract MonitorHarness {
    function sortPair(address a, address b) external pure returns (address, address) {
        return V4PoolMonitor.sortPair(a, b);
    }

    function poolKeys(address c0, address c1) external pure returns (V4SwapCalldata.PoolKey[7] memory) {
        return V4PoolMonitor.poolKeys(c0, c1);
    }

    function spreadBps(uint256 a, uint256 b) external pure returns (uint256) {
        return V4PoolMonitor.spreadBps(a, b);
    }

    function applySlippage(uint256 amount, uint256 bps) external pure returns (uint256) {
        return V4PoolMonitor.applySlippage(amount, bps);
    }

    function decodeQuoteRevert(bytes memory data, uint256 amountIn) external pure returns (uint256) {
        return V4PoolMonitor.decodeQuoteRevert(data, amountIn);
    }

    function decodeSwapTick(bytes memory data) external pure returns (int24) {
        return V4PoolMonitor.decodeSwapTick(data);
    }
}

contract V4PoolMonitorTest is Test {
    MonitorHarness internal harness;

    // Observed on the live router on 2026-11-07: 0.01 USDG into pool 3000/60 bought 52358673121064015 PONS.
    uint256 internal constant LIVE_PRICE_X36 = 5235867312106401500000000000000000000000000000000;
    uint256 internal constant LIVE_AMOUNT_IN = 10_000;
    uint256 internal constant LIVE_AMOUNT_OUT = 52_358_673_121_064_015;
    // The same values after the JavaScript applySlippage(quote, 50).
    uint256 internal constant LIVE_BRIDGE = 52_096_879_755_458_694;
    // keccak256(abi.encode(PONS, USDG, fee, spacing, 0)) from cast and from the JavaScript poolId().
    bytes32 internal constant POOL_A_ID = 0x4be9657ec9002e528f4f17a5c43edc525a07f888f7b180c2afbf75e096c4f38a;
    bytes32 internal constant POOL_B_ID = 0x2e7ba084e848fb5af806efaeccfc9676a1a4c459f696e852b53c1a4f650c39b6;

    function setUp() public {
        harness = new MonitorHarness();
    }

    // ---------------------------------------------------------------- pool ids

    function test_PoolIdMatchesCastAndJavaScript() public pure {
        assertEq(V4PoolMonitor.poolId(V4SwapCalldata.poolA()), POOL_A_ID);
        assertEq(V4PoolMonitor.poolId(V4SwapCalldata.poolB()), POOL_B_ID);
    }

    function test_SwapTopicIsTheEventSignature() public pure {
        assertEq(
            V4PoolMonitor.SWAP_TOPIC, keccak256("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)")
        );
    }

    function test_SortPairPutsTheLowerAddressFirstEitherWay() public pure {
        (address c0, address c1) = V4PoolMonitor.sortPair(V4SwapCalldata.USDG, V4SwapCalldata.PONS);
        assertEq(c0, V4SwapCalldata.PONS);
        assertEq(c1, V4SwapCalldata.USDG);
        (c0, c1) = V4PoolMonitor.sortPair(V4SwapCalldata.PONS, V4SwapCalldata.USDG);
        assertEq(c0, V4SwapCalldata.PONS);
        assertEq(c1, V4SwapCalldata.USDG);
    }

    function test_RevertWhen_PairIsIdenticalOrZero() public {
        vm.expectRevert(V4PoolMonitor.IdenticalTokens.selector);
        harness.sortPair(V4SwapCalldata.PONS, V4SwapCalldata.PONS);
        vm.expectRevert(V4PoolMonitor.ZeroToken.selector);
        harness.sortPair(address(0), V4SwapCalldata.PONS);
        vm.expectRevert(V4PoolMonitor.ZeroToken.selector);
        harness.sortPair(V4SwapCalldata.USDG, address(0));
    }

    function test_PoolKeysCoverTheSevenTiersWithDistinctIds() public pure {
        V4SwapCalldata.PoolKey[7] memory keys = V4PoolMonitor.poolKeys(V4SwapCalldata.PONS, V4SwapCalldata.USDG);
        (uint24[7] memory fees, int24[7] memory spacings) = V4PoolMonitor.feeTiers();
        assertEq(fees[4], 3000);
        assertEq(spacings[4], 60);
        assertEq(fees[6], 30000);
        assertEq(spacings[6], 600);
        for (uint256 i = 0; i < 7; ++i) {
            assertEq(keys[i].currency0, V4SwapCalldata.PONS);
            assertEq(keys[i].currency1, V4SwapCalldata.USDG);
            assertEq(keys[i].fee, fees[i]);
            assertEq(keys[i].tickSpacing, spacings[i]);
            assertEq(keys[i].hooks, address(0));
            for (uint256 j = 0; j < i; ++j) {
                assertNotEq(V4PoolMonitor.poolId(keys[i]), V4PoolMonitor.poolId(keys[j]));
            }
        }
        assertEq(V4PoolMonitor.poolId(keys[4]), POOL_A_ID);
        assertEq(V4PoolMonitor.poolId(keys[6]), POOL_B_ID);
    }

    function test_RevertWhen_PoolKeysPairIsUnsorted() public {
        vm.expectRevert(V4SwapCalldata.CurrenciesNotSorted.selector);
        harness.poolKeys(V4SwapCalldata.USDG, V4SwapCalldata.PONS);
    }

    // ---------------------------------------------------------------- spreads

    function test_SpreadFeeAndNetForKnownPrices() public pure {
        // 1.00 vs 1.01: a 1% gap is 100 bps of the lower price.
        assertEq(V4PoolMonitor.spreadBps(1e18, 1.01e18), 100);
        assertEq(V4PoolMonitor.spreadBps(1.01e18, 1e18), 100);
        assertEq(V4PoolMonitor.spreadBps(5e18, 5e18), 0);
        // Two 0.30% pools cost 60 bps; 3000 + 30000 pips cost 330 bps.
        assertEq(V4PoolMonitor.feeCostBps(3000, 3000), 60);
        assertEq(V4PoolMonitor.feeCostBps(3000, 30000), 330);
        assertEq(V4PoolMonitor.feeCostBps(0, 500), 5);
        assertEq(V4PoolMonitor.netBps(1e18, 1.01e18, 3000, 3000), 40);
        assertEq(V4PoolMonitor.netBps(1e18, 1.01e18, 3000, 30000), -230);
    }

    function test_VerdictIsStrictlyAboveTheThreshold() public pure {
        assertTrue(V4PoolMonitor.isGreen(51, 50));
        assertFalse(V4PoolMonitor.isGreen(50, 50));
        assertFalse(V4PoolMonitor.isGreen(-230, 50));
        assertTrue(V4PoolMonitor.isGreen(1, 0));
        assertFalse(V4PoolMonitor.isGreen(type(int256).max, type(uint256).max));
    }

    function test_RevertWhen_PriceIsZero() public {
        vm.expectRevert(V4PoolMonitor.ZeroPrice.selector);
        harness.spreadBps(0, 1e18);
        vm.expectRevert(V4PoolMonitor.ZeroPrice.selector);
        harness.spreadBps(1e18, 0);
    }

    // ---------------------------------------------------------------- slippage and quotes

    function test_ApplySlippageMatchesTheJavaScriptBridgeAmount() public pure {
        assertEq(V4PoolMonitor.applySlippage(LIVE_AMOUNT_OUT, V4PoolMonitor.SLIPPAGE_BPS), LIVE_BRIDGE);
        assertEq(V4PoolMonitor.applySlippage(LIVE_AMOUNT_OUT, 0), LIVE_AMOUNT_OUT);
        assertEq(V4PoolMonitor.applySlippage(LIVE_AMOUNT_OUT, 10_000), 0);
    }

    function test_RevertWhen_SlippageAbove100Percent() public {
        vm.expectRevert(V4PoolMonitor.SlippageTooHigh.selector);
        harness.applySlippage(1e18, 10_001);
    }

    function _priceRevert(uint256 priceX36) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(V4PoolMonitor.QUOTE_REVERT_SELECTOR, type(uint256).max, priceX36);
    }

    function test_DecodeQuoteRevertReproducesTheLiveQuote() public pure {
        assertEq(V4PoolMonitor.decodeQuoteRevert(_priceRevert(LIVE_PRICE_X36), LIVE_AMOUNT_IN), LIVE_AMOUNT_OUT);
        // The empty 30000/600 pool answers with price 0: "no liquidity".
        assertEq(V4PoolMonitor.decodeQuoteRevert(_priceRevert(0), LIVE_AMOUNT_IN), 0);
    }

    function test_QuoteRevertSelectorIsTheRoutersError() public pure {
        assertEq(
            V4PoolMonitor.QUOTE_REVERT_SELECTOR, bytes4(keccak256("V4TooLittleReceivedPerHopSingle(uint256,uint256)"))
        );
    }

    function test_RevertWhen_QuoteDataIsNotThePriceCheck() public {
        // SliceOutOfBounds(), PoolNotInitialized(), empty data and a truncated price revert are all refused.
        vm.expectRevert(V4PoolMonitor.NotPriceRevert.selector);
        harness.decodeQuoteRevert(hex"3b99b53d", LIVE_AMOUNT_IN);
        vm.expectRevert(V4PoolMonitor.NotPriceRevert.selector);
        harness.decodeQuoteRevert(abi.encodeWithSelector(bytes4(0x486aa307)), LIVE_AMOUNT_IN);
        vm.expectRevert(V4PoolMonitor.NotPriceRevert.selector);
        harness.decodeQuoteRevert("", LIVE_AMOUNT_IN);
        bytes memory full = _priceRevert(LIVE_PRICE_X36);
        bytes memory cut = new bytes(full.length - 1);
        for (uint256 i = 0; i < cut.length; ++i) {
            cut[i] = full[i];
        }
        vm.expectRevert(V4PoolMonitor.NotPriceRevert.selector);
        harness.decodeQuoteRevert(cut, LIVE_AMOUNT_IN);
        // Right selector, wrong length.
        vm.expectRevert(V4PoolMonitor.NotPriceRevert.selector);
        harness.decodeQuoteRevert(abi.encodeWithSelector(V4PoolMonitor.QUOTE_REVERT_SELECTOR, uint256(1)), 1);
    }

    // ---------------------------------------------------------------- swap logs

    function test_DecodeSwapTickFromTheEventData() public pure {
        bytes memory data = abi.encode(
            int128(-1000), int128(1000), uint160(34563993575947629248983), uint128(1), int24(-292916), uint24(3000)
        );
        assertEq(V4PoolMonitor.decodeSwapTick(data), -292916);
    }

    function test_RevertWhen_SwapLogDataHasTheWrongLength() public {
        vm.expectRevert(V4PoolMonitor.MalformedSwapLog.selector);
        harness.decodeSwapTick(abi.encode(int128(-1000), int128(1000), uint160(1), uint128(1), int24(5)));
        vm.expectRevert(V4PoolMonitor.MalformedSwapLog.selector);
        harness.decodeSwapTick("");
    }

    // ---------------------------------------------------------------- fuzz

    function testFuzz_SpreadIsSymmetricAndZeroOnlyForEqualPrices(uint128 a, uint128 b) public pure {
        a = uint128(bound(a, 1, type(uint128).max));
        b = uint128(bound(b, 1, type(uint128).max));
        uint256 spread = V4PoolMonitor.spreadBps(a, b);
        assertEq(spread, V4PoolMonitor.spreadBps(b, a));
        if (a == b) assertEq(spread, 0);
        // A gap smaller than 0.01% of the lower price rounds to zero; anything at least 1 bp apart does not.
        (uint256 low, uint256 high) = a <= b ? (a, b) : (b, a);
        if ((high - low) * V4PoolMonitor.BPS >= low) assertGt(spread, 0);
    }

    function testFuzz_SlippageNeverIncreasesTheAmount(uint128 amount, uint256 bps) public pure {
        bps = bound(bps, 0, V4PoolMonitor.BPS);
        uint256 result = V4PoolMonitor.applySlippage(amount, bps);
        assertLe(result, amount);
        if (bps == 0) assertEq(result, amount);
        if (bps == V4PoolMonitor.BPS) assertEq(result, 0);
        // The default 0.5% keeps at least 99.5% of the amount, rounded down.
        if (bps == V4PoolMonitor.SLIPPAGE_BPS) assertEq(result, uint256(amount) * 9950 / 10_000);
    }

    function testFuzz_QuoteRoundTripsThroughTheRoutersPrice(uint128 amountOut, uint256 amountIn) public pure {
        amountIn = bound(amountIn, 1, 1e36);
        uint256 priceX36 = uint256(amountOut) * V4PoolMonitor.X36 / amountIn; // what the router computes
        uint256 recovered = V4PoolMonitor.decodeQuoteRevert(_priceRevert(priceX36), amountIn);
        assertLe(recovered, amountOut);
        assertGe(recovered + 1, amountOut);
    }

    function testFuzz_PoolIdsOfOnePairDifferByTier(address tokenA, address tokenB, uint8 i, uint8 j) public pure {
        vm.assume(tokenA != tokenB && tokenA != address(0) && tokenB != address(0));
        i = uint8(bound(i, 0, 6));
        j = uint8(bound(j, 0, 6));
        (address c0, address c1) = V4PoolMonitor.sortPair(tokenA, tokenB);
        V4SwapCalldata.PoolKey[7] memory keys = V4PoolMonitor.poolKeys(c0, c1);
        assertEq(V4PoolMonitor.poolId(keys[i]) == V4PoolMonitor.poolId(keys[j]), i == j);
        assertEq(
            V4PoolMonitor.poolId(keys[i]), keccak256(abi.encode(c0, c1, keys[i].fee, keys[i].tickSpacing, address(0)))
        );
    }
}
