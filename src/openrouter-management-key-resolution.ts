import { execFile } from "node:child_process";
import { Effect } from "effect";

const KEYRING_TIMEOUT_MS = 5_000;
const MAX_KEYRING_OUTPUT_BYTES = 4 * 1024;
const SECRET_TOOL_ARGUMENTS = [
  "lookup",
  "application",
  "pi-usage",
  "credential",
  "openrouter-management-key",
] as const;

declare const openRouterManagementKeyBrand: unique symbol;

export type OpenRouterManagementKey = string & {
  readonly [openRouterManagementKeyBrand]: true;
};

export type ResolveOpenRouterManagementKey = () => Effect.Effect<
  OpenRouterManagementKey | undefined
>;

interface ExecuteFileOptions {
  readonly signal: AbortSignal;
  readonly timeout: number;
  readonly maxBuffer: number;
}

interface ExecuteFileResult {
  readonly stdout: string;
}

type ExecuteFile = (
  file: string,
  args: ReadonlyArray<string>,
  options: ExecuteFileOptions,
) => Promise<ExecuteFileResult>;

export interface OpenRouterManagementKeyResolutionDependencies {
  readonly platform?: NodeJS.Platform;
  readonly environment?: () => NodeJS.ProcessEnv;
  readonly executeFile?: ExecuteFile;
}

function executeFile(
  file: string,
  args: ReadonlyArray<string>,
  options: ExecuteFileOptions,
): Promise<ExecuteFileResult> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      {
        encoding: "utf8",
        maxBuffer: options.maxBuffer,
        signal: options.signal,
        timeout: options.timeout,
      },
      (error, stdout) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve({ stdout });
      },
    );
  });
}

function managementKey(value: string | undefined) {
  const normalized = value?.trim();
  return normalized === undefined || normalized === ""
    ? undefined
    : (normalized as OpenRouterManagementKey);
}

export function createResolveOpenRouterManagementKey(
  dependencies: OpenRouterManagementKeyResolutionDependencies = {},
): ResolveOpenRouterManagementKey {
  const platform = dependencies.platform ?? process.platform;
  const environment = dependencies.environment ?? (() => process.env);
  const run = dependencies.executeFile ?? executeFile;

  return () => {
    if (platform !== "linux") {
      return Effect.succeed(
        managementKey(environment().OPENROUTER_MANAGEMENT_KEY),
      );
    }
    return Effect.tryPromise({
      try: (signal) =>
        run("secret-tool", SECRET_TOOL_ARGUMENTS, {
          signal,
          timeout: KEYRING_TIMEOUT_MS,
          maxBuffer: MAX_KEYRING_OUTPUT_BYTES,
        }),
      catch: () => undefined,
    }).pipe(
      Effect.match({
        onFailure: () => undefined,
        onSuccess: (result) => managementKey(result.stdout),
      }),
      Effect.map(
        (key) => key ?? managementKey(environment().OPENROUTER_MANAGEMENT_KEY),
      ),
    );
  };
}
