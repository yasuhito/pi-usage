export type QuotaStatus =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "available";
      readonly usedPercent: number;
      readonly stale: boolean;
      readonly weeklyWindowResetsAtMs?: number;
      readonly availableLimitResetCredits?: number;
    };

export interface QuotaStatusPresentation {
  readonly text: string;
  readonly color: "dim" | "warning" | "error";
}

function formatWeeklyResetCountdown(remainingMs: number): string {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return "now";

  const totalMinutes = Math.max(1, Math.floor(remainingMs / 60_000));
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;

  if (days > 0) return `${days}d${hours > 0 ? ` ${hours}h` : ""}`;
  if (hours > 0) return `${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`;
  return `${minutes}m`;
}

export function presentQuotaStatus(
  status: QuotaStatus,
  nowMs = Date.now(),
): QuotaStatusPresentation {
  if (status.kind !== "available") {
    return {
      text:
        status.kind === "loading"
          ? "Codex wk loading…"
          : "Codex wk unavailable",
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
      : ` · reset ${formatWeeklyResetCountdown(status.weeklyWindowResetsAtMs - nowMs)}`;
  const limitResetCreditsSuffix =
    status.availableLimitResetCredits === undefined
      ? ""
      : ` · ↻${status.availableLimitResetCredits}`;

  return {
    text: `Codex wk ${bar} ${usedPercent}%${resetCountdownSuffix}${limitResetCreditsSuffix}${status.stale ? " ~" : ""}`,
    color: usedPercent >= 90 ? "error" : usedPercent >= 75 ? "warning" : "dim",
  };
}
