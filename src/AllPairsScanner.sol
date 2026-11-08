// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {V4PoolMonitor} from "./V4PoolMonitor.sol";

/// @title AllPairsScanner
/// @notice Reference arithmetic for follow-up 6 of js/v4-arb-encoder.js: the all-pairs scanner's
///         V4 liquidity slot (getLiquidity(poolId) through extsload), the count and tagging of
///         pairwise spreads across pairs (same-pair executable, cross-pair "3-LEG" watch-only), the
///         30000/600 drained-tick filter, the gas estimate shown after a quote, the net after gas,
///         and the multi-tab lock's freshness rule.
/// @dev All functions are internal and pure: nothing is deployed, called or held.
library AllPairsScanner {
    /// @notice A protocol other than V3 or V4.
    error UnknownProtocol();
    /// @notice The two legs of an executable spread must be different pools of the same pair.
    error NotExecutable();

    enum Protocol {
        V3,
        V4
    }

    /// @notice How a spread row is shown: executable two-leg route, or a cross-pair hint.
    enum Legs {
        TwoLeg,
        ThreeLeg
    }

    /// @dev Pool.State layout in the PoolManager: slot0, feeGrowthGlobal0X128, feeGrowthGlobal1X128, liquidity.
    uint256 internal constant LIQUIDITY_OFFSET = 3;
    /// @dev A V4 pool whose latest tick is at or below this has been drained to its price floor (EMPTY).
    int24 internal constant DRAINED_TICK = -887000;
    int24 internal constant MIN_TICK = -887272;
    uint256 internal constant GAS_V3 = 250_000;
    uint256 internal constant GAS_V4 = 400_000;
    uint256 internal constant LOCK_TTL_SECONDS = 5 minutes;

    /// @notice The PoolManager storage slot of a pool's liquidity: the slot0 slot plus 3.
    function liquiditySlot(bytes32 id) internal pure returns (bytes32) {
        return bytes32(uint256(V4PoolMonitor.slot0Slot(id)) + LIQUIDITY_OFFSET);
    }

    /// @notice The low 128 bits of the liquidity word; a zero word means "no pool worth watching".
    function decodeLiquidity(bytes32 word) internal pure returns (uint128) {
        // casting is safe because the value is masked to 128 bits first
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint128(uint256(word) & type(uint128).max);
    }

    /// @notice The 30000/600 filter: a V4 pool at or below -887000 is drained. V3 pools are not filtered.
    function isDrained(Protocol protocol, int24 tick) internal pure returns (bool) {
        return protocol == Protocol.V4 && tick >= MIN_TICK && tick <= DRAINED_TICK;
    }

    /// @notice Number of pairwise combinations of n active pools: n(n-1)/2.
    function pairwiseCount(uint256 n) internal pure returns (uint256) {
        return n < 2 ? 0 : n * (n - 1) / 2;
    }

    /// @notice A pair key: the sorted currencies hashed, so two pools of the same pair share it.
    function pairKey(address currency0, address currency1) internal pure returns (bytes32) {
        (address c0, address c1) = V4PoolMonitor.sortPair(currency0, currency1);
        return keccak256(abi.encode(c0, c1));
    }

    /// @notice Same pair: executable two-leg route. Different Token B: 3-LEG, watch-only.
    function legs(bytes32 pairKeyA, bytes32 pairKeyB) internal pure returns (Legs) {
        return pairKeyA == pairKeyB ? Legs.TwoLeg : Legs.ThreeLeg;
    }

    /// @notice Only a two-leg spread of two different pools may be executed.
    function requireExecutable(bytes32 pairKeyA, bytes32 pairKeyB, bytes32 poolIdA, bytes32 poolIdB) internal pure {
        if (pairKeyA != pairKeyB || poolIdA == poolIdB) revert NotExecutable();
    }

    /// @notice Gas units of a route: 250K V3, 400K V4; a mixed route is two transactions and adds both.
    function gasUnits(Protocol buy, Protocol sell) internal pure returns (uint256) {
        uint256 a = buy == Protocol.V3 ? GAS_V3 : GAS_V4;
        uint256 b = sell == Protocol.V3 ? GAS_V3 : GAS_V4;
        return buy == sell ? a : a + b;
    }

    /// @notice Gas cost in wei at eth_gasPrice.
    function gasCostWei(Protocol buy, Protocol sell, uint256 gasPrice) internal pure returns (uint256) {
        return gasUnits(buy, sell) * gasPrice;
    }

    /// @notice Gas cost in dollars scaled by 1e6 (USDG decimals): wei * ethUsd6 / 1e18.
    function gasCostUsd6(uint256 costWei, uint256 ethUsd6) internal pure returns (uint256) {
        return costWei * ethUsd6 / 1e18;
    }

    /// @notice Expected return minus input (both in the input token's base units) minus gas, in the same
    ///         units; negative when gas or a losing quote eats the gain.
    function netAfterGas(uint256 amountIn, uint256 expectedReturn, uint256 gasCostInputUnits)
        internal
        pure
        returns (int256)
    {
        // casting is safe because token amounts fit uint128 and gas costs are far below 2^255
        // forge-lint: disable-next-line(unsafe-typecast)
        return int256(expectedReturn) - int256(amountIn) - int256(gasCostInputUnits);
    }

    /// @notice The multi-tab lock is active while its timestamp is younger than 5 minutes. A lock from the
    ///         future (clock skew) counts as active; a missing lock (0) never does.
    function lockActive(uint256 lockTimestamp, uint256 nowTimestamp) internal pure returns (bool) {
        if (lockTimestamp == 0) return false;
        if (lockTimestamp > nowTimestamp) return true;
        return nowTimestamp - lockTimestamp < LOCK_TTL_SECONDS;
    }
}
