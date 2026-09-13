import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Clock, Effect } from "effect";
import { claudeProviderMonitorLayer } from "./claude-provider-monitor.ts";
import {
  type AcquireClaudeSubscriptionUsage,
  claudeCredentialFingerprint,
} from "./claude-subscription-usage-acquisition.ts";
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
  makeMonitoredProviderCapacitySession,
} from "./monitored-provider-capacity-session.ts";
import {
  presentProviderSubscriptionUsage,
  type WeeklySubscriptionUsageStatus,
} from "./presentation.ts";

const STATUS_KEY = "pi-usage";

export interface MonitoredProviderCapacityDependencies {
  readonly acquireDedicatedWeeklyQuotaUsage: AcquireDedicatedWeeklyQuotaUsage;
  readonly acquireClaudeSubscriptionUsage: (
    ctx: ExtensionContext,
  ) => AcquireClaudeSubscriptionUsage;
  readonly now?: Effect.Effect<number>;
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

function claudeCredentialIdentityResolution(ctx: ExtensionContext) {
  return Effect.tryPromise(() =>
    ctx.modelRegistry.getProviderAuth("anthropic"),
  ).pipe(
    Effect.map((authentication) => {
      const fingerprint = claudeCredentialFingerprint(authentication);
      return fingerprint === undefined
        ? { kind: "missing" as const }
        : { kind: "available" as const, fingerprint };
    }),
    Effect.catchAll(() => Effect.succeed({ kind: "missing" as const })),
  );
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

export function registerMonitoredProviderCapacity(
  pi: ExtensionAPI,
  dependencies: MonitoredProviderCapacityDependencies,
): void {
  const session = Effect.runSync(makeMonitoredProviderCapacitySession());
  const now = dependencies.now ?? Clock.currentTimeMillis;
  const run = (effect: Effect.Effect<void>) => Effect.runPromise(effect);

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") {
      await run(session.shutdown);
      return;
    }
    let lastRendered: string | undefined;
    await run(
      session.start({
        now,
        present: (presentations) =>
          Effect.sync(() => {
            const rendered = presentations
              .map(
                ({ presentation }) =>
                  `${ctx.ui.theme.fg("accent", presentation.providerName)} ${ctx.ui.theme.fg(presentation.color, presentation.detail)}`,
              )
              .join(" ");
            if (rendered === lastRendered) return;
            lastRendered = rendered;
            ctx.ui.setStatus(STATUS_KEY, rendered);
          }),
        providers: [
          defineMonitoredProvider<WeeklySubscriptionUsageStatus>({
            piProviderId: "openai-codex",
            makeLayer: (publish) =>
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
          }),
          defineMonitoredProvider<WeeklySubscriptionUsageStatus>({
            piProviderId: "anthropic",
            makeLayer: (publish) =>
              claudeProviderMonitorLayer({
                resolveCredentialIdentity:
                  claudeCredentialIdentityResolution(ctx),
                acquireClaudeSubscriptionUsage:
                  dependencies.acquireClaudeSubscriptionUsage(ctx),
                publish,
                ...(dependencies.random === undefined
                  ? {}
                  : { random: dependencies.random }),
              }),
            present: (status, currentTime) =>
              presentProviderSubscriptionUsage("Claude", status, currentTime),
          }),
        ],
      }),
    );
  });

  pi.on("after_provider_response", async (event, ctx) => {
    const piProviderId = ctx.model?.provider;
    if (ctx.mode !== "tui" || piProviderId === undefined) return;
    await run(session.observeResponse(piProviderId, event.headers));
  });

  pi.on("agent_settled", async (_event, ctx) => {
    const piProviderId = ctx.model?.provider;
    if (ctx.mode !== "tui" || piProviderId === undefined) return;
    await run(session.refreshAfterActivity(piProviderId));
  });

  pi.on("model_select", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    await run(session.refreshForAccountChange);
  });

  pi.on("session_shutdown", async () => {
    await run(session.shutdown);
  });
}
