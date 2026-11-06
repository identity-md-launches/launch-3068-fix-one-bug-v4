// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {V4SwapCalldata} from "../src/V4SwapCalldata.sol";
import {V4SwapCalldataCheck} from "../src/V4SwapCalldataCheck.sol";
import {Vectors} from "./Vectors.sol";

/// @dev External entry points for the two libraries, so reverts can be expected.
contract Harness {
    function encodeV4Swap(V4SwapCalldata.Swap memory swap) external pure returns (bytes memory) {
        return V4SwapCalldata.encodeV4Swap(swap);
    }

    function encodeSwapParams(V4SwapCalldata.ExactInputSingleParams memory params)
        external
        pure
        returns (bytes memory)
    {
        return V4SwapCalldata.encodeSwapParams(params);
    }

    function encodeExecute(bytes memory commands, bytes[] memory inputs, uint256 deadline)
        external
        pure
        returns (bytes memory)
    {
        return V4SwapCalldata.encodeExecute(commands, inputs, deadline);
    }

    function buildCalldata(
        address recipient,
        uint128 amountIn,
        uint128 bridgeAmount,
        uint128 minAmountOut,
        V4SwapCalldata.PoolKey memory buyPool,
        V4SwapCalldata.PoolKey memory sellPool,
        uint256 deadline
    ) external pure returns (bytes memory) {
        return V4SwapCalldata.buildCalldata(
            recipient, amountIn, bridgeAmount, minAmountOut, buyPool, sellPool, deadline
        );
    }

    function buildAtomicCalldata(
        address recipient,
        uint128 amountIn,
        uint128 minAmountOut,
        V4SwapCalldata.PoolKey memory buyPool,
        V4SwapCalldata.PoolKey memory sellPool,
        uint256 deadline
    ) external pure returns (bytes memory) {
        return V4SwapCalldata.buildAtomicCalldata(recipient, amountIn, minAmountOut, buyPool, sellPool, deadline);
    }

    function check(bytes memory data)
        external
        pure
        returns (V4SwapCalldataCheck.DecodedInput[] memory decoded, uint256 deadline)
    {
        return V4SwapCalldataCheck.check(data);
    }

    function decodeV4Swap(bytes memory input) external pure returns (V4SwapCalldataCheck.DecodedInput memory) {
        return V4SwapCalldataCheck.decodeV4Swap(input);
    }

    function decodeSwapParams(bytes memory params)
        external
        pure
        returns (V4SwapCalldata.ExactInputSingleParams memory)
    {
        return V4SwapCalldataCheck.decodeSwapParams(params);
    }
}

contract V4SwapCalldataTest is Test {
    Harness internal harness;

    // The sender of the failed transaction: the account the corrected calldata was simulated from.
    address internal constant CALLER = 0xd064E892A3BBb758053922C80098b7f4130444c6;
    // Fields of the successful transaction.
    address internal constant OK_TOKEN = 0x36C2861a1F94C6F277A388338A4F8A686e0d9B30;
    address internal constant OK_RECIPIENT = 0xd7F5739050c65fCe574400F70Bea1Ca63B6b4Bbc;
    uint128 internal constant OK_AMOUNT_IN = 0xc6e4d2fb9176784bfab;
    uint128 internal constant OK_MIN_OUT = 0x1f6f6d1cb16ad98;

    uint128 internal constant USDG_IN = 10_000; // 0.01 USDG, six decimals
    uint128 internal constant PONS_BRIDGE = 51_690_143_190_364_074;

    function setUp() public {
        harness = new Harness();
    }

    // ---------------------------------------------------------------- helpers

    function _okSwap() internal pure returns (V4SwapCalldata.Swap memory) {
        return V4SwapCalldata.Swap({
            poolKey: V4SwapCalldata.PoolKey({
                currency0: address(0), currency1: OK_TOKEN, fee: 0, tickSpacing: 60, hooks: address(0)
            }),
            zeroForOne: false,
            amountIn: OK_AMOUNT_IN,
            amountOutMinimum: OK_MIN_OUT,
            minHopPriceX36: 0,
            hookData: "",
            settleMax: OK_AMOUNT_IN,
            recipient: OK_RECIPIENT
        });
    }

    function _swap(V4SwapCalldata.PoolKey memory key, bool zeroForOne, uint128 amountIn, uint128 minOut)
        internal
        pure
        returns (V4SwapCalldata.Swap memory)
    {
        return V4SwapCalldata.Swap({
            poolKey: key,
            zeroForOne: zeroForOne,
            amountIn: amountIn,
            amountOutMinimum: minOut,
            minHopPriceX36: 0,
            hookData: "",
            settleMax: amountIn,
            recipient: CALLER
        });
    }

    function _one(bytes memory input) internal pure returns (bytes[] memory inputs) {
        inputs = new bytes[](1);
        inputs[0] = input;
    }

    /// @dev The failing encoder's swap params, with each of its defects switchable.
    function _swapParamsVariant(bool structOffset, bool minHopWord) internal pure returns (bytes memory) {
        V4SwapCalldata.PoolKey memory key = V4SwapCalldata.poolA();
        if (structOffset && minHopWord) {
            return abi.encode(
                V4SwapCalldata.ExactInputSingleParams({
                    poolKey: key,
                    zeroForOne: false,
                    amountIn: USDG_IN,
                    amountOutMinimum: 0,
                    minHopPriceX36: 0,
                    hookData: ""
                })
            );
        }
        if (structOffset) return abi.encode(LegacyParams(key, false, USDG_IN, 0, ""));
        if (minHopWord) return abi.encode(key, false, USDG_IN, uint128(0), uint256(0), bytes(""));
        return abi.encode(key, false, USDG_IN, uint128(0), bytes(""));
    }

    struct LegacyParams {
        V4SwapCalldata.PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData;
    }

    function _variant(bool structOffset, bool minHopWord, bool threeWordTake) internal pure returns (bytes memory) {
        bytes[] memory params = new bytes[](3);
        params[0] = _swapParamsVariant(structOffset, minHopWord);
        params[1] = abi.encode(V4SwapCalldata.USDG, uint256(USDG_IN));
        params[2] = threeWordTake
            ? abi.encode(V4SwapCalldata.PONS, CALLER, uint256(0))
            : abi.encode(V4SwapCalldata.PONS, uint256(0));
        return V4SwapCalldata.encodeExecute(hex"10", _one(abi.encode(hex"060c0e", params)), type(uint256).max);
    }

    function _firstWord(bytes memory data) internal pure returns (uint256 word) {
        assembly ("memory-safe") {
            word := mload(add(data, 0x20))
        }
    }

    function _args(bytes memory data) internal pure returns (bytes memory args) {
        args = new bytes(data.length - 4);
        for (uint256 i = 0; i < args.length; ++i) {
            args[i] = data[i + 4];
        }
    }

    // ------------------------------------------- the successful transaction

    function test_EncoderReproducesSuccessfulTransactionByteForByte() public pure {
        bytes memory built =
            V4SwapCalldata.encodeExecute(hex"10", _one(V4SwapCalldata.encodeV4Swap(_okSwap())), type(uint256).max);
        assertEq(built, Vectors.SUCCESS_TX_INPUT);
    }

    function test_SuccessfulTransactionPassesCheck() public view {
        (V4SwapCalldataCheck.DecodedInput[] memory decoded, uint256 deadline) = harness.check(Vectors.SUCCESS_TX_INPUT);
        assertEq(deadline, type(uint256).max);
        assertEq(decoded.length, 1);
        assertEq(decoded[0].actions, hex"060c0e");
        assertEq(decoded[0].swaps.length, 1);
        assertEq(decoded[0].swaps[0].poolKey.currency0, address(0));
        assertEq(decoded[0].swaps[0].poolKey.currency1, OK_TOKEN);
        assertEq(decoded[0].swaps[0].poolKey.tickSpacing, 60);
        assertFalse(decoded[0].swaps[0].zeroForOne);
        assertEq(decoded[0].swaps[0].amountIn, OK_AMOUNT_IN);
        assertEq(decoded[0].swaps[0].amountOutMinimum, OK_MIN_OUT);
        assertEq(decoded[0].swaps[0].minHopPriceX36, 0);
        assertEq(decoded[0].swaps[0].hookData.length, 0);
        assertEq(decoded[0].settles[0].currency, OK_TOKEN);
        assertEq(decoded[0].settles[0].maxAmount, OK_AMOUNT_IN);
        assertEq(decoded[0].takes[0].currency, address(0));
        assertEq(decoded[0].takes[0].recipient, OK_RECIPIENT);
        // The successful transaction takes with amount 0: OPEN_DELTA is zero on this router.
        assertEq(decoded[0].takes[0].amount, V4SwapCalldata.OPEN_DELTA);
    }

    // ----------------------------------------------- the failed transaction

    function test_SliceOutOfBoundsSelectorIsTheRoutersRevertData() public pure {
        // eth_call of the failed transaction's input returns revert data 0x3b99b53d.
        assertEq(V4SwapCalldataCheck.SliceOutOfBounds.selector, bytes4(0x3b99b53d));
    }

    function test_FailedTransactionRevertsWithSliceOutOfBounds() public {
        vm.expectRevert(V4SwapCalldataCheck.SliceOutOfBounds.selector);
        harness.check(Vectors.FAILED_TX_INPUT);
    }

    /// @dev The structural difference, measured on the two transactions' own bytes.
    function test_StructuralDifferenceBetweenTheTwoTransactions() public pure {
        (, bytes[] memory okInputs,) = abi.decode(_args(Vectors.SUCCESS_TX_INPUT), (bytes, bytes[], uint256));
        (bytes memory badCommands, bytes[] memory badInputs,) =
            abi.decode(_args(Vectors.FAILED_TX_INPUT), (bytes, bytes[], uint256));
        (bytes memory okActions, bytes[] memory okParams) = abi.decode(okInputs[0], (bytes, bytes[]));
        assertEq(badCommands, hex"1010");

        for (uint256 i = 0; i < 2; ++i) {
            (bytes memory badActions, bytes[] memory badParams) = abi.decode(badInputs[i], (bytes, bytes[]));
            // Same actions on both sides.
            assertEq(badActions, okActions);
            assertEq(badActions, hex"060c0e");

            // 1 and 2: swap params are 0x180 bytes starting with the struct offset 0x20 in the
            // successful transaction, 0x140 bytes starting with currency0 in the failed one.
            assertEq(okParams[0].length, 0x180);
            assertEq(_firstWord(okParams[0]), 0x20);
            assertEq(badParams[0].length, 0x140);
            assertEq(_firstWord(badParams[0]), uint256(uint160(V4SwapCalldata.PONS)));

            // SETTLE_ALL has the same two-word shape in both.
            assertEq(okParams[1].length, 0x40);
            assertEq(badParams[1].length, 0x40);

            // 3: TAKE is three words in the successful transaction, two in the failed one.
            assertEq(okParams[2].length, 0x60);
            assertEq(badParams[2].length, 0x40);
        }
    }

    /// @dev The failed transaction also differs from the brief in its values, which no encoding
    ///      fix changes: both swaps use fee 2500 / tick spacing 25, and swap 1 sells 1e16 units.
    function test_FailedTransactionValuesDifferFromTheBrief() public pure {
        (, bytes[] memory badInputs, uint256 deadline) =
            abi.decode(_args(Vectors.FAILED_TX_INPUT), (bytes, bytes[], uint256));
        assertEq(deadline, type(uint128).max);
        for (uint256 i = 0; i < 2; ++i) {
            (, bytes[] memory params) = abi.decode(badInputs[i], (bytes, bytes[]));
            (V4SwapCalldata.PoolKey memory key, bool zeroForOne, uint128 amountIn,,) =
                abi.decode(params[0], (V4SwapCalldata.PoolKey, bool, uint128, uint128, bytes));
            assertEq(key.currency0, V4SwapCalldata.PONS);
            assertEq(key.currency1, V4SwapCalldata.USDG);
            assertEq(key.fee, 2500);
            assertEq(key.tickSpacing, 25);
            assertEq(zeroForOne, i == 1);
            assertEq(amountIn, i == 0 ? 1e16 : type(uint128).max);
        }
    }

    /// @dev Each defect reverts by itself: only the variant with all three corrected decodes.
    ///      The live router gave the same pass/fail result for all eight combinations.
    function test_EveryPartialFixStillReverts() public {
        for (uint256 mask = 0; mask < 7; ++mask) {
            bytes memory data = _variant(mask & 1 != 0, mask & 2 != 0, mask & 4 != 0);
            vm.expectRevert();
            harness.check(data);
        }
        (V4SwapCalldataCheck.DecodedInput[] memory decoded,) = harness.check(_variant(true, true, true));
        assertEq(decoded[0].swaps[0].amountIn, USDG_IN);
        assertEq(decoded[0].takes[0].recipient, CALLER);
    }

    function test_MissingMinHopWordAloneIsSliceOutOfBounds() public {
        // Without the struct offset and without the ninth word the params are 0x140 bytes.
        vm.expectRevert(V4SwapCalldataCheck.SliceOutOfBounds.selector);
        harness.check(_variant(false, false, true));
    }

    function test_TwoWordTakeAloneIsSliceOutOfBounds() public {
        vm.expectRevert(V4SwapCalldataCheck.SliceOutOfBounds.selector);
        harness.check(_variant(true, true, false));
    }

    function test_FlatStructIsMalformed() public {
        // Long enough, but the first word is currency0 instead of the struct's offset.
        vm.expectRevert(V4SwapCalldataCheck.MalformedStruct.selector);
        harness.check(_variant(false, true, true));
    }

    // ------------------------------------------------ the corrected calldata

    function test_BuildCalldataMatchesJavaScriptOutput() public pure {
        bytes memory built = V4SwapCalldata.buildCalldata(
            CALLER, USDG_IN, PONS_BRIDGE, USDG_IN, V4SwapCalldata.poolA(), V4SwapCalldata.poolB(), type(uint256).max
        );
        assertEq(built, Vectors.JS_TWO_COMMAND);
        assertEq(bytes4(built), bytes4(0x3593564c));
    }

    function test_BuildCalldataDecodesToTheBriefsTwoSwaps() public view {
        (V4SwapCalldataCheck.DecodedInput[] memory decoded, uint256 deadline) = harness.check(Vectors.JS_TWO_COMMAND);
        assertEq(deadline, type(uint256).max);
        assertEq(decoded.length, 2);

        // Swap 1: pool A, sell USDG for PONS.
        assertEq(decoded[0].actions, hex"060c0e");
        assertEq(decoded[0].swaps[0].poolKey.fee, 3000);
        assertEq(decoded[0].swaps[0].poolKey.tickSpacing, 60);
        assertEq(decoded[0].swaps[0].poolKey.hooks, address(0));
        assertFalse(decoded[0].swaps[0].zeroForOne);
        assertEq(decoded[0].swaps[0].amountIn, USDG_IN);
        assertEq(decoded[0].swaps[0].amountOutMinimum, PONS_BRIDGE);
        assertEq(decoded[0].settles[0].currency, V4SwapCalldata.USDG);
        assertEq(decoded[0].settles[0].maxAmount, USDG_IN);
        assertEq(decoded[0].takes[0].currency, V4SwapCalldata.PONS);
        assertEq(decoded[0].takes[0].recipient, CALLER);
        assertEq(decoded[0].takes[0].amount, 0);

        // Swap 2: pool B, sell exactly what swap 1 guaranteed.
        assertEq(decoded[1].actions, hex"060c0e");
        assertEq(decoded[1].swaps[0].poolKey.fee, 30000);
        assertEq(decoded[1].swaps[0].poolKey.tickSpacing, 600);
        assertTrue(decoded[1].swaps[0].zeroForOne);
        assertEq(decoded[1].swaps[0].amountIn, PONS_BRIDGE);
        assertEq(decoded[1].swaps[0].amountOutMinimum, USDG_IN);
        assertEq(decoded[1].settles[0].currency, V4SwapCalldata.PONS);
        assertEq(decoded[1].settles[0].maxAmount, PONS_BRIDGE);
        assertEq(decoded[1].takes[0].currency, V4SwapCalldata.USDG);
        assertEq(decoded[1].takes[0].recipient, CALLER);
    }

    function test_BuildAtomicCalldataMatchesJavaScriptOutput() public pure {
        bytes memory built = V4SwapCalldata.buildAtomicCalldata(
            CALLER, USDG_IN, USDG_IN, V4SwapCalldata.poolA(), V4SwapCalldata.poolB(), type(uint256).max
        );
        assertEq(built, Vectors.JS_ATOMIC);
    }

    function test_BuildAtomicCalldataUsesOpenDeltaForSwapTwo() public view {
        (V4SwapCalldataCheck.DecodedInput[] memory decoded,) = harness.check(Vectors.JS_ATOMIC);
        assertEq(decoded.length, 1);
        assertEq(decoded[0].actions, hex"06060e");
        assertEq(decoded[0].swaps.length, 2);
        assertEq(decoded[0].settles.length, 0);
        assertEq(decoded[0].swaps[0].amountIn, USDG_IN);
        assertFalse(decoded[0].swaps[0].zeroForOne);
        assertEq(decoded[0].swaps[1].amountIn, V4SwapCalldata.OPEN_DELTA);
        assertTrue(decoded[0].swaps[1].zeroForOne);
        assertEq(decoded[0].swaps[1].amountOutMinimum, USDG_IN);
        assertEq(decoded[0].takes[0].currency, V4SwapCalldata.USDG);
        assertEq(decoded[0].takes[0].recipient, CALLER);
        assertEq(decoded[0].takes[0].amount, V4SwapCalldata.OPEN_DELTA);
    }

    function test_SwapParamsLayout() public pure {
        bytes memory params = V4SwapCalldata.encodeSwapParams(
            V4SwapCalldata.ExactInputSingleParams({
                poolKey: V4SwapCalldata.poolA(),
                zeroForOne: false,
                amountIn: USDG_IN,
                amountOutMinimum: 1,
                minHopPriceX36: 7,
                hookData: ""
            })
        );
        bytes memory expected = abi.encodePacked(
            uint256(0x20),
            uint256(uint160(V4SwapCalldata.PONS)),
            uint256(uint160(V4SwapCalldata.USDG)),
            uint256(3000),
            uint256(60),
            uint256(0),
            uint256(0),
            uint256(USDG_IN),
            uint256(1),
            uint256(7),
            uint256(0x140),
            uint256(0)
        );
        assertEq(params, expected);
        assertEq(params.length, 0x180);
    }

    // ------------------------------------------------------ encoder refusals

    function test_RevertWhen_AmountInIsZero() public {
        V4SwapCalldata.Swap memory swap = _swap(V4SwapCalldata.poolB(), true, 0, 0);
        vm.expectRevert(V4SwapCalldata.AmountInIsOpenDelta.selector);
        harness.encodeV4Swap(swap);
    }

    function test_RevertWhen_AmountInIsUint128Max() public {
        V4SwapCalldata.Swap memory swap = _swap(V4SwapCalldata.poolB(), true, type(uint128).max, 0);
        vm.expectRevert(V4SwapCalldata.AmountInIsUint128Max.selector);
        harness.encodeV4Swap(swap);
    }

    function test_RevertWhen_BridgeAmountIsUint128Max() public {
        vm.expectRevert(V4SwapCalldata.AmountInIsUint128Max.selector);
        harness.buildCalldata(
            CALLER, USDG_IN, type(uint128).max, 0, V4SwapCalldata.poolA(), V4SwapCalldata.poolB(), type(uint256).max
        );
    }

    function test_RevertWhen_BridgeAmountIsZero() public {
        vm.expectRevert(V4SwapCalldata.AmountInIsOpenDelta.selector);
        harness.buildCalldata(CALLER, USDG_IN, 0, 0, V4SwapCalldata.poolA(), V4SwapCalldata.poolB(), type(uint256).max);
    }

    function test_RevertWhen_CurrenciesNotSorted() public {
        V4SwapCalldata.PoolKey memory key = V4SwapCalldata.poolA();
        (key.currency0, key.currency1) = (key.currency1, key.currency0);
        V4SwapCalldata.Swap memory swap = _swap(key, false, USDG_IN, 0);
        vm.expectRevert(V4SwapCalldata.CurrenciesNotSorted.selector);
        harness.encodeV4Swap(swap);
    }

    function test_RevertWhen_CurrenciesEqual() public {
        V4SwapCalldata.PoolKey memory key = V4SwapCalldata.poolA();
        key.currency1 = key.currency0;
        V4SwapCalldata.Swap memory swap = _swap(key, false, USDG_IN, 0);
        vm.expectRevert(V4SwapCalldata.CurrenciesNotSorted.selector);
        harness.encodeV4Swap(swap);
    }

    function test_RevertWhen_RecipientIsZero() public {
        V4SwapCalldata.Swap memory swap = _swap(V4SwapCalldata.poolA(), false, USDG_IN, 0);
        swap.recipient = address(0);
        vm.expectRevert(V4SwapCalldata.ZeroRecipient.selector);
        harness.encodeV4Swap(swap);
    }

    function test_RevertWhen_SettleMaxBelowAmountIn() public {
        V4SwapCalldata.Swap memory swap = _swap(V4SwapCalldata.poolA(), false, USDG_IN, 0);
        swap.settleMax = USDG_IN - 1;
        vm.expectRevert(V4SwapCalldata.SettleMaxBelowAmountIn.selector);
        harness.encodeV4Swap(swap);
    }

    function test_RevertWhen_InputCountDiffersFromCommands() public {
        bytes[] memory inputs = _one(V4SwapCalldata.encodeV4Swap(_okSwap()));
        vm.expectRevert(V4SwapCalldata.InputCountMismatch.selector);
        harness.encodeExecute(hex"1010", inputs, type(uint256).max);
    }

    function test_RevertWhen_AtomicMinOutBelowAmountIn() public {
        vm.expectRevert(V4SwapCalldata.MinOutBelowAmountIn.selector);
        harness.buildAtomicCalldata(
            CALLER, USDG_IN, USDG_IN - 1, V4SwapCalldata.poolA(), V4SwapCalldata.poolB(), type(uint256).max
        );
    }

    function test_RevertWhen_AtomicPoolsTradeDifferentPairs() public {
        V4SwapCalldata.PoolKey memory other = V4SwapCalldata.poolB();
        other.currency1 = address(type(uint160).max);
        vm.expectRevert(V4SwapCalldata.PairMismatch.selector);
        harness.buildAtomicCalldata(CALLER, USDG_IN, USDG_IN, V4SwapCalldata.poolA(), other, type(uint256).max);
    }

    function test_RevertWhen_AtomicAmountInIsSentinel() public {
        vm.expectRevert(V4SwapCalldata.AmountInIsOpenDelta.selector);
        harness.buildAtomicCalldata(CALLER, 0, 0, V4SwapCalldata.poolA(), V4SwapCalldata.poolB(), type(uint256).max);
        vm.expectRevert(V4SwapCalldata.AmountInIsUint128Max.selector);
        harness.buildAtomicCalldata(
            CALLER,
            type(uint128).max,
            type(uint128).max,
            V4SwapCalldata.poolA(),
            V4SwapCalldata.poolB(),
            type(uint256).max
        );
    }

    // ------------------------------------------------------- check refusals

    function test_RevertWhen_NotExecuteSelector() public {
        bytes memory data = Vectors.SUCCESS_TX_INPUT;
        data[0] = 0x00;
        vm.expectRevert(V4SwapCalldataCheck.NotExecute.selector);
        harness.check(data);
        vm.expectRevert(V4SwapCalldataCheck.NotExecute.selector);
        harness.check(hex"3593");
    }

    function test_RevertWhen_CommandIsNotV4Swap() public {
        bytes memory data =
            V4SwapCalldata.encodeExecute(hex"0b", _one(V4SwapCalldata.encodeV4Swap(_okSwap())), type(uint256).max);
        vm.expectRevert(abi.encodeWithSelector(V4SwapCalldataCheck.UnsupportedCommand.selector, uint8(0x0b)));
        harness.check(data);
    }

    function test_RevertWhen_ActionIsNotSupported() public {
        bytes[] memory params = new bytes[](1);
        params[0] = abi.encode(V4SwapCalldata.USDG, uint256(0));
        vm.expectRevert(abi.encodeWithSelector(V4SwapCalldataCheck.UnsupportedAction.selector, uint8(0x0f)));
        harness.decodeV4Swap(abi.encode(hex"0f", params));
    }

    function test_RevertWhen_ActionsAndParamsDifferInLength() public {
        bytes[] memory params = new bytes[](1);
        params[0] = abi.encode(V4SwapCalldata.USDG, uint256(0));
        vm.expectRevert(V4SwapCalldataCheck.LengthMismatch.selector);
        harness.decodeV4Swap(abi.encode(hex"0c0e", params));
    }

    function test_RevertWhen_SwapFieldIsDirty() public {
        bytes memory params = _swapParamsVariant(true, true);
        // zeroForOne (word 6) set to 2.
        params[0x20 * 7 - 1] = 0x02;
        vm.expectRevert(V4SwapCalldataCheck.MalformedStruct.selector);
        harness.decodeSwapParams(params);
    }

    function test_RevertWhen_HookDataPointsOutsideTheSlice() public {
        bytes memory params = _swapParamsVariant(true, true);
        // hookData offset (word 10) moved from 0x140 to 0x160: its length word is past the end.
        params[0x20 * 11 - 1] = 0x60;
        vm.expectRevert(V4SwapCalldataCheck.MalformedStruct.selector);
        harness.decodeSwapParams(params);
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_EncodeThenCheckRoundTrips(V4SwapCalldata.Swap memory swap, uint256 deadline) public view {
        V4SwapCalldata.PoolKey memory key = swap.poolKey;
        vm.assume(key.currency0 != key.currency1);
        vm.assume(swap.recipient != address(0));
        if (key.currency0 > key.currency1) (key.currency0, key.currency1) = (key.currency1, key.currency0);
        swap.amountIn = uint128(bound(swap.amountIn, 1, type(uint128).max - 1));
        swap.settleMax = bound(swap.settleMax, swap.amountIn, type(uint256).max);

        bytes memory data = harness.encodeExecute(hex"10", _one(harness.encodeV4Swap(swap)), deadline);
        (V4SwapCalldataCheck.DecodedInput[] memory decoded, uint256 gotDeadline) = harness.check(data);

        assertEq(gotDeadline, deadline);
        assertEq(decoded[0].actions, hex"060c0e");
        _assertSwapEq(decoded[0].swaps[0], swap);
        assertEq(decoded[0].settles[0].currency, swap.zeroForOne ? key.currency0 : key.currency1);
        assertEq(decoded[0].settles[0].maxAmount, swap.settleMax);
        assertEq(decoded[0].takes[0].currency, swap.zeroForOne ? key.currency1 : key.currency0);
        assertEq(decoded[0].takes[0].recipient, swap.recipient);
        assertEq(decoded[0].takes[0].amount, 0);
    }

    function _assertSwapEq(V4SwapCalldata.ExactInputSingleParams memory got, V4SwapCalldata.Swap memory want)
        internal
        pure
    {
        assertEq(got.poolKey.currency0, want.poolKey.currency0);
        assertEq(got.poolKey.currency1, want.poolKey.currency1);
        assertEq(got.poolKey.fee, want.poolKey.fee);
        assertEq(got.poolKey.tickSpacing, want.poolKey.tickSpacing);
        assertEq(got.poolKey.hooks, want.poolKey.hooks);
        assertEq(got.zeroForOne, want.zeroForOne);
        assertEq(got.amountIn, want.amountIn);
        assertEq(got.amountOutMinimum, want.amountOutMinimum);
        assertEq(got.minHopPriceX36, want.minHopPriceX36);
        assertEq(got.hookData, want.hookData);
    }

    function testFuzz_BuildCalldataLinksTheSwapsThroughTheBridgeAmount(
        address recipient,
        uint128 amountIn,
        uint128 bridgeAmount,
        uint128 minOut,
        uint256 deadline
    ) public view {
        vm.assume(recipient != address(0));
        amountIn = uint128(bound(amountIn, 1, type(uint128).max - 1));
        bridgeAmount = uint128(bound(bridgeAmount, 1, type(uint128).max - 1));

        bytes memory data = harness.buildCalldata(
            recipient, amountIn, bridgeAmount, minOut, V4SwapCalldata.poolA(), V4SwapCalldata.poolB(), deadline
        );
        (V4SwapCalldataCheck.DecodedInput[] memory decoded, uint256 gotDeadline) = harness.check(data);
        assertEq(gotDeadline, deadline);
        assertEq(decoded.length, 2);
        assertEq(decoded[0].swaps[0].amountIn, amountIn);
        // Swap 2 sells exactly what swap 1 is required to deliver, never more.
        assertEq(decoded[0].swaps[0].amountOutMinimum, bridgeAmount);
        assertEq(decoded[1].swaps[0].amountIn, bridgeAmount);
        assertEq(decoded[1].settles[0].maxAmount, bridgeAmount);
        assertEq(decoded[1].swaps[0].amountOutMinimum, minOut);
        assertEq(decoded[0].takes[0].recipient, recipient);
        assertEq(decoded[1].takes[0].recipient, recipient);
    }

    function testFuzz_SwapParamsShorterThanTheMinimumAreSliceOutOfBounds(uint256 length) public {
        length = bound(length, 0, 0x15f);
        bytes memory full = _swapParamsVariant(true, true);
        bytes memory cut = new bytes(length);
        for (uint256 i = 0; i < length; ++i) {
            cut[i] = full[i];
        }
        vm.expectRevert(V4SwapCalldataCheck.SliceOutOfBounds.selector);
        harness.decodeSwapParams(cut);
    }

    function testFuzz_TruncatedCalldataNeverPassesCheck(uint256 cutBytes) public {
        bytes memory full = Vectors.JS_TWO_COMMAND;
        cutBytes = bound(cutBytes, 1, full.length);
        bytes memory cut = new bytes(full.length - cutBytes);
        for (uint256 i = 0; i < cut.length; ++i) {
            cut[i] = full[i];
        }
        vm.expectRevert();
        harness.check(cut);
    }
}
