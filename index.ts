import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { createAcquireDedicatedWeeklyQuotaUsage } from "./src/dedicated-weekly-quota-acquisition.ts";
import { registerWeeklyQuotaUsage } from "./src/register.ts";

export default function piUsage(pi: ExtensionAPI): void {
  registerWeeklyQuotaUsage(pi, {
    acquireDedicatedWeeklyQuotaUsage: createAcquireDedicatedWeeklyQuotaUsage({
      fetch,
    }),
  });
}
