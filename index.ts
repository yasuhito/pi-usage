import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { readCodexWeeklyQuotaUsage } from "./src/codex-usage.ts";
import { registerWeeklyQuotaUsage } from "./src/register.ts";

export default function piUsage(pi: ExtensionAPI): void {
  registerWeeklyQuotaUsage(pi, {
    now: Date.now,
    random: Math.random,
    schedule: (callback, delay) => {
      const timer = setTimeout(callback, delay);
      timer.unref();
      return () => clearTimeout(timer);
    },
    readWeeklyQuotaUsage: (credential, signal) =>
      readCodexWeeklyQuotaUsage(credential, fetch, signal),
    startPolling: (refresh) => {
      const timer = setInterval(refresh, 60_000);
      timer.unref();
      return () => clearInterval(timer);
    },
  });
}
