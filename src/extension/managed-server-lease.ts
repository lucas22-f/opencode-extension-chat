import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  open,
  readFile,
  realpath,
  rmdir,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";

export type ProcessStatus = "alive" | "gone" | "unknown";
export type EndpointStatus = "available" | "unavailable" | "unknown";

export interface ManagedServerLeaseRuntime {
  processStatus?: (pid: number) => ProcessStatus | Promise<ProcessStatus>;
  endpointStatus?: (
    serverUrl: string,
    timeoutMs: number,
  ) => EndpointStatus | Promise<EndpointStatus>;
}

export interface ManagedServerLease {
  readonly path: string;
  recordProcess(pid: number): Promise<void>;
  recordServerUrl(serverUrl: string): Promise<void>;
  ownsProcess(pid: number): Promise<boolean>;
  release(): Promise<void>;
}

interface LeaseRecord {
  nonce: string;
  hostPid: number;
  createdAt: number;
  processPid?: number;
  serverUrl?: string;
}

const STALE_ENDPOINT_CHECK_TIMEOUT_MS = 500;

export class ManagedServerLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ManagedServerLeaseError";
  }
}

export async function acquireManagedServerLease(
  storageDirectory: string,
  workspaceDirectory: string,
  runtime: ManagedServerLeaseRuntime = {},
): Promise<ManagedServerLease> {
  await mkdir(storageDirectory, { recursive: true });
  const canonicalDirectory = await realpath(workspaceDirectory);
  const key = createHash("sha256")
    .update(process.platform === "win32" ? canonicalDirectory.toLowerCase() : canonicalDirectory)
    .digest("hex");
  const leasePath = join(storageDirectory, `${key}.lease`);
  const reaperPath = `${leasePath}.reaper`;
  const nonce = randomUUID();
  const initialRecord: LeaseRecord = {
    nonce,
    hostPid: process.pid,
    createdAt: Date.now(),
  };

  if (await pathExists(reaperPath)) {
    throw leaseBusyError();
  }

  try {
    await writeFile(leasePath, JSON.stringify(initialRecord), { flag: "wx" });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    if (!(await reclaimStaleLease(leasePath, reaperPath, runtime))) {
      throw leaseBusyError();
    }
    try {
      await writeFile(leasePath, JSON.stringify(initialRecord), { flag: "wx" });
    } catch (retryError) {
      if (isAlreadyExists(retryError)) throw leaseBusyError();
      throw retryError;
    }
  }

  // A reaper may have removed the preceding stale record just before this
  // exclusive create. Do not keep a new lease while its cleanup guard is held.
  if (await pathExists(reaperPath)) {
    await removeIfOwned(leasePath, nonce);
    throw leaseBusyError();
  }

  let processPid: number | undefined;
  let serverUrl: string | undefined;

  return {
    path: leasePath,
    async recordProcess(pid) {
      if (!isValidPid(pid)) {
        throw new ManagedServerLeaseError("Managed server lease requires a valid owned process ID.");
      }
      const record = await readOwnedLease(leasePath, nonce);
      await writeLease(leasePath, { ...record, processPid: pid });
      processPid = pid;
    },
    async recordServerUrl(url) {
      if (!isManagedLoopbackUrl(url)) {
        throw new ManagedServerLeaseError("Managed server lease requires its reported loopback URL.");
      }
      const record = await readOwnedLease(leasePath, nonce);
      if (!processPid || record.processPid !== processPid) {
        throw new ManagedServerLeaseError("Managed server lease does not own the reported process.");
      }
      await writeLease(leasePath, { ...record, serverUrl: url });
      serverUrl = url;
    },
    async ownsProcess(pid) {
      try {
        const record = await readLease(leasePath);
        return Boolean(
          record &&
            record.nonce === nonce &&
            record.hostPid === process.pid &&
            record.processPid === pid &&
            processPid === pid,
        );
      } catch {
        return false;
      }
    },
    async release() {
      const record = await readOwnedLease(leasePath, nonce);
      if (processPid !== undefined && record.processPid !== processPid) {
        throw new ManagedServerLeaseError("Managed server lease ownership changed before cleanup.");
      }
      if (serverUrl !== undefined && record.serverUrl !== serverUrl) {
        throw new ManagedServerLeaseError("Managed server lease URL changed before cleanup.");
      }
      await unlink(leasePath);
    },
  };
}

export async function probeManagedServerEndpoint(
  serverUrl: string,
  timeoutMs: number,
): Promise<EndpointStatus> {
  const controller = AbortSignal.timeout(Math.max(1, timeoutMs));
  try {
    const response = await fetch(`${serverUrl}/global/health`, {
      method: "GET",
      redirect: "manual",
      signal: controller,
    });
    await response.body?.cancel();
    return "available";
  } catch (error) {
    return hasErrorCode(error, "ECONNREFUSED") ? "unavailable" : "unknown";
  }
}

async function reclaimStaleLease(
  leasePath: string,
  reaperPath: string,
  runtime: ManagedServerLeaseRuntime,
): Promise<boolean> {
  const record = await readLease(leasePath);
  if (
    !record ||
    !isValidPid(record.hostPid) ||
    !isValidPid(record.processPid) ||
    !record.serverUrl ||
    !isManagedLoopbackUrl(record.serverUrl)
  ) {
    return false;
  }

  try {
    await mkdir(reaperPath);
  } catch (error) {
    if (isAlreadyExists(error)) return false;
    throw error;
  }

  try {
    if (
      (await getProcessStatus(record.hostPid, runtime)) !== "gone" ||
      (await getProcessStatus(record.processPid, runtime)) !== "gone" ||
      (await getEndpointStatus(record.serverUrl, runtime)) !== "unavailable"
    ) {
      return false;
    }

    const current = await readLease(leasePath);
    if (
      !current ||
      current.nonce !== record.nonce ||
      current.hostPid !== record.hostPid ||
      current.processPid !== record.processPid ||
      current.serverUrl !== record.serverUrl ||
      (await getProcessStatus(current.hostPid, runtime)) !== "gone" ||
      (await getProcessStatus(current.processPid, runtime)) !== "gone" ||
      (await getEndpointStatus(current.serverUrl, runtime)) !== "unavailable"
    ) {
      return false;
    }

    await unlink(leasePath);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  } finally {
    try {
      await rmdir(reaperPath);
    } catch {
      // A stranded guard fails closed; a later host will not take the lease.
    }
  }
}

async function getProcessStatus(
  pid: number,
  runtime: ManagedServerLeaseRuntime,
): Promise<ProcessStatus> {
  if (!isValidPid(pid)) return "unknown";
  if (runtime.processStatus) return runtime.processStatus(pid);
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return errorCode(error) === "ESRCH" ? "gone" : "unknown";
  }
}

async function getEndpointStatus(
  serverUrl: string,
  runtime: ManagedServerLeaseRuntime,
): Promise<EndpointStatus> {
  return runtime.endpointStatus
    ? runtime.endpointStatus(serverUrl, STALE_ENDPOINT_CHECK_TIMEOUT_MS)
    : probeManagedServerEndpoint(serverUrl, STALE_ENDPOINT_CHECK_TIMEOUT_MS);
}

async function readOwnedLease(path: string, nonce: string): Promise<LeaseRecord> {
  const record = await readLease(path);
  if (!record || record.nonce !== nonce || record.hostPid !== process.pid) {
    throw new ManagedServerLeaseError("Managed server lease ownership could not be verified.");
  }
  return record;
}

async function readLease(path: string): Promise<LeaseRecord | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("nonce" in parsed) ||
      typeof parsed.nonce !== "string" ||
      !("hostPid" in parsed) ||
      !isValidPid(parsed.hostPid) ||
      !("createdAt" in parsed) ||
      typeof parsed.createdAt !== "number" ||
      ("processPid" in parsed && parsed.processPid !== undefined && !isValidPid(parsed.processPid)) ||
      ("serverUrl" in parsed && parsed.serverUrl !== undefined && typeof parsed.serverUrl !== "string")
    ) {
      return undefined;
    }
    return parsed as LeaseRecord;
  } catch {
    return undefined;
  }
}

async function writeLease(path: string, record: LeaseRecord): Promise<void> {
  const handle = await open(path, "r+");
  try {
    await handle.truncate(0);
    await handle.writeFile(JSON.stringify(record));
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function removeIfOwned(path: string, nonce: string): Promise<void> {
  const record = await readLease(path);
  if (record?.nonce === nonce && record.hostPid === process.pid) {
    await unlink(path);
  }
}

function isManagedLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const port = Number(url.port);
    return (
      url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      Number.isInteger(port) &&
      port > 0 &&
      port <= 65_535 &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash &&
      !url.username &&
      !url.password &&
      url.origin === value
    );
  } catch {
    return false;
  }
}

function leaseBusyError(): ManagedServerLeaseError {
  return new ManagedServerLeaseError(
    "Another extension host is starting or owns a managed OpenCode server for this workspace.",
  );
}

function isValidPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isAlreadyExists(error: unknown): boolean {
  return errorCode(error) === "EEXIST" || errorCode(error) === "ENOTEMPTY";
}

function isMissing(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function hasErrorCode(error: unknown, code: string): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (errorCode(current) === code) return true;
    if (typeof current !== "object" || current === null || !("cause" in current)) {
      return false;
    }
    current = current.cause;
  }
  return false;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
