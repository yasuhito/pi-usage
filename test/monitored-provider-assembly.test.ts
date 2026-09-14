import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect, Layer } from "effect";
import { test } from "vitest";

import { makeClaudeMonitoredProvider } from "../src/claude-monitored-provider.ts";
import type { ClaudeOAuthCredential } from "../src/claude-subscription-usage-acquisition.ts";
import { makeCodexMonitoredProvider } from "../src/codex-monitored-provider.ts";
import type { CodexCredential } from "../src/dedicated-weekly-quota-acquisition.ts";
import {
  defineMonitoredProvider,
  type MonitoredProvider,
} from "../src/monitored-provider.ts";
import { makeMonitoredProviderCapacitySession } from "../src/monitored-provider-capacity-session.ts";
import type { OpenRouterManagementKey } from "../src/openrouter-management-key-resolution.ts";
import { makeOpenRouterMonitoredProvider } from "../src/openrouter-monitored-provider.ts";
import {
  type OpenRouterAccountCreditBalanceStatus,
  type ProviderCapacityPresentation,
  presentProviderSubscriptionUsage,
  type WeeklySubscriptionUsageStatus,
} from "../src/presentation.ts";
import { ProviderMonitorService } from "../src/provider-monitor.ts";

function accessTokenFor(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

async function runMonitoredProvider(provider: MonitoredProvider) {
  const presentations: ReadonlyArray<ProviderCapacityPresentation>[] = [];
  const session = await Effect.runPromise(
    makeMonitoredProviderCapacitySession(),
  );
  await Effect.runPromise(
    session.start({
      providers: [provider],
      now: Effect.succeed(1_000_000),
      present: (next) =>
        Effect.sync(() => {
          presentations.push(next);
        }),
    }),
  );
  await Effect.runPromise(session.shutdown);
  const presentation = presentations.at(-1)?.[0];
  if (presentation === undefined) {
    throw new TypeError("monitored provider did not publish a presentation");
  }
  return presentation;
}

test("Codex assembly adapts Pi authentication, monitor acquisition, and presentation", async () => {
  const accessToken = accessTokenFor("account-1");
  const credentials: CodexCredential[] = [];
  const ctx = {
    modelRegistry: {
      getProviderAuth: async (provider: string) => {
        assert.equal(provider, "openai-codex");
        return { source: "OAuth", auth: { apiKey: accessToken } };
      },
    },
  } as unknown as ExtensionContext;
  const provider = makeCodexMonitoredProvider(ctx, {
    acquireDedicatedWeeklyQuotaUsage: (credential) => {
      credentials.push(credential);
      return Effect.succeed({
        usedPercent: 63.4,
        resetsAtMs: 2_000_000,
        windowPosition: "secondary",
        availableLimitResetCredits: 2,
      });
    },
    random: Effect.succeed(0.5),
  });

  const presentation = await runMonitoredProvider(provider);

  assert.equal(provider.piProviderId, "openai-codex");
  assert.deepEqual(credentials, [{ accessToken, accountId: "account-1" }]);
  assert.deepEqual(presentation, {
    providerName: "Codex",
    detail: "wk ━━━━━━──── 63% 16m ↻2",
    color: "dim",
  });
});

test("Claude assembly adapts OAuth authentication, monitor acquisition, and presentation", async () => {
  const credentials: ClaudeOAuthCredential[] = [];
  const ctx = {
    modelRegistry: {
      getProviderAuth: async (provider: string) => {
        assert.equal(provider, "anthropic");
        return { source: "OAuth", auth: { apiKey: "claude-token" } };
      },
    },
  } as unknown as ExtensionContext;
  const provider = makeClaudeMonitoredProvider(ctx, {
    acquireClaudeSubscriptionUsage: (credential) => {
      credentials.push(credential);
      return Effect.succeed({ usedPercent: 80, resetsAtMs: 2_000_000 });
    },
    random: Effect.succeed(0.5),
  });

  const presentation = await runMonitoredProvider(provider);

  assert.equal(provider.piProviderId, "anthropic");
  assert.deepEqual(credentials, ["claude-token"]);
  assert.deepEqual(presentation, {
    providerName: "Claude",
    detail: "wk ━━━━━━━━── 80% 16m",
    color: "warning",
  });
});

test("OpenRouter assembly connects Management Key resolution, acquisition, and presentation", async () => {
  const credentials: OpenRouterManagementKey[] = [];
  const provider = makeOpenRouterMonitoredProvider({
    resolveOpenRouterManagementKey: () =>
      Effect.succeed("management-key" as OpenRouterManagementKey),
    acquireOpenRouterAccountCreditBalance: (credential) => {
      credentials.push(credential);
      return Effect.succeed({
        totalCreditsUsd: 20,
        totalUsageUsd: 7.66,
        balanceUsd: 12.34,
      });
    },
    random: Effect.succeed(0.5),
  });

  const presentation = await runMonitoredProvider(provider);

  assert.equal(provider.piProviderId, "openrouter");
  assert.deepEqual(credentials, ["management-key"]);
  assert.deepEqual(presentation, {
    providerName: "OpenRouter",
    detail: "$12.34 left",
    color: "dim",
  });
});

test("rejects a mismatched provider status and presenter at compile time", () => {
  const provider =
    defineMonitoredProvider<OpenRouterAccountCreditBalanceStatus>({
      piProviderId: "openrouter",
      initialStatus: { kind: "loading" },
      makeMonitor: () =>
        Layer.succeed(ProviderMonitorService, {
          start: Effect.void,
          observeResponse: () => Effect.void,
          refreshAfterActivity: Effect.void,
          refreshForAccountChange: Effect.void,
        }),
      // @ts-expect-error Weekly subscription usage cannot present OpenRouter capacity.
      present: (status: WeeklySubscriptionUsageStatus, nowMs) =>
        presentProviderSubscriptionUsage("Codex", status, nowMs),
    });

  assert.equal(provider.piProviderId, "openrouter");
});
