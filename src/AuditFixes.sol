// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title AuditFixes
/// @notice Reference rules for job 8 of js/v4-arb-encoder.js and index.html (audit fixes, display,
///         Permit2, UX): the auto-mode return guard, the zero sell-quote floor, the REVOKE ALL target
///         matrix, the Worker's origin and method allow-lists, the 3-LEG indicator, the quote-line colour
///         and the Permit2 layer-1 readiness check. Each function is the JavaScript rule, stated once in
///         Solidity so the tests pin it independently of the page.
/// @dev All functions are internal and pure: nothing is deployed, called or held.
library AuditFixes {
    /// @notice Fix 1: auto mode may not send when the quoted return is at or below the input.
    error ReturnNotAboveInput(uint256 amountIn, uint256 expectedReturn);
    /// @notice Fix 2: the sell leg quoted 0; the route is invalid.
    error SellQuoteZero();
    /// @notice Fix 8: the asset token has no ERC20 allowance to Permit2 (layer 1).
    error Permit2LayerOneMissing(address token);
    /// @notice Fix 4: the Origin header is not a loopback origin.
    error ForbiddenOrigin();
    /// @notice Fix 4: the JSON-RPC method is not on the allow-list.
    error MethodNotAllowed();

    /// @notice Fix 7: the colour of the return value on the quote line.
    enum Color {
        Red,
        Green
    }

    /// @notice Fix 5: a 3-LEG row's indicator. Live = both pools exist and are tradeable.
    enum Indicator {
        Dark,
        Live
    }

    /// @dev Robinhood Chain (4663) deployments the page revokes allowances to (fix 3).
    address internal constant V3_ROUTER = 0xCaf681a66D020601342297493863E78C959E5cb2;
    address internal constant POOL_MANAGER = 0x8366a39CC670B4001A1121B8F6A443A643e40951;
    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    /// @dev Fix 3: spenders per token, tokens per REVOKE ALL and the resulting number of allowance reads.
    uint256 internal constant REVOKE_SPENDERS = 3;
    uint256 internal constant REVOKE_TOKENS = 2;
    /// @dev Fix 4: number of relayed JSON-RPC methods.
    uint256 internal constant ALLOWED_METHODS = 8;

    // ------------------------------------------------------------------ fix 1: auto-mode guard

    /// @notice True only when the quoted return is STRICTLY greater than a non-zero input.
    function autoSendAllowed(uint256 amountIn, uint256 expectedReturn) internal pure returns (bool) {
        return amountIn != 0 && expectedReturn > amountIn;
    }

    /// @notice Reverts with the ABORTED reason when auto mode must not send.
    function requireReturnAboveInput(uint256 amountIn, uint256 expectedReturn) internal pure {
        if (!autoSendAllowed(amountIn, expectedReturn)) revert ReturnNotAboveInput(amountIn, expectedReturn);
    }

    // ------------------------------------------------------------------ fix 2: sell-quote floor

    /// @notice A sell leg quoting 0 has no liquidity in its tick range: the route is invalid.
    function sellQuoteValid(uint256 sellQuote) internal pure returns (bool) {
        return sellQuote != 0;
    }

    /// @notice Reverts when the sell leg quoted 0.
    function requireSellQuote(uint256 sellQuote) internal pure {
        if (!sellQuoteValid(sellQuote)) revert SellQuoteZero();
    }

    /// @notice The V4/V4 default minimum return is 0: the sell quote, not a minimum, is the guard.
    function v4MinimumReturn(uint256 fieldValue) internal pure returns (uint256) {
        return fieldValue;
    }

    // ------------------------------------------------------------------ fix 7: quote-line colour

    /// @notice Green when the return beats the input, red at or below it.
    function returnColor(uint256 amountIn, uint256 expectedReturn) internal pure returns (Color) {
        return autoSendAllowed(amountIn, expectedReturn) ? Color.Green : Color.Red;
    }

    // ------------------------------------------------------------------ fix 5: 3-LEG indicator

    /// @notice A 3-LEG row is live when both pools exist and are tradeable; it never carries a percentage.
    function threeLegIndicator(bool buyTradeable, bool sellTradeable) internal pure returns (Indicator) {
        return buyTradeable && sellTradeable ? Indicator.Live : Indicator.Dark;
    }

    // ------------------------------------------------------------------ fix 3: REVOKE ALL matrix

    /// @notice The spenders REVOKE ALL zeroes for each token, in order: V3 Router, PoolManager, Permit2.
    function revokeSpenders() internal pure returns (address[3] memory spenders) {
        spenders = [V3_ROUTER, POOL_MANAGER, PERMIT2];
    }

    /// @notice The (token, spender) pairs of one REVOKE ALL over Token A and Token B: 2 × 3, Token A first.
    function revokeTargets(address tokenA, address tokenB)
        internal
        pure
        returns (address[6] memory tokens, address[6] memory spenders)
    {
        address[3] memory list = revokeSpenders();
        for (uint256 i = 0; i < REVOKE_SPENDERS; i++) {
            tokens[i] = tokenA;
            spenders[i] = list[i];
            tokens[i + REVOKE_SPENDERS] = tokenB;
            spenders[i + REVOKE_SPENDERS] = list[i];
        }
    }

    /// @notice An allowance already at 0 is skipped: no transaction is sent for it.
    function needsRevocation(uint256 allowance) internal pure returns (bool) {
        return allowance != 0;
    }

    /// @notice The number of transactions one REVOKE ALL sends for the six current allowances.
    function revocationCount(uint256[6] memory allowances) internal pure returns (uint256 count) {
        for (uint256 i = 0; i < allowances.length; i++) {
            if (needsRevocation(allowances[i])) count++;
        }
    }

    // ------------------------------------------------------------------ fix 8: Permit2 layer 1

    /// @notice Layer 1 is ready when the token's ERC20 allowance to Permit2 covers the amount.
    function permit2LayerOneReady(uint256 erc20AllowanceToPermit2, uint256 amount) internal pure returns (bool) {
        return erc20AllowanceToPermit2 >= amount && erc20AllowanceToPermit2 != 0;
    }

    /// @notice Reverts with the token when its layer-1 allowance is 0 (the clear message, not an opaque revert).
    function requirePermit2LayerOne(address token, uint256 erc20AllowanceToPermit2) internal pure {
        if (erc20AllowanceToPermit2 == 0) revert Permit2LayerOneMissing(token);
    }

    // ------------------------------------------------------------------ fix 4: Worker allow-lists

    /// @notice The eight relayed JSON-RPC methods; anything else is refused with 403.
    function methodAllowed(string memory method) internal pure returns (bool) {
        bytes32 hash = keccak256(bytes(method));
        return hash == keccak256("eth_call") || hash == keccak256("eth_blockNumber")
            || hash == keccak256("eth_getBalance") || hash == keccak256("eth_estimateGas")
            || hash == keccak256("eth_getTransactionReceipt") || hash == keccak256("eth_getTransactionByHash")
            || hash == keccak256("eth_chainId") || hash == keccak256("net_version");
    }

    /// @notice Reverts unless every method of a (batch) request is allowed.
    function requireMethodsAllowed(string[] memory methods) internal pure {
        for (uint256 i = 0; i < methods.length; i++) {
            if (!methodAllowed(methods[i])) revert MethodNotAllowed();
        }
    }

    /// @notice True for `http://` or `https://` + localhost | 127.0.0.1 | [::1] + an optional `:port` (1 to 65535),
    ///         and nothing else. Missing, "null", remote and look-alike origins are not loopback.
    function originIsLoopback(string memory origin) internal pure returns (bool) {
        bytes memory o = bytes(origin);
        uint256 hostStart;
        if (_startsWith(o, 0, "https://")) hostStart = 8;
        else if (_startsWith(o, 0, "http://")) hostStart = 7;
        else return false;
        uint256 hostEnd;
        if (_startsWith(o, hostStart, "localhost")) hostEnd = hostStart + 9;
        else if (_startsWith(o, hostStart, "127.0.0.1")) hostEnd = hostStart + 9;
        else if (_startsWith(o, hostStart, "[::1]")) hostEnd = hostStart + 5;
        else return false;
        if (hostEnd == o.length) return true;
        if (o[hostEnd] != ":") return false;
        uint256 digits = o.length - hostEnd - 1;
        if (digits == 0 || digits > 5) return false;
        uint256 port = 0;
        for (uint256 i = hostEnd + 1; i < o.length; i++) {
            bytes1 c = o[i];
            if (c < "0" || c > "9") return false;
            port = port * 10 + (uint8(c) - 48);
        }
        return port >= 1 && port <= 65535;
    }

    /// @notice Reverts unless the Origin is loopback.
    function requireLoopbackOrigin(string memory origin) internal pure {
        if (!originIsLoopback(origin)) revert ForbiddenOrigin();
    }

    /// @dev True when `data` has `prefix` at `offset`.
    function _startsWith(bytes memory data, uint256 offset, bytes memory prefix) private pure returns (bool) {
        if (data.length < offset + prefix.length) return false;
        for (uint256 i = 0; i < prefix.length; i++) {
            if (data[offset + i] != prefix[i]) return false;
        }
        return true;
    }
}
