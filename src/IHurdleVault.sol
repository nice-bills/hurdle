// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// Frozen external interface of a Hurdle curator vault (one vault per curator per pool).
/// NAV and bond are denominated in token1. All valuation uses the hook's TWAP price.
interface IHurdleVault {
    event Deposited(address indexed owner, uint256 amount0, uint256 amount1, uint256 shares);
    event Withdrawn(address indexed owner, uint256 shares, uint256 amount0, uint256 amount1);
    event BondPosted(uint256 amount, uint256 bond);
    event Rebalanced(int24 tickLower, int24 tickUpper, uint128 liquidity);
    /// nav and bench are token1 values at the settlement TWAP. carry > 0 xor shortfallPaid > 0 (or both 0).
    event Settled(uint256 nav, uint256 bench, uint256 carry, uint256 shortfallPaid, uint256 bond, uint160 sqrtPriceX96);
    event Fired(uint256 bond, uint256 nav);

    error NotCurator();
    error CuratorFired();
    error ZeroShares();

    function deposit(uint256 amount0, uint256 amount1) external returns (uint256 shares);
    function withdraw(uint256 shares) external returns (uint256 amount0, uint256 amount1);
    function postBond(uint256 amount1) external;
    function rebalance(int24 tickLower, int24 tickUpper) external;
    function settle() external;

    function curator() external view returns (address);
    function fired() external view returns (bool);
    function bond() external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function position() external view returns (int24 tickLower, int24 tickUpper, uint128 liquidity);
}
