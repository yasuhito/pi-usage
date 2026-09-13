import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";

import piUsage from "../index.ts";

test("package entry point registers the Codex quota lifecycle", () => {
  const events: string[] = [];
  const pi = {
    on: (event: string) => {
      events.push(event);
    },
  } as unknown as ExtensionAPI;

  piUsage(pi);

  assert.deepEqual(events.sort(), [
    "after_provider_response",
    "agent_settled",
    "model_select",
    "session_shutdown",
    "session_start",
  ]);
});

test("warns only once per process when secure coordination is unavailable", async () => {
  const warningSymbol = Symbol.for(
    "@yasuhito/pi-usage/coordination-warning-shown",
  );
  Reflect.deleteProperty(globalThis, warningSymbol);
  const previousRuntimeDirectory = process.env.XDG_RUNTIME_DIR;
  delete process.env.XDG_RUNTIME_DIR;
  const warnings: string[] = [];

  type Handler = (event: unknown, context: unknown) => Promise<void>;
  const load = () => {
    const handlers = new Map<string, Handler>();
    const pi = {
      on: (event: string, handler: Handler) => {
        handlers.set(event, handler);
      },
    } as unknown as ExtensionAPI;
    piUsage(pi);
    return handlers;
  };
  const ctx = {
    mode: "tui",
    modelRegistry: {
      getProviderAuth: async (provider: string) =>
        provider === "anthropic"
          ? { source: "OAuth", auth: { apiKey: "secret" } }
          : undefined,
    },
    ui: {
      notify: (message: string) => warnings.push(message),
      setStatus: () => undefined,
      theme: { fg: (_color: string, text: string) => text },
    },
  };

  try {
    const first = load();
    await first.get("session_start")?.({}, ctx);
    await first.get("session_shutdown")?.({}, ctx);
    const reloaded = load();
    await reloaded.get("session_start")?.({}, ctx);
    await reloaded.get("session_shutdown")?.({}, ctx);
  } finally {
    if (previousRuntimeDirectory === undefined) {
      delete process.env.XDG_RUNTIME_DIR;
    } else {
      process.env.XDG_RUNTIME_DIR = previousRuntimeDirectory;
    }
    Reflect.deleteProperty(globalThis, warningSymbol);
  }

  assert.deepEqual(warnings, [
    "Claude usage unavailable: secure Linux XDG_RUNTIME_DIR required",
  ]);
});
