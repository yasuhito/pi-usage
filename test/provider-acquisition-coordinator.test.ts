import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Fiber } from "effect";
import { afterEach, assert, describe, test } from "vitest";

import {
  type CoordinatedAcquisitionRequest,
  createFileProviderAcquisitionCoordinator,
} from "../src/provider-acquisition-coordinator.ts";

interface Usage {
  readonly usedPercent: number;
  readonly resetsAtMs: number;
}

const roots: string[] = [];

async function runtimeRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pi-usage-runtime-"));
  await chmod(path, 0o700);
  roots.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true })),
  );
});

function request(
  acquire: CoordinatedAcquisitionRequest<Usage>["acquire"],
): CoordinatedAcquisitionRequest<Usage> {
  return {
    provider: "claude-subscription-usage",
    credential: "oauth-secret",
    decode: (value) => {
      if (typeof value !== "object" || value === null) return undefined;
      const usedPercent = Reflect.get(value, "usedPercent");
      const resetsAtMs = Reflect.get(value, "resetsAtMs");
      return typeof usedPercent === "number" &&
        usedPercent >= 0 &&
        usedPercent <= 100 &&
        typeof resetsAtMs === "number"
        ? { usedPercent, resetsAtMs }
        : undefined;
    },
    reusableUntilMs: (usage, observedAtMs) =>
      Math.min(observedAtMs + 180_000, usage.resetsAtMs),
    acquire,
  };
}

async function storedContents(path: string): Promise<string> {
  const items = await readdir(path, { withFileTypes: true });
  const contents = await Promise.all(
    items.map((item) => {
      const child = join(path, item.name);
      return item.isDirectory()
        ? storedContents(child)
        : readFile(child, "utf8").catch(() => "");
    }),
  );
  return `${items.map((item) => item.name).join("\n")}\n${contents.join("\n")}`;
}

async function waitForLines(path: string, count: number): Promise<void> {
  for (;;) {
    const contents = await readFile(path, "utf8").catch(() => "");
    if (contents.trim().split("\n").filter(Boolean).length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function spawnWorker(arguments_: readonly string[]) {
  const child = spawn(
    process.execPath,
    [
      "--experimental-strip-types",
      fileURLToPath(
        new URL("./fixtures/coordinator-worker.mjs", import.meta.url),
      ),
      ...arguments_,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const completion = new Promise<string>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`worker exited ${code ?? signal}: ${stderr}`));
    });
  });
  return { child, completion };
}

function runWorker(arguments_: readonly string[]): Promise<string> {
  return spawnWorker(arguments_).completion;
}

describe("provider acquisition coordination", () => {
  test("concurrent processes reuse one successful acquisition", async () => {
    const root = await runtimeRoot();
    const first = createFileProviderAcquisitionCoordinator({
      runtimeDirectory: root,
    });
    const second = createFileProviderAcquisitionCoordinator({
      runtimeDirectory: root,
    });
    let acquisitions = 0;
    const acquire = Effect.promise(async () => {
      acquisitions += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return {
        kind: "success" as const,
        value: { usedPercent: 42, resetsAtMs: Date.now() + 3_600_000 },
      };
    });

    const outcomes = await Promise.all([
      Effect.runPromise(first.coordinate(request(acquire))),
      Effect.runPromise(second.coordinate(request(acquire))),
    ]);

    assert.equal(acquisitions, 1);
    assert.deepEqual(
      outcomes.map((outcome) => outcome.kind),
      ["success", "success"],
    );
    assert.deepEqual(
      outcomes.map((outcome) =>
        outcome.kind === "success" ? outcome.value.usedPercent : undefined,
      ),
      [42, 42],
    );
  });

  test("never stores the credential or its plain fingerprint", async () => {
    const root = await runtimeRoot();
    const credential = "credential-must-remain-secret";
    const coordinator = createFileProviderAcquisitionCoordinator({
      runtimeDirectory: root,
    });
    const coordinatedRequest = {
      ...request(
        Effect.succeed({
          kind: "success" as const,
          value: { usedPercent: 42, resetsAtMs: Date.now() + 3_600_000 },
        }),
      ),
      credential,
    };

    await Effect.runPromise(coordinator.coordinate(coordinatedRequest));
    const stored = await storedContents(join(root, "pi-usage"));

    assert.equal(stored.includes(credential), false);
    assert.equal(
      stored.includes(createHash("sha256").update(credential).digest("hex")),
      false,
    );
  });

  test("removes entries untouched for twenty-four hours", async () => {
    const root = await runtimeRoot();
    const coordinator = createFileProviderAcquisitionCoordinator({
      runtimeDirectory: root,
    });
    await Effect.runPromise(
      coordinator.coordinate(
        request(
          Effect.succeed({
            kind: "success",
            value: { usedPercent: 42, resetsAtMs: Date.now() + 3_600_000 },
          }),
        ),
      ),
    );
    const entriesPath = join(root, "pi-usage", "acquisition-v1", "entries");
    const [oldEntry] = await readdir(entriesPath);
    assert.ok(oldEntry);
    const oldTime = new Date(Date.now() - 25 * 60 * 60_000);
    const oldEntryPath = join(entriesPath, oldEntry);
    await utimes(oldEntryPath, oldTime, oldTime);
    await Promise.all(
      (await readdir(oldEntryPath)).map((name) =>
        utimes(join(oldEntryPath, name), oldTime, oldTime),
      ),
    );

    await Effect.runPromise(
      coordinator.coordinate({
        ...request(
          Effect.succeed({
            kind: "success",
            value: { usedPercent: 27, resetsAtMs: Date.now() + 3_600_000 },
          }),
        ),
        credential: "another-oauth-secret",
      }),
    );

    assert.equal((await readdir(entriesPath)).includes(oldEntry), false);
  });

  test("coordinates one acquisition across Node processes", async () => {
    const root = await runtimeRoot();
    const readyPath = join(root, "ready");
    const startPath = join(root, "start");
    const countPath = join(root, "count");
    const arguments_ = [root, readyPath, startPath, countPath] as const;
    const workers = [runWorker(arguments_), runWorker(arguments_)];
    await waitForLines(readyPath, 2);
    await writeFile(startPath, "go");

    const outputs = await Promise.all(workers);
    const acquisitions = (await readFile(countPath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean);

    assert.equal(acquisitions.length, 1);
    assert.deepEqual(
      outputs.map((output) => JSON.parse(output).kind),
      ["success", "success"],
    );
  });

  test("another process recovers an expired lease after owner termination", async () => {
    const root = await runtimeRoot();
    const countPath = join(root, "count");
    const ownerReady = join(root, "owner-ready");
    const ownerStart = join(root, "owner-start");
    const owner = spawnWorker([
      root,
      ownerReady,
      ownerStart,
      countPath,
      "hang",
      "100",
      "20",
      "500",
    ]);
    const ownerExit = owner.completion.catch(() => "terminated");
    await waitForLines(ownerReady, 1);
    await writeFile(ownerStart, "go");
    await waitForLines(countPath, 1);
    owner.child.kill("SIGKILL");
    await ownerExit;
    await new Promise((resolve) => setTimeout(resolve, 125));

    const recoveryReady = join(root, "recovery-ready");
    const recoveryStart = join(root, "recovery-start");
    const recovery = runWorker([
      root,
      recoveryReady,
      recoveryStart,
      countPath,
      "success",
      "100",
      "20",
      "500",
    ]);
    await waitForLines(recoveryReady, 1);
    await writeFile(recoveryStart, "go");
    const output = await recovery;

    assert.equal(JSON.parse(output).kind, "success");
    assert.equal(
      (await readFile(countPath, "utf8")).trim().split("\n").length,
      2,
    );
  });

  test("a cancelled follower process does not bypass the owner", async () => {
    const root = await runtimeRoot();
    const countPath = join(root, "count");
    const ownerReady = join(root, "owner-ready");
    const ownerStart = join(root, "owner-start");
    const owner = spawnWorker([
      root,
      ownerReady,
      ownerStart,
      countPath,
      "hang",
      "1000",
      "20",
      "500",
    ]);
    const ownerExit = owner.completion.catch(() => "terminated");
    await waitForLines(ownerReady, 1);
    await writeFile(ownerStart, "go");
    await waitForLines(countPath, 1);

    const followerReady = join(root, "follower-ready");
    const followerStart = join(root, "follower-start");
    const follower = spawnWorker([
      root,
      followerReady,
      followerStart,
      countPath,
      "success",
      "1000",
      "20",
      "500",
    ]);
    const followerExit = follower.completion.catch(() => "terminated");
    await waitForLines(followerReady, 1);
    await writeFile(followerStart, "go");
    await new Promise((resolve) => setTimeout(resolve, 75));
    follower.child.kill("SIGKILL");
    await followerExit;

    assert.equal(
      (await readFile(countPath, "utf8")).trim().split("\n").length,
      1,
    );
    owner.child.kill("SIGKILL");
    await ownerExit;
  });

  test("a resumed stale owner cannot supersede its replacement", async () => {
    const root = await runtimeRoot();
    const timings = {
      runtimeDirectory: root,
      heartbeatMs: 1_000,
      leaseStaleMs: 50,
      followerWaitMs: 250,
    } as const;
    let releaseStaleOwner!: () => void;
    const staleOwnerGate = new Promise<void>((resolve) => {
      releaseStaleOwner = resolve;
    });
    const staleOwner = createFileProviderAcquisitionCoordinator(timings);
    const staleResult = Effect.runPromise(
      staleOwner.coordinate(
        request(
          Effect.promise(async () => {
            await staleOwnerGate;
            return {
              kind: "success" as const,
              value: { usedPercent: 99, resetsAtMs: Date.now() + 3_600_000 },
            };
          }),
        ),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 75));

    const replacement = createFileProviderAcquisitionCoordinator(timings);
    const replacementResult = await Effect.runPromise(
      replacement.coordinate(
        request(
          Effect.succeed({
            kind: "success",
            value: { usedPercent: 42, resetsAtMs: Date.now() + 3_600_000 },
          }),
        ),
      ),
    );
    releaseStaleOwner();
    const resumedResult = await staleResult;
    const reader = createFileProviderAcquisitionCoordinator(timings);
    const authoritative = await Effect.runPromise(
      reader.coordinate(
        request(Effect.die("authoritative replacement should be shared")),
      ),
    );

    assert.equal(
      replacementResult.kind === "success"
        ? replacementResult.value.usedPercent
        : undefined,
      42,
    );
    assert.equal(
      resumedResult.kind === "success"
        ? resumedResult.value.usedPercent
        : undefined,
      42,
    );
    assert.equal(
      authoritative.kind === "success"
        ? authoritative.value.usedPercent
        : undefined,
      42,
    );
  });

  test("a follower timeout never bypasses the active owner", async () => {
    const root = await runtimeRoot();
    const timings = {
      runtimeDirectory: root,
      heartbeatMs: 10,
      leaseStaleMs: 1_000,
      followerWaitMs: 50,
    } as const;
    const owner = createFileProviderAcquisitionCoordinator(timings);
    const ownerFiber = Effect.runFork(owner.coordinate(request(Effect.never)));
    await new Promise((resolve) => setTimeout(resolve, 30));
    let followerAcquired = false;
    const follower = createFileProviderAcquisitionCoordinator(timings);

    const outcome = await Effect.runPromise(
      follower.coordinate(
        request(
          Effect.sync(() => {
            followerAcquired = true;
            return {
              kind: "success" as const,
              value: { usedPercent: 99, resetsAtMs: Date.now() + 3_600_000 },
            };
          }),
        ),
      ),
    );
    await Effect.runPromise(Fiber.interrupt(ownerFiber));

    assert.equal(followerAcquired, false);
    assert.equal(
      outcome.kind === "deferred" ? outcome.reason : undefined,
      "follower-timeout",
    );
  });

  test("a cancelled follower never bypasses the active owner", async () => {
    const root = await runtimeRoot();
    const timings = {
      runtimeDirectory: root,
      heartbeatMs: 10,
      leaseStaleMs: 1_000,
      followerWaitMs: 500,
    } as const;
    const owner = createFileProviderAcquisitionCoordinator(timings);
    const ownerFiber = Effect.runFork(owner.coordinate(request(Effect.never)));
    await new Promise((resolve) => setTimeout(resolve, 30));
    let followerAcquired = false;
    const follower = createFileProviderAcquisitionCoordinator(timings);
    const followerFiber = Effect.runFork(
      follower.coordinate(
        request(
          Effect.sync(() => {
            followerAcquired = true;
            return {
              kind: "success" as const,
              value: { usedPercent: 99, resetsAtMs: Date.now() + 3_600_000 },
            };
          }),
        ),
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 30));

    await Effect.runPromise(Fiber.interrupt(followerFiber));
    await Effect.runPromise(Fiber.interrupt(ownerFiber));

    assert.equal(followerAcquired, false);
  });

  test("shares terminal suppression without exposing preceding usage", async () => {
    const root = await runtimeRoot();
    let now = 1_000_000;
    const coordinator = createFileProviderAcquisitionCoordinator({
      runtimeDirectory: root,
      now: () => now,
    });
    await Effect.runPromise(
      coordinator.coordinate(
        request(
          Effect.succeed({
            kind: "success",
            value: { usedPercent: 42, resetsAtMs: 5_000_000 },
          }),
        ),
      ),
    );
    now += 180_000;
    let terminalAttempts = 0;
    const terminalRequest = request(
      Effect.sync(() => {
        terminalAttempts += 1;
        return { kind: "terminal" as const };
      }),
    );

    const failed = await Effect.runPromise(
      coordinator.coordinate(terminalRequest),
    );
    const suppressed = await Effect.runPromise(
      createFileProviderAcquisitionCoordinator({
        runtimeDirectory: root,
        now: () => now,
      }).coordinate(terminalRequest),
    );

    assert.equal(terminalAttempts, 1);
    assert.deepEqual(failed, {
      kind: "deferred",
      reason: "terminal",
      retryAtMs: now + 900_000,
    });
    assert.deepEqual(suppressed, failed);
  });

  test("replaces a stale provider retry instructions into shared backoff", async () => {
    const root = await runtimeRoot();
    const now = 1_000;
    const coordinator = createFileProviderAcquisitionCoordinator({
      runtimeDirectory: root,
      now: () => now,
      random: () => 0.5,
    });

    const outcome = await Effect.runPromise(
      coordinator.coordinate(
        request(Effect.succeed({ kind: "temporary", retryAtMs: now - 1 })),
      ),
    );

    assert.deepEqual(outcome, {
      kind: "deferred",
      reason: "temporary",
      retryAtMs: now + 1_000,
    });
  });

  test("removes superseded state generations", async () => {
    const root = await runtimeRoot();
    let now = 1_000_000;
    const coordinator = createFileProviderAcquisitionCoordinator({
      runtimeDirectory: root,
      now: () => now,
    });
    for (const usedPercent of [10, 20, 30]) {
      await Effect.runPromise(
        coordinator.coordinate(
          request(
            Effect.succeed({
              kind: "success",
              value: { usedPercent, resetsAtMs: 5_000_000 },
            }),
          ),
        ),
      );
      now += 180_000;
    }
    const entriesPath = join(root, "pi-usage", "acquisition-v1", "entries");
    const [entryName] = await readdir(entriesPath);
    assert.ok(entryName);
    const generations = (await readdir(join(entriesPath, entryName))).filter(
      (name) => /^\d+\.json$/.test(name),
    );

    assert.equal(generations.length, 1);
  });

  test("shares temporary backoff and the preceding successful observation", async () => {
    const root = await runtimeRoot();
    let now = 1_000_000;
    const first = createFileProviderAcquisitionCoordinator({
      runtimeDirectory: root,
      now: () => now,
    });
    let acquisitions = 0;
    const success = request(
      Effect.sync(() => {
        acquisitions += 1;
        return {
          kind: "success" as const,
          value: { usedPercent: 42, resetsAtMs: 5_000_000 },
        };
      }),
    );
    await Effect.runPromise(first.coordinate(success));

    now += 180_000;
    const retryAtMs = now + 900_000;
    const failed = await Effect.runPromise(
      first.coordinate(
        request(
          Effect.sync(() => {
            acquisitions += 1;
            return { kind: "temporary" as const, retryAtMs };
          }),
        ),
      ),
    );
    const follower = createFileProviderAcquisitionCoordinator({
      runtimeDirectory: root,
      now: () => now,
    });
    const shared = await Effect.runPromise(
      follower.coordinate(
        request(
          Effect.sync(() => {
            acquisitions += 1;
            return {
              kind: "success" as const,
              value: { usedPercent: 99, resetsAtMs: 5_000_000 },
            };
          }),
        ),
      ),
    );

    assert.equal(acquisitions, 2);
    assert.deepEqual(failed, {
      kind: "deferred",
      reason: "temporary",
      retryAtMs,
      stale: {
        value: { usedPercent: 42, resetsAtMs: 5_000_000 },
        observedAtMs: 1_000_000,
      },
    });
    assert.deepEqual(shared, failed);
  });

  test("quarantines malformed state and reacquires under the lease", async () => {
    const root = await runtimeRoot();
    let now = 1_000_000;
    const coordinator = createFileProviderAcquisitionCoordinator({
      runtimeDirectory: root,
      now: () => now,
    });
    await Effect.runPromise(
      coordinator.coordinate(
        request(
          Effect.succeed({
            kind: "success",
            value: { usedPercent: 42, resetsAtMs: 5_000_000 },
          }),
        ),
      ),
    );
    const entriesPath = join(root, "pi-usage", "acquisition-v1", "entries");
    const [entryName] = await readdir(entriesPath);
    assert.ok(entryName);
    const entryPath = join(entriesPath, entryName);
    await writeFile(join(entryPath, "1.json"), "{malformed");
    now += 180_000;

    const recovered = await Effect.runPromise(
      coordinator.coordinate(
        request(
          Effect.succeed({
            kind: "success",
            value: { usedPercent: 27, resetsAtMs: 5_000_000 },
          }),
        ),
      ),
    );

    assert.equal(
      recovered.kind === "success" ? recovered.value.usedPercent : undefined,
      27,
    );
    assert.equal(
      (await readdir(entryPath)).some((name) => name.includes("quarantine")),
      true,
    );
  });

  test("fails closed when an existing application directory is not private", async () => {
    const root = await runtimeRoot();
    await mkdir(join(root, "pi-usage", "acquisition-v1"), {
      recursive: true,
      mode: 0o755,
    });
    const coordinator = createFileProviderAcquisitionCoordinator({
      runtimeDirectory: root,
    });

    const exit = await Effect.runPromiseExit(
      coordinator.coordinate(
        request(
          Effect.succeed({
            kind: "success",
            value: { usedPercent: 42, resetsAtMs: Date.now() + 3_600_000 },
          }),
        ),
      ),
    );

    assert.equal(exit._tag, "Failure");
  });

  test("fails closed when the runtime directory is not private", async () => {
    const root = await runtimeRoot();
    await chmod(root, 0o755);
    const coordinator = createFileProviderAcquisitionCoordinator({
      runtimeDirectory: root,
    });
    let acquired = false;

    const exit = await Effect.runPromiseExit(
      coordinator.coordinate(
        request(
          Effect.sync(() => {
            acquired = true;
            return {
              kind: "success" as const,
              value: { usedPercent: 42, resetsAtMs: Date.now() + 3_600_000 },
            };
          }),
        ),
      ),
    );

    assert.equal(exit._tag, "Failure");
    assert.equal(acquired, false);
  });
});
