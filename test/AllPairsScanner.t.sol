// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {AllPairsScanner} from "../src/AllPairsScanner.sol";
import {V4PoolMonitor} from "../src/V4PoolMonitor.sol";
import {V4SwapCalldata} from "../src/V4SwapCalldata.sol";

contract AllPairsScannerHarness {
    function requireExecutable(bytes32 a, bytes32 b, bytes32 poolA, bytes32 poolB) external pure {
        AllPairsScanner.requireExecutable(a, b, poolA, poolB);
    }

    function pairKey(address a, address b) external pure returns (bytes32) {
        return AllPairsScanner.pairKey(a, b);
    }
}

contract AllPairsScannerTest is Test {
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant PONS = 0x39dBED3a2bd333467115dE45665cC57F813C4571;

    AllPairsScannerHarness internal harness;

    function setUp() public {
        harness = new AllPairsScannerHarness();
    }

    function _key(address c0, address c1, uint24 fee, int24 spacing)
        internal
        pure
        returns (V4SwapCalldata.PoolKey memory)
    {
        return V4SwapCalldata.PoolKey({currency0: c0, currency1: c1, fee: fee, tickSpacing: spacing, hooks: address(0)});
    }

    // ------------------------------------------------------------------ liquidity slot

    function test_LiquiditySlotIsSlot0SlotPlusThree() public pure {
        bytes32 id = V4PoolMonitor.poolId(_key(PONS, USDG, 3000, 60));
        bytes32 slot0 = V4PoolMonitor.slot0Slot(id);
        assertEq(uint256(AllPairsScanner.liquiditySlot(id)) - uint256(slot0), 3);
        assertEq(AllPairsScanner.LIQUIDITY_OFFSET, 3);
    }

    function test_LiquiditySlotMatchesTheJavaScriptEncoding() public pure {
        // keccak256(abi.encode(poolId, 6)) + 3, as js liquidityStorageSlot computes it.
        bytes32 id = V4PoolMonitor.poolId(_key(PONS, USDG, 30000, 600));
        assertEq(AllPairsScanner.liquiditySlot(id), bytes32(uint256(keccak256(abi.encode(id, uint256(6)))) + 3));
    }

    function test_DecodeLiquidityTakesTheLow128Bits() public pure {
        assertEq(AllPairsScanner.decodeLiquidity(bytes32(uint256(42))), 42);
        assertEq(AllPairsScanner.decodeLiquidity(bytes32(0)), 0);
        assertEq(AllPairsScanner.decodeLiquidity(bytes32(type(uint256).max)), type(uint128).max);
        assertEq(AllPairsScanner.decodeLiquidity(bytes32(uint256(1) << 128)), 0, "high bits are not liquidity");
    }

    function testFuzz_DecodeLiquidityRoundTrips(uint128 liquidity, uint128 highBits) public pure {
        bytes32 word = bytes32((uint256(highBits) << 128) | uint256(liquidity));
        assertEq(AllPairsScanner.decodeLiquidity(word), liquidity);
    }

    // ------------------------------------------------------------------ drained tick filter

    function test_DrainedTickFilterMarksThe30000600PoolEmpty() public pure {
        assertTrue(AllPairsScanner.isDrained(AllPairsScanner.Protocol.V4, -887272), "the live 30000/600 tick");
        assertTrue(AllPairsScanner.isDrained(AllPairsScanner.Protocol.V4, -887000), "the boundary is inclusive");
        assertFalse(AllPairsScanner.isDrained(AllPairsScanner.Protocol.V4, -886999));
        assertFalse(AllPairsScanner.isDrained(AllPairsScanner.Protocol.V4, -292916), "the healthy 3000/60 tick");
        assertFalse(AllPairsScanner.isDrained(AllPairsScanner.Protocol.V3, -887272), "V3 pools are not filtered");
        assertFalse(AllPairsScanner.isDrained(AllPairsScanner.Protocol.V4, -887273), "below MIN_TICK is not a tick");
    }

    function testFuzz_DrainedOnlyAtOrBelowTheFloor(int24 tick) public pure {
        bool drained = AllPairsScanner.isDrained(AllPairsScanner.Protocol.V4, tick);
        assertEq(drained, tick >= -887272 && tick <= -887000);
    }

    // ------------------------------------------------------------------ pairwise spreads

    function test_PairwiseCountOfActivePools() public pure {
        assertEq(AllPairsScanner.pairwiseCount(0), 0);
        assertEq(AllPairsScanner.pairwiseCount(1), 0);
        assertEq(AllPairsScanner.pairwiseCount(2), 1);
        assertEq(AllPairsScanner.pairwiseCount(4), 6, "two pairs with two pools each: 2 same-pair + 4 cross-pair");
        assertEq(AllPairsScanner.pairwiseCount(7), 21);
    }

    function test_PairKeyIsOrderIndependentAndDistinguishesTokenBs() public view {
        bytes32 ponsUsdg = harness.pairKey(PONS, USDG);
        assertEq(ponsUsdg, harness.pairKey(USDG, PONS));
        assertTrue(ponsUsdg != harness.pairKey(PONS, WETH));
        assertEq(AllPairsScanner.legs(ponsUsdg, harness.pairKey(USDG, PONS)) == AllPairsScanner.Legs.TwoLeg, true);
        assertEq(AllPairsScanner.legs(ponsUsdg, harness.pairKey(PONS, WETH)) == AllPairsScanner.Legs.ThreeLeg, true);
    }

    function test_PairKeyRejectsIdenticalOrZeroTokens() public {
        vm.expectRevert(V4PoolMonitor.IdenticalTokens.selector);
        harness.pairKey(PONS, PONS);
        vm.expectRevert(V4PoolMonitor.ZeroToken.selector);
        harness.pairKey(address(0), PONS);
    }

    function test_OnlySamePairDifferentPoolsAreExecutable() public {
        bytes32 ponsUsdg = harness.pairKey(PONS, USDG);
        bytes32 ponsWeth = harness.pairKey(PONS, WETH);
        bytes32 a = V4PoolMonitor.poolId(_key(PONS, USDG, 3000, 60));
        bytes32 b = V4PoolMonitor.poolId(_key(PONS, USDG, 2500, 25));
        harness.requireExecutable(ponsUsdg, ponsUsdg, a, b);
        vm.expectRevert(AllPairsScanner.NotExecutable.selector);
        harness.requireExecutable(ponsUsdg, ponsWeth, a, b);
        vm.expectRevert(AllPairsScanner.NotExecutable.selector);
        harness.requireExecutable(ponsUsdg, ponsUsdg, a, a);
    }

    // ------------------------------------------------------------------ gas estimate

    function test_GasUnitsPerProtocolAndMixed() public pure {
        assertEq(AllPairsScanner.gasUnits(AllPairsScanner.Protocol.V3, AllPairsScanner.Protocol.V3), 250_000);
        assertEq(AllPairsScanner.gasUnits(AllPairsScanner.Protocol.V4, AllPairsScanner.Protocol.V4), 400_000);
        assertEq(AllPairsScanner.gasUnits(AllPairsScanner.Protocol.V3, AllPairsScanner.Protocol.V4), 650_000);
        assertEq(AllPairsScanner.gasUnits(AllPairsScanner.Protocol.V4, AllPairsScanner.Protocol.V3), 650_000);
    }

    function test_GasCostAtTwoGweiWithEthAtThreeThousand() public pure {
        uint256 cost = AllPairsScanner.gasCostWei(AllPairsScanner.Protocol.V4, AllPairsScanner.Protocol.V4, 2 gwei);
        assertEq(cost, 0.0008 ether);
        assertEq(AllPairsScanner.gasCostUsd6(cost, 3000e6), 2.4e6, "$2.40");
        assertEq(AllPairsScanner.gasCostUsd6(0, 3000e6), 0);
    }

    function testFuzz_GasCostIsLinearInGasPrice(uint64 gasPrice) public pure {
        assertEq(
            AllPairsScanner.gasCostWei(AllPairsScanner.Protocol.V3, AllPairsScanner.Protocol.V3, gasPrice),
            uint256(gasPrice) * 250_000
        );
    }

    function test_NetAfterGasCanGoNegative() public pure {
        // 0.01 USDG in, 0.0135 USDG back, gas worth 0.0024 USDG: +0.0011 USDG.
        assertEq(AllPairsScanner.netAfterGas(10_000, 13_500, 2_400), 1_100);
        // Gas above the gain.
        assertEq(AllPairsScanner.netAfterGas(10_000, 10_100, 2_400), -2_300);
        // A losing quote.
        assertEq(AllPairsScanner.netAfterGas(10_000, 9_000, 0), -1_000);
    }

    // ------------------------------------------------------------------ multi-tab lock

    function test_LockFreshnessRule() public pure {
        uint256 nowTs = 1_700_000_000;
        assertFalse(AllPairsScanner.lockActive(0, nowTs), "no lock");
        assertTrue(AllPairsScanner.lockActive(nowTs, nowTs), "just written");
        assertTrue(AllPairsScanner.lockActive(nowTs - 299, nowTs));
        assertFalse(AllPairsScanner.lockActive(nowTs - 300, nowTs), "five minutes old has expired");
        assertFalse(AllPairsScanner.lockActive(nowTs - 3600, nowTs));
        assertTrue(AllPairsScanner.lockActive(nowTs + 10, nowTs), "a future timestamp is treated as active");
        assertEq(AllPairsScanner.LOCK_TTL_SECONDS, 300);
    }

    function testFuzz_LockExpiresExactlyAfterTtl(uint32 age, uint64 nowTs) public pure {
        vm.assume(nowTs > age && nowTs > 0);
        uint256 lockTs = uint256(nowTs) - age;
        if (lockTs == 0) return;
        assertEq(AllPairsScanner.lockActive(lockTs, nowTs), age < 300);
    }
}
