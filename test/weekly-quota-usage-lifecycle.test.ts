import assert from "node:assert/strict";
import test from "node:test";

import {
  type CodexCredential,
  CodexUsageFormatError,
  CodexUsageRequestError,
} from "../src/codex-usage.ts";
import type { QuotaStatus } from "../src/presentation.ts";
import {
  type CodexCredentialResolution,
  createWeeklyQuotaUsageLifecycle,
} from "../src/weekly-quota-usage-lifecycle.ts";

function credential(accountId = "account-1"): CodexCredential {
  return { accessToken: `token-${accountId}`, accountId };
}

function lifecycleFixture() {
  let now = 1_000_000;
  let resolution: CodexCredentialResolution = {
    kind: "available",
    credential: credential(),
  };
  let resolutionReads = 0;
  let resolutionGate: Promise<void> | undefined;
  let readError: Error | undefined;
  let readGate: Promise<void> | undefined;
  let readsFail = false;
  let disableAuthAfterUsageReads: number | undefined;
  let scheduled: { callback: () => void; delay: number } | undefined;
  let pollingRefresh: (() => void) | undefined;
  let pollingStarted = 0;
  let pollingStopped = 0;
  let cancelledSchedules = 0;

  const statuses: Array<QuotaStatus | undefined> = [];
  const observedCredentials: CodexCredential[] = [];
  const observedSignals: Array<AbortSignal | undefined> = [];

  const lifecycle = createWeeklyQuotaUsageLifecycle({
    now: () => now,
    random: () => 0.5,
    schedule: (callback, delay) => {
      scheduled = { callback, delay };
      return () => {
        cancelledSchedules += 1;
        if (scheduled?.callback === callback) scheduled = undefined;
      };
    },
    resolveCredential: async () => {
      resolutionReads += 1;
      await resolutionGate;
      return resolution;
    },
    readWeeklyQuotaUsage: async (value, signal) => {
      observedCredentials.push(value);
      observedSignals.push(signal);
      if (observedCredentials.length === disableAuthAfterUsageReads) {
        resolution = { kind: "missing" };
      }
      await readGate;
      if (readError !== undefined) throw readError;
      if (readsFail) throw new Error("network unavailable");
      return {
        usedPercent: 63.4,
        resetsAtMs: 2_000_000,
        windowPosition: "secondary",
      };
    },
    publish: (status) => statuses.push(status),
    startPolling: (refresh) => {
      pollingStarted += 1;
      pollingRefresh = refresh;
      return () => {
        pollingStopped += 1;
        pollingRefresh = undefined;
      };
    },
  });

  return {
    lifecycle,
    statuses,
    observedCredentials,
    observedSignals,
    resolutionReads: () => resolutionReads,
    pollingStarted: () => pollingStarted,
    pollingStopped: () => pollingStopped,
    cancelledSchedules: () => cancelledSchedules,
    scheduledDelay: () => scheduled?.delay,
    runScheduled: () => {
      const callback = scheduled?.callback;
      scheduled = undefined;
      callback?.();
    },
    runPolling: () => pollingRefresh?.(),
    setNow: (value: number) => {
      now = value;
    },
    setResolution: (value: CodexCredentialResolution) => {
      resolution = value;
    },
    setResolutionGate: (value: Promise<void> | undefined) => {
      resolutionGate = value;
    },
    setAccountId: (accountId: string) => {
      resolution = { kind: "available", credential: credential(accountId) };
    },
    setReadError: (value: Error | undefined) => {
      readError = value;
    },
    setReadsFail: (value: boolean) => {
      readsFail = value;
    },
    setReadGate: (value: Promise<void> | undefined) => {
      readGate = value;
    },
    setDisableAuthAfterUsageReads: (value: number | undefined) => {
      disableAuthAfterUsageReads = value;
    },
  };
}

const immediate = () => new Promise<void>((resolve) => setImmediate(resolve));

test("start publishes loading and active-account usage", async () => {
  const fixture = lifecycleFixture();

  await fixture.lifecycle.start();

  assert.deepEqual(fixture.statuses, [
    { kind: "loading" },
    { kind: "available", usedPercent: 63.4, stale: false },
  ]);
  assert.deepEqual(fixture.observedCredentials, [credential()]);
});

test("missing credentials clear usage and do not start polling", async () => {
  const fixture = lifecycleFixture();
  fixture.setResolution({ kind: "missing" });

  await fixture.lifecycle.start();

  assert.deepEqual(fixture.statuses, [{ kind: "loading" }, undefined]);
  assert.equal(fixture.pollingStarted(), 0);
});

test("invalid credentials publish unavailable", async () => {
  const fixture = lifecycleFixture();
  fixture.setResolution({ kind: "invalid" });

  await fixture.lifecycle.start();

  assert.deepEqual(fixture.statuses.at(-1), { kind: "unavailable" });
});

test("polling starts after credential resolution and stops with lifecycle", async () => {
  const fixture = lifecycleFixture();

  await fixture.lifecycle.start();
  fixture.lifecycle.stop();

  assert.deepEqual(
    [fixture.pollingStarted(), fixture.pollingStopped()],
    [1, 1],
  );
});

test("fresh activity is debounced and polling can refresh old usage", async () => {
  const fixture = lifecycleFixture();
  await fixture.lifecycle.start();

  await fixture.lifecycle.refreshAfterActivity();
  assert.equal(fixture.observedCredentials.length, 1);

  fixture.setNow(1_031_000);
  fixture.runPolling();
  await immediate();

  assert.equal(fixture.observedCredentials.length, 2);
});

test("temporary failure publishes stale usage, then unavailable when expired", async () => {
  const fixture = lifecycleFixture();
  await fixture.lifecycle.start();
  fixture.setReadsFail(true);

  await fixture.lifecycle.refreshForAccountChange();
  assert.deepEqual(fixture.statuses.at(-1), {
    kind: "available",
    usedPercent: 63.4,
    stale: true,
  });

  fixture.setNow(1_600_000);
  fixture.runScheduled();
  assert.deepEqual(fixture.statuses.at(-1), { kind: "unavailable" });
});

test("stale usage is scheduled for its earliest expiration", async () => {
  const fixture = lifecycleFixture();
  await fixture.lifecycle.start();
  fixture.setReadsFail(true);

  await fixture.lifecycle.refreshForAccountChange();

  assert.equal(fixture.scheduledDelay(), 600_000);
});

test("stop cancels scheduled stale expiration", async () => {
  const fixture = lifecycleFixture();
  await fixture.lifecycle.start();
  fixture.setReadsFail(true);
  await fixture.lifecycle.refreshForAccountChange();
  const statusCount = fixture.statuses.length;

  fixture.lifecycle.stop();
  fixture.runScheduled();

  assert.equal(fixture.statuses.length, statusCount);
});

test("a dedicated quota observation becomes the baseline for passive observation", async () => {
  const fixture = lifecycleFixture();
  await fixture.lifecycle.start();

  fixture.lifecycle.observeCodexResponse({
    "x-codex-secondary-used-percent": "82",
  });

  assert.deepEqual(fixture.statuses.at(-1), {
    kind: "available",
    usedPercent: 82,
    stale: false,
  });
});

test("fresh headers cancel scheduled stale expiration", async () => {
  const fixture = lifecycleFixture();
  await fixture.lifecycle.start();
  fixture.setReadsFail(true);
  await fixture.lifecycle.refreshForAccountChange();

  fixture.lifecycle.observeCodexResponse({
    "x-codex-secondary-used-percent": "82",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": "4000",
  });

  assert.equal(fixture.cancelledSchedules(), 1);
  assert.equal(fixture.scheduledDelay(), undefined);
  assert.deepEqual(fixture.statuses.at(-1), {
    kind: "available",
    usedPercent: 82,
    stale: false,
  });
});

test("an empty response refreshes an old observation", async () => {
  const fixture = lifecycleFixture();
  await fixture.lifecycle.start();
  fixture.setNow(1_031_000);

  fixture.lifecycle.observeCodexResponse({});
  await immediate();

  assert.equal(fixture.observedCredentials.length, 2);
});

test("malformed recognized headers publish unavailable", async () => {
  const fixture = lifecycleFixture();
  await fixture.lifecycle.start();

  fixture.lifecycle.observeCodexResponse({
    "x-codex-secondary-used-percent": " ",
    "x-codex-secondary-window-minutes": "10080",
    "x-codex-secondary-reset-at": "4000",
  });

  assert.deepEqual(fixture.statuses.at(-1), { kind: "unavailable" });
});

test("overlapping activity refreshes share one request", async () => {
  const fixture = lifecycleFixture();
  await fixture.lifecycle.start();
  fixture.setNow(1_031_000);

  let release: (() => void) | undefined;
  fixture.setReadGate(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );

  const refreshes = [
    fixture.lifecycle.refreshAfterActivity(),
    fixture.lifecycle.refreshAfterActivity(),
  ];
  await immediate();
  release?.();
  await Promise.all(refreshes);

  assert.equal(fixture.observedCredentials.length, 2);
});

test("stop prevents a pending credential resolution from publishing", async () => {
  const fixture = lifecycleFixture();
  let release: (() => void) | undefined;
  fixture.setResolutionGate(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );

  const starting = fixture.lifecycle.start();
  await immediate();
  fixture.lifecycle.stop();
  fixture.setResolution({ kind: "missing" });
  release?.();
  await starting;

  assert.deepEqual(fixture.statuses, [{ kind: "loading" }]);
  assert.equal(fixture.pollingStarted(), 0);
});

test("stop aborts an in-flight request", async () => {
  const fixture = lifecycleFixture();
  let release: (() => void) | undefined;
  fixture.setReadGate(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );

  const starting = fixture.lifecycle.start();
  await immediate();
  fixture.lifecycle.stop();

  assert.equal(fixture.observedSignals.at(-1)?.aborted, true);
  release?.();
  await starting;
});

test("a forced refresh queued behind a request cannot run after stop", async () => {
  const fixture = lifecycleFixture();
  let release: (() => void) | undefined;
  fixture.setReadGate(
    new Promise<void>((resolve) => {
      release = resolve;
    }),
  );

  const starting = fixture.lifecycle.start();
  await immediate();
  const queued = fixture.lifecycle.refreshForAccountChange();
  fixture.lifecycle.stop();
  release?.();
  await Promise.all([starting, queued]);

  assert.equal(fixture.observedCredentials.length, 1);
  assert.equal(fixture.pollingStarted(), 0);
});

test("Retry-After suppresses requests until its deadline", async () => {
  const fixture = lifecycleFixture();
  await fixture.lifecycle.start();
  fixture.setReadError(new CodexUsageRequestError(429, "120"));
  fixture.setNow(1_031_000);

  await fixture.lifecycle.refreshAfterActivity();
  await fixture.lifecycle.refreshAfterActivity();
  assert.equal(fixture.observedCredentials.length, 2);

  fixture.setNow(1_151_001);
  await fixture.lifecycle.refreshAfterActivity();

  assert.equal(fixture.observedCredentials.length, 3);
});

test("stale usage expires while Retry-After suppresses requests", async () => {
  const fixture = lifecycleFixture();
  await fixture.lifecycle.start();
  fixture.setReadError(new CodexUsageRequestError(429, "1200"));

  await fixture.lifecycle.refreshForAccountChange();
  fixture.setNow(2_000_001);
  await fixture.lifecycle.refreshAfterActivity();

  assert.deepEqual(fixture.statuses.at(-1), { kind: "unavailable" });
});

test("temporary failures use exponential backoff", async () => {
  const fixture = lifecycleFixture();
  await fixture.lifecycle.start();
  fixture.setReadsFail(true);
  fixture.setNow(1_031_000);

  await fixture.lifecycle.refreshForAccountChange();
  await fixture.lifecycle.refreshAfterActivity();
  assert.equal(fixture.observedCredentials.length, 2);

  fixture.setNow(1_032_001);
  await fixture.lifecycle.refreshAfterActivity();

  assert.equal(fixture.observedCredentials.length, 3);
});

test("account refresh bypasses old-account backoff", async () => {
  const fixture = lifecycleFixture();
  await fixture.lifecycle.start();
  fixture.setReadError(new CodexUsageRequestError(429, "120"));

  await fixture.lifecycle.refreshForAccountChange();
  fixture.setAccountId("account-2");
  await fixture.lifecycle.refreshForAccountChange();

  assert.deepEqual(fixture.observedCredentials.at(-1), credential("account-2"));
});

test("authentication failure resolves credentials and retries once", async () => {
  const fixture = lifecycleFixture();
  await fixture.lifecycle.start();
  fixture.setReadError(new CodexUsageRequestError(401, undefined));

  await fixture.lifecycle.refreshForAccountChange();

  assert.equal(fixture.resolutionReads(), 3);
  assert.equal(fixture.observedCredentials.length, 3);
  assert.deepEqual(fixture.statuses.at(-1), { kind: "unavailable" });
});

test("logout discovered during authentication retry clears usage and polling", async () => {
  const fixture = lifecycleFixture();
  await fixture.lifecycle.start();
  fixture.setReadError(new CodexUsageRequestError(401, undefined));
  fixture.setDisableAuthAfterUsageReads(2);

  await fixture.lifecycle.refreshForAccountChange();

  assert.equal(fixture.pollingStopped(), 1);
  assert.equal(fixture.statuses.at(-1), undefined);
});

test("malformed dedicated observation discards partial passive fields", async () => {
  const fixture = lifecycleFixture();
  await fixture.lifecycle.start();
  fixture.lifecycle.observeCodexResponse({
    "x-codex-primary-window-minutes": "10080",
  });
  fixture.setReadError(new CodexUsageFormatError("malformed"));
  await fixture.lifecycle.refreshForAccountChange();
  const statusCount = fixture.statuses.length;

  fixture.lifecycle.observeCodexResponse({
    "x-codex-primary-used-percent": "74",
    "x-codex-primary-reset-at": "4000",
  });

  assert.equal(fixture.statuses.length, statusCount);
});

test("invalid credentials discard partial passive fields", async () => {
  const fixture = lifecycleFixture();
  await fixture.lifecycle.start();
  fixture.lifecycle.observeCodexResponse({
    "x-codex-primary-window-minutes": "10080",
  });
  fixture.setResolution({ kind: "invalid" });
  await fixture.lifecycle.refreshForAccountChange();
  const statusCount = fixture.statuses.length;

  fixture.lifecycle.observeCodexResponse({
    "x-codex-primary-used-percent": "74",
    "x-codex-primary-reset-at": "4000",
  });

  assert.equal(fixture.statuses.length, statusCount);
});

test("permanent request failure discards old usage", async () => {
  const fixture = lifecycleFixture();
  await fixture.lifecycle.start();
  fixture.setReadError(new CodexUsageRequestError(400, undefined));

  await fixture.lifecycle.refreshForAccountChange();

  assert.deepEqual(fixture.statuses.at(-1), { kind: "unavailable" });
});

test("account change discards previous-account usage before refresh", async () => {
  const fixture = lifecycleFixture();
  await fixture.lifecycle.start();
  fixture.setAccountId("account-2");
  fixture.setReadsFail(true);

  await fixture.lifecycle.refreshForAccountChange();

  assert.deepEqual(fixture.observedCredentials.at(-1), credential("account-2"));
  assert.deepEqual(fixture.statuses.at(-1), { kind: "unavailable" });
});

test("account resolution isolates passive observations", async () => {
  const fixture = lifecycleFixture();
  await fixture.lifecycle.start();
  fixture.lifecycle.observeCodexResponse({
    "x-codex-primary-window-minutes": "10080",
  });
  fixture.setAccountId("account-2");
  let releaseResolution: (() => void) | undefined;
  fixture.setResolutionGate(
    new Promise<void>((resolve) => {
      releaseResolution = resolve;
    }),
  );
  const refreshing = fixture.lifecycle.refreshForAccountChange();
  await immediate();
  const statusCount = fixture.statuses.length;

  fixture.lifecycle.observeCodexResponse({
    "x-codex-primary-used-percent": "74",
    "x-codex-primary-reset-at": "4000",
  });

  assert.equal(fixture.statuses.length, statusCount);
  releaseResolution?.();
  await refreshing;
});

test("account change discards partial passive observation fields", async () => {
  const fixture = lifecycleFixture();
  await fixture.lifecycle.start();
  fixture.lifecycle.observeCodexResponse({
    "x-codex-primary-window-minutes": "10080",
  });
  fixture.setAccountId("account-2");
  fixture.setReadsFail(true);
  await fixture.lifecycle.refreshForAccountChange();
  const statusCount = fixture.statuses.length;

  fixture.lifecycle.observeCodexResponse({
    "x-codex-primary-used-percent": "74",
    "x-codex-primary-reset-at": "4000",
  });

  assert.equal(fixture.statuses.length, statusCount);
});
