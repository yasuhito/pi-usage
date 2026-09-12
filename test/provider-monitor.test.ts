import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Cause, Deferred, Effect, Exit, Fiber, Scope, TestClock } from "effect";
import type { WeeklySubscriptionUsageStatus } from "../src/presentation.ts";
import {
  makeProviderMonitor,
  type ProviderAcquisitionCompletion,
  type ProviderCredentialContinuity,
  type ProviderMonitorAdapter,
  type WeeklySubscriptionUsageChange,
} from "../src/provider-monitor.ts";

const noChange = (): WeeklySubscriptionUsageChange => ({
  publication: undefined,
  staleExpiration: { kind: "preserve" },
  acquire: false,
});

const available = (usedPercent: number): WeeklySubscriptionUsageChange => ({
  publication: { kind: "available", usedPercent, stale: false },
  staleExpiration: { kind: "clear" },
  acquire: false,
});

const completed = (usedPercent: number): ProviderAcquisitionCompletion => ({
  changes: [available(usedPercent)],
  disposition: { kind: "completed" },
});

const retry = (
  retryAtMs: number | undefined,
): ProviderAcquisitionCompletion => ({
  changes: [noChange()],
  disposition: { kind: "retry", retryAtMs },
});

const noopAdapter = (
  overrides: Partial<ProviderMonitorAdapter>,
): ProviderMonitorAdapter => ({
  inspectAcquisition: () =>
    Effect.succeed({
      kind: "blocked",
      continuity: "unavailable",
      change: noChange(),
    }),
  observeActivity: () => Effect.succeed(noChange()),
  staleExpirationReached: () => Effect.succeed(noChange()),
  finalize: Effect.void,
  ...overrides,
});

function fixture(random = 0.5) {
  return Effect.gen(function* () {
    let reads = 0;
    let acquisition: Effect.Effect<ProviderAcquisitionCompletion> = Effect.sync(
      () => completed(reads),
    );
    let staleExpirationChange = noChange();
    let continuity: ProviderCredentialContinuity = "unchanged";
    const statuses: WeeklySubscriptionUsageStatus[] = [];
    const adapter: ProviderMonitorAdapter = {
      inspectAcquisition: () => {
        if (continuity === "unavailable") {
          return Effect.succeed({
            kind: "blocked" as const,
            continuity,
            change: noChange(),
          });
        }
        return Effect.succeed({
          kind: "ready" as const,
          continuity,
          change: noChange(),
          acquire: Effect.suspend(() => {
            reads += 1;
            return acquisition;
          }),
          acquisitionDeferred: Effect.succeed(noChange()),
        });
      },
      observeResponse: () => Effect.succeed(noChange()),
      observeActivity: () => Effect.succeed({ ...noChange(), acquire: true }),
      staleExpirationReached: () => Effect.succeed(staleExpirationChange),
      finalize: Effect.void,
    };
    const monitor = yield* makeProviderMonitor(adapter, {
      publish: (status) =>
        Effect.sync(() => {
          statuses.push(status);
        }),
      random: Effect.succeed(random),
    });
    return {
      monitor,
      statuses,
      reads: () => reads,
      setAcquisition: (value: Effect.Effect<ProviderAcquisitionCompletion>) => {
        acquisition = value;
      },
      setStaleExpirationChange: (value: WeeklySubscriptionUsageChange) => {
        staleExpirationChange = value;
      },
      setContinuity: (value: ProviderCredentialContinuity) => {
        continuity = value;
      },
    };
  });
}

it.scoped("starts immediately and polls every minute", () =>
  Effect.gen(function* () {
    const harness = yield* fixture();
    yield* harness.monitor.start;
    assert.deepEqual(harness.statuses, [
      { kind: "loading" },
      { kind: "available", usedPercent: 1, stale: false },
    ]);
    yield* TestClock.adjust("59999 millis");
    assert.equal(harness.reads(), 1);
    yield* TestClock.adjust("1 millis");
    assert.equal(harness.reads(), 2);
  }),
);

it.scoped("keeps poll cadence while acquisition is in flight", () =>
  Effect.gen(function* () {
    const harness = yield* fixture();
    yield* harness.monitor.start;
    const gate = yield* Deferred.make<void>();
    harness.setAcquisition(Deferred.await(gate).pipe(Effect.as(completed(2))));
    yield* TestClock.adjust("1 minute");
    assert.equal(harness.reads(), 2);
    yield* TestClock.adjust("65 seconds");
    assert.equal(harness.reads(), 2);
    yield* Deferred.succeed(gate, undefined);
    yield* TestClock.adjust("55 seconds");
    assert.equal(harness.reads(), 3);
  }),
);

it.scoped("coalesces ordinary refreshes", () =>
  Effect.gen(function* () {
    const harness = yield* fixture();
    yield* harness.monitor.start;
    const gate = yield* Deferred.make<void>();
    harness.setAcquisition(Deferred.await(gate).pipe(Effect.as(completed(2))));
    const first = yield* Effect.fork(harness.monitor.refreshAfterActivity);
    const second = yield* Effect.fork(harness.monitor.refreshAfterActivity);
    while (harness.reads() < 2) yield* Effect.yieldNow();
    assert.equal(harness.reads(), 2);
    yield* Deferred.succeed(gate, undefined);
    yield* Fiber.join(first);
    yield* Fiber.join(second);
    assert.equal(harness.reads(), 2);
  }),
);

it.scoped("forced refresh supersedes ordinary work", () =>
  Effect.gen(function* () {
    const harness = yield* fixture();
    yield* harness.monitor.start;
    const never = yield* Deferred.make<void>();
    harness.setAcquisition(
      Deferred.await(never).pipe(Effect.as(completed(90))),
    );
    const old = yield* Effect.fork(harness.monitor.refreshAfterActivity);
    while (harness.reads() < 2) yield* Effect.yieldNow();
    harness.setAcquisition(Effect.succeed(completed(20)));
    yield* harness.monitor.refreshForAccountChange;
    yield* Fiber.await(old);
    assert.equal(harness.reads(), 3);
    const latest = harness.statuses.at(-1);
    assert.equal(latest?.kind === "available" && latest.usedPercent, 20);
  }),
);

it.scoped("propagates acquisition defects without scheduling retry", () =>
  Effect.gen(function* () {
    const harness = yield* fixture();
    harness.setAcquisition(Effect.die("unexpected defect"));
    const exit = yield* Effect.exit(harness.monitor.start);
    assert.equal(Exit.isFailure(exit), true);
    assert.equal(Exit.isFailure(exit) && Cause.defects(exit.cause).length, 1);
    yield* TestClock.adjust("1 second");
    assert.equal(harness.reads(), 1);
  }),
);

it.scoped("honors a valid provider retry deadline", () =>
  Effect.gen(function* () {
    const harness = yield* fixture();
    harness.setAcquisition(Effect.succeed(retry(5_000)));
    yield* harness.monitor.start;
    yield* TestClock.adjust("4999 millis");
    assert.equal(harness.reads(), 1);
    yield* TestClock.adjust("1 millis");
    assert.equal(harness.reads(), 2);
  }),
);

it.scoped("stops retry while credentials are unavailable", () =>
  Effect.gen(function* () {
    const harness = yield* fixture();
    harness.setAcquisition(Effect.succeed(retry(5_000)));
    yield* harness.monitor.start;
    harness.setContinuity("unavailable");
    yield* harness.monitor.refreshAfterActivity;
    yield* TestClock.adjust("5 seconds");
    assert.equal(harness.reads(), 1);
    harness.setContinuity("changed");
    yield* harness.monitor.refreshAfterActivity;
    assert.equal(harness.reads(), 2);
  }),
);

it.scoped("an unavailable completion preserves retry history", () =>
  Effect.gen(function* () {
    const harness = yield* fixture();
    harness.setAcquisition(Effect.succeed(retry(undefined)));
    yield* harness.monitor.start;
    harness.setAcquisition(
      Effect.succeed({
        continuity: "unavailable",
        changes: [noChange()],
        disposition: { kind: "completed" },
      }),
    );
    yield* TestClock.adjust("1 second");
    assert.equal(harness.reads(), 2);

    harness.setAcquisition(Effect.succeed(retry(undefined)));
    yield* harness.monitor.refreshAfterActivity;
    yield* TestClock.adjust("1999 millis");
    assert.equal(harness.reads(), 3);
    yield* TestClock.adjust("1 millis");
    assert.equal(harness.reads(), 4);
  }),
);

it.scoped("grows deterministic retry backoff and caps it at one minute", () =>
  Effect.gen(function* () {
    const harness = yield* fixture();
    harness.setAcquisition(Effect.succeed(retry(undefined)));
    yield* harness.monitor.start;
    for (const [delay, expectedReads] of [
      [1, 2],
      [2, 3],
      [4, 4],
      [8, 5],
      [16, 6],
      [32, 7],
      [60, 8],
      [60, 9],
    ] as const) {
      yield* TestClock.adjust(`${delay} seconds`);
      assert.equal(harness.reads(), expectedReads);
    }
  }),
);

it.scoped("applies deterministic retry jitter", () =>
  Effect.gen(function* () {
    const harness = yield* fixture(1);
    harness.setAcquisition(Effect.succeed(retry(undefined)));
    yield* harness.monitor.start;
    yield* TestClock.adjust("1499 millis");
    assert.equal(harness.reads(), 1);
    yield* TestClock.adjust("1 millis");
    assert.equal(harness.reads(), 2);
  }),
);

it.scoped("forced refresh replaces an obsolete retry", () =>
  Effect.gen(function* () {
    const harness = yield* fixture();
    harness.setAcquisition(Effect.succeed(retry(100_000)));
    yield* harness.monitor.start;
    harness.setAcquisition(Effect.succeed(retry(undefined)));
    yield* harness.monitor.refreshForAccountChange;
    yield* TestClock.adjust("1999 millis");
    assert.equal(harness.reads(), 2);
    yield* TestClock.adjust("1 millis");
    assert.equal(harness.reads(), 3);
  }),
);

it.scoped("terminal results suppress polling until a forced refresh", () =>
  Effect.gen(function* () {
    const harness = yield* fixture();
    harness.setAcquisition(
      Effect.succeed({
        changes: [noChange()],
        disposition: { kind: "terminal" },
      }),
    );
    yield* harness.monitor.start;
    yield* TestClock.adjust("1 minute");
    assert.equal(harness.reads(), 1);
    yield* harness.monitor.refreshForAccountChange;
    assert.equal(harness.reads(), 2);
  }),
);

it.scoped("unavailable credentials do not clear terminal history", () =>
  Effect.gen(function* () {
    const harness = yield* fixture();
    harness.setAcquisition(
      Effect.succeed({
        changes: [noChange()],
        disposition: { kind: "terminal" },
      }),
    );
    yield* harness.monitor.start;
    harness.setContinuity("unavailable");
    yield* TestClock.adjust("1 minute");
    harness.setContinuity("unchanged");
    yield* harness.monitor.refreshAfterActivity;
    assert.equal(harness.reads(), 1);
  }),
);

it.scoped("coalesces acquisition demand emitted by completion", () =>
  Effect.gen(function* () {
    const harness = yield* fixture();
    harness.setAcquisition(
      Effect.sync(() =>
        harness.reads() === 1
          ? {
              changes: [{ ...noChange(), acquire: true }],
              disposition: { kind: "completed" },
            }
          : completed(2),
      ),
    );
    yield* harness.monitor.start;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      yield* Effect.yieldNow();
    }
    assert.equal(harness.reads(), 2);
  }),
);

it.scoped("publishes completion changes before applying retry", () =>
  Effect.gen(function* () {
    const harness = yield* fixture();
    harness.setAcquisition(
      Effect.succeed({
        changes: [
          {
            ...noChange(),
            publication: { kind: "unavailable" },
          },
          available(40),
        ],
        disposition: { kind: "retry", retryAtMs: 5_000 },
      }),
    );
    yield* harness.monitor.start;
    assert.deepEqual(harness.statuses, [
      { kind: "loading" },
      { kind: "unavailable" },
      { kind: "available", usedPercent: 40, stale: false },
    ]);
    yield* TestClock.adjust("4999 millis");
    assert.equal(harness.reads(), 1);
    yield* TestClock.adjust("1 millis");
    assert.equal(harness.reads(), 2);
  }),
);

it.scoped("runs provider stale expiration at its deadline", () =>
  Effect.gen(function* () {
    const harness = yield* fixture();
    harness.setStaleExpirationChange({
      publication: { kind: "unavailable" },
      staleExpiration: { kind: "clear" },
      acquire: false,
    });
    harness.setAcquisition(
      Effect.succeed({
        changes: [
          {
            publication: {
              kind: "available",
              usedPercent: 50,
              stale: true,
            },
            staleExpiration: { kind: "arm", atMs: 10_000 },
            acquire: false,
          },
        ],
        disposition: { kind: "completed" },
      }),
    );
    yield* harness.monitor.start;
    yield* TestClock.adjust("9999 millis");
    assert.equal(harness.statuses.at(-1)?.kind, "available");
    yield* TestClock.adjust("1 millis");
    assert.deepEqual(harness.statuses.at(-1), { kind: "unavailable" });
  }),
);

it("scope closure interrupts active acquisition", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    let interrupted = false;
    const adapter = noopAdapter({
      inspectAcquisition: () =>
        Effect.succeed({
          kind: "ready",
          continuity: "unchanged",
          change: noChange(),
          acquire: Effect.never.pipe(
            Effect.ensuring(
              Effect.sync(() => {
                interrupted = true;
              }),
            ),
          ),
        }),
    });
    const monitor = yield* makeProviderMonitor(adapter, {
      publish: () => Effect.void,
    }).pipe(Effect.provideService(Scope.Scope, scope));
    const start = yield* Effect.fork(monitor.start);
    yield* Effect.yieldNow();

    yield* Scope.close(scope, Exit.void);
    yield* Fiber.await(start);

    assert.equal(interrupted, true);
  }));

it("scope closure cancels polling and retry work", () =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    let reads = 0;
    let finalized = false;
    const adapter = noopAdapter({
      inspectAcquisition: () =>
        Effect.succeed({
          kind: "ready",
          continuity: "unchanged",
          change: noChange(),
          acquire: Effect.sync(() => {
            reads += 1;
            return retry(undefined);
          }),
        }),
      finalize: Effect.sync(() => {
        finalized = true;
      }),
    });
    const monitor = yield* makeProviderMonitor(adapter, {
      publish: () => Effect.void,
      random: Effect.succeed(0.5),
    }).pipe(Effect.provideService(Scope.Scope, scope));
    yield* monitor.start;
    assert.equal(reads, 1);
    yield* Scope.close(scope, Exit.void);
    assert.equal(finalized, true);
    yield* TestClock.adjust("2 minutes");
    assert.equal(reads, 1);
  }));
