// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {Deployers} from "v4-core/test/utils/Deployers.sol";
import {Hooks} from "v4-core/src/libraries/Hooks.sol";
import {IHooks} from "v4-core/src/interfaces/IHooks.sol";
import {IPoolManager} from "v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "v4-core/src/types/PoolKey.sol";
import {PoolIdLibrary} from "v4-core/src/types/PoolId.sol";
import {StateLibrary} from "v4-core/src/libraries/StateLibrary.sol";
import {TickMath} from "v4-core/src/libraries/TickMath.sol";
import {MockERC20} from "solmate/src/test/utils/mocks/MockERC20.sol";
import {Currency} from "v4-core/src/types/Currency.sol";
import {HurdleHook} from "../../src/HurdleHook.sol";
import {HurdleVault} from "../../src/HurdleVault.sol";
import {HookMiner} from "../utils/HookMiner.sol";
import {Handler} from "./Handler.sol";

/// Stateful invariant suite for HurdleVault.
///
/// The handler drives deposits (in a settlement window), withdrawals, random PoolSwapTest swaps, time
/// warps, settlements, curator rebalances to random aligned ranges, bond top-ups and bond reclaims. Each
/// action is bounded and wrapped in try/catch, so reverts that are by design (window closed, price
/// deviation, too many rebalances, bond below floor, ...) do not fail a run. The invariants below only
/// look at ghosts the handler recorded (post-settlement values) where a later price move would otherwise
/// invalidate the check, and at live vault views otherwise.
///
/// forge-config: default.invariant.runs = 64
/// forge-config: default.invariant.depth = 64
///
/// (The two lines above are Foundry inline config, not prose.)
contract HurdleInvariantTest is Test, Deployers {
    using PoolIdLibrary for PoolKey;
    using StateLibrary for IPoolManager;

    int24 constant SPACING = 60;
    address constant CURATOR = address(0xC0);
    address constant ALICE = address(0xA1);
    address constant BOB = address(0xB0B);
    address constant CAROL = address(0xCA);

    HurdleHook hook;
    HurdleVault vault;
    Handler handler;

    function setUp() public {
        vm.warp(1_000_000);
        deployFreshManagerAndRouters();
        deployMintAndApprove2Currencies();

        uint160 flags = uint160(Hooks.BEFORE_SWAP_FLAG | Hooks.AFTER_INITIALIZE_FLAG | Hooks.BEFORE_DONATE_FLAG);
        (, bytes32 salt) = HookMiner.find(address(this), flags, type(HurdleHook).creationCode, abi.encode(manager));
        hook = new HurdleHook{salt: salt}(manager);

        // background passive LP, same as the unit-test fixture
        LIQUIDITY_PARAMS = IPoolManager.ModifyLiquidityParams(
            TickMath.minUsableTick(SPACING), TickMath.maxUsableTick(SPACING), 2000e18, 0
        );
        (key,) = initPoolAndAddLiquidity(currency0, currency1, IHooks(address(hook)), 3000, SQRT_PRICE_1_1);
        vm.warp(block.timestamp + 600); // the hook's TWAP needs 10 min of history

        // a small bond makes the fire/reclaim path reachable: 0.1e18 bond on a 2e18 NAV (5%), floor 2%
        vault = new HurdleVault(manager, key, CURATOR, 2000, 200, 50, 600);
        _fund(CURATOR, address(vault), 0, 0.1e18);
        vm.prank(CURATOR);
        vault.postBond(0.1e18);
        _fund(CURATOR, address(vault), 1e18, 1e18);
        vm.prank(CURATOR);
        vault.firstDeposit(1e18, 1e18, ALICE);

        // fund the actors
        MockERC20(Currency.unwrap(currency0)).mint(address(this), 1e27);
        MockERC20(Currency.unwrap(currency1)).mint(address(this), 1e27);
        address[3] memory users = [ALICE, BOB, CAROL];
        for (uint256 i; i < 3; ++i) _fund(users[i], address(vault), 1e23, 1e23);
        _fund(CURATOR, address(vault), 1e23, 1e23); // for repeated postBond calls and curator co-investment

        handler = new Handler(vault, manager, key, swapRouter, hook, CURATOR, users);
        _fund(address(handler), address(swapRouter), 5e26, 5e26); // swap inventory
        targetContract(address(handler));
    }

    // ---------------------------------------------------------------------
    // invariants
    // ---------------------------------------------------------------------

    /// 1. The shares held by every holder sum to totalSupply (mint/burn accounting).
    function invariant_sharesSumToTotalSupply() public view {
        assertEq(handler.sumShares(), vault.totalSupply(), "sum of holder shares != totalSupply");
    }

    /// 2. Bond tokens: current balance == posted - paid to depositors - reclaimed.
    function invariant_bondAccounting() public view {
        uint256 out = handler.ghostBondPaid() + handler.ghostBondReclaimed();
        assertLe(out, handler.ghostBondPosted(), "bond paid out more than was posted");
        assertEq(vault.bond(), handler.ghostBondPosted() - out, "bond token balance not accounted");
        assertEq(handler.ghostUnexplainedBondIncrease(), 0, "bond increased outside postBond");
        assertEq(handler.ghostBondPostMismatch(), 0, "postBond did not raise bond by the posted amount");
        assertEq(handler.ghostReclaimLeftBond(), 0, "reclaimBond left bond tokens behind");
        assertEq(handler.ghostRevertedBondDrift(), 0, "reverted action changed the bond");
    }

    /// 3. The deficit is never negative (uint256), never overflows, and at settlement it is <= NAV.
    ///    (A mid-epoch price crash can legitimately push it above the current NAV, so the NAV bound is
    ///    asserted on the post-settlement snapshot the handler records.)
    function invariant_deficitBoundedByNav() public view {
        assertLe(vault.deficit(), type(uint128).max, "deficit overflowed any realistic bound");
        assertEq(handler.ghostSettleDeficitViolations(), 0, "deficit > NAV at settlement");
    }

    /// 3b. Live check: the deficit never exceeds the current NAV.
    function invariant_deficitLiveNotAboveNav() public view {
        uint256 d = vault.deficit();
        uint256 n = vault.nav();
        assertLe(d, n + n / 10_000 + 1, "live deficit > NAV");
    }

    /// 4. After a settlement in which the bond covered the depositor shortfall, depositors are at par
    ///    (1 bp rounding tolerance). Checked on the handler's post-settlement snapshot.
    function invariant_depositorsAtParAfterCoveredSettle() public view {
        assertEq(handler.ghostCoveredSettleViolations(), 0, "depositors left below par after a covered shortfall");
    }

    /// 5. Firing is monotonic: once fired, the vault never reports not-fired again.
    function invariant_firedMonotonic() public view {
        if (handler.ghostFiredSeen()) assertTrue(vault.fired(), "fired went back to false");
    }

    /// 6. Liveness: once an epoch is over, settle() must not revert.
    function invariant_settleNeverRevertsAfterEpoch() public view {
        assertEq(handler.ghostSettleRevertsAfterEpoch(), 0, "settle() reverted after the epoch was over");
    }

    /// 7. A deposit immediately followed by a withdrawal never returns more value than was paid
    ///    (1 bp + dust for rounding, valued at the TWAP).
    function invariant_depositWithdrawNoProfit() public view {
        assertEq(handler.ghostRoundTripViolations(), 0, "deposit -> withdraw round trip profited");
        assertLe(
            handler.ghostWorstProfit(),
            handler.ghostWorstProfitIn() / 10_000 + 1e6,
            "deposit -> withdraw round trip profited by more than rounding"
        );
    }


    // ---------------------------------------------------------------------
    // audit3 invariants (research/audit3-accounting.md). Numbers follow the report's list; 2 (noise
    // neutrality) is a fuzz test in NoiseNeutrality.t.sol because it pins NAV with vm.store.
    // ---------------------------------------------------------------------

    /// 1. Depositors repay exactly what they received:
    ///    deficit == paid - recouped - forgiven - paydown, and no action changes the deficit by anything
    ///    the Settled/postBond/exit events do not explain.
    function invariant_deficitReconciles() public view {
        assertEq(handler.ghostDeficitUnexplained(), 0, "deficit moved without a matching event");
        uint256 out = handler.ghostDeficitRecouped() + handler.ghostDeficitForgiven() + handler.ghostDeficitPaydown();
        uint256 paid = handler.ghostDeficitPaid();
        assertLe(out, paid + 1e7, "deficit repaid more than the bond paid");
        assertApproxEqAbs(vault.deficit(), paid - (out > paid ? paid : out), 1e7 + paid / 1e9, "deficit != paid - repaid");
    }

    /// 3. Value is conserved across a settle with no external flow (nav + bond tokens).
    function invariant_valueConservedAcrossSettle() public view {
        assertEq(handler.ghostConservationViolations(), 0, "settle created or destroyed value");
        // and every share is worth its pro-rata slice: holders + bond + dead shares add up to NAV + bond
        uint256 nav = vault.nav();
        uint256 t = vault.totalSupply();
        uint256 holders = 4 + handler.seenHoldersLength() + 3;
        uint256 sum = vault.bondValue() - vault.bond();
        sum += vault.balanceOf(address(0)) * nav / t + vault.balanceOf(CURATOR) * nav / t;
        sum += vault.balanceOf(ALICE) * nav / t + vault.balanceOf(BOB) * nav / t + vault.balanceOf(CAROL) * nav / t;
        sum += vault.balanceOf(address(handler)) * nav / t;
        for (uint256 i; i < handler.seenHoldersLength(); ++i) {
            address h = handler.seenHolders(i);
            if (h == CURATOR || h == ALICE || h == BOB || h == CAROL || h == address(handler)) continue;
            sum += vault.balanceOf(h) * nav / t;
        }
        assertLe(sum, nav, "holders are worth more than NAV");
        assertGe(sum + holders, nav, "holders are worth less than NAV");
    }

    /// 4. The vault always holds at least the bond tokens it owes the curator.
    function invariant_bondTokensBackedByBalance() public view {
        assertGe(
            MockERC20(Currency.unwrap(currency1)).balanceOf(address(vault)), vault.bond(), "bond tokens not in the vault"
        );
    }

    /// 5. The dead shares are never touched.
    function invariant_deadShares() public view {
        assertEq(vault.balanceOf(address(0)), 1000, "dead shares moved");
        assertGe(vault.totalSupply(), 1000, "supply below the dead shares");
    }

    /// 6. A shortfall settle lowers the bond's value by exactly what depositors received and leaves the
    ///    curator's free shares' value unchanged.
    function invariant_shortfallEffect() public view {
        assertEq(handler.ghostShortfallEffectViolations(), 0, "shortfall settle moved other value");
    }

    /// 7. At or above par no shortfall is paid; minted shares equal take*t/(nav-take); the bounty is <= 5%.
    function invariant_carryGate() public view {
        assertEq(handler.ghostCarryGateViolations(), 0, "carry gate or mint formula violated");
    }

    /// 8. Deposits into a fired vault only happen while it is parked.
    function invariant_firedDepositsOnlyWhenParked() public view {
        assertEq(handler.ghostFiredDepositViolations(), 0, "deposit accepted into a fired, unparked vault");
    }

    /// 9. withdraw: burn + paidShares == shares, and curator + bond gain == paidShares.
    function invariant_withdrawSplit() public view {
        assertEq(handler.ghostWithdrawSplitViolations(), 0, "withdraw share split broken");
    }

    /// 10. Deposit and withdraw keep par per share (start.nav / totalSupply) and, on withdraw, the deficit per
    ///     depositor share.
    function invariant_parAndDeficitPerShare() public view {
        assertEq(handler.ghostParPerShareViolations(), 0, "start.nav per share moved");
        assertEq(handler.ghostDeficitPerShareViolations(), 0, "deficit per depositor share moved");
    }

    /// 11. Handler gaps closed: bounty recipients are summed in sumShares (invariant 1 of the original suite),
    ///     and the new actions are reachable.
    function test_handlerGapsClosed() public {
        handler.curatorDeposit(1e17);
        handler.curatorWithdraw(1e12);
        handler.keeperSettle(0);
        assertGt(handler.ghostKeeperSettles() + handler.ghostCuratorActions(), 0, "new actions not reached");
        assertEq(handler.sumShares(), vault.totalSupply(), "bounty recipient missed by sumShares");
    }

    /// Coverage for 1 and 6 with real recoups: a miss, a recovery and a beat with the curator co-invested.
    function test_coverageDeficitRecoupReconciles() public {
        handler.curatorDeposit(1e17);
        handler.rebalance(1200, 1, 10_000);
        handler.swap(50e18, 0);
        handler.warp(2000);
        handler.keeperSettle(1);
        assertGt(handler.ghostDeficitPaid(), 0, "no shortfall paid");
        assertEq(handler.ghostDeficitUnexplained(), 0, "deficit unexplained after a miss");
        for (uint256 i; i < 12 && vault.deficit() > 0 && !vault.fired(); ++i) {
            handler.swap(50e18, 1);
            handler.warp(2000);
            handler.keeperSettle(i);
        }
        assertEq(handler.ghostDeficitUnexplained(), 0, "deficit unexplained");
        assertEq(handler.sumShares(), vault.totalSupply());
    }

    // ---------------------------------------------------------------------
    // coverage tests: the handler actually reaches the interesting paths
    // ---------------------------------------------------------------------

    /// Coverage: a narrow range pushed out of the money across an epoch makes the vault miss par while
    /// the bond still covers the miss, so the settlement pays a shortfall and depositors end at par.
    /// Exercises invariants 3 and 4.
    function test_coverageCoveredShortfall() public {
        handler.rebalance(1200, 1, 10_000); // 120-tick range centred on spot
        handler.swap(50e18, 0); // down, out of the range: the vault ends all token0 and misses par
        handler.warp(2000); // past the epoch, TWAP caught up
        handler.settle();
        assertGt(handler.ghostCoveredSettlements(), 0, "no covered shortfall settlement exercised");
        assertLt(handler.lastNav(), handler.lastBench(), "settlement was not below par");
        assertGt(handler.lastPaid(), 0, "bond paid nothing on a covered shortfall");
        assertEq(handler.ghostCoveredSettleViolations(), 0, "depositors below par after a covered shortfall");
        assertFalse(vault.fired(), "a miss the bond covers must not fire the curator");
    }

    /// Coverage: a miss big enough to take the bond below half the floor is covered first, then fires the
    /// curator, parks the vault full range and lets the curator reclaim what is left. Exercises
    /// invariants 2, 4 and 5.
    function test_coverageFireParkReclaim() public {
        handler.rebalance(1200, 1, 10_000); // 120-tick range centred on spot
        handler.swap(100e18, 0); // down, out of the range: a miss the bond covers, leaving it under the floor
        handler.warp(2000);
        handler.settle();
        assertTrue(vault.fired(), "bond did not drain enough to fire");
        assertTrue(handler.ghostFiredSeen(), "handler did not observe the firing");
        assertGt(handler.ghostSettlements(), 0, "no settlement observed");
        assertGt(handler.ghostCoveredSettlements(), 0, "no covered shortfall settlement exercised");
        assertEq(handler.ghostCoveredSettleViolations(), 0, "depositors below par after a covered shortfall");

        for (uint256 i; i < 12; ++i) {
            handler.warp(2000);
            handler.rebalance(1200, 1, 10_000); // permissionless park after firing
        }
        (int24 lo, int24 hi,) = vault.position();
        assertEq(lo, TickMath.minUsableTick(SPACING), "vault not parked");
        assertEq(hi, TickMath.maxUsableTick(SPACING), "vault not parked");

        handler.warp(2000);
        handler.reclaimBond();
        assertGt(handler.ghostReclaimOk(), 0, "reclaimBond did not succeed");
        assertEq(vault.bond(), 0, "bond tokens left after reclaim");
        assertEq(vault.bondShares(), 0, "bond shares left after reclaim");
    }

    /// Coverage: a long seeded random sequence through every handler action (the same paths the fuzzer
    /// takes, but deterministic) must reach covered shortfalls without tripping any ghost counter.
    function test_coverageRandomSequence() public {
        uint256 seed = 12345;
        for (uint256 i; i < 512; ++i) {
            seed = uint256(keccak256(abi.encode(seed)));
            uint256 action = seed % 13;
            if (action == 0) handler.deposit(seed >> 8, seed >> 16);
            else if (action == 1) handler.withdraw(seed >> 8, seed >> 16);
            else if (action == 2) handler.depositThenWithdraw(seed >> 8, seed >> 16);
            else if (action == 3 || action == 4) handler.swap(seed >> 8, seed >> 16);
            else if (action == 5) handler.warp(seed >> 8);
            else if (action == 6) handler.settle();
            else if (action == 7) handler.rebalance(seed >> 8, seed >> 16, seed >> 24);
            else if (action == 8) handler.postBond(seed >> 8);
            else if (action == 9) handler.reclaimBond();
            else if (action == 10) handler.curatorDeposit(seed >> 8);
            else if (action == 11) handler.curatorWithdraw(seed >> 8);
            else handler.keeperSettle(seed >> 8);
        }
        assertGt(handler.ghostSettlements(), 0, "no settlement observed");
        assertGt(handler.ghostCoveredSettlements(), 0, "no covered shortfall settlement exercised");
        assertGt(handler.ghostSwapOk(), 0, "no swap succeeded");
        assertGt(handler.ghostRebalanceOk(), 0, "no rebalance succeeded");
        assertEq(handler.ghostCoveredSettleViolations(), 0, "depositors below par after a covered shortfall");
        assertEq(handler.ghostSettleDeficitViolations(), 0, "deficit > NAV at settlement");
        assertEq(handler.ghostSettleRevertsAfterEpoch(), 0, "settle() reverted after the epoch was over");
    }

    function test_handlerExercisesPaths() public {
        handler.deposit(0, 1e17);
        handler.swap(50e18, 0);
        handler.warp(2000);
        handler.settle();
        handler.rebalance(0, 5, 9000);
        handler.postBond(1e17);
        handler.depositThenWithdraw(1, 1e17);
        handler.withdraw(2, 1e17);
        handler.swap(80e18, 1);
        handler.warp(1800);
        handler.settle();
        handler.reclaimBond();

        assertGt(handler.ghostDepositOk(), 0, "no deposit succeeded");
        assertGt(handler.ghostWithdrawOk(), 0, "no withdraw succeeded");
        assertGt(handler.ghostSwapOk(), 0, "no swap succeeded");
        assertGt(handler.ghostSettleOk(), 0, "no settle succeeded");
        assertGt(handler.ghostPostBondOk(), 0, "no postBond succeeded");
        assertGt(handler.ghostRoundTrips(), 0, "no round trip ran");
        assertGt(handler.ghostSettlements(), 0, "no settlement observed");
        assertEq(handler.ghostSettleRevertsAfterEpoch(), 0, "settle reverted");
    }

    // ---------------------------------------------------------------------
    // helpers (mirrors of VaultFixture's, which cannot be inherited without its setUp)
    // ---------------------------------------------------------------------

    function _fund(address who, address spender, uint256 a0, uint256 a1) internal {
        MockERC20(Currency.unwrap(currency0)).transfer(who, a0);
        MockERC20(Currency.unwrap(currency1)).transfer(who, a1);
        vm.startPrank(who);
        MockERC20(Currency.unwrap(currency0)).approve(spender, type(uint256).max);
        MockERC20(Currency.unwrap(currency1)).approve(spender, type(uint256).max);
        vm.stopPrank();
    }
}
