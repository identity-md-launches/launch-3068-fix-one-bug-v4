// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IV3QuoteFactory {
    function getPool(address token0, address token1, uint24 fee) external view returns (address);
}

interface IV3QuotePool {
    function liquidity() external view returns (uint128);
    function swap(address recipient, bool zeroForOne, int256 amount, uint160 limit, bytes calldata data)
        external
        returns (int256, int256);
}

error V3QuoteResult(uint256 amountInUsed, uint256 amountOut);
error V3QuoteInvalidInput();
error V3QuoteUnexpectedReturn();

/// @dev Ephemeral callback receiver, created only inside the reverting eth_call below.
/// Never pays tokens, grants allowances, or retains funds. Reversion unwinds the pool's swap.
contract V3QuoteCallback {
    address private immutable caller;
    address private immutable pool;
    bool private immutable zeroForOne;

    constructor(address pool_, bool zeroForOne_) {
        if (pool_ == address(0)) revert V3QuoteInvalidInput();
        caller = msg.sender;
        pool = pool_;
        zeroForOne = zeroForOne_;
    }

    function quote(uint128 amount) external {
        if (msg.sender != caller || amount == 0) revert V3QuoteInvalidInput();
        IV3QuotePool(pool)
            .swap(
                address(this),
                zeroForOne,
                int256(uint256(amount)),
                zeroForOne ? 4295128740 : 1461446703485210103287273052203988822378723970341,
                ""
            );
        revert V3QuoteUnexpectedReturn();
    }

    function uniswapV3SwapCallback(int256 amount0, int256 amount1, bytes calldata) external view {
        if (msg.sender != pool) revert V3QuoteInvalidInput();
        int256 paid = zeroForOne ? amount0 : amount1;
        int256 received = zeroForOne ? amount1 : amount0;
        if (paid < 0 || received > 0 || received == type(int256).min) revert V3QuoteInvalidInput();
        revert V3QuoteResult(uint256(paid), uint256(-received));
    }
}

/// @notice Read-only creation-call quoter. ALWAYS reverts, including on a successful quote.
/// @dev Supply creation bytecode + constructor args to eth_call with no `to`. No deployment,
/// wallet, payer balance, router, external quoter address or state override is required.
contract V3Quote {
    address internal constant FACTORY = 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA;

    constructor(address tokenIn, address tokenOut, uint24 fee, uint128 amount) {
        if (tokenIn == address(0) || tokenOut == address(0) || tokenIn == tokenOut || amount == 0) {
            revert V3QuoteInvalidInput();
        }
        bool zeroForOne = tokenIn < tokenOut;
        address pool =
            IV3QuoteFactory(FACTORY).getPool(zeroForOne ? tokenIn : tokenOut, zeroForOne ? tokenOut : tokenIn, fee);
        if (pool == address(0)) revert V3QuoteInvalidInput();
        if (IV3QuotePool(pool).liquidity() == 0) revert V3QuoteResult(0, 0);
        new V3QuoteCallback(pool, zeroForOne).quote(amount);
        revert V3QuoteUnexpectedReturn();
    }
}
