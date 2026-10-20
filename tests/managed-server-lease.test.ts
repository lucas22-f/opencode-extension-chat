import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireManagedServerLease,
  type ProcessStatus,
} from "../src/extension/managed-server-lease";

const temporaryDirectories: string[] = [];

async function pathExistsQuietly(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true }),
    ),
  );
});

async function createLeaseFixture(): Promise<{
  workspace: string;
  storageDirectory: string;
}> {
  const root = await mkdtemp(
    join(process.cwd(), ".opencode-visual-lease-test-ñ-"),
  );
  temporaryDirectories.push(root);
  const workspace = join(root, "workspace");
  const storageDirectory = join(root, "global-storage", "managed-server-leases");
  await mkdir(workspace);
  return { workspace, storageDirectory };
}

describe("managed server workspace lease", () => {
  it("refuses to release a lease record that no longer belongs to this owner", async () => {
    const { workspace, storageDirectory } = await createLeaseFixture();

    const lease = await acquireManagedServerLease(storageDirectory, workspace);
    const ownedRecord = JSON.parse(await readFile(lease.path, "utf8")) as {
      nonce: string;
    };
    const replacementRecord = JSON.stringify({
      ...ownedRecord,
      nonce: "different-owner",
    });
    await writeFile(lease.path, replacementRecord, "utf8");

    await expect(lease.release()).rejects.toThrow(
      "Managed server lease ownership could not be verified",
    );
    expect(await readFile(lease.path, "utf8")).toBe(replacementRecord);
  });

  it("fails closed and preserves a lease when the recorded CLI process is unknown", async () => {
    const { workspace, storageDirectory } = await createLeaseFixture();

    const initialLease = await acquireManagedServerLease(storageDirectory, workspace);
    const leasePath = initialLease.path;
    await initialLease.release();

    const hostPid = process.pid + 10_000;
    const processPid = process.pid + 20_000;
    const staleRecord = JSON.stringify({
      nonce: "unverified-owner",
      hostPid,
      createdAt: Date.now() - 60_000,
      processPid,
      serverUrl: "http://127.0.0.1:43130",
    });
    await writeFile(leasePath, staleRecord, "utf8");

    const processStatus = vi.fn(
      (pid: number): ProcessStatus => (pid === hostPid ? "gone" : "unknown"),
    );
    const endpointStatus = vi.fn(async () => "unavailable" as const);
    const processKill = vi.spyOn(process, "kill");

    try {
      await expect(
        acquireManagedServerLease(storageDirectory, workspace, {
          processStatus,
          endpointStatus,
        }),
      ).rejects.toThrow("Another extension host is starting or owns");

      expect(processStatus).toHaveBeenNthCalledWith(1, hostPid);
      expect(processStatus).toHaveBeenNthCalledWith(2, processPid);
      expect(endpointStatus).not.toHaveBeenCalled();
      expect(processKill).not.toHaveBeenCalled();
      expect(await readFile(leasePath, "utf8")).toBe(staleRecord);
      expect(await readdir(storageDirectory)).toEqual([basename(leasePath)]);
    } finally {
      processKill.mockRestore();
    }
  });

  it("keeps the busy error when the recorded owner host is still alive", async () => {
    const { workspace, storageDirectory } = await createLeaseFixture();

    const initialLease = await acquireManagedServerLease(storageDirectory, workspace);
    const leasePath = initialLease.path;
    await initialLease.release();
    const liveOwnerRecord = JSON.stringify({
      nonce: "live-owner",
      hostPid: process.pid + 50_000,
      createdAt: Date.now() - 60_000,
      processPid: process.pid + 60_000,
      serverUrl: "http://127.0.0.1:43140",
    });
    await writeFile(leasePath, liveOwnerRecord, "utf8");

    const processStatus = vi.fn(() => "alive" as const);
    const endpointStatus = vi.fn(async () => "available" as const);
    const terminateProcess = vi.fn(async () => {});

    await expect(
      acquireManagedServerLease(storageDirectory, workspace, {
        processStatus,
        endpointStatus,
        terminateProcess,
      }),
    ).rejects.toThrow("Another extension host is starting or owns");

    expect(processStatus).toHaveBeenCalledOnce();
    expect(endpointStatus).not.toHaveBeenCalled();
    expect(terminateProcess).not.toHaveBeenCalled();
    expect(await readFile(leasePath, "utf8")).toBe(liveOwnerRecord);
  });

  it("adopts a healthy orphaned managed server whose owner host died", async () => {
    const { workspace, storageDirectory } = await createLeaseFixture();

    const initialLease = await acquireManagedServerLease(storageDirectory, workspace);
    const leasePath = initialLease.path;
    await initialLease.release();
    const hostPid = process.pid + 70_000;
    const processPid = process.pid + 80_000;
    const serverUrl = "http://127.0.0.1:43141";
    await writeFile(
      leasePath,
      JSON.stringify({
        nonce: "orphan-owner",
        hostPid,
        createdAt: Date.now() - 60_000,
        processPid,
        serverUrl,
      }),
      "utf8",
    );

    const processStatus = vi.fn(
      (pid: number): ProcessStatus =>
        pid === hostPid ? "gone" : pid === processPid ? "alive" : "unknown",
    );
    const endpointStatus = vi.fn(async () => "available" as const);

    const lease = await acquireManagedServerLease(storageDirectory, workspace, {
      processStatus,
      endpointStatus,
    });

    expect(lease.adopted).toEqual({ processPid, serverUrl });
    const record = JSON.parse(await readFile(lease.path, "utf8")) as {
      nonce: string;
      hostPid: number;
      processPid?: number;
      serverUrl?: string;
    };
    expect(record).toMatchObject({ hostPid: process.pid, processPid, serverUrl });
    expect(record.nonce).not.toBe("orphan-owner");
    expect(await lease.ownsProcess(processPid)).toBe(true);
    expect(await lease.ownsProcess(processPid + 1)).toBe(false);

    await lease.release();
    expect(await readdir(storageDirectory)).toEqual([]);
  });

  it("kills an unhealthy orphaned managed server and reclaims its lease", async () => {
    const { workspace, storageDirectory } = await createLeaseFixture();

    const initialLease = await acquireManagedServerLease(storageDirectory, workspace);
    const leasePath = initialLease.path;
    await initialLease.release();
    const hostPid = process.pid + 90_000;
    const processPid = process.pid + 100_000;
    await writeFile(
      leasePath,
      JSON.stringify({
        nonce: "unhealthy-orphan-owner",
        hostPid,
        createdAt: Date.now() - 60_000,
        processPid,
        serverUrl: "http://127.0.0.1:43142",
      }),
      "utf8",
    );

    const processStatus = vi.fn(
      (pid: number): ProcessStatus =>
        pid === hostPid ? "gone" : pid === processPid ? "alive" : "unknown",
    );
    const endpointStatus = vi.fn(async () => "unavailable" as const);
    const terminateProcess = vi.fn(async () => {});

    const lease = await acquireManagedServerLease(storageDirectory, workspace, {
      processStatus,
      endpointStatus,
      terminateProcess,
    });

    expect(terminateProcess).toHaveBeenCalledExactlyOnceWith(processPid);
    expect(lease.adopted).toBeUndefined();
    const record = JSON.parse(await readFile(lease.path, "utf8")) as {
      hostPid: number;
      processPid?: number;
      serverUrl?: string;
    };
    expect(record).toMatchObject({ hostPid: process.pid });
    expect(record.processPid).toBeUndefined();
    expect(record.serverUrl).toBeUndefined();
  });

  it("keeps the busy error when an orphaned process cannot be verified because endpoint status is unknown", async () => {
    const { workspace, storageDirectory } = await createLeaseFixture();

    const initialLease = await acquireManagedServerLease(storageDirectory, workspace);
    const leasePath = initialLease.path;
    await initialLease.release();
    const hostPid = process.pid + 110_000;
    const processPid = process.pid + 120_000;
    const staleRecord = JSON.stringify({
      nonce: "unknown-orphan-owner",
      hostPid,
      createdAt: Date.now() - 60_000,
      processPid,
      serverUrl: "http://127.0.0.1:43143",
    });
    await writeFile(leasePath, staleRecord, "utf8");

    const processStatus = vi.fn(
      (pid: number): ProcessStatus =>
        pid === hostPid ? "gone" : pid === processPid ? "alive" : "unknown",
    );
    const endpointStatus = vi.fn(async () => "unknown" as const);
    const terminateProcess = vi.fn(async () => {});

    await expect(
      acquireManagedServerLease(storageDirectory, workspace, {
        processStatus,
        endpointStatus,
        terminateProcess,
      }),
    ).rejects.toThrow("Another extension host is starting or owns");

    expect(endpointStatus).toHaveBeenCalledOnce();
    expect(terminateProcess).not.toHaveBeenCalled();
    expect(await readFile(leasePath, "utf8")).toBe(staleRecord);
    expect(await readdir(storageDirectory)).toEqual([basename(leasePath)]);
  });

  it("kills an orphaned process left before its server URL was recorded and reclaims its lease", async () => {
    const { workspace, storageDirectory } = await createLeaseFixture();

    const initialLease = await acquireManagedServerLease(storageDirectory, workspace);
    const leasePath = initialLease.path;
    await initialLease.release();
    const hostPid = process.pid + 130_000;
    const processPid = process.pid + 140_000;
    await writeFile(
      leasePath,
      JSON.stringify({
        nonce: "mid-startup-orphan-owner",
        hostPid,
        createdAt: Date.now() - 60_000,
        processPid,
      }),
      "utf8",
    );

    const processStatus = vi.fn(
      (pid: number): ProcessStatus =>
        pid === hostPid ? "gone" : pid === processPid ? "alive" : "unknown",
    );
    const terminateProcess = vi.fn(async () => {});

    const lease = await acquireManagedServerLease(storageDirectory, workspace, {
      processStatus,
      terminateProcess,
    });

    expect(terminateProcess).toHaveBeenCalledExactlyOnceWith(processPid);
    expect(lease.adopted).toBeUndefined();
    const record = JSON.parse(await readFile(lease.path, "utf8")) as {
      hostPid: number;
      processPid?: number;
    };
    expect(record).toMatchObject({ hostPid: process.pid });
    expect(record.processPid).toBeUndefined();
  });

  it("reclaims a lease left before its process was recorded", async () => {
    const { workspace, storageDirectory } = await createLeaseFixture();

    const initialLease = await acquireManagedServerLease(storageDirectory, workspace);
    const leasePath = initialLease.path;
    await initialLease.release();
    const hostPid = process.pid + 150_000;
    await writeFile(
      leasePath,
      JSON.stringify({
        nonce: "pre-spawn-orphan-owner",
        hostPid,
        createdAt: Date.now() - 60_000,
      }),
      "utf8",
    );

    const processStatus = vi.fn(
      (pid: number): ProcessStatus => (pid === hostPid ? "gone" : "unknown"),
    );
    const terminateProcess = vi.fn(async () => {});

    const lease = await acquireManagedServerLease(storageDirectory, workspace, {
      processStatus,
      terminateProcess,
    });

    expect(terminateProcess).not.toHaveBeenCalled();
    expect(lease.adopted).toBeUndefined();
    const record = JSON.parse(await readFile(lease.path, "utf8")) as {
      hostPid: number;
    };
    expect(record).toMatchObject({ hostPid: process.pid });
  });

  it("keeps the busy error for an unparseable lease record", async () => {
    const { workspace, storageDirectory } = await createLeaseFixture();

    const initialLease = await acquireManagedServerLease(storageDirectory, workspace);
    const leasePath = initialLease.path;
    await initialLease.release();
    const corruptRecord = "{not-json";
    await writeFile(leasePath, corruptRecord, "utf8");

    const processStatus = vi.fn(() => "gone" as const);
    const terminateProcess = vi.fn(async () => {});

    await expect(
      acquireManagedServerLease(storageDirectory, workspace, {
        processStatus,
        terminateProcess,
      }),
    ).rejects.toThrow("Another extension host is starting or owns");

    expect(terminateProcess).not.toHaveBeenCalled();
    expect(await readFile(leasePath, "utf8")).toBe(corruptRecord);
  });

  it("clears a stranded reaper guard whose owner died and takes the lease", async () => {
    const { workspace, storageDirectory } = await createLeaseFixture();

    const initialLease = await acquireManagedServerLease(storageDirectory, workspace);
    const leasePath = initialLease.path;
    await initialLease.release();
    const reaperPath = `${leasePath}.reaper`;
    await mkdir(reaperPath);
    await writeFile(
      join(reaperPath, "owner"),
      JSON.stringify({ hostPid: process.pid + 160_000 }),
      "utf8",
    );

    const processStatus = vi.fn(
      (pid: number): ProcessStatus => (pid === process.pid + 160_000 ? "gone" : "alive"),
    );

    const lease = await acquireManagedServerLease(storageDirectory, workspace, {
      processStatus,
    });

    expect(lease.adopted).toBeUndefined();
    expect(await pathExistsQuietly(reaperPath)).toBe(false);
    expect(await readdir(storageDirectory)).toEqual([basename(leasePath)]);
  });

  it("keeps the busy error while a reaper guard owner is still alive", async () => {
    const { workspace, storageDirectory } = await createLeaseFixture();

    const initialLease = await acquireManagedServerLease(storageDirectory, workspace);
    const leasePath = initialLease.path;
    await initialLease.release();
    const reaperPath = `${leasePath}.reaper`;
    await mkdir(reaperPath);
    await writeFile(
      join(reaperPath, "owner"),
      JSON.stringify({ hostPid: process.pid + 170_000 }),
      "utf8",
    );

    const processStatus = vi.fn(() => "alive" as const);

    await expect(
      acquireManagedServerLease(storageDirectory, workspace, {
        processStatus,
      }),
    ).rejects.toThrow("Another extension host is starting or owns");

    expect(await pathExistsQuietly(reaperPath)).toBe(true);
  });

  it("keeps the busy error for a reaper guard without a readable owner record", async () => {
    const { workspace, storageDirectory } = await createLeaseFixture();

    const initialLease = await acquireManagedServerLease(storageDirectory, workspace);
    const leasePath = initialLease.path;
    await initialLease.release();
    const reaperPath = `${leasePath}.reaper`;
    await mkdir(reaperPath);

    await expect(
      acquireManagedServerLease(storageDirectory, workspace, {}),
    ).rejects.toThrow("Another extension host is starting or owns");

    expect(await pathExistsQuietly(reaperPath)).toBe(true);
  });

  it("fails closed when a mid-startup orphan must be terminated without a termination hook", async () => {
    const { workspace, storageDirectory } = await createLeaseFixture();
    const initialLease = await acquireManagedServerLease(storageDirectory, workspace);
    const leasePath = initialLease.path;
    await initialLease.release();
    const hostPid = process.pid + 180_000, processPid = process.pid + 190_000;
    const midStartupRecord = JSON.stringify({ nonce: "mid-startup-no-hook", hostPid, createdAt: Date.now() - 60_000, processPid });
    await writeFile(leasePath, midStartupRecord, "utf8");
    const processKill = vi.spyOn(process, "kill");

    try {
      await expect(
        acquireManagedServerLease(storageDirectory, workspace, {
          processStatus: (pid: number): ProcessStatus => (pid === hostPid ? "gone" : pid === processPid ? "alive" : "unknown"),
        }),
      ).rejects.toThrow("requires a verified orphan termination hook");

      expect(processKill).not.toHaveBeenCalled();
      expect(await readFile(leasePath, "utf8")).toBe(midStartupRecord);
    } finally {
      processKill.mockRestore();
    }
  });

  it("keeps the busy error instead of adopting when the recorded process is gone but the endpoint is available", async () => {
    const { workspace, storageDirectory } = await createLeaseFixture();
    const initialLease = await acquireManagedServerLease(storageDirectory, workspace);
    const leasePath = initialLease.path;
    await initialLease.release();
    const staleRecord = JSON.stringify({ nonce: "gone-process-available-endpoint", hostPid: process.pid + 200_000, createdAt: Date.now() - 60_000, processPid: process.pid + 210_000, serverUrl: "http://127.0.0.1:43144" });    await writeFile(leasePath, staleRecord, "utf8");
    const terminateProcess = vi.fn(async () => {});

    await expect(
      acquireManagedServerLease(storageDirectory, workspace, {
        processStatus: () => "gone" as const,
        endpointStatus: async () => "available" as const,
        terminateProcess,
      }),
    ).rejects.toThrow("Another extension host is starting or owns");

    expect(terminateProcess).not.toHaveBeenCalled();
    expect(await readFile(leasePath, "utf8")).toBe(staleRecord);
  });

  it("reclaims a stale lease when the recorded owner host cannot be signaled", async () => {
    const { workspace, storageDirectory } = await createLeaseFixture();

    const initialLease = await acquireManagedServerLease(storageDirectory, workspace);
    const leasePath = initialLease.path;
    await initialLease.release();
    const hostPid = process.pid + 180_000;
    const processPid = process.pid + 190_000;
    await writeFile(
      leasePath,
      JSON.stringify({
        nonce: "unsignalable-host-owner",
        hostPid,
        createdAt: Date.now() - 60_000,
        processPid,
        serverUrl: "http://127.0.0.1:43144",
      }),
      "utf8",
    );

    const processStatus = vi.fn(
      (pid: number): ProcessStatus =>
        pid === hostPid
          ? "unknown"
          : pid === processPid
            ? "gone"
            : "alive",
    );
    const endpointStatus = vi.fn(async () => "unavailable" as const);
    const terminateProcess = vi.fn(async () => {});

    const lease = await acquireManagedServerLease(storageDirectory, workspace, {
      processStatus,
      endpointStatus,
      terminateProcess,
    });

    expect(terminateProcess).not.toHaveBeenCalled();
    expect(lease.adopted).toBeUndefined();
    const record = JSON.parse(await readFile(lease.path, "utf8")) as {
      hostPid: number;
    };
    expect(record).toMatchObject({ hostPid: process.pid });
  });

  it("keeps the busy error when the recorded owner host cannot be signaled and the orphan is healthy", async () => {
    const { workspace, storageDirectory } = await createLeaseFixture();

    const initialLease = await acquireManagedServerLease(storageDirectory, workspace);
    const leasePath = initialLease.path;
    await initialLease.release();
    const hostPid = process.pid + 200_000;
    const processPid = process.pid + 210_000;
    const staleRecord = JSON.stringify({
      nonce: "unsignalable-host-orphan-owner",
      hostPid,
      createdAt: Date.now() - 60_000,
      processPid,
      serverUrl: "http://127.0.0.1:43145",
    });
    await writeFile(leasePath, staleRecord, "utf8");

    const processStatus = vi.fn(
      (pid: number): ProcessStatus => (pid === hostPid ? "unknown" : "alive"),
    );
    const endpointStatus = vi.fn(async () => "available" as const);
    const terminateProcess = vi.fn(async () => {});

    await expect(
      acquireManagedServerLease(storageDirectory, workspace, {
        processStatus,
        endpointStatus,
        terminateProcess,
      }),
    ).rejects.toThrow("Another extension host is starting or owns");

    expect(terminateProcess).not.toHaveBeenCalled();
    expect(await readFile(leasePath, "utf8")).toBe(staleRecord);
  });

  it("fails closed for an incomplete lease when the recorded owner host cannot be signaled", async () => {
    const { workspace, storageDirectory } = await createLeaseFixture();

    const initialLease = await acquireManagedServerLease(storageDirectory, workspace);
    const leasePath = initialLease.path;
    await initialLease.release();
    const hostPid = process.pid + 220_000;
    const processPid = process.pid + 230_000;
    const midStartupRecord = JSON.stringify({
      nonce: "unsignalable-host-mid-startup-owner",
      hostPid,
      createdAt: Date.now() - 60_000,
      processPid,
    });
    await writeFile(leasePath, midStartupRecord, "utf8");

    const processStatus = vi.fn(
      (pid: number): ProcessStatus => (pid === hostPid ? "unknown" : "alive"),
    );
    const terminateProcess = vi.fn(async () => {});

    await expect(
      acquireManagedServerLease(storageDirectory, workspace, {
        processStatus,
        terminateProcess,
      }),
    ).rejects.toThrow("Another extension host is starting or owns");

    expect(terminateProcess).not.toHaveBeenCalled();
    expect(await readFile(leasePath, "utf8")).toBe(midStartupRecord);
  });

  it("keeps the busy error when the recorded owner host cannot be signaled and the endpoint status is unknown", async () => {
    const { workspace, storageDirectory } = await createLeaseFixture();

    const initialLease = await acquireManagedServerLease(storageDirectory, workspace);
    const leasePath = initialLease.path;
    await initialLease.release();
    const hostPid = process.pid + 240_000;
    const processPid = process.pid + 250_000;
    const staleRecord = JSON.stringify({
      nonce: "unsignalable-host-unknown-endpoint",
      hostPid,
      createdAt: Date.now() - 60_000,
      processPid,
      serverUrl: "http://127.0.0.1:43146",
    });
    await writeFile(leasePath, staleRecord, "utf8");

    const processStatus = vi.fn(
      (pid: number): ProcessStatus =>
        pid === hostPid ? "unknown" : pid === processPid ? "gone" : "alive",
    );
    const endpointStatus = vi.fn(async () => "unknown" as const);
    const terminateProcess = vi.fn(async () => {});

    await expect(
      acquireManagedServerLease(storageDirectory, workspace, {
        processStatus,
        endpointStatus,
        terminateProcess,
      }),
    ).rejects.toThrow("Another extension host is starting or owns");

    expect(terminateProcess).not.toHaveBeenCalled();
    expect(await readFile(leasePath, "utf8")).toBe(staleRecord);
  });

  it("does not reclaim a stale lease when endpoint status is unknown", async () => {
    const { workspace, storageDirectory } = await createLeaseFixture();

    const initialLease = await acquireManagedServerLease(storageDirectory, workspace);
    const leasePath = initialLease.path;
    await initialLease.release();
    const staleRecord = JSON.stringify({
      nonce: "stale-owner",
      hostPid: process.pid + 30_000,
      createdAt: Date.now() - 60_000,
      processPid: process.pid + 40_000,
      serverUrl: "http://127.0.0.1:43132",
    });
    await writeFile(leasePath, staleRecord, "utf8");

    const processStatus = vi.fn(() => "gone" as const);
    const endpointStatus = vi.fn(async () => "unknown" as const);
    const processKill = vi.spyOn(process, "kill");

    try {
      await expect(
        acquireManagedServerLease(storageDirectory, workspace, {
          processStatus,
          endpointStatus,
        }),
      ).rejects.toThrow("Another extension host is starting or owns");

      expect(processStatus).toHaveBeenCalledTimes(2);
      expect(endpointStatus).toHaveBeenCalledOnce();
      expect(processKill).not.toHaveBeenCalled();
      expect(await readFile(leasePath, "utf8")).toBe(staleRecord);
      expect(await readdir(storageDirectory)).toEqual([basename(leasePath)]);
    } finally {
      processKill.mockRestore();
    }
  });
});
