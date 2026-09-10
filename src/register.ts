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

export interface UsageDependencies {
  readonly now: () => number;
  readonly random: () => number;
  readonly schedule: (callback: () => void, delay: number) => () => void;
  readonly readUsage: (
    credential: CodexCredential,
    signal?: AbortSignal,
  ) => Promise<WeeklyQuotaUsage>;
  readonly startPolling: (refresh: () => void) => () => void;
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
  const accountId = accountIdEntry?.[1];

  if (typeof accessToken !== "string" || typeof accountId !== "string") {
    return undefined;
  }
  return { accessToken, accountId };
}

export function registerUsage(
  pi: ExtensionAPI,
  dependencies: UsageDependencies,
): void {
  let stopPolling: (() => void) | undefined;
  let cancelStaleExpiration: (() => void) | undefined;
  let activeController: AbortController | undefined;
  let shuttingDown = false;
  let credentialAvailable = false;
  let nextAttemptAt = 0;
  let consecutiveFailures = 0;
  let currentAccountId: string | undefined;
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
      now - lastObservedUsage.capturedAt >= 10 * 60 * 1_000 ||
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
      lastObservedUsage.capturedAt + 10 * 60 * 1_000,
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
  ): Promise<void> => {
    try {
      const auth = await ctx.modelRegistry.getProviderAuth("openai-codex");
      const credential = credentialFromContext(auth);
      if (credential === undefined) {
        credentialAvailable = false;
        currentAccountId = undefined;
        clearObservedUsage();
        ctx.ui.setStatus(STATUS_KEY, undefined);
        return;
      }

      credentialAvailable = true;
      selectAccount(credential.accountId);
      let usage: WeeklyQuotaUsage;
      try {
        usage = await dependencies.readUsage(credential, signal);
      } catch (error) {
        if (
          !(error instanceof CodexUsageRequestError) ||
          (error.status !== 401 && error.status !== 403)
        ) {
          throw error;
        }
        const refreshedAuth =
          await ctx.modelRegistry.getProviderAuth("openai-codex");
        const refreshedCredential = credentialFromContext(refreshedAuth);
        if (refreshedCredential === undefined) throw error;
        selectAccount(refreshedCredential.accountId);
        usage = await dependencies.readUsage(refreshedCredential, signal);
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
          60_000,
          1_000 * 2 ** (consecutiveFailures - 1),
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
    if (inFlight !== undefined) {
      if (!ignoreBackoff) return inFlight;
      activeController?.abort();
      return inFlight.then(() => refresh(ctx, true));
    }
    if (!ignoreBackoff && dependencies.now() < nextAttemptAt) {
      publishStaleUsage(ctx);
      return Promise.resolve();
    }

    const controller = new AbortController();
    activeController = controller;
    const current = performRefresh(ctx, controller.signal).finally(() => {
      if (inFlight === current) {
        inFlight = undefined;
        activeController = undefined;
      }
    });
    inFlight = current;
    return current;
  };

  const updatePolling = (ctx: ExtensionContext): void => {
    if (!credentialAvailable) {
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
    let usage: WeeklyQuotaUsage | undefined;
    try {
      usage = parseCodexRateLimitHeaders(event.headers);
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
          dependencies.now() - lastObservedUsage.capturedAt >= 30_000)
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
      dependencies.now() - lastObservedUsage.capturedAt < 30_000
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
    currentAccountId = undefined;
    clearObservedUsage();
  });
}
