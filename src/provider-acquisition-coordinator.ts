import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Data, Effect } from "effect";

const PROTOCOL_VERSION = 1;
const TERMINAL_SUPPRESSION_MS = 15 * 60_000;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const LEASE_STALE_MS = 10_000;
const HEARTBEAT_MS = 2_000;
const FOLLOWER_WAIT_MS = 6_000;
const ENTRY_RETENTION_MS = 24 * 60 * 60_000;
const MAX_STATE_BYTES = 16 * 1024;

export class AcquisitionCoordinationUnavailable extends Data.TaggedError(
  "AcquisitionCoordinationUnavailable",
)<{ readonly reason: string }> {}

export type CoordinatedAcquisitionAttempt<A> =
  | { readonly kind: "success"; readonly value: A }
  | { readonly kind: "temporary"; readonly retryAtMs?: number }
  | { readonly kind: "malformed" }
  | { readonly kind: "credential-rejected" }
  | { readonly kind: "terminal" };

export type CoordinatedAcquisitionOutcome<A> =
  | {
      readonly kind: "success";
      readonly value: A;
      readonly observedAtMs: number;
    }
  | {
      readonly kind: "deferred";
      readonly reason:
        | "temporary"
        | "malformed"
        | "credential-rejected"
        | "terminal"
        | "follower-timeout";
      readonly retryAtMs: number;
      readonly stale?: { readonly value: A; readonly observedAtMs: number };
    };

export interface CoordinatedAcquisitionRequest<A> {
  readonly provider: string;
  /** Used only in memory as HMAC input. */
  readonly credential: string;
  readonly decode: (value: unknown) => A | undefined;
  readonly reusableUntilMs: (value: A, observedAtMs: number) => number;
  readonly acquire: Effect.Effect<CoordinatedAcquisitionAttempt<A>>;
}

export interface ProviderAcquisitionCoordinator {
  readonly coordinate: <A>(
    request: CoordinatedAcquisitionRequest<A>,
  ) => Effect.Effect<
    CoordinatedAcquisitionOutcome<A>,
    AcquisitionCoordinationUnavailable
  >;
}

interface CoordinatorOptions {
  readonly runtimeDirectory?: string;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly leaseStaleMs?: number;
  readonly heartbeatMs?: number;
  readonly followerWaitMs?: number;
}

interface StoredSuccess {
  readonly observedAtMs: number;
  readonly value: unknown;
}

interface StoredState {
  readonly version: 1;
  readonly generation: number;
  readonly updatedAtMs: number;
  readonly failures: number;
  readonly outcome:
    | { readonly kind: "pending"; readonly startedAtMs: number }
    | { readonly kind: "success" }
    | {
        readonly kind: "deferred";
        readonly reason:
          | "temporary"
          | "malformed"
          | "credential-rejected"
          | "terminal";
        readonly retryAtMs: number;
      };
  readonly success?: StoredSuccess;
}

interface Runtime {
  readonly entries: string;
  readonly secret: Buffer;
}

function coordinationUnavailable(reason: unknown) {
  return new AcquisitionCoordinationUnavailable({
    reason: reason instanceof Error ? reason.message : String(reason),
  });
}

async function validatePrivateDirectory(path: string): Promise<void> {
  const information = await lstat(path);
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error("runtime location is not a real directory");
  }
  const getuid = process.getuid;
  if (getuid === undefined || information.uid !== getuid()) {
    throw new Error("runtime location is not owned by the current user");
  }
  if ((information.mode & 0o077) !== 0) {
    throw new Error("runtime location permissions are not private");
  }
}

async function atomicWrite(
  path: string,
  contents: string | Buffer,
): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, contents, { mode: 0o600, flag: "wx" });
  await rename(temporary, path);
}

async function readAndValidateSecret(path: string): Promise<Buffer> {
  const information = await lstat(path);
  const contents = await readFile(path);
  if (
    !information.isFile() ||
    information.isSymbolicLink() ||
    information.uid !== process.getuid?.() ||
    (information.mode & 0o077) !== 0 ||
    contents.length !== 32
  ) {
    throw new Error("coordination secret is unsafe");
  }
  return contents;
}

async function initializeSecret(root: string): Promise<Buffer> {
  const secretPath = join(root, "secret");
  try {
    return await readAndValidateSecret(secretPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temporary = join(root, `secret.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, randomBytes(32), { mode: 0o600, flag: "wx" });
    try {
      await link(temporary, secretPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  } finally {
    await rm(temporary, { force: true });
  }
  return readAndValidateSecret(secretPath);
}

async function initializeRuntime(
  requestedRuntimeDirectory: string | undefined,
): Promise<Runtime> {
  if (process.platform !== "linux") throw new Error("Linux is required");
  const runtimeDirectory =
    requestedRuntimeDirectory ?? process.env.XDG_RUNTIME_DIR;
  if (runtimeDirectory === undefined || !isAbsolute(runtimeDirectory)) {
    throw new Error("a secure XDG_RUNTIME_DIR is required");
  }
  await validatePrivateDirectory(runtimeDirectory);
  const applicationRoot = join(runtimeDirectory, "pi-usage");
  await mkdir(applicationRoot, { mode: 0o700 }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    },
  );
  await validatePrivateDirectory(applicationRoot);
  const root = join(applicationRoot, `acquisition-v${PROTOCOL_VERSION}`);
  await mkdir(root, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  await validatePrivateDirectory(root);
  const entries = join(root, "entries");
  await mkdir(entries, { mode: 0o700 }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    },
  );
  await validatePrivateDirectory(entries);
  return { entries, secret: await initializeSecret(root) };
}

function parseState(value: unknown): StoredState | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const version = Reflect.get(value, "version");
  const generation = Reflect.get(value, "generation");
  const updatedAtMs = Reflect.get(value, "updatedAtMs");
  const failures = Reflect.get(value, "failures");
  const outcome = Reflect.get(value, "outcome");
  if (
    version !== 1 ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    !Number.isSafeInteger(updatedAtMs) ||
    !Number.isSafeInteger(failures) ||
    failures < 0 ||
    typeof outcome !== "object" ||
    outcome === null
  )
    return undefined;
  const kind = Reflect.get(outcome, "kind");
  if (kind === "pending") {
    const startedAtMs = Reflect.get(outcome, "startedAtMs");
    if (!Number.isSafeInteger(startedAtMs)) return undefined;
  } else if (kind === "deferred") {
    const reason = Reflect.get(outcome, "reason");
    const retryAtMs = Reflect.get(outcome, "retryAtMs");
    if (
      !["temporary", "malformed", "credential-rejected", "terminal"].includes(
        reason,
      ) ||
      !Number.isSafeInteger(retryAtMs)
    )
      return undefined;
  } else if (kind !== "success") return undefined;
  const success = Reflect.get(value, "success");
  if (success !== undefined) {
    if (typeof success !== "object" || success === null) return undefined;
    if (!Number.isSafeInteger(Reflect.get(success, "observedAtMs")))
      return undefined;
    if (!("value" in success)) return undefined;
  }
  return value as StoredState;
}

function isReasonableState(
  state: StoredState,
  currentTime: number,
  decode: (value: unknown) => unknown,
): boolean {
  if (
    state.updatedAtMs < 0 ||
    state.updatedAtMs > currentTime + 60_000 ||
    currentTime - state.updatedAtMs > ENTRY_RETENTION_MS
  ) {
    return false;
  }
  if (
    state.success !== undefined &&
    (state.success.observedAtMs < 0 ||
      state.success.observedAtMs > state.updatedAtMs ||
      decode(state.success.value) === undefined)
  ) {
    return false;
  }
  if (state.outcome.kind === "pending") {
    return (
      state.outcome.startedAtMs >= 0 &&
      state.outcome.startedAtMs <= currentTime + 60_000
    );
  }
  if (state.outcome.kind === "deferred") {
    return (
      state.outcome.retryAtMs >= state.updatedAtMs &&
      state.outcome.retryAtMs <= 8_640_000_000_000_000
    );
  }
  return state.success !== undefined;
}

async function quarantineMalformedStates(
  entry: string,
  currentTime: number,
  decode: (value: unknown) => unknown,
): Promise<void> {
  const names = await readdir(entry);
  for (const name of names) {
    const match = /^(\d+)\.json$/.exec(name);
    if (match === null) continue;
    const path = join(entry, name);
    let valid = false;
    try {
      const raw = await readFile(path);
      const state =
        raw.length <= MAX_STATE_BYTES
          ? parseState(JSON.parse(raw.toString("utf8")))
          : undefined;
      valid =
        state?.generation === Number(match[1]) &&
        isReasonableState(state, currentTime, decode);
    } catch {
      valid = false;
    }
    if (valid) continue;
    try {
      await rename(path, `${path}.quarantine.${randomUUID()}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function removeSupersededGenerations(
  entry: string,
  currentGeneration: number,
): Promise<void> {
  const names = await readdir(entry);
  await Promise.all(
    names.map(async (name) => {
      const match = /^(\d+)\.json$/.exec(name);
      if (match === null || Number(match[1]) >= currentGeneration) return;
      await rm(join(entry, name), { force: true });
    }),
  );
}

async function readLatestState(
  entry: string,
  currentTime: number,
  decode: (value: unknown) => unknown,
): Promise<StoredState | undefined> {
  let names: string[];
  try {
    names = await readdir(entry);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const generations = names
    .map((name) => /^(\d+)\.json$/.exec(name))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => Number(match[1]))
    .filter(Number.isSafeInteger)
    .sort((a, b) => b - a);
  const generation = generations[0];
  if (generation === undefined) return undefined;
  const path = join(entry, `${generation}.json`);
  try {
    const raw = await readFile(path);
    if (raw.length > MAX_STATE_BYTES) return undefined;
    const state = parseState(JSON.parse(raw.toString("utf8")));
    return state?.generation === generation &&
      isReasonableState(state, currentTime, decode)
      ? state
      : undefined;
  } catch {
    // The lock owner quarantines the malformed newest generation.
    return undefined;
  }
}

function priorSuccess<A>(
  state: StoredState | undefined,
  decode: (value: unknown) => A | undefined,
): { value: A; observedAtMs: number } | undefined {
  if (state?.success === undefined) return undefined;
  const value = decode(state.success.value);
  return value === undefined
    ? undefined
    : { value, observedAtMs: state.success.observedAtMs };
}

function reusableOutcome<A>(
  state: StoredState | undefined,
  request: CoordinatedAcquisitionRequest<A>,
  now: number,
): CoordinatedAcquisitionOutcome<A> | undefined {
  const success = priorSuccess(state, request.decode);
  if (state?.outcome.kind === "success" && success !== undefined) {
    if (now < request.reusableUntilMs(success.value, success.observedAtMs)) {
      return { kind: "success", ...success };
    }
  }
  if (state?.outcome.kind === "deferred" && now < state.outcome.retryAtMs) {
    return {
      kind: "deferred",
      reason: state.outcome.reason,
      retryAtMs: state.outcome.retryAtMs,
      ...(!["temporary", "malformed"].includes(state.outcome.reason) ||
      success === undefined
        ? {}
        : { stale: success }),
    };
  }
  return undefined;
}

async function tryAcquireLease(
  entry: string,
  token: string,
  now: number,
  staleMs: number,
): Promise<FileHandle | undefined> {
  const lockPath = join(entry, "lease");
  try {
    await mkdir(lockPath, { mode: 0o700 });
    try {
      const owner = await open(join(lockPath, "owner"), "wx", 0o600);
      await owner.writeFile(token);
      return owner;
    } catch (error) {
      await rm(lockPath, { recursive: true, force: true });
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  try {
    const information = await stat(join(lockPath, "owner")).catch(
      async (error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return stat(lockPath);
      },
    );
    if (now - information.mtimeMs < staleMs) return undefined;
    const abandoned = join(entry, `lease.abandoned.${randomUUID()}`);
    await rename(lockPath, abandoned);
    await rm(abandoned, { recursive: true, force: true });
    return tryAcquireLease(entry, token, now, staleMs);
  } catch (error) {
    if (
      ["ENOENT", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")
    ) {
      return undefined;
    }
    throw error;
  }
}

async function stillOwnsLease(entry: string, token: string): Promise<boolean> {
  try {
    return (await readFile(join(entry, "lease", "owner"), "utf8")) === token;
  } catch {
    return false;
  }
}

async function releaseLease(entry: string, token: string): Promise<void> {
  if (!(await stillOwnsLease(entry, token))) return;
  const released = join(entry, `lease.released.${randomUUID()}`);
  try {
    await rename(join(entry, "lease"), released);
    await rm(released, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function cleanup(entries: string, now: number): Promise<void> {
  return readdir(entries, { withFileTypes: true })
    .then(async (items) => {
      await Promise.all(
        items
          .filter((item) => item.isDirectory() && !item.isSymbolicLink())
          .map(async (item) => {
            const path = join(entries, item.name);
            const information = await stat(path);
            if (now - information.mtimeMs <= ENTRY_RETENTION_MS) return;
            try {
              await lstat(join(path, "lease"));
              return;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
            }
            const names = await readdir(path);
            await Promise.all(
              names.map(async (name) => {
                const child = join(path, name);
                const childInformation = await lstat(child);
                if (
                  childInformation.isFile() &&
                  now - childInformation.mtimeMs > ENTRY_RETENTION_MS
                ) {
                  await rm(child, { force: true });
                }
              }),
            );
            await rmdir(path).catch(() => undefined);
          }),
      );
    })
    .catch(() => undefined);
}

export function createFileProviderAcquisitionCoordinator(
  options: CoordinatorOptions = {},
): ProviderAcquisitionCoordinator {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const leaseStaleMs = options.leaseStaleMs ?? LEASE_STALE_MS;
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const followerWaitMs = options.followerWaitMs ?? FOLLOWER_WAIT_MS;
  let runtimePromise: Promise<Runtime> | undefined;

  const runtime = Effect.tryPromise({
    try: async () => {
      runtimePromise ??= initializeRuntime(options.runtimeDirectory);
      return runtimePromise;
    },
    catch: coordinationUnavailable,
  });

  const coordinate = <A>(request: CoordinatedAcquisitionRequest<A>) =>
    Effect.gen(function* () {
      const shared = yield* runtime;
      const currentTime = now();
      yield* Effect.promise(() => cleanup(shared.entries, currentTime));
      if (!/^[a-z0-9-]+$/.test(request.provider)) {
        return yield* coordinationUnavailable("invalid provider namespace");
      }
      const key = createHmac("sha256", shared.secret)
        .update(request.credential)
        .digest("hex");
      const entry = join(shared.entries, `${request.provider}-${key}`);
      yield* Effect.tryPromise({
        try: async () => {
          await mkdir(entry, { mode: 0o700 }).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code !== "EEXIST") throw error;
            },
          );
          await validatePrivateDirectory(entry);
          const touchedAt = new Date(now());
          await utimes(entry, touchedAt, touchedAt);
        },
        catch: coordinationUnavailable,
      });

      let state = yield* Effect.tryPromise({
        try: () => readLatestState(entry, now(), request.decode),
        catch: coordinationUnavailable,
      });
      const reusable = reusableOutcome(state, request, now());
      if (reusable !== undefined) return reusable;

      const token = randomUUID();
      const waitStartedAt = now();
      let leaseHandle: FileHandle | undefined;
      while (
        leaseHandle === undefined &&
        now() - waitStartedAt < followerWaitMs
      ) {
        leaseHandle = yield* Effect.tryPromise({
          try: () => tryAcquireLease(entry, token, now(), leaseStaleMs),
          catch: coordinationUnavailable,
        });
        if (leaseHandle === undefined) {
          yield* Effect.sleep(25);
          state = yield* Effect.tryPromise({
            try: () => readLatestState(entry, now(), request.decode),
            catch: coordinationUnavailable,
          });
          const followerOutcome = reusableOutcome(state, request, now());
          if (followerOutcome !== undefined) return followerOutcome;
        }
      }
      if (leaseHandle === undefined) {
        state = yield* Effect.tryPromise({
          try: () => readLatestState(entry, now(), request.decode),
          catch: coordinationUnavailable,
        });
        const followerOutcome = reusableOutcome(state, request, now());
        if (followerOutcome !== undefined) return followerOutcome;
        const stale = priorSuccess(state, request.decode);
        return {
          kind: "deferred" as const,
          reason: "follower-timeout" as const,
          retryAtMs: now() + INITIAL_BACKOFF_MS,
          ...(stale === undefined ? {} : { stale }),
        };
      }

      return yield* Effect.acquireUseRelease(
        Effect.succeed({ token, leaseHandle }),
        ({ leaseHandle }) =>
          Effect.gen(function* () {
            yield* Effect.tryPromise({
              try: () =>
                quarantineMalformedStates(entry, now(), request.decode),
              catch: coordinationUnavailable,
            });
            state = yield* Effect.tryPromise({
              try: () => readLatestState(entry, now(), request.decode),
              catch: coordinationUnavailable,
            });
            const ownerReusable = reusableOutcome(state, request, now());
            if (ownerReusable !== undefined) return ownerReusable;
            const generation = (state?.generation ?? 0) + 1;
            const success = state?.success;
            const startedAtMs = now();
            const pending: StoredState = {
              version: 1,
              generation,
              updatedAtMs: startedAtMs,
              failures: state?.failures ?? 0,
              outcome: { kind: "pending", startedAtMs },
              ...(success === undefined ? {} : { success }),
            };
            yield* Effect.tryPromise({
              try: () =>
                atomicWrite(
                  join(entry, `${generation}.json`),
                  JSON.stringify(pending),
                ),
              catch: coordinationUnavailable,
            });
            const heartbeat = Effect.forever(
              Effect.sleep(heartbeatMs).pipe(
                Effect.andThen(
                  Effect.gen(function* () {
                    const ownsLease = yield* Effect.tryPromise({
                      try: () => stillOwnsLease(entry, token),
                      catch: coordinationUnavailable,
                    });
                    if (!ownsLease) {
                      return yield* coordinationUnavailable("lease was lost");
                    }
                    const time = new Date(now());
                    yield* Effect.tryPromise({
                      try: () => leaseHandle.utimes(time, time),
                      catch: coordinationUnavailable,
                    });
                  }),
                ),
              ),
            );
            const attempt = yield* Effect.raceFirst(request.acquire, heartbeat);
            const completedAtMs = now();
            const ownsLease = yield* Effect.tryPromise({
              try: () => stillOwnsLease(entry, token),
              catch: coordinationUnavailable,
            });
            if (!ownsLease) {
              const latest = yield* Effect.tryPromise({
                try: () => readLatestState(entry, now(), request.decode),
                catch: coordinationUnavailable,
              });
              const latestOutcome = reusableOutcome(latest, request, now());
              if (latestOutcome !== undefined) return latestOutcome;
              const stale = priorSuccess(latest, request.decode);
              return {
                kind: "deferred" as const,
                reason: "follower-timeout" as const,
                retryAtMs: now() + INITIAL_BACKOFF_MS,
                ...(stale === undefined ? {} : { stale }),
              };
            }
            const previous = priorSuccess(state, request.decode);
            let completed: StoredState;
            let outcome: CoordinatedAcquisitionOutcome<A>;
            if (attempt.kind === "success") {
              completed = {
                version: 1,
                generation,
                updatedAtMs: completedAtMs,
                failures: 0,
                outcome: { kind: "success" },
                success: { observedAtMs: completedAtMs, value: attempt.value },
              };
              outcome = {
                kind: "success",
                value: attempt.value,
                observedAtMs: completedAtMs,
              };
            } else {
              const failures = (state?.failures ?? 0) + 1;
              const reason = attempt.kind;
              const providerRetryAtMs =
                attempt.kind === "temporary" &&
                attempt.retryAtMs !== undefined &&
                attempt.retryAtMs > completedAtMs
                  ? attempt.retryAtMs
                  : undefined;
              const retryAtMs =
                attempt.kind === "temporary" || attempt.kind === "malformed"
                  ? (providerRetryAtMs ??
                    completedAtMs +
                      Math.min(
                        MAX_BACKOFF_MS,
                        Math.max(
                          INITIAL_BACKOFF_MS,
                          INITIAL_BACKOFF_MS *
                            2 ** (failures - 1) *
                            (0.5 + random()),
                        ),
                      ))
                  : completedAtMs + TERMINAL_SUPPRESSION_MS;
              completed = {
                version: 1,
                generation,
                updatedAtMs: completedAtMs,
                failures,
                outcome: { kind: "deferred", reason, retryAtMs },
                ...(state?.success === undefined
                  ? {}
                  : { success: state.success }),
              };
              outcome = {
                kind: "deferred",
                reason,
                retryAtMs,
                ...(!["temporary", "malformed"].includes(reason) ||
                previous === undefined
                  ? {}
                  : { stale: previous }),
              };
            }
            yield* Effect.tryPromise({
              try: () =>
                atomicWrite(
                  join(entry, `${generation}.json`),
                  JSON.stringify(completed),
                ),
              catch: coordinationUnavailable,
            });
            yield* Effect.promise(() =>
              removeSupersededGenerations(entry, generation).catch(
                () => undefined,
              ),
            );
            return outcome;
          }),
        ({ token, leaseHandle }) =>
          Effect.all([
            Effect.tryPromise(() => releaseLease(entry, token)),
            Effect.tryPromise(() => leaseHandle.close()),
          ]).pipe(
            Effect.catchAll(() => Effect.void),
            Effect.asVoid,
          ),
      );
    });

  return { coordinate };
}
