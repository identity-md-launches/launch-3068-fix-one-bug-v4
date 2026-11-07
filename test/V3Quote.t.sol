// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Test} from "forge-std/Test.sol";
import {
    V3Quote,
    V3QuoteCallback,
    V3QuoteResult,
    V3QuoteInvalidInput,
    V3QuoteUnexpectedReturn
} from "../src/V3Quote.sol";

contract QuoteFactoryMock {
    mapping(bytes32 => address) private pools;

    function setPool(address a, address b, uint24 fee, address pool) external {
        pools[keccak256(abi.encode(a, b, fee))] = pool;
    }

    function getPool(address a, address b, uint24 fee) external view returns (address) {
        require(a < b, "factory tokens not sorted");
        return pools[keccak256(abi.encode(a, b, fee))];
    }
}

contract QuotePoolMock {
    uint128 public liquidity = 100;
    uint256 public swapCount;
    uint8 public mode;

    function configure(uint128 liquidity_, uint8 mode_) external {
        liquidity = liquidity_;
        mode = mode_;
    }

    function swap(address recipient, bool zeroForOne, int256 amount, uint160 limit, bytes calldata)
        external
        returns (int256, int256)
    {
        require(recipient == msg.sender, "wrong recipient");
        require(amount > 0, "not exact input");
        require(
            limit == (zeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341), "wrong price limit"
        );
        ++swapCount;
        if (mode == 1) revert("pool failure");
        if (mode == 2) return (amount, -amount);
        int256 received = mode == 3 ? int256(0) : amount * 2;
        int256 paid = mode == 4 ? amount / 2 : amount;
        V3QuoteCallback(msg.sender)
            .uniswapV3SwapCallback(zeroForOne ? paid : -received, zeroForOne ? -received : paid, "");
        revert("callback must revert");
    }
}

contract V3QuoteTest is Test {
    address internal constant FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;
    address internal constant PONS = 0x39dBED3a2bd333467115dE45665cC57F813C4571;
    address internal constant USDG = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    QuotePoolMock internal pool;

    function setUp() public {
        QuoteFactoryMock implementation = new QuoteFactoryMock();
        vm.etch(FACTORY, address(implementation).code);
        pool = new QuotePoolMock();
        QuoteFactoryMock(FACTORY).setPool(PONS, USDG, 3000, address(pool));
    }

    function testFuzz_QuoteUsesRealCallbackBothDirectionsAndRollsBack(uint128 input, bool zeroForOne) public {
        input = uint128(bound(input, 1, type(uint128).max));
        vm.expectRevert(abi.encodeWithSelector(V3QuoteResult.selector, uint256(input), uint256(input) * 2));
        new V3Quote(zeroForOne ? PONS : USDG, zeroForOne ? USDG : PONS, 3000, input);
        assertEq(pool.swapCount(), 0, "quote must not change pool state");
    }

    function test_ZeroLiquidityReturnsZeroWithoutAttemptingSwap() public {
        pool.configure(0, 1);
        vm.expectRevert(abi.encodeWithSelector(V3QuoteResult.selector, 0, 0));
        new V3Quote(USDG, PONS, 3000, 10000);
    }

    function test_ZeroOutputIsDistinctFromRpcFailure() public {
        pool.configure(100, 3);
        vm.expectRevert(abi.encodeWithSelector(V3QuoteResult.selector, 10000, 0));
        new V3Quote(USDG, PONS, 3000, 10000);
    }

    function test_PartialInputIsReportedForClientToReject() public {
        pool.configure(100, 4);
        vm.expectRevert(abi.encodeWithSelector(V3QuoteResult.selector, 5000, 20000));
        new V3Quote(USDG, PONS, 3000, 10000);
    }

    function test_PoolFailureBubblesWithoutFakeQuote() public {
        pool.configure(100, 1);
        vm.expectRevert("pool failure");
        new V3Quote(USDG, PONS, 3000, 10000);
    }

    function test_UnexpectedSuccessfulSwapIsRejected() public {
        pool.configure(100, 2);
        vm.expectRevert(V3QuoteUnexpectedReturn.selector);
        new V3Quote(USDG, PONS, 3000, 10000);
        assertEq(pool.swapCount(), 0);
    }

    function test_MissingPoolAndInvalidInputsRevert() public {
        vm.expectRevert(V3QuoteInvalidInput.selector);
        new V3Quote(USDG, PONS, 500, 10000);
        vm.expectRevert(V3QuoteInvalidInput.selector);
        new V3Quote(PONS, PONS, 3000, 10000);
        vm.expectRevert(V3QuoteInvalidInput.selector);
        new V3Quote(address(0), PONS, 3000, 10000);
        vm.expectRevert(V3QuoteInvalidInput.selector);
        new V3Quote(USDG, PONS, 3000, 0);
    }

    function test_CallbackAuthenticatesPoolAndQuoteCaller() public {
        V3QuoteCallback callback = new V3QuoteCallback(address(pool), true);
        vm.expectRevert(V3QuoteInvalidInput.selector);
        callback.uniswapV3SwapCallback(100, -200, "");
        vm.prank(address(pool));
        vm.expectRevert(V3QuoteInvalidInput.selector);
        callback.quote(100);
        vm.expectRevert(V3QuoteInvalidInput.selector);
        callback.quote(0);
    }

    function test_CallbackRejectsInvalidDeltaSignsAndOverflow() public {
        V3QuoteCallback callback = new V3QuoteCallback(address(pool), true);
        vm.startPrank(address(pool));
        vm.expectRevert(V3QuoteInvalidInput.selector);
        callback.uniswapV3SwapCallback(-1, -2, "");
        vm.expectRevert(V3QuoteInvalidInput.selector);
        callback.uniswapV3SwapCallback(1, 2, "");
        vm.expectRevert(V3QuoteInvalidInput.selector);
        callback.uniswapV3SwapCallback(1, type(int256).min, "");
        vm.stopPrank();
    }
}
