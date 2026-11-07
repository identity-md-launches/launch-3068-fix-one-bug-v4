// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {V3ManualPool} from "../src/V3ManualPool.sol";

/// @dev A pool-shaped contract: canonical seven-word slot0, or the brief's six-word layout.
contract ManualPoolMock {
    address internal token0;
    address internal token1;
    uint24 internal fee;
    uint160 internal sqrtPriceX96;
    int24 internal tick;
    bool internal sixWords;
    bytes4 internal revertOn;

    constructor(address token0_, address token1_, uint24 fee_, uint160 sqrtPriceX96_, int24 tick_) {
        token0 = token0_;
        token1 = token1_;
        fee = fee_;
        sqrtPriceX96 = sqrtPriceX96_;
        tick = tick_;
    }

    function setPrice(uint160 sqrtPriceX96_, int24 tick_) external {
        sqrtPriceX96 = sqrtPriceX96_;
        tick = tick_;
    }

    function setSixWords(bool value) external {
        sixWords = value;
    }

    function setRevertOn(bytes4 selector) external {
        revertOn = selector;
    }

    fallback(bytes calldata data) external returns (bytes memory) {
        bytes4 selector = bytes4(data[:4]);
        if (selector == revertOn) revert("mock revert");
        if (selector == V3ManualPool.TOKEN0_SELECTOR) return abi.encode(token0);
        if (selector == V3ManualPool.TOKEN1_SELECTOR) return abi.encode(token1);
        if (selector == V3ManualPool.FEE_SELECTOR) return abi.encode(fee);
        if (selector == V3ManualPool.SLOT0_SELECTOR) {
            if (sixWords) return abi.encode(sqrtPriceX96, tick, uint24(0), fee, uint8(60), true);
            return abi.encode(sqrtPriceX96, tick, uint16(0), uint16(1), uint16(1), uint8(0), true);
        }
        revert("unknown selector");
    }
}

/// @dev A contract with code but no pool functions (a token, say): every read reverts.
contract NotAPool {
    function symbol() external pure returns (string memory) {
        return "PONS";
    }
}

/// @dev Exposes the library so `vm.expectRevert` sees external calls.
contract ManualHarness {
    function read(address pool) external view returns (V3ManualPool.Reading memory) {
        return V3ManualPool.read(pool);
    }

    function validate(V3ManualPool.Reading memory a, V3ManualPool.Reading memory b)
        external
        pure
        returns (V3ManualPool.Reading memory, V3ManualPool.Reading memory)
    {
        return V3ManualPool.validate(a, b);
    }

    function decodeSlot0(bytes memory reply) external pure returns (uint160, int24) {
        return V3ManualPool.decodeSlot0(reply);
    }
}

contract V3ManualPoolTest is Test {
    // The brief's pools and their live replies on chain 4663, 2026-11-07.
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    address internal constant PONS = 0x39dBED3a2bd333467115dE45665cC57F813C4571;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    uint160 internal constant LIVE_SQRT_A = 0x6de19cd729279cd0d3d20effb4;
    int24 internal constant LIVE_TICK_A = 93992;
    uint160 internal constant LIVE_SQRT_B = 0x6e482fb88f9dc537e6be8af519;
    int24 internal constant LIVE_TICK_B = 94065;

    ManualHarness internal harness;
    ManualPoolMock internal poolA; // the brief's "Pool A": fee() answers 10000 on chain
    ManualPoolMock internal poolB; // the brief's "Pool B": 3000
    ManualPoolMock internal otherPair;

    function setUp() public {
        harness = new ManualHarness();
        poolA = new ManualPoolMock(WETH, PONS, 10000, LIVE_SQRT_A, LIVE_TICK_A);
        poolB = new ManualPoolMock(WETH, PONS, 3000, LIVE_SQRT_B, LIVE_TICK_B);
        otherPair = new ManualPoolMock(PONS, USDG, 3000, uint160(1) << 96, -292916);
    }

    function test_ReadsTokensFeeAndSlot0FromBothLayouts() public {
        V3ManualPool.Reading memory a = harness.read(address(poolA));
        assertEq(a.pool, address(poolA));
        assertEq(a.token0, WETH);
        assertEq(a.token1, PONS);
        assertEq(a.fee, 10000);
        assertEq(a.sqrtPriceX96, LIVE_SQRT_A);
        assertEq(a.tick, LIVE_TICK_A);
        poolB.setSixWords(true);
        V3ManualPool.Reading memory b = harness.read(address(poolB));
        assertEq(b.fee, 3000);
        assertEq(b.sqrtPriceX96, LIVE_SQRT_B);
        assertEq(b.tick, LIVE_TICK_B);
    }

    function test_SelectorsMatchTheV3PoolAbi() public pure {
        assertEq(V3ManualPool.TOKEN0_SELECTOR, bytes4(keccak256("token0()")));
        assertEq(V3ManualPool.TOKEN1_SELECTOR, bytes4(keccak256("token1()")));
        assertEq(V3ManualPool.FEE_SELECTOR, bytes4(keccak256("fee()")));
        assertEq(V3ManualPool.SLOT0_SELECTOR, bytes4(keccak256("slot0()")));
        assertEq(V3ManualPool.READS_PER_POOL, 4);
    }

    function test_RevertWhen_AddressHasNoCode() public {
        address empty = makeAddr("no code");
        vm.expectRevert(abi.encodeWithSelector(V3ManualPool.InvalidPool.selector, empty));
        harness.read(empty);
        vm.expectRevert(abi.encodeWithSelector(V3ManualPool.InvalidPool.selector, address(0)));
        harness.read(address(0));
    }

    function test_RevertWhen_ContractIsNotAPool() public {
        NotAPool token = new NotAPool();
        vm.expectRevert(abi.encodeWithSelector(V3ManualPool.InvalidPool.selector, address(token)));
        harness.read(address(token));
    }

    function test_RevertWhen_AnyOfTheFourReadsReverts() public {
        bytes4[4] memory selectors = [
            V3ManualPool.TOKEN0_SELECTOR,
            V3ManualPool.TOKEN1_SELECTOR,
            V3ManualPool.FEE_SELECTOR,
            V3ManualPool.SLOT0_SELECTOR
        ];
        for (uint256 i = 0; i < selectors.length; ++i) {
            poolA.setRevertOn(selectors[i]);
            vm.expectRevert(abi.encodeWithSelector(V3ManualPool.InvalidPool.selector, address(poolA)));
            harness.read(address(poolA));
        }
        poolA.setRevertOn(bytes4(0));
        assertEq(harness.read(address(poolA)).fee, 10000);
    }

    function test_RevertWhen_PoolValuesAreImpossible() public {
        ManualPoolMock unsorted = new ManualPoolMock(PONS, WETH, 3000, LIVE_SQRT_A, LIVE_TICK_A);
        vm.expectRevert(abi.encodeWithSelector(V3ManualPool.InvalidPool.selector, address(unsorted)));
        harness.read(address(unsorted));
        ManualPoolMock zeroToken = new ManualPoolMock(address(0), WETH, 3000, LIVE_SQRT_A, LIVE_TICK_A);
        vm.expectRevert(abi.encodeWithSelector(V3ManualPool.InvalidPool.selector, address(zeroToken)));
        harness.read(address(zeroToken));
        ManualPoolMock same = new ManualPoolMock(WETH, WETH, 3000, LIVE_SQRT_A, LIVE_TICK_A);
        vm.expectRevert(abi.encodeWithSelector(V3ManualPool.InvalidPool.selector, address(same)));
        harness.read(address(same));
    }

    function test_ValidateOrdersTheLowerPriceAsBuyAndAutoSwaps() public view {
        V3ManualPool.Reading memory a = harness.read(address(poolA));
        V3ManualPool.Reading memory b = harness.read(address(poolB));
        (V3ManualPool.Reading memory buy, V3ManualPool.Reading memory sell) = harness.validate(a, b);
        assertEq(buy.pool, address(poolA), "lower tick buys");
        assertEq(sell.pool, address(poolB));
        (buy, sell) = harness.validate(b, a);
        assertEq(buy.pool, address(poolA), "pasted order does not matter");
        assertEq(sell.pool, address(poolB));
        // The brief's expected fee cost (0.01% + 0.30% = 31 bps) against what the chain answers (130 bps).
        assertEq(V3ManualPool.feeCostBps(100, 3000), 31);
        assertEq(V3ManualPool.feeCostBps(buy.fee, sell.fee), 130);
    }

    function test_RevertWhen_PoolsAreDifferentPairs() public {
        V3ManualPool.Reading memory a = harness.read(address(poolA));
        V3ManualPool.Reading memory other = harness.read(address(otherPair));
        vm.expectRevert(V3ManualPool.DifferentPairs.selector);
        harness.validate(a, other);
        // Same tokens in the other order is a different pair too.
        V3ManualPool.Reading memory swapped = V3ManualPool.Reading({
            pool: address(poolB),
            token0: a.token1,
            token1: a.token0,
            fee: 3000,
            sqrtPriceX96: LIVE_SQRT_B,
            tick: LIVE_TICK_B
        });
        vm.expectRevert(V3ManualPool.DifferentPairs.selector);
        harness.validate(a, swapped);
    }

    function test_RevertWhen_PoolHasNoLiquidity() public {
        poolB.setPrice(0, 0);
        V3ManualPool.Reading memory a = harness.read(address(poolA));
        V3ManualPool.Reading memory b = harness.read(address(poolB));
        vm.expectRevert(abi.encodeWithSelector(V3ManualPool.NoLiquidity.selector, address(poolB)));
        harness.validate(a, b);
        vm.expectRevert(abi.encodeWithSelector(V3ManualPool.NoLiquidity.selector, address(poolB)));
        harness.validate(b, a);
        // The pair check comes first, as the brief lists it.
        V3ManualPool.Reading memory other = harness.read(address(otherPair));
        vm.expectRevert(V3ManualPool.DifferentPairs.selector);
        harness.validate(b, other);
    }

    function test_RevertWhen_SamePoolTwice() public {
        V3ManualPool.Reading memory a = harness.read(address(poolA));
        vm.expectRevert(V3ManualPool.SamePool.selector);
        harness.validate(a, a);
    }

    function test_Slot0DecodingRejectsShortOrOutOfRangeReplies() public {
        vm.expectRevert(V3ManualPool.MalformedSlot0.selector);
        harness.decodeSlot0(hex"");
        vm.expectRevert(V3ManualPool.MalformedSlot0.selector);
        harness.decodeSlot0(abi.encode(uint256(1)));
        vm.expectRevert(V3ManualPool.MalformedSlot0.selector);
        harness.decodeSlot0(abi.encode(uint256(type(uint160).max) + 1, int256(0)));
        vm.expectRevert(V3ManualPool.MalformedSlot0.selector);
        harness.decodeSlot0(abi.encode(uint256(1), int256(887273)));
        vm.expectRevert(V3ManualPool.MalformedSlot0.selector);
        harness.decodeSlot0(abi.encode(uint256(1), int256(-887273)));
    }

    function testFuzz_Slot0RoundTripsThroughBothLayouts(uint160 sqrtPriceX96, int24 tick, bool six) public view {
        tick = int24(bound(int256(tick), int256(V3ManualPool.MIN_TICK), int256(V3ManualPool.MAX_TICK)));
        bytes memory reply = six
            ? abi.encode(sqrtPriceX96, tick, uint24(0), uint24(500), uint8(10), true)
            : abi.encode(sqrtPriceX96, tick, uint16(3), uint16(4), uint16(5), uint8(0), true);
        (uint160 price, int24 decodedTick) = harness.decodeSlot0(reply);
        assertEq(price, sqrtPriceX96);
        assertEq(decodedTick, tick);
    }

    function testFuzz_ValidateAlwaysPutsTheLowerTickFirst(int24 tickA, int24 tickB, uint160 sqrtA, uint160 sqrtB)
        public
    {
        vm.assume(sqrtA != 0 && sqrtB != 0);
        tickA = int24(bound(int256(tickA), int256(V3ManualPool.MIN_TICK), int256(V3ManualPool.MAX_TICK)));
        tickB = int24(bound(int256(tickB), int256(V3ManualPool.MIN_TICK), int256(V3ManualPool.MAX_TICK)));
        poolA.setPrice(sqrtA, tickA);
        poolB.setPrice(sqrtB, tickB);
        (V3ManualPool.Reading memory buy, V3ManualPool.Reading memory sell) =
            harness.validate(harness.read(address(poolA)), harness.read(address(poolB)));
        assertLe(buy.tick, sell.tick);
        assertTrue(buy.pool != sell.pool);
    }

    function test_AddressTextMustBe42HexCharacters() public pure {
        assertTrue(V3ManualPool.isPoolAddressText("0x10cc6bd38112cac182db90b6a71d8bb5939526ba"));
        assertTrue(V3ManualPool.isPoolAddressText("0xEd50bDeeA8aDC232f159486192a4157281D722ff"));
        // A 66-character V4 poolId.
        assertFalse(
            V3ManualPool.isPoolAddressText("0xabababababababababababababababababababababababababababababababab")
        );
        assertFalse(V3ManualPool.isPoolAddressText("0x10cc6bd38112cac182db90b6a71d8bb5939526b"));
        assertFalse(V3ManualPool.isPoolAddressText("10cc6bd38112cac182db90b6a71d8bb5939526ba00"));
        assertFalse(V3ManualPool.isPoolAddressText("0x10cc6bd38112cac182db90b6a71d8bb5939526bg"));
        assertFalse(V3ManualPool.isPoolAddressText(""));
    }
}
