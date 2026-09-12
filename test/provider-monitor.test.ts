import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Scope, TestClock } from "effect";
import type { WeeklySubscriptionUsageStatus } from "../src/presentation.ts";
import {
  makeProviderMonitor,
  type ProviderMonitorAdapter,
  type ProviderMonitorReaction,
  type ProviderMonitorTransition,
  type ProviderRefreshPlan,
} from "../src/provider-monitor.ts";

const noReaction = (): ProviderMonitorReaction => ({
  publication: undefined,
  staleExpiration: { kind: "preserve" },
  acquire: false,
});

const available = (usedPercent: number): ProviderMonitorReaction => ({
  publication: { kind: "available", usedPercent, stale: false },
  staleExpiration: { kind: "clear" },
  acquire: false,
});

const completedPlan = (usedPercent: number): ProviderRefreshPlan => ({
  beforeDirective: noReaction(),
  directive: { kind: "completed" },
  afterDirective: available(usedPercent),
});

const noopAdapter = (
  overrides: Partial<ProviderMonitorAdapter>,
): ProviderMonitorAdapter => ({
  prepareRefresh: () =>
    Effect.succeed({
      kind: "skip",
      schedule: "preserve",
      reaction: noReaction(),
    }),
  observeActivity: () => Effect.succeed(noReaction()),
  staleExpirationReached: () => Effect.succeed(noReaction()),
  finalize: Effect.void,
  ...overrides,
});

type TestRefreshExecution =
  | ProviderRefreshPlan
  | {
      readonly kind: "stop";
      readonly transition: ProviderMonitorTransition;
    };

function fixture(random = 0.5) {
  return Effect.gen(function* () {
    let reads = 0;
    let acquisition: Effect.Effect<TestRefreshExecution> = Effect.sync(() =>
      completedPlan(reads),
    );
    let staleExpirationReaction = noReaction();
    let preparationSchedule: ProviderMonitorTransition["schedule"] = "preserve";
    const statuses: WeeklySubscriptionUsageStatus[] = [];
    const adapter: ProviderMonitorAdapter = {
      prepareRefresh: () =>
        Effect.succeed({
          kind: "ready",
          schedule: preparationSchedule,
          reaction: noReaction(),
          execute: Effect.suspend(() => {
            reads += 1;
            return acquisition;
          }),
        }),
      observeResponse: () => Effect.succeed(noReaction()),
      observeActivity: () => Effect.succeed({ ...noReaction(), acquire: true }),
      acquisitionDeferred: () => Effect.succeed(noReaction()),
      staleExpirationReached: () => Effect.succeed(staleExpirationReaction),
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
      setAcquisition: (value: Effect.Effect<TestRefreshExecution>) => {
        acquisition = value;
      },
      setStaleExpirationReaction: (value: ProviderMonitorReaction) => {
        staleExpirationReaction = value;
      },
      setPreparationSchedule: (value: typeof preparationSchedule) => {
        preparationSchedule = value;
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
    harness.setAcquisition(
      Deferred.await(gate).pipe(Effect.as(completedPlan(2))),
    );
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
    harness.setAcquisition(
      Deferred.await(gate).pipe(Effect.as(completedPlan(2))),
    );
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
      Deferred.await(never).pipe(Effect.as(completedPlan(90))),
    );
    const old = yield* Effect.fork(harness.monitor.refreshAfterActivity);
    while (harness.reads() < 2) yield* Effect.yieldNow();
    harness.setAcquisition(Effect.succeed(completedPlan(20)));
    yield* harness.monitor.refreshForAccountChange;
    yield* Fiber.await(old);
    assert.equal(harness.reads(), 3);
    const latest = harness.statuses.at(-1);
    assert.equal(latest?.kind === "available" && latest.usedPercent, 20);
  }),
);

it.scoped("honors a valid provider retry deadline", () =>
  Effect.gen(function* () {
    const harness = yield* fixture();
    harness.setAcquisition(
      Effect.succeed({
        beforeDirective: noReaction(),
        directive: { kind: "temporary-failure", retryAtMs: 5_000 },
        afterDirective: noReaction(),
      }),
    );
    yield* harness.monitor.start;
    yield* TestClock.adjust("4999 millis");
    assert.equal(harness.reads(), 1);
    yield* TestClock.adjust("1 millis");
    assert.equal(harness.reads(), 2);
  }),
);

it.scoped("pauses retry work without discarding its deadline", () =>
  Effect.gen(function* () {
    const harness = yield* fixture();
    harness.setAcquisition(
      Effect.succeed({
        beforeDirective: noReaction(),
        directive: { kind: "temporary-failure", retryAtMs: 5_000 },
        afterDirective: noReaction(),
      }),
    );
    yield* harness.monitor.start;
    harness.setPreparationSchedule("pause-retry");
    yield* harness.monitor.refreshAfterActivity;
    harness.setPreparationSchedule("preserve");
    yield* TestClock.adjust("4999 millis");
    yield* harness.monitor.refreshAfterActivity;
    assert.equal(harness.reads(), 1);
    yield* TestClock.adjust("1 millis");
    yield* harness.monitor.refreshAfterActivity;
    assert.equal(harness.reads(), 2);
  }),
);

it.scoped("stops a refresh without resetting retry state", () =>
  Effect.gen(function* () {
    const harness = yield* fixture();
    harness.setAcquisition(
      Effect.succeed({
        beforeDirective: noReaction(),
        directive: { kind: "temporary-failure", retryAtMs: undefined },
        afterDirective: noReaction(),
      }),
    );
    yield* harness.monitor.start;
    harness.setAcquisition(
      Effect.succeed({
        kind: "stop",
        transition: {
          schedule: "pause-retry",
          reaction: noReaction(),
        },
      }),
    );
    yield* TestClock.adjust("1 second");
    assert.equal(harness.reads(), 2);

    harness.setAcquisition(
      Effect.succeed({
        beforeDirective: noReaction(),
        directive: { kind: "temporary-failure", retryAtMs: undefined },
        afterDirective: noReaction(),
      }),
    );
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
    harness.setAcquisition(
      Effect.succeed({
        beforeDirective: noReaction(),
        directive: { kind: "temporary-failure", retryAtMs: undefined },
        afterDirective: noReaction(),
      }),
    );
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
    harness.setAcquisition(
      Effect.succeed({
        beforeDirective: noReaction(),
        directive: { kind: "temporary-failure", retryAtMs: undefined },
        afterDirective: noReaction(),
      }),
    );
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
    harness.setAcquisition(
      Effect.succeed({
        beforeDirective: noReaction(),
        directive: { kind: "temporary-failure", retryAtMs: 100_000 },
        afterDirective: noReaction(),
      }),
    );
    yield* harness.monitor.start;
    harness.setAcquisition(
      Effect.succeed({
        beforeDirective: noReaction(),
        directive: { kind: "temporary-failure", retryAtMs: undefined },
        afterDirective: noReaction(),
      }),
    );
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
        beforeDirective: noReaction(),
        directive: { kind: "terminal" },
        afterDirective: noReaction(),
      }),
    );
    yield* harness.monitor.start;
    yield* TestClock.adjust("1 minute");
    assert.equal(harness.reads(), 1);
    yield* harness.monitor.refreshForAccountChange;
    assert.equal(harness.reads(), 2);
  }),
);

it.scoped("runs provider stale expiration at its deadline", () =>
  Effect.gen(function* () {
    const harness = yield* fixture();
    harness.setStaleExpirationReaction({
      publication: { kind: "unavailable" },
      staleExpiration: { kind: "clear" },
      acquire: false,
    });
    harness.setAcquisition(
      Effect.succeed({
        beforeDirective: noReaction(),
        directive: { kind: "completed" },
        afterDirective: {
          publication: {
            kind: "available",
            usedPercent: 50,
            stale: true,
          },
          staleExpiration: { kind: "arm", atMs: 10_000 },
          acquire: false,
        },
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
      prepareRefresh: () =>
        Effect.succeed({
          kind: "ready",
          schedule: "preserve",
          reaction: noReaction(),
          execute: Effect.never.pipe(
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
      prepareRefresh: () =>
        Effect.succeed({
          kind: "ready",
          schedule: "preserve",
          reaction: noReaction(),
          execute: Effect.sync(() => {
            reads += 1;
            return {
              beforeDirective: noReaction(),
              directive: {
                kind: "temporary-failure" as const,
                retryAtMs: undefined,
              },
              afterDirective: noReaction(),
            };
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
