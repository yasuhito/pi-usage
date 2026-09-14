import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Effect } from "effect";

import {
  type CodexCredentialResolution,
  codexProviderMonitorLayer,
} from "./codex-provider-monitor.ts";
import type {
  AcquireDedicatedWeeklyQuotaUsage,
  CodexCredential,
} from "./dedicated-weekly-quota-acquisition.ts";
import {
  defineMonitoredProvider,
  type MonitoredProvider,
} from "./monitored-provider.ts";
import {
  presentProviderSubscriptionUsage,
  type WeeklySubscriptionUsageStatus,
} from "./presentation.ts";

export interface CodexMonitoredProviderDependencies {
  readonly acquireDedicatedWeeklyQuotaUsage: AcquireDedicatedWeeklyQuotaUsage;
  readonly random?: Effect.Effect<number>;
}

function accountIdFromAccessToken(accessToken: string): string | undefined {
  const payload = accessToken.split(".")[1];
  if (payload === undefined) return undefined;
  try {
    const claims: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    const openAiAuth =
      typeof claims === "object" && claims !== null
        ? Reflect.get(claims, "https://api.openai.com/auth")
        : undefined;
    const accountId =
      typeof openAiAuth === "object" && openAiAuth !== null
        ? Reflect.get(openAiAuth, "chatgpt_account_id")
        : undefined;
    return typeof accountId === "string" && accountId.trim() !== ""
      ? accountId
      : undefined;
  } catch {
    return undefined;
  }
}

function credentialFromContext(
  auth: Awaited<
    ReturnType<ExtensionContext["modelRegistry"]["getProviderAuth"]>
  >,
): CodexCredential | undefined {
  const accessToken = auth?.auth.apiKey;
  const headers = auth?.auth.headers;
  const accountIdEntry = headers
    ? Object.entries(headers).find(
        ([name]) => name.toLowerCase() === "chatgpt-account-id",
      )
    : undefined;
  if (typeof accessToken !== "string" || accessToken.trim() === "")
    return undefined;
  const headerAccountId = accountIdEntry?.[1];
  const accountId =
    typeof headerAccountId === "string" && headerAccountId.trim() !== ""
      ? headerAccountId
      : accountIdFromAccessToken(accessToken);
  return accountId === undefined ? undefined : { accessToken, accountId };
}

function credentialResolution(ctx: ExtensionContext) {
  return Effect.tryPromise(() =>
    ctx.modelRegistry.getProviderAuth("openai-codex"),
  ).pipe(
    Effect.map((auth): CodexCredentialResolution => {
      if (auth === undefined) return { kind: "missing" };
      const credential = credentialFromContext(auth);
      return credential === undefined
        ? { kind: "invalid" }
        : { kind: "available", credential };
    }),
    Effect.catchAll(() => Effect.succeed({ kind: "invalid" } as const)),
  );
}

export function makeCodexMonitoredProvider(
  ctx: ExtensionContext,
  dependencies: CodexMonitoredProviderDependencies,
): MonitoredProvider {
  return defineMonitoredProvider<WeeklySubscriptionUsageStatus>({
    piProviderId: "openai-codex",
    initialStatus: { kind: "loading" },
    makeMonitor: (publish) =>
      codexProviderMonitorLayer({
        resolveCredential: credentialResolution(ctx),
        acquireDedicatedWeeklyQuotaUsage:
          dependencies.acquireDedicatedWeeklyQuotaUsage,
        publish,
        ...(dependencies.random === undefined
          ? {}
          : { random: dependencies.random }),
      }),
    present: (status, currentTime) =>
      presentProviderSubscriptionUsage("Codex", status, currentTime),
  });
}
