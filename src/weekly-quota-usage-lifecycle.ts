import type {
  AcquireDedicatedWeeklyQuotaUsage,
  CodexCredential,
  WeeklyQuotaUsage,
} from "./codex-usage.ts";
import type { QuotaStatus } from "./presentation.ts";
import { createWeeklyQuotaObservationReconciliation } from "./weekly-quota-observation-reconciliation.ts";

const STALE_AFTER_MS = 10 * 60 * 1_000;
const REFRESH_DEBOUNCE_MS = 30_000;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

export type CodexCredentialResolution =
  | { readonly kind: "missing" }
  | { readonly kind: "invalid" }
  | { readonly kind: "available"; readonly credential: CodexCredential };

export interface WeeklyQuotaUsageLifecycleDependencies {
  readonly now: () => number;
  readonly random: () => number;
  readonly schedule: (callback: () => void, delay: number) => () => void;
  readonly resolveCredential: () => Promise<CodexCredentialResolution>;
  readonly acquireDedicatedWeeklyQuotaUsage: AcquireDedicatedWeeklyQuotaUsage;
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
  let accountResolutionsInFlight = 0;
  const observationReconciliation =
    createWeeklyQuotaObservationReconciliation();
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
    observationReconciliation.discard("account-change");
    clearObservedUsage();
    nextAttemptAt = 0;
    consecutiveFailures = 0;
  };
  const clearForMissingCredential = (): void => {
    credentialAvailable = false;
    currentAccountId = undefined;
    observationReconciliation.discard("missing-credential");
    clearObservedUsage();
    dependencies.publish(undefined);
  };
  const clearForInvalidCredential = (): void => {
    credentialAvailable = true;
    currentAccountId = undefined;
    observationReconciliation.discard("invalid-credential");
    clearObservedUsage();
    nextAttemptAt = 0;
    consecutiveFailures = 0;
    dependencies.publish({ kind: "unavailable" });
  };
  const applyCredentialResolution = (
    resolution: CodexCredentialResolution,
  ): CodexCredential | undefined => {
    if (resolution.kind === "missing") {
      clearForMissingCredential();
      return undefined;
    }
    if (resolution.kind === "invalid") {
      clearForInvalidCredential();
      return undefined;
    }

    credentialAvailable = true;
    selectAccount(resolution.credential.accountId);
    return resolution.credential;
  };
  const recordFreshUsage = (usage: WeeklyQuotaUsage): void => {
    clearStaleExpiration();
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
      clearObservedUsage();
      observationReconciliation.discard("stale-usage-expired");
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

  const recordTemporaryFailure = (retryAtMs: number | undefined): void => {
    const now = dependencies.now();
    consecutiveFailures += 1;
    if (retryAtMs !== undefined && Number.isFinite(retryAtMs)) {
      nextAttemptAt = retryAtMs;
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
  };

  let inFlight: Promise<void> | undefined;
  const performRefresh = async (
    signal: AbortSignal,
    ignoreBackoff: boolean,
  ): Promise<void> => {
    try {
      const resolution = await dependencies.resolveCredential();
      if (shuttingDown) return;
      const credential = applyCredentialResolution(resolution);
      if (credential === undefined) return;

      if (!ignoreBackoff && dependencies.now() < nextAttemptAt) {
        publishStaleUsage();
        return;
      }
      let result = await dependencies.acquireDedicatedWeeklyQuotaUsage(
        credential,
        signal,
      );
      if (result.kind === "authentication-rejected") {
        const refreshedResolution = await dependencies.resolveCredential();
        if (shuttingDown) return;
        const refreshedCredential =
          applyCredentialResolution(refreshedResolution);
        if (refreshedCredential === undefined) return;
        result = await dependencies.acquireDedicatedWeeklyQuotaUsage(
          refreshedCredential,
          signal,
        );
      }
      if (shuttingDown || signal.aborted) return;

      result = observationReconciliation.reconcileDedicated(result);
      if (result.kind === "observed") {
        nextAttemptAt = 0;
        consecutiveFailures = 0;
        recordFreshUsage(result.usage);
        return;
      }
      if (result.kind === "temporary-failure") {
        recordTemporaryFailure(result.retryAtMs);
        return;
      }
      clearObservedUsage();
      nextAttemptAt = 0;
      consecutiveFailures = 0;
      dependencies.publish({ kind: "unavailable" });
    } catch {
      if (shuttingDown || signal.aborted) return;
      recordTemporaryFailure(undefined);
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
      if (!credentialAvailable || accountResolutionsInFlight > 0) return;
      const result = observationReconciliation.observePassive(headers);
      if (result.kind === "unrecognized") {
        if (
          lastObservedUsage === undefined ||
          dependencies.now() - lastObservedUsage.capturedAt >=
            REFRESH_DEBOUNCE_MS
        ) {
          void refresh();
        }
        return;
      }
      if (result.kind === "malformed") {
        clearObservedUsage();
        dependencies.publish({ kind: "unavailable" });
        return;
      }
      if (result.kind === "observed") recordFreshUsage(result.usage);
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
    refreshForAccountChange: async () => {
      accountResolutionsInFlight += 1;
      try {
        await refreshAndUpdatePolling(true);
      } finally {
        accountResolutionsInFlight -= 1;
      }
    },
    stop: () => {
      shuttingDown = true;
      activeController?.abort();
      stopPolling?.();
      stopPolling = undefined;
      credentialAvailable = false;
      currentAccountId = undefined;
      observationReconciliation.discard("session-end");
      clearObservedUsage();
    },
  };
}
