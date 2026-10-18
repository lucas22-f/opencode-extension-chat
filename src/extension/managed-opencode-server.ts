import {
  createOpencodeClient,
} from "@opencode-ai/sdk/v2/client";
import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { access, mkdir, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, posix, win32 } from "node:path";
import {
  ManagedServerLeaseError,
  acquireManagedServerLease,
  probeManagedServerEndpoint,
  type EndpointStatus,
  type ManagedServerLease,
  type ManagedServerLeaseRuntime,
} from "./managed-server-lease";

export const MANAGED_SERVER_STARTUP_TIMEOUT_MS = 15_000;
export const MANAGED_SERVER_SHUTDOWN_TIMEOUT_MS = 3_000;
const TASKKILL_TIMEOUT_MS = 2_000;
const MAX_STARTUP_OUTPUT_CHARS = 8_192;

export type ManagedServerShutdownMode = "graceful" | "owned-tree-fallback";

export class ManagedServerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedServerError";
  }
}

export interface ManagedServerHandle {
  readonly url: string | undefined;
  isRunning(): boolean;
  start(signal?: AbortSignal): Promise<string>;
  dispose(): Promise<void>;
}

interface ManagedServerRuntime {
  platform?: NodeJS.Platform;
  resolveWindowsExecutable?: () => Promise<string>;
  resolveTaskkillPath?: () => Promise<string>;
  acquireLease?: typeof acquireManagedServerLease;
  databasePath?: string;
  spawnProcess?: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => ChildProcess;
  terminateWindowsTree?: (
    child: ChildProcess,
    taskkillPath: string,
    timeoutMs: number,
  ) => void;
  requestInstanceDispose?: (
    serverUrl: string,
    directory: string,
    timeoutMs: number,
  ) => Promise<boolean>;
  probeEndpoint?: (
    serverUrl: string,
    timeoutMs: number,
  ) => Promise<EndpointStatus>;
  leaseStorageDirectory?: string;
  leaseRuntime?: ManagedServerLeaseRuntime;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

export class ManagedOpenCodeServer implements ManagedServerHandle {
  private readonly platform: NodeJS.Platform;
  private readonly startupTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private child: ChildProcess | undefined;
  private taskkillPath: string | undefined;
  private processStartPromise: Promise<string> | undefined;
  private processStopPromise: Promise<void> | undefined;
  private lease: ManagedServerLease | undefined;
  private hasStarted = false;
  private disposed = false;
  private listeningUrl: string | undefined;
  private lastShutdownMode: ManagedServerShutdownMode | undefined;

  constructor(
    private readonly cwd: string,
    private readonly runtime: ManagedServerRuntime = {},
  ) {
    this.platform = runtime.platform ?? process.platform;
    this.startupTimeoutMs =
      runtime.startupTimeoutMs ?? MANAGED_SERVER_STARTUP_TIMEOUT_MS;
    this.shutdownTimeoutMs =
      runtime.shutdownTimeoutMs ?? MANAGED_SERVER_SHUTDOWN_TIMEOUT_MS;
  }

  get url(): string | undefined {
    return this.listeningUrl;
  }

  get shutdownMode(): ManagedServerShutdownMode | undefined {
    return this.lastShutdownMode;
  }

  isRunning(): boolean {
    return this.child !== undefined && isChildRunning(this.child);
  }

  start(signal?: AbortSignal): Promise<string> {
    if (this.processStartPromise) return this.processStartPromise;
    if (this.hasStarted || this.disposed) {
      return Promise.reject(
        new ManagedServerError("This managed OpenCode server cannot be started again."),
      );
    }
    this.hasStarted = true;
    this.processStartPromise = this.startProcess(signal);
    return this.processStartPromise;
  }

  dispose(): Promise<void> {
    this.disposed = true;
    if (!this.processStopPromise) {
      this.processStopPromise = this.stopProcess().finally(() => {
        this.processStopPromise = undefined;
      });
    }
    return this.processStopPromise;
  }

  private async startProcess(signal?: AbortSignal): Promise<string> {
    const cwdIsAbsolute =
      this.platform === "win32"
        ? win32.isAbsolute(this.cwd)
        : posix.isAbsolute(this.cwd);
    if (!cwdIsAbsolute) {
      throw new ManagedServerError(
        "Managed OpenCode startup requires an absolute workspace directory.",
      );
    }
    if (!this.runtime.leaseStorageDirectory) {
      throw new ManagedServerError(
        "Managed OpenCode startup requires shared storage for its workspace lease.",
      );
    }
    const databasePath = this.runtime.databasePath;
    if (!databasePath || !isAbsolute(databasePath)) {
      throw new ManagedServerError(
        "Managed OpenCode startup requires an absolute extension-owned database path.",
      );
    }

    const windowsExecutable =
      this.platform === "win32"
        ? await (
            this.runtime.resolveWindowsExecutable ??
            resolveWindowsOpenCodeExecutable
          )()
        : undefined;
    if (signal?.aborted || this.disposed) {
      throw new ManagedServerError("Managed OpenCode startup was cancelled.");
    }

    if (this.platform === "win32") {
      this.taskkillPath = await (
        this.runtime.resolveTaskkillPath ?? resolveWindowsTaskkillPath
      )();
    }
    if (signal?.aborted || this.disposed) {
      throw new ManagedServerError("Managed OpenCode startup was cancelled.");
    }

    this.lease = await (this.runtime.acquireLease ?? acquireManagedServerLease)(
      this.runtime.leaseStorageDirectory,
      this.cwd,
      this.runtime.leaseRuntime,
    );
    if (signal?.aborted || this.disposed) {
      await this.releaseLease();
      throw new ManagedServerError("Managed OpenCode startup was cancelled.");
    }

    const args = [
      "serve",
      "--hostname=127.0.0.1",
      "--port=0",
      "--pure",
    ];
    const command = windowsExecutable ?? "opencode";
    let child: ChildProcess;
    try {
      await mkdir(dirname(databasePath), { recursive: true });
      child = (this.runtime.spawnProcess ?? spawn)(command, args, {
        cwd: this.cwd,
        env: getManagedServerEnvironment(this.platform, databasePath),
        shell: false,
        windowsHide: this.platform === "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      await this.releaseLease();
      throw error;
    }
    this.child = child;

    try {
      if (this.lease && child.pid !== undefined) {
        await this.lease.recordProcess(child.pid);
      }
      const url = await waitForListeningUrl(
        child,
        this.startupTimeoutMs,
        signal,
      );
      this.listeningUrl = url;
      await this.lease?.recordServerUrl(url);
      return url;
    } catch (error) {
      try {
        await this.dispose();
      } catch {
        throw new ManagedServerError(
          "Managed OpenCode startup failed, and the extension could not confirm cleanup of its owned process.",
        );
      }
      if (
        error instanceof ManagedServerError ||
        error instanceof ManagedServerLeaseError
      ) {
        throw error;
      }
      throw new ManagedServerError("Managed OpenCode failed before becoming ready.");
    }
  }

  private async stopProcess(): Promise<void> {
    const child = this.child;
    if (!child) {
      await this.releaseLease();
      return;
    }

    const serverUrl = this.listeningUrl;
    if (isChildRunning(child)) {
      const deadline = Date.now() + this.shutdownTimeoutMs;
      if (serverUrl) {
        try {
          await (this.runtime.requestInstanceDispose ?? requestInstanceDispose)(
            serverUrl,
            this.cwd,
            Math.max(1, deadline - Date.now()),
          );
        } catch {
          // Keep the owned process; the bounded wait decides whether fallback is safe.
        }
      }

      if (
        await waitForManagedShutdown(
          child,
          serverUrl,
          deadline,
          this.runtime.probeEndpoint ?? probeManagedServerEndpoint,
        )
      ) {
        await this.releaseLease();
        if (serverUrl) this.lastShutdownMode = "graceful";
        return;
      }
    }

    if (!isChildRunning(child)) {
      if (
        !(await waitForManagedShutdown(
          child,
          serverUrl,
          Date.now() + this.shutdownTimeoutMs,
          this.runtime.probeEndpoint ?? probeManagedServerEndpoint,
        ))
      ) {
        throw new ManagedServerError(
          "The owned process exited, but the managed server endpoint has not been confirmed stopped.",
        );
      }
      await this.releaseLease();
      if (serverUrl) this.lastShutdownMode = "graceful";
      return;
    }

    if (this.platform === "win32") {
      if (
        !this.taskkillPath ||
        !(await this.ownsWindowsProcess(child))
      ) {
        throw new ManagedServerError(
          "Windows shutdown is blocked because the live OpenCode process root is not verified as extension-owned.",
        );
      }

      try {
        this.lastShutdownMode = "owned-tree-fallback";
        (this.runtime.terminateWindowsTree ?? terminateWindowsProcessTree)(
          child,
          this.taskkillPath,
          TASKKILL_TIMEOUT_MS,
        );
      } catch {
        if (!isChildRunning(child)) {
          throw new ManagedServerError(
            "The owned OpenCode process exited during shutdown, so process-tree cleanup could not be confirmed.",
          );
        }
        throw new ManagedServerError(
          "Windows could not stop the extension-owned OpenCode process root.",
        );
      }

      if (
        !(await waitForManagedShutdown(
          child,
          serverUrl,
          Date.now() + this.shutdownTimeoutMs,
          this.runtime.probeEndpoint ?? probeManagedServerEndpoint,
        ))
      ) {
        throw new ManagedServerError(
          "Timed out waiting for the owned process tree and its server endpoint to stop.",
        );
      }
      await this.releaseLease();
      return;
    }

    this.lastShutdownMode = "owned-tree-fallback";
    child.kill("SIGTERM");
    if (
      await waitForManagedShutdown(
        child,
        serverUrl,
        Date.now() + this.shutdownTimeoutMs,
        this.runtime.probeEndpoint ?? probeManagedServerEndpoint,
      )
    ) {
      await this.releaseLease();
      return;
    }
    if (isChildRunning(child)) child.kill("SIGKILL");
    if (
      !(await waitForManagedShutdown(
        child,
        serverUrl,
        Date.now() + this.shutdownTimeoutMs,
        this.runtime.probeEndpoint ?? probeManagedServerEndpoint,
      ))
    ) {
      throw new ManagedServerError(
        "Timed out waiting for the extension-owned OpenCode process and server endpoint to stop.",
      );
    }
    await this.releaseLease();
  }

  private async ownsWindowsProcess(child: ChildProcess): Promise<boolean> {
    const lease = this.lease;
    if (
      !lease ||
      child !== this.child ||
      !Number.isSafeInteger(child.pid) ||
      !child.pid ||
      !isChildRunning(child)
    ) {
      return false;
    }
    return lease.ownsProcess(child.pid);
  }

  private async releaseLease(): Promise<void> {
    if (!this.lease) return;
    await this.lease.release();
    this.lease = undefined;
  }
}

export function parseListeningUrl(line: string): string | undefined {
  const match = /^opencode server listening on (https?:\/\/\S+)$/.exec(
    line.trim(),
  );
  if (!match?.[1]) return undefined;

  try {
    const url = new URL(match[1]);
    const port = Number(url.port);
    if (
      url.protocol !== "http:" ||
      url.hostname !== "127.0.0.1" ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65_535 ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

export function terminateWindowsProcessTree(
  child: ChildProcess,
  taskkillPath: string,
  timeoutMs: number,
  runTaskkill?: (
    executable: string,
    args: string[],
    options: {
      shell: false;
      windowsHide: true;
      stdio: "ignore";
      timeout: number;
    },
  ) => { status: number | null; error?: Error },
): void {
  if (!isChildRunning(child)) return;
  if (!Number.isSafeInteger(child.pid) || !child.pid || !win32.isAbsolute(taskkillPath)) {
    throw new ManagedServerError(
      "Windows process-tree termination requires the live owned process ID and an absolute taskkill path.",
    );
  }

  const args = ["/PID", String(child.pid), "/T", "/F"];
  const options = {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
      timeout: Math.min(timeoutMs, TASKKILL_TIMEOUT_MS),
    } as const;
  const result = runTaskkill
    ? runTaskkill(taskkillPath, args, options)
    : spawnSync(taskkillPath, args, options);
  if (result.error || result.status !== 0) {
    throw new ManagedServerError("Windows taskkill did not confirm process-tree termination.");
  }
}

export async function resolveWindowsOpenCodeExecutable(
  pathValue = process.env.Path ?? process.env.PATH ?? "",
): Promise<string> {
  for (const entry of pathValue.split(win32.delimiter)) {
    const directory = entry.replace(/^"(.*)"$/, "$1");
    if (!directory || !win32.isAbsolute(directory)) continue;
    try {
      const resolvedScript = await realpath(
        win32.join(directory, "opencode.ps1"),
      );
      const scriptDetails = await stat(resolvedScript);
      if (
        !scriptDetails.isFile() ||
        win32.extname(resolvedScript).toLowerCase() !== ".ps1"
      ) continue;

      const executable = win32.join(
        win32.dirname(resolvedScript),
        "node_modules",
        "opencode-ai",
        "bin",
        "opencode.exe",
      );
      const resolvedExecutable = await realpath(executable);
      const executableDetails = await stat(resolvedExecutable);
      if (
        win32.isAbsolute(resolvedExecutable) &&
        executableDetails.isFile() &&
        win32.extname(resolvedExecutable).toLowerCase() === ".exe"
      ) {
        return resolvedExecutable;
      }
    } catch {
      // Continue to the next PATH entry without exposing its contents.
    }
  }

  throw new ManagedServerError(
    "Could not resolve OpenCode's executable from an absolute PATH entry: no opencode.ps1 shim with an adjacent node_modules\\opencode-ai\\bin\\opencode.exe was found. Repair the OpenCode 1.19.0 installation or PATH; managed startup is blocked.",
  );
}

async function resolveWindowsTaskkillPath(): Promise<string> {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  if (!systemRoot || !win32.isAbsolute(systemRoot)) {
    throw new ManagedServerError("Could not resolve the Windows system directory for safe shutdown.");
  }
  const taskkillPath = win32.join(systemRoot, "System32", "taskkill.exe");
  try {
    await access(taskkillPath);
  } catch {
    throw new ManagedServerError("Windows taskkill.exe is unavailable; managed startup is blocked.");
  }
  return taskkillPath;
}

function getManagedServerEnvironment(
  platform: NodeJS.Platform,
  databasePath: string,
): NodeJS.ProcessEnv {
  const allowed = platform === "win32"
    ? new Set([
        "appdata",
        "comspec",
        "homedrive",
        "homepath",
        "localappdata",
        "path",
        "pathext",
        "programdata",
        "psmodulepath",
        "systemroot",
        "temp",
        "tmp",
        "userprofile",
        "windir",
      ])
    : new Set([
        "home",
        "lang",
        "lc_all",
        "no_color",
        "path",
        "term",
        "tmpdir",
        "xdg_cache_home",
        "xdg_config_home",
      ]);
  const environment: NodeJS.ProcessEnv = {};
  for (const key of Object.keys(process.env)) {
    if (!allowed.has(key.toLowerCase())) continue;
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  environment.OPENCODE_CONFIG_CONTENT = "{}";
  environment.OPENCODE_DB = databasePath;
  return environment;
}

function waitForListeningUrl(
  child: ChildProcess,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<string> {
  if (!child.stdout || !child.stderr) {
    return Promise.reject(
      new ManagedServerError("Managed OpenCode process output could not be captured safely."),
    );
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let output = "";
    let pendingLine = "";
    const timer = setTimeout(
      () => fail(new ManagedServerError("Timed out waiting for the OpenCode loopback listener.")),
      timeoutMs,
    );
    const cleanup = (): void => {
      clearTimeout(timer);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", discardOutput);
      child.off("error", onError);
      child.off("exit", onExit);
      signal?.removeEventListener("abort", onAbort);
    };
    const complete = (url: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(url);
    };
    const fail = (error: ManagedServerError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onStdout = (chunk: Buffer | string): void => {
      output = `${output}${chunk.toString()}`.slice(-MAX_STARTUP_OUTPUT_CHARS);
      pendingLine += chunk.toString();
      const lines = pendingLine.split(/\r?\n/);
      pendingLine = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.startsWith("opencode server listening")) continue;
        const url = parseListeningUrl(line);
        if (!url) {
          fail(new ManagedServerError("OpenCode reported a non-loopback or invalid listener URL."));
          return;
        }
        complete(url);
        return;
      }
      if (output.length >= MAX_STARTUP_OUTPUT_CHARS && pendingLine.length > MAX_STARTUP_OUTPUT_CHARS) {
        pendingLine = pendingLine.slice(-MAX_STARTUP_OUTPUT_CHARS);
      }
    };
    const discardOutput = (): void => undefined;
    const onError = (): void =>
      fail(new ManagedServerError("Could not launch the managed OpenCode process."));
    const onExit = (code: number | null): void =>
      fail(
        new ManagedServerError(
          code === null
            ? "The managed OpenCode process exited before it became ready."
            : `The managed OpenCode process exited with code ${code} before it became ready.`,
        ),
      );
    const onAbort = (): void =>
      fail(new ManagedServerError("Managed OpenCode startup was cancelled."));

    const stdout = child.stdout;
    const stderr = child.stderr;
    if (!stdout || !stderr) {
      fail(new ManagedServerError("Managed OpenCode process output could not be captured safely."));
      return;
    }
    stdout.on("data", onStdout);
    stderr.on("data", discardOutput);
    child.once("error", onError);
    child.once("exit", onExit);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function isChildRunning(child: ChildProcess): boolean {
  return (
    child.pid !== undefined &&
    child.exitCode === null &&
    child.signalCode === null
  );
}

async function requestInstanceDispose(
  serverUrl: string,
  directory: string,
  timeoutMs: number,
): Promise<boolean> {
  const client = createOpencodeClient({
    baseUrl: serverUrl,
    redirect: "error",
  });
  const result = await client.instance.dispose(
    { directory },
    { signal: AbortSignal.timeout(Math.max(1, timeoutMs)) },
  );
  return result.response?.status === 200 && result.error === undefined && result.data === true;
}

async function waitForManagedShutdown(
  child: ChildProcess,
  serverUrl: string | undefined,
  deadline: number,
  probeEndpoint: (serverUrl: string, timeoutMs: number) => Promise<EndpointStatus>,
): Promise<boolean> {
  while (true) {
    const remainingMs = Math.max(1, deadline - Date.now());
    const endpointStatus = serverUrl
      ? await probeEndpoint(serverUrl, Math.min(250, remainingMs))
      : "unavailable";
    if (!isChildRunning(child) && endpointStatus === "unavailable") return true;
    if (Date.now() >= deadline) return false;
    await delay(Math.min(50, deadline - Date.now()));
  }
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, timeoutMs)));
}
