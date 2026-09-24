export type CapacityAcquisitionStatus =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" };

export type WeeklySubscriptionUsageStatus =
  | CapacityAcquisitionStatus
  | {
      readonly kind: "available";
      readonly usedPercent: number;
      readonly stale: boolean;
      readonly weeklyWindowResetsAtMs?: number;
      readonly availableLimitResetCredits?: number;
    };

export type OpenRouterAccountCreditBalanceStatus =
  | CapacityAcquisitionStatus
  | {
      readonly kind: "openrouter-account-credit-balance";
      readonly balanceUsd: number;
      readonly stale: boolean;
    };

export type ProviderCapacityStatus =
  | WeeklySubscriptionUsageStatus
  | OpenRouterAccountCreditBalanceStatus;
export type WeeklySubscriptionProviderName = "Codex" | "Claude";
export type ProviderName = WeeklySubscriptionProviderName | "OpenRouter";

export interface ProviderCapacityPresentation {
  readonly providerName: ProviderName;
  readonly detail: string;
  readonly color: "dim" | "warning" | "error";
  readonly highlight?: {
    readonly start: number;
    readonly length: number;
    readonly color: "success";
  };
}

export interface SubscriptionUsagePresentation {
  readonly text: string;
  readonly color: "dim" | "warning" | "error";
}

function formatWeeklyResetCountdown(remainingMs: number): string {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return "now";

  const totalMinutes = Math.max(1, Math.floor(remainingMs / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d${hours > 0 ? `${hours}h` : ""}`;
  if (hours > 0) return `${hours}h${minutes > 0 ? `${minutes}m` : ""}`;
  return `${minutes}m`;
}

export function presentProviderSubscriptionUsage(
  providerName: WeeklySubscriptionProviderName,
  status: WeeklySubscriptionUsageStatus,
  nowMs = Date.now(),
): ProviderCapacityPresentation {
  if (status.kind !== "available") {
    return {
      providerName,
      detail: status.kind === "loading" ? "wk loading…" : "wk unavailable",
      color: "dim",
    };
  }

  const usedPercent = Math.min(
    100,
    Math.max(0, Math.round(status.usedPercent)),
  );
  const filledCells = Math.round(usedPercent / 10);
  const bar = "━".repeat(filledCells) + "─".repeat(10 - filledCells);

  const resetCountdownSuffix =
    status.weeklyWindowResetsAtMs === undefined
      ? ""
      : ` ${formatWeeklyResetCountdown(status.weeklyWindowResetsAtMs - nowMs)}`;
  const limitResetCreditsSuffix =
    status.availableLimitResetCredits === undefined
      ? ""
      : ` ↻${status.availableLimitResetCredits}`;

  return {
    providerName,
    detail: `wk ${bar} ${usedPercent}%${resetCountdownSuffix}${limitResetCreditsSuffix}${status.stale ? " ~" : ""}`,
    color: usedPercent >= 90 ? "error" : usedPercent >= 80 ? "warning" : "dim",
    ...(usedPercent < 80 && filledCells > 0
      ? {
          highlight: {
            start: 3,
            length: filledCells,
            color: "success" as const,
          },
        }
      : {}),
  };
}

export function presentOpenRouterAccountCreditBalance(
  status: OpenRouterAccountCreditBalanceStatus,
): ProviderCapacityPresentation {
  if (status.kind === "loading" || status.kind === "unavailable") {
    return {
      providerName: "OpenRouter",
      detail: status.kind === "loading" ? "loading…" : "unavailable",
      color: "dim",
    };
  }

  const balance = status.balanceUsd;
  const amount =
    balance > 0 && balance < 0.01
      ? "<$0.01"
      : balance < 0 && balance > -0.01
        ? `-$${new Intl.NumberFormat("en-US", {
            useGrouping: false,
            maximumSignificantDigits: 15,
          }).format(Math.abs(balance))}`
        : balance < 0
          ? `-$${Math.abs(balance).toFixed(2)}`
          : `$${balance.toFixed(2)}`;
  return {
    providerName: "OpenRouter",
    detail: `${amount} left${status.stale ? " ~" : ""}`,
    color: "dim",
  };
}

/** Backwards-compatible single-provider presentation for the Codex seam. */
export function presentCodexQuotaStatus(
  status: WeeklySubscriptionUsageStatus,
  nowMs = Date.now(),
): SubscriptionUsagePresentation {
  const presentation = presentProviderSubscriptionUsage("Codex", status, nowMs);
  return {
    text: `${presentation.providerName} ${presentation.detail}`,
    color: presentation.color,
  };
}
