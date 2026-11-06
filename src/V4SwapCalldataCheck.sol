// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {V4SwapCalldata} from "./V4SwapCalldata.sol";

/// @title V4SwapCalldataCheck
/// @notice Offline shape check for execute() calldata that carries V4_SWAP commands.
/// @dev A model of how the router on chain 4663 reads its input, built from the bytes of one
///      successful and one failed transaction and from eth_call probes of the live router. It is
///      not the router: it executes nothing and knows nothing about pools, balances, allowances
///      or prices. What it reproduces are the length rules the failed transaction broke:
///
///        SWAP_EXACT_IN_SINGLE (0x06)  params >= 0x160 bytes, first word is the struct's offset
///        SETTLE_ALL           (0x0c)  params >= 0x40 bytes
///        TAKE                 (0x0e)  params >= 0x60 bytes
///
///      A params slice shorter than its rule reverts with SliceOutOfBounds(), the same selector
///      (0x3b99b53d) the router returned for the failed transaction. Where the live router fails
///      later with empty revert data (a struct that points outside its slice, a dirty field),
///      this model reverts with MalformedStruct().
library V4SwapCalldataCheck {
    /// @notice A params slice is shorter than the action needs. Selector 0x3b99b53d, as on the router.
    error SliceOutOfBounds();
    /// @notice The struct, its hookData or one of its fields does not fit its type or its slice.
    error MalformedStruct();
    /// @notice The calldata does not start with execute's selector.
    error NotExecute();
    /// @notice commands and inputs, or actions and params, differ in length.
    error LengthMismatch();
    /// @notice A command other than V4_SWAP (0x10).
    error UnsupportedCommand(uint8 command);
    /// @notice An action other than 0x06, 0x0c or 0x0e.
    error UnsupportedAction(uint8 action);

    struct SettleAll {
        address currency;
        uint256 maxAmount;
    }

    struct Take {
        address currency;
        address recipient;
        uint256 amount;
    }

    /// @dev The decoded actions of one V4_SWAP command, each kind in the order it appears.
    struct DecodedInput {
        bytes actions;
        V4SwapCalldata.ExactInputSingleParams[] swaps;
        SettleAll[] settles;
        Take[] takes;
    }

    uint256 private constant SWAP_PARAMS_MIN_LENGTH = 0x160;
    uint256 private constant SWAP_STRUCT_HEAD_LENGTH = 0x140;
    uint256 private constant SETTLE_ALL_LENGTH = 0x40;
    uint256 private constant TAKE_LENGTH = 0x60;

    /// @notice Split execute() calldata into commands, inputs and deadline.
    function decodeExecute(bytes memory data)
        internal
        pure
        returns (bytes memory commands, bytes[] memory inputs, uint256 deadline)
    {
        // casting is safe because the first four bytes are the selector being compared; the length is checked first
        // forge-lint: disable-next-line(unsafe-typecast)
        if (data.length < 4 || bytes4(data) != V4SwapCalldata.EXECUTE_SELECTOR) revert NotExecute();
        bytes memory args = new bytes(data.length - 4);
        for (uint256 i = 0; i < args.length; ++i) {
            args[i] = data[i + 4];
        }
        (commands, inputs, deadline) = abi.decode(args, (bytes, bytes[], uint256));
        if (commands.length != inputs.length) revert LengthMismatch();
    }

    /// @notice Split one V4_SWAP input into its actions and one params slice per action.
    function decodeActions(bytes memory input) internal pure returns (bytes memory actions, bytes[] memory params) {
        (actions, params) = abi.decode(input, (bytes, bytes[]));
        if (actions.length != params.length) revert LengthMismatch();
    }

    /// @notice Decode SWAP_EXACT_IN_SINGLE params the way the router does: follow the offset in
    ///         the first word to the struct.
    function decodeSwapParams(bytes memory params)
        internal
        pure
        returns (V4SwapCalldata.ExactInputSingleParams memory swap)
    {
        if (params.length < SWAP_PARAMS_MIN_LENGTH) revert SliceOutOfBounds();
        uint256 start = _word(params, 0);
        if (start > params.length || params.length - start < SWAP_STRUCT_HEAD_LENGTH) revert MalformedStruct();

        swap.poolKey.currency0 = _address(_word(params, start));
        swap.poolKey.currency1 = _address(_word(params, start + 0x20));
        uint256 fee = _word(params, start + 0x40);
        if (fee > type(uint24).max) revert MalformedStruct();
        // casting is safe because fee was just checked to fit uint24
        // forge-lint: disable-next-line(unsafe-typecast)
        swap.poolKey.fee = uint24(fee);
        // casting is safe because the word is reinterpreted as two's complement on purpose, then range checked
        // forge-lint: disable-next-line(unsafe-typecast)
        int256 tickSpacing = int256(_word(params, start + 0x60));
        if (tickSpacing > type(int24).max || tickSpacing < type(int24).min) revert MalformedStruct();
        // casting is safe because tickSpacing was just checked to fit int24
        // forge-lint: disable-next-line(unsafe-typecast)
        swap.poolKey.tickSpacing = int24(tickSpacing);
        swap.poolKey.hooks = _address(_word(params, start + 0x80));
        uint256 zeroForOne = _word(params, start + 0xa0);
        if (zeroForOne > 1) revert MalformedStruct();
        swap.zeroForOne = zeroForOne == 1;
        swap.amountIn = _uint128(_word(params, start + 0xc0));
        swap.amountOutMinimum = _uint128(_word(params, start + 0xe0));
        swap.minHopPriceX36 = _word(params, start + 0x100);

        uint256 hookOffset = _word(params, start + 0x120);
        if (hookOffset > params.length) revert MalformedStruct();
        uint256 hookStart = start + hookOffset;
        uint256 hookLength = _word(params, hookStart);
        if (hookLength > params.length - hookStart - 0x20) revert MalformedStruct();
        bytes memory hookData = new bytes(hookLength);
        for (uint256 i = 0; i < hookLength; ++i) {
            hookData[i] = params[hookStart + 0x20 + i];
        }
        swap.hookData = hookData;
    }

    /// @notice Decode SETTLE_ALL(currency, maxAmount).
    function decodeSettleAll(bytes memory params) internal pure returns (SettleAll memory settle) {
        if (params.length < SETTLE_ALL_LENGTH) revert SliceOutOfBounds();
        settle.currency = _address(_word(params, 0));
        settle.maxAmount = _word(params, 0x20);
    }

    /// @notice Decode TAKE(currency, recipient, amount).
    function decodeTake(bytes memory params) internal pure returns (Take memory take) {
        if (params.length < TAKE_LENGTH) revert SliceOutOfBounds();
        take.currency = _address(_word(params, 0));
        take.recipient = _address(_word(params, 0x20));
        take.amount = _word(params, 0x40);
    }

    /// @notice Decode every action of one V4_SWAP input.
    function decodeV4Swap(bytes memory input) internal pure returns (DecodedInput memory decoded) {
        (bytes memory actions, bytes[] memory params) = decodeActions(input);
        uint256 swapCount = 0;
        uint256 settleCount = 0;
        uint256 takeCount = 0;
        for (uint256 i = 0; i < actions.length; ++i) {
            bytes1 action = actions[i];
            if (action == V4SwapCalldata.ACTION_SWAP_EXACT_IN_SINGLE) ++swapCount;
            else if (action == V4SwapCalldata.ACTION_SETTLE_ALL) ++settleCount;
            else if (action == V4SwapCalldata.ACTION_TAKE) ++takeCount;
            else revert UnsupportedAction(uint8(action));
        }

        decoded.actions = actions;
        decoded.swaps = new V4SwapCalldata.ExactInputSingleParams[](swapCount);
        decoded.settles = new SettleAll[](settleCount);
        decoded.takes = new Take[](takeCount);
        swapCount = 0;
        settleCount = 0;
        takeCount = 0;
        for (uint256 i = 0; i < actions.length; ++i) {
            bytes1 action = actions[i];
            if (action == V4SwapCalldata.ACTION_SWAP_EXACT_IN_SINGLE) {
                decoded.swaps[swapCount++] = decodeSwapParams(params[i]);
            } else if (action == V4SwapCalldata.ACTION_SETTLE_ALL) {
                decoded.settles[settleCount++] = decodeSettleAll(params[i]);
            } else {
                decoded.takes[takeCount++] = decodeTake(params[i]);
            }
        }
    }

    /// @notice Check whole execute() calldata and return what each V4_SWAP command decodes to.
    function check(bytes memory data) internal pure returns (DecodedInput[] memory decoded, uint256 deadline) {
        bytes memory commands;
        bytes[] memory inputs;
        (commands, inputs, deadline) = decodeExecute(data);
        decoded = new DecodedInput[](commands.length);
        for (uint256 i = 0; i < commands.length; ++i) {
            if (commands[i] != V4SwapCalldata.COMMAND_V4_SWAP) revert UnsupportedCommand(uint8(commands[i]));
            decoded[i] = decodeV4Swap(inputs[i]);
        }
    }

    function _word(bytes memory data, uint256 offset) private pure returns (uint256 value) {
        if (offset > data.length || data.length - offset < 0x20) revert MalformedStruct();
        assembly ("memory-safe") {
            value := mload(add(add(data, 0x20), offset))
        }
    }

    function _address(uint256 word) private pure returns (address) {
        if (word > type(uint160).max) revert MalformedStruct();
        // casting is safe because word was just checked to fit uint160
        // forge-lint: disable-next-line(unsafe-typecast)
        return address(uint160(word));
    }

    function _uint128(uint256 word) private pure returns (uint128) {
        if (word > type(uint128).max) revert MalformedStruct();
        // casting is safe because word was just checked to fit uint128
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint128(word);
    }
}
