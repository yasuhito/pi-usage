import { access, appendFile } from "node:fs/promises";
import { Effect } from "effect";

import { createFileProviderAcquisitionCoordinator } from "../../src/provider-acquisition-coordinator.ts";

const [
  runtimeDirectory,
  readyPath,
  startPath,
  countPath,
  behavior = "success",
  rawLeaseStaleMs,
  rawHeartbeatMs,
  rawFollowerWaitMs,
] = process.argv.slice(2);
if (!runtimeDirectory || !readyPath || !startPath || !countPath) {
  throw new Error("missing coordinator worker argument");
}

await appendFile(readyPath, `${process.pid}\n`);
while (true) {
  try {
    await access(startPath);
    break;
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const coordinator = createFileProviderAcquisitionCoordinator({
  runtimeDirectory,
  ...(rawLeaseStaleMs === undefined
    ? {}
    : { leaseStaleMs: Number(rawLeaseStaleMs) }),
  ...(rawHeartbeatMs === undefined
    ? {}
    : { heartbeatMs: Number(rawHeartbeatMs) }),
  ...(rawFollowerWaitMs === undefined
    ? {}
    : { followerWaitMs: Number(rawFollowerWaitMs) }),
});
const outcome = await Effect.runPromise(
  coordinator.coordinate({
    provider: "claude-subscription-usage",
    credential: "multiprocess-oauth-secret",
    decode: (value) => {
      if (typeof value !== "object" || value === null) return undefined;
      const usedPercent = Reflect.get(value, "usedPercent");
      const resetsAtMs = Reflect.get(value, "resetsAtMs");
      return typeof usedPercent === "number" && typeof resetsAtMs === "number"
        ? { usedPercent, resetsAtMs }
        : undefined;
    },
    reusableUntilMs: (_usage, observedAtMs) => observedAtMs + 180_000,
    acquire: Effect.promise(async () => {
      await appendFile(countPath, `${process.pid}\n`);
      if (behavior === "hang") await new Promise(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 100));
      return {
        kind: "success",
        value: { usedPercent: 42, resetsAtMs: Date.now() + 3_600_000 },
      };
    }),
  }),
);

process.stdout.write(`${JSON.stringify(outcome)}\n`);
