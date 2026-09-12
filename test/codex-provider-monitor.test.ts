import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, TestClock } from "effect";
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
      resolveCredential: Effect.sync(() => resolution),
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

it.scoped("polls every minute and debounces fresh activity", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.monitor.start;
    yield* f.monitor.refreshAfterActivity;
    assert.equal(f.reads(), 1);
    yield* TestClock.adjust("1 minute");
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
    yield* f.monitor.refreshForAccountChange;
    yield* TestClock.adjust("10 minutes");
    assert.deepEqual(f.statuses.at(-1), { kind: "unavailable" });
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

it.scoped("coalesces ordinary refreshes", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.monitor.start;
    yield* TestClock.adjust("31 seconds");
    const gate = yield* Deferred.make<void>();
    f.setAcquisition(Deferred.await(gate).pipe(Effect.as(goodUsage)));
    const first = yield* Effect.fork(f.monitor.refreshAfterActivity);
    const second = yield* Effect.fork(f.monitor.refreshAfterActivity);
    yield* Effect.yieldNow();
    yield* Deferred.succeed(gate, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    assert.equal(f.reads(), 2);
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
