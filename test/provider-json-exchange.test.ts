import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Cause, Data, Effect, Exit, Fiber, Option, TestClock } from "effect";

import {
  exchangeProviderJson,
  type ProviderJsonExchangeRequest,
} from "../src/provider-json-exchange.ts";

const TARGET = "https://provider.example/target-secret";
const HEADERS = {
  Authorization: "Bearer credential-secret",
  "X-Account": "account-secret",
};
const MAXIMUM_BYTES = 1024;
const PRIVATE_VALUES = [
  "credential-secret",
  "account-secret",
  "target-secret",
  "raw-response-secret",
  "header-secret",
  "x-secret",
  "transport-secret",
  "cleanup-secret",
];

class InterpretationRejected extends Data.TaggedError(
  "InterpretationRejected",
)<{
  readonly detail: string;
}> {}

function request(
  overrides: Partial<ProviderJsonExchangeRequest> = {},
): ProviderJsonExchangeRequest {
  return {
    target: TARGET,
    method: "GET",
    headers: HEADERS,
    maximumResponseBytes: MAXIMUM_BYTES,
    ...overrides,
  };
}

function exchange(
  fetch: typeof globalThis.fetch,
  overrides: Partial<ProviderJsonExchangeRequest> = {},
) {
  return exchangeProviderJson(fetch, request(overrides), Effect.succeed);
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

function failureField(exit: Exit.Exit<unknown, unknown>, field: string) {
  const error = failure(exit);
  return typeof error === "object" && error !== null
    ? Reflect.get(error, field)
    : undefined;
}

function assertSecretSafe(exit: Exit.Exit<unknown, unknown>, label: string) {
  const serialized = JSON.stringify(exit);
  for (const privateValue of PRIVATE_VALUES) {
    assert.equal(
      serialized.includes(privateValue),
      false,
      `${label}: ${privateValue}`,
    );
  }
}

function stalledFetch(onAbort?: () => void): typeof globalThis.fetch {
  return (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener(
        "abort",
        () => {
          onAbort?.();
          reject(init.signal?.reason);
        },
        { once: true },
      );
    });
}

function trackedStream(options: {
  readonly chunks?: readonly Uint8Array[];
  readonly close?: boolean;
  readonly onCancel?: () => Promise<void> | void;
}) {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of options.chunks ?? []) controller.enqueue(chunk);
      if (options.close ?? false) controller.close();
    },
    pull() {},
    cancel() {
      cancelled = true;
      return options.onCancel?.();
    },
  });
  return { stream, cancelled: () => cancelled };
}

it.effect("sends the provider's request facts with manual redirects", () =>
  Effect.gen(function* () {
    let observed: [RequestInfo | URL, RequestInit | undefined] | undefined;
    const body = yield* exchange(async (input, init) => {
      observed = [input, init];
      return new Response('{"windows":[1,"é"]}');
    });
    assert.deepEqual(body, { windows: [1, "é"] });
    assert.equal(observed?.[0], TARGET);
    assert.equal(observed?.[1]?.method, "GET");
    assert.deepEqual(observed?.[1]?.headers, HEADERS);
    assert.equal(observed?.[1]?.redirect, "manual");
    assert.ok(observed?.[1]?.signal instanceof AbortSignal);
  }),
);

it.effect("decodes UTF-8 across streamed chunk boundaries", () =>
  Effect.gen(function* () {
    const { stream } = trackedStream({
      chunks: [new Uint8Array([0x22, 0xc3]), new Uint8Array([0xa9, 0x22])],
      close: true,
    });
    const body = yield* exchange(async () => new Response(stream));
    assert.equal(body, "é");
  }),
);

it.effect("classifies HTTP statuses into neutral failures with status", () =>
  Effect.gen(function* () {
    const cases = [
      [401, "ProviderJsonExchangeAuthenticationRejected"],
      [403, "ProviderJsonExchangeAuthenticationRejected"],
      [408, "TemporaryProviderJsonExchangeFailure"],
      [425, "TemporaryProviderJsonExchangeFailure"],
      [429, "TemporaryProviderJsonExchangeFailure"],
      [500, "TemporaryProviderJsonExchangeFailure"],
      [503, "TemporaryProviderJsonExchangeFailure"],
      [302, "PermanentProviderJsonExchangeFailure"],
      [400, "PermanentProviderJsonExchangeFailure"],
      [404, "PermanentProviderJsonExchangeFailure"],
    ] as const;
    for (const [status, tag] of cases) {
      const exit = yield* Effect.exit(
        exchange(async () => new Response("{}", { status })),
      );
      assert.equal(failureTag(exit), tag, String(status));
      assert.equal(failureField(exit, "status"), status, String(status));
      assert.equal(failureField(exit, "retryAtMs"), undefined, String(status));
    }
  }),
);

it.effect("normalizes strict Retry-After against the Effect clock", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(10_000);
    for (const status of [408, 425, 429, 503]) {
      for (const [value, expected] of [
        ["120", 130_000],
        ["Thu, 01 Jan 1970 00:02:00 GMT", 120_000],
      ] as const) {
        const exit = yield* Effect.exit(
          exchange(
            async () =>
              new Response(null, { status, headers: { "retry-after": value } }),
          ),
        );
        assert.equal(failureTag(exit), "TemporaryProviderJsonExchangeFailure");
        assert.equal(failureField(exit, "retryAtMs"), expected, value);
      }
    }
    for (const value of [
      "1.5",
      "-10",
      "+5",
      "0x10",
      "later",
      "Thu, 01 Jan 1970 00:02:00 UTC",
      "Thu, 1 Jan 1970 00:02:00 GMT",
    ]) {
      const exit = yield* Effect.exit(
        exchange(
          async () =>
            new Response(null, {
              status: 429,
              headers: { "retry-after": value },
            }),
        ),
      );
      assert.equal(failureTag(exit), "TemporaryProviderJsonExchangeFailure");
      assert.equal(failureField(exit, "retryAtMs"), undefined, value);
    }
    const permanent = yield* Effect.exit(
      exchange(
        async () =>
          new Response(null, {
            status: 302,
            headers: { "retry-after": "120" },
          }),
      ),
    );
    assert.equal(failureTag(permanent), "PermanentProviderJsonExchangeFailure");
    assert.equal(failureField(permanent, "retryAtMs"), undefined);
  }),
);

it.effect("maps a rejected fetch to a temporary failure without a status", () =>
  Effect.gen(function* () {
    const exit = yield* Effect.exit(
      exchange(async () => {
        throw new Error("transport-secret");
      }),
    );
    assert.equal(failureTag(exit), "TemporaryProviderJsonExchangeFailure");
    assert.equal(failureField(exit, "status"), undefined);
    assert.equal(failureField(exit, "retryAtMs"), undefined);
    assertSecretSafe(exit, "rejected fetch");
  }),
);

it.effect("maps a failed body read to a temporary failure", () =>
  Effect.gen(function* () {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0x7b]));
        controller.error(new Error("transport-secret"));
      },
    });
    const exit = yield* Effect.exit(exchange(async () => new Response(stream)));
    assert.equal(failureTag(exit), "TemporaryProviderJsonExchangeFailure");
    assert.equal(failureField(exit, "status"), undefined);
    assertSecretSafe(exit, "failed body read");
  }),
);

it.effect("times out the whole exchange after five seconds", () =>
  Effect.gen(function* () {
    let aborted = false;
    const duringFetch = yield* Effect.fork(
      Effect.exit(
        exchange(
          stalledFetch(() => {
            aborted = true;
          }),
        ),
      ),
    );
    yield* TestClock.adjust("5 seconds");
    const fetchExit = yield* Fiber.join(duringFetch);
    assert.equal(failureTag(fetchExit), "TemporaryProviderJsonExchangeFailure");
    assert.equal(failureField(fetchExit, "status"), undefined);
    assert.equal(aborted, true);

    const stalledBody = trackedStream({});
    const duringBody = yield* Effect.fork(
      Effect.exit(exchange(async () => new Response(stalledBody.stream))),
    );
    yield* Effect.yieldNow();
    yield* TestClock.adjust("5 seconds");
    const bodyExit = yield* Fiber.join(duringBody);
    assert.equal(failureTag(bodyExit), "TemporaryProviderJsonExchangeFailure");
    assert.equal(stalledBody.cancelled(), true);

    let interpreting = false;
    const finalized = trackedStream({
      chunks: [new TextEncoder().encode("{}")],
      close: true,
    });
    const duringInterpretation = yield* Effect.fork(
      Effect.exit(
        exchangeProviderJson(
          async () => new Response(finalized.stream),
          request(),
          () =>
            Effect.suspend(() => {
              interpreting = true;
              return Effect.sleep("10 seconds");
            }),
        ),
      ),
    );
    while (!interpreting) yield* Effect.yieldNow();
    yield* TestClock.adjust("5 seconds");
    const interpretationExit = yield* Fiber.join(duringInterpretation);
    assert.equal(
      failureTag(interpretationExit),
      "TemporaryProviderJsonExchangeFailure",
    );
    assert.equal(finalized.stream.locked, false);
  }),
);

it.effect("interrupts the exchange without producing a failure", () =>
  Effect.gen(function* () {
    let aborted = false;
    const duringFetch = yield* Effect.fork(
      exchange(
        stalledFetch(() => {
          aborted = true;
        }),
      ),
    );
    yield* Effect.yieldNow();
    const fetchExit = yield* Fiber.interrupt(duringFetch);
    assert.equal(Exit.isInterrupted(fetchExit), true);
    assert.equal(aborted, true);

    const stalledBody = trackedStream({});
    const duringBody = yield* Effect.fork(
      exchange(async () => new Response(stalledBody.stream)),
    );
    while (!stalledBody.stream.locked) yield* Effect.yieldNow();
    const bodyExit = yield* Fiber.interrupt(duringBody);
    assert.equal(Exit.isInterrupted(bodyExit), true);
    assert.equal(stalledBody.cancelled(), true);
    assert.equal(stalledBody.stream.locked, false);
  }),
);

it.effect("finalizes the response for every classified outcome", () =>
  Effect.gen(function* () {
    for (const status of [401, 403, 408, 429, 500, 302, 400]) {
      const { stream, cancelled } = trackedStream({});
      const exit = yield* Effect.exit(
        exchange(async () => new Response(stream, { status })),
      );
      assert.equal(Exit.isFailure(exit), true, String(status));
      assert.equal(cancelled(), true, String(status));
      assert.equal(stream.locked, false, String(status));
    }
    const { stream } = trackedStream({
      chunks: [new TextEncoder().encode("{}")],
      close: true,
    });
    assert.deepEqual(yield* exchange(async () => new Response(stream)), {});
    assert.equal(stream.locked, false);
  }),
);

it.effect("awaits streamed cancellation before completing", () =>
  Effect.gen(function* () {
    let finishCancellation: (() => void) | undefined;
    const { stream, cancelled } = trackedStream({
      chunks: [new Uint8Array(MAXIMUM_BYTES + 1)],
      onCancel: () =>
        new Promise<void>((resolve) => {
          finishCancellation = resolve;
        }),
    });
    const fiber = yield* Effect.fork(
      Effect.exit(exchange(async () => new Response(stream))),
    );
    while (!cancelled()) yield* Effect.yieldNow();
    yield* Effect.promise<void>(
      () => new Promise((resolve) => setImmediate(resolve)),
    );
    assert.equal((yield* Fiber.poll(fiber))._tag, "None");
    assert.ok(finishCancellation);
    finishCancellation();
    assert.equal(
      failureTag(yield* Fiber.join(fiber)),
      "MalformedProviderJsonExchange",
    );
    assert.equal(stream.locked, false);
  }),
);

it.effect(
  "awaits cancellation and releases the lock for a declared overflow",
  () =>
    Effect.gen(function* () {
      let finishCancellation: (() => void) | undefined;
      const { stream, cancelled } = trackedStream({
        onCancel: () =>
          new Promise<void>((resolve) => {
            finishCancellation = resolve;
          }),
      });
      const fiber = yield* Effect.fork(
        Effect.exit(
          exchange(
            async () =>
              new Response(stream, {
                headers: { "content-length": String(MAXIMUM_BYTES + 1) },
              }),
          ),
        ),
      );
      while (!cancelled()) yield* Effect.yieldNow();
      assert.equal((yield* Fiber.poll(fiber))._tag, "None");
      assert.equal(stream.locked, true);
      assert.ok(finishCancellation);
      finishCancellation();
      assert.equal(
        failureTag(yield* Fiber.join(fiber)),
        "MalformedProviderJsonExchange",
      );
      assert.equal(stream.locked, false);
    }),
);

it.effect("preserves the outcome when response cleanup fails", () =>
  Effect.gen(function* () {
    const rejected = trackedStream({
      onCancel: () => Promise.reject(new Error("cleanup-secret")),
    });
    const rejectedExit = yield* Effect.exit(
      exchange(async () => new Response(rejected.stream, { status: 401 })),
    );
    assert.equal(
      failureTag(rejectedExit),
      "ProviderJsonExchangeAuthenticationRejected",
    );
    assert.equal(rejected.stream.locked, false);
    assertSecretSafe(rejectedExit, "cleanup after rejection");

    const overflowed = trackedStream({
      chunks: [new Uint8Array(MAXIMUM_BYTES + 1)],
      onCancel: () => Promise.reject(new Error("cleanup-secret")),
    });
    const overflowExit = yield* Effect.exit(
      exchange(async () => new Response(overflowed.stream)),
    );
    assert.equal(failureTag(overflowExit), "MalformedProviderJsonExchange");
    assert.equal(overflowed.stream.locked, false);
    assertSecretSafe(overflowExit, "cleanup after overflow");
  }),
);

it.effect("bounds declared and streamed bodies at the configured limit", () =>
  Effect.gen(function* () {
    let interpreted = 0;
    const declared = trackedStream({});
    const declaredExit = yield* Effect.exit(
      exchangeProviderJson(
        async () =>
          new Response(declared.stream, {
            headers: { "content-length": String(MAXIMUM_BYTES + 1) },
          }),
        request(),
        (body) => Effect.sync(() => (interpreted += 1)).pipe(Effect.as(body)),
      ),
    );
    assert.equal(failureTag(declaredExit), "MalformedProviderJsonExchange");
    assert.equal(declared.cancelled(), true);
    assert.equal(interpreted, 0);

    const streamed = trackedStream({
      chunks: [new Uint8Array(MAXIMUM_BYTES + 1)],
    });
    const streamedExit = yield* Effect.exit(
      exchange(async () => new Response(streamed.stream)),
    );
    assert.equal(failureTag(streamedExit), "MalformedProviderJsonExchange");
    assert.equal(streamed.cancelled(), true);

    const exact = yield* exchange(async () => new Response('"ab"'), {
      maximumResponseBytes: 4,
    });
    assert.equal(exact, "ab");
    const overflowing = yield* Effect.exit(
      exchange(async () => new Response('"abc"'), { maximumResponseBytes: 4 }),
    );
    assert.equal(failureTag(overflowing), "MalformedProviderJsonExchange");

    const undeclared = yield* exchange(
      async () =>
        new Response("{}", { headers: { "content-length": "not-a-size" } }),
    );
    assert.deepEqual(undeclared, {});
  }),
);

it.effect("treats invalid JSON and empty bodies as malformed", () =>
  Effect.gen(function* () {
    let interpreted = 0;
    for (const response of [
      () => new Response("{"),
      () => new Response(""),
      () => new Response(null),
      () => new Response("raw-response-secret"),
    ]) {
      const exit = yield* Effect.exit(
        exchangeProviderJson(
          async () => response(),
          request(),
          (body) => Effect.sync(() => (interpreted += 1)).pipe(Effect.as(body)),
        ),
      );
      assert.equal(failureTag(exit), "MalformedProviderJsonExchange");
      assertSecretSafe(exit, "invalid JSON");
    }
    assert.equal(interpreted, 0);
  }),
);

it.effect(
  "passes interpretation failures, defects, and interruption through",
  () =>
    Effect.gen(function* () {
      const rejected = trackedStream({
        chunks: [new TextEncoder().encode('{"secret":"raw-response-secret"}')],
        close: true,
      });
      const rejectedExit = yield* Effect.exit(
        exchangeProviderJson(
          async () => new Response(rejected.stream),
          request(),
          (body) =>
            new InterpretationRejected({
              detail: typeof body === "object" ? "object" : typeof body,
            }),
        ),
      );
      assert.equal(failureTag(rejectedExit), "InterpretationRejected");
      assert.equal(failureField(rejectedExit, "detail"), "object");
      assert.equal(rejected.stream.locked, false);

      const defectExit = yield* Effect.exit(
        exchangeProviderJson(
          async () => new Response("{}"),
          request(),
          () => Effect.die("interpretation defect"),
        ),
      );
      assert.equal(
        Exit.isFailure(defectExit)
          ? Option.getOrUndefined(Cause.dieOption(defectExit.cause))
          : undefined,
        "interpretation defect",
      );

      const interruptedExit = yield* Effect.exit(
        exchangeProviderJson(
          async () => new Response("{}"),
          request(),
          () => Effect.interrupt,
        ),
      );
      assert.equal(Exit.isInterrupted(interruptedExit), true);
    }),
);

it.effect("dies on an invalid byte limit before sending anything", () =>
  Effect.gen(function* () {
    let requests = 0;
    for (const maximumResponseBytes of [0, -1, 1.5, Number.NaN, Infinity]) {
      const exit = yield* Effect.exit(
        exchange(
          async () => {
            requests += 1;
            return new Response("{}");
          },
          { maximumResponseBytes },
        ),
      );
      assert.equal(
        Exit.isFailure(exit) && Cause.isDie(exit.cause),
        true,
        String(maximumResponseBytes),
      );
      assertSecretSafe(exit, `byte limit ${maximumResponseBytes}`);
    }
    assert.equal(requests, 0);
  }),
);

it.effect("keeps every unsuccessful outcome secret-safe", () =>
  Effect.gen(function* () {
    for (const status of [401, 403, 408, 429, 503, 302, 400, 200]) {
      const exit = yield* Effect.exit(
        exchange(
          async () =>
            new Response("raw-response-secret", {
              status,
              headers: { "x-secret": "header-secret" },
            }),
        ),
      );
      assert.equal(Exit.isFailure(exit), true, String(status));
      assertSecretSafe(exit, String(status));
    }
  }),
);
