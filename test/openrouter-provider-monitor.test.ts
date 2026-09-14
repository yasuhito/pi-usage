import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, TestClock } from "effect";

import {
  OpenRouterManagementAuthenticationRejected,
  TemporaryOpenRouterAccountCreditBalanceFailure,
} from "../src/openrouter-account-credit-balance-acquisition.ts";
import type { OpenRouterManagementKey } from "../src/openrouter-management-key-resolution.ts";
import { makeOpenRouterProviderMonitor } from "../src/openrouter-provider-monitor.ts";
import type { OpenRouterAccountCreditBalanceStatus } from "../src/presentation.ts";

function managementKey(value: string): OpenRouterManagementKey {
  return value as OpenRouterManagementKey;
}

it.scoped("publishes OpenRouter account credit balance at startup", () =>
  Effect.gen(function* () {
    const statuses: OpenRouterAccountCreditBalanceStatus[] = [];
    let receivedCredential: string | undefined;
    let resolutions = 0;
    const monitor = yield* makeOpenRouterProviderMonitor({
      resolveManagementKey: () => {
        resolutions += 1;
        return Effect.succeed(managementKey("management-secret"));
      },
      acquireOpenRouterAccountCreditBalance: (credential) => {
        receivedCredential = credential;
        return Effect.succeed({
          totalCreditsUsd: 20,
          totalUsageUsd: 7.66,
          balanceUsd: 12.34,
        });
      },
      publish: (status) =>
        Effect.sync(() => {
          statuses.push(status);
        }),
    });

    yield* monitor.start;

    assert.equal(receivedCredential, "management-secret");
    assert.equal(resolutions, 1);
    assert.deepEqual(statuses, [
      { kind: "loading" },
      {
        kind: "openrouter-account-credit-balance",
        balanceUsd: 12.34,
        stale: false,
      },
    ]);
  }),
);

it.scoped("stays unavailable when the Management Key is missing", () =>
  Effect.gen(function* () {
    let reads = 0;
    const statuses: OpenRouterAccountCreditBalanceStatus[] = [];
    const monitor = yield* makeOpenRouterProviderMonitor({
      resolveManagementKey: () => Effect.succeed(undefined),
      acquireOpenRouterAccountCreditBalance: () => {
        reads += 1;
        return Effect.succeed({
          totalCreditsUsd: 20,
          totalUsageUsd: 7.66,
          balanceUsd: 12.34,
        });
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
  "refreshes after OpenRouter activity without polling or timer retries",
  () =>
    Effect.gen(function* () {
      let reads = 0;
      let fail = false;
      const monitor = yield* makeOpenRouterProviderMonitor({
        resolveManagementKey: () =>
          Effect.succeed(managementKey("management-secret")),
        acquireOpenRouterAccountCreditBalance: () => {
          reads += 1;
          return fail
            ? Effect.fail(new TemporaryOpenRouterAccountCreditBalanceFailure())
            : Effect.succeed({
                totalCreditsUsd: 20,
                totalUsageUsd: 7.66,
                balanceUsd: 12.34,
              });
        },
        publish: () => Effect.void,
        random: Effect.succeed(0.5),
      });

      yield* monitor.start;
      yield* TestClock.adjust("1 hour");
      assert.equal(reads, 1);

      fail = true;
      yield* monitor.refreshAfterActivity;
      yield* monitor.refreshAfterActivity;
      yield* TestClock.adjust("1 hour");
      assert.equal(reads, 2);

      fail = false;
      yield* monitor.refreshAfterActivity;
      assert.equal(reads, 3);
    }),
);

it.scoped("marks the last balance stale for at most ten minutes", () =>
  Effect.gen(function* () {
    let fail = false;
    const statuses: OpenRouterAccountCreditBalanceStatus[] = [];
    const monitor = yield* makeOpenRouterProviderMonitor({
      resolveManagementKey: () =>
        Effect.succeed(managementKey("management-secret")),
      acquireOpenRouterAccountCreditBalance: () =>
        fail
          ? Effect.fail(new TemporaryOpenRouterAccountCreditBalanceFailure())
          : Effect.succeed({
              totalCreditsUsd: 20,
              totalUsageUsd: 7.66,
              balanceUsd: 12.34,
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
    assert.deepEqual(statuses.at(-1), {
      kind: "openrouter-account-credit-balance",
      balanceUsd: 12.34,
      stale: true,
    });

    yield* TestClock.adjust("599999 millis");
    assert.equal(statuses.at(-1)?.kind, "openrouter-account-credit-balance");
    yield* TestClock.adjust("1 millis");
    assert.deepEqual(statuses.at(-1), { kind: "unavailable" });
  }),
);

it.scoped("does not retry a rejected static Management Key immediately", () =>
  Effect.gen(function* () {
    let reads = 0;
    const statuses: OpenRouterAccountCreditBalanceStatus[] = [];
    const monitor = yield* makeOpenRouterProviderMonitor({
      resolveManagementKey: () =>
        Effect.succeed(managementKey("management-secret")),
      acquireOpenRouterAccountCreditBalance: () => {
        reads += 1;
        return Effect.fail(new OpenRouterManagementAuthenticationRejected());
      },
      publish: (status) =>
        Effect.sync(() => {
          statuses.push(status);
        }),
    });

    yield* monitor.start;

    assert.equal(reads, 1);
    assert.deepEqual(statuses.at(-1), { kind: "unavailable" });
  }),
);
