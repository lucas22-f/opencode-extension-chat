import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";

const serverUrl = "http://127.0.0.1:4096";
const workspace = await mkdtemp(
  join(process.cwd(), ".opencode-visual-health-smoke-ñ-"),
);
const timeoutSignal = AbortSignal.timeout(4_000);

try {
  const client = createOpencodeClient({
    baseUrl: serverUrl,
    directory: workspace,
    redirect: "error",
  });
  const result = await client.global.health({ signal: timeoutSignal });

  if (result.response?.status === 401 || result.response?.status === 403) {
    process.stdout.write("BLOCKED: server requires authentication; no credentials were sent.\n");
    process.exitCode = 2;
  } else if (
    result.response?.status === 200 &&
    result.error === undefined &&
    result.data?.healthy === true &&
    typeof result.data.version === "string"
  ) {
    process.stdout.write(`HEALTHY: OpenCode ${result.data.version} at ${serverUrl}.\n`);
  } else if (timeoutSignal.aborted) {
    process.stdout.write("BLOCKED: loopback health check exceeded 4 seconds.\n");
    process.exitCode = 2;
  } else if (!result.response) {
    process.stdout.write("BLOCKED: no server answered at 127.0.0.1:4096.\n");
    process.exitCode = 2;
  } else {
    process.stdout.write(
      `BLOCKED: loopback returned HTTP ${result.response.status}; expected OpenCode health.\n`,
    );
    process.exitCode = 2;
  }
} catch {
  process.stdout.write(
    timeoutSignal.aborted
      ? "BLOCKED: loopback health check exceeded 4 seconds.\n"
      : "BLOCKED: no server answered at 127.0.0.1:4096.\n",
  );
  process.exitCode = 2;
} finally {
  await rm(workspace, { recursive: true, force: true });
}
