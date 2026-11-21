// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// Frozen external interface of a Hurdle curator vault (one vault per curator per pool).
/// NAV and bond are denominated in token1. All valuation uses the hook's TWAP price.
interface IHurdleVault {
    event Deposited(address indexed owner, uint256 amount0, uint256 amount1, uint256 shares);
    event Withdrawn(address indexed owner, uint256 shares, uint256 amount0, uint256 amount1);
    event BondPosted(uint256 amount, uint256 bond);
    event Rebalanced(int24 tickLower, int24 tickUpper, uint128 liquidity);
    /// nav = what the curator produced (before any shortfall payment); bench = par; both token1 at TWAP.
    /// take = bond refill + carry (curator gain); shortfallPaid = value delivered to depositors; bond = bondValue().
    event Settled(uint256 nav, uint256 bench, uint256 take, uint256 shortfallPaid, uint256 bond, uint160 sqrtPriceX96);
    event Fired(uint256 bond, uint256 nav);
    /// A third party called settle() on schedule and received `shares` of the curator's carry.
    event SettlerPaid(address indexed settler, uint256 shares);
    event BondReclaimed(uint256 bondTokens, uint256 bondShares);

    error NotCurator();
    error CuratorFired();
    error ZeroShares();

    /// First deposit only, curator-only, shares to `receiver` (TWAP-valued, idle).
    function firstDeposit(uint256 amount0, uint256 amount1, address receiver) external returns (uint256 shares);
    /// In kind, within DEPOSIT_WINDOW of an epoch settlement: pays what withdraw(shares) would pay, rounded up.
    function deposit(uint256 shares, uint256 max0, uint256 max1) external returns (uint256 amount0, uint256 amount1);
    function withdraw(uint256 shares) external returns (uint256 amount0, uint256 amount1);
    function postBond(uint256 amount1) external;
    function rebalance(int24 tickLower, int24 tickUpper) external;
    /// Reverts if more than maxIdleBps of NAV is left outside the position.
    function rebalance(int24 tickLower, int24 tickUpper, uint16 maxIdleBps) external;
    function settle() external;
    /// Fired and parked, one epoch after firing: the curator takes back what is left of its bond.
    function reclaimBond() external;
    function previewDeposit(uint256 shares) external view returns (uint256 amount0, uint256 amount1);
    function previewWithdraw(uint256 shares) external view returns (uint256 amount0, uint256 amount1);

    function curator() external view returns (address);
    function fired() external view returns (bool);
    function bond() external view returns (uint256);
    function totalSupply() external view returns (uint256);
    function balanceOf(address) external view returns (uint256);
    function position() external view returns (int24 tickLower, int24 tickUpper, uint128 liquidity);
}
