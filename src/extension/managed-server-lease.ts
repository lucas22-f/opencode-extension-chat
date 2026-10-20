import { createHash, randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
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
  terminateProcess?: (pid: number) => Promise<void>;
}

export interface ManagedServerLeaseAdoption {
  processPid: number;
  serverUrl: string;
}

export interface ManagedServerLease {
  readonly path: string;
  readonly adopted: ManagedServerLeaseAdoption | undefined;
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

const REAPER_GUARD_OWNER_FILE = "owner";
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
    if (!(await clearStrandedReaperGuard(reaperPath, runtime))) {
      throw leaseBusyError();
    }
  }

  let adopted: ManagedServerLeaseAdoption | undefined;
  try {
    await writeFile(leasePath, JSON.stringify(initialRecord), { flag: "wx" });
  } catch (error) {
    if (!isAlreadyExists(error)) throw error;
    adopted = await healExistingLease(leasePath, reaperPath, nonce, runtime);
    if (!adopted) {
      try {
        await writeFile(leasePath, JSON.stringify(initialRecord), { flag: "wx" });
      } catch (retryError) {
        if (isAlreadyExists(retryError)) throw leaseBusyError();
        throw retryError;
      }
    }
  }

  // A reaper may have removed the preceding stale record just before this
  // exclusive create. Do not keep a new lease while its cleanup guard is held.
  if (!adopted && (await pathExists(reaperPath))) {
    await removeIfOwned(leasePath, nonce);
    throw leaseBusyError();
  }

  return adopted
    ? createAdoptedLease(leasePath, nonce, adopted)
    : createSpawnedLease(leasePath, nonce);
}

function createSpawnedLease(
  leasePath: string,
  nonce: string,
): ManagedServerLease {
  let processPid: number | undefined;
  let serverUrl: string | undefined;

  return {
    path: leasePath,
    adopted: undefined,
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

function createAdoptedLease(
  leasePath: string,
  nonce: string,
  adopted: ManagedServerLeaseAdoption,
): ManagedServerLease {
  return {
    path: leasePath,
    adopted,
    async recordProcess(pid) {
      if (pid !== adopted.processPid) {
        throw new ManagedServerLeaseError(
          "An adopted managed server lease already owns its recorded process.",
        );
      }
    },
    async recordServerUrl(serverUrl) {
      if (serverUrl !== adopted.serverUrl) {
        throw new ManagedServerLeaseError(
          "An adopted managed server lease already owns its recorded server URL.",
        );
      }
    },
    async ownsProcess(pid) {
      try {
        const record = await readLease(leasePath);
        return Boolean(
          record &&
            record.nonce === nonce &&
            record.hostPid === process.pid &&
            record.processPid === adopted.processPid &&
            pid === adopted.processPid,
        );
      } catch {
        return false;
      }
    },
    async release() {
      const record = await readLease(leasePath);
      if (!record || record.nonce !== nonce || record.hostPid !== process.pid) {
        throw new ManagedServerLeaseError("Managed server lease ownership could not be verified.");
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

async function healExistingLease(
  leasePath: string,
  reaperPath: string,
  nonce: string,
  runtime: ManagedServerLeaseRuntime,
): Promise<ManagedServerLeaseAdoption | undefined> {
  // Fail fast before creating the reclaim guard: a live owner's concurrent
  // lease creation must never be mistaken for an active reclaim. The guard
  // directory would make such a creator discard its own fresh lease.
  const failFastRecord = await readLease(leasePath);
  if (!failFastRecord) {
    throw leaseBusyError();
  }
  const ownerStatus = await getProcessStatus(failFastRecord.hostPid, runtime);
  if (ownerStatus === "alive") {
    throw leaseBusyError();
  }
  if (ownerStatus === "unknown") {
    // An unknown owner status (e.g. EPERM probing another host's session)
    // cannot confirm the owner is dead, so it never permits adoption or
    // termination. Corroborate BEFORE creating the guard: only a complete
    // record, a definitively gone recorded process, and a definitively closed
    // endpoint allow an unlink-and-reacquire.
    await requireUnknownOwnerReclaimEvidence(failFastRecord, runtime);
  }

  try {
    await mkdir(reaperPath);
  } catch (error) {
    if (isAlreadyExists(error)) throw leaseBusyError();
    throw error;
  }

  // Record the guard owner so a later host can clear this guard if this host
  // dies mid-heal instead of failing closed forever.
  try {
    await writeFile(
      join(reaperPath, REAPER_GUARD_OWNER_FILE),
      JSON.stringify({ hostPid: process.pid }),
      { flag: "wx" },
    );
  } catch (error) {
    await clearReaperGuard(reaperPath);
    if (isAlreadyExists(error)) throw leaseBusyError();
    throw error;
  }

  try {
    // The fail-fast check above already established the recorded owner host is
    // dead, or that an unknown owner left a fully corroborated stale record.
    // Re-verify only that the record itself is unchanged; re-checking
    // statuses here would discard the evidence that guard creation raced
    // against.
    const record = await readLease(leasePath);
    if (
      !record ||
      record.nonce !== failFastRecord.nonce ||
      record.hostPid !== failFastRecord.hostPid
    ) {
      throw leaseBusyError();
    }

    if (ownerStatus === "unknown") {
      // Unknown owner: unlink-and-reacquire only, never adoption or
      // termination. Recheck the FULL record under the guard immediately
      // before unlinking so any concurrent change (fresh lease, adoption
      // rewrite, mid-write) keeps the lease and fails busy.
      if (
        record.createdAt !== failFastRecord.createdAt ||
        record.processPid !== failFastRecord.processPid ||
        record.serverUrl !== failFastRecord.serverUrl
      ) {
        throw leaseBusyError();
      }
      await requireUnknownOwnerReclaimEvidence(record, runtime);
      await unlinkLeaseIfUnchanged(leasePath, record);
      return undefined;
    }

    // The owning host died before this lease recorded its server URL. The
    // recorded process, if any, was never confirmed ready: stop it and drop
    // the lease so this host can start its own managed server.
    if (!record.serverUrl) {
      if (
        record.processPid !== undefined &&
        isValidPid(record.processPid) &&
        (await getProcessStatus(record.processPid, runtime)) === "alive"
      ) {
        await terminateOrphan(record.processPid, runtime);
      }
      await unlinkLeaseIfUnchanged(leasePath, record);
      return undefined;
    }

    const processPid = record.processPid;
    if (
      processPid === undefined ||
      !isManagedLoopbackUrl(record.serverUrl)
    ) {
      throw leaseBusyError();
    }

    const processStatus = await getProcessStatus(processPid, runtime);
    if (processStatus === "unknown") throw leaseBusyError();

    const endpointStatus = await getEndpointStatus(record.serverUrl, runtime);
    if (processStatus === "alive" && endpointStatus === "available") {
      // The orphan is healthy: take over its lease and reuse its server.
      const current = await readLease(leasePath);
      if (
        !current ||
        current.nonce !== record.nonce ||
        current.hostPid !== record.hostPid ||
        current.processPid !== record.processPid ||
        current.serverUrl !== record.serverUrl
      ) {
        throw leaseBusyError();
      }
      await writeLease(leasePath, {
        nonce,
        hostPid: process.pid,
        createdAt: Date.now(),
        processPid,
        serverUrl: record.serverUrl,
      });
      return { processPid, serverUrl: record.serverUrl };
    }

    if (processStatus === "alive") {
      // The orphan is not healthy: stop it and reclaim its lease.
      if (endpointStatus !== "unavailable") throw leaseBusyError();
      await terminateOrphan(processPid, runtime);
      await unlinkLeaseIfUnchanged(leasePath, record);
      return undefined;
    }

    // The recorded process is gone; only a closed endpoint may be reclaimed.
    if (endpointStatus !== "unavailable") throw leaseBusyError();
    await unlinkLeaseIfUnchanged(leasePath, record);
    return undefined;
  } catch (error) {
    if (isMissing(error)) throw leaseBusyError();
    throw error;
  } finally {
    await clearReaperGuard(reaperPath);
  }
}

async function requireUnknownOwnerReclaimEvidence(
  record: LeaseRecord,
  runtime: ManagedServerLeaseRuntime,
): Promise<void> {
  if (
    !isValidPid(record.processPid) ||
    !record.serverUrl ||
    !isManagedLoopbackUrl(record.serverUrl) ||
    (await getProcessStatus(record.processPid, runtime)) !== "gone" ||
    (await getEndpointStatus(record.serverUrl, runtime)) !== "unavailable"
  ) {
    throw leaseBusyError();
  }
}

async function clearStrandedReaperGuard(
  reaperPath: string,
  runtime: ManagedServerLeaseRuntime,
): Promise<boolean> {
  let ownerPid: number | undefined;
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(reaperPath, REAPER_GUARD_OWNER_FILE), "utf8"),
    );
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "hostPid" in parsed &&
      isValidPid(parsed.hostPid)
    ) {
      ownerPid = parsed.hostPid;
    }
  } catch {
    return false;
  }
  if (ownerPid === undefined) return false;
  if ((await getProcessStatus(ownerPid, runtime)) !== "gone") return false;
  try {
    await rm(reaperPath, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

async function clearReaperGuard(reaperPath: string): Promise<void> {
  try {
    await rm(reaperPath, { recursive: true, force: true });
  } catch {
    // A stranded guard fails closed; a later host clears it via its recorded owner.
  }
}

async function unlinkLeaseIfUnchanged(
  leasePath: string,
  record: LeaseRecord,
): Promise<void> {
  const current = await readLease(leasePath);
  if (
    !current ||
    current.nonce !== record.nonce ||
    current.hostPid !== record.hostPid ||
    current.processPid !== record.processPid ||
    current.serverUrl !== record.serverUrl
  ) {
    throw leaseBusyError();
  }
  await unlink(leasePath);
}

async function terminateOrphan(
  pid: number,
  runtime: ManagedServerLeaseRuntime,
): Promise<void> {
  if (!runtime.terminateProcess) {
    // A bare signal on a lease-recorded PID could hit a recycled process.
    throw new ManagedServerLeaseError(
      "Managed server lease healing requires a verified orphan termination hook.",
    );
  }
  await runtime.terminateProcess(pid);
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
