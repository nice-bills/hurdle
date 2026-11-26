// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Vm} from "forge-std/Vm.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {HurdleVault} from "../../src/HurdleVault.sol";
import {IHurdleVault} from "../../src/IHurdleVault.sol";
import {HurdleHook} from "../../src/HurdleHook.sol";

/// Stateful-invariant handler for HurdleVault.
/// Every action is bounded, wrapped in try/catch (a revert by design is not a failure) and counted in a
/// ghost variable. Ghosts also snapshot the pre-action settlement state so the invariant suite can assert
/// post-settlement guarantees that a later price move would otherwise erase.
contract Handler {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant Q96 = 1 << 96;

    // action kinds, used by _after to attribute bond movements
    uint8 private constant KIND_DEPOSIT = 1;
    uint8 private constant KIND_WITHDRAW = 2;
    uint8 private constant KIND_ROUNDTRIP = 3;
    uint8 private constant KIND_SWAP = 4;
    uint8 private constant KIND_WARP = 5;
    uint8 private constant KIND_SETTLE = 6;
    uint8 private constant KIND_REBALANCE = 7;
    uint8 private constant KIND_POST_BOND = 8;
    uint8 private constant KIND_RECLAIM = 9;

    HurdleVault public immutable vault;
    IPoolManager public immutable manager;
    PoolSwapTest public immutable swapRouter;
    HurdleHook public immutable hook;
    address public immutable curator;
    PoolId public immutable pid;
    address[3] public users;

    PoolKey public key;

    struct Snap {
        uint256 t; // totalSupply before the action (settle-time supply)
        uint256 x; // bondShares + curator free shares before the action (excluded holders)
        uint256 bond; // bond tokens before the action
        uint256 bondV; // bondValue() before the action
        uint256 b; // bondShares before
        uint256 c; // curator free shares before
        uint256 deficit; // deficit before
        uint256 startNav; // start.nav before
        uint64 startTs; // start.timestamp before
        uint256 user; // actor's shares before (deposit/withdraw)
        address actor;
        uint256 shares; // shares moved by the action
        bool fired;
    }

    // ---- ghost accounting -------------------------------------------------
    uint256 public ghostBondPosted; // successful postBond amounts (+ initial bond)
    uint256 public ghostBondPaid; // bond tokens moved to depositors on settlement
    uint256 public ghostBondReclaimed; // bond tokens returned by reclaimBond
    uint256 public ghostUnexplainedBondIncrease;
    uint256 public ghostBondPostMismatch;
    uint256 public ghostReclaimLeftBond;
    uint256 public ghostRevertedBondDrift;

    uint256 public ghostDepositOk;
    uint256 public ghostWithdrawOk;
    uint256 public ghostSwapOk;
    uint256 public ghostSettleOk;
    uint256 public ghostRebalanceOk;
    uint256 public ghostPostBondOk;
    uint256 public ghostReclaimOk;
    uint256 public ghostWarps;

    uint256 public ghostSettlements;
    uint256 public ghostCoveredSettlements; // settlements where the bond could cover the depositor shortfall
    uint256 public ghostCoveredSettleViolations; // ... and depositors were left below par by > 1 bp
    uint256 public ghostWorstOwed;
    uint256 public ghostWorstPaid;
    // last settlement, for coverage assertions
    uint256 public lastNav;
    uint256 public lastBench;
    uint256 public lastPaid;
    uint256 public ghostSettleDeficitViolations;
    uint256 public ghostWorstDeficit;
    uint256 public ghostWorstDeficitNav;

    uint256 public ghostSettleRevertsAfterEpoch;
    bool public ghostFiredSeen;

    uint256 public ghostRoundTrips;
    uint256 public ghostRoundTripViolations;
    uint256 public ghostWorstProfit; // max(outValue - inValue) over a deposit->withdraw round trip
    uint256 public ghostWorstProfitIn;
    uint256 public ghostWorstProfitOut;

    // ---- audit3 ghosts ----------------------------------------------------
    // 1. deficit reconciliation
    uint256 public ghostDeficitPaid; // sum of Settled.shortfallPaid
    uint256 public ghostDeficitRecouped; // depositors' dilution from recoups, derived from Settled.take
    uint256 public ghostDeficitForgiven; // deficit that left with exiting depositors (or reclaimBond)
    uint256 public ghostDeficitPaydown; // postBond paydown
    uint256 public ghostDeficitUnexplained; // actions whose deficit change differs from the derived one
    // 3, 6, 7, 8, 9, 10: per-action violation counters
    uint256 public ghostConservationViolations;
    uint256 public ghostShortfallEffectViolations;
    uint256 public ghostCarryGateViolations;
    uint256 public ghostFiredDepositViolations;
    uint256 public ghostWithdrawSplitViolations;
    uint256 public ghostParPerShareViolations;
    uint256 public ghostDeficitPerShareViolations;
    uint256 public ghostCuratorActions;
    uint256 public ghostKeeperSettles;
    // 11. every address that ever received bounty shares
    address[] public seenHolders;
    mapping(address => bool) public isSeen;
    address[3] public keepers = [address(0xBEEF01), address(0xBEEF02), address(0xBEEF03)];

    constructor(
        HurdleVault _vault,
        IPoolManager _manager,
        PoolKey memory _key,
        PoolSwapTest _swapRouter,
        HurdleHook _hook,
        address _curator,
        address[3] memory _users
    ) {
        vault = _vault;
        manager = _manager;
        key = _key;
        pid = _key.toId();
        swapRouter = _swapRouter;
        hook = _hook;
        curator = _curator;
        users = _users;
        // the vault's bond at handler deployment is the ghost baseline
        ghostBondPosted = _vault.bond();
    }

    // ---------------------------------------------------------------------
    // actions
    // ---------------------------------------------------------------------

    /// Depositor buys shares in kind, forced into a settlement window so the path is exercised.
    function deposit(uint256 userSeed, uint256 sharesSeed) external {
        address user = users[userSeed % 3];
        uint256 shares = _depositShares(sharesSeed);
        _warpIntoDepositWindow();
        Snap memory s = _snap();
        s.actor = user;
        s.user = vault.balanceOf(user);
        s.shares = shares;
        vm.prank(user);
        bool ok;
        try vault.deposit(shares, type(uint256).max, type(uint256).max) {
            ok = true;
            ghostDepositOk++;
        } catch {}
        _after(s, KIND_DEPOSIT, ok);
    }

    /// Curator co-invests in kind (raises x/t, where finding A showed).
    function curatorDeposit(uint256 sharesSeed) external {
        uint256 shares = _depositShares(sharesSeed);
        _warpIntoDepositWindow();
        Snap memory s = _snap();
        s.actor = curator;
        s.user = vault.balanceOf(curator);
        s.shares = shares;
        vm.prank(curator);
        bool ok;
        try vault.deposit(shares, type(uint256).max, type(uint256).max) {
            ok = true;
            ghostDepositOk++;
            ghostCuratorActions++;
        } catch {}
        _after(s, KIND_DEPOSIT, ok);
    }

    /// Curator withdraws some of its free shares.
    function curatorWithdraw(uint256 sharesSeed) external {
        uint256 bal = vault.balanceOf(curator);
        if (bal == 0) return;
        uint256 shares = _bound(sharesSeed, 1, bal);
        Snap memory s = _snap();
        s.actor = curator;
        s.user = vault.balanceOf(curator);
        s.shares = shares;
        vm.prank(curator);
        bool ok;
        try vault.withdraw(shares) {
            ok = true;
            ghostWithdrawOk++;
            ghostCuratorActions++;
        } catch {}
        _after(s, KIND_WITHDRAW, ok);
    }

    /// A keeper (a fresh non-curator address) settles on schedule and collects the bounty.
    function keeperSettle(uint256 keeperSeed) external {
        uint256 es = vault.epochStart();
        uint256 ee = vault.epochSeconds();
        if (block.timestamp < es + ee) vm.warp(es + ee);
        Snap memory s = _snap();
        bool ok;
        vm.prank(keepers[keeperSeed % 3]);
        try vault.settle() {
            ok = true;
            ghostSettleOk++;
            ghostKeeperSettles++;
        } catch {
            ghostSettleRevertsAfterEpoch++;
        }
        _after(s, KIND_SETTLE, ok);
    }

    /// Depositor exits pro-rata.
    function withdraw(uint256 userSeed, uint256 sharesSeed) external {
        address user = users[userSeed % 3];
        uint256 bal = vault.balanceOf(user);
        if (bal == 0) return;
        uint256 shares = _bound(sharesSeed, 1, bal);
        Snap memory s = _snap();
        s.actor = user;
        s.user = vault.balanceOf(user);
        s.shares = shares;
        vm.prank(user);
        bool ok;
        try vault.withdraw(shares) {
            ok = true;
            ghostWithdrawOk++;
        } catch {}
        _after(s, KIND_WITHDRAW, ok);
    }

    /// Invariant 7 probe: deposit and immediately withdraw the same shares in the same block.
    function depositThenWithdraw(uint256 userSeed, uint256 sharesSeed) external {
        address user = users[userSeed % 3];
        uint256 shares = _depositShares(sharesSeed);
        _warpIntoDepositWindow();
        Snap memory s = _snap();
        s.actor = user;
        s.user = vault.balanceOf(user);
        s.shares = shares;

        vm.prank(user);
        bool ok;
        uint256 in0;
        uint256 in1;
        try vault.deposit(shares, type(uint256).max, type(uint256).max) returns (uint256 a0, uint256 a1) {
            ok = true;
            in0 = a0;
            in1 = a1;
        } catch {}
        if (!ok) {
            _after(s, KIND_DEPOSIT, false);
            return;
        }
        ghostDepositOk++;

        vm.prank(user);
        try vault.withdraw(shares) returns (uint256 o0, uint256 o1) {
            ghostWithdrawOk++;
            uint256 inV = _twapValue(in0, in1);
            uint256 outV = _twapValue(o0, o1);
            ghostRoundTrips++;
            if (outV > inV) {
                uint256 profit = outV - inV;
                if (profit > ghostWorstProfit) {
                    ghostWorstProfit = profit;
                    ghostWorstProfitIn = inV;
                    ghostWorstProfitOut = outV;
                }
                if (outV > inV + inV / 10_000 + 1e6) ghostRoundTripViolations++;
            }
        } catch {}
        _after(s, KIND_ROUNDTRIP, true);
    }

    /// Random exact-input swap through PoolSwapTest. Direction is biased to keep the price crossing the
    /// vault's range: while spot is inside the range the seed picks the side, and once spot leaves the
    /// range the handler reverses and pushes the price back through it. That repeatedly leaves the
    /// concentrated position holding the losing token (all token0 below the range, all token1 above),
    /// which is what makes random settlements miss par and actually pay a shortfall.
    function swap(uint256 sizeSeed, uint256 directionSeed) external {
        uint256 amountIn = _bound(sizeSeed, 1e15, 400e18);
        (int24 lo, int24 hi,) = vault.position();
        (, int24 spot,,) = manager.getSlot0(pid);
        bool zeroForOne;
        if (hi > lo && spot >= hi) {
            zeroForOne = true; // above the range: sell back down into it
        } else if (hi > lo && spot <= lo) {
            zeroForOne = false; // below the range: buy back up into it
        } else {
            zeroForOne = directionSeed % 2 == 0;
        }
        Snap memory s = _snap();
        bool ok;
        try swapRouter.swap(
            key,
            IPoolManager.SwapParams(
                zeroForOne,
                -int256(amountIn),
                zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            ),
            PoolSwapTest.TestSettings(false, false),
            ""
        ) {
            ok = true;
            ghostSwapOk++;
        } catch {}
        _after(s, KIND_SWAP, ok);
    }

    /// Time passes: TWAP catches up, epochs end.
    function warp(uint256 secondsSeed) external {
        uint256 dt = _bound(secondsSeed, 60, 3600);
        Snap memory s = _snap();
        vm.warp(block.timestamp + dt);
        ghostWarps++;
        _after(s, KIND_WARP, true);
    }

    /// Settle, after moving time to at least the epoch end, and record whether it reverted.
    function settle() external {
        uint256 es = vault.epochStart();
        uint256 ee = vault.epochSeconds();
        if (block.timestamp < es + ee) vm.warp(es + ee);
        Snap memory s = _snap();
        bool ok;
        try vault.settle() {
            ok = true;
            ghostSettleOk++;
        } catch {
            // invariant 6: once the epoch is over settle() must not revert
            ghostSettleRevertsAfterEpoch++;
        }
        _after(s, KIND_SETTLE, ok);
    }

    /// Curator rebalance to a random aligned range around spot.
    function rebalance(uint256 centerSeed, uint256 widthSeed, uint256 idleSeed) external {
        int24 sp = int24(uint24(key.tickSpacing));
        (, int24 spot,,) = manager.getSlot0(pid);
        int24 offset = int24(int256(_bound(centerSeed, 0, 2400))) - 1200;
        int24 center = _floorToSpacing(spot + offset, sp);
        int24 width = int24(int256(_bound(widthSeed, 1, 20))) * sp;
        // Centre the range on `center`: a range whose edge sits on spot is degenerate (the position is
        // all one token there, so a swap during the redeploy leaves nothing to mint liquidity with).
        int24 lo = center - width;
        int24 hi = center + width;
        int24 minTick = TickMath.minUsableTick(sp);
        int24 maxTick = TickMath.maxUsableTick(sp);
        if (lo < minTick) lo = minTick;
        if (hi > maxTick) hi = maxTick;
        if (hi <= lo) return;
        uint16 maxIdle = uint16(_bound(idleSeed, 5000, 10_000));

        Snap memory s = _snap();
        vm.prank(curator);
        bool ok;
        try vault.rebalance(lo, hi, maxIdle) {
            ok = true;
            ghostRebalanceOk++;
        } catch {}
        _after(s, KIND_REBALANCE, ok);
    }

    /// Curator tops up the bond.
    function postBond(uint256 amountSeed) external {
        uint256 amt = _bound(amountSeed, 1, 2e17);
        Snap memory s = _snap();
        s.shares = amt; // the posted amount
        vm.prank(curator);
        bool ok;
        try vault.postBond(amt) {
            ok = true;
            ghostPostBondOk++;
            ghostBondPosted += amt;
        } catch {}
        _after(s, KIND_POST_BOND, ok);
        if (ok && vault.bond() != s.bond + amt) ghostBondPostMismatch++;
    }

    /// Curator takes the bond back after firing + parking + an epoch.
    function reclaimBond() external {
        Snap memory s = _snap();
        vm.prank(curator);
        bool ok;
        try vault.reclaimBond() {
            ok = true;
            ghostReclaimOk++;
        } catch {}
        _after(s, KIND_RECLAIM, ok);
    }

    // ---------------------------------------------------------------------
    // views for the invariant suite
    // ---------------------------------------------------------------------

    /// Sum of shares over every address that can hold vault shares in this suite, plus the locked bond
    /// shares (held by the vault itself, outside `balanceOf`).
    function sumShares() external view returns (uint256 sum) {
        sum = vault.balanceOf(address(0)) + vault.balanceOf(curator) + vault.balanceOf(address(this))
            + vault.bondShares();
        for (uint256 i; i < 3; ++i) {
            sum += vault.balanceOf(users[i]);
        }
        // every address that ever received a SettlerPaid bounty (keepers, depositors that settled implicitly)
        for (uint256 i; i < seenHolders.length; ++i) {
            address h = seenHolders[i];
            if (h == address(0) || h == curator || h == address(this) || _isUser(h)) continue;
            sum += vault.balanceOf(h);
        }
    }

    function _isUser(address a) internal view returns (bool) {
        return a == users[0] || a == users[1] || a == users[2];
    }

    function seenHoldersLength() external view returns (uint256) {
        return seenHolders.length;
    }

    // ---------------------------------------------------------------------
    // internals
    // ---------------------------------------------------------------------

    function _snap() internal returns (Snap memory s) {
        s.t = vault.totalSupply();
        s.x = vault.bondShares() + vault.balanceOf(curator);
        s.bond = vault.bond();
        s.b = vault.bondShares();
        s.c = vault.balanceOf(curator);
        s.deficit = vault.deficit();
        s.fired = vault.fired();
        (s.startTs,,,, s.startNav) = vault.start();
        try vault.bondValue() returns (uint256 v) {
            s.bondV = v;
        } catch {}
        vm.recordLogs();
    }

    function _after(Snap memory s, uint8 kind, bool ok) internal {
        if (vault.fired()) ghostFiredSeen = true;

        if (!ok) {
            if (vault.bond() != s.bond) ghostRevertedBondDrift++;
            vm.getRecordedLogs();
            return;
        }

        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 reclaimTokens;
        Ev memory e;
        for (uint256 i; i < logs.length; ++i) {
            bytes32 topic = logs[i].topics[0];
            if (topic == IHurdleVault.Settled.selector) {
                _onSettled(logs[i].data, s);
                e.settled = true;
                (e.nav, e.bench, e.take, e.paid,,) =
                    abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256, uint160));
            } else if (topic == IHurdleVault.SettlerPaid.selector) {
                address who = address(uint160(uint256(logs[i].topics[1])));
                e.bounty += abi.decode(logs[i].data, (uint256));
                e.bountyTo = who;
                if (!isSeen[who]) {
                    isSeen[who] = true;
                    seenHolders.push(who);
                }
            } else if (topic == IHurdleVault.BondReclaimed.selector) {
                (uint256 tokens,) = abi.decode(logs[i].data, (uint256, uint256));
                reclaimTokens += tokens;
            }
        }

        _audit3Checks(s, kind, e);

        uint256 bondNow = vault.bond();
        if (kind == KIND_RECLAIM) {
            // a reclaim can also settle a finished epoch first, so split the fall into paid + reclaimed
            ghostBondReclaimed += reclaimTokens;
            if (s.bond >= reclaimTokens) ghostBondPaid += s.bond - reclaimTokens;
            if (bondNow != 0) ghostReclaimLeftBond++;
        } else if (bondNow < s.bond) {
            ghostBondPaid += s.bond - bondNow;
        } else if (bondNow > s.bond && kind != KIND_POST_BOND) {
            ghostUnexplainedBondIncrease += bondNow - s.bond;
        }
    }

    struct Ev {
        bool settled;
        uint256 nav;
        uint256 bench;
        uint256 take;
        uint256 paid;
        uint256 bounty;
        address bountyTo;
    }

    /// Audit 3 per-action checks (invariants 1, 3, 6, 7, 8, 9, 10). Tolerances are rounding only.
    function _audit3Checks(Snap memory s, uint8 kind, Ev memory e) internal {
        _chkDeficit(s, kind, e);
        _chkSettle(s, kind, e);
        _chkFlow(s, kind, e);
    }

    function _chkDeficit(Snap memory s, uint8 kind, Ev memory e) internal {
        uint256 dAfter = vault.deficit();

        // ---- 1. deficit reconciliation -----------------------------------------------------------
        uint256 paid = e.settled ? e.paid : 0;
        uint256 recoupDrop;
        if (e.settled && e.paid == 0 && e.nav > e.bench && e.take > 0 && !s.fired && s.t > s.x) {
            uint256 exc = e.nav - e.bench;
            uint256 c = vault.carryBps();
            uint256 carryPart = FullMath.mulDiv(exc, c, 10_000);
            uint256 r = e.take > carryPart ? FullMath.mulDiv(e.take - carryPart, 10_000, 10_000 - c) : 0;
            uint256 dep = s.t - s.x;
            recoupDrop = FullMath.mulDiv(r, dep, s.t);
            if (recoupDrop > s.deficit) recoupDrop = s.deficit;
        }
        uint256 paydown = kind == KIND_POST_BOND ? (s.shares < s.deficit ? s.shares : s.deficit) : 0;
        // deficit_after should equal before + paid - recoup - paydown - forgiven
        uint256 expectedHi = s.deficit + paid;
        uint256 minus = recoupDrop + paydown;
        uint256 forgiven;
        if (expectedHi >= minus + dAfter) forgiven = expectedHi - minus - dAfter;
        else if (minus + dAfter - expectedHi > 1e6) ghostDeficitUnexplained++; // deficit above what the events allow
        bool exits = kind == KIND_WITHDRAW || kind == KIND_ROUNDTRIP || kind == KIND_RECLAIM;
        if (forgiven > 1e6 && !exits) ghostDeficitUnexplained++; // deficit vanished outside an exit
        if (forgiven > s.deficit + paid) ghostDeficitUnexplained++;
        ghostDeficitPaid += paid;
        ghostDeficitRecouped += recoupDrop;
        ghostDeficitPaydown += paydown;
        ghostDeficitForgiven += forgiven;

    }

    function _chkSettle(Snap memory s, uint8 kind, Ev memory e) internal {
        uint256 tAfter = vault.totalSupply();
        uint256 cAfter = vault.balanceOf(curator);
        bool firedNow = vault.fired();
        bool pureSettle = kind == KIND_SETTLE;
        // ---- 3. value conservation across a settle (no external flow) ----------------------------
        if (pureSettle && e.settled && !firedNow && !s.fired) {
            uint256 pre = e.nav + s.bond;
            uint256 post = vault.nav() + vault.bond();
            uint256 tol = pre / 1e9 + 1e3;
            if (post + tol < pre || pre + tol < post) ghostConservationViolations++;
        }

        // ---- 6. shortfall effect -----------------------------------------------------------------
        if (pureSettle && e.settled && e.paid > 0 && !firedNow && !s.fired && s.t > 0) {
            uint256 bondBefore = s.bond + FullMath.mulDiv(s.b, e.nav, s.t);
            uint256 bondAfter = vault.bondValue();
            uint256 tol = e.nav / 1e9 + 1e3;
            uint256 fall = bondBefore > bondAfter ? bondBefore - bondAfter : 0;
            if (fall + tol < e.paid || e.paid + tol < fall) ghostShortfallEffectViolations++;
            uint256 cBefore = FullMath.mulDiv(s.c, e.nav, s.t);
            uint256 cNow = FullMath.mulDiv(cAfter, vault.nav(), tAfter);
            if (cBefore > cNow + tol || cNow > cBefore + tol) ghostShortfallEffectViolations++;
        }

        // ---- 7. carry gate -----------------------------------------------------------------------
        if (e.settled && e.nav >= e.bench && e.paid != 0) ghostCarryGateViolations++;
        if (pureSettle && e.settled && e.nav >= e.bench && !s.fired && e.take > 0 && e.take < e.nav) {
            uint256 ns = FullMath.mulDiv(e.take, s.t, e.nav - e.take);
            if (tAfter + 1 < s.t + ns || tAfter > s.t + ns + 1) ghostCarryGateViolations++;
            if (e.bounty * 10_000 > ns * 500) ghostCarryGateViolations++;
        }

    }

    function _chkFlow(Snap memory s, uint8 kind, Ev memory e) internal {
        uint256 dAfter = vault.deficit();
        uint256 tAfter = vault.totalSupply();
        uint256 cAfter = vault.balanceOf(curator);
        uint256 bAfter = vault.bondShares();
        bool firedNow = vault.fired();
        // ---- 8. fired deposits are only taken while parked ---------------------------------------
        if ((kind == KIND_DEPOSIT || kind == KIND_ROUNDTRIP) && firedNow && s.actor != address(0)) {
            (int24 lo, int24 hi,) = vault.position();
            int24 sp = int24(uint24(key.tickSpacing));
            if (lo != TickMath.minUsableTick(sp) || hi != TickMath.maxUsableTick(sp)) {
                // a deposit only counts here if it succeeded; the roundtrip kind always succeeded on deposit
                ghostFiredDepositViolations++;
            }
        }

        // ---- 9. withdraw split: burn + paidShares == shares; curator + bond gain == paidShares ----
        if (kind == KIND_WITHDRAW && !e.settled && s.actor != address(0)) {
            uint256 userAfter = vault.balanceOf(s.actor);
            uint256 gained = cAfter + bAfter >= s.c + s.b ? (cAfter + bAfter) - (s.c + s.b) : type(uint256).max;
            if (s.actor == curator) {
                // curator exits: it pays nothing to itself and burns exactly `shares`
                if (s.user - userAfter != s.shares || s.t - tAfter != s.shares) ghostWithdrawSplitViolations++;
            } else {
                if (s.user - userAfter != s.shares) ghostWithdrawSplitViolations++;
                uint256 burn = s.t - tAfter;
                if (burn + gained != s.shares) ghostWithdrawSplitViolations++;
            }
        }

        // ---- 10. par per share and deficit per depositor share across deposit / withdraw ---------
        bool plain = !e.settled && s.actor != address(0) && s.startTs == _startTs() && s.c == cAfter && s.b == bAfter;
        if (plain && (kind == KIND_DEPOSIT || kind == KIND_WITHDRAW) && vault.balanceOf(s.actor) != s.user) {
            (,,,, uint256 sn) = vault.start();
            if (s.startNav > 0 && s.t > 0) {
                uint256 lhs = sn * s.t;
                uint256 rhs = s.startNav * tAfter;
                uint256 diff = lhs > rhs ? lhs - rhs : rhs - lhs;
                if (diff > rhs / 1e15 + s.t * 2 + tAfter * 2) ghostParPerShareViolations++;
            }
            if (kind == KIND_WITHDRAW && s.actor != curator && s.deficit > 0 && s.t > s.x && tAfter > s.x) {
                uint256 lhs = dAfter * (s.t - s.x);
                uint256 rhs = s.deficit * (tAfter - s.x);
                uint256 diff = lhs > rhs ? lhs - rhs : rhs - lhs;
                if (diff > rhs / 1e12 + (s.t - s.x) * 2) ghostDeficitPerShareViolations++;
            }
        }
    }

    function _startTs() internal view returns (uint64 ts) {
        (ts,,,,) = vault.start();
    }

    /// Checks the post-settlement depositor guarantee from the Settled event, using the pre-action
    /// supply/excluded shares snapshot (settlement always runs before a deposit/withdraw changes them).
    function _onSettled(bytes memory data, Snap memory s) internal {
        (uint256 nav, uint256 bench, uint256 take, uint256 paid, uint256 bondAfter, uint160 price) =
            abi.decode(data, (uint256, uint256, uint256, uint256, uint256, uint160));
        lastNav = nav;
        lastBench = bench;
        lastPaid = paid;
        nav;
        take;
        bondAfter;
        price;
        ghostSettlements++;

        if (bench > nav && s.t > s.x) {
            uint256 owed = FullMath.mulDiv(bench - nav, s.t - s.x, s.t);
            // "Covered" = the bond is worth what it takes to make depositors whole. Bond shares burn at their
            // depositor-weighted value and bond tokens are grossed up for the curator's free shares, so the need
            // is owed * (t - b) / (t - x) (at most the whole shortfall); a bond worth only `owed` is not covered.
            uint256 need = FullMath.mulDiv(owed, s.t - s.b, s.t - s.x);
            if (owed > 0 && s.bondV >= need + need / 10_000) {
                ghostCoveredSettlements++;
                uint256 tol = owed / 10_000 + 1; // 1 bp rounding tolerance
                if (paid + tol < owed) {
                    ghostCoveredSettleViolations++;
                    if (owed - paid > ghostWorstOwed - ghostWorstPaid) {
                        ghostWorstOwed = owed;
                        ghostWorstPaid = paid;
                    }
                }
            }
        }

        // deficit may never exceed NAV at a settlement (it is created by a payment that was <= NAV)
        uint256 d = vault.deficit();
        try vault.nav() returns (uint256 n) {
            if (d > n + n / 10_000 + 1) {
                ghostSettleDeficitViolations++;
                ghostWorstDeficit = d;
                ghostWorstDeficitNav = n;
            }
        } catch {}
    }

    /// Bounded deposit size: a fraction of supply, so the capacity cap is exercised but not always hit.
    function _depositShares(uint256 seed) internal view returns (uint256) {
        uint256 cap = vault.totalSupply() / 4;
        if (cap < 1e12) cap = 1e12;
        return _bound(seed, 1e12, cap);
    }

    function _warpIntoDepositWindow() internal {
        uint256 es = vault.epochStart();
        uint256 ee = vault.epochSeconds();
        if (block.timestamp > es + vault.DEPOSIT_WINDOW()) {
            uint256 target = es + ee;
            if (target > block.timestamp) vm.warp(target);
        }
    }

    function _twapValue(uint256 a0, uint256 a1) internal view returns (uint256) {
        uint160 s = TickMath.getSqrtPriceAtTick(hook.twapTick(pid));
        return FullMath.mulDiv(FullMath.mulDiv(a0, s, Q96), s, Q96) + a1;
    }

    function _floorToSpacing(int24 tick, int24 spacing) internal pure returns (int24 c) {
        c = (tick / spacing) * spacing;
        if (tick < 0 && tick % spacing != 0) c -= spacing;
    }

    function _bound(uint256 x, uint256 min, uint256 max) internal pure returns (uint256) {
        if (max <= min) return min;
        return min + (x % (max - min + 1));
    }
}
