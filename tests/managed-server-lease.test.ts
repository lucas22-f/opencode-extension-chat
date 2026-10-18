import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  acquireManagedServerLease,
  type ProcessStatus,
} from "../src/extension/managed-server-lease";

const temporaryDirectories: string[] = [];

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
