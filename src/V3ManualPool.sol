// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title V3ManualPool
/// @notice Reference for the page's Manual mode (follow-up 5): two pasted Uniswap V3 pool
///         addresses are read with plain eth_call only (token0, token1, fee, slot0), validated as
///         the brief lists (same pair in the same order, sqrtPriceX96 above zero, distinct pools),
///         and ordered so the lower-priced pool buys. js/v4-arb-encoder.js implements the same
///         checks off chain; this library pins them in Solidity so forge tests cover success and
///         every failure path against real pool-shaped contracts.
/// @dev Internal functions only: nothing is deployed, owned or holds funds. `read` is `view` and
///      uses staticcall, so it can never move value. Prices are compared by tick: a higher tick is
///      a higher token1-per-token0 price, exactly as 1.0001^tick is monotonic.
library V3ManualPool {
    /// @notice token0(), token1(), fee() or slot0() reverted, returned nothing, or returned a value
    ///         no V3 pool can have (unsorted or zero tokens, fee above 100%).
    error InvalidPool(address pool);
    /// @notice The two pools do not share token0 and token1.
    error DifferentPairs();
    /// @notice A pool's slot0 sqrtPriceX96 is zero: not initialised, nothing to trade.
    error NoLiquidity(address pool);
    /// @notice The same pool was pasted twice.
    error SamePool();
    /// @notice A slot0 reply shorter than the two words the page needs.
    error MalformedSlot0();

    /// @notice What the page reads from one pool.
    struct Reading {
        address pool;
        address token0;
        address token1;
        uint24 fee;
        uint160 sqrtPriceX96;
        int24 tick;
    }

    bytes4 internal constant TOKEN0_SELECTOR = 0x0dfe1681; // token0()
    bytes4 internal constant TOKEN1_SELECTOR = 0xd21220a7; // token1()
    bytes4 internal constant FEE_SELECTOR = 0xddca3f43; // fee()
    bytes4 internal constant SLOT0_SELECTOR = 0x3850c7bd; // slot0()
    /// @dev Reads per pool per poll; two pools make eight eth_calls, never a batch or a log query.
    uint256 internal constant READS_PER_POOL = 4;
    /// @dev Fees are in hundredths of a basis point: 1_000_000 is 100%.
    uint24 internal constant MAX_FEE = 1_000_000;
    int24 internal constant MIN_TICK = -887272;
    int24 internal constant MAX_TICK = 887272;
    /// @dev "0x" + 40 hex digits.
    uint256 internal constant ADDRESS_TEXT_LENGTH = 42;

    /// @notice sqrtPriceX96 and tick from a slot0 reply. Accepts the canonical seven-word V3 layout
    ///         and the six-word layout the brief declares: both start with these two words.
    function decodeSlot0(bytes memory reply) internal pure returns (uint160 sqrtPriceX96, int24 tick) {
        if (reply.length < 64) revert MalformedSlot0();
        (uint256 price, int256 rawTick) = abi.decode(reply, (uint256, int256));
        if (price > type(uint160).max || rawTick < MIN_TICK || rawTick > MAX_TICK) revert MalformedSlot0();
        return (uint160(price), int24(rawTick));
    }

    /// @dev One staticcall; any failure or empty reply is the brief's "Invalid pool address".
    function staticRead(address pool, bytes4 selector) private view returns (bytes memory reply) {
        bool ok;
        // slither-disable-next-line low-level-calls
        (ok, reply) = pool.staticcall(abi.encodeWithSelector(selector));
        if (!ok || reply.length == 0) revert InvalidPool(pool);
    }

    /// @notice Read token0, token1, fee and slot0 from a pool with four staticcalls, as the page
    ///         does with four eth_calls. Reverts InvalidPool when any read fails or the values
    ///         cannot belong to a V3 pool.
    function read(address pool) internal view returns (Reading memory reading) {
        if (pool == address(0) || pool.code.length == 0) revert InvalidPool(pool);
        reading.pool = pool;
        bytes memory reply = staticRead(pool, TOKEN0_SELECTOR);
        if (reply.length != 32) revert InvalidPool(pool);
        reading.token0 = abi.decode(reply, (address));
        reply = staticRead(pool, TOKEN1_SELECTOR);
        if (reply.length != 32) revert InvalidPool(pool);
        reading.token1 = abi.decode(reply, (address));
        reply = staticRead(pool, FEE_SELECTOR);
        if (reply.length != 32) revert InvalidPool(pool);
        uint256 fee = abi.decode(reply, (uint256));
        if (fee > MAX_FEE) revert InvalidPool(pool);
        reading.fee = uint24(fee);
        reply = staticRead(pool, SLOT0_SELECTOR);
        if (reply.length < 64) revert InvalidPool(pool);
        (reading.sqrtPriceX96, reading.tick) = decodeSlot0(reply);
        if (reading.token0 == address(0) || reading.token0 >= reading.token1) revert InvalidPool(pool);
    }

    /// @notice The brief's checks in its order: same pair (same token0 and token1), both with
    ///         sqrtPriceX96 above zero, and not the same pool twice. Returns the pools as
    ///         (buy, sell): the lower tick, hence the lower price, buys.
    function validate(Reading memory a, Reading memory b)
        internal
        pure
        returns (Reading memory buy, Reading memory sell)
    {
        if (a.token0 != b.token0 || a.token1 != b.token1) revert DifferentPairs();
        if (a.sqrtPriceX96 == 0) revert NoLiquidity(a.pool);
        if (b.sqrtPriceX96 == 0) revert NoLiquidity(b.pool);
        if (a.pool == b.pool) revert SamePool();
        return a.tick <= b.tick ? (a, b) : (b, a);
    }

    /// @notice Fee Cost in basis points: (feeA + feeB) / 100, since fees are hundredths of a basis
    ///         point. The page shows it as a percent, (feeA + feeB) / 10000.
    function feeCostBps(uint24 feeA, uint24 feeB) internal pure returns (uint256) {
        return (uint256(feeA) + uint256(feeB)) / 100;
    }

    /// @notice Whether pasted text has the shape of a V3 pool address: "0x" and 40 hex digits,
    ///         42 characters in all. A 66-character V4 poolId fails this, as the brief requires.
    function isPoolAddressText(bytes memory text) internal pure returns (bool) {
        if (text.length != ADDRESS_TEXT_LENGTH || text[0] != "0" || (text[1] != "x" && text[1] != "X")) return false;
        for (uint256 i = 2; i < ADDRESS_TEXT_LENGTH; ++i) {
            bytes1 c = text[i];
            bool digit = c >= "0" && c <= "9";
            bool lowerHex = c >= "a" && c <= "f";
            bool upperHex = c >= "A" && c <= "F";
            if (!digit && !lowerHex && !upperHex) return false;
        }
        return true;
    }
}
