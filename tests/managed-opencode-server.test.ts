import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeOpenCodeHealth } from "../src/extension/opencode-connection";
import type { EndpointStatus, ManagedServerLeaseRuntime } from "../src/extension/managed-server-lease";
import {
  MANAGED_SERVER_SHUTDOWN_TIMEOUT_MS,
  MANAGED_SERVER_STARTUP_TIMEOUT_MS,
  ManagedOpenCodeServer,
  parseListeningUrl,
  resolveWindowsOpenCodeExecutable,
  terminateWindowsProcessTree,
} from "../src/extension/managed-opencode-server";

const OPENCODE_EXECUTABLE = "C:\\OpenCode Tools\\OpenCode ñ\\opencode.exe";
const TASKKILL_PATH = "C:\\Windows\\System32\\taskkill.exe";
const runRealCliSmoke = process.env.OPENCODE_VISUAL_MANAGED_SMOKE === "1";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

interface TestServerOptions {
  leaseStorageDirectory?: string;
  leaseRuntime?: ManagedServerLeaseRuntime;
  resolveWindowsExecutable?: () => Promise<string>;
  requestInstanceDispose?: (
    serverUrl: string,
    directory: string,
    timeoutMs: number,
  ) => Promise<boolean>;
  terminateWindowsTree?: (
    child: ChildProcess,
    taskkillPath: string,
    timeoutMs: number,
  ) => void;
  probeEndpoint?: (
    serverUrl: string,
    timeoutMs: number,
  ) => Promise<EndpointStatus>;
  spawnProcess?: (
    command: string,
    args: string[],
    options: SpawnOptions,
  ) => ChildProcess;
  startupTimeoutMs?: number;
  shutdownTimeoutMs?: number;
}

interface TestWorkspace {
  workspace: string;
  leaseStorageDirectory: string;
}

async function createTestWorkspace(): Promise<TestWorkspace> {
  const root = await mkdtemp(
    join(process.cwd(), ".opencode-visual-managed-test-ñ-"),
  );
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  temporaryDirectories.push(root);
  return {
    workspace,
    leaseStorageDirectory: join(root, "global-storage", "managed-server-leases"),
  };
}

describe("managed OpenCode process lifecycle", () => {
  it("parses only a reported HTTP URL bound to 127.0.0.1", () => {
    expect(
      parseListeningUrl(
        "opencode server listening on http://127.0.0.1:43123",
      ),
    ).toBe("http://127.0.0.1:43123");
    expect(
      parseListeningUrl(
        "opencode server listening on http://0.0.0.0:43123",
      ),
    ).toBeUndefined();
    expect(
      parseListeningUrl(
        "opencode server listening on https://127.0.0.1:43123",
      ),
    ).toBeUndefined();
    expect(
      parseListeningUrl("opencode server listening on http://127.0.0.1:0"),
    ).toBeUndefined();
  });

  it("refuses to spawn a managed server without shared workspace lease storage", async () => {
    const spawnProcess = vi.fn(
      (_command: string, _args: string[], _options: SpawnOptions) =>
        new FakeChildProcess(7313) as unknown as ChildProcess,
    );
    const server = new ManagedOpenCodeServer("C:\\workspace\\project", {
      platform: "win32",
      spawnProcess,
    });

    await expect(server.start()).rejects.toThrow(
      "shared storage for its workspace lease",
    );

    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("resolves the PATH shim to its direct executable and gracefully shuts it down", async () => {
    const environment = await createTestWorkspace();
    const shimDirectory = join(environment.workspace, "OpenCode shim ñ with spaces");
    const executablePath = join(
      shimDirectory,
      "node_modules",
      "opencode-ai",
      "bin",
      "opencode.exe",
    );
    await mkdir(dirname(executablePath), { recursive: true });
    await writeFile(join(shimDirectory, "opencode.ps1"), "shim fixture");
    await writeFile(executablePath, "executable fixture");
    const pathValue = `"${shimDirectory}"`;
    const resolvedExecutable = await resolveWindowsOpenCodeExecutable(pathValue);
    expect(resolvedExecutable).toBe(await realpath(executablePath));

    const child = new FakeChildProcess(7314);
    const spawnProcess = vi.fn(
      (_command: string, _args: string[], _options: SpawnOptions) =>
        child as unknown as ChildProcess,
    );
    const terminateTree = vi.fn(
      (_root: ChildProcess, _taskkillPath: string, _timeoutMs: number) => undefined,
    );
    const requestInstanceDispose = vi.fn(
      async (_serverUrl: string, _directory: string, _timeoutMs: number) => {
        exitChild(child as unknown as ChildProcess, 0);
        return true;
      },
    );
    const server = new ManagedOpenCodeServer(
      environment.workspace,
      {
        platform: "win32",
        resolveWindowsExecutable: () =>
          resolveWindowsOpenCodeExecutable(pathValue),
        resolveTaskkillPath: async () => TASKKILL_PATH,
        spawnProcess,
        terminateWindowsTree: terminateTree,
        requestInstanceDispose,
        probeEndpoint: async () => "unavailable",
        leaseStorageDirectory: environment.leaseStorageDirectory,
      },
    );

    const starting = server.start();
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce());
    child.stdout.write("opencode server listening on http://127.0.0.1:");
    child.stdout.write("43123\r\n");

    await expect(starting).resolves.toBe("http://127.0.0.1:43123");
    expect(spawnProcess).toHaveBeenCalledWith(
      resolvedExecutable,
      [
        "serve",
        "--hostname=127.0.0.1",
        "--port=0",
        "--pure",
      ],
      expect.objectContaining({
        cwd: environment.workspace,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    expect(resolvedExecutable).toContain("OpenCode shim ñ with spaces");
    expect(environment.workspace).toContain(" ");
    expect(environment.workspace).toContain("ñ");
    const processEnvironment = spawnProcess.mock.calls[0]?.[2].env;
    expect(processEnvironment?.OPENCODE_CONFIG_CONTENT).toBe("{}");
    expect(processEnvironment).not.toHaveProperty("OPENAI_API_KEY");
    expect(server.url).toBe("http://127.0.0.1:43123");
    expect(server.isRunning()).toBe(true);

    await server.dispose();

    expect(server.shutdownMode).toBe("graceful");
    expect(requestInstanceDispose).toHaveBeenCalledOnce();
    expect(requestInstanceDispose).toHaveBeenCalledWith(
      "http://127.0.0.1:43123",
      environment.workspace,
      expect.any(Number),
    );
    expect(requestInstanceDispose.mock.calls[0]?.[2]).toBeLessThanOrEqual(
      MANAGED_SERVER_SHUTDOWN_TIMEOUT_MS,
    );
    expect(terminateTree).not.toHaveBeenCalled();
    expect(await readdir(environment.leaseStorageDirectory)).toEqual([]);
    expect(server.isRunning()).toBe(false);
  });

  it("fails closed without the executable adjacent to the resolved PATH shim", async () => {
    const environment = await createTestWorkspace();
    const shimDirectory = join(environment.workspace, "OpenCode shim ñ with spaces");
    await mkdir(shimDirectory);
    await writeFile(join(shimDirectory, "opencode.ps1"), "shim fixture");
    const spawnProcess = vi.fn(
      (_command: string, _args: string[], _options: SpawnOptions) =>
        new FakeChildProcess(7330) as unknown as ChildProcess,
    );
    const server = new ManagedOpenCodeServer(environment.workspace, {
      platform: "win32",
      resolveWindowsExecutable: () =>
        resolveWindowsOpenCodeExecutable(`"${shimDirectory}"`),
      resolveTaskkillPath: async () => TASKKILL_PATH,
      spawnProcess,
      leaseStorageDirectory: environment.leaseStorageDirectory,
    });

    await expect(server.start()).rejects.toThrow(
      "Repair the OpenCode 1.19.0 installation or PATH",
    );

    expect(spawnProcess).not.toHaveBeenCalled();
    await expect(readdir(environment.leaseStorageDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("invokes the executable directly and uses SIGTERM after the disposal grace outside Windows", async () => {
    const environment = await createTestWorkspace();
    const child = new FakeChildProcess(7319);
    const spawnProcess = vi.fn(
      (_command: string, _args: string[], _options: SpawnOptions) =>
        child as unknown as ChildProcess,
    );
    const kill = vi.spyOn(child, "kill");
    const server = new ManagedOpenCodeServer("/", {
      platform: "linux",
      spawnProcess,
      leaseStorageDirectory: environment.leaseStorageDirectory,
      requestInstanceDispose: async () => false,
      probeEndpoint: async () =>
        child.exitCode === null && child.signalCode === null
          ? "available"
          : "unavailable",
      shutdownTimeoutMs: 50,
    });

    const starting = server.start();
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce());
    child.stdout.write("opencode server listening on http://127.0.0.1:43125\n");
    await expect(starting).resolves.toBe("http://127.0.0.1:43125");

    expect(spawnProcess).toHaveBeenCalledWith(
      "opencode",
      ["serve", "--hostname=127.0.0.1", "--port=0", "--pure"],
      expect.objectContaining({
        cwd: "/",
        shell: false,
      }),
    );

    await server.dispose();

    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(kill).toHaveBeenCalledOnce();
    expect(server.isRunning()).toBe(false);
  });

  it("stops a process whose reported URL is not a safe loopback listener", async () => {
    const environment = await createTestWorkspace();
    const child = new FakeChildProcess(7315);
    const terminateTree = vi.fn((root: ChildProcess) => exitChild(root, 0));
    const server = createServer(
      child,
      terminateTree,
      {
        leaseStorageDirectory: environment.leaseStorageDirectory,
        shutdownTimeoutMs: 15,
      },
      environment.workspace,
    );
    const starting = server.start();
    await vi.waitFor(() => expect(child.pid).toBe(7315));
    await vi.waitFor(() => expect(child.stdout.listenerCount("data")).toBeGreaterThan(0));
    child.stdout.write("opencode server listening on http://0.0.0.0:43124\n");

    await expect(starting).rejects.toThrow("non-loopback or invalid listener URL");

    expect(terminateTree).toHaveBeenCalledOnce();
    expect(server.isRunning()).toBe(false);
  });

  it("cleans up on a bounded startup timeout", async () => {
    const environment = await createTestWorkspace();
    const child = new FakeChildProcess(7316);
    const terminateTree = vi.fn((root: ChildProcess) => exitChild(root, 0));
    const server = createServer(
      child,
      terminateTree,
      {
        leaseStorageDirectory: environment.leaseStorageDirectory,
        startupTimeoutMs: 5,
        shutdownTimeoutMs: 15,
      },
      environment.workspace,
    );

    await expect(server.start()).rejects.toThrow("Timed out waiting");

    expect(terminateTree).toHaveBeenCalledOnce();
    expect(server.isRunning()).toBe(false);
  });

  it("reports a bounded shutdown timeout when the owned process tree does not exit", async () => {
    const environment = await createTestWorkspace();
    const child = new FakeChildProcess(7320);
    const terminateTree = vi.fn();
    let endpointStatus: EndpointStatus = "available";
    const requestInstanceDispose = vi.fn(async () => false);
    const server = createServer(
      child,
      terminateTree,
      {
        leaseStorageDirectory: environment.leaseStorageDirectory,
        requestInstanceDispose,
        probeEndpoint: async () => endpointStatus,
        shutdownTimeoutMs: 40,
      },
      environment.workspace,
    );
    const starting = server.start();
    await vi.waitFor(() => expect(child.stdout.listenerCount("data")).toBeGreaterThan(0));
    child.stdout.write("opencode server listening on http://127.0.0.1:43126\n");
    await starting;

    await expect(server.dispose()).rejects.toThrow("Timed out waiting");

    expect(requestInstanceDispose).toHaveBeenCalledOnce();
    expect(terminateTree).toHaveBeenCalledOnce();
    expect(terminateTree.mock.calls[0]?.[0]).toBe(child);
    expect(terminateTree.mock.calls[0]?.[1]).toBe(TASKKILL_PATH);
    expect(terminateTree.mock.calls[0]?.[2]).toBeLessThanOrEqual(2_000);
    expect(server.isRunning()).toBe(true);

    exitChild(child as unknown as ChildProcess, 0);
    endpointStatus = "unavailable";
    await expect(server.dispose()).resolves.toBeUndefined();
  });

  it("uses bounded taskkill only on the still-live lease-owned executable root", async () => {
    const environment = await createTestWorkspace();
    const child = new FakeChildProcess(7324);
    let disposeRequestedAt = 0;
    let taskkillAt = 0;
    let taskkillSawLiveOwnedRoot = false;
    const requestInstanceDispose = vi.fn(
      async (_serverUrl: string, _directory: string, _timeoutMs: number) => {
        disposeRequestedAt = Date.now();
        return false;
      },
    );
    const runTaskkill = vi.fn(
      (
        _executable: string,
        _args: string[],
        _options: { shell: false; windowsHide: true; stdio: "ignore"; timeout: number },
      ) => {
        taskkillAt = Date.now();
        taskkillSawLiveOwnedRoot =
          _args[1] === "7324" &&
          child.exitCode === null &&
          child.signalCode === null;
        exitChild(child as unknown as ChildProcess, 0);
        return { status: 0 };
      },
    );
    const terminateTree = vi.fn(
      (root: ChildProcess, taskkillPath: string, timeoutMs: number) =>
        terminateWindowsProcessTree(root, taskkillPath, timeoutMs, runTaskkill),
    );
    const server = createServer(
      child,
      terminateTree,
      {
        leaseStorageDirectory: environment.leaseStorageDirectory,
        requestInstanceDispose,
        probeEndpoint: async () =>
          child.exitCode === null ? "available" : "unavailable",
        shutdownTimeoutMs: 60,
      },
      environment.workspace,
    );
    const starting = server.start();
    await vi.waitFor(() => expect(child.stdout.listenerCount("data")).toBeGreaterThan(0));
    child.stdout.write("opencode server listening on http://127.0.0.1:43129\n");
    await starting;

    await server.dispose();

    expect(server.shutdownMode).toBe("owned-tree-fallback");
    expect(requestInstanceDispose).toHaveBeenCalledOnce();
    expect(requestInstanceDispose.mock.calls[0]?.[2]).toBeLessThanOrEqual(60);
    expect(terminateTree).toHaveBeenCalledOnce();
    expect(taskkillSawLiveOwnedRoot).toBe(true);
    expect(taskkillAt - disposeRequestedAt).toBeGreaterThanOrEqual(45);
    expect(runTaskkill).toHaveBeenCalledWith(
      TASKKILL_PATH,
      ["/PID", "7324", "/T", "/F"],
      expect.objectContaining({
        shell: false,
        windowsHide: true,
        stdio: "ignore",
        timeout: 2_000,
      }),
    );
    expect(await readdir(environment.leaseStorageDirectory)).toEqual([]);
    expect(server.isRunning()).toBe(false);
  });

  it("waits through the bounded grace before falling back when startup captured no URL", async () => {
    const environment = await createTestWorkspace();
    const child = new FakeChildProcess(7325);
    const terminateTree = vi.fn((root: ChildProcess) => exitChild(root, 0));
    const requestInstanceDispose = vi.fn(async () => false);
    let fallbackAt = 0;
    const server = createServer(
      child,
      (root, _taskkillPath, _timeoutMs) => {
        fallbackAt = Date.now();
        terminateTree(root);
      },
      {
        leaseStorageDirectory: environment.leaseStorageDirectory,
        startupTimeoutMs: 5,
        shutdownTimeoutMs: 40,
        requestInstanceDispose,
      },
      environment.workspace,
    );
    const startedAt = Date.now();

    await expect(server.start()).rejects.toThrow("Timed out waiting");

    expect(fallbackAt - startedAt).toBeGreaterThanOrEqual(35);
    expect(requestInstanceDispose).not.toHaveBeenCalled();
    expect(terminateTree).toHaveBeenCalledOnce();
    expect(server.shutdownMode).toBe("owned-tree-fallback");
    expect(await readdir(environment.leaseStorageDirectory)).toEqual([]);
  });

  it("does not taskkill a live root after its workspace lease ownership is lost", async () => {
    const environment = await createTestWorkspace();
    const child = new FakeChildProcess(7326);
    const terminateTree = vi.fn();
    const server = createServer(
      child,
      terminateTree,
      {
        leaseStorageDirectory: environment.leaseStorageDirectory,
        requestInstanceDispose: async () => false,
        probeEndpoint: async () => "available",
        shutdownTimeoutMs: 10,
      },
      environment.workspace,
    );
    const starting = server.start();
    await vi.waitFor(() => expect(child.stdout.listenerCount("data")).toBeGreaterThan(0));
    child.stdout.write("opencode server listening on http://127.0.0.1:43131\n");
    await starting;

    const [leaseName] = await readdir(environment.leaseStorageDirectory);
    expect(leaseName).toBeDefined();
    const leasePath = join(environment.leaseStorageDirectory, leaseName!);
    const lease = JSON.parse(await readFile(leasePath, "utf8")) as { nonce: string };
    await writeFile(leasePath, JSON.stringify({ ...lease, nonce: "foreign-owner" }));

    await expect(server.dispose()).rejects.toThrow("not verified as extension-owned");

    expect(terminateTree).not.toHaveBeenCalled();
    expect(server.isRunning()).toBe(true);
    exitChild(child as unknown as ChildProcess, 0);
  });

  it("never invokes taskkill after the owned root process has exited", async () => {
    const child = new FakeChildProcess(7317);
    const runTaskkill = vi.fn();
    child.exitCode = 0;

    terminateWindowsProcessTree(
      child as unknown as ChildProcess,
      TASKKILL_PATH,
      MANAGED_SERVER_SHUTDOWN_TIMEOUT_MS,
      runTaskkill,
    );

    expect(runTaskkill).not.toHaveBeenCalled();
  });

  it("never invokes taskkill when the root exited but its endpoint remains reachable", async () => {
    const environment = await createTestWorkspace();
    const child = new FakeChildProcess(7321);
    const terminateTree = vi.fn();
    const requestInstanceDispose = vi.fn(async () => true);
    const server = createServer(
      child,
      terminateTree,
      {
        leaseStorageDirectory: environment.leaseStorageDirectory,
        requestInstanceDispose,
        probeEndpoint: async () => "available",
        shutdownTimeoutMs: 10,
      },
      environment.workspace,
    );
    const starting = server.start();
    await vi.waitFor(() => expect(child.stdout.listenerCount("data")).toBeGreaterThan(0));
    child.stdout.write("opencode server listening on http://127.0.0.1:43127\n");
    await starting;
    exitChild(child as unknown as ChildProcess, 0);

    await expect(server.dispose()).rejects.toThrow("endpoint has not been confirmed stopped");

    expect(requestInstanceDispose).not.toHaveBeenCalled();
    expect(terminateTree).not.toHaveBeenCalled();
  });

  it("rejects a concurrent same-workspace manager instead of spawning or attaching", async () => {
    const environment = await createTestWorkspace();
    const child = new FakeChildProcess(7322);
    const spawnProcess = vi.fn(
      (_command: string, _args: string[], _options: SpawnOptions) =>
        child as unknown as ChildProcess,
    );
    const terminateTree = vi.fn(
      (_root: ChildProcess, _taskkillPath: string, _timeoutMs: number) => undefined,
    );
    const requestInstanceDispose = vi.fn(async () => {
      exitChild(child as unknown as ChildProcess, 0);
      return true;
    });
    const options: TestServerOptions = {
      leaseStorageDirectory: environment.leaseStorageDirectory,
      spawnProcess,
      terminateWindowsTree: terminateTree,
      requestInstanceDispose,
      probeEndpoint: async () => "unavailable",
    };
    const servers = [
      createServer(child, terminateTree, options, environment.workspace),
      createServer(child, terminateTree, options, environment.workspace),
    ];
    const starts = servers.map((server) => server.start());
    const outcomesPromise = Promise.allSettled(starts);

    const readiness = await Promise.race([
      outcomesPromise.then((outcomes) => ({ kind: "settled" as const, outcomes })),
      vi
        .waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce())
        .then(() => ({ kind: "spawned" as const })),
    ]);
    if (readiness.kind === "settled") {
      throw new Error(
        `Managed starts settled before spawning: ${readiness.outcomes
          .map((outcome) =>
            outcome.status === "rejected" ? String(outcome.reason) : "fulfilled",
          )
          .join("; ")}`,
      );
    }
    child.stdout.write("opencode server listening on http://127.0.0.1:43128\n");
    const outcomes = await outcomesPromise;

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(outcomes.find((outcome) => outcome.status === "rejected")).toMatchObject({
      reason: expect.objectContaining({
        message: expect.stringContaining("Another extension host is starting or owns"),
      }),
    });
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect(servers.filter((server) => server.isRunning())).toHaveLength(1);
    expect(servers.find((server) => !server.isRunning())?.url).toBeUndefined();

    await servers.find((server) => server.isRunning())?.dispose();
    expect(requestInstanceDispose).toHaveBeenCalledOnce();
    expect(terminateTree).not.toHaveBeenCalled();
  });

  it("uses bounded startup and shutdown limits", () => {
    expect(MANAGED_SERVER_STARTUP_TIMEOUT_MS).toBeGreaterThan(0);
    expect(MANAGED_SERVER_STARTUP_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    expect(MANAGED_SERVER_SHUTDOWN_TIMEOUT_MS).toBeGreaterThan(0);
    expect(MANAGED_SERVER_SHUTDOWN_TIMEOUT_MS).toBeLessThanOrEqual(5_000);
  });

  it.skipIf(!runRealCliSmoke)(
    "real installed CLI smoke: starts, health-checks, and stops only the owned server",
    async () => {
      expect(process.platform).toBe("win32");
      const temporaryRoot = await mkdtemp(
        join(process.cwd(), ".opencode-visual-managed-smoke-"),
      );
      const workspace = join(temporaryRoot, "workspace");
      const leaseStorageDirectory = join(
        temporaryRoot,
        "global-storage",
        "managed-server-leases",
      );
      await mkdir(workspace);
      let fallbackUsed = false;
      const server = new ManagedOpenCodeServer(workspace, {
        leaseStorageDirectory,
        terminateWindowsTree: (child, taskkillPath, timeoutMs) => {
          fallbackUsed = true;
          terminateWindowsProcessTree(child, taskkillPath, timeoutMs);
        },
      });
      let serverUrl: string | undefined;

      try {
        serverUrl = await server.start();
        expect(serverUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        await expect(
          probeOpenCodeHealth(serverUrl, {
            directory: workspace,
            timeoutMs: 4_000,
          }),
        ).resolves.toEqual({ kind: "healthy", version: "1.19.0" });

        await server.dispose();
        expect(server.isRunning()).toBe(false);
        expect(server.shutdownMode).toBe(
          fallbackUsed ? "owned-tree-fallback" : "graceful",
        );
        await expect(
          probeOpenCodeHealth(serverUrl, { timeoutMs: 500 }),
        ).resolves.toEqual({ kind: "unreachable" });
        expect(await readdir(leaseStorageDirectory)).toEqual([]);
        process.stdout.write(`SMOKE_SHUTDOWN=${server.shutdownMode}\n`);
      } finally {
        try {
          await server.dispose();
        } finally {
          await rm(temporaryRoot, { recursive: true, force: true });
        }
      }
    },
  );
});

function createServer(
  child: FakeChildProcess,
  terminateTree: (
    child: ChildProcess,
    taskkillPath: string,
    timeoutMs: number,
  ) => void,
  options: TestServerOptions = {},
  cwd = "C:\\workspace\\project",
): ManagedOpenCodeServer {
  return new ManagedOpenCodeServer(cwd, {
    platform: "win32",
    resolveWindowsExecutable: async () => OPENCODE_EXECUTABLE,
    resolveTaskkillPath: async () => TASKKILL_PATH,
    spawnProcess: () => child as unknown as ChildProcess,
    terminateWindowsTree: (root, taskkillPath, timeoutMs) =>
      terminateTree(root, taskkillPath, timeoutMs),
    ...options,
  });
}

function exitChild(child: ChildProcess, code: number): void {
  Object.assign(child, { exitCode: code });
  child.emit("exit", code, null);
  child.stdout?.emit("end");
  child.stderr?.emit("end");
}

class FakeChildProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();

  constructor(readonly pid: number) {
    super();
  }

  kill(signal?: NodeJS.Signals): boolean {
    queueMicrotask(() => {
      this.exitCode = null;
      this.signalCode = signal ?? "SIGTERM";
      this.emit("exit", null, this.signalCode);
    });
    return true;
  }
}
