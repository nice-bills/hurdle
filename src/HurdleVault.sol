// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IERC20Minimal} from "v4-core/src/interfaces/external/IERC20Minimal.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {BalanceDelta} from "v4-core/src/types/BalanceDelta.sol";
import {SafeCast} from "v4-core/src/libraries/SafeCast.sol";
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
/// Miss par: the bond pays depositors the shortfall (locked bond shares first, then bond tokens) and
/// the amount is recorded as `deficit`. Beat par: the excess first refills the bond (as locked bond
/// shares) up to `deficit`, then the curator gets `carryBps` of the rest as free shares. So noise
/// around par nets out instead of draining the bond. Bond value below `minBondBps` of NAV: the
/// curator is fired and the vault is parked full range (50/50) — i.e. it becomes par.
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
    /// Epoch length. settle() is gated by it; deposit/withdraw settle only once it has elapsed.
    uint32 public immutable epochSeconds;
    IERC20Minimal public immutable token0;
    IERC20Minimal public immutable token1;

    PoolKey public poolKey;
    PoolId public immutable poolId;

    bool public fired;
    uint256 public bond;
    /// Shortfall the bond has paid and the curator has not yet earned back. Recouped at 100%
    /// before any carry, so a curator who beats par over many epochs isn't drained by the bad ones.
    uint256 public deficit;
    /// Curator shares held as bond (count toward bond value, cannot be withdrawn, burned first on shortfall).
    uint256 public bondShares;
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
    error EpochNotOver();
    /// AUM cap = bond / minBondBps: a deposit may not push the bond below the firing floor.
    error CapacityExceeded();

    constructor(
        IPoolManager _manager,
        PoolKey memory _key,
        address _curator,
        uint16 _carryBps,
        uint16 _minBondBps,
        int24 _maxTickDeviation,
        uint32 _epochSeconds
    ) {
        epochSeconds = _epochSeconds;
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
        _maybeSettle();
        uint160 sqrtP = _checkedTwapSqrtPrice();
        uint256 value = _value(amount0, amount1, sqrtP);
        uint256 navNow = navAt(sqrtP);
        shares = totalSupply == 0 ? value : FullMath.mulDiv(value, totalSupply, navNow);
        if (shares == 0) revert ZeroShares();
        if (bondValue() * 10_000 < uint256(minBondBps) * (navNow + value)) revert CapacityExceeded();

        if (amount0 > 0) require(token0.transferFrom(msg.sender, address(this), amount0), "T0");
        if (amount1 > 0) require(token1.transferFrom(msg.sender, address(this), amount1), "T1");
        // New money joins the benchmark at today's par: add value / (par growth so far) to its start.
        uint256 benchNow = _benchNow(sqrtP);
        start.nav += totalSupply == 0 || benchNow == 0 ? value : FullMath.mulDiv(value, start.nav, benchNow);
        balanceOf[msg.sender] += shares;
        totalSupply += shares;
        emit Deposited(msg.sender, amount0, amount1, shares);
    }

    /// Pro-rata in kind: no pricing, so no price check is needed.
    /// shortcut: a mid-epoch withdrawal leaves without that partial epoch's par guarantee; fine for epochs of hours, add pro-rata settlement for long epochs.
    function withdraw(uint256 shares) external returns (uint256 amount0, uint256 amount1) {
        if (shares == 0) revert ZeroShares();
        _maybeSettle();
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
        if (block.timestamp < start.timestamp + epochSeconds) revert EpochNotOver();
        _settle();
    }

    /// Settles if the epoch is over; otherwise realizes accrued fees so NAV and pro-rata payouts include them.
    function _maybeSettle() private {
        if (block.timestamp >= start.timestamp + epochSeconds) _settle();
        else if (_liquidity > 0) _modify(_tickLower, _tickUpper, 0);
    }

    function _settle() private {
        Start memory st = start;
        uint160 s1 = _twapSqrtPrice();
        (uint256 fg0, uint256 fg1) = manager.getFeeGrowthGlobals(poolId);

        if (totalSupply == 0 || st.timestamp == block.timestamp) {
            if (totalSupply == 0) _resetStart(s1, fg0, fg1, 0);
            return;
        }

        // Realize fees into idle balances so NAV = idle + principal at TWAP.
        if (_liquidity > 0) _modify(_tickLower, _tickUpper, 0);

        uint256 navNow = navAt(s1);
        uint256 bench;
        unchecked {
            // Fee growth accumulators wrap by design.
            bench = benchmark(st.nav, st.sqrtPriceX96, s1, fg0 - st.feeGrowth0X128, fg1 - st.feeGrowth1X128);
        }

        uint256 take;
        uint256 paid;
        uint256 navAfter = navNow;
        if (navNow >= bench) {
            if (!fired) take = _reward(navNow, navNow - bench);
        } else {
            uint256 tokens;
            (paid, tokens) = _payShortfall(navNow, bench - navNow);
            navAfter = navNow + tokens;
        }
        emit Settled(navNow, bench, take, paid, bondValue(), s1);

        if (!fired && bondValue() * 10_000 < uint256(minBondBps) * navAfter) {
            fired = true;
            emit Fired(bondValue(), navAfter);
            // Park passively if the price is sane now; otherwise anyone can call rebalance later.
            if (_deviationOk(s1)) {
                _redeploy(TickMath.minUsableTick(poolKey.tickSpacing), TickMath.maxUsableTick(poolKey.tickSpacing));
            }
        }
        _resetStart(s1, fg0, fg1, navAfter);
    }

    /// Excess first refills the bond up to `deficit` (as locked shares), then pays carry (free shares).
    function _reward(uint256 navNow, uint256 excess) private returns (uint256 take) {
        uint256 recoup = excess < deficit ? excess : deficit;
        deficit -= recoup;
        uint256 carry = FullMath.mulDiv(excess - recoup, carryBps, 10_000);
        take = recoup + carry;
        if (take == 0 || take >= navNow) return take;
        uint256 newShares = FullMath.mulDiv(take, totalSupply, navNow - take);
        uint256 toBond = FullMath.mulDiv(newShares, recoup, take);
        bondShares += toBond;
        balanceOf[curator] += newShares - toBond;
        totalSupply += newShares;
    }

    /// Makes non-bond shareholders whole to par: burn locked bond shares first, then pay bond tokens.
    /// Returns value delivered to them, and the bond tokens moved into the vault.
    function _payShortfall(uint256 navNow, uint256 shortfall) private returns (uint256 paid, uint256 tokens) {
        uint256 t = totalSupply;
        uint256 b = bondShares;
        if (t == b) return (0, 0); // only bond shares left: no depositors to make whole
        uint256 owed = FullMath.mulDiv(shortfall, t - b, t); // bond shares absorb their own share of the miss
        if (b > 0) {
            // Burning k shares lifts the other (t-b) shares' value by (t-b)*nav*k / (t*(t-k)).
            uint256 k = FullMath.mulDiv(owed, t * t, (t - b) * navNow + owed * t);
            if (k > b) k = b;
            bondShares = b - k;
            totalSupply = t - k;
            paid = FullMath.mulDiv(FullMath.mulDiv(t - b, navNow, t), k, t - k);
            if (paid > owed) paid = owed;
        }
        if (owed > paid) {
            uint256 rest = owed - paid;
            // Tokens added to NAV are shared with any remaining bond shares; gross up so depositors get `rest`.
            uint256 gross = bondShares == 0 ? rest : FullMath.mulDiv(rest, totalSupply, totalSupply - bondShares);
            tokens = gross < bond ? gross : bond;
            bond -= tokens; // bond tokens become vault tokens
            paid += bondShares == 0 ? tokens : FullMath.mulDiv(tokens, totalSupply - bondShares, totalSupply);
        }
        deficit += paid;
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

    /// Bond in token1: posted tokens plus the value of locked bond shares.
    function bondValue() public view returns (uint256) {
        if (bondShares == 0) return bond;
        return bond + FullMath.mulDiv(bondShares, navAt(_twapSqrtPrice()), totalSupply);
    }

    function _benchNow(uint160 s1) private view returns (uint256) {
        (uint256 fg0, uint256 fg1) = manager.getFeeGrowthGlobals(poolId);
        unchecked {
            return benchmark(start.nav, start.sqrtPriceX96, s1, fg0 - start.feeGrowth0X128, fg1 - start.feeGrowth1X128);
        }
    }

    /// Vault NAV in token1 at sqrt price `s` (excludes bond and unrealized fees).
    /// Valuing a concentrated position at TWAP when spot differs undervalues it: errs against the curator, never depositors.
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
        _swapToRatio(TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(tickUpper));
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

    /// Swap idle balances to the token ratio the range needs at spot. Price impact is bounded to
    /// `maxTickDeviation` around TWAP; any unswapped remainder stays idle.
    function _swapToRatio(uint160 sa, uint160 sb) private {
        (uint160 sp,,,) = manager.getSlot0(poolId);
        uint256 a0 = token0.balanceOf(address(this));
        uint256 a1 = _idle1();
        (uint256 u0, uint256 u1) = LiquidityAmounts.getAmountsForLiquidity(sp, sa, sb, 1e27);
        uint256 total = _value(a0, a1, sp);
        uint256 perL = _value(u0, u1, sp);
        if (total == 0 || perL == 0) return;
        uint256 target0 = FullMath.mulDiv(u0, total, perL);
        bool zeroForOne = a0 > target0;
        uint256 amountIn = zeroForOne ? a0 - target0 : _value(target0 - a0, 0, sp);
        if (amountIn == 0 || _value(zeroForOne ? amountIn : 0, zeroForOne ? 0 : amountIn, sp) * 1000 < total) return;
        int24 twap = oracle.twapTick(poolId);
        uint160 limit = TickMath.getSqrtPriceAtTick(zeroForOne ? twap - maxTickDeviation : twap + maxTickDeviation);
        if (zeroForOne ? limit >= sp : limit <= sp) return; // already at the impact bound
        manager.unlock(abi.encode(uint8(1), abi.encode(zeroForOne, amountIn, limit)));
    }

    /// Returns tokens received (positive) by the vault; reverts if it would have to pay more than it holds.
    function _modify(int24 tickLower, int24 tickUpper, int256 delta) private returns (int256 d0, int256 d1) {
        BalanceDelta bd = abi.decode(
            manager.unlock(abi.encode(uint8(0), abi.encode(tickLower, tickUpper, delta))), (BalanceDelta)
        );
        return (bd.amount0(), bd.amount1());
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), "PM");
        (uint8 action, bytes memory payload) = abi.decode(data, (uint8, bytes));
        BalanceDelta bd;
        if (action == 0) {
            (int24 tickLower, int24 tickUpper, int256 delta) = abi.decode(payload, (int24, int24, int256));
            (bd,) = manager.modifyLiquidity(
                poolKey, IPoolManager.ModifyLiquidityParams(tickLower, tickUpper, delta, SALT), ""
            );
        } else {
            (bool zeroForOne, uint256 amountIn, uint160 limit) = abi.decode(payload, (bool, uint256, uint160));
            bd = manager.swap(
                poolKey, IPoolManager.SwapParams(zeroForOne, -SafeCast.toInt256(amountIn), limit), ""
            );
        }
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
