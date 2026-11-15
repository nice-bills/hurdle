// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IERC20Minimal} from "v4-core/src/interfaces/external/IERC20Minimal.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {LiquidityAmounts} from "v4-core/test/utils/LiquidityAmounts.sol";
import {IHurdleVault} from "./IHurdleVault.sol";

interface IHurdleOracle {
    function twapTick(PoolId id) external view returns (int24);
}

/// A curator vault settled against the passive full-range benchmark ("par").
/// Each settlement: par = navStart/(2 s0) * (2 s1 + dfg0*P1 + dfg1), all at the hook's TWAP price.
/// Beat par: the curator gets `carryBps` of the excess as new shares. Miss par: the bond pays the
/// shortfall into the vault. Bond below `minBondBps` of NAV: the curator is fired and anyone can
/// park the vault in a full-range position.
contract HurdleVault is IHurdleVault, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    uint256 private constant Q96 = 1 << 96;
    uint256 private constant Q128 = 1 << 128;
    bytes32 private constant SALT = bytes32(0);

    IPoolManager public immutable manager;
    IHurdleOracle public immutable oracle;
    address public immutable curator;
    uint16 public immutable carryBps;
    uint16 public immutable minBondBps;
    /// Max |spot - TWAP| in ticks for operations that price or mint at spot.
    int24 public immutable maxTickDeviation;
    IERC20Minimal public immutable token0;
    IERC20Minimal public immutable token1;

    PoolKey public poolKey;
    PoolId public immutable poolId;

    bool public fired;
    uint256 public bond;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    int24 private _tickLower;
    int24 private _tickUpper;
    uint128 private _liquidity;

    /// Benchmark start point, reset at every settlement.
    struct Start {
        uint64 timestamp;
        uint160 sqrtPriceX96;
        uint256 feeGrowth0X128;
        uint256 feeGrowth1X128;
        uint256 nav;
    }

    Start public start;

    error PriceDeviation();

    constructor(
        IPoolManager _manager,
        PoolKey memory _key,
        address _curator,
        uint16 _carryBps,
        uint16 _minBondBps,
        int24 _maxTickDeviation
    ) {
        manager = _manager;
        oracle = IHurdleOracle(address(_key.hooks));
        poolKey = _key;
        poolId = _key.toId();
        curator = _curator;
        carryBps = _carryBps;
        minBondBps = _minBondBps;
        maxTickDeviation = _maxTickDeviation;
        token0 = IERC20Minimal(Currency.unwrap(_key.currency0));
        token1 = IERC20Minimal(Currency.unwrap(_key.currency1));
    }

    // ---------------------------------------------------------------------
    // Depositors
    // ---------------------------------------------------------------------

    function deposit(uint256 amount0, uint256 amount1) external returns (uint256 shares) {
        _settle();
        uint160 sqrtP = _checkedTwapSqrtPrice();
        uint256 value = _value(amount0, amount1, sqrtP);
        shares = totalSupply == 0 ? value : FullMath.mulDiv(value, totalSupply, start.nav);
        if (shares == 0) revert ZeroShares();

        if (amount0 > 0) require(token0.transferFrom(msg.sender, address(this), amount0), "T0");
        if (amount1 > 0) require(token1.transferFrom(msg.sender, address(this), amount1), "T1");
        balanceOf[msg.sender] += shares;
        totalSupply += shares;
        start.nav += value;
        emit Deposited(msg.sender, amount0, amount1, shares);
    }

    /// Pro-rata in kind: no pricing, so no price check is needed.
    function withdraw(uint256 shares) external returns (uint256 amount0, uint256 amount1) {
        if (shares == 0) revert ZeroShares();
        _settle();
        uint256 supply = totalSupply;
        balanceOf[msg.sender] -= shares;

        amount0 = FullMath.mulDiv(token0.balanceOf(address(this)), shares, supply);
        amount1 = FullMath.mulDiv(_idle1(), shares, supply);
        uint128 liq = uint128(FullMath.mulDiv(_liquidity, shares, supply));
        if (liq > 0) {
            (int256 d0, int256 d1) = _modify(_tickLower, _tickUpper, -int256(uint256(liq)));
            _liquidity -= liq;
            amount0 += uint256(d0);
            amount1 += uint256(d1);
        }

        start.nav = FullMath.mulDiv(start.nav, supply - shares, supply);
        totalSupply = supply - shares;
        if (amount0 > 0) require(token0.transfer(msg.sender, amount0), "T0");
        if (amount1 > 0) require(token1.transfer(msg.sender, amount1), "T1");
        emit Withdrawn(msg.sender, shares, amount0, amount1);
    }

    // ---------------------------------------------------------------------
    // Curator
    // ---------------------------------------------------------------------

    function postBond(uint256 amount1) external {
        if (msg.sender != curator) revert NotCurator();
        if (fired) revert CuratorFired();
        require(token1.transferFrom(msg.sender, address(this), amount1), "T1");
        bond += amount1;
        emit BondPosted(amount1, bond);
    }

    /// Move all liquidity to [tickLower, tickUpper] using idle balances, no swaps.
    /// After firing, anyone may call it and the range is forced to full range.
    function rebalance(int24 tickLower, int24 tickUpper) external {
        if (fired) {
            tickLower = TickMath.minUsableTick(poolKey.tickSpacing);
            tickUpper = TickMath.maxUsableTick(poolKey.tickSpacing);
        } else if (msg.sender != curator) {
            revert NotCurator();
        }
        _checkedTwapSqrtPrice();
        _redeploy(tickLower, tickUpper);
    }

    // ---------------------------------------------------------------------
    // Settlement
    // ---------------------------------------------------------------------

    function settle() external {
        _settle();
    }

    function _settle() private {
        Start memory s = start;
        uint160 s1 = _twapSqrtPrice();
        (uint256 fg0, uint256 fg1) = manager.getFeeGrowthGlobals(poolId);

        if (totalSupply == 0 || s.timestamp == block.timestamp) {
            if (totalSupply == 0) _resetStart(s1, fg0, fg1, 0);
            return;
        }

        // Realize fees into idle balances so NAV = idle + principal at TWAP.
        if (_liquidity > 0) _modify(_tickLower, _tickUpper, 0);

        uint256 navNow = navAt(s1);
        uint256 bench;
        unchecked {
            // Fee growth accumulators wrap by design.
            bench = benchmark(s.nav, s.sqrtPriceX96, s1, fg0 - s.feeGrowth0X128, fg1 - s.feeGrowth1X128);
        }

        uint256 carry;
        uint256 paid;
        if (navNow >= bench) {
            if (!fired) {
                carry = FullMath.mulDiv(navNow - bench, carryBps, 10_000);
                if (carry > 0 && carry < navNow) {
                    uint256 newShares = FullMath.mulDiv(carry, totalSupply, navNow - carry);
                    balanceOf[curator] += newShares;
                    totalSupply += newShares;
                }
            }
        } else {
            uint256 shortfall = bench - navNow;
            paid = shortfall < bond ? shortfall : bond;
            bond -= paid; // bond tokens become vault (depositor) tokens
            navNow += paid;
        }
        emit Settled(navNow, bench, carry, paid, bond, s1);

        if (!fired && bond * 10_000 < uint256(minBondBps) * navNow) {
            fired = true;
            emit Fired(bond, navNow);
            // Park passively if the price is sane now; otherwise anyone can call rebalance later.
            if (_deviationOk(s1)) {
                _redeploy(TickMath.minUsableTick(poolKey.tickSpacing), TickMath.maxUsableTick(poolKey.tickSpacing));
            }
        }
        _resetStart(s1, fg0, fg1, navNow);
    }

    function _resetStart(uint160 s1, uint256 fg0, uint256 fg1, uint256 navValue) private {
        start = Start(uint64(block.timestamp), s1, fg0, fg1, navValue);
    }

    // ---------------------------------------------------------------------
    // Views: the math
    // ---------------------------------------------------------------------

    /// Value of a full-range position worth `nav0` at s0, after moving to s1 and earning dfg per unit L.
    function benchmark(uint256 nav0, uint160 s0, uint160 s1, uint256 dfg0X128, uint256 dfg1X128)
        public
        pure
        returns (uint256)
    {
        uint256 l = FullMath.mulDiv(nav0, Q96, 2 * uint256(s0)); // full range: V = 2 L s
        uint256 principal = FullMath.mulDiv(l, 2 * uint256(s1), Q96);
        uint256 fees0 = FullMath.mulDiv(l, dfg0X128, Q128);
        uint256 fees1 = FullMath.mulDiv(l, dfg1X128, Q128);
        return principal + _value(fees0, fees1, s1);
    }

    /// Vault NAV in token1 at sqrt price `s` (excludes bond and unrealized fees).
    function navAt(uint160 s) public view returns (uint256) {
        (uint256 a0, uint256 a1) = LiquidityAmounts.getAmountsForLiquidity(
            s, TickMath.getSqrtPriceAtTick(_tickLower), TickMath.getSqrtPriceAtTick(_tickUpper), _liquidity
        );
        return _value(token0.balanceOf(address(this)) + a0, _idle1() + a1, s);
    }

    function nav() external view returns (uint256) {
        return navAt(_twapSqrtPrice());
    }

    function position() external view returns (int24, int24, uint128) {
        return (_tickLower, _tickUpper, _liquidity);
    }

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    function _value(uint256 a0, uint256 a1, uint160 s) private pure returns (uint256) {
        return FullMath.mulDiv(FullMath.mulDiv(a0, s, Q96), s, Q96) + a1;
    }

    function _idle1() private view returns (uint256) {
        return token1.balanceOf(address(this)) - bond;
    }

    function _twapSqrtPrice() private view returns (uint160) {
        return TickMath.getSqrtPriceAtTick(oracle.twapTick(poolId));
    }

    function _deviationOk(uint160 twapSqrtP) private view returns (bool) {
        (, int24 spot,,) = manager.getSlot0(poolId);
        int24 d = spot - TickMath.getTickAtSqrtPrice(twapSqrtP);
        return d <= maxTickDeviation && d >= -maxTickDeviation;
    }

    function _checkedTwapSqrtPrice() private view returns (uint160 s) {
        s = _twapSqrtPrice();
        if (!_deviationOk(s)) revert PriceDeviation();
    }

    function _redeploy(int24 tickLower, int24 tickUpper) private {
        if (_liquidity > 0) _modify(_tickLower, _tickUpper, -int256(uint256(_liquidity)));
        (uint160 spot,,,) = manager.getSlot0(poolId);
        uint128 liq = LiquidityAmounts.getLiquidityForAmounts(
            spot,
            TickMath.getSqrtPriceAtTick(tickLower),
            TickMath.getSqrtPriceAtTick(tickUpper),
            token0.balanceOf(address(this)),
            _idle1()
        );
        (_tickLower, _tickUpper, _liquidity) = (tickLower, tickUpper, liq);
        if (liq > 0) _modify(tickLower, tickUpper, int256(uint256(liq)));
        emit Rebalanced(tickLower, tickUpper, liq);
    }

    /// Returns tokens received (positive) by the vault; reverts if it would have to pay more than it holds.
    function _modify(int24 tickLower, int24 tickUpper, int256 delta) private returns (int256 d0, int256 d1) {
        BalanceDelta bd = abi.decode(manager.unlock(abi.encode(tickLower, tickUpper, delta)), (BalanceDelta));
        return (bd.amount0(), bd.amount1());
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), "PM");
        (int24 tickLower, int24 tickUpper, int256 delta) = abi.decode(data, (int24, int24, int256));
        (BalanceDelta bd,) = manager.modifyLiquidity(
            poolKey, IPoolManager.ModifyLiquidityParams(tickLower, tickUpper, delta, SALT), ""
        );
        _resolve(poolKey.currency0, bd.amount0());
        _resolve(poolKey.currency1, bd.amount1());
        return abi.encode(bd);
    }

    function _resolve(Currency c, int128 amount) private {
        if (amount > 0) {
            manager.take(c, address(this), uint128(amount));
        } else if (amount < 0) {
            manager.sync(c);
            require(IERC20Minimal(Currency.unwrap(c)).transfer(address(manager), uint128(-amount)), "PAY");
            manager.settle();
        }
    }
}
