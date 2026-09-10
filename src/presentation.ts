export type QuotaStatus =
  | { readonly kind: "loading" }
  | { readonly kind: "unavailable" }
  | {
      readonly kind: "available";
      readonly usedPercent: number;
      readonly stale: boolean;
    };

export interface QuotaStatusPresentation {
  readonly text: string;
  readonly color: "dim" | "warning" | "error";
}

export function presentQuotaStatus(
  status: QuotaStatus,
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

  return {
    text: `Codex wk ${bar} ${usedPercent}%${status.stale ? " ~" : ""}`,
    color: usedPercent >= 90 ? "error" : usedPercent >= 75 ? "warning" : "dim",
  };
}
