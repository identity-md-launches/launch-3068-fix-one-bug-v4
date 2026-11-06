// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title V4SwapCalldata
/// @notice Reference encoder for Uniswap V4 swaps through the Universal Router on Robinhood Chain
///         (chain id 4663, router 0x8876789976dEcBfCbBbe364623C63652db8C0904).
/// @dev Mirrors js/v4-arb-encoder.js function for function. Every layout was read from the
///      successful transaction 0x1143c44d...befb6b7 and is reproduced byte for byte in the tests.
///      All functions are internal and pure: nothing is deployed, called or held.
library V4SwapCalldata {
    /// @notice currency0 must sort strictly below currency1.
    error CurrenciesNotSorted();
    /// @notice The output recipient is the zero address.
    error ZeroRecipient();
    /// @notice amountIn 0 means OPEN_DELTA, which a command of its own has no credit for.
    error AmountInIsOpenDelta();
    /// @notice amountIn 2^128-1 is not OPEN_DELTA on this router; it would sell that many tokens.
    error AmountInIsUint128Max();
    /// @notice SETTLE_ALL's cap is below the amount the swap owes.
    error SettleMaxBelowAmountIn();
    /// @notice The two pools of a round trip do not trade the same pair.
    error PairMismatch();
    /// @notice A single-unlock round trip has no SETTLE, so it must return at least its input.
    error MinOutBelowAmountIn();
    /// @notice commands and inputs differ in length.
    error InputCountMismatch();

    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    /// @dev The struct this router decodes for SWAP_EXACT_IN_SINGLE. `minHopPriceX36` is the
    ///      ninth head word the failing encoder left out.
    struct ExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        uint256 minHopPriceX36;
        bytes hookData;
    }

    /// @dev One V4_SWAP command with actions 0x060c0e.
    struct Swap {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        uint256 minHopPriceX36;
        bytes hookData;
        uint256 settleMax;
        address recipient;
    }

    address internal constant ROUTER = 0x8876789976dEcBfCbBbe364623C63652db8C0904;
    uint256 internal constant CHAIN_ID = 4663;
    address internal constant PONS = 0x39dBED3a2bd333467115dE45665cC57F813C4571;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;

    bytes4 internal constant EXECUTE_SELECTOR = 0x3593564c;
    bytes1 internal constant COMMAND_V4_SWAP = 0x10;
    bytes1 internal constant ACTION_SWAP_EXACT_IN_SINGLE = 0x06;
    bytes1 internal constant ACTION_SETTLE_ALL = 0x0c;
    bytes1 internal constant ACTION_TAKE = 0x0e;
    bytes internal constant ACTIONS_SWAP_SETTLE_TAKE = hex"060c0e";
    bytes internal constant ACTIONS_SWAP_SWAP_TAKE = hex"06060e";

    /// @dev ActionConstants.OPEN_DELTA of the router: zero, not 2^128-1.
    uint256 internal constant OPEN_DELTA = 0;
    /// @dev Recipient sentinel the router maps to the caller of execute().
    address internal constant MSG_SENDER = address(1);

    /// @notice Pool A of the brief: PONS/USDG, fee 3000, tick spacing 60, no hook.
    function poolA() internal pure returns (PoolKey memory) {
        return PoolKey({currency0: PONS, currency1: USDG, fee: 3000, tickSpacing: 60, hooks: address(0)});
    }

    /// @notice Pool B of the brief: PONS/USDG, fee 30000, tick spacing 600, no hook.
    function poolB() internal pure returns (PoolKey memory) {
        return PoolKey({currency0: PONS, currency1: USDG, fee: 30000, tickSpacing: 600, hooks: address(0)});
    }

    /// @notice abi.encode of the struct: a leading 0x20 offset, nine head words, the hookData
    ///         offset (0x140) and the hookData itself.
    function encodeSwapParams(ExactInputSingleParams memory params) internal pure returns (bytes memory) {
        if (params.poolKey.currency0 >= params.poolKey.currency1) revert CurrenciesNotSorted();
        return abi.encode(params);
    }

    /// @notice SETTLE_ALL(currency, maxAmount): two words.
    function encodeSettleAll(address currency, uint256 maxAmount) internal pure returns (bytes memory) {
        return abi.encode(currency, maxAmount);
    }

    /// @notice TAKE(currency, recipient, amount): three words. Amount 0 takes the whole credit.
    function encodeTake(address currency, address recipient, uint256 amount) internal pure returns (bytes memory) {
        if (recipient == address(0)) revert ZeroRecipient();
        return abi.encode(currency, recipient, amount);
    }

    /// @notice One V4_SWAP input, actions 0x060c0e: swap exact in, settle the input from the
    ///         caller through Permit2, take the whole output to `swap.recipient`.
    function encodeV4Swap(Swap memory swap) internal pure returns (bytes memory) {
        if (swap.amountIn == OPEN_DELTA) revert AmountInIsOpenDelta();
        if (swap.amountIn == type(uint128).max) revert AmountInIsUint128Max();
        if (swap.settleMax < swap.amountIn) revert SettleMaxBelowAmountIn();

        address currencyIn = swap.zeroForOne ? swap.poolKey.currency0 : swap.poolKey.currency1;
        address currencyOut = swap.zeroForOne ? swap.poolKey.currency1 : swap.poolKey.currency0;

        bytes[] memory params = new bytes[](3);
        params[0] = encodeSwapParams(
            ExactInputSingleParams({
                poolKey: swap.poolKey,
                zeroForOne: swap.zeroForOne,
                amountIn: swap.amountIn,
                amountOutMinimum: swap.amountOutMinimum,
                minHopPriceX36: swap.minHopPriceX36,
                hookData: swap.hookData
            })
        );
        params[1] = encodeSettleAll(currencyIn, swap.settleMax);
        params[2] = encodeTake(currencyOut, swap.recipient, OPEN_DELTA);
        return abi.encode(ACTIONS_SWAP_SETTLE_TAKE, params);
    }

    /// @notice execute(commands, inputs, deadline) calldata, one input per command byte.
    function encodeExecute(bytes memory commands, bytes[] memory inputs, uint256 deadline)
        internal
        pure
        returns (bytes memory)
    {
        if (commands.length != inputs.length) revert InputCountMismatch();
        return abi.encodeWithSelector(EXECUTE_SELECTOR, commands, inputs, deadline);
    }

    /// @notice The round trip as two commands (0x1010), each 0x060c0e.
    /// @dev Swap 1 sells `amountIn` of currency1 on `buyPool` and must deliver at least
    ///      `bridgeAmount` of currency0. Swap 2 sells exactly `bridgeAmount` of currency0 on
    ///      `sellPool` for at least `minAmountOut` of currency1. The two commands are separate
    ///      unlocks, so the fixed `bridgeAmount` is the only link between them.
    function buildCalldata(
        address recipient,
        uint128 amountIn,
        uint128 bridgeAmount,
        uint128 minAmountOut,
        PoolKey memory buyPool,
        PoolKey memory sellPool,
        uint256 deadline
    ) internal pure returns (bytes memory) {
        bytes[] memory inputs = new bytes[](2);
        inputs[0] = encodeV4Swap(
            Swap({
                poolKey: buyPool,
                zeroForOne: false,
                amountIn: amountIn,
                amountOutMinimum: bridgeAmount,
                minHopPriceX36: 0,
                hookData: "",
                settleMax: amountIn,
                recipient: recipient
            })
        );
        inputs[1] = encodeV4Swap(
            Swap({
                poolKey: sellPool,
                zeroForOne: true,
                amountIn: bridgeAmount,
                amountOutMinimum: minAmountOut,
                minHopPriceX36: 0,
                hookData: "",
                settleMax: bridgeAmount,
                recipient: recipient
            })
        );
        return encodeExecute(hex"1010", inputs, deadline);
    }

    /// @notice The round trip in one command, actions 0x06060e. Swap 2's amountIn is OPEN_DELTA
    ///         (0), which inside one unlock means "everything swap 1 bought".
    /// @dev Nothing is pulled from the caller: the transaction settles only when swap 2 returns
    ///      at least `amountIn`, which is why `minAmountOut` may not be below it.
    function buildAtomicCalldata(
        address recipient,
        uint128 amountIn,
        uint128 minAmountOut,
        PoolKey memory buyPool,
        PoolKey memory sellPool,
        uint256 deadline
    ) internal pure returns (bytes memory) {
        if (buyPool.currency0 != sellPool.currency0 || buyPool.currency1 != sellPool.currency1) {
            revert PairMismatch();
        }
        if (amountIn == OPEN_DELTA) revert AmountInIsOpenDelta();
        if (amountIn == type(uint128).max) revert AmountInIsUint128Max();
        if (minAmountOut < amountIn) revert MinOutBelowAmountIn();

        bytes[] memory params = new bytes[](3);
        params[0] = encodeSwapParams(
            ExactInputSingleParams({
                poolKey: buyPool,
                zeroForOne: false,
                amountIn: amountIn,
                amountOutMinimum: 0,
                minHopPriceX36: 0,
                hookData: ""
            })
        );
        params[1] = encodeSwapParams(
            ExactInputSingleParams({
                poolKey: sellPool,
                zeroForOne: true,
                amountIn: 0, // OPEN_DELTA: everything swap 1 bought
                amountOutMinimum: minAmountOut,
                minHopPriceX36: 0,
                hookData: ""
            })
        );
        params[2] = encodeTake(buyPool.currency1, recipient, OPEN_DELTA);

        bytes[] memory inputs = new bytes[](1);
        inputs[0] = abi.encode(ACTIONS_SWAP_SWAP_TAKE, params);
        return encodeExecute(hex"10", inputs, deadline);
    }
}
