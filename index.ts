import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { readCodexWeeklyUsage } from "./src/codex-usage.ts";
import { registerUsage } from "./src/register.ts";

export default function piUsage(pi: ExtensionAPI): void {
  registerUsage(pi, {
    now: Date.now,
    random: Math.random,
    readUsage: (credential, signal) =>
      readCodexWeeklyUsage(credential, fetch, signal),
    startPolling: (refresh) => {
      const timer = setInterval(refresh, 60_000);
      timer.unref();
      return () => clearInterval(timer);
    },
  });
}
