import { Effect } from "effect";

import type { ProviderAcquisitionCoordinator } from "../../src/provider-acquisition-coordinator.ts";

/** Test adapter that preserves the coordinator interface without filesystem sharing. */
export const immediateAcquisitionCoordinator: ProviderAcquisitionCoordinator = {
  coordinate: (request) =>
    request.acquire.pipe(
      Effect.map((attempt) => {
        if (attempt.kind === "success") {
          return {
            kind: "success" as const,
            value: attempt.value,
            observedAtMs: 0,
          };
        }
        return {
          kind: "deferred" as const,
          reason: attempt.kind,
          retryAtMs:
            attempt.kind === "temporary" ? (attempt.retryAtMs ?? 0) : 0,
        };
      }),
    ),
};
