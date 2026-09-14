import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Equal, Exit } from "effect";

import {
  createAcquireOpenRouterAccountCreditBalance,
  type OpenRouterManagementKey,
  TemporaryOpenRouterAccountCreditBalanceFailure,
} from "../src/openrouter-account-credit-balance-acquisition.ts";

function managementKey(value: string): OpenRouterManagementKey {
  return value as OpenRouterManagementKey;
}

function acquire(fetch: typeof globalThis.fetch) {
  return createAcquireOpenRouterAccountCreditBalance({ fetch })(
    managementKey("management-secret"),
  );
}

function failure(exit: Exit.Exit<unknown, unknown>): unknown {
  return Exit.isFailure(exit) && exit.cause._tag === "Fail"
    ? exit.cause.error
    : undefined;
}

function failureTag(exit: Exit.Exit<unknown, unknown>) {
  const error = failure(exit);
  return typeof error === "object" && error !== null
    ? Reflect.get(error, "_tag")
    : undefined;
}

it.effect("acquires and derives the OpenRouter account credit balance", () =>
  Effect.gen(function* () {
    let request: [RequestInfo | URL, RequestInit | undefined] | undefined;
    const balance = yield* acquire(async (input, init) => {
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
    });

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
      const balance = yield* acquire(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                total_credits: totalCredits,
                total_usage: totalUsage,
              },
            }),
          ),
      );
      assert.equal(balance.balanceUsd, expected);
    }
  }),
);

it.effect("rejects malformed credit totals without carrying them", () =>
  Effect.gen(function* () {
    for (const data of [
      {},
      { total_credits: -1, total_usage: 0 },
      { total_credits: 1, total_usage: -1 },
      { total_credits: "raw-response-secret", total_usage: 1 },
    ]) {
      const exit = yield* Effect.exit(
        acquire(async () => new Response(JSON.stringify({ data }))),
      );
      assert.equal(failureTag(exit), "MalformedOpenRouterAccountCreditBalance");
      assert.equal(JSON.stringify(exit).includes("raw-response-secret"), false);
    }
  }),
);

it.effect("maps every exchange outcome to an acquisition failure", () =>
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
        acquire(async () => new Response("{", { status })),
      );
      assert.equal(failureTag(exit), expectedTag, String(status));
    }
    const malformed = yield* Effect.exit(
      acquire(async () => new Response("{")),
    );
    assert.equal(
      failureTag(malformed),
      "MalformedOpenRouterAccountCreditBalance",
    );

    const rejected = yield* Effect.exit(
      acquire(async () => {
        throw new Error("network unavailable");
      }),
    );
    assert.equal(
      Equal.equals(
        failure(rejected),
        new TemporaryOpenRouterAccountCreditBalanceFailure(),
      ),
      true,
    );
  }),
);

it.effect("adopts Retry-After on every temporary outcome", () =>
  Effect.gen(function* () {
    for (const status of [429, 503]) {
      const exit = yield* Effect.exit(
        acquire(
          async () =>
            new Response(null, {
              status,
              headers: { "retry-after": "120" },
            }),
        ),
      );
      assert.equal(
        Equal.equals(
          failure(exit),
          new TemporaryOpenRouterAccountCreditBalanceFailure({
            retryAtMs: 120_000,
          }),
        ),
        true,
        String(status),
      );
    }
    const withoutInstruction = yield* Effect.exit(
      acquire(async () => new Response(null, { status: 429 })),
    );
    assert.equal(
      Equal.equals(
        failure(withoutInstruction),
        new TemporaryOpenRouterAccountCreditBalanceFailure(),
      ),
      true,
    );
  }),
);

it.effect("bounds response bodies at 64 KiB", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      acquire(
        async () =>
          new Response("{}", {
            headers: { "content-length": String(64 * 1024 + 1) },
          }),
      ),
    );
    assert.equal(failureTag(exit), "MalformedOpenRouterAccountCreditBalance");
  }),
);
