import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { PassThrough } from "node:stream";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { basename, dirname, isAbsolute, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OpenCodeConnection,
  probeOpenCodeHealth,
} from "../src/extension/opencode-connection";
import {
  ManagedServerLeaseError,
  acquireManagedServerLease,
  type EndpointStatus,
  type ManagedServerLease,
  type ManagedServerLeaseRuntime,
  type ProcessStatus,
} from "../src/extension/managed-server-lease";
import {
  MANAGED_SERVER_SHUTDOWN_TIMEOUT_MS,
  MANAGED_SERVER_STARTUP_TIMEOUT_MS,
  ManagedOpenCodeServer,
  parseListeningUrl,
  resolveWindowsOpenCodeExecutable,
  terminateWindowsProcessTree,
} from "../src/extension/managed-opencode-server";

const posixRealpathState = vi.hoisted(() => ({
  actualRealpath: undefined as ((path: string) => Promise<string>) | undefined,
  delegate: undefined as ((path: string) => Promise<string>) | undefined,
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  posixRealpathState.actualRealpath = actual.realpath;
  return {
    ...actual,
    realpath: (path: string) =>
      posixRealpathState.delegate
        ? posixRealpathState.delegate(path)
        : actual.realpath(path),
  };
});

const nodeReadFileSyncState = vi.hoisted(() => ({
  actualReadFileSync: undefined as
    | ((path: string, options?: unknown) => unknown)
    | undefined,
  delegate: undefined as
    | ((path: string, options?: unknown) => unknown)
    | undefined,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  nodeReadFileSyncState.actualReadFileSync =
    actual.readFileSync as unknown as (
      path: string,
      options?: unknown,
    ) => unknown;
  return {
    ...actual,
    readFileSync: ((path: string, options?: unknown) =>
      nodeReadFileSyncState.delegate
        ? nodeReadFileSyncState.delegate(path, options)
        : nodeReadFileSyncState.actualReadFileSync?.(path, options)) as unknown as typeof actual.readFileSync,
  };
});

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

interface PosixFailClosedCase {
  name: string;
  canonicalPaths: Record<string, string>;
  failingPaths: string[];
  pathValue: string | undefined;
}

interface TestServerOptions {
  leaseStorageDirectory?: string;
  databasePath?: string;
  leaseRuntime?: ManagedServerLeaseRuntime;
  acquireLease?: typeof acquireManagedServerLease;
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
  databasePath: string;
}

async function createTestWorkspace(): Promise<TestWorkspace> {
  const root = await mkdtemp(
    join(process.cwd(), ".opencode-visual-managed-test-ñ-"),
  );
  temporaryDirectories.push(root);
  const workspace = join(root, "workspace");
  const globalStorageDirectory = join(root, "global-storage");
  await mkdir(workspace);
  return {
    workspace,
    leaseStorageDirectory: join(globalStorageDirectory, "managed-server-leases"),
    databasePath: join(globalStorageDirectory, "managed-opencode", "opencode.db"),
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

  it("passes the extension-owned absolute database path to the managed child", async () => {
    const environment = await createTestWorkspace();
    const child = new FakeChildProcess(7332);
    const originalEnvironment = process.env;
    const disallowedKey = `OPENCODE_VISUAL_DISALLOWED_TEST_${process.pid}`;
    const readDisallowedValue = vi.fn(() => "synthetic test value");
    process.env = new Proxy(originalEnvironment, {
      ownKeys(target) {
        return [...new Set([...Reflect.ownKeys(target), disallowedKey])];
      },
      getOwnPropertyDescriptor(target, property) {
        if (property === disallowedKey) {
          return { configurable: true, enumerable: true };
        }
        return Reflect.getOwnPropertyDescriptor(target, property);
      },
      get(target, property, receiver) {
        if (property === disallowedKey) return readDisallowedValue();
        return Reflect.get(target, property, receiver);
      },
    });
    const spawnProcess = vi.fn(
      (_command: string, _args: string[], _options: SpawnOptions) => {
        expect(_options.env?.OPENCODE_DB).toBe(environment.databasePath);
        expect(existsSync(dirname(environment.databasePath))).toBe(true);
        return child as unknown as ChildProcess;
      },
    );
    const server = new ManagedOpenCodeServer(environment.workspace, {
      platform: "win32",
      resolveWindowsExecutable: async () => OPENCODE_EXECUTABLE,
      resolveTaskkillPath: async () => TASKKILL_PATH,
      leaseStorageDirectory: environment.leaseStorageDirectory,
      databasePath: environment.databasePath,
      spawnProcess,
      requestInstanceDispose: async () => {
        exitChild(child as unknown as ChildProcess, 0);
        return true;
      },
      probeEndpoint: async () => "unavailable",
    });
    const starting = server.start();

    try {
      await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce());
      expect(isAbsolute(environment.databasePath)).toBe(true);
      expect(environment.databasePath).toBe(
        join(
          dirname(environment.leaseStorageDirectory),
          "managed-opencode",
          "opencode.db",
        ),
      );
      await expect(access(dirname(environment.databasePath))).resolves.toBeUndefined();
      child.stdout.write("opencode server listening on http://127.0.0.1:43122\n");
      await expect(starting).resolves.toBe("http://127.0.0.1:43122");

      const processEnvironment = spawnProcess.mock.calls[0]?.[2].env;
      expect(processEnvironment?.OPENCODE_DB).toBe(environment.databasePath);
      expect(processEnvironment?.OPENCODE_CONFIG_CONTENT).toBe("{}");
      expect(processEnvironment).not.toHaveProperty("OPENAI_API_KEY");
      expect(processEnvironment).not.toHaveProperty(disallowedKey);
      expect(readDisallowedValue).not.toHaveBeenCalled();

      await server.dispose();
    } finally {
      process.env = originalEnvironment;
    }
  });

  it("keeps an explicitly configured external attachment out of managed startup", async () => {
    const databasePath = join(
      process.cwd(),
      "extension-global-storage",
      "managed-opencode",
      "opencode.db",
    );
    const spawnProcess = vi.fn(
      (_command: string, _args: string[], _options: SpawnOptions) => {
        throw new Error("External attachment must not launch a managed child.");
      },
    );
    const managedFactory = vi.fn(
      (directory: string) =>
        new ManagedOpenCodeServer(directory, {
          databasePath,
          leaseStorageDirectory: join(
            process.cwd(),
            "extension-global-storage",
            "managed-server-leases",
          ),
          spawnProcess,
        }),
    );
    const connection = new OpenCodeConnection(
      async () => ({ kind: "healthy", version: "1.19.0" }),
      managedFactory,
    );

    const state = await connection.connect("https://opencode.example:4096");

    expect(state).toMatchObject({ status: "connected", owner: "attached" });
    expect(managedFactory).not.toHaveBeenCalled();
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("does not spawn or leak a lease when disposed during lease acquisition", async () => {
    const environment = await createTestWorkspace();
    let continueAcquire!: () => void;
    const acquireGate = new Promise<void>((resolve) => {
      continueAcquire = resolve;
    });
    const acquireLease = vi.fn(
      async (
        storageDirectory: string,
        workspaceDirectory: string,
        leaseRuntime?: ManagedServerLeaseRuntime,
      ) => {
        await acquireGate;
        return acquireManagedServerLease(
          storageDirectory,
          workspaceDirectory,
          leaseRuntime,
        );
      },
    );
    const spawnProcess = vi.fn(
      (_command: string, _args: string[], _options: SpawnOptions) =>
        new FakeChildProcess(7331) as unknown as ChildProcess,
    );
    const server = new ManagedOpenCodeServer(environment.workspace, {
      platform: "win32",
      resolveWindowsExecutable: async () => OPENCODE_EXECUTABLE,
      resolveTaskkillPath: async () => TASKKILL_PATH,
      acquireLease,
      leaseStorageDirectory: environment.leaseStorageDirectory,
      databasePath: environment.databasePath,
      spawnProcess,
    });
    const starting = server.start();

    await vi.waitFor(() => expect(acquireLease).toHaveBeenCalledOnce());
    await server.dispose();
    continueAcquire();

    await expect(starting).rejects.toThrow("Managed OpenCode startup was cancelled");
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(await readdir(environment.leaseStorageDirectory)).toEqual([]);
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
        databasePath: environment.databasePath,
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

  it("starts from an adopted orphaned server lease without spawning a replacement", async () => {
    const environment = await createTestWorkspace();
    const adoptedUrl = "http://127.0.0.1:43210";
    const adoptedPid = 4321;
    const adoptedLease: ManagedServerLease = {
      path: join(environment.leaseStorageDirectory, "adopted.lease"),
      adopted: { processPid: adoptedPid, serverUrl: adoptedUrl },
      recordProcess: vi.fn(async () => {}),
      recordServerUrl: vi.fn(async () => {}),
      ownsProcess: vi.fn(async (pid: number) => pid === adoptedPid),
      release: vi.fn(async () => {}),
    };
    const spawnProcess = vi.fn(
      (_command: string, _args: string[], _options: SpawnOptions) =>
        new FakeChildProcess(7325) as unknown as ChildProcess,
    );
    const terminateTree = vi.fn();
    const terminateOrphan = vi.fn();
    const requestInstanceDispose = vi.fn(async () => true);
    const server = new ManagedOpenCodeServer(environment.workspace, {
      platform: "win32",
      resolveWindowsExecutable: async () => OPENCODE_EXECUTABLE,
      resolveTaskkillPath: async () => TASKKILL_PATH,
      spawnProcess,
      terminateWindowsTree: (
        _root: ChildProcess,
        _taskkillPath: string,
        _timeoutMs: number,
      ) => terminateTree(),
      terminateWindowsOrphan: (
        _pid: number,
        _taskkillPath: string,
        _timeoutMs: number,
      ) => terminateOrphan(),
      requestInstanceDispose,
      probeEndpoint: async () => "unavailable",
      acquireLease: async () => adoptedLease,
      leaseStorageDirectory: environment.leaseStorageDirectory,
      databasePath: environment.databasePath,
    });

    await expect(server.start()).resolves.toBe(adoptedUrl);

    expect(spawnProcess).not.toHaveBeenCalled();
    expect(adoptedLease.recordProcess).not.toHaveBeenCalled();
    expect(adoptedLease.recordServerUrl).not.toHaveBeenCalled();
    expect(server.url).toBe(adoptedUrl);
    expect(server.isRunning()).toBe(true);

    await server.dispose();

    expect(requestInstanceDispose).toHaveBeenCalledOnce();
    expect(requestInstanceDispose).toHaveBeenCalledWith(
      adoptedUrl,
      environment.workspace,
      expect.any(Number),
    );
    expect(server.shutdownMode).toBe("graceful");
    expect(terminateTree).not.toHaveBeenCalled();
    expect(terminateOrphan).not.toHaveBeenCalled();
    expect(adoptedLease.release).toHaveBeenCalledOnce();
    expect(server.isRunning()).toBe(false);
  });

  it.each([
    { verified: true, name: "verifies" },
    { verified: false, name: "fails closed on" },
  ] as const)("$name the orphan process image before heal-killing a lease-recorded PID on Windows", async ({ verified }) => {
    const environment = await createTestWorkspace();
    const hostPid = process.pid + 220_000;
    const recordedPid = 4324;
    const orphanUrl = "http://127.0.0.1:43215";
    const probeLease = await acquireManagedServerLease(environment.leaseStorageDirectory, environment.workspace);
    const leasePath = probeLease.path;
    await probeLease.release();
    await writeFile(leasePath, JSON.stringify({ nonce: "orphan-heal-owner", hostPid, createdAt: Date.now() - 60_000, processPid: recordedPid, serverUrl: orphanUrl }), "utf8");

    const verifyOrphanProcessImage = vi.fn(async () => verified),
      terminateOrphan = vi.fn();
    const server = new ManagedOpenCodeServer(environment.workspace, {
      platform: "win32",
      resolveWindowsExecutable: async () => OPENCODE_EXECUTABLE,
      resolveTaskkillPath: async () => TASKKILL_PATH,
      spawnProcess: vi.fn(() => {
        const child = new FakeChildProcess(recordedPid);
        child.stdout.write(`opencode server listening on ${orphanUrl}\n`);
        return child as unknown as ChildProcess;
      }),
      verifyOrphanProcessImage,
      terminateWindowsOrphan: (pid: number) => terminateOrphan(pid),
      acquireLease: acquireManagedServerLease,
      leaseRuntime: {
        processStatus: (pid: number): ProcessStatus => (pid === hostPid ? "gone" : pid === recordedPid ? "alive" : "unknown"),
        endpointStatus: async () => "unavailable" as const,
      },
      leaseStorageDirectory: environment.leaseStorageDirectory,
      databasePath: environment.databasePath,
    });

    if (verified) {
      await expect(server.start()).resolves.toBe(orphanUrl);
      expect(verifyOrphanProcessImage).toHaveBeenCalledWith(recordedPid, "opencode.exe");
      expect(terminateOrphan).toHaveBeenCalledExactlyOnceWith(recordedPid);
      return;
    }
    await expect(server.start()).rejects.toThrow("could not be verified as the extension's OpenCode executable");
    expect(terminateOrphan).not.toHaveBeenCalled();
  });

  it("falls back to PID-verified Windows termination when an adopted server will not stop gracefully", async () => {
    const environment = await createTestWorkspace();
    const adoptedUrl = "http://127.0.0.1:43211";
    const adoptedPid = 4322;
    let orphanTerminated = false;
    const adoptedLease: ManagedServerLease = {
      path: join(environment.leaseStorageDirectory, "adopted.lease"),
      adopted: { processPid: adoptedPid, serverUrl: adoptedUrl },
      recordProcess: vi.fn(async () => {}),
      recordServerUrl: vi.fn(async () => {}),
      ownsProcess: vi.fn(async (pid: number) => pid === adoptedPid),
      release: vi.fn(async () => {}),
    };
    const terminateOrphan = vi.fn(
      (_pid: number, _taskkillPath: string, _timeoutMs: number) => {
        orphanTerminated = true;
      },
    );
    const verifyOrphanProcessImage = vi.fn(async () => true);
    const server = new ManagedOpenCodeServer(environment.workspace, {
      platform: "win32",
      resolveWindowsExecutable: async () => OPENCODE_EXECUTABLE,
      resolveTaskkillPath: async () => TASKKILL_PATH,
      spawnProcess: vi.fn(),
      terminateWindowsTree: vi.fn(),
      terminateWindowsOrphan: (
        pid: number,
        taskkillPath: string,
        timeoutMs: number,
      ) => terminateOrphan(pid, taskkillPath, timeoutMs),
      verifyOrphanProcessImage,
      requestInstanceDispose: vi.fn(async () => false),
      probeEndpoint: async () =>
        orphanTerminated ? ("unavailable" as const) : ("available" as const),
      acquireLease: async () => adoptedLease,
      leaseStorageDirectory: environment.leaseStorageDirectory,
      databasePath: environment.databasePath,
      shutdownTimeoutMs: 60,
    });

    await expect(server.start()).resolves.toBe(adoptedUrl);
    await server.dispose();

    expect(server.shutdownMode).toBe("owned-tree-fallback");
    expect(verifyOrphanProcessImage).toHaveBeenCalledWith(adoptedPid, "opencode.exe");
    expect(terminateOrphan).toHaveBeenCalledExactlyOnceWith(
      adoptedPid,
      TASKKILL_PATH,
      expect.any(Number),
    );
    expect(terminateOrphan.mock.calls[0]?.[2]).toBeLessThanOrEqual(
      MANAGED_SERVER_SHUTDOWN_TIMEOUT_MS,
    );
    expect(adoptedLease.ownsProcess).toHaveBeenCalledWith(adoptedPid);
    expect(adoptedLease.release).toHaveBeenCalledOnce();
    expect(server.isRunning()).toBe(false);
  });

  it("stops an adopted server on POSIX with PID-verified signals when graceful disposal fails", async () => {
    const environment = await createTestWorkspace();
    const adoptedUrl = "http://127.0.0.1:43212";
    const adoptedPid = 4323;
    let orphanTerminated = false;
    const adoptedLease: ManagedServerLease = {
      path: join(environment.leaseStorageDirectory, "adopted.lease"),
      adopted: { processPid: adoptedPid, serverUrl: adoptedUrl },
      recordProcess: vi.fn(async () => {}),
      recordServerUrl: vi.fn(async () => {}),
      ownsProcess: vi.fn(async (pid: number) => pid === adoptedPid),
      release: vi.fn(async () => {}),
    };
    const verifyOrphanProcessImage = vi.fn(async () => true);
    const processKill = vi
      .spyOn(process, "kill")
      .mockImplementation((() => {
        orphanTerminated = true;
        return true;
      }) as typeof process.kill);
    try {
      const server = new ManagedOpenCodeServer("/workspace/project", {
        platform: "linux",
        spawnProcess: vi.fn(),
        verifyOrphanProcessImage,
        requestInstanceDispose: vi.fn(async () => false),
        probeEndpoint: async () =>
          orphanTerminated ? ("unavailable" as const) : ("available" as const),
        acquireLease: async () => adoptedLease,
        leaseStorageDirectory: environment.leaseStorageDirectory,
        databasePath: environment.databasePath,
        shutdownTimeoutMs: 60,
      });

      await expect(server.start()).resolves.toBe(adoptedUrl);
      await server.dispose();

      expect(server.shutdownMode).toBe("owned-tree-fallback");
      expect(verifyOrphanProcessImage).toHaveBeenCalledWith(adoptedPid, "opencode");
      expect(processKill).toHaveBeenCalledExactlyOnceWith(adoptedPid, "SIGTERM");
      expect(adoptedLease.ownsProcess).toHaveBeenCalledWith(adoptedPid);
      expect(adoptedLease.release).toHaveBeenCalledOnce();
      expect(server.isRunning()).toBe(false);
    } finally {
      processKill.mockRestore();
    }
  });

  it("heal-kills a POSIX orphan only after its /proc exe canonicalizes to the PATH-resolved opencode executable", async () => {
    const environment = await createTestWorkspace();
    const orphanUrl = "http://127.0.0.1:43218";
    const hostPid = process.pid + 230_000;
    const recordedPid = 4326;
    const canonicalOpencode = "/opt/opencode-1.19.0/bin/opencode";
    const canonicalRealpath = stubCanonicalRealpath({
      "/workspace/project": "/workspace/project",
      [`/proc/${recordedPid}/exe`]: canonicalOpencode,
      "/usr/local/bin/opencode": canonicalOpencode,
    });
    const restorePath = stubEnvPath("/usr/local/bin");
    const probeLease = await acquireManagedServerLease(
      environment.leaseStorageDirectory,
      "/workspace/project",
    );
    const leasePath = probeLease.path;
    await probeLease.release();
    await writeFile(
      leasePath,
      JSON.stringify({
        nonce: "posix-orphan-heal-owner",
        hostPid,
        createdAt: Date.now() - 60_000,
        processPid: recordedPid,
        serverUrl: orphanUrl,
      }),
      "utf8",
    );
    const child = new FakeChildProcess(recordedPid);
    const spawnProcess = vi.fn(
      (_command: string, _args: string[], _options: SpawnOptions) => {
        child.stdout.write(`opencode server listening on ${orphanUrl}\n`);
        return child as unknown as ChildProcess;
      },
    );
    const processKill = vi
      .spyOn(process, "kill")
      .mockImplementation((() => true) as typeof process.kill);
    try {
      const server = new ManagedOpenCodeServer("/workspace/project", {
        platform: "linux",
        spawnProcess,
        acquireLease: acquireManagedServerLease,
        leaseRuntime: {
          processStatus: (pid: number): ProcessStatus =>
            pid === hostPid
              ? "gone"
              : pid === recordedPid
                ? "alive"
                : "unknown",
          endpointStatus: async () => "unavailable" as const,
        },
        leaseStorageDirectory: environment.leaseStorageDirectory,
        databasePath: environment.databasePath,
        requestInstanceDispose: async () => false,
        probeEndpoint: async () =>
          child.exitCode === null && child.signalCode === null
            ? ("available" as const)
            : ("unavailable" as const),
        shutdownTimeoutMs: 50,
      });

      await expect(server.start()).resolves.toBe(orphanUrl);

      expect(processKill).toHaveBeenCalledExactlyOnceWith(
        recordedPid,
        "SIGTERM",
      );
      expect(canonicalRealpath.realpath).toHaveBeenCalledWith(
        `/proc/${recordedPid}/exe`,
      );
      expect(canonicalRealpath.realpath).toHaveBeenCalledWith(
        "/usr/local/bin/opencode",
      );
      expect(canonicalRealpath.realpath).not.toHaveBeenCalledWith(
        `/proc/${recordedPid}/cmdline`,
      );

      await server.dispose();

      expect(server.isRunning()).toBe(false);
      expect(await readdir(environment.leaseStorageDirectory)).toEqual([]);
    } finally {
      processKill.mockRestore();
      canonicalRealpath.restore();
      restorePath();
    }
  });

  it("fails closed on a POSIX orphan with an unrelated executable, even when its argv mentions opencode", async () => {
    const environment = await createTestWorkspace();
    const orphanUrl = "http://127.0.0.1:43219";
    const hostPid = process.pid + 240_000;
    const recordedPid = 4327;
    const canonicalOpencode = "/opt/opencode-1.19.0/bin/opencode";
    // An editor opening an opencode-named file satisfied the old cmdline
    // substring check; the exact canonical executable comparison must not.
    const cmdlineStub = stubProcCmdline(
      recordedPid,
      "vim\0/home/user/notes/opencode.md\0",
    );
    const canonicalRealpath = stubCanonicalRealpath({
      "/workspace/project": "/workspace/project",
      [`/proc/${recordedPid}/exe`]: "/usr/bin/vim",
      "/usr/local/bin/opencode": canonicalOpencode,
    });
    const restorePath = stubEnvPath("/usr/local/bin");
    const probeLease = await acquireManagedServerLease(
      environment.leaseStorageDirectory,
      "/workspace/project",
    );
    const leasePath = probeLease.path;
    await probeLease.release();
    await writeFile(
      leasePath,
      JSON.stringify({
        nonce: "posix-unrelated-exe-owner",
        hostPid,
        createdAt: Date.now() - 60_000,
        processPid: recordedPid,
        serverUrl: orphanUrl,
      }),
      "utf8",
    );
    const child = new FakeChildProcess(recordedPid);
    const spawnProcess = vi.fn(
      (_command: string, _args: string[], _options: SpawnOptions) => {
        child.stdout.write(`opencode server listening on ${orphanUrl}\n`);
        return child as unknown as ChildProcess;
      },
    );
    const processKill = vi
      .spyOn(process, "kill")
      .mockImplementation((() => true) as typeof process.kill);
    try {
      const server = new ManagedOpenCodeServer("/workspace/project", {
        platform: "linux",
        spawnProcess,
        acquireLease: acquireManagedServerLease,
        leaseRuntime: {
          processStatus: (pid: number): ProcessStatus =>
            pid === hostPid
              ? "gone"
              : pid === recordedPid
                ? "alive"
                : "unknown",
          endpointStatus: async () => "unavailable" as const,
        },
        leaseStorageDirectory: environment.leaseStorageDirectory,
        databasePath: environment.databasePath,
      });

      await expect(server.start()).rejects.toThrow(
        "could not be verified as the extension's OpenCode executable",
      );

      expect(processKill).not.toHaveBeenCalled();
      expect(canonicalRealpath.realpath).toHaveBeenCalledWith(
        `/proc/${recordedPid}/exe`,
      );
      expect(canonicalRealpath.realpath).toHaveBeenCalledWith(
        "/usr/local/bin/opencode",
      );
      expect(cmdlineStub.readFileSync).not.toHaveBeenCalledWith(
        `/proc/${recordedPid}/cmdline`,
        "utf8",
      );
      expect(server.isRunning()).toBe(false);
      expect(await readdir(environment.leaseStorageDirectory)).toEqual([
        basename(leasePath),
      ]);
      const survivingRecord = JSON.parse(
        await readFile(leasePath, "utf8"),
      ) as { processPid: number };
      expect(survivingRecord.processPid).toBe(recordedPid);
    } finally {
      processKill.mockRestore();
      canonicalRealpath.restore();
      cmdlineStub.restore();
      restorePath();
    }
  });

  it.each<PosixFailClosedCase>([
    {
      name: "fails closed when POSIX procfs is unavailable",
      canonicalPaths: {},
      failingPaths: ["/proc/4331/exe"],
      pathValue: "/usr/local/bin",
    },
    {
      name: "fails closed when PATH is missing",
      canonicalPaths: { "/proc/4331/exe": "/opt/opencode-1.19.0/bin/opencode" },
      failingPaths: [],
      pathValue: undefined,
    },
    {
      name: "fails closed when only a relative PATH entry would resolve the executable",
      canonicalPaths: {
        "/proc/4331/exe": "/opt/opencode-1.19.0/bin/opencode",
        "relative-notify-bin/opencode": "/opt/opencode-1.19.0/bin/opencode",
      },
      failingPaths: [],
      pathValue: "relative-notify-bin",
    },
])(
    "$name on an adopted POSIX orphan: no signal, no lease release",
    async ({ canonicalPaths, failingPaths, pathValue }) => {
      const environment = await createTestWorkspace();
      const adoptedUrl = "http://127.0.0.1:43220";
      const adoptedPid = 4331;
      const adoptedLease: ManagedServerLease = {
        path: join(environment.leaseStorageDirectory, "adopted.lease"),
        adopted: { processPid: adoptedPid, serverUrl: adoptedUrl },
        recordProcess: vi.fn(async () => {}),
        recordServerUrl: vi.fn(async () => {}),
        ownsProcess: vi.fn(async (pid: number) => pid === adoptedPid),
        release: vi.fn(async () => {}),
      };
      const canonicalRealpath = stubCanonicalRealpath(
        canonicalPaths,
        failingPaths,
      );
      const restorePath = stubEnvPath(pathValue);
      const processKill = vi
        .spyOn(process, "kill")
        .mockImplementation((() => true) as typeof process.kill);
      try {
        const server = new ManagedOpenCodeServer("/workspace/project", {
          platform: "linux",
          spawnProcess: vi.fn(),
          acquireLease: async () => adoptedLease,
          requestInstanceDispose: async () => false,
          probeEndpoint: async () => "available" as const,
          leaseStorageDirectory: environment.leaseStorageDirectory,
          databasePath: environment.databasePath,
          shutdownTimeoutMs: 30,
        });

        await expect(server.start()).resolves.toBe(adoptedUrl);
        await expect(server.dispose()).rejects.toThrow(
          "could not be verified as the extension's OpenCode executable",
        );

        expect(processKill).not.toHaveBeenCalled();
        expect(adoptedLease.release).not.toHaveBeenCalled();
        expect(server.isRunning()).toBe(true);
        expect(canonicalRealpath.realpath).toHaveBeenCalledWith(
          `/proc/${adoptedPid}/exe`,
        );
        expect(canonicalRealpath.realpath).not.toHaveBeenCalledWith(
          "relative-notify-bin/opencode",
        );
      } finally {
        processKill.mockRestore();
        canonicalRealpath.restore();
        restorePath();
      }
    },
  );

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
      databasePath: environment.databasePath,
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
      databasePath: environment.databasePath,
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
    expect(
      outcomes.find((outcome) => outcome.status === "rejected"),
    ).toMatchObject({
      reason: expect.any(ManagedServerLeaseError),
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
      temporaryDirectories.push(temporaryRoot);
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
        databasePath: join(
          temporaryRoot,
          "global-storage",
          "managed-opencode",
          "opencode.db",
        ),
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
    45_000,
  );
});

function stubCanonicalRealpath(
  canonicalPaths: Record<string, string>,
  failingPaths: readonly string[] = [],
): { realpath: ReturnType<typeof vi.fn>; restore(): void } {
  const actualRealpath = posixRealpathState.actualRealpath;
  const realpath = vi.fn(async (path: string) => {
    if (failingPaths.includes(path)) {
      throw Object.assign(
        new Error(`ENOENT: no such file or directory, realpath '${path}'`),
        { code: "ENOENT" },
      );
    }
    const canonicalPath: string | undefined = canonicalPaths[path];
    if (canonicalPath !== undefined) return canonicalPath;
    if (!actualRealpath) {
      throw new Error("POSIX realpath fixtures require the real filesystem.");
    }
    return actualRealpath(path);
  });
  posixRealpathState.delegate = realpath;
  return {
    realpath,
    restore: () => {
      posixRealpathState.delegate = undefined;
    },
  };
}

function stubProcCmdline(
  pid: number,
  cmdline: string,
): { readFileSync: ReturnType<typeof vi.fn>; restore(): void } {
  const actualReadFileSync = nodeReadFileSyncState.actualReadFileSync;
  const readFileSync = vi.fn((path: string, options?: unknown) => {
    if (path === `/proc/${pid}/cmdline`) return cmdline;
    if (!actualReadFileSync) {
      throw new Error("POSIX cmdline fixtures require the real filesystem.");
    }
    return actualReadFileSync(path, options);
  });
  nodeReadFileSyncState.delegate = readFileSync;
  return {
    readFileSync,
    restore: () => {
      nodeReadFileSyncState.delegate = undefined;
    },
  };
}

function stubEnvPath(pathValue: string | undefined): () => void {
  const previousPath = process.env.PATH;
  if (pathValue === undefined) delete process.env.PATH;
  else process.env.PATH = pathValue;
  return () => {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  };
}

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
    databasePath:
      options.databasePath ??
      join(
        options.leaseStorageDirectory ?? process.cwd(),
        "..",
        "managed-opencode",
        "opencode.db",
      ),
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
