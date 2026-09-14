import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import { Effect, Fiber } from "effect";

import { createResolveOpenRouterManagementKey } from "../src/openrouter-management-key-resolution.ts";

it.effect("resolves a Linux Management Key from the OS keychain", () =>
  Effect.gen(function* () {
    const calls: unknown[][] = [];
    const key = yield* createResolveOpenRouterManagementKey({
      platform: "linux",
      environment: () => ({ OPENROUTER_MANAGEMENT_KEY: "environment-key" }),
      executeFile: async (file, args, options) => {
        calls.push([file, args, options.timeout, options.maxBuffer]);
        return { stdout: "  keychain-key\n" };
      },
    })();

    assert.equal(key, "keychain-key");
    assert.deepEqual(calls, [
      [
        "secret-tool",
        [
          "lookup",
          "application",
          "pi-usage",
          "credential",
          "openrouter-management-key",
        ],
        5_000,
        4_096,
      ],
    ]);
  }),
);

it.effect(
  "falls back to the Linux environment when keychain lookup fails",
  () =>
    Effect.gen(function* () {
      for (const lookup of [
        async () => {
          throw new Error("keyring unavailable");
        },
        async () => ({ stdout: "   \n" }),
      ]) {
        const key = yield* createResolveOpenRouterManagementKey({
          platform: "linux",
          environment: () => ({
            OPENROUTER_MANAGEMENT_KEY: "  environment-key  ",
          }),
          executeFile: lookup,
        })();
        assert.equal(key, "environment-key");
      }
    }),
);

it.effect("treats missing Linux credentials as unavailable", () =>
  Effect.gen(function* () {
    const key = yield* createResolveOpenRouterManagementKey({
      platform: "linux",
      environment: () => ({ OPENROUTER_MANAGEMENT_KEY: "   " }),
      executeFile: async () => ({ stdout: "\n" }),
    })();
    assert.equal(key, undefined);
  }),
);

it.effect("uses only the environment on unsupported keychain platforms", () =>
  Effect.gen(function* () {
    let executed = false;
    const key = yield* createResolveOpenRouterManagementKey({
      platform: "darwin",
      environment: () => ({
        OPENROUTER_MANAGEMENT_KEY: "environment-key",
      }),
      executeFile: async () => {
        executed = true;
        return { stdout: "keychain-key" };
      },
    })();
    assert.equal(key, "environment-key");
    assert.equal(executed, false);
  }),
);

it.effect("interrupting resolution aborts secret-tool", () =>
  Effect.gen(function* () {
    let started = false;
    let aborted = false;
    const resolution = createResolveOpenRouterManagementKey({
      platform: "linux",
      environment: () => ({}),
      executeFile: (_file, _args, options) =>
        new Promise((_resolve, reject) => {
          started = true;
          options.signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("aborted"));
            },
            { once: true },
          );
        }),
    });
    const fiber = yield* Effect.fork(resolution());
    while (!started) yield* Effect.yieldNow();
    yield* Fiber.interrupt(fiber);
    assert.equal(aborted, true);
  }),
);
