// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test, Vm} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {FullMath} from "v4-core/src/libraries/FullMath.sol";
import {PoolSwapTest} from "v4-core/src/test/PoolSwapTest.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {LiquidityAmounts} from "v4-core/test/utils/LiquidityAmounts.sol";
import {HurdleHook} from "../src/HurdleHook.sol";
import {HurdleVault} from "../src/HurdleVault.sol";
import {IHurdleVault} from "../src/IHurdleVault.sol";
import {HookMiner} from "./utils/HookMiner.sol";

/// Replays a real swap price path (data/weeks/*.csv) through a local v4 pool with Hurdle attached,
/// with two curators: Patient (static ±10%) and Chaser (±2%, re-anchored whenever price leaves it).
/// Every swap is swap-to-price at the row's sqrtPriceX96, so fee growth per unit L depends only on
/// the price path. Settles hourly and writes one CSV row per settlement for demo/build_json.py.
/// Run: REPLAY_CSV=data/weeks/2026-10-31.csv REPLAY_OUT=demo/out/range-week.csv \
///      forge test --match-contract ReplayTest -vv
contract ReplayTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    int24 constant SPACING = 10;
    uint32 constant EPOCH = 3600;
    int24 constant PATIENT_HALF = 950; // ~±10%
    int24 constant CHASER_HALF = 200; // ~±2%
    uint256 constant Q96 = 1 << 96;
    uint256 constant POOL_HISTORY = 700; // > HurdleHook.MIN_TWAP_WINDOW (600)

    address constant DEPOSITOR = address(0xA1);
    address constant PATIENT = address(0xC1);
    address constant CHASER = address(0xC2);

    HurdleHook hook;
    HurdleVault patient;
    HurdleVault chaser;

    struct Track {
        uint256 par; // 1e18-scaled, compounding bench/startNav
        uint256 produced; // 1e18-scaled, compounding (nav - paid)/startNav: the curator's own result
        uint256 take;
        uint256 paid;
        uint256 initialValue;
        uint256 initialCapital;
        bool firedLogged;
        uint256 firedDay; // days since replay start, x100, when the vault fired (0 = never)
    }

    Track tp;
    Track tc;
    uint256 lastChase;
    uint256 settlements;
    uint256 minDepositorVsPar; // lowest depositor_value / par seen at any settlement, 1e18 scale
    uint256 t0_;

    function test_replay() public {
        string memory csv = vm.envOr("REPLAY_CSV", string(""));
        if (bytes(csv).length == 0) vm.skip(true); // opt-in: shows as skipped, not as a silent pass
        string memory out = vm.envOr("REPLAY_OUT", string("demo/out/replay.csv"));

        vm.readLine(csv); // header
        (uint256 t0, uint160 s0) = _row(vm.readLine(csv));
        _setUp(t0, s0);
        t0_ = t0;
        minDepositorVsPar = type(uint256).max;

        vm.writeFile(out, "t,sqrtPriceX96,twapSqrtPriceX96,par,p_nav,p_dep,p_bond,p_carry,p_paid,p_fired,c_nav,c_dep,c_bond,c_carry,c_paid,c_fired\n");
        _writeRow(out, t0);

        uint256 nextSettle = t0 + EPOCH;
        uint256 rows;
        while (true) {
            string memory line = vm.readLine(csv);
            if (bytes(line).length == 0) break;
            (uint256 t, uint160 s) = _row(line);
            if (t > block.timestamp) vm.warp(t);
            if (t >= nextSettle) {
                _settleBoth();
                _writeRow(out, t);
                nextSettle = t + EPOCH;
            }
            _swapTo(s);
            _maybeChase();
            ++rows;
        }
        emit log_named_uint("rows replayed", rows);
        emit log_named_uint("patient depositor 1e18", _depositorRatio(patient, tp));
        emit log_named_uint("chaser depositor 1e18", _depositorRatio(chaser, tc));
        emit log_named_uint("par 1e18", tp.par);
        emit log_named_uint("settlements", settlements);
        emit log_named_uint("chaser rebalances refused: BondBelowFloor", chaseBelowFloor);
        emit log_named_uint("chaser rebalances refused: other (PriceDeviation etc.)", chaseOtherRevert);
        emit log_named_uint("patient fired", patient.fired() ? 1 : 0);
        emit log_named_uint("chaser fired", chaser.fired() ? 1 : 0);
        emit log_named_uint("patient day fired (x100)", tp.firedDay);
        emit log_named_uint("chaser day fired (x100)", tc.firedDay);
        emit log_named_uint("chaser par 1e18", tc.par);
        emit log_named_uint("min depositor/par 1e18 over all settlements", minDepositorVsPar);

        // A settle() revert would have aborted the replay above; make sure settlements really ran.
        assertGt(settlements, 0, "no settlement happened");
        // Final depositor value covers par (benchmark) within 1 bp, for each vault.
        assertGe(_depositorRatio(patient, tp) * 10_000, tp.par * 9_999, "patient depositor below par");
        assertGe(_depositorRatio(chaser, tc) * 10_000, tc.par * 9_999, "chaser depositor below par");
        // ...and at every settlement along the way.
        assertGe(minDepositorVsPar, 0.9999e18, "depositor fell below par at a settlement");
    }

    // ---------------------------------------------------------------------

    /// The pool is initialized POOL_HISTORY before the first real swap so the hook's TWAP has the
    /// 10 minutes of history the vault requires; the vaults then deposit at t0 (twap == spot == s0).
    function _setUp(uint256 t0, uint160 s0) internal {
        vm.warp(t0 - POOL_HISTORY);
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();
        uint160 flags = uint160(
            Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_DONATE_FLAG
        );
        (, bytes32 salt) = HookMiner.find(address(this), flags, type(HurdleHook).creationCode, abi.encode(manager));
        hook = new HurdleHook{salt: salt}(manager);

        LIQUIDITY_PARAMS = IPoolManager.ModifyLiquidityParams(
            TickMath.minUsableTick(SPACING), TickMath.maxUsableTick(SPACING), 1e21, 0
        );
        (key,) = initPool(currency0, currency1, IHooks(address(hook)), 500, SPACING, s0);
        modifyLiquidityRouter.modifyLiquidity(key, LIQUIDITY_PARAMS, ZERO_BYTES);
        vm.warp(t0);

        // $1M USDC-equivalent of token0 + equal value of token1; bond = 5% of NAV in token1.
        uint256 a0 = 1e12;
        uint256 a1 = FullMath.mulDiv(FullMath.mulDiv(a0, s0, Q96), s0, Q96);
        patient = _vault(PATIENT, a0, a1, a1 / 10);
        chaser = _vault(CHASER, a0, a1, a1 / 10);

        int24 c = _floor(_tick());
        vm.prank(PATIENT);
        patient.rebalance(c - PATIENT_HALF, c + PATIENT_HALF);
        vm.prank(CHASER);
        chaser.rebalance(c - CHASER_HALF, c + CHASER_HALF);

        tp = _track(patient);
        tc = _track(chaser);
    }

    function _vault(address curator, uint256 a0, uint256 a1, uint256 bondAmt) internal returns (HurdleVault v) {
        v = new HurdleVault(manager, key, curator, 2000, 200, 50, EPOCH);
        _give(curator, address(v), a0, a1 + bondAmt);
        vm.startPrank(curator);
        v.postBond(bondAmt);
        v.firstDeposit(a0, a1, DEPOSITOR); // curator pays, shares go to a non-curator depositor the bond covers
        vm.stopPrank();
    }

    function _track(HurdleVault v) internal view returns (Track memory t) {
        t.par = 1e18;
        t.produced = 1e18;
        t.initialValue = v.nav();
        t.initialCapital = t.initialValue;
    }

    function _give(address who, address spender, uint256 a0, uint256 a1) internal {
        MockERC20(Currency.unwrap(currency0)).transfer(who, a0);
        MockERC20(Currency.unwrap(currency1)).transfer(who, a1);
        vm.startPrank(who);
        MockERC20(Currency.unwrap(currency0)).approve(spender, type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(spender, type(uint256).max);
        vm.stopPrank();
    }

    function _row(string memory line) internal pure returns (uint256 t, uint160 s) {
        string[] memory f = vm.split(line, ",");
        t = vm.parseUint(f[1]);
        s = uint160(vm.parseUint(f[5]));
    }

    function _swapTo(uint160 target) internal {
        (uint160 now_,,,) = manager.getSlot0(key.toId());
        if (target == now_) return;
        swapRouter.swap(
            key,
            IPoolManager.SwapParams(target < now_, -int256(1e40), target),
            PoolSwapTest.TestSettings(false, false),
            ZERO_BYTES
        );
    }

    /// Chaser: when price leaves its ±2% range, re-center 50/50 on spot (the vault swaps to ratio),
    /// at most every 10 min. This is the re-centering strategy the Bitquery data says loses.
    uint256 chaseBelowFloor; // chases refused because the bond drifted under the floor
    uint256 chaseOtherRevert; // chases refused for other reasons (e.g. PriceDeviation while TWAP lags)

    function _maybeChase() internal {
        if (chaser.fired() || block.timestamp < lastChase + 600) return;
        (int24 lo, int24 hi,) = chaser.position();
        int24 t = _tick();
        if (t >= lo && t < hi) return;
        int24 c = _floor(t);
        vm.prank(CHASER);
        try chaser.rebalance(c - CHASER_HALF, c + CHASER_HALF) {}
        catch (bytes memory err) {
            if (bytes4(err) == HurdleVault.BondBelowFloor.selector) chaseBelowFloor++;
            else chaseOtherRevert++;
        }
        lastChase = block.timestamp;
    }

    function _settleBoth() internal {
        _settle(patient, tp);
        _settle(chaser, tc);
        settlements++;
        _checkVsPar(patient, tp);
        _checkVsPar(chaser, tc);
        // Keeper: a fired vault is re-parked full range once spot is near TWAP again.
        if (patient.fired()) try patient.rebalance(0, 0) {} catch {}
        if (chaser.fired()) try chaser.rebalance(0, 0) {} catch {}
    }

    function _settle(HurdleVault v, Track storage tr) internal {
        (,,,, uint256 startNav) = v.start();
        uint256 deficitBefore = v.deficit();
        vm.recordLogs();
        v.settle();
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].emitter != address(v) || logs[i].topics[0] != IHurdleVault.Settled.selector) continue;
            (uint256 nav, uint256 bench, uint256 take, uint256 paid,,) =
                abi.decode(logs[i].data, (uint256, uint256, uint256, uint256, uint256, uint160));
            tr.par = FullMath.mulDiv(tr.par, bench, startNav);
            tr.produced = FullMath.mulDiv(tr.produced, nav, startNav);
            uint256 recoup = paid == 0 && deficitBefore > v.deficit() ? deficitBefore - v.deficit() : 0;
            tr.take += take - recoup; // carry only; the recoup shows up as bond refill
            tr.paid += paid;
        }
    }

    function _checkVsPar(HurdleVault v, Track storage tr) internal {
        if (v.fired() && tr.firedDay == 0) tr.firedDay = (block.timestamp - t0_) * 100 / 1 days;
        uint256 r = FullMath.mulDiv(_depositorRatio(v, tr), 1e18, tr.par);
        if (r < minDepositorVsPar) minDepositorVsPar = r;
    }

    function _depositorRatio(HurdleVault v, Track storage tr) internal view returns (uint256) {
        uint256 value = FullMath.mulDiv(v.nav(), v.balanceOf(DEPOSITOR), v.totalSupply());
        return FullMath.mulDiv(value, 1e18, tr.initialValue);
    }

    function _writeRow(string memory out, uint256 t) internal {
        (uint160 sp,,,) = manager.getSlot0(key.toId());
        uint160 tw = TickMath.getSqrtPriceAtTick(hook.twapTick(key.toId()));
        string memory row = string.concat(vm.toString(t), ",", vm.toString(uint256(sp)), ",", vm.toString(uint256(tw)));
        row = string.concat(row, ",", vm.toString(tp.par));
        row = string.concat(row, ",", _vaultCols(patient, tp), ",", _vaultCols(chaser, tc));
        vm.writeLine(out, row);
    }

    function _vaultCols(HurdleVault v, Track storage tr) internal view returns (string memory) {
        uint256 cap = tr.initialCapital;
        return string.concat(
            vm.toString(tr.produced),
            ",",
            vm.toString(_depositorRatio(v, tr)),
            ",",
            vm.toString(FullMath.mulDiv(v.bondValue(), 1e18, cap)),
            ",",
            vm.toString(FullMath.mulDiv(tr.take, 1e18, cap)),
            ",",
            vm.toString(FullMath.mulDiv(tr.paid, 1e18, cap)),
            ",",
            v.fired() ? "1" : "0"
        );
    }

    function _tick() internal view returns (int24 t) {
        (, t,,) = manager.getSlot0(key.toId());
    }

    function _floor(int24 t) internal pure returns (int24 c) {
        c = (t / SPACING) * SPACING;
        if (t < 0 && t % SPACING != 0) c -= SPACING;
    }
}
