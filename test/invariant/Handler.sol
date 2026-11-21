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
        uint256 shares = _bound(sharesSeed, 1e15, 2e18);
        _warpIntoDepositWindow();
        Snap memory s = _snap();
        vm.prank(user);
        bool ok;
        try vault.deposit(shares, type(uint256).max, type(uint256).max) {
            ok = true;
            ghostDepositOk++;
        } catch {}
        _after(s, KIND_DEPOSIT, ok);
    }

    /// Depositor exits pro-rata.
    function withdraw(uint256 userSeed, uint256 sharesSeed) external {
        address user = users[userSeed % 3];
        uint256 bal = vault.balanceOf(user);
        if (bal == 0) return;
        uint256 shares = _bound(sharesSeed, 1, bal);
        Snap memory s = _snap();
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
        uint256 shares = _bound(sharesSeed, 1e15, 2e18);
        _warpIntoDepositWindow();
        Snap memory s = _snap();

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

    /// Random exact-input swap through PoolSwapTest, random direction.
    function swap(uint256 sizeSeed, uint256 directionSeed) external {
        uint256 amountIn = _bound(sizeSeed, 1e15, 100e18);
        bool zeroForOne = directionSeed % 2 == 0;
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
        int24 lo = center;
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

    /// Sum of shares over every address that can hold vault shares in this suite.
    function sumShares() external view returns (uint256 sum) {
        sum = vault.balanceOf(address(0)) + vault.balanceOf(curator) + vault.balanceOf(address(this));
        for (uint256 i; i < 3; ++i) {
            sum += vault.balanceOf(users[i]);
        }
    }

    // ---------------------------------------------------------------------
    // internals
    // ---------------------------------------------------------------------

    function _snap() internal returns (Snap memory s) {
        s.t = vault.totalSupply();
        s.x = vault.bondShares() + vault.balanceOf(curator);
        s.bond = vault.bond();
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
        for (uint256 i; i < logs.length; ++i) {
            bytes32 topic = logs[i].topics[0];
            if (topic == IHurdleVault.Settled.selector) {
                _onSettled(logs[i].data, s);
            } else if (topic == IHurdleVault.BondReclaimed.selector) {
                (uint256 tokens,) = abi.decode(logs[i].data, (uint256, uint256));
                reclaimTokens += tokens;
            }
        }

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

    /// Checks the post-settlement depositor guarantee from the Settled event, using the pre-action
    /// supply/excluded shares snapshot (settlement always runs before a deposit/withdraw changes them).
    function _onSettled(bytes memory data, Snap memory s) internal {
        (uint256 nav, uint256 bench, uint256 take, uint256 paid, uint256 bondAfter, uint160 price) =
            abi.decode(data, (uint256, uint256, uint256, uint256, uint256, uint160));
        nav;
        take;
        bondAfter;
        price;
        ghostSettlements++;

        if (bench > nav && s.t > s.x) {
            uint256 owed = FullMath.mulDiv(bench - nav, s.t - s.x, s.t);
            if (owed > 0 && s.bondV >= owed) {
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
        uint256 n = vault.nav();
        if (d > n + n / 10_000 + 1) {
            ghostSettleDeficitViolations++;
            ghostWorstDeficit = d;
            ghostWorstDeficitNav = n;
        }
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
