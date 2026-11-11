// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {V4AlpBridge} from "../src/V4AlpBridge.sol";
import {V4AlpBridgeVectors} from "./V4AlpBridgeVectors.sol";

/// @dev External entry points so reverts can be expected.
contract AlpHarness {
    function buildBridgeRouteCalldata(
        address recipient,
        uint256 deadline,
        address tokenIn,
        uint24 v3Fee,
        V4AlpBridge.PoolKey memory alpPool,
        uint128 amountIn,
        uint128 amountOutMinimum
    ) external pure returns (bytes memory) {
        return V4AlpBridge.buildBridgeRouteCalldata(
            recipient, deadline, tokenIn, v3Fee, alpPool, amountIn, amountOutMinimum
        );
    }

    function buildV4ExactInCalldata(address recipient, uint256 deadline, V4AlpBridge.ExactInputParams memory params)
        external
        pure
        returns (bytes memory)
    {
        return V4AlpBridge.buildV4ExactInCalldata(recipient, deadline, params);
    }

    function encodeExactInput(V4AlpBridge.ExactInputParams memory params) external pure returns (bytes memory) {
        return V4AlpBridge.encodeExactInput(params);
    }

    function pathKeyFor(V4AlpBridge.PoolKey memory key, address currencyIn)
        external
        pure
        returns (V4AlpBridge.PathKey memory)
    {
        return V4AlpBridge.pathKeyFor(key, currencyIn);
    }

    function decodePoolKey(bytes32 poolId, bytes memory data) external pure returns (V4AlpBridge.PoolKey memory) {
        return V4AlpBridge.decodePoolKey(poolId, data);
    }

    function verifyPoolKey(bytes32 poolId, V4AlpBridge.PoolKey memory key)
        external
        pure
        returns (V4AlpBridge.PoolKey memory)
    {
        return V4AlpBridge.verifyPoolKey(poolId, key);
    }

    function priceE18(uint160 sqrtPriceX96) external pure returns (uint256) {
        return V4AlpBridge.priceE18(sqrtPriceX96);
    }

    function spotQuote(uint256 amountIn, uint256 price, uint24 fee, bool zeroForOne) external pure returns (uint256) {
        return V4AlpBridge.spotQuote(amountIn, price, fee, zeroForOne);
    }

    function encodeV3Path(address tokenIn, uint24 fee, address tokenOut) external pure returns (bytes memory) {
        return V4AlpBridge.encodeV3Path(tokenIn, fee, tokenOut);
    }

    function encodeTake(address currency, address recipient, uint256 amount) external pure returns (bytes memory) {
        return V4AlpBridge.encodeTake(currency, recipient, amount);
    }

    function encodeExecute(bytes memory commands, bytes[] memory inputs, uint256 deadline)
        external
        pure
        returns (bytes memory)
    {
        return V4AlpBridge.encodeExecute(commands, inputs, deadline);
    }
}

contract V4AlpBridgeTest is Test {
    AlpHarness internal h;

    address internal constant RECIPIENT = 0xd064E892A3BBb758053922C80098b7f4130444c6;
    address internal constant WETH = 0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73;
    uint256 internal constant DEADLINE = 1_800_000_000;
    uint128 internal constant ONE_ETH = 1e18;
    uint128 internal constant MIN_OUT = 2_500_000_000;
    /// @dev The slot0 word of the ALP/ETH pool read from the Robinhood Chain PoolManager on 2026-11-11.
    bytes32 internal constant LIVE_SLOT0 = 0x0000000000010010010315660000000000005f749e8ae92fc28297be66495c7e;

    function setUp() public {
        h = new AlpHarness();
    }

    // ------------------------------------------------------------- pool ids and keys

    function test_BriefPoolIdsHashFromTheKnownKeys() public pure {
        assertEq(V4AlpBridge.poolIdOf(V4AlpBridge.alpEthKey()), V4AlpBridge.ALP_ETH_POOL_ID, "ALP/ETH");
        assertEq(V4AlpBridge.poolIdOf(V4AlpBridge.alpUsdgKey()), V4AlpBridge.ALP_USDG_POOL_ID, "ALP/USDG");
        assertEq(V4AlpBridge.alpEthKey().tickSpacing, 1);
        assertEq(V4AlpBridge.alpUsdgKey().fee, V4AlpBridge.ALP_POOL_FEE);
        assertEq(V4AlpBridge.alpEthKey().currency0, V4AlpBridge.NATIVE, "ETH is currency0");
        assertTrue(V4AlpBridge.ALP < V4AlpBridge.USDG, "ALP sorts first in ALP/USDG");
    }

    function test_VerifyPoolKeyAcceptsTheRightKeyAndRejectsAnyOtherTickSpacing() public {
        V4AlpBridge.PoolKey memory key = h.verifyPoolKey(V4AlpBridge.ALP_USDG_POOL_ID, V4AlpBridge.alpUsdgKey());
        assertEq(key.currency1, V4AlpBridge.USDG);
        V4AlpBridge.PoolKey memory wrong = V4AlpBridge.alpUsdgKey();
        wrong.tickSpacing = 10;
        bytes32 actual = V4AlpBridge.poolIdOf(wrong);
        vm.expectRevert(
            abi.encodeWithSelector(V4AlpBridge.PoolKeyMismatch.selector, V4AlpBridge.ALP_USDG_POOL_ID, actual)
        );
        h.verifyPoolKey(V4AlpBridge.ALP_USDG_POOL_ID, wrong);
    }

    function test_ReadCalldataUsesTheDeployedSelectors() public pure {
        bytes memory keys = V4AlpBridge.encodePoolKeysCall(V4AlpBridge.ALP_ETH_POOL_ID);
        assertEq(keys.length, 36);
        assertEq(bytes4(keys), bytes4(0x86b6be7d), "poolKeys(bytes25)");
        // bytes25 is left-aligned: the first 25 bytes of the id, then seven zero bytes.
        assertEq(keys, hex"86b6be7d71fcb8242d330883f1114bd719b0d6f852a4c26450c665effb00000000000000");
        assertEq(bytes4(V4AlpBridge.encodeGetSlot0Call(V4AlpBridge.ALP_ETH_POOL_ID)), bytes4(0xc815641c), "getSlot0");
        assertEq(
            bytes4(V4AlpBridge.encodeGetLiquidityCall(V4AlpBridge.ALP_ETH_POOL_ID)), bytes4(0xfa6793d5), "getLiquidity"
        );
        assertEq(
            V4AlpBridge.slot0StorageSlot(V4AlpBridge.ALP_ETH_POOL_ID),
            0xdc15c47262520be0a0f79567d75c4d9ddc7f43956e1b2e65dcd4ae16e7311b4b
        );
        assertEq(
            V4AlpBridge.liquidityStorageSlot(V4AlpBridge.ALP_ETH_POOL_ID),
            0xdc15c47262520be0a0f79567d75c4d9ddc7f43956e1b2e65dcd4ae16e7311b4e
        );
        assertEq(bytes4(V4AlpBridge.encodeExtsloadCall(bytes32(0))), bytes4(0x1e2eaeaf), "extsload(bytes32)");
    }

    function test_DecodePoolKeyAcceptsTheChainsAnswerAndRejectsAMismatch() public {
        V4AlpBridge.PoolKey memory expected = V4AlpBridge.alpEthKey();
        bytes memory answer =
            abi.encode(expected.currency0, expected.currency1, expected.fee, expected.tickSpacing, expected.hooks);
        V4AlpBridge.PoolKey memory key = h.decodePoolKey(V4AlpBridge.ALP_ETH_POOL_ID, answer);
        assertEq(key.currency1, V4AlpBridge.ALP);
        assertEq(key.tickSpacing, 1);
        // A zero key (poolKeys of an id the PositionManager never saw) fails the hash check.
        bytes memory zero = abi.encode(address(0), address(0), uint24(0), int24(0), address(0));
        vm.expectRevert();
        h.decodePoolKey(V4AlpBridge.ALP_ETH_POOL_ID, zero);
    }

    function test_DecodeSlot0FromStateViewAndFromTheRawWord() public pure {
        V4AlpBridge.Slot0 memory viaView = V4AlpBridge.decodeSlot0(
            abi.encode(uint160(2 ** 96), int24(0), uint24(0), uint24(1)), abi.encode(uint128(777)), int24(1)
        );
        assertEq(viaView.sqrtPriceX96, 2 ** 96);
        assertEq(viaView.lpFee, 1);
        assertEq(viaView.liquidity, 777);
        assertEq(viaView.tickSpacing, 1);

        V4AlpBridge.Slot0 memory live = V4AlpBridge.decodeSlot0Word(LIVE_SLOT0, bytes32(uint256(12345)), int24(1));
        assertEq(live.sqrtPriceX96, 0x5f749e8ae92fc28297be66495c7e);
        assertEq(live.tick, 202086);
        assertEq(live.protocolFee, 0x001001);
        assertEq(live.lpFee, 1);
        assertEq(live.liquidity, 12345);
        // A negative tick is sign-extended from 24 bits.
        bytes32 negative = bytes32(uint256(0xffffff) << 160);
        assertEq(V4AlpBridge.decodeSlot0Word(negative, bytes32(0), int24(1)).tick, -1);
    }

    // ------------------------------------------------------------- price

    function test_PriceIsSqrtPriceSquared() public pure {
        assertEq(V4AlpBridge.priceE18(uint160(2 ** 96)), 1e18, "sqrt 1 -> 1");
        assertEq(V4AlpBridge.priceE18(uint160(2 ** 97)), 4e18, "sqrt 2 -> 4");
        assertEq(V4AlpBridge.priceE18(uint160(2 ** 95)), 0.25e18, "sqrt 0.5 -> 0.25");
        // The live ALP/ETH word: about 5.97e8 ALP per ETH in base units.
        uint256 live = V4AlpBridge.priceE18(0x5f749e8ae92fc28297be66495c7e);
        assertApproxEqRel(live, 597148363.1607138e18, 1e12);
    }

    function test_RevertWhen_PriceIsZeroOrOutOfRange() public {
        vm.expectRevert(V4AlpBridge.PoolNotInitialized.selector);
        h.priceE18(0);
        vm.expectRevert(V4AlpBridge.PriceOutOfRange.selector);
        h.priceE18(uint160(2 ** 128));
    }

    function testFuzz_PriceIsMonotonicInSqrtPrice(uint128 a, uint128 b) public pure {
        vm.assume(a > 0 && b > 0);
        (uint128 lo, uint128 hi) = a < b ? (a, b) : (b, a);
        assertLe(V4AlpBridge.priceE18(lo), V4AlpBridge.priceE18(hi));
    }

    function test_SpotQuoteAppliesPriceAndFeeBothWays() public {
        // price 2 token1 per token0, fee 1 (0.0001%): selling 1e18 of token0 returns 2e18 minus 0.0001%.
        assertEq(h.spotQuote(1e18, 2e18, 1, true), 2e18 - 2e12);
        // selling token1 for token0: 1e18 / 2 minus fee.
        assertEq(h.spotQuote(1e18, 2e18, 1, false), 0.5e18 - 0.5e12);
        // 0.30% on 1e18 at price 1.
        assertEq(h.spotQuote(1e18, 1e18, 3000, true), 0.997e18);
        vm.expectRevert(V4AlpBridge.PoolNotInitialized.selector);
        h.spotQuote(1e18, 0, 1, true);
    }

    // ------------------------------------------------------------- fees and route text

    function test_FormatFeePercent() public pure {
        assertEq(V4AlpBridge.formatFeePercent(3000), "0.30");
        assertEq(V4AlpBridge.formatFeePercent(1), "0.0001");
        assertEq(V4AlpBridge.formatFeePercent(3001), "0.3001");
        assertEq(V4AlpBridge.formatFeePercent(500), "0.05");
        assertEq(V4AlpBridge.formatFeePercent(100), "0.01");
        assertEq(V4AlpBridge.formatFeePercent(10000), "1.00");
        assertEq(V4AlpBridge.formatFeePercent(0), "0.00");
        assertEq(V4AlpBridge.formatFeePercent(30000), "3.00");
    }

    function test_DescribeRouteMatchesTheBriefsLine() public pure {
        assertEq(
            V4AlpBridge.describeRoute("TOKEN", 3000, "USDG", V4AlpBridge.ALP_POOL_FEE),
            unicode"Route: TOKEN → ALP (V3 0.30%) → USDG (V4 0.0001%) | Total fee: 0.3001%"
        );
        assertEq(V4AlpBridge.totalFee(500, 1), 501);
        assertTrue(V4AlpBridge.involvesAlp(V4AlpBridge.ALP, WETH));
        assertTrue(V4AlpBridge.involvesAlp(WETH, V4AlpBridge.ALP));
        assertFalse(V4AlpBridge.involvesAlp(WETH, V4AlpBridge.USDG));
    }

    // ------------------------------------------------------------- encoders vs the JavaScript

    function test_BridgeRouteMatchesTheJavaScriptByteForByte() public view {
        bytes memory data =
            h.buildBridgeRouteCalldata(RECIPIENT, DEADLINE, WETH, 3000, V4AlpBridge.alpUsdgKey(), ONE_ETH, MIN_OUT);
        assertEq(data, V4AlpBridgeVectors.JS_BRIDGE_ROUTE);
    }

    function test_BridgeRouteDecodesToV3ThenV4WithOpenDeltaAndContractBalance() public view {
        bytes memory data =
            h.buildBridgeRouteCalldata(RECIPIENT, DEADLINE, WETH, 3000, V4AlpBridge.alpUsdgKey(), ONE_ETH, MIN_OUT);
        assertEq(bytes4(data), V4AlpBridge.EXECUTE_SELECTOR);
        (bytes memory commands, bytes[] memory inputs, uint256 deadline) = _decodeExecute(data);
        assertEq(commands, hex"0010", "V3_SWAP_EXACT_IN then V4_SWAP");
        assertEq(inputs.length, 2);
        assertEq(deadline, DEADLINE);

        (address v3Recipient, uint256 amountIn, uint256 minOut, bytes memory path, bool payerIsUser) =
            abi.decode(inputs[0], (address, uint256, uint256, bytes, bool));
        assertEq(v3Recipient, V4AlpBridge.ADDRESS_THIS, "V3 output stays in the router");
        assertEq(amountIn, ONE_ETH);
        assertEq(minOut, 0, "the V4 leg carries the minimum");
        assertEq(path, abi.encodePacked(WETH, uint24(3000), V4AlpBridge.ALP));
        assertTrue(payerIsUser);

        (bytes memory actions, bytes[] memory params) = abi.decode(inputs[1], (bytes, bytes[]));
        assertEq(actions, hex"0b060e", "SETTLE, SWAP_EXACT_IN_SINGLE, TAKE");
        (address settleCurrency, uint256 settleAmount, bool settlePayerIsUser) =
            abi.decode(params[0], (address, uint256, bool));
        assertEq(settleCurrency, V4AlpBridge.ALP);
        assertEq(settleAmount, V4AlpBridge.CONTRACT_BALANCE);
        assertFalse(settlePayerIsUser, "the router pays with the V3 output");
        V4AlpBridge.ExactInputSingleParams memory swap = abi.decode(params[1], (V4AlpBridge.ExactInputSingleParams));
        assertEq(swap.poolKey.currency0, V4AlpBridge.ALP);
        assertEq(swap.poolKey.tickSpacing, 1);
        assertTrue(swap.zeroForOne, "ALP (currency0) -> USDG");
        assertEq(swap.amountIn, 0, "OPEN_DELTA");
        assertEq(swap.amountOutMinimum, MIN_OUT);
        assertEq(swap.hookData.length, 0);
        (address takeCurrency, address takeRecipient, uint256 takeAmount) =
            abi.decode(params[2], (address, address, uint256));
        assertEq(takeCurrency, V4AlpBridge.USDG);
        assertEq(takeRecipient, RECIPIENT);
        assertEq(takeAmount, V4AlpBridge.OPEN_DELTA);
    }

    function test_ExactInputSingleHasFiveFieldsNotSix() public pure {
        bytes memory encoded = V4AlpBridge.encodeExactInputSingle(
            V4AlpBridge.ExactInputSingleParams({
                poolKey: V4AlpBridge.alpUsdgKey(), zeroForOne: true, amountIn: 1, amountOutMinimum: 2, hookData: ""
            })
        );
        // offset word + 8 head words (5 key + zeroForOne + amountIn + minOut) + hookData offset + hookData length
        assertEq(encoded.length, 0x20 + 8 * 0x20 + 0x20 + 0x20);
        assertEq(uint256(bytes32(_slice(encoded, 0x120, 0x20))), 0x120, "hookData offset is 0x120, not 0x140");
    }

    function test_V4PathMatchesTheJavaScriptAndDecodes() public view {
        V4AlpBridge.PathKey[] memory path = new V4AlpBridge.PathKey[](2);
        path[0] = h.pathKeyFor(V4AlpBridge.alpEthKey(), V4AlpBridge.NATIVE);
        path[1] = h.pathKeyFor(V4AlpBridge.alpUsdgKey(), V4AlpBridge.ALP);
        V4AlpBridge.ExactInputParams memory params = V4AlpBridge.ExactInputParams({
            currencyIn: V4AlpBridge.NATIVE, path: path, amountIn: ONE_ETH, amountOutMinimum: MIN_OUT
        });
        bytes memory data = h.buildV4ExactInCalldata(RECIPIENT, DEADLINE, params);
        assertEq(data, V4AlpBridgeVectors.JS_V4_PATH);

        (bytes memory commands, bytes[] memory inputs,) = _decodeExecute(data);
        assertEq(commands, hex"10", "one V4_SWAP command");
        (bytes memory actions, bytes[] memory actionParams) = abi.decode(inputs[0], (bytes, bytes[]));
        assertEq(actions, hex"070c0e", "SWAP_EXACT_IN, SETTLE_ALL, TAKE");
        V4AlpBridge.ExactInputParams memory decoded = abi.decode(actionParams[0], (V4AlpBridge.ExactInputParams));
        assertEq(decoded.currencyIn, V4AlpBridge.NATIVE);
        assertEq(decoded.path.length, 2);
        assertEq(decoded.path[0].intermediateCurrency, V4AlpBridge.ALP);
        assertEq(decoded.path[1].intermediateCurrency, V4AlpBridge.USDG);
        assertEq(decoded.path[1].tickSpacing, 1);
        assertEq(decoded.amountIn, ONE_ETH);
        assertEq(decoded.amountOutMinimum, MIN_OUT);
        (address settleCurrency, uint256 settleMax) = abi.decode(actionParams[1], (address, uint256));
        assertEq(settleCurrency, V4AlpBridge.NATIVE);
        assertEq(settleMax, ONE_ETH);
        (address takeCurrency, address takeRecipient, uint256 takeAmount) =
            abi.decode(actionParams[2], (address, address, uint256));
        assertEq(takeCurrency, V4AlpBridge.USDG);
        assertEq(takeRecipient, RECIPIENT);
        assertEq(takeAmount, 0);
    }

    function testFuzz_BridgeRouteRoundTripsAmountsAndRecipient(address recipient, uint128 amountIn, uint128 minOut)
        public
        view
    {
        vm.assume(recipient != address(0) && amountIn != 0);
        bytes memory data =
            h.buildBridgeRouteCalldata(recipient, DEADLINE, WETH, 500, V4AlpBridge.alpUsdgKey(), amountIn, minOut);
        (, bytes[] memory inputs,) = _decodeExecute(data);
        (, uint256 decodedIn,,,) = abi.decode(inputs[0], (address, uint256, uint256, bytes, bool));
        assertEq(decodedIn, amountIn);
        (, bytes[] memory params) = abi.decode(inputs[1], (bytes, bytes[]));
        V4AlpBridge.ExactInputSingleParams memory swap = abi.decode(params[1], (V4AlpBridge.ExactInputSingleParams));
        assertEq(swap.amountOutMinimum, minOut);
        (, address takeRecipient,) = abi.decode(params[2], (address, address, uint256));
        assertEq(takeRecipient, recipient);
    }

    // ------------------------------------------------------------- failure paths

    function test_RevertWhen_BridgeRouteArgumentsAreInvalid() public {
        V4AlpBridge.PoolKey memory alp = V4AlpBridge.alpUsdgKey();
        vm.expectRevert(V4AlpBridge.ZeroRecipient.selector);
        h.buildBridgeRouteCalldata(address(0), DEADLINE, WETH, 3000, alp, ONE_ETH, MIN_OUT);
        vm.expectRevert(V4AlpBridge.AmountInIsOpenDelta.selector);
        h.buildBridgeRouteCalldata(RECIPIENT, DEADLINE, WETH, 3000, alp, 0, MIN_OUT);
        vm.expectRevert(V4AlpBridge.NotAnAlpRoute.selector);
        h.buildBridgeRouteCalldata(RECIPIENT, DEADLINE, V4AlpBridge.ALP, 3000, alp, ONE_ETH, MIN_OUT);
        V4AlpBridge.PoolKey memory notAlp = V4AlpBridge.PoolKey({
            currency0: WETH, currency1: V4AlpBridge.USDG, fee: 3000, tickSpacing: 60, hooks: address(0)
        });
        vm.expectRevert(V4AlpBridge.NotAnAlpRoute.selector);
        h.buildBridgeRouteCalldata(RECIPIENT, DEADLINE, WETH, 3000, notAlp, ONE_ETH, MIN_OUT);
        vm.expectRevert(abi.encodeWithSelector(V4AlpBridge.UnsupportedV3Fee.selector, uint24(2500)));
        h.buildBridgeRouteCalldata(RECIPIENT, DEADLINE, WETH, 2500, alp, ONE_ETH, MIN_OUT);
    }

    function test_RevertWhen_PathIsEmptyLoopsOrSellsNothing() public {
        V4AlpBridge.PathKey[] memory empty = new V4AlpBridge.PathKey[](0);
        vm.expectRevert(V4AlpBridge.EmptyPath.selector);
        h.encodeExactInput(
            V4AlpBridge.ExactInputParams({
                currencyIn: V4AlpBridge.NATIVE, path: empty, amountIn: 1, amountOutMinimum: 0
            })
        );
        V4AlpBridge.PathKey[] memory loop = new V4AlpBridge.PathKey[](1);
        loop[0] = h.pathKeyFor(V4AlpBridge.alpEthKey(), V4AlpBridge.ALP); // ETH out of an ALP -> ETH hop
        vm.expectRevert(V4AlpBridge.PathLoops.selector);
        h.encodeExactInput(
            V4AlpBridge.ExactInputParams({currencyIn: V4AlpBridge.NATIVE, path: loop, amountIn: 1, amountOutMinimum: 0})
        );
        V4AlpBridge.PathKey[] memory one = new V4AlpBridge.PathKey[](1);
        one[0] = h.pathKeyFor(V4AlpBridge.alpEthKey(), V4AlpBridge.NATIVE);
        vm.expectRevert(V4AlpBridge.AmountInIsOpenDelta.selector);
        h.encodeExactInput(
            V4AlpBridge.ExactInputParams({currencyIn: V4AlpBridge.NATIVE, path: one, amountIn: 0, amountOutMinimum: 0})
        );
        vm.expectRevert(V4AlpBridge.ZeroRecipient.selector);
        h.buildV4ExactInCalldata(
            address(0),
            DEADLINE,
            V4AlpBridge.ExactInputParams({currencyIn: V4AlpBridge.NATIVE, path: one, amountIn: 1, amountOutMinimum: 0})
        );
    }

    function test_RevertWhen_CurrencyIsNotInThePoolOrKeyIsUnsorted() public {
        vm.expectRevert(V4AlpBridge.CurrencyNotInPool.selector);
        h.pathKeyFor(V4AlpBridge.alpEthKey(), WETH);
        V4AlpBridge.PoolKey memory unsorted = V4AlpBridge.alpUsdgKey();
        (unsorted.currency0, unsorted.currency1) = (unsorted.currency1, unsorted.currency0);
        vm.expectRevert(V4AlpBridge.CurrenciesNotSorted.selector);
        h.pathKeyFor(unsorted, V4AlpBridge.ALP);
        vm.expectRevert(V4AlpBridge.ZeroRecipient.selector);
        h.encodeTake(V4AlpBridge.ALP, address(0), 0);
        vm.expectRevert(abi.encodeWithSelector(V4AlpBridge.UnsupportedV3Fee.selector, uint24(1)));
        h.encodeV3Path(WETH, 1, V4AlpBridge.ALP);
        bytes[] memory none = new bytes[](0);
        vm.expectRevert(V4AlpBridge.InputCountMismatch.selector);
        h.encodeExecute(hex"10", none, DEADLINE);
    }

    // ------------------------------------------------------------- helpers

    function _decodeExecute(bytes memory data)
        internal
        pure
        returns (bytes memory commands, bytes[] memory inputs, uint256 deadline)
    {
        bytes memory args = _slice(data, 4, data.length - 4);
        (commands, inputs, deadline) = abi.decode(args, (bytes, bytes[], uint256));
    }

    function _slice(bytes memory data, uint256 start, uint256 length) internal pure returns (bytes memory out) {
        out = new bytes(length);
        for (uint256 i = 0; i < length; ++i) {
            out[i] = data[start + i];
        }
    }
}
