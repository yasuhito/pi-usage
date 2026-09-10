import {
  type CodexCredential,
  CodexUsageFormatError,
  CodexUsageRequestError,
  parseCodexRateLimitHeaders,
  type WeeklyQuotaUsage,
} from "./codex-usage.ts";
import type { QuotaStatus } from "./presentation.ts";

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

export type CodexCredentialResolution =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "available"; readonly credential: CodexCredential };

export interface WeeklyQuotaUsageLifecycleDependencies {
  readonly now: () => number;
  readonly random: () => number;
  readonly schedule: (callback: () => void, delay: number) => () => void;
  readonly resolveCredential: () => Promise<CodexCredentialResolution>;
  readonly readWeeklyQuotaUsage: (
    credential: CodexCredential,
    signal?: AbortSignal,
  ) => Promise<WeeklyQuotaUsage>;
  readonly publish: (status: QuotaStatus | undefined) => void;
  readonly startPolling: (refresh: () => void) => () => void;
}

export interface WeeklyQuotaUsageLifecycle {
  readonly start: () => Promise<void>;
  readonly observeCodexResponse: (
    headers: Readonly<Record<string, unknown>>,
  ) => void;
  readonly refreshAfterActivity: () => Promise<void>;
  readonly refreshForAccountChange: () => Promise<void>;
  readonly stop: () => void;
}

export function createWeeklyQuotaUsageLifecycle(
  dependencies: WeeklyQuotaUsageLifecycleDependencies,
): WeeklyQuotaUsageLifecycle {
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
  const clearForMissingCredential = (): void => {
    credentialAvailable = false;
    currentAccountId = undefined;
    observedRateLimitHeaders = {};
    clearObservedUsage();
    dependencies.publish(undefined);
  };
  const recordFreshUsage = (usage: WeeklyQuotaUsage): void => {
    clearStaleExpiration();
    observedRateLimitHeaders = {};
    lastObservedUsage = { usage, capturedAt: dependencies.now() };
    dependencies.publish({
      kind: "available",
      usedPercent: usage.usedPercent,
      stale: false,
    });
  };
  const publishStaleUsage = (): void => {
    const now = dependencies.now();
    if (
      lastObservedUsage === undefined ||
      now - lastObservedUsage.capturedAt >= STALE_AFTER_MS ||
      now >= lastObservedUsage.usage.resetsAtMs
    ) {
      clearStaleExpiration();
      dependencies.publish({ kind: "unavailable" });
      return;
    }
    dependencies.publish({
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
      publishStaleUsage();
    }, deadline - now);
  };

  let inFlight: Promise<void> | undefined;
  const performRefresh = async (
    signal: AbortSignal,
    ignoreBackoff: boolean,
  ): Promise<void> => {
    try {
      const resolution = await dependencies.resolveCredential();
      if (shuttingDown) return;
      if (resolution.kind === "missing") {
        clearForMissingCredential();
        return;
      }
      if (resolution.kind === "invalid") {
        credentialAvailable = true;
        currentAccountId = undefined;
        clearObservedUsage();
        dependencies.publish({ kind: "unavailable" });
        return;
      }

      credentialAvailable = true;
      selectAccount(resolution.credential.accountId);
      if (!ignoreBackoff && dependencies.now() < nextAttemptAt) {
        publishStaleUsage();
        return;
      }
      let usage: WeeklyQuotaUsage;
      try {
        usage = await dependencies.readWeeklyQuotaUsage(
          resolution.credential,
          signal,
        );
      } catch (error) {
        if (
          !(error instanceof CodexUsageRequestError) ||
          (error.status !== 401 && error.status !== 403)
        ) {
          throw error;
        }
        const refreshedResolution = await dependencies.resolveCredential();
        if (shuttingDown) return;
        if (refreshedResolution.kind === "missing") {
          clearForMissingCredential();
          return;
        }
        if (refreshedResolution.kind === "invalid") throw error;
        selectAccount(refreshedResolution.credential.accountId);
        usage = await dependencies.readWeeklyQuotaUsage(
          refreshedResolution.credential,
          signal,
        );
      }
      if (shuttingDown) return;
      nextAttemptAt = 0;
      consecutiveFailures = 0;
      recordFreshUsage(usage);
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
        dependencies.publish({ kind: "unavailable" });
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
      publishStaleUsage();
    }
  };

  const refresh = (ignoreBackoff = false): Promise<void> => {
    if (shuttingDown) return Promise.resolve();
    if (inFlight !== undefined) {
      if (!ignoreBackoff) return inFlight;
      activeController?.abort();
      return inFlight.then(() => refresh(true));
    }
    const controller = new AbortController();
    activeController = controller;
    const current = performRefresh(controller.signal, ignoreBackoff).finally(
      () => {
        if (inFlight === current) {
          inFlight = undefined;
          activeController = undefined;
        }
      },
    );
    inFlight = current;
    return current;
  };

  const updatePolling = (): void => {
    if (shuttingDown || !credentialAvailable) {
      stopPolling?.();
      stopPolling = undefined;
      return;
    }
    stopPolling ??= dependencies.startPolling(() => {
      void refreshAndUpdatePolling();
    });
  };
  const refreshAndUpdatePolling = async (
    ignoreBackoff = false,
  ): Promise<void> => {
    await refresh(ignoreBackoff);
    updatePolling();
  };

  return {
    start: async () => {
      dependencies.publish({ kind: "loading" });
      await refreshAndUpdatePolling();
    },
    observeCodexResponse: (headers) => {
      if (!credentialAvailable) return;
      let contributedRateLimitField = false;
      for (const [name, value] of Object.entries(headers)) {
        const normalizedName = name.toLowerCase();
        if (
          CODEX_RATE_LIMIT_HEADER_NAMES.has(normalizedName) &&
          typeof value === "string"
        ) {
          observedRateLimitHeaders[normalizedName] = value;
          contributedRateLimitField = true;
        }
      }
      if (!contributedRateLimitField) {
        if (
          lastObservedUsage === undefined ||
          dependencies.now() - lastObservedUsage.capturedAt >=
            REFRESH_DEBOUNCE_MS
        ) {
          void refresh();
        }
        return;
      }

      let usage: WeeklyQuotaUsage | undefined;
      try {
        usage = parseCodexRateLimitHeaders(
          observedRateLimitHeaders,
          lastObservedUsage?.usage,
        );
      } catch (error) {
        if (error instanceof CodexUsageFormatError) {
          observedRateLimitHeaders = {};
          clearObservedUsage();
          dependencies.publish({ kind: "unavailable" });
          return;
        }
        throw error;
      }
      if (usage === undefined) return;

      recordFreshUsage(usage);
    },
    refreshAfterActivity: async () => {
      if (
        lastObservedUsage !== undefined &&
        dependencies.now() - lastObservedUsage.capturedAt < REFRESH_DEBOUNCE_MS
      ) {
        return;
      }
      await refreshAndUpdatePolling();
    },
    refreshForAccountChange: () => refreshAndUpdatePolling(true),
    stop: () => {
      shuttingDown = true;
      activeController?.abort();
      stopPolling?.();
      stopPolling = undefined;
      credentialAvailable = false;
      currentAccountId = undefined;
      observedRateLimitHeaders = {};
      clearObservedUsage();
    },
  };
}
