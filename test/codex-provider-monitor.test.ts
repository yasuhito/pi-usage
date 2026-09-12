import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, TestClock } from "effect";
import {
  type CodexCredentialResolution,
  makeCodexProviderMonitor,
} from "../src/codex-provider-monitor.ts";
import {
  type AcquiredWeeklyQuotaUsage,
  AuthenticationRejected,
  type CodexCredential,
  type MalformedAcquisition,
  PermanentAcquisitionFailure,
  TemporaryAcquisitionFailure,
} from "../src/dedicated-weekly-quota-acquisition.ts";
import type { WeeklySubscriptionUsageStatus } from "../src/presentation.ts";

const credential = (accountId = "account-1"): CodexCredential => ({
  accessToken: `token-${accountId}`,
  accountId,
});
const goodUsage: AcquiredWeeklyQuotaUsage = {
  usedPercent: 63.4,
  resetsAtMs: 2_000_000,
  windowPosition: "secondary",
};

function fixture() {
  return Effect.gen(function* () {
    let resolution: CodexCredentialResolution = {
      kind: "available",
      credential: credential(),
    };
    let resolutionEffect: Effect.Effect<CodexCredentialResolution> | undefined;
    let acquisition: Effect.Effect<
      AcquiredWeeklyQuotaUsage,
      | AuthenticationRejected
      | TemporaryAcquisitionFailure
      | PermanentAcquisitionFailure
      | MalformedAcquisition
    > = Effect.succeed(goodUsage);
    let reads = 0;
    const credentials: CodexCredential[] = [];
    const statuses: Array<WeeklySubscriptionUsageStatus> = [];
    const monitor = yield* makeCodexProviderMonitor({
      resolveCredential: Effect.suspend(
        () => resolutionEffect ?? Effect.succeed(resolution),
      ),
      acquireDedicatedWeeklyQuotaUsage: (value) => {
        reads += 1;
        credentials.push(value);
        return acquisition;
      },
      publish: (status) =>
        Effect.sync(() => {
          statuses.push(status);
        }),
      random: Effect.succeed(0.5),
    });
    return {
      monitor,
      statuses,
      credentials,
      reads: () => reads,
      setResolution: (value: CodexCredentialResolution) => {
        resolution = value;
        resolutionEffect = undefined;
      },
      setResolutionEffect: (
        value: Effect.Effect<CodexCredentialResolution>,
      ) => {
        resolutionEffect = value;
      },
      setAcquisition: (value: typeof acquisition) => {
        acquisition = value;
      },
    };
  });
}

it.scoped("publishes loading and active-account usage", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.monitor.start;
    assert.deepEqual(f.statuses, [
      { kind: "loading" },
      {
        kind: "available",
        usedPercent: 63.4,
        stale: false,
        weeklyWindowResetsAtMs: 2_000_000,
      },
    ]);
    assert.deepEqual(f.credentials, [credential()]);
  }),
);

it.scoped("presents missing authentication as unavailable", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.setResolution({ kind: "missing" });
    yield* f.monitor.start;
    assert.deepEqual(f.statuses, [
      { kind: "loading" },
      { kind: "unavailable" },
    ]);
    yield* TestClock.adjust("2 minutes");
    assert.equal(f.reads(), 0);
  }),
);

it.scoped("debounces activity for exactly 30 seconds", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.monitor.start;
    yield* TestClock.adjust("29999 millis");
    yield* f.monitor.refreshAfterActivity;
    assert.equal(f.reads(), 1);
    yield* TestClock.adjust("1 millis");
    yield* f.monitor.refreshAfterActivity;
    assert.equal(f.reads(), 2);
  }),
);

it.scoped(
  "marks temporary failures stale and expires them with virtual time",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.monitor.start;
      f.setAcquisition(
        Effect.fail(new TemporaryAcquisitionFailure({ retryAtMs: undefined })),
      );
      yield* f.monitor.refreshForAccountChange;
      const stale = f.statuses.at(-1);
      assert.equal(stale?.kind, "available");
      assert.equal(stale?.kind === "available" && stale.stale, true);
      yield* TestClock.adjust("10 minutes");
      assert.deepEqual(f.statuses.at(-1), { kind: "unavailable" });
    }),
);

it.scoped("keeps stale expiration armed across forced supersession", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.monitor.start;
    f.setAcquisition(
      Effect.fail(new TemporaryAcquisitionFailure({ retryAtMs: undefined })),
    );
    yield* f.monitor.refreshForAccountChange;
    const never = yield* Deferred.make<void>();
    f.setAcquisition(Deferred.await(never).pipe(Effect.as(goodUsage)));
    const supersedingRefresh = yield* Effect.fork(
      f.monitor.refreshForAccountChange,
    );
    while (f.reads() < 3) yield* Effect.yieldNow();
    yield* TestClock.adjust("10 minutes");
    assert.deepEqual(f.statuses.at(-1), { kind: "unavailable" });
    yield* Fiber.interrupt(supersedingRefresh);
  }),
);

it.scoped(
  "reconciles sparse passive observations with dedicated evidence",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.monitor.start;
      yield* f.monitor.observeResponse({
        "x-codex-secondary-used-percent": "82",
      });
      assert.deepEqual(f.statuses.at(-1), {
        kind: "available",
        usedPercent: 82,
        stale: false,
        weeklyWindowResetsAtMs: 2_000_000,
      });
    }),
);

it.scoped(
  "forced account changes supersede old work and isolate publication",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.monitor.start;
      const never = yield* Deferred.make<void>();
      f.setAcquisition(
        Deferred.await(never).pipe(
          Effect.as({ ...goodUsage, usedPercent: 90 }),
        ),
      );
      const old = yield* Effect.fork(f.monitor.refreshForAccountChange);
      yield* Effect.yieldNow();
      yield* f.monitor.observeResponse({
        "x-codex-secondary-used-percent": "99",
      });
      const beforeAccountChange = f.statuses.at(-1);
      assert.equal(
        beforeAccountChange?.kind === "available" &&
          beforeAccountChange.usedPercent,
        63.4,
      );
      f.setResolution({
        kind: "available",
        credential: credential("account-2"),
      });
      f.setAcquisition(Effect.succeed({ ...goodUsage, usedPercent: 20 }));
      yield* f.monitor.refreshForAccountChange;
      yield* Fiber.await(old);
      assert.deepEqual(f.credentials.at(-1), credential("account-2"));
      const latest = f.statuses.at(-1);
      assert.equal(latest?.kind === "available" && latest.usedPercent, 20);
    }),
);

it.scoped(
  "ignores passive observations during authentication re-resolution",
  () =>
    Effect.gen(function* () {
      const harness = yield* fixture();
      yield* harness.monitor.start;
      yield* TestClock.adjust("31 seconds");
      harness.setAcquisition(Effect.fail(new AuthenticationRejected()));
      const pendingResolution =
        yield* Deferred.make<CodexCredentialResolution>();
      let resolutions = 0;
      harness.setResolutionEffect(
        Effect.suspend(() =>
          ++resolutions === 1
            ? Effect.succeed({
                kind: "available" as const,
                credential: credential(),
              })
            : Deferred.await(pendingResolution),
        ),
      );
      const refresh = yield* Effect.fork(harness.monitor.refreshAfterActivity);
      while (harness.reads() < 2) yield* Effect.yieldNow();

      yield* harness.monitor.observeResponse({
        "x-codex-secondary-used-percent": "99",
      });
      const latest = harness.statuses.at(-1);
      assert.equal(latest?.kind === "available" && latest.usedPercent, 63.4);

      yield* Deferred.succeed(pendingResolution, {
        kind: "available",
        credential: credential(),
      });
      yield* Fiber.await(refresh);
    }),
);

it.scoped("does not disguise acquisition defects as retryable failures", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.monitor.start;
    f.setAcquisition(Effect.die("unexpected defect"));
    const exit = yield* Effect.exit(f.monitor.refreshForAccountChange);
    assert.equal(Exit.isFailure(exit), true);
    assert.deepEqual(f.statuses.at(-1), { kind: "unavailable" });
    yield* TestClock.adjust("1 second");
    assert.equal(f.reads(), 2);
    yield* TestClock.adjust("59 seconds");
    assert.equal(f.reads(), 3);
  }),
);

it.scoped(
  "applies temporary-failure backoff without blocking forced refreshes",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.monitor.start;
      yield* TestClock.adjust("31 seconds");
      f.setAcquisition(
        Effect.fail(new TemporaryAcquisitionFailure({ retryAtMs: undefined })),
      );
      yield* f.monitor.refreshForAccountChange;
      const readsAfterFailure = f.reads();
      yield* f.monitor.refreshAfterActivity;
      assert.equal(f.reads(), readsAfterFailure);
      yield* TestClock.adjust("1001 millis");
      yield* f.monitor.refreshAfterActivity;
      assert.equal(f.reads(), readsAfterFailure + 1);
    }),
);

it.scoped("permanent unavailability discards prior usage", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.monitor.start;
    f.setAcquisition(Effect.fail(new PermanentAcquisitionFailure()));
    yield* f.monitor.refreshForAccountChange;
    assert.deepEqual(f.statuses.at(-1), { kind: "unavailable" });
    const readsAtTerminalState = f.reads();
    yield* TestClock.adjust("1 minute");
    assert.equal(f.reads(), readsAtTerminalState);
    yield* f.monitor.refreshForAccountChange;
    assert.equal(f.reads(), readsAtTerminalState + 1);
  }),
);

it.scoped("keeps checking for a Codex credential while unavailable", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    f.setResolution({ kind: "missing" });
    yield* f.monitor.start;
    f.setResolution({ kind: "available", credential: credential() });
    yield* TestClock.adjust("1 minute");
    assert.equal(f.reads(), 1);
    assert.equal(f.statuses.at(-1)?.kind, "available");
  }),
);

it.scoped("logout during authentication refresh presents unavailable", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.monitor.start;
    f.setAcquisition(
      Effect.sync(() => {
        f.setResolution({ kind: "missing" });
      }).pipe(Effect.andThen(Effect.fail(new AuthenticationRejected()))),
    );
    yield* f.monitor.refreshForAccountChange;
    assert.deepEqual(f.statuses.at(-1), { kind: "unavailable" });
  }),
);

it.scoped("refreshes credentials once after authentication rejection", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    let attempt = 0;
    f.setAcquisition(
      Effect.suspend(() =>
        ++attempt === 1
          ? Effect.fail(new AuthenticationRejected())
          : Effect.succeed(goodUsage),
      ),
    );
    yield* f.monitor.start;
    assert.equal(f.reads(), 2);
    assert.equal(f.statuses.at(-1)?.kind, "available");
  }),
);
