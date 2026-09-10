import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { CodexCredential, WeeklyQuotaUsage } from "./codex-usage.ts";
import { presentQuotaStatus } from "./presentation.ts";
import {
  type CodexCredentialResolution,
  createWeeklyQuotaUsageLifecycle,
  type WeeklyQuotaUsageLifecycle,
} from "./weekly-quota-usage-lifecycle.ts";

const STATUS_KEY = "pi-usage";

export interface WeeklyQuotaUsageDependencies {
  readonly now: () => number;
  readonly random: () => number;
  readonly schedule: (callback: () => void, delay: number) => () => void;
  readonly readWeeklyQuotaUsage: (
    credential: CodexCredential,
    signal?: AbortSignal,
  ) => Promise<WeeklyQuotaUsage>;
  readonly startPolling: (refresh: () => void) => () => void;
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
  if (typeof accessToken !== "string" || accessToken.trim() === "") {
    return undefined;
  }
  const headerAccountId = accountIdEntry?.[1];
  const accountId =
    typeof headerAccountId === "string" && headerAccountId.trim() !== ""
      ? headerAccountId
      : accountIdFromAccessToken(accessToken);
  if (accountId === undefined) return undefined;
  return { accessToken, accountId };
}

function createLifecycle(
  ctx: ExtensionContext,
  dependencies: WeeklyQuotaUsageDependencies,
): WeeklyQuotaUsageLifecycle {
  return createWeeklyQuotaUsageLifecycle({
    ...dependencies,
    resolveCredential: async (): Promise<CodexCredentialResolution> => {
      const auth = await ctx.modelRegistry.getProviderAuth("openai-codex");
      if (auth === undefined) return { kind: "missing" };
      const credential = credentialFromContext(auth);
      return credential === undefined
        ? { kind: "invalid" }
        : { kind: "available", credential };
    },
    publish: (status) => {
      if (status === undefined) {
        ctx.ui.setStatus(STATUS_KEY, undefined);
        return;
      }
      const presentation = presentQuotaStatus(status);
      ctx.ui.setStatus(
        STATUS_KEY,
        ctx.ui.theme.fg(presentation.color, presentation.text),
      );
    },
  });
}

export function registerWeeklyQuotaUsage(
  pi: ExtensionAPI,
  dependencies: WeeklyQuotaUsageDependencies,
): void {
  let lifecycle: WeeklyQuotaUsageLifecycle | undefined;

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    lifecycle?.stop();
    lifecycle = createLifecycle(ctx, dependencies);
    await lifecycle.start();
  });

  pi.on("after_provider_response", (event, ctx) => {
    if (ctx.mode !== "tui" || ctx.model?.provider !== "openai-codex") return;
    lifecycle?.observeCodexResponse(event.headers);
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    await lifecycle?.refreshAfterActivity();
  });

  pi.on("model_select", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    await lifecycle?.refreshForAccountChange();
  });

  pi.on("session_shutdown", () => {
    lifecycle?.stop();
    lifecycle = undefined;
  });
}
