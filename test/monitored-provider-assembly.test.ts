import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Context, Effect, Layer } from "effect";
import { test } from "vitest";

import { makeClaudeMonitoredProviderRegistration } from "../src/claude-monitored-provider.ts";
import type { ClaudeOAuthCredential } from "../src/claude-subscription-usage-acquisition.ts";
import { makeCodexMonitoredProviderRegistration } from "../src/codex-monitored-provider.ts";
import type { CodexCredential } from "../src/dedicated-weekly-quota-acquisition.ts";
import type { MonitoredProviderRegistration } from "../src/monitored-provider-capacity-session.ts";
import type { OpenRouterManagementKey } from "../src/openrouter-management-key-resolution.ts";
import { makeOpenRouterMonitoredProviderRegistration } from "../src/openrouter-monitored-provider.ts";
import type { ProviderCapacityStatus } from "../src/presentation.ts";
import { ProviderMonitorService } from "../src/provider-monitor.ts";

function accessTokenFor(accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: accountId },
    }),
  ).toString("base64url");
  return `header.${payload}.signature`;
}

function runRegistration(registration: MonitoredProviderRegistration) {
  const statuses: ProviderCapacityStatus[] = [];
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const context = yield* Layer.build(
          registration.makeLayer((status) =>
            Effect.sync(() => {
              statuses.push(status);
            }),
          ),
        );
        const monitor = Context.get(context, ProviderMonitorService);
        yield* monitor.start;
        const status = statuses.at(-1);
        if (status === undefined) {
          return yield* Effect.die(
            new TypeError("monitored provider did not publish a status"),
          );
        }
        return {
          statuses,
          presentation: registration.present(status, 1_000_000),
        };
      }),
    ),
  );
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
  const registration = makeCodexMonitoredProviderRegistration(ctx, {
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

  const result = await runRegistration(registration);

  assert.equal(registration.piProviderId, "openai-codex");
  assert.deepEqual(credentials, [{ accessToken, accountId: "account-1" }]);
  assert.deepEqual(result.presentation, {
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
  const registration = makeClaudeMonitoredProviderRegistration(ctx, {
    acquireClaudeSubscriptionUsage: (credential) => {
      credentials.push(credential);
      return Effect.succeed({ usedPercent: 80, resetsAtMs: 2_000_000 });
    },
    random: Effect.succeed(0.5),
  });

  const result = await runRegistration(registration);

  assert.equal(registration.piProviderId, "anthropic");
  assert.deepEqual(credentials, ["claude-token"]);
  assert.deepEqual(result.presentation, {
    providerName: "Claude",
    detail: "wk ━━━━━━━━── 80% 16m",
    color: "warning",
  });
});

test("OpenRouter assembly connects Management Key resolution, acquisition, and presentation", async () => {
  const credentials: OpenRouterManagementKey[] = [];
  const registration = makeOpenRouterMonitoredProviderRegistration({
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

  const result = await runRegistration(registration);

  assert.equal(registration.piProviderId, "openrouter");
  assert.deepEqual(credentials, ["management-key"]);
  assert.deepEqual(result.presentation, {
    providerName: "OpenRouter",
    detail: "$12.34 left",
    color: "dim",
  });
});
