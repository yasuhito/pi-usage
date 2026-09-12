import assert from "node:assert/strict";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";
import { test } from "vitest";

import type {
  AcquiredWeeklyQuotaUsage,
  CodexCredential,
} from "../src/dedicated-weekly-quota-acquisition.ts";
import { registerWeeklyQuotaUsage } from "../src/register.ts";

function accessTokenFor(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

type ExtensionHandler = (
  event: { readonly headers?: Readonly<Record<string, unknown>> },
  ctx: ExtensionContext,
) => void | Promise<void>;

function registerFixture() {
  const handlers = new Map<string, ExtensionHandler[]>();
  const pi = {
    on(event: string, handler: ExtensionHandler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  const observedCredentials: CodexCredential[] = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];
  let mode: ExtensionContext["mode"] = "tui";
  let provider = "openai-codex";
  let authEnabled = true;
  let acquisition: Effect.Effect<AcquiredWeeklyQuotaUsage> = Effect.succeed({
    usedPercent: 63.4,
    resetsAtMs: 2_000_000,
    windowPosition: "secondary",
    availableLimitResetCredits: 2,
  });

  registerWeeklyQuotaUsage(pi, {
    now: Effect.succeed(1_000_000),
    random: Effect.succeed(0.5),
    acquireDedicatedWeeklyQuotaUsage: (credential) => {
      observedCredentials.push(credential);
      return acquisition;
    },
  });

  const ctx = {
    get mode() {
      return mode;
    },
    get model() {
      return { provider };
    },
    modelRegistry: {
      getProviderAuth: async () =>
        authEnabled
          ? {
              auth: { apiKey: accessTokenFor("account-1") },
              source: "OAuth" as const,
            }
          : undefined,
    },
    ui: {
      theme: { fg: (_color: string, text: string) => text },
      setStatus: (key: string, text: string | undefined) =>
        statuses.push({ key, text }),
    },
  } as unknown as ExtensionContext;
  const emit = async (event: string, payload: unknown = {}) => {
    for (const handler of handlers.get(event) ?? [])
      await handler(
        payload as { readonly headers?: Readonly<Record<string, unknown>> },
        ctx,
      );
  };
  return {
    emit,
    observedCredentials,
    statuses,
    setMode: (value: ExtensionContext["mode"]) => {
      mode = value;
    },
    setProvider: (value: string) => {
      provider = value;
    },
    setAuthEnabled: (value: boolean) => {
      authEnabled = value;
    },
    setAcquisition: (value: typeof acquisition) => {
      acquisition = value;
    },
  };
}

test("session start adapts Pi authentication and quota presentation", async () => {
  const f = registerFixture();
  await f.emit("session_start");
  assert.deepEqual(f.observedCredentials, [
    { accessToken: accessTokenFor("account-1"), accountId: "account-1" },
  ]);
  assert.deepEqual(f.statuses, [
    { key: "pi-usage", text: "Codex wk loading…" },
    { key: "pi-usage", text: "Codex wk ━━━━━━──── 63% · reset 16m · ↻2" },
  ]);
  await f.emit("session_shutdown");
});

test("missing Pi authentication clears status without requesting", async () => {
  const f = registerFixture();
  f.setAuthEnabled(false);
  await f.emit("session_start");
  assert.deepEqual(f.statuses.at(-1), { key: "pi-usage", text: undefined });
  assert.equal(f.observedCredentials.length, 0);
  await f.emit("session_shutdown");
});

test("non-TUI sessions perform no work", async () => {
  const f = registerFixture();
  f.setMode("rpc");
  await f.emit("session_start");
  assert.equal(f.observedCredentials.length, 0);
  assert.equal(f.statuses.length, 0);
});

test("responses from another provider are ignored", async () => {
  const f = registerFixture();
  await f.emit("session_start");
  f.setProvider("anthropic");
  await f.emit("after_provider_response", {
    headers: { "x-codex-secondary-used-percent": "99" },
  });
  assert.equal(
    f.statuses.at(-1)?.text,
    "Codex wk ━━━━━━──── 63% · reset 16m · ↻2",
  );
  await f.emit("session_shutdown");
});

test("repeated session start closes the previous Scope and suppresses late publication", async () => {
  const f = registerFixture();
  let finalized = 0;
  f.setAcquisition(
    Effect.never.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          finalized += 1;
        }),
      ),
    ),
  );
  const first = f.emit("session_start");
  await new Promise<void>((resolve) => setImmediate(resolve));
  f.setAcquisition(
    Effect.succeed({
      usedPercent: 20,
      resetsAtMs: 2_000_000,
      windowPosition: "secondary",
    }),
  );
  await f.emit("session_start");
  await first;
  assert.equal(finalized, 1);
  assert.equal(f.statuses.at(-1)?.text, "Codex wk ━━──────── 20% · reset 16m");
  await f.emit("session_shutdown");
});
