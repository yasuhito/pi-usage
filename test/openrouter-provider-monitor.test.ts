import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, TestClock } from "effect";
import { TemporaryOpenRouterKeyCapacityFailure } from "../src/openrouter-key-capacity-acquisition.ts";
import { makeOpenRouterProviderMonitor } from "../src/openrouter-provider-monitor.ts";
import type { OpenRouterKeyCapacityStatus } from "../src/presentation.ts";

it.scoped("publishes OpenRouter key remaining spend at startup", () =>
  Effect.gen(function* () {
    const statuses: OpenRouterKeyCapacityStatus[] = [];
    let receivedCredential: string | undefined;
    const monitor = yield* makeOpenRouterProviderMonitor({
      resolveAuthentication: () =>
        Effect.succeed({ auth: { apiKey: "  secret  " } }),
      acquireOpenRouterKeyCapacity: (credential) => {
        receivedCredential = credential;
        return Effect.succeed({ kind: "limited", remainingUsd: 12.34 });
      },
      publish: (status) =>
        Effect.sync(() => {
          statuses.push(status);
        }),
    });

    yield* monitor.start;

    assert.equal(receivedCredential, "secret");
    assert.deepEqual(statuses, [
      { kind: "loading" },
      {
        kind: "openrouter-key-remaining-spend",
        remainingUsd: 12.34,
        stale: false,
      },
    ]);
  }),
);

it.scoped("publishes a key with no configured spending limit", () =>
  Effect.gen(function* () {
    const statuses: OpenRouterKeyCapacityStatus[] = [];
    const monitor = yield* makeOpenRouterProviderMonitor({
      resolveAuthentication: () =>
        Effect.succeed({ auth: { apiKey: "secret" } }),
      acquireOpenRouterKeyCapacity: () => Effect.succeed({ kind: "no-limit" }),
      publish: (status) =>
        Effect.sync(() => {
          statuses.push(status);
        }),
    });

    yield* monitor.start;

    assert.deepEqual(statuses.at(-1), {
      kind: "openrouter-key-no-limit",
      stale: false,
    });
  }),
);

it.scoped("stays unavailable when OpenRouter authentication is missing", () =>
  Effect.gen(function* () {
    let reads = 0;
    const statuses: OpenRouterKeyCapacityStatus[] = [];
    const monitor = yield* makeOpenRouterProviderMonitor({
      resolveAuthentication: () => Effect.succeed(undefined),
      acquireOpenRouterKeyCapacity: () => {
        reads += 1;
        return Effect.succeed({ kind: "limited", remainingUsd: 12.34 });
      },
      publish: (status) =>
        Effect.sync(() => {
          statuses.push(status);
        }),
    });

    yield* monitor.start;

    assert.equal(reads, 0);
    assert.deepEqual(statuses.at(-1), { kind: "unavailable" });
  }),
);

it.scoped(
  "refreshes after OpenRouter activity without polling or failure retries",
  () =>
    Effect.gen(function* () {
      let reads = 0;
      let fail = false;
      const monitor = yield* makeOpenRouterProviderMonitor({
        resolveAuthentication: () =>
          Effect.succeed({ auth: { apiKey: "secret" } }),
        acquireOpenRouterKeyCapacity: () => {
          reads += 1;
          return fail
            ? Effect.fail(new TemporaryOpenRouterKeyCapacityFailure())
            : Effect.succeed({ kind: "limited", remainingUsd: 12.34 });
        },
        publish: () => Effect.void,
      });

      yield* monitor.start;
      yield* TestClock.adjust("1 hour");
      assert.equal(reads, 1);

      fail = true;
      yield* monitor.refreshAfterActivity;
      yield* monitor.refreshAfterActivity;
      yield* monitor.refreshForAccountChange;
      assert.equal(reads, 2);
      yield* TestClock.adjust("1 hour");
      assert.equal(reads, 2);

      fail = false;
      yield* monitor.refreshAfterActivity;
      assert.equal(reads, 3);
    }),
);

it.scoped("marks the last amount stale for at most ten minutes", () =>
  Effect.gen(function* () {
    let fail = false;
    const statuses: OpenRouterKeyCapacityStatus[] = [];
    const monitor = yield* makeOpenRouterProviderMonitor({
      resolveAuthentication: () =>
        Effect.succeed({ auth: { apiKey: "secret" } }),
      acquireOpenRouterKeyCapacity: () =>
        fail
          ? Effect.fail(new TemporaryOpenRouterKeyCapacityFailure())
          : Effect.succeed({ kind: "limited" as const, remainingUsd: 12.34 }),
      publish: (status) =>
        Effect.sync(() => {
          statuses.push(status);
        }),
      random: Effect.succeed(0.5),
    });

    yield* monitor.start;
    fail = true;
    yield* monitor.refreshForAccountChange;
    assert.deepEqual(statuses.at(-1), {
      kind: "openrouter-key-remaining-spend",
      remainingUsd: 12.34,
      stale: true,
    });

    yield* TestClock.adjust("599999 millis");
    assert.equal(statuses.at(-1)?.kind, "openrouter-key-remaining-spend");
    yield* TestClock.adjust("1 millis");
    assert.deepEqual(statuses.at(-1), { kind: "unavailable" });
  }),
);

it.scoped("invalidates fresh capacity at its reset or expiration", () =>
  Effect.gen(function* () {
    const statuses: OpenRouterKeyCapacityStatus[] = [];
    const monitor = yield* makeOpenRouterProviderMonitor({
      resolveAuthentication: () =>
        Effect.succeed({ auth: { apiKey: "secret" } }),
      acquireOpenRouterKeyCapacity: () =>
        Effect.succeed({
          kind: "limited",
          remainingUsd: 12.34,
          validUntilMs: 120_000,
        }),
      publish: (status) =>
        Effect.sync(() => {
          statuses.push(status);
        }),
    });

    yield* monitor.start;
    yield* TestClock.adjust("119999 millis");
    assert.equal(statuses.at(-1)?.kind, "openrouter-key-remaining-spend");
    yield* TestClock.adjust("1 millis");
    assert.deepEqual(statuses.at(-1), { kind: "unavailable" });
  }),
);

it.scoped("does not retain stale capacity beyond its reset or expiration", () =>
  Effect.gen(function* () {
    let fail = false;
    const statuses: OpenRouterKeyCapacityStatus[] = [];
    const monitor = yield* makeOpenRouterProviderMonitor({
      resolveAuthentication: () =>
        Effect.succeed({ auth: { apiKey: "secret" } }),
      acquireOpenRouterKeyCapacity: () =>
        fail
          ? Effect.fail(new TemporaryOpenRouterKeyCapacityFailure())
          : Effect.succeed({
              kind: "limited" as const,
              remainingUsd: 12.34,
              validUntilMs: 120_000,
            }),
      publish: (status) =>
        Effect.sync(() => {
          statuses.push(status);
        }),
      random: Effect.succeed(0.5),
    });

    yield* monitor.start;
    fail = true;
    yield* monitor.refreshForAccountChange;
    yield* TestClock.adjust("119999 millis");
    assert.equal(statuses.at(-1)?.kind, "openrouter-key-remaining-spend");
    yield* TestClock.adjust("1 millis");
    assert.deepEqual(statuses.at(-1), { kind: "unavailable" });
  }),
);
