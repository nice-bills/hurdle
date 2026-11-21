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

        // a small bond makes the fire/reclaim path reachable: 0.5e18 bond on a 2e18 NAV, floor 2%
        vault = new HurdleVault(manager, key, CURATOR, 2000, 200, 50, 600);
        _fund(CURATOR, address(vault), 0, 0.5e18);
        vm.prank(CURATOR);
        vault.postBond(0.5e18);
        _fund(CURATOR, address(vault), 1e18, 1e18);
        vm.prank(CURATOR);
        vault.firstDeposit(1e18, 1e18, ALICE);

        // fund the actors
        MockERC20(Currency.unwrap(currency0)).mint(address(this), 1e27);
        MockERC20(Currency.unwrap(currency1)).mint(address(this), 1e27);
        address[3] memory users = [ALICE, BOB, CAROL];
        for (uint256 i; i < 3; ++i) _fund(users[i], address(vault), 1e23, 1e23);
        _fund(CURATOR, address(vault), 0, 1e23); // for repeated postBond calls

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
    // coverage test: the handler actually reaches the interesting paths
    // ---------------------------------------------------------------------

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
