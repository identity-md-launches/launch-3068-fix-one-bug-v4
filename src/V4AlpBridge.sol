// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {V4SwapCalldata} from "./V4SwapCalldata.sol";

/// @title V4AlpBridge
/// @notice Job 10: reference encoder for the Uniswap V4 "ALP bridge" on Base (chain id 8453) and
///         for the eth_call reads behind the "ALP V4" rows of the cross-DEX table. Mirrors
///         js/v4-alp-bridge.js function for function; js/test/v4-alp-bridge.test.js asserts both
///         implementations produce the same bytes.
/// @dev Everything here is internal and pure: nothing is deployed, called or held. The layouts are
///      those of Uniswap's v4-periphery (V4Router / Actions / ActionConstants) and of the Universal
///      Router's Dispatcher, which the router at UNIVERSAL_ROUTER decodes. Unlike the Robinhood
///      Chain router of V4SwapCalldata, the Base router's ExactInputSingleParams has no
///      minHopPriceX36 word: the struct is poolKey, zeroForOne, amountIn, amountOutMinimum, hookData.
///
///      Two facts of the deployed contracts differ from the brief's wording and are encoded here as
///      they are on chain (checked with eth_call against Base on 2026-11-11):
///        - PoolManager has no getPool(bytes32). The on-chain poolId -> PoolKey map is
///          PositionManager.poolKeys(bytes25), keyed by the first 25 bytes of the poolId.
///        - StateView has no slot0(bytes32). It has getSlot0(bytes32) -> (sqrtPriceX96, tick,
///          protocolFee, lpFee) and getLiquidity(bytes32) -> liquidity; tickSpacing comes from the
///          PoolKey. Together they give every field the brief lists.
library V4AlpBridge {
    /// @notice The PoolKey returned for a poolId does not hash back to that poolId.
    error PoolKeyMismatch(bytes32 expected, bytes32 actual);
    /// @notice currency0 must sort strictly below currency1.
    error CurrenciesNotSorted();
    /// @notice The input currency is neither currency of the pool.
    error CurrencyNotInPool();
    /// @notice The output recipient is the zero address.
    error ZeroRecipient();
    /// @notice amountIn 0 is OPEN_DELTA, meaningless for a swap paid by the caller.
    error AmountInIsOpenDelta();
    /// @notice A multi-hop path needs at least one hop.
    error EmptyPath();
    /// @notice A hop's intermediate currency equals the currency it is swapped from.
    error PathLoops();
    /// @notice The V3 fee is not one of Uniswap V3's tiers (100, 500, 3000, 10000).
    error UnsupportedV3Fee(uint24 fee);
    /// @notice The route's first hop must sell a token other than ALP for ALP.
    error NotAnAlpRoute();
    /// @notice sqrtPriceX96 is 0: the pool is not initialized.
    error PoolNotInitialized();
    /// @notice sqrtPriceX96 >= 2^128: the price does not fit the e18 fixed point this library uses.
    error PriceOutOfRange();
    /// @notice commands and inputs differ in length.
    error InputCountMismatch();

    struct PoolKey {
        address currency0;
        address currency1;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
    }

    /// @dev One hop of a V4 multi-hop path (v4-periphery PathKey).
    struct PathKey {
        address intermediateCurrency;
        uint24 fee;
        int24 tickSpacing;
        address hooks;
        bytes hookData;
    }

    /// @dev v4-periphery IV4Router.ExactInputParams: the struct SWAP_EXACT_IN (0x07) decodes.
    struct ExactInputParams {
        address currencyIn;
        PathKey[] path;
        uint128 amountIn;
        uint128 amountOutMinimum;
    }

    /// @dev v4-periphery IV4Router.ExactInputSingleParams: the struct SWAP_EXACT_IN_SINGLE (0x06) decodes.
    struct ExactInputSingleParams {
        PoolKey poolKey;
        bool zeroForOne;
        uint128 amountIn;
        uint128 amountOutMinimum;
        bytes hookData;
    }

    /// @dev StateView.getSlot0 plus getLiquidity, and the tickSpacing of the PoolKey.
    struct Slot0 {
        uint160 sqrtPriceX96;
        int24 tick;
        uint24 protocolFee;
        uint24 lpFee;
        uint128 liquidity;
        int24 tickSpacing;
    }

    // ---------------------------------------------------------------- Base (8453) addresses of the brief
    uint256 internal constant CHAIN_ID = 8453;
    address internal constant POOL_MANAGER = 0x498581fF718922c3f8e6A244956aF099B2652b2b;
    address internal constant STATE_VIEW = 0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71;
    address internal constant UNIVERSAL_ROUTER = 0xd6145b2D3F379919E8CdEda7B97e37c4b2Ca9c40;
    address internal constant POSITION_MANAGER = 0x7C5f5A4bBd8fD63184577525326123B519429bDc;
    address internal constant ALP = 0x29D95816a65425B3514f9AcaC7548b867343B818;
    /// @dev currency0 of the ALP/USDG pool: the USDG address whose key hashes to ALP_USDG_POOL_ID.
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    /// @dev Native ETH is currency address(0) in a V4 PoolKey.
    address internal constant NATIVE = address(0);
    bytes32 internal constant ALP_ETH_POOL_ID = 0x71fcb8242d330883f1114bd719b0d6f852a4c26450c665effb048a094766efd0;
    bytes32 internal constant ALP_USDG_POOL_ID = 0xa551151cfe4ea1bd015c01c6a6b4ca11056db4ddd81aa0ddc4d465e3c25b2000;
    /// @dev The ALP pools' fee: 1 hundredth of a bip, 0.0001%.
    uint24 internal constant ALP_POOL_FEE = 1;

    // ---------------------------------------------------------------- selectors and command bytes
    bytes4 internal constant EXECUTE_SELECTOR = V4SwapCalldata.EXECUTE_SELECTOR; // execute(bytes,bytes[],uint256)
    bytes4 internal constant POOL_KEYS_SELECTOR = bytes4(keccak256("poolKeys(bytes25)"));
    bytes4 internal constant GET_SLOT0_SELECTOR = bytes4(keccak256("getSlot0(bytes32)"));
    bytes4 internal constant GET_LIQUIDITY_SELECTOR = bytes4(keccak256("getLiquidity(bytes32)"));

    /// @dev Universal Router Commands. V4 swaps are command 0x10 (V4_SWAP); the exact-in path is the
    ///      V4 action 0x07 inside it. (0x04 is SWEEP in the router's Commands.sol, not a V4 swap.)
    bytes1 internal constant COMMAND_V3_SWAP_EXACT_IN = 0x00;
    bytes1 internal constant COMMAND_V4_SWAP = 0x10;
    /// @dev v4-periphery Actions.
    bytes1 internal constant ACTION_SWAP_EXACT_IN_SINGLE = 0x06;
    bytes1 internal constant ACTION_SWAP_EXACT_IN = 0x07;
    bytes1 internal constant ACTION_SETTLE = 0x0b;
    bytes1 internal constant ACTION_SETTLE_ALL = 0x0c;
    bytes1 internal constant ACTION_TAKE = 0x0e;
    bytes1 internal constant ACTION_TAKE_ALL = 0x0f;
    /// @dev ActionConstants.
    uint256 internal constant OPEN_DELTA = 0;
    uint256 internal constant CONTRACT_BALANCE = 0x8000000000000000000000000000000000000000000000000000000000000000;
    address internal constant MSG_SENDER = address(1);
    address internal constant ADDRESS_THIS = address(2);

    uint256 internal constant Q96 = 2 ** 96;
    uint256 internal constant FEE_DENOMINATOR = 1_000_000;

    // ---------------------------------------------------------------- pool ids and reads

    /// @notice keccak256(abi.encode(PoolKey)), the PoolManager's PoolId.
    function poolIdOf(PoolKey memory key) internal pure returns (bytes32) {
        return keccak256(abi.encode(key));
    }

    /// @notice PositionManager.poolKeys is keyed by the first 25 bytes of the PoolId.
    function toPoolKeysId(bytes32 poolId) internal pure returns (bytes25) {
        return bytes25(poolId);
    }

    /// @notice eth_call data for PositionManager.poolKeys(bytes25(poolId)).
    function encodePoolKeysCall(bytes32 poolId) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(POOL_KEYS_SELECTOR, toPoolKeysId(poolId));
    }

    /// @notice eth_call data for StateView.getSlot0(poolId).
    function encodeGetSlot0Call(bytes32 poolId) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(GET_SLOT0_SELECTOR, poolId);
    }

    /// @notice eth_call data for StateView.getLiquidity(poolId).
    function encodeGetLiquidityCall(bytes32 poolId) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(GET_LIQUIDITY_SELECTOR, poolId);
    }

    /// @notice Decode poolKeys(bytes25) and check the key hashes back to `poolId`. A zero key (no
    ///         position ever minted through the PositionManager) fails this check too.
    function decodePoolKey(bytes32 poolId, bytes memory returndata) internal pure returns (PoolKey memory key) {
        (key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks) =
            abi.decode(returndata, (address, address, uint24, int24, address));
        bytes32 actual = poolIdOf(key);
        if (actual != poolId) revert PoolKeyMismatch(poolId, actual);
    }

    /// @notice The PoolKeys the brief's two pool ids hash from: ALP/ETH is (ETH, ALP, 1, 1, no hook)
    ///         and ALP/USDG is (ALP, USDG, 1, 1, no hook). Both are checked against the ids in the tests.
    function alpEthKey() internal pure returns (PoolKey memory) {
        return PoolKey({currency0: NATIVE, currency1: ALP, fee: ALP_POOL_FEE, tickSpacing: 1, hooks: address(0)});
    }

    function alpUsdgKey() internal pure returns (PoolKey memory) {
        return PoolKey({currency0: ALP, currency1: USDG, fee: ALP_POOL_FEE, tickSpacing: 1, hooks: address(0)});
    }

    /// @notice Accept a candidate PoolKey for `poolId` only if it hashes to it. The poolId is the hash
    ///         of the key, so a passing key is the pool's key, tickSpacing included.
    function verifyPoolKey(bytes32 poolId, PoolKey memory key) internal pure returns (PoolKey memory) {
        bytes32 actual = poolIdOf(key);
        if (actual != poolId) revert PoolKeyMismatch(poolId, actual);
        return key;
    }

    /// @dev PoolManager without a StateView (Robinhood Chain's): Pool.State lives at
    ///      keccak256(abi.encode(poolId, POOLS_SLOT)); slot0 at +0, liquidity at +3 (StateLibrary).
    uint256 internal constant POOLS_SLOT = 6;
    uint256 internal constant LIQUIDITY_OFFSET = 3;
    bytes4 internal constant EXTSLOAD_SELECTOR = bytes4(keccak256("extsload(bytes32)"));

    function slot0StorageSlot(bytes32 poolId) internal pure returns (bytes32) {
        return keccak256(abi.encode(poolId, POOLS_SLOT));
    }

    function liquidityStorageSlot(bytes32 poolId) internal pure returns (bytes32) {
        return bytes32(uint256(slot0StorageSlot(poolId)) + LIQUIDITY_OFFSET);
    }

    function encodeExtsloadCall(bytes32 slot) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(EXTSLOAD_SELECTOR, slot);
    }

    /// @notice Unpack a Slot0 word: sqrtPriceX96 in the low 160 bits, then tick (24), protocolFee
    ///         (24) and lpFee (24).
    function decodeSlot0Word(bytes32 word, bytes32 liquidityWord, int24 tickSpacing)
        internal
        pure
        returns (Slot0 memory slot)
    {
        uint256 w = uint256(word);
        // casting is safe because each field is masked to its width first
        // forge-lint: disable-start(unsafe-typecast)
        slot.sqrtPriceX96 = uint160(w & ((1 << 160) - 1));
        uint24 rawTick = uint24((w >> 160) & 0xffffff);
        slot.tick = int24(rawTick);
        slot.protocolFee = uint24((w >> 184) & 0xffffff);
        slot.lpFee = uint24((w >> 208) & 0xffffff);
        slot.liquidity = uint128(uint256(liquidityWord) & ((1 << 128) - 1));
        // forge-lint: disable-end(unsafe-typecast)
        slot.tickSpacing = tickSpacing;
    }

    /// @notice Decode getSlot0 and getLiquidity into one record; tickSpacing comes from the key.
    function decodeSlot0(bytes memory slot0Data, bytes memory liquidityData, int24 tickSpacing)
        internal
        pure
        returns (Slot0 memory slot)
    {
        (slot.sqrtPriceX96, slot.tick, slot.protocolFee, slot.lpFee) =
            abi.decode(slot0Data, (uint160, int24, uint24, uint24));
        slot.liquidity = abi.decode(liquidityData, (uint128));
        slot.tickSpacing = tickSpacing;
    }

    /// @notice (sqrtPriceX96 / 2^96)^2 scaled by 1e18: currency1 per currency0 in base units.
    /// @dev Exact for sqrtPriceX96 below 2^128 to within 1e-11 (the lower 96 bits of the square are
    ///      dropped before scaling). Above that the price exceeds 2^64 and is out of this range.
    function priceE18(uint160 sqrtPriceX96) internal pure returns (uint256) {
        if (sqrtPriceX96 == 0) revert PoolNotInitialized();
        if (sqrtPriceX96 >= 2 ** 128) revert PriceOutOfRange();
        uint256 squared = uint256(sqrtPriceX96) * uint256(sqrtPriceX96); // < 2^256
        return ((squared / Q96) * 1e18) / Q96;
    }

    /// @notice Spot output of selling `amountIn` through a pool at `price` (e18, currency1 per
    ///         currency0) after its fee. No price impact: a display estimate, never a minimum.
    function spotQuote(uint256 amountIn, uint256 price, uint24 fee, bool zeroForOne) internal pure returns (uint256) {
        if (price == 0) revert PoolNotInitialized();
        uint256 gross = zeroForOne ? (amountIn * price) / 1e18 : (amountIn * 1e18) / price;
        return (gross * (FEE_DENOMINATOR - fee)) / FEE_DENOMINATOR;
    }

    // ---------------------------------------------------------------- V4 action encoders

    /// @notice The PathKey that swaps out of `currencyIn` through `key`.
    function pathKeyFor(PoolKey memory key, address currencyIn) internal pure returns (PathKey memory) {
        if (key.currency0 >= key.currency1) revert CurrenciesNotSorted();
        address intermediate;
        if (currencyIn == key.currency0) intermediate = key.currency1;
        else if (currencyIn == key.currency1) intermediate = key.currency0;
        else revert CurrencyNotInPool();
        return PathKey({
            intermediateCurrency: intermediate,
            fee: key.fee,
            tickSpacing: key.tickSpacing,
            hooks: key.hooks,
            hookData: ""
        });
    }

    /// @notice abi.encode of ExactInputParams: offset word, then currencyIn, path offset, amountIn,
    ///         amountOutMinimum, then the PathKey array.
    function encodeExactInput(ExactInputParams memory params) internal pure returns (bytes memory) {
        if (params.path.length == 0) revert EmptyPath();
        if (params.amountIn == OPEN_DELTA) revert AmountInIsOpenDelta();
        address current = params.currencyIn;
        for (uint256 i = 0; i < params.path.length; ++i) {
            if (params.path[i].intermediateCurrency == current) revert PathLoops();
            current = params.path[i].intermediateCurrency;
        }
        return abi.encode(params);
    }

    /// @notice abi.encode of ExactInputSingleParams (five fields, no minHopPriceX36).
    function encodeExactInputSingle(ExactInputSingleParams memory params) internal pure returns (bytes memory) {
        if (params.poolKey.currency0 >= params.poolKey.currency1) revert CurrenciesNotSorted();
        return abi.encode(params);
    }

    /// @notice SETTLE(currency, amount, payerIsUser).
    function encodeSettle(address currency, uint256 amount, bool payerIsUser) internal pure returns (bytes memory) {
        return abi.encode(currency, amount, payerIsUser);
    }

    /// @notice SETTLE_ALL(currency, maxAmount).
    function encodeSettleAll(address currency, uint256 maxAmount) internal pure returns (bytes memory) {
        return abi.encode(currency, maxAmount);
    }

    /// @notice TAKE(currency, recipient, amount). Amount OPEN_DELTA takes the whole credit.
    function encodeTake(address currency, address recipient, uint256 amount) internal pure returns (bytes memory) {
        if (recipient == address(0)) revert ZeroRecipient();
        return abi.encode(currency, recipient, amount);
    }

    /// @notice TAKE_ALL(currency, minAmount): the whole credit to the caller, at least minAmount.
    function encodeTakeAll(address currency, uint256 minAmount) internal pure returns (bytes memory) {
        return abi.encode(currency, minAmount);
    }

    /// @notice One V4_SWAP input: abi.encode(actions, params).
    function encodeV4SwapInput(bytes memory actions, bytes[] memory params) internal pure returns (bytes memory) {
        if (actions.length != params.length) revert InputCountMismatch();
        return abi.encode(actions, params);
    }

    /// @notice execute(commands, inputs, deadline) calldata.
    function encodeExecute(bytes memory commands, bytes[] memory inputs, uint256 deadline)
        internal
        pure
        returns (bytes memory)
    {
        if (commands.length != inputs.length) revert InputCountMismatch();
        return abi.encodeWithSelector(EXECUTE_SELECTOR, commands, inputs, deadline);
    }

    /// @notice The last currency of a path.
    function currencyOut(ExactInputParams memory params) internal pure returns (address) {
        if (params.path.length == 0) revert EmptyPath();
        return params.path[params.path.length - 1].intermediateCurrency;
    }

    /// @notice A V4-only exact-in swap along `path`: command 0x10 with actions
    ///         SWAP_EXACT_IN (0x07), SETTLE_ALL (0x0c) of the input, TAKE (0x0e) of the whole output
    ///         to `recipient`. The caller pays through Permit2, or with msg.value when currencyIn is
    ///         native ETH.
    function buildV4ExactInCalldata(address recipient, uint256 deadline, ExactInputParams memory params)
        internal
        pure
        returns (bytes memory)
    {
        if (recipient == address(0)) revert ZeroRecipient();
        bytes[] memory actionParams = new bytes[](3);
        actionParams[0] = encodeExactInput(params);
        actionParams[1] = encodeSettleAll(params.currencyIn, params.amountIn);
        actionParams[2] = encodeTake(currencyOut(params), recipient, OPEN_DELTA);
        bytes[] memory inputs = new bytes[](1);
        inputs[0] =
            encodeV4SwapInput(abi.encodePacked(ACTION_SWAP_EXACT_IN, ACTION_SETTLE_ALL, ACTION_TAKE), actionParams);
        return encodeExecute(abi.encodePacked(COMMAND_V4_SWAP), inputs, deadline);
    }

    // ---------------------------------------------------------------- the ALP bridge route (V3 -> V4)

    /// @notice Uniswap V3 path tokenIn | fee | tokenOut (packed 20 + 3 + 20 bytes).
    function encodeV3Path(address tokenIn, uint24 fee, address tokenOut) internal pure returns (bytes memory) {
        if (fee != 100 && fee != 500 && fee != 3000 && fee != 10000) revert UnsupportedV3Fee(fee);
        return abi.encodePacked(tokenIn, fee, tokenOut);
    }

    /// @notice V3_SWAP_EXACT_IN input: (recipient, amountIn, amountOutMin, path, payerIsUser).
    function encodeV3ExactIn(
        address recipient,
        uint256 amountIn,
        uint256 amountOutMin,
        bytes memory path,
        bool payerIsUser
    ) internal pure returns (bytes memory) {
        if (amountIn == 0) revert AmountInIsOpenDelta();
        return abi.encode(recipient, amountIn, amountOutMin, path, payerIsUser);
    }

    /// @notice Token -> [V3 pool, v3Fee] -> ALP -> [V4 ALP pool] -> out, in one execute():
    ///         command 0x00 sells `amountIn` of `tokenIn` for ALP into the router (ADDRESS_THIS,
    ///         payer = caller through Permit2), then command 0x10 SETTLEs the router's whole ALP
    ///         balance (CONTRACT_BALANCE, payerIsUser false), swaps it (amountIn OPEN_DELTA) on the
    ///         ALP pool and TAKEs the output to `recipient`. `amountOutMinimum` guards the final leg;
    ///         the V3 leg's own minimum is 0 because the whole output is consumed inside the same call.
    function buildBridgeRouteCalldata(
        address recipient,
        uint256 deadline,
        address tokenIn,
        uint24 v3Fee,
        PoolKey memory alpPool,
        uint128 amountIn,
        uint128 amountOutMinimum
    ) internal pure returns (bytes memory) {
        if (recipient == address(0)) revert ZeroRecipient();
        if (amountIn == OPEN_DELTA) revert AmountInIsOpenDelta();
        if (tokenIn == ALP) revert NotAnAlpRoute();
        if (alpPool.currency0 != ALP && alpPool.currency1 != ALP) revert NotAnAlpRoute();
        bool zeroForOne = alpPool.currency0 == ALP;
        address out = zeroForOne ? alpPool.currency1 : alpPool.currency0;

        bytes[] memory v4Params = new bytes[](3);
        v4Params[0] = encodeSettle(ALP, CONTRACT_BALANCE, false);
        v4Params[1] = encodeExactInputSingle(
            ExactInputSingleParams({
                poolKey: alpPool,
                zeroForOne: zeroForOne,
                amountIn: 0, // OPEN_DELTA: the ALP credited by the SETTLE
                amountOutMinimum: amountOutMinimum,
                hookData: ""
            })
        );
        v4Params[2] = encodeTake(out, recipient, OPEN_DELTA);

        bytes[] memory inputs = new bytes[](2);
        inputs[0] = encodeV3ExactIn(ADDRESS_THIS, amountIn, 0, encodeV3Path(tokenIn, v3Fee, ALP), true);
        inputs[1] =
            encodeV4SwapInput(abi.encodePacked(ACTION_SETTLE, ACTION_SWAP_EXACT_IN_SINGLE, ACTION_TAKE), v4Params);
        return encodeExecute(abi.encodePacked(COMMAND_V3_SWAP_EXACT_IN, COMMAND_V4_SWAP), inputs, deadline);
    }

    /// @notice A pair is routed through the ALP V4 pool when either side is ALP.
    function involvesAlp(address tokenA, address tokenB) internal pure returns (bool) {
        return tokenA == ALP || tokenB == ALP;
    }

    /// @notice Total fee of the two hops in hundredths of a bip (3000 + 1 = 3001 = 0.3001%).
    function totalFee(uint24 v3Fee, uint24 v4Fee) internal pure returns (uint24) {
        return v3Fee + v4Fee;
    }

    /// @notice A fee in hundredths of a bip as a percentage: 3000 -> "0.30", 1 -> "0.0001", 3001 -> "0.3001".
    function formatFeePercent(uint24 fee) internal pure returns (string memory) {
        uint256 whole = fee / 10_000;
        uint256 fraction = fee % 10_000; // four decimals
        bytes memory digits = new bytes(4);
        for (uint256 i = 4; i > 0; --i) {
            digits[i - 1] = bytes1(uint8(48 + fraction % 10));
            fraction /= 10;
        }
        uint256 keep = 4;
        while (keep > 2 && digits[keep - 1] == "0") --keep;
        bytes memory trimmed = new bytes(keep);
        for (uint256 i = 0; i < keep; ++i) {
            trimmed[i] = digits[i];
        }
        return string.concat(_uintToString(whole), ".", string(trimmed));
    }

    /// @notice "Route: TOKEN -> ALP (V3 0.30%) -> USDG (V4 0.0001%) | Total fee: 0.3001%" with arrows.
    function describeRoute(string memory tokenSymbol, uint24 v3Fee, string memory outSymbol, uint24 v4Fee)
        internal
        pure
        returns (string memory)
    {
        return string.concat(
            "Route: ",
            tokenSymbol,
            unicode" → ALP (V3 ",
            formatFeePercent(v3Fee),
            unicode"%) → ",
            outSymbol,
            " (V4 ",
            formatFeePercent(v4Fee),
            "%) | Total fee: ",
            formatFeePercent(totalFee(v3Fee, v4Fee)),
            "%"
        );
    }

    function _uintToString(uint256 value) private pure returns (string memory) {
        if (value == 0) return "0";
        uint256 length;
        for (uint256 v = value; v > 0; v /= 10) {
            ++length;
        }
        bytes memory out = new bytes(length);
        for (uint256 v = value; v > 0; v /= 10) {
            out[--length] = bytes1(uint8(48 + v % 10));
        }
        return string(out);
    }
}
