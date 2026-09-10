import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  type CodexCredential,
  CodexUsageFormatError,
  CodexUsageRequestError,
  parseCodexRateLimitHeaders,
  type WeeklyQuotaUsage,
} from "./codex-usage.ts";
import { presentQuotaStatus, type QuotaStatus } from "./presentation.ts";

const STATUS_KEY = "pi-usage";
const STALE_AFTER_MS = 10 * 60 * 1_000;
const REFRESH_DEBOUNCE_MS = 30_000;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const CODEX_RATE_LIMIT_HEADER_NAMES = new Set(
  ["primary", "secondary"].flatMap((position) => [
    `x-codex-${position}-used-percent`,
    `x-codex-${position}-window-minutes`,
    `x-codex-${position}-reset-at`,
  ]),
);

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

export function registerWeeklyQuotaUsage(
  pi: ExtensionAPI,
  dependencies: WeeklyQuotaUsageDependencies,
): void {
  let stopPolling: (() => void) | undefined;
  let cancelStaleExpiration: (() => void) | undefined;
  let activeController: AbortController | undefined;
  let shuttingDown = false;
  let credentialAvailable = false;
  let nextAttemptAt = 0;
  let consecutiveFailures = 0;
  let currentAccountId: string | undefined;
  let observedRateLimitHeaders: Record<string, string> = {};
  let lastObservedUsage:
    | { readonly usage: WeeklyQuotaUsage; readonly capturedAt: number }
    | undefined;
  const clearStaleExpiration = (): void => {
    cancelStaleExpiration?.();
    cancelStaleExpiration = undefined;
  };
  const clearObservedUsage = (): void => {
    clearStaleExpiration();
    lastObservedUsage = undefined;
  };
  const selectAccount = (accountId: string): void => {
    if (currentAccountId === accountId) return;
    currentAccountId = accountId;
    observedRateLimitHeaders = {};
    clearObservedUsage();
    nextAttemptAt = 0;
    consecutiveFailures = 0;
  };
  const publish = (ctx: ExtensionContext, status: QuotaStatus): void => {
    const presentation = presentQuotaStatus(status);
    ctx.ui.setStatus(
      STATUS_KEY,
      ctx.ui.theme.fg(presentation.color, presentation.text),
    );
  };
  const publishStaleUsage = (ctx: ExtensionContext): void => {
    const now = dependencies.now();
    if (
      lastObservedUsage === undefined ||
      now - lastObservedUsage.capturedAt >= STALE_AFTER_MS ||
      now >= lastObservedUsage.usage.resetsAtMs
    ) {
      clearStaleExpiration();
      publish(ctx, { kind: "unavailable" });
      return;
    }
    publish(ctx, {
      kind: "available",
      usedPercent: lastObservedUsage.usage.usedPercent,
      stale: true,
    });
    const deadline = Math.min(
      lastObservedUsage.capturedAt + STALE_AFTER_MS,
      lastObservedUsage.usage.resetsAtMs,
    );
    clearStaleExpiration();
    cancelStaleExpiration = dependencies.schedule(() => {
      cancelStaleExpiration = undefined;
      publishStaleUsage(ctx);
    }, deadline - now);
  };

  let inFlight: Promise<void> | undefined;
  const performRefresh = async (
    ctx: ExtensionContext,
    signal: AbortSignal,
    ignoreBackoff: boolean,
  ): Promise<void> => {
    try {
      const auth = await ctx.modelRegistry.getProviderAuth("openai-codex");
      if (auth === undefined) {
        credentialAvailable = false;
        currentAccountId = undefined;
        observedRateLimitHeaders = {};
        clearObservedUsage();
        ctx.ui.setStatus(STATUS_KEY, undefined);
        return;
      }
      const credential = credentialFromContext(auth);
      if (credential === undefined) {
        credentialAvailable = true;
        currentAccountId = undefined;
        clearObservedUsage();
        publish(ctx, { kind: "unavailable" });
        return;
      }

      credentialAvailable = true;
      selectAccount(credential.accountId);
      if (!ignoreBackoff && dependencies.now() < nextAttemptAt) {
        publishStaleUsage(ctx);
        return;
      }
      let usage: WeeklyQuotaUsage;
      try {
        usage = await dependencies.readWeeklyQuotaUsage(credential, signal);
      } catch (error) {
        if (
          !(error instanceof CodexUsageRequestError) ||
          (error.status !== 401 && error.status !== 403)
        ) {
          throw error;
        }
        const refreshedAuth =
          await ctx.modelRegistry.getProviderAuth("openai-codex");
        if (refreshedAuth === undefined) {
          credentialAvailable = false;
          currentAccountId = undefined;
          observedRateLimitHeaders = {};
          clearObservedUsage();
          ctx.ui.setStatus(STATUS_KEY, undefined);
          return;
        }
        const refreshedCredential = credentialFromContext(refreshedAuth);
        if (refreshedCredential === undefined) throw error;
        selectAccount(refreshedCredential.accountId);
        usage = await dependencies.readWeeklyQuotaUsage(
          refreshedCredential,
          signal,
        );
      }
      if (shuttingDown) return;
      nextAttemptAt = 0;
      consecutiveFailures = 0;
      clearStaleExpiration();
      lastObservedUsage = { usage, capturedAt: dependencies.now() };
      publish(ctx, {
        kind: "available",
        usedPercent: usage.usedPercent,
        stale: false,
      });
    } catch (error) {
      if (shuttingDown) return;
      const now = dependencies.now();
      const temporaryFailure =
        !(error instanceof CodexUsageFormatError) &&
        (!(error instanceof CodexUsageRequestError) ||
          error.status === 408 ||
          error.status === 425 ||
          error.status === 429 ||
          error.status >= 500);
      if (!temporaryFailure) {
        clearObservedUsage();
        nextAttemptAt = 0;
        consecutiveFailures = 0;
        publish(ctx, { kind: "unavailable" });
        return;
      }

      consecutiveFailures += 1;
      if (error instanceof CodexUsageRequestError && error.status === 429) {
        const seconds = Number(error.retryAfter);
        const retryAt = Number.isFinite(seconds)
          ? now + Math.max(0, seconds) * 1_000
          : Date.parse(error.retryAfter ?? "");
        if (Number.isFinite(retryAt)) nextAttemptAt = retryAt;
      }
      if (nextAttemptAt <= now) {
        const baseDelay = Math.min(
          MAX_BACKOFF_MS,
          INITIAL_BACKOFF_MS * 2 ** (consecutiveFailures - 1),
        );
        const jitter = 0.5 + dependencies.random();
        nextAttemptAt = now + baseDelay * jitter;
      }
      publishStaleUsage(ctx);
    }
  };
  const refresh = (
    ctx: ExtensionContext,
    ignoreBackoff = false,
  ): Promise<void> => {
    if (shuttingDown) return Promise.resolve();
    if (inFlight !== undefined) {
      if (!ignoreBackoff) return inFlight;
      activeController?.abort();
      return inFlight.then(() => refresh(ctx, true));
    }
    const controller = new AbortController();
    activeController = controller;
    const current = performRefresh(
      ctx,
      controller.signal,
      ignoreBackoff,
    ).finally(() => {
      if (inFlight === current) {
        inFlight = undefined;
        activeController = undefined;
      }
    });
    inFlight = current;
    return current;
  };

  const updatePolling = (ctx: ExtensionContext): void => {
    if (shuttingDown || !credentialAvailable) {
      stopPolling?.();
      stopPolling = undefined;
      return;
    }
    stopPolling ??= dependencies.startPolling(() => {
      void refreshAndUpdatePolling(ctx);
    });
  };
  const refreshAndUpdatePolling = async (
    ctx: ExtensionContext,
    ignoreBackoff = false,
  ): Promise<void> => {
    await refresh(ctx, ignoreBackoff);
    updatePolling(ctx);
  };

  pi.on("session_start", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    shuttingDown = false;
    publish(ctx, { kind: "loading" });
    await refreshAndUpdatePolling(ctx);
  });

  pi.on("after_provider_response", (event, ctx) => {
    if (ctx.mode !== "tui" || !credentialAvailable) return;
    for (const [name, value] of Object.entries(event.headers)) {
      const normalizedName = name.toLowerCase();
      if (
        CODEX_RATE_LIMIT_HEADER_NAMES.has(normalizedName) &&
        typeof value === "string"
      ) {
        observedRateLimitHeaders[normalizedName] = value;
      }
    }
    let usage: WeeklyQuotaUsage | undefined;
    try {
      usage = parseCodexRateLimitHeaders(
        observedRateLimitHeaders,
        lastObservedUsage?.usage,
      );
    } catch (error) {
      if (error instanceof CodexUsageFormatError) {
        clearObservedUsage();
        publish(ctx, { kind: "unavailable" });
        return;
      }
      throw error;
    }
    if (usage === undefined) {
      if (
        ctx.model?.provider === "openai-codex" &&
        (lastObservedUsage === undefined ||
          dependencies.now() - lastObservedUsage.capturedAt >=
            REFRESH_DEBOUNCE_MS)
      ) {
        void refresh(ctx);
      }
      return;
    }

    clearStaleExpiration();
    lastObservedUsage = { usage, capturedAt: dependencies.now() };
    publish(ctx, {
      kind: "available",
      usedPercent: usage.usedPercent,
      stale: false,
    });
  });

  pi.on("agent_settled", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    if (
      lastObservedUsage !== undefined &&
      dependencies.now() - lastObservedUsage.capturedAt < REFRESH_DEBOUNCE_MS
    ) {
      return;
    }
    await refreshAndUpdatePolling(ctx);
  });

  pi.on("model_select", async (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    await refreshAndUpdatePolling(ctx, true);
  });

  pi.on("session_shutdown", () => {
    shuttingDown = true;
    activeController?.abort();
    stopPolling?.();
    stopPolling = undefined;
    credentialAvailable = false;
    currentAccountId = undefined;
    observedRateLimitHeaders = {};
    clearObservedUsage();
  });
}
