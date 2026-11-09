// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {AuditFixes} from "../src/AuditFixes.sol";

contract AuditFixesHarness {
    function requireReturnAboveInput(uint256 amountIn, uint256 expectedReturn) external pure {
        AuditFixes.requireReturnAboveInput(amountIn, expectedReturn);
    }

    function requireSellQuote(uint256 sellQuote) external pure {
        AuditFixes.requireSellQuote(sellQuote);
    }

    function requirePermit2LayerOne(address token, uint256 allowance) external pure {
        AuditFixes.requirePermit2LayerOne(token, allowance);
    }

    function requireMethodsAllowed(string[] memory methods) external pure {
        AuditFixes.requireMethodsAllowed(methods);
    }

    function requireLoopbackOrigin(string memory origin) external pure {
        AuditFixes.requireLoopbackOrigin(origin);
    }
}

contract AuditFixesTest is Test {
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    address internal constant PONS = 0x39dBED3a2bd333467115dE45665cC57F813C4571;
    uint256 internal constant INPUT = 10_000; // 0.01 USDG, the page's default test size (6 decimals)
    uint256 internal constant TINY = 1_000; // $0.001 USDG, the brief's test size

    AuditFixesHarness internal harness;

    function setUp() public {
        harness = new AuditFixesHarness();
    }

    // ------------------------------------------------------------------ fix 1: auto-mode guard

    function test_AutoSendAllowedOnlyStrictlyAboveInput() public pure {
        assertTrue(AuditFixes.autoSendAllowed(INPUT, INPUT + 1));
        assertTrue(AuditFixes.autoSendAllowed(TINY, TINY + 1), "the $0.001 size obeys the same rule");
        assertFalse(AuditFixes.autoSendAllowed(INPUT, INPUT), "equal is not a profit");
        assertFalse(AuditFixes.autoSendAllowed(INPUT, INPUT - 1));
        assertFalse(AuditFixes.autoSendAllowed(INPUT, 0));
        assertFalse(AuditFixes.autoSendAllowed(0, 1), "a zero input never trades");
        assertFalse(AuditFixes.autoSendAllowed(0, 0));
    }

    function test_RequireReturnAboveInputPasses() public view {
        harness.requireReturnAboveInput(INPUT, INPUT + 1);
        harness.requireReturnAboveInput(TINY, type(uint128).max);
    }

    function test_RevertWhen_ReturnEqualsInput() public {
        vm.expectRevert(abi.encodeWithSelector(AuditFixes.ReturnNotAboveInput.selector, INPUT, INPUT));
        harness.requireReturnAboveInput(INPUT, INPUT);
    }

    function test_RevertWhen_ReturnBelowInput() public {
        vm.expectRevert(abi.encodeWithSelector(AuditFixes.ReturnNotAboveInput.selector, INPUT, 5_209));
        harness.requireReturnAboveInput(INPUT, 5_209);
    }

    function test_RevertWhen_ReturnIsZero() public {
        vm.expectRevert(abi.encodeWithSelector(AuditFixes.ReturnNotAboveInput.selector, TINY, 0));
        harness.requireReturnAboveInput(TINY, 0);
    }

    function testFuzz_AutoSendAllowedIsStrictGreaterThan(uint128 amountIn, uint128 expectedReturn) public pure {
        bool allowed = AuditFixes.autoSendAllowed(amountIn, expectedReturn);
        assertEq(allowed, amountIn != 0 && expectedReturn > amountIn);
        if (allowed) assertGt(expectedReturn, amountIn);
    }

    function testFuzz_ReturnAtOrBelowInputAlwaysReverts(uint128 amountIn, uint128 expectedReturn) public {
        vm.assume(expectedReturn <= amountIn);
        vm.expectRevert(
            abi.encodeWithSelector(AuditFixes.ReturnNotAboveInput.selector, uint256(amountIn), uint256(expectedReturn))
        );
        harness.requireReturnAboveInput(amountIn, expectedReturn);
    }

    // ------------------------------------------------------------------ fix 2: sell-quote floor

    function test_SellQuoteValidRejectsZero() public pure {
        assertTrue(AuditFixes.sellQuoteValid(1));
        assertTrue(AuditFixes.sellQuoteValid(type(uint128).max));
        assertFalse(AuditFixes.sellQuoteValid(0));
    }

    function test_RequireSellQuotePassesForAnyPositiveQuote() public view {
        harness.requireSellQuote(1);
        harness.requireSellQuote(INPUT);
    }

    function test_RevertWhen_SellQuoteIsZero() public {
        vm.expectRevert(AuditFixes.SellQuoteZero.selector);
        harness.requireSellQuote(0);
    }

    function test_V4MinimumReturnDefaultsToTheFieldValueZero() public pure {
        assertEq(AuditFixes.v4MinimumReturn(0), 0, "default min value is 0");
        assertEq(AuditFixes.v4MinimumReturn(INPUT), INPUT, "a user-set minimum is kept as entered");
    }

    function testFuzz_SellQuoteValidIsNonZero(uint128 quote) public pure {
        assertEq(AuditFixes.sellQuoteValid(quote), quote != 0);
    }

    // ------------------------------------------------------------------ fix 7: quote-line colour

    function test_ReturnColorGreenAboveRedAtOrBelow() public pure {
        assertEq(uint8(AuditFixes.returnColor(INPUT, INPUT + 1)), uint8(AuditFixes.Color.Green));
        assertEq(uint8(AuditFixes.returnColor(INPUT, INPUT)), uint8(AuditFixes.Color.Red));
        assertEq(uint8(AuditFixes.returnColor(INPUT, 0)), uint8(AuditFixes.Color.Red));
        assertEq(uint8(AuditFixes.returnColor(TINY, 2 * TINY)), uint8(AuditFixes.Color.Green));
    }

    function testFuzz_ReturnColorMatchesTheAutoGuard(uint128 amountIn, uint128 expectedReturn) public pure {
        bool green = AuditFixes.returnColor(amountIn, expectedReturn) == AuditFixes.Color.Green;
        assertEq(green, AuditFixes.autoSendAllowed(amountIn, expectedReturn), "same rule, two uses");
    }

    // ------------------------------------------------------------------ fix 5: 3-LEG indicator

    function test_ThreeLegIndicatorLiveOnlyWhenBothPoolsTradeable() public pure {
        assertEq(uint8(AuditFixes.threeLegIndicator(true, true)), uint8(AuditFixes.Indicator.Live));
        assertEq(uint8(AuditFixes.threeLegIndicator(true, false)), uint8(AuditFixes.Indicator.Dark));
        assertEq(uint8(AuditFixes.threeLegIndicator(false, true)), uint8(AuditFixes.Indicator.Dark));
        assertEq(uint8(AuditFixes.threeLegIndicator(false, false)), uint8(AuditFixes.Indicator.Dark));
    }

    // ------------------------------------------------------------------ fix 3: REVOKE ALL matrix

    function test_RevokeSpendersAreV3RouterPoolManagerPermit2InOrder() public pure {
        address[3] memory spenders = AuditFixes.revokeSpenders();
        assertEq(spenders[0], 0xCaf681a66D020601342297493863E78C959E5cb2, "SwapRouter02");
        assertEq(spenders[1], 0x8366a39CC670B4001A1121B8F6A443A643e40951, "PoolManager");
        assertEq(spenders[2], 0x000000000022D473030F116dDEE9F6B43aC78BA3, "Permit2");
        assertEq(AuditFixes.REVOKE_SPENDERS, 3);
        assertEq(AuditFixes.REVOKE_TOKENS, 2);
    }

    function test_RevokeTargetsCoverBothTokensTokenAFirst() public pure {
        (address[6] memory tokens, address[6] memory spenders) = AuditFixes.revokeTargets(PONS, USDG);
        address[3] memory list = AuditFixes.revokeSpenders();
        for (uint256 i = 0; i < 3; i++) {
            assertEq(tokens[i], PONS, "Token A first");
            assertEq(tokens[i + 3], USDG, "then Token B");
            assertEq(spenders[i], list[i]);
            assertEq(spenders[i + 3], list[i]);
        }
    }

    function test_RevocationCountSkipsZeroAllowances() public pure {
        uint256[6] memory none;
        assertEq(AuditFixes.revocationCount(none), 0, "nothing to revoke");
        uint256[6] memory some = [uint256(12_345), 77, 1, 0, 0, 0];
        assertEq(AuditFixes.revocationCount(some), 3, "USDG's three allowances; PONS has none");
        uint256[6] memory all = [uint256(1), 1, 1, 1, 1, 1];
        assertEq(AuditFixes.revocationCount(all), 6);
        assertTrue(AuditFixes.needsRevocation(1));
        assertFalse(AuditFixes.needsRevocation(0));
    }

    function testFuzz_RevocationCountIsTheNumberOfNonZeroAllowances(uint256[6] memory allowances) public pure {
        uint256 expected;
        for (uint256 i = 0; i < 6; i++) {
            if (allowances[i] != 0) expected++;
        }
        assertEq(AuditFixes.revocationCount(allowances), expected);
        assertLe(AuditFixes.revocationCount(allowances), AuditFixes.REVOKE_SPENDERS * AuditFixes.REVOKE_TOKENS);
    }

    // ------------------------------------------------------------------ fix 8: Permit2 layer 1

    function test_Permit2LayerOneReadyNeedsANonZeroCoveringAllowance() public pure {
        assertTrue(AuditFixes.permit2LayerOneReady(INPUT, INPUT));
        assertTrue(AuditFixes.permit2LayerOneReady(type(uint256).max, INPUT));
        assertFalse(AuditFixes.permit2LayerOneReady(INPUT - 1, INPUT), "too low");
        assertFalse(AuditFixes.permit2LayerOneReady(0, INPUT), "missing");
        assertFalse(AuditFixes.permit2LayerOneReady(0, 0), "an allowance of 0 is never ready");
    }

    function test_RequirePermit2LayerOnePassesWithAnyAllowance() public view {
        harness.requirePermit2LayerOne(USDG, 1);
        harness.requirePermit2LayerOne(PONS, type(uint256).max);
    }

    function test_RevertWhen_Permit2LayerOneIsZero() public {
        vm.expectRevert(abi.encodeWithSelector(AuditFixes.Permit2LayerOneMissing.selector, USDG));
        harness.requirePermit2LayerOne(USDG, 0);
        vm.expectRevert(abi.encodeWithSelector(AuditFixes.Permit2LayerOneMissing.selector, PONS));
        harness.requirePermit2LayerOne(PONS, 0);
    }

    // ------------------------------------------------------------------ fix 4: Worker allow-lists

    function test_MethodAllowListIsExactlyTheBriefsEight() public pure {
        string[8] memory allowed = [
            "eth_call",
            "eth_blockNumber",
            "eth_getBalance",
            "eth_estimateGas",
            "eth_getTransactionReceipt",
            "eth_getTransactionByHash",
            "eth_chainId",
            "net_version"
        ];
        for (uint256 i = 0; i < allowed.length; i++) {
            assertTrue(AuditFixes.methodAllowed(allowed[i]), allowed[i]);
        }
        assertEq(allowed.length, AuditFixes.ALLOWED_METHODS);
        string[12] memory refused = [
            "eth_sendTransaction",
            "eth_sendRawTransaction",
            "eth_sign",
            "personal_sign",
            "eth_getLogs",
            "eth_getBlockByNumber",
            "eth_gasPrice",
            "eth_getCode",
            "ETH_CALL",
            "eth_call ",
            "",
            "debug_traceTransaction"
        ];
        for (uint256 i = 0; i < refused.length; i++) {
            assertFalse(AuditFixes.methodAllowed(refused[i]), refused[i]);
        }
    }

    function test_RequireMethodsAllowedPassesForAnAllowedBatch() public view {
        string[] memory methods = new string[](3);
        methods[0] = "eth_chainId";
        methods[1] = "eth_call";
        methods[2] = "eth_getTransactionReceipt";
        harness.requireMethodsAllowed(methods);
        harness.requireMethodsAllowed(new string[](0));
    }

    function test_RevertWhen_AnyMethodOfABatchIsNotAllowed() public {
        string[] memory methods = new string[](2);
        methods[0] = "eth_chainId";
        methods[1] = "eth_sendRawTransaction";
        vm.expectRevert(AuditFixes.MethodNotAllowed.selector);
        harness.requireMethodsAllowed(methods);
    }

    function test_LoopbackOrigins() public pure {
        assertTrue(AuditFixes.originIsLoopback("http://localhost"));
        assertTrue(AuditFixes.originIsLoopback("http://localhost:3000"));
        assertTrue(AuditFixes.originIsLoopback("https://localhost:8443"));
        assertTrue(AuditFixes.originIsLoopback("http://127.0.0.1"));
        assertTrue(AuditFixes.originIsLoopback("http://127.0.0.1:8000"));
        assertTrue(AuditFixes.originIsLoopback("http://[::1]:5173"));
        assertTrue(AuditFixes.originIsLoopback("https://[::1]"));
        assertTrue(AuditFixes.originIsLoopback("http://localhost:65535"));
        assertTrue(AuditFixes.originIsLoopback("http://localhost:1"));
    }

    function test_NonLoopbackOrigins() public pure {
        assertFalse(AuditFixes.originIsLoopback("https://evil.example"));
        assertFalse(AuditFixes.originIsLoopback("http://localhost.evil.example"));
        assertFalse(AuditFixes.originIsLoopback("http://127.0.0.1.evil.example:80"));
        assertFalse(AuditFixes.originIsLoopback("http://localhost@evil.example"));
        assertFalse(AuditFixes.originIsLoopback("http://localhost/"));
        assertFalse(AuditFixes.originIsLoopback("http://localhost:"));
        assertFalse(AuditFixes.originIsLoopback("http://localhost:0"));
        assertFalse(AuditFixes.originIsLoopback("http://localhost:99999"));
        assertFalse(AuditFixes.originIsLoopback("http://localhost:65536"));
        assertFalse(AuditFixes.originIsLoopback("http://localhost:80a"));
        assertFalse(AuditFixes.originIsLoopback("ftp://localhost"));
        assertFalse(AuditFixes.originIsLoopback("localhost"));
        assertFalse(AuditFixes.originIsLoopback("null"));
        assertFalse(AuditFixes.originIsLoopback(""));
        assertFalse(AuditFixes.originIsLoopback("http://10.0.0.5"));
        assertFalse(AuditFixes.originIsLoopback("http://192.168.1.2:8080"));
        assertFalse(AuditFixes.originIsLoopback("http://[::2]"));
        assertFalse(AuditFixes.originIsLoopback("HTTP://LOCALHOST"), "case is significant, as in the Worker");
    }

    function test_RequireLoopbackOriginPasses() public view {
        harness.requireLoopbackOrigin("http://localhost:8080");
    }

    function test_RevertWhen_OriginIsRemote() public {
        vm.expectRevert(AuditFixes.ForbiddenOrigin.selector);
        harness.requireLoopbackOrigin("https://evil.example");
    }

    function test_RevertWhen_OriginIsMissing() public {
        vm.expectRevert(AuditFixes.ForbiddenOrigin.selector);
        harness.requireLoopbackOrigin("");
    }

    function testFuzz_LoopbackPortRangeIsOneToSixtyFiveThousand(uint32 port) public pure {
        string memory origin = string.concat("http://localhost:", vm.toString(uint256(port)));
        assertEq(AuditFixes.originIsLoopback(origin), port >= 1 && port <= 65535);
    }

    function testFuzz_ArbitraryHostsAreNotLoopback(address host) public pure {
        // A hex address text is never one of the three loopback hosts.
        string memory origin = string.concat("http://", vm.toString(host));
        assertFalse(AuditFixes.originIsLoopback(origin));
    }
}
