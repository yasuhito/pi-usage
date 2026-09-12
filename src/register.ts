import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Clock, Effect } from "effect";
import {
  type AcquireClaudeSubscriptionUsage,
  claudeCredentialFingerprint,
} from "./claude-subscription-usage-acquisition.ts";
import type { CodexCredentialResolution } from "./codex-provider-monitor.ts";
import type {
  AcquireDedicatedWeeklyQuotaUsage,
  CodexCredential,
} from "./dedicated-weekly-quota-acquisition.ts";
import { presentProviderSubscriptionUsage } from "./presentation.ts";
import { makeWeeklySubscriptionUsageLifecycle } from "./weekly-subscription-usage-lifecycle.ts";

const STATUS_KEY = "pi-usage";

export interface WeeklySubscriptionUsageDependencies {
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

export function registerWeeklySubscriptionUsage(
  pi: ExtensionAPI,
  dependencies: WeeklySubscriptionUsageDependencies,
): void {
  const lifecycle = Effect.runSync(makeWeeklySubscriptionUsageLifecycle());
  const now = dependencies.now ?? Clock.currentTimeMillis;
  const run = (effect: Effect.Effect<void>) => Effect.runPromise(effect);

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") {
      await run(lifecycle.shutdown);
      return;
    }
    let lastRendered: string | undefined;
    await run(
      lifecycle.start({
        now,
        present: (statuses, currentTime) =>
          Effect.sync(() => {
            const rendered = (["Codex", "Claude"] as const)
              .map((name) => {
                const presentation = presentProviderSubscriptionUsage(
                  name,
                  statuses[name],
                  currentTime,
                );
                return `${ctx.ui.theme.fg("accent", presentation.providerName)} ${ctx.ui.theme.fg(presentation.color, presentation.detail)}`;
              })
              .join(" ");
            if (rendered === lastRendered) return;
            lastRendered = rendered;
            ctx.ui.setStatus(STATUS_KEY, rendered);
          }),
        codex: {
          resolveCredential: credentialResolution(ctx),
          acquireDedicatedWeeklyQuotaUsage:
            dependencies.acquireDedicatedWeeklyQuotaUsage,
          ...(dependencies.random === undefined
            ? {}
            : { random: dependencies.random }),
        },
        makeClaudeDependencies: () => ({
          resolveCredentialIdentity: claudeCredentialIdentityResolution(ctx),
          acquireClaudeSubscriptionUsage:
            dependencies.acquireClaudeSubscriptionUsage(ctx),
          ...(dependencies.random === undefined
            ? {}
            : { random: dependencies.random }),
        }),
      }),
    );
  });

  pi.on("after_provider_response", async (event, ctx) => {
    if (ctx.mode !== "tui" || ctx.model?.provider !== "openai-codex") return;
    await run(lifecycle.observeCodexResponse(event.headers));
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (ctx.model?.provider === "openai-codex") {
      await run(lifecycle.refreshAfterActivity("Codex"));
    } else if (ctx.model?.provider === "anthropic") {
      await run(lifecycle.refreshAfterActivity("Claude"));
    }
  });

  pi.on("model_select", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    await run(lifecycle.refreshForAccountChange);
  });

  pi.on("session_shutdown", async () => {
    await run(lifecycle.shutdown);
  });
}
