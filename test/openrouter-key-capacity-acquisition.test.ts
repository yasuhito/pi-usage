import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Exit, Fiber, TestClock } from "effect";

import {
  createAcquireOpenRouterKeyCapacity,
  type OpenRouterApiKey,
} from "../src/openrouter-key-capacity-acquisition.ts";

function apiKey(value: string): OpenRouterApiKey {
  return value as OpenRouterApiKey;
}

function failureTag(exit: Exit.Exit<unknown, unknown>) {
  if (!Exit.isFailure(exit) || exit.cause._tag !== "Fail") return undefined;
  const error = exit.cause.error;
  return typeof error === "object" && error !== null
    ? Reflect.get(error, "_tag")
    : undefined;
}

it.effect("acquires the authenticated OpenRouter key remaining spend", () =>
  Effect.gen(function* () {
    let request: [RequestInfo | URL, RequestInit | undefined] | undefined;
    const capacity = yield* createAcquireOpenRouterKeyCapacity({
      fetch: async (input, init) => {
        request = [input, init];
        return new Response(
          JSON.stringify({
            data: {
              limit: 20,
              limit_remaining: 12.34,
              limit_reset: null,
              expires_at: null,
              future_field: true,
            },
          }),
        );
      },
    })(apiKey("secret"));

    assert.deepEqual(capacity, {
      kind: "limited",
      remainingUsd: 12.34,
    });
    assert.equal(request?.[0], "https://openrouter.ai/api/v1/key");
    assert.equal(request?.[1]?.method, "GET");
    assert.equal(request?.[1]?.redirect, "manual");
    assert.deepEqual(request?.[1]?.headers, {
      Accept: "application/json",
      Authorization: "Bearer secret",
    });
    assert.ok(request?.[1]?.signal instanceof AbortSignal);
  }),
);

it.effect("distinguishes a key with no configured spending limit", () =>
  Effect.gen(function* () {
    const capacity = yield* createAcquireOpenRouterKeyCapacity({
      fetch: async () =>
        new Response(
          JSON.stringify({
            data: {
              limit: null,
              limit_remaining: null,
              limit_reset: null,
              expires_at: null,
            },
          }),
        ),
    })(apiKey("secret"));

    assert.deepEqual(capacity, { kind: "no-limit" });
  }),
);

it.effect("retains the provider's next spending-limit reset deadline", () =>
  Effect.gen(function* () {
    const capacity = yield* createAcquireOpenRouterKeyCapacity({
      fetch: async () =>
        new Response(
          JSON.stringify({
            data: {
              limit: 20,
              limit_remaining: 12.34,
              limit_reset: "daily",
              expires_at: null,
            },
          }),
        ),
    })(apiKey("secret"));

    assert.deepEqual(capacity, {
      kind: "limited",
      remainingUsd: 12.34,
      validUntilMs: Date.UTC(1970, 0, 2),
    });
  }),
);

it.effect("rejects malformed or inconsistent spending limits", () =>
  Effect.gen(function* () {
    for (const data of [
      { limit: null, limit_remaining: 1, limit_reset: null, expires_at: null },
      { limit: 20, limit_remaining: null, limit_reset: null, expires_at: null },
      { limit: 20, limit_remaining: -1, limit_reset: null, expires_at: null },
      { limit: 20, limit_remaining: 21, limit_reset: null, expires_at: null },
      { limit: "20", limit_remaining: 12, limit_reset: null, expires_at: null },
      {
        limit: 20,
        limit_remaining: 12,
        limit_reset: "yearly",
        expires_at: null,
      },
      {
        limit: 20,
        limit_remaining: 12,
        limit_reset: null,
        expires_at: "not-an-instant",
      },
    ]) {
      const exit = yield* Effect.exit(
        createAcquireOpenRouterKeyCapacity({
          fetch: async () => new Response(JSON.stringify({ data })),
        })(apiKey("secret")),
      );
      assert.equal(
        failureTag(exit),
        "MalformedOpenRouterKeyCapacity",
        JSON.stringify(data),
      );
    }
  }),
);

it.effect("classifies unsuccessful responses without exposing secrets", () =>
  Effect.gen(function* () {
    for (const [status, expectedTag] of [
      [401, "OpenRouterAuthenticationRejected"],
      [403, "OpenRouterAuthenticationRejected"],
      [408, "TemporaryOpenRouterKeyCapacityFailure"],
      [425, "TemporaryOpenRouterKeyCapacityFailure"],
      [429, "TemporaryOpenRouterKeyCapacityFailure"],
      [503, "TemporaryOpenRouterKeyCapacityFailure"],
      [302, "PermanentOpenRouterKeyCapacityFailure"],
      [400, "PermanentOpenRouterKeyCapacityFailure"],
    ] as const) {
      const exit = yield* Effect.exit(
        createAcquireOpenRouterKeyCapacity({
          fetch: async () =>
            new Response("raw-response-secret", {
              status,
              headers: { "x-secret": "header-secret" },
            }),
        })(apiKey("credential-secret")),
      );
      const serialized = JSON.stringify(exit);
      assert.equal(failureTag(exit), expectedTag);
      for (const secret of [
        "credential-secret",
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
      createAcquireOpenRouterKeyCapacity({
        fetch: async () =>
          new Response("{}", {
            headers: { "content-length": String(64 * 1024 + 1) },
          }),
      })(apiKey("secret")),
    );
    assert.equal(failureTag(exit), "MalformedOpenRouterKeyCapacity");
  }),
);

it.effect("times out a stalled request after five seconds", () =>
  Effect.gen(function* () {
    const fiber = yield* Effect.fork(
      Effect.exit(
        createAcquireOpenRouterKeyCapacity({
          fetch: (_input, init) =>
            new Promise((_resolve, reject) => {
              init?.signal?.addEventListener(
                "abort",
                () => reject(init.signal?.reason),
                { once: true },
              );
            }),
        })(apiKey("secret")),
      ),
    );
    yield* TestClock.adjust("5 seconds");
    assert.equal(
      failureTag(yield* Fiber.join(fiber)),
      "TemporaryOpenRouterKeyCapacityFailure",
    );
  }),
);
