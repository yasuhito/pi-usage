import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Exit, Fiber, TestClock } from "effect";

import {
  createAcquireOpenRouterAccountCreditBalance,
  type OpenRouterManagementKey,
} from "../src/openrouter-account-credit-balance-acquisition.ts";

function managementKey(value: string): OpenRouterManagementKey {
  return value as OpenRouterManagementKey;
}

function failureTag(exit: Exit.Exit<unknown, unknown>) {
  if (!Exit.isFailure(exit) || exit.cause._tag !== "Fail") return undefined;
  const error = exit.cause.error;
  return typeof error === "object" && error !== null
    ? Reflect.get(error, "_tag")
    : undefined;
}

it.effect("acquires and derives the OpenRouter account credit balance", () =>
  Effect.gen(function* () {
    let request: [RequestInfo | URL, RequestInit | undefined] | undefined;
    const balance = yield* createAcquireOpenRouterAccountCreditBalance({
      fetch: async (input, init) => {
        request = [input, init];
        return new Response(
          JSON.stringify({
            data: {
              total_credits: 20,
              total_usage: 7.66,
              future_field: true,
            },
          }),
        );
      },
    })(managementKey("management-secret"));

    assert.deepEqual(balance, {
      totalCreditsUsd: 20,
      totalUsageUsd: 7.66,
      balanceUsd: 12.34,
    });
    assert.equal(request?.[0], "https://openrouter.ai/api/v1/credits");
    assert.equal(request?.[1]?.method, "GET");
    assert.equal(request?.[1]?.redirect, "manual");
    assert.deepEqual(request?.[1]?.headers, {
      Accept: "application/json",
      Authorization: "Bearer management-secret",
    });
    assert.ok(request?.[1]?.signal instanceof AbortSignal);
  }),
);

it.effect("preserves zero and negative account credit balances", () =>
  Effect.gen(function* () {
    for (const [totalCredits, totalUsage, expected] of [
      [20, 20, 0],
      [20, 21.25, -1.25],
    ] as const) {
      const balance = yield* createAcquireOpenRouterAccountCreditBalance({
        fetch: async () =>
          new Response(
            JSON.stringify({
              data: {
                total_credits: totalCredits,
                total_usage: totalUsage,
              },
            }),
          ),
      })(managementKey("management-secret"));
      assert.equal(balance.balanceUsd, expected);
    }
  }),
);

it.effect("rejects malformed credit totals", () =>
  Effect.gen(function* () {
    for (const data of [
      {},
      { total_credits: -1, total_usage: 0 },
      { total_credits: 1, total_usage: -1 },
      { total_credits: "20", total_usage: 1 },
    ]) {
      const exit = yield* Effect.exit(
        createAcquireOpenRouterAccountCreditBalance({
          fetch: async () => new Response(JSON.stringify({ data })),
        })(managementKey("management-secret")),
      );
      assert.equal(failureTag(exit), "MalformedOpenRouterAccountCreditBalance");
    }
  }),
);

it.effect("classifies failures without exposing Management Key data", () =>
  Effect.gen(function* () {
    for (const [status, expectedTag] of [
      [401, "OpenRouterManagementAuthenticationRejected"],
      [403, "OpenRouterManagementAuthenticationRejected"],
      [408, "TemporaryOpenRouterAccountCreditBalanceFailure"],
      [425, "TemporaryOpenRouterAccountCreditBalanceFailure"],
      [429, "TemporaryOpenRouterAccountCreditBalanceFailure"],
      [503, "TemporaryOpenRouterAccountCreditBalanceFailure"],
      [302, "PermanentOpenRouterAccountCreditBalanceFailure"],
      [400, "PermanentOpenRouterAccountCreditBalanceFailure"],
    ] as const) {
      const exit = yield* Effect.exit(
        createAcquireOpenRouterAccountCreditBalance({
          fetch: async () =>
            new Response("raw-response-secret", {
              status,
              headers: { "x-secret": "header-secret" },
            }),
        })(managementKey("management-secret")),
      );
      const serialized = JSON.stringify(exit);
      assert.equal(failureTag(exit), expectedTag);
      for (const secret of [
        "management-secret",
        "raw-response-secret",
        "header-secret",
        "x-secret",
      ]) {
        assert.equal(serialized.includes(secret), false);
      }
    }
  }),
);

it.effect("bounds response bodies at 64 KiB", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      createAcquireOpenRouterAccountCreditBalance({
        fetch: async () =>
          new Response("{}", {
            headers: { "content-length": String(64 * 1024 + 1) },
          }),
      })(managementKey("management-secret")),
    );
    assert.equal(failureTag(exit), "MalformedOpenRouterAccountCreditBalance");
  }),
);

it.effect("times out a stalled credits request after five seconds", () =>
  Effect.gen(function* () {
    const fiber = yield* Effect.fork(
      Effect.exit(
        createAcquireOpenRouterAccountCreditBalance({
          fetch: (_input, init) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () => reject(init.signal?.reason),
                { once: true },
              );
            }),
        })(managementKey("management-secret")),
      ),
    );
    yield* TestClock.adjust("5 seconds");
    assert.equal(
      failureTag(yield* Fiber.join(fiber)),
      "TemporaryOpenRouterAccountCreditBalanceFailure",
    );
  }),
);
