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
    function consult(PoolId id, uint32 secondsAgo) external view returns (int24);
    function referenceTick(PoolId id) external view returns (int24);
    function referenceFeeGrowth(PoolId id) external view returns (uint256, uint256);
}

/// A curator vault settled against the passive full-range benchmark ("par").
/// Each settlement: par = navStart/(2 s0) * (2 s1 + dfg0*P1 + dfg1), all at the hook's TWAP price.
/// Miss par: the bond pays depositors the shortfall (locked bond shares first, then bond tokens) and
/// the amount is recorded as `deficit`. Beat par: the excess first refills the bond (as locked bond
/// shares) up to `deficit`, then the curator gets `carryBps` of the rest as free shares. So noise
/// around par nets out instead of draining the bond. Bond value below `minBondBps` of NAV (e.g. after
/// NAV grew): deposits and curator rebalances are blocked until the curator tops up. A shortfall
/// payment that leaves the bond below half of `minBondBps`: the curator is fired and the vault is
/// parked full range (50/50) — i.e. it becomes par. Beating par never fires the curator.
/// Tokens: plain ERC20 only. Native ETH (currency0 = 0) and fee-on-transfer/rebasing tokens are unsupported.
/// The oracle is the pool's hook and is not checked here: depositors must check that `poolKey.hooks`
/// is the canonical HurdleHook (README lists its address).
contract HurdleVault is IHurdleVault, IUnlockCallback {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    /// Each rebalance can lose at most ~maxTickDeviation bps of NAV to a sandwich: its swap is
    /// price-limited to the intersection of referenceTick ± maxTickDeviation and 10-min and 30-min TWAP ± maxTickDeviation,
    /// and the referenceTick (block-open price) cannot be moved within the block. Capping rebalances per
    /// epoch keeps 4 x maxTickDeviation <= minBondBps, so a curator (or MEV) cannot extract more than the
    /// bond in one epoch versus the block-open price. Residual: a price held off-market across a block
    /// boundary passes every check (that costs the attacker a block of arbitrage exposure).
    uint256 public constant MAX_REBALANCES_PER_EPOCH = 4;
    /// Cap on the benchmark's fee credit, as an APR on the epoch's starting NAV (300%).
    uint256 public constant MAX_FEE_APR_BPS = 30_000;
    /// In-kind deposits are refused while `deficit` exceeds this share of NAV (1 bp): a newcomer would
    /// otherwise help refill the bond for payouts that earlier holders received.
    uint256 private constant DEFICIT_TOLERANCE_BPS = 1;
    /// In-kind deposits are open for this long after each epoch settlement. A deposit in the window
    /// first re-baselines par (a short settle that keeps the epoch clock and rebalance count), so a
    /// newcomer neither pays for nor collects performance from before it joined, and a third party
    /// settling first cannot close the window.
    uint256 public constant DEPOSIT_WINDOW = 300;
    /// A bonded curator's rebalances gate on a 10-min TWAP (not the 30-min one used for valuation), so the curator
    /// can act minutes after a real move. The 10- and 30-min TWAPs must still agree within
    /// MAX_REBALANCES_PER_EPOCH x maxTickDeviation, so moving the gate still means holding the price
    /// across blocks for ~10 min, and the swap stays bounded by the 10-min, 30-min and block-open bands. Fired-vault parks keep the 30-min gate.
    uint32 public constant REBALANCE_TWAP_WINDOW = 600;
    /// Share of the curator's carry (free shares) paid to whoever calls `settle()` on schedule, so a
    /// keeper is paid to keep epochs short. Minted out of the curator's carry, never from depositors or
    /// the bond; once minted they are ordinary non-curator shares, covered by the bond like any other.
    uint256 public constant SETTLER_BOUNTY_BPS = 500;
    /// Shares burned on the first deposit so a donation cannot inflate the share price.
    uint256 private constant DEAD_SHARES = 1000;
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
    /// Start of the current epoch: settle() and the rebalance count run on this clock. `start` (par's
    /// baseline) also moves on deposit re-baselines; `epochStart` does not.
    uint64 public epochStart;
    uint64 public firedAt;
    uint256 public rebalancesThisEpoch;

    error PriceDeviation();
    error EpochNotOver();
    /// AUM cap = bond / minBondBps: a deposit may not push the bond below the firing floor.
    error CapacityExceeded();
    error TooManyRebalances();
    error AlreadyParked();
    /// In-kind deposits are only accepted in the block the vault settled (deposit() settles a finished epoch).
    error DepositWindowClosed();
    error NotFired();
    /// reclaimBond needs the fired vault parked full range (≤ 2% of NAV idle).
    error NotParked();
    /// The bond has not yet been refilled for past shortfall payments (see `deficit`).
    error DeficitOutstanding();
    /// Bond value is below `minBondBps` of NAV: the curator must postBond before rebalancing.
    error BondBelowFloor();
    /// More than the curator's `maxIdleBps` of NAV was left outside the position (e.g. a front-run
    /// pushed spot to the swap bound). Reverting keeps the epoch's rebalance count.
    error RebalanceIncomplete();
    error NotFirstDeposit();
    error Slippage();
    error OnlySelf();

    constructor(
        IPoolManager _manager,
        PoolKey memory _key,
        address _curator,
        uint16 _carryBps,
        uint16 _minBondBps,
        int24 _maxTickDeviation,
        uint32 _epochSeconds
    ) {
        require(_maxTickDeviation > 0 && MAX_REBALANCES_PER_EPOCH * uint24(_maxTickDeviation) <= _minBondBps, "DEV");
        require(_carryBps <= 5000, "CARRY");
        require(_minBondBps >= 100 && _minBondBps <= 5000, "BOND");
        require(_epochSeconds >= 600, "EPOCH");
        require(Currency.unwrap(_key.currency0) != address(0), "NATIVE");
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

    /// First deposit only, by the curator (so nobody can front-run the vault's start), with shares
    /// minted to `receiver` (a depositor, covered by the bond unless it is the curator). Valued at TWAP
    /// (spot/reference checked), idle until the curator rebalances. Starts the benchmark from this block.
    function firstDeposit(uint256 amount0, uint256 amount1, address receiver) external returns (uint256 shares) {
        if (msg.sender != curator) revert NotCurator();
        if (totalSupply != 0) revert NotFirstDeposit();
        uint160 sqrtP = _checkedTwapSqrtPrice();
        uint256 value = _value(amount0, amount1, sqrtP);
        if (value <= DEAD_SHARES) revert ZeroShares();
        shares = value - DEAD_SHARES;
        balanceOf[address(0)] += DEAD_SHARES;
        if (amount0 > 0) require(token0.transferFrom(msg.sender, address(this), amount0), "T0");
        if (amount1 > 0) require(token1.transferFrom(msg.sender, address(this), amount1), "T1");
        balanceOf[receiver] += shares;
        totalSupply = DEAD_SHARES + shares;
        (uint256 fg0, uint256 fg1) = oracle.referenceFeeGrowth(poolId);
        _resetStart(sqrtP, fg0, fg1, navAt(sqrtP));
        _newEpoch();
        if (bondValue() * 10_000 < uint256(minBondBps) * value) revert CapacityExceeded();
        emit Deposited(receiver, amount0, amount1, shares);
    }

    /// Buy `shares` in kind: pays exactly what withdraw(shares) would pay out, rounded up (idle pro rata
    /// plus the same fraction of the position's liquidity, added at spot). No price is used, so a
    /// deposit/withdraw round trip cannot trade with the vault. Only within DEPOSIT_WINDOW of an epoch
    /// settlement, after par is re-baselined to this block (no carry or shortfall pending), and only
    /// while no shortfall is still owed to the bond (`deficit` within 1 bp of NAV), so a newcomer neither
    /// pays for nor collects past performance. Spot, block-open price and TWAP must agree, so a
    /// same-block sandwich cannot skew the liquidity it adds. See previewDeposit for a quote.
    function deposit(uint256 shares, uint256 max0, uint256 max1) external returns (uint256 amount0, uint256 amount1) {
        if (shares == 0) revert ZeroShares();
        _maybeSettle(); // also realizes accrued fees, so the add below carries none
        if (block.timestamp > epochStart + DEPOSIT_WINDOW) revert DepositWindowClosed();
        if (start.timestamp != block.timestamp) _settle(false, address(0)); // re-baseline par to this block
        uint256 supply = totalSupply;
        if (supply == 0) revert ZeroShares();
        uint256 navBefore = navAt(_checkedTwapSqrtPrice());
        if (deficit * 10_000 > navBefore * DEFICIT_TOLERANCE_BPS) revert DeficitOutstanding();
        amount0 = FullMath.mulDivRoundingUp(token0.balanceOf(address(this)), shares, supply);
        amount1 = FullMath.mulDivRoundingUp(_idle1(), shares, supply);
        if (amount0 > 0) require(token0.transferFrom(msg.sender, address(this), amount0), "T0");
        if (amount1 > 0) require(token1.transferFrom(msg.sender, address(this), amount1), "T1");
        uint128 liq = SafeCast.toUint128(FullMath.mulDivRoundingUp(_liquidity, shares, supply));
        if (liq > 0) {
            (int256 d0, int256 d1) = _modify(_tickLower, _tickUpper, int256(uint256(liq)), msg.sender);
            _liquidity += liq;
            amount0 += uint256(-d0);
            amount1 += uint256(-d1);
        }
        if (amount0 > max0 || amount1 > max1) revert Slippage();

        // Mirror of withdraw: the benchmark grows by the same fraction as the holdings.
        start.nav = FullMath.mulDiv(start.nav, supply + shares, supply);
        balanceOf[msg.sender] += shares;
        totalSupply = supply + shares;
        // A fired vault is parked passive (it is par), so it needs no bond behind new deposits.
        if (!fired && _belowFloor()) revert CapacityExceeded();
        emit Deposited(msg.sender, amount0, amount1, shares);
    }

    /// Pro-rata in kind: no pricing, so no price check is needed. Never blocked by settlement or price
    /// failures: settling and crystallizing run as self-calls whose reverts are skipped. (Gas griefing a
    /// self-call into an out-of-gas leaves 1/64 of the gas, far less than the payout below needs.)
    /// Mid-epoch while ahead of par, the withdrawn shares first pay their pro-rata share of the pending
    /// recoup and carry (see crystallize).
    /// shortcut: a mid-epoch withdrawal leaves without that partial epoch's par guarantee; fine for epochs of hours, add pro-rata settlement for long epochs.
    function withdraw(uint256 shares) external returns (uint256 amount0, uint256 amount1) {
        if (shares == 0) revert ZeroShares();
        try this.settleForWithdraw() {}
        catch {
            if (_liquidity > 0) _modify(_tickLower, _tickUpper, 0); // still realize fees: removal would hand them all over
        }
        // The withdrawer's pro-rata share of the deficit leaves with them (recouped by crystallize when
        // ahead of par, forgiven otherwise), so remaining holders' per-share charge is unchanged.
        uint256 deficitBefore = deficit;
        uint256 owedDeficit = FullMath.mulDiv(deficitBefore, shares, totalSupply);
        uint256 burn = shares;
        if (!fired && start.timestamp != block.timestamp) {
            try this.crystallize(msg.sender, shares) returns (uint256 paidShares) {
                burn -= paidShares;
            } catch {}
        }
        deficit = deficitBefore - owedDeficit;
        uint256 supply = totalSupply;
        balanceOf[msg.sender] -= burn;

        amount0 = FullMath.mulDiv(token0.balanceOf(address(this)), burn, supply);
        amount1 = FullMath.mulDiv(_idle1(), burn, supply);
        uint128 liq = uint128(FullMath.mulDiv(_liquidity, burn, supply));
        if (liq > 0) {
            (int256 d0, int256 d1) = _modify(_tickLower, _tickUpper, -int256(uint256(liq)));
            _liquidity -= liq;
            amount0 += uint256(d0);
            amount1 += uint256(d1);
        }

        start.nav = FullMath.mulDiv(start.nav, supply - burn, supply);
        totalSupply = supply - burn;
        if (amount0 > 0) require(token0.transfer(msg.sender, amount0), "T0");
        if (amount1 > 0) require(token1.transfer(msg.sender, amount1), "T1");
        emit Withdrawn(msg.sender, shares, amount0, amount1);
    }

    /// Self-call target for withdraw (so a revert here cannot block exits).
    function settleForWithdraw() external {
        if (msg.sender != address(this)) revert OnlySelf();
        _maybeSettle();
    }

    /// Self-call target for withdraw: `owner`'s `shares` pay their pro-rata share of what _reward would
    /// take if the vault settled now (recoup into bond shares first, then carry), by transferring shares.
    /// Returns the shares moved. So exiting just before a good settle does not dodge carry.
    function crystallize(address owner, uint256 shares) external returns (uint256 paidShares) {
        if (msg.sender != address(this)) revert OnlySelf();
        uint160 s = _twapSqrtPrice();
        uint256 navNow = navAt(s);
        uint256 benchNow = _benchNow(s);
        if (navNow <= benchNow) return 0;
        uint256 t = totalSupply;
        uint256 excess = FullMath.mulDiv(navNow - benchNow, shares, t);
        uint256 owedDeficit = FullMath.mulDiv(deficit, shares, t);
        uint256 recoup = excess < owedDeficit ? excess : owedDeficit;
        deficit -= recoup;
        uint256 take = recoup + FullMath.mulDiv(excess - recoup, carryBps, 10_000);
        if (take == 0) return 0;
        paidShares = FullMath.mulDivRoundingUp(take, t, navNow);
        uint256 toBond = FullMath.mulDiv(paidShares, recoup, take);
        balanceOf[owner] -= paidShares;
        bondShares += toBond;
        balanceOf[curator] += paidShares - toBond;
    }

    /// Self-call target for the fire-time park, so a failed park cannot revert the settlement.
    function park() external {
        if (msg.sender != address(this)) revert OnlySelf();
        _redeploy(TickMath.minUsableTick(poolKey.tickSpacing), TickMath.maxUsableTick(poolKey.tickSpacing));
    }

    // ---------------------------------------------------------------------
    // Curator
    // ---------------------------------------------------------------------

    function postBond(uint256 amount1) external {
        if (msg.sender != curator) revert NotCurator();
        if (fired) revert CuratorFired();
        require(token1.transferFrom(msg.sender, address(this), amount1), "T1");
        bond += amount1;
        // Fresh bond tokens settle the curator's debt to the bond first (deficit is in token1 value, like
        // the bond): a curator in a drawdown can reopen deposits by paying back what the bond paid out,
        // instead of waiting to earn it back from excess over par.
        uint256 d = deficit;
        if (d > 0) deficit = amount1 < d ? d - amount1 : 0;
        emit BondPosted(amount1, bond);
    }

    /// Move all liquidity to [tickLower, tickUpper], swapping idle balances to the range's ratio.
    /// No bound on what is left idle; see the overload.
    function rebalance(int24 tickLower, int24 tickUpper) external {
        _rebalance(tickLower, tickUpper, 10_000);
    }

    /// As above, but reverts RebalanceIncomplete if more than `maxIdleBps` of NAV is left outside the
    /// position, so a front-run that pins spot at the swap bound costs the curator no rebalance slot.
    /// After firing, anyone may call either overload to finish parking full range, until it is parked;
    /// those calls are not counted. Each still swaps within the same price bands, so a manipulator can
    /// cost a few bp per call while the park is incomplete; once parked, calls revert AlreadyParked.
    function rebalance(int24 tickLower, int24 tickUpper, uint16 maxIdleBps) external {
        _rebalance(tickLower, tickUpper, maxIdleBps);
    }

    function _rebalance(int24 tickLower, int24 tickUpper, uint16 maxIdleBps) private {
        bool wasFired = fired;
        if (!wasFired && msg.sender != curator) revert NotCurator();
        _maybeSettle(); // a finished epoch is settled (and the counter reset) before new risk is taken
        if (fired) {
            if (!wasFired) return; // this settle fired the curator and parked: the curator's range is void
            tickLower = TickMath.minUsableTick(poolKey.tickSpacing);
            tickUpper = TickMath.maxUsableTick(poolKey.tickSpacing);
            if (_tickLower == tickLower && _tickUpper == tickUpper && _idleBps() * 50 <= 10_000) revert AlreadyParked();
        } else {
            // Below the floor the bond no longer covers MAX_REBALANCES_PER_EPOCH worst-case swaps.
            if (_belowFloor()) revert BondBelowFloor();
            if (++rebalancesThisEpoch > MAX_REBALANCES_PER_EPOCH) revert TooManyRebalances();
        }
        _redeploy(tickLower, tickUpper);
        if (_idleBps() > maxIdleBps) revert RebalanceIncomplete();
    }

    /// Share of NAV (bps) sitting outside the position (e.g. a swap that hit its price bound).
    function _idleBps() private view returns (uint256) {
        uint160 s = _twapSqrtPrice();
        uint256 navNow = navAt(s);
        if (navNow == 0) return 0;
        return FullMath.mulDiv(_value(token0.balanceOf(address(this)), _idle1(), s), 10_000, navNow);
    }

    /// Bond value below `minBondBps` of NAV.
    function _belowFloor() private view returns (bool) {
        return bondValue() * 10_000 < uint256(minBondBps) * navAt(_twapSqrtPrice());
    }

    // ---------------------------------------------------------------------
    // Settlement
    // ---------------------------------------------------------------------

    function settle() external {
        if (block.timestamp < epochStart + epochSeconds) revert EpochNotOver();
        _settle(true, msg.sender);
    }

    /// After firing, once the vault is parked full range and a full epoch has passed, the curator takes
    /// back what is left of its bond (tokens, and bond shares as free shares). The parked vault holds the
    /// passive position par describes, so the guarantee no longer needs collateral.
    function reclaimBond() external {
        if (msg.sender != curator) revert NotCurator();
        if (!fired) revert NotFired();
        _maybeSettle();
        if (block.timestamp < firedAt + epochSeconds) revert EpochNotOver();
        if (
            _tickLower != TickMath.minUsableTick(poolKey.tickSpacing)
                || _tickUpper != TickMath.maxUsableTick(poolKey.tickSpacing) || _idleBps() * 50 > 10_000
        ) revert NotParked();
        uint256 tokens = bond;
        uint256 sh = bondShares;
        bond = 0;
        bondShares = 0;
        deficit = 0;
        balanceOf[curator] += sh;
        if (tokens > 0) require(token1.transfer(curator, tokens), "T1");
        emit BondReclaimed(tokens, sh);
    }

    /// Settles if the epoch is over; otherwise realizes accrued fees so NAV and pro-rata payouts include them.
    function _maybeSettle() private {
        if (block.timestamp >= epochStart + epochSeconds) _settle(true, address(0));
        else if (_liquidity > 0) _modify(_tickLower, _tickUpper, 0);
    }

    /// `epochEnd`: a scheduled settlement (new epoch, rebalance count reset). Otherwise a deposit's
    /// re-baseline: same accounting, but the epoch clock and count are kept.
    /// `settler`: the external `settle()` caller, paid SETTLER_BOUNTY_BPS of the carry; zero otherwise.
    function _settle(bool epochEnd, address settler) private {
        if (epochEnd) _newEpoch();
        Start memory st = start;
        uint160 s1 = _twapSqrtPrice();
        (uint256 fg0, uint256 fg1) = oracle.referenceFeeGrowth(poolId);

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
            bench = benchmark(
                st.nav, st.sqrtPriceX96, s1, fg0 - st.feeGrowth0X128, fg1 - st.feeGrowth1X128, _feeElapsed(st.timestamp)
            );
        }

        uint256 take;
        uint256 paid;
        uint256 navAfter = navNow;
        if (navNow >= bench) {
            if (!fired) take = _reward(navNow, navNow - bench, settler);
        } else {
            uint256 tokens;
            (paid, tokens) = _payShortfall(navNow, bench - navNow);
            navAfter = navNow + tokens;
        }
        emit Settled(navNow, bench, take, paid, bondValue(), s1);

        // Fire only on a miss that leaves the bond below half the floor. NAV growth alone (price, fees,
        // carry, deposits up to capacity) can push the bond under the floor; that blocks deposits and
        // rebalances until the curator tops up, but never forfeits the bond of a curator at or above par.
        if (!fired && paid > 0 && bondValue() * 20_000 < uint256(minBondBps) * navAfter) {
            fired = true;
            firedAt = uint64(block.timestamp);
            emit Fired(bondValue(), navAfter);
            // Park passively if the price is sane now; otherwise (or if the park reverts) anyone can call rebalance later.
            try this.park() {} catch {}
        }
        _resetStart(s1, fg0, fg1, navAfter);
    }

    /// Excess first refills the bond up to `deficit` (as locked shares), then pays carry (free shares).
    function _reward(uint256 navNow, uint256 excess, address settler) private returns (uint256 take) {
        uint256 recoup = excess < deficit ? excess : deficit;
        deficit -= recoup;
        uint256 carry = FullMath.mulDiv(excess - recoup, carryBps, 10_000);
        take = recoup + carry;
        if (take == 0 || take >= navNow) return take;
        uint256 newShares = FullMath.mulDiv(take, totalSupply, navNow - take);
        uint256 toBond = FullMath.mulDiv(newShares, recoup, take);
        bondShares += toBond;
        uint256 carryShares = newShares - toBond;
        uint256 bounty = settler == address(0) || settler == curator
            ? 0
            : FullMath.mulDiv(carryShares, SETTLER_BOUNTY_BPS, 10_000);
        balanceOf[curator] += carryShares - bounty;
        if (bounty > 0) {
            balanceOf[settler] += bounty;
            emit SettlerPaid(settler, bounty);
        }
        totalSupply += newShares;
    }

    /// Makes depositors whole to par: burn locked bond shares first, then pay bond tokens.
    /// Bond shares and the curator's free shares absorb their own share of the miss.
    /// Returns value delivered to depositors, and the bond tokens moved into the vault.
    function _payShortfall(uint256 navNow, uint256 shortfall) private returns (uint256 paid, uint256 tokens) {
        uint256 t = totalSupply;
        uint256 b = bondShares;
        uint256 c = balanceOf[curator];
        uint256 x = b + c; // excluded: bond shares and curator free shares
        if (t == x) return (0, 0); // no depositors to make whole
        uint256 owed = FullMath.mulDiv(shortfall, t - x, t);
        if (b > 0) {
            // Burning k shares lifts the other (t-x) shares' value by (t-x)*nav*k / (t*(t-k)).
            uint256 k = FullMath.mulDiv(owed, t * t, (t - x) * navNow + owed * t);
            if (k > b) k = b;
            bondShares = b - k;
            totalSupply = t - k;
            paid = FullMath.mulDiv(FullMath.mulDiv(t - x, navNow, t), k, t - k);
            if (paid > owed) paid = owed;
        }
        if (owed > paid) {
            uint256 rest = owed - paid;
            uint256 t2 = totalSupply;
            uint256 x2 = bondShares + c;
            // Tokens added to NAV are shared with the excluded shares; gross up so depositors get `rest`.
            uint256 gross = x2 == 0 ? rest : FullMath.mulDiv(rest, t2, t2 - x2);
            tokens = gross < bond ? gross : bond;
            bond -= tokens; // bond tokens become vault tokens
            paid += x2 == 0 ? tokens : FullMath.mulDiv(tokens, t2 - x2, t2);
        }
        if (c > 0) {
            // The burn and the tokens lift curator free shares too: lock that lift back into bond shares,
            // so the curator's value stays c*nav/t and the bond shrinks only by what depositors got.
            uint256 keep = FullMath.mulDiv(c, navNow * totalSupply, t * (navNow + tokens));
            balanceOf[curator] = keep;
            bondShares += c - keep;
        }
        deficit += paid;
    }

    function _resetStart(uint160 s1, uint256 fg0, uint256 fg1, uint256 navValue) private {
        start = Start(uint64(block.timestamp), s1, fg0, fg1, navValue);
    }

    function _newEpoch() private {
        epochStart = uint64(block.timestamp);
        rebalancesThisEpoch = 0;
    }

    // ---------------------------------------------------------------------
    // Views: the math
    // ---------------------------------------------------------------------

    /// Value of a full-range position worth `nav0` at s0, after moving to s1 and earning dfg per unit L
    /// over `elapsed` seconds. The fee credit is capped at MAX_FEE_APR_BPS of nav0: wash swaps raise
    /// feeGrowthGlobal, which this virtual liquidity collects without paying the swap fees.
    /// Residual: an attacker can still inflate par up to the cap (300% APR, ~0.57 bp of NAV per 10-min
    /// epoch), and a real fee burst above the cap shows up as curator excess.
    function benchmark(uint256 nav0, uint160 s0, uint160 s1, uint256 dfg0X128, uint256 dfg1X128, uint256 elapsed)
        public
        pure
        returns (uint256)
    {
        uint256 l = FullMath.mulDiv(nav0, Q96, 2 * uint256(s0)); // full range: V = 2 L s
        uint256 principal = FullMath.mulDiv(l, 2 * uint256(s1), Q96);
        uint256 fees = _value(FullMath.mulDiv(l, dfg0X128, Q128), FullMath.mulDiv(l, dfg1X128, Q128), s1);
        uint256 maxFees = FullMath.mulDiv(nav0, MAX_FEE_APR_BPS * elapsed, 10_000 * 365 days);
        return principal + (fees < maxFees ? fees : maxFees);
    }

    /// Bond in token1: posted tokens plus the value of locked bond shares.
    function bondValue() public view returns (uint256) {
        if (bondShares == 0) return bond;
        return bond + FullMath.mulDiv(bondShares, navAt(_twapSqrtPrice()), totalSupply);
    }

    /// Uses block-open fee growth, so same-block wash swaps cannot lift par (e.g. to dodge carry on exit).
    /// Time the fee cap may grow over: capped at one epoch, so a settlement that comes late (nobody
    /// settled on schedule) does not widen the wash-trading allowance. Real fees above the capped credit
    /// count as curator excess; settle() is permissionless and pays a keeper bounty, so epochs stay short.
    function _feeElapsed(uint64 since) private view returns (uint256 e) {
        e = block.timestamp - since;
        if (e > epochSeconds) e = epochSeconds;
    }

    function _benchNow(uint160 s1) private view returns (uint256) {
        (uint256 fg0, uint256 fg1) = oracle.referenceFeeGrowth(poolId);
        unchecked {
            return benchmark(
                start.nav,
                start.sqrtPriceX96,
                s1,
                fg0 - start.feeGrowth0X128,
                fg1 - start.feeGrowth1X128,
                _feeElapsed(start.timestamp)
            );
        }
    }

    /// Vault NAV in token1 at sqrt price `s` (excludes bond and unrealized fees).
    /// Values the position's token amounts at TWAP as if the price were TWAP (not spot); whether that over- or
    /// undervalues it depends on the position's composition. It matters only at settlement and crystallization.
    function navAt(uint160 s) public view returns (uint256) {
        (uint256 a0, uint256 a1) = LiquidityAmounts.getAmountsForLiquidity(
            s, TickMath.getSqrtPriceAtTick(_tickLower), TickMath.getSqrtPriceAtTick(_tickUpper), _liquidity
        );
        return _value(token0.balanceOf(address(this)) + a0, _idle1() + a1, s);
    }

    /// Approximate quote for deposit(shares, …) at the current state: pro-rata idle balances plus the same
    /// fraction of the position at spot, rounded up (+2 wei per token: the pool and LiquidityAmounts round in opposite directions). Excludes
    /// unrealized fees and any pending settlement; pass max0/max1 with some slack.
    function previewDeposit(uint256 shares) external view returns (uint256 amount0, uint256 amount1) {
        uint256 t = totalSupply;
        amount0 = FullMath.mulDivRoundingUp(_idle0(), shares, t);
        amount1 = FullMath.mulDivRoundingUp(_idle1(), shares, t);
        (uint256 p0, uint256 p1) = _positionAmounts(uint128(FullMath.mulDivRoundingUp(_liquidity, shares, t)));
        if (p0 + p1 > 0) (amount0, amount1) = (amount0 + p0 + 2, amount1 + p1 + 2);
    }

    /// Approximate payout of withdraw(shares) at the current state, before any carry `crystallize` takes
    /// and excluding unrealized fees (both move it by a fraction of a bp).
    function previewWithdraw(uint256 shares) external view returns (uint256 amount0, uint256 amount1) {
        uint256 t = totalSupply;
        (uint256 p0, uint256 p1) = _positionAmounts(uint128(FullMath.mulDiv(_liquidity, shares, t)));
        amount0 = FullMath.mulDiv(_idle0(), shares, t) + p0;
        amount1 = FullMath.mulDiv(_idle1(), shares, t) + p1;
    }

    function _positionAmounts(uint128 liq) private view returns (uint256, uint256) {
        (uint160 sp,,,) = manager.getSlot0(poolId);
        return LiquidityAmounts.getAmountsForLiquidity(
            sp, TickMath.getSqrtPriceAtTick(_tickLower), TickMath.getSqrtPriceAtTick(_tickUpper), liq
        );
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

    function _idle0() private view returns (uint256) {
        return token0.balanceOf(address(this));
    }

    function _idle1() private view returns (uint256) {
        return token1.balanceOf(address(this)) - bond;
    }

    function _twapSqrtPrice() private view returns (uint160) {
        return TickMath.getSqrtPriceAtTick(oracle.twapTick(poolId));
    }

    /// Spot, the block-open reference tick and the TWAP must all agree within maxTickDeviation, so no
    /// rebalance trades while spot is pushed within the block or while the TWAP lags a fast move.
    function _checkedTwapSqrtPrice() private view returns (uint160) {
        int24 twap = oracle.twapTick(poolId);
        int24 ref = oracle.referenceTick(poolId);
        (, int24 spot,,) = manager.getSlot0(poolId);
        if (!_near(spot, twap) || !_near(spot, ref) || !_near(ref, twap)) revert PriceDeviation();
        return TickMath.getSqrtPriceAtTick(twap);
    }

    function _near(int24 a, int24 b) private view returns (bool) {
        int24 d = a - b;
        return d <= maxTickDeviation && d >= -maxTickDeviation;
    }

    /// Gate for a bonded curator's rebalance (`fast`): spot, block-open tick and the 10-min TWAP agree
    /// within maxTickDeviation, and the 10-min TWAP is within MAX_REBALANCES_PER_EPOCH x maxTickDeviation
    /// of the 30-min one. The swap itself stays within maxTickDeviation of the 30-min TWAP too
    /// (see _swapToRatio): while the 30-min TWAP lags, the curator can re-range but swaps less.
    /// Parks of a fired vault (no live bond behind them) use the strict gate: the 30-min TWAP in place of
    /// the 10-min one. Returns the gate's TWAP tick, which bounds the swap.
    function _checkedRebalanceTick(bool fast) private view returns (int24 twap) {
        int24 t30 = oracle.twapTick(poolId);
        twap = fast ? oracle.consult(poolId, REBALANCE_TWAP_WINDOW) : t30;
        int24 ref = oracle.referenceTick(poolId);
        (, int24 spot,,) = manager.getSlot0(poolId);
        int24 d = twap - t30;
        int24 lim = int24(uint24(MAX_REBALANCES_PER_EPOCH)) * maxTickDeviation;
        if (!_near(spot, twap) || !_near(spot, ref) || !_near(ref, twap) || d > lim || d < -lim) {
            revert PriceDeviation();
        }
    }

    function _redeploy(int24 tickLower, int24 tickUpper) private {
        int24 twap = _checkedRebalanceTick(!fired);
        if (_liquidity > 0) _modify(_tickLower, _tickUpper, -int256(uint256(_liquidity)));
        _swapToRatio(TickMath.getSqrtPriceAtTick(tickLower), TickMath.getSqrtPriceAtTick(tickUpper), twap);
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

    /// Swap idle balances to the token ratio the range needs at spot. The price limit is the intersection
    /// of referenceTick, gate TWAP and 30-min TWAP, each ± maxTickDeviation (no swap if empty); any unswapped
    /// remainder stays idle.
    function _swapToRatio(uint160 sa, uint160 sb, int24 twap) private {
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
        // Band: within maxTickDeviation of the gate TWAP, the block-open tick AND the 30-min valuation
        // TWAP, so the swap price is never more than maxTickDeviation from the price NAV is marked at
        // (keeps MAX_REBALANCES_PER_EPOCH x maxTickDeviation <= minBondBps meaningful for fast rebalances).
        int24 ref = oracle.referenceTick(poolId);
        int24 t30 = oracle.twapTick(poolId);
        (int24 hi, int24 lo) = twap > ref ? (twap, ref) : (ref, twap);
        if (t30 > hi) hi = t30;
        if (t30 < lo) lo = t30;
        if (hi - lo > 2 * maxTickDeviation) return; // bands do not overlap: re-range without swapping
        uint160 limit = TickMath.getSqrtPriceAtTick(zeroForOne ? hi - maxTickDeviation : lo + maxTickDeviation);
        if (zeroForOne ? limit >= sp : limit <= sp) return; // already at the impact bound
        manager.unlock(abi.encode(uint8(1), abi.encode(zeroForOne, amountIn, limit)));
    }

    /// Returns tokens received (positive) by the vault; reverts if it would have to pay more than it holds.
    function _modify(int24 tickLower, int24 tickUpper, int256 delta) private returns (int256 d0, int256 d1) {
        return _modify(tickLower, tickUpper, delta, address(this));
    }

    /// `payer` settles what the vault owes (an in-kind depositor pays its liquidity directly).
    function _modify(int24 tickLower, int24 tickUpper, int256 delta, address payer)
        private
        returns (int256 d0, int256 d1)
    {
        BalanceDelta bd = abi.decode(
            manager.unlock(abi.encode(uint8(0), abi.encode(tickLower, tickUpper, delta, payer))), (BalanceDelta)
        );
        return (bd.amount0(), bd.amount1());
    }

    function unlockCallback(bytes calldata data) external returns (bytes memory) {
        require(msg.sender == address(manager), "PM");
        (uint8 action, bytes memory payload) = abi.decode(data, (uint8, bytes));
        BalanceDelta bd;
        address payer = address(this);
        if (action == 0) {
            int24 tickLower;
            int24 tickUpper;
            int256 delta;
            (tickLower, tickUpper, delta, payer) = abi.decode(payload, (int24, int24, int256, address));
            (bd,) = manager.modifyLiquidity(
                poolKey, IPoolManager.ModifyLiquidityParams(tickLower, tickUpper, delta, SALT), ""
            );
        } else {
            (bool zeroForOne, uint256 amountIn, uint160 limit) = abi.decode(payload, (bool, uint256, uint160));
            bd = manager.swap(
                poolKey, IPoolManager.SwapParams(zeroForOne, -SafeCast.toInt256(amountIn), limit), ""
            );
        }
        _resolve(poolKey.currency0, bd.amount0(), payer);
        _resolve(poolKey.currency1, bd.amount1(), payer);
        return abi.encode(bd);
    }

    function _resolve(Currency c, int128 amount, address payer) private {
        if (amount > 0) {
            manager.take(c, address(this), uint128(amount));
        } else if (amount < 0) {
            manager.sync(c);
            IERC20Minimal t = IERC20Minimal(Currency.unwrap(c));
            require(
                payer == address(this)
                    ? t.transfer(address(manager), uint128(-amount))
                    : t.transferFrom(payer, address(manager), uint128(-amount)),
                "PAY"
            );
            manager.settle();
        }
    }
}
