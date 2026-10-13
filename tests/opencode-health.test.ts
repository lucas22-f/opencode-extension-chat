import { mkdtemp, rm } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { type AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { probeOpenCodeHealth } from "../src/extension/opencode-connection";

describe("pinned OpenCode SDK health probe", () => {
  let workspace: string | undefined;

  beforeEach(async () => {
    workspace = await mkdtemp(
      join(process.cwd(), ".opencode-visual-health-test-ñ-"),
    );
  });

  afterEach(async () => {
    if (workspace) {
      await rm(workspace, { recursive: true, force: true });
      workspace = undefined;
    }
  });

  it("uses the pinned version-bearing health route and sends no credentials", async () => {
    const requests: Array<{
      method: string | undefined;
      url: string | undefined;
      authorization: string | undefined;
    }> = [];
    const server = await startLoopbackServer((request, response) => {
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ healthy: true, version: "1.19.0" }));
    });

    try {
      const result = await probeOpenCodeHealth(server.url, {
        timeoutMs: 500,
        directory: workspace,
      });

      expect(result).toEqual({ kind: "healthy", version: "1.19.0" });
      expect(requests).toHaveLength(1);
      expect(requests[0]?.method).toBe("GET");
      const requestUrl = new URL(requests[0]?.url ?? "/", server.url);
      expect(requestUrl.pathname).toBe("/global/health");
      expect(requestUrl.searchParams.get("directory")).toBe(workspace);
      expect(requests[0]?.authorization).toBeUndefined();
    } finally {
      await server.close();
    }
  });

  it("stops at an authentication challenge", async () => {
    const server = await startLoopbackServer((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "authentication required" }));
    });

    try {
      await expect(
        probeOpenCodeHealth(server.url, { timeoutMs: 500 }),
      ).resolves.toEqual({ kind: "authentication-required" });
    } finally {
      await server.close();
    }
  });

  it("does not classify a responding non-OpenCode endpoint as unavailable", async () => {
    const server = await startLoopbackServer((_request, response) => {
      response.writeHead(503, { "content-type": "text/plain" });
      response.end("unavailable");
    });

    try {
      await expect(
        probeOpenCodeHealth(server.url, { timeoutMs: 500 }),
      ).resolves.toEqual({ kind: "unexpected-response", status: 503 });
    } finally {
      await server.close();
    }
  });

  it("does not follow redirects or treat an HTML listener as a missing server", async () => {
    let redirectedRequestCount = 0;
    const destination = await startLoopbackServer((_request, response) => {
      redirectedRequestCount += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ healthy: true, version: "1.19.0" }));
    });
    const redirecting = await startLoopbackServer((_request, response) => {
      response.writeHead(302, { location: destination.url });
      response.end();
    });

    try {
      await expect(
        probeOpenCodeHealth(redirecting.url, { timeoutMs: 500 }),
      ).resolves.toEqual({ kind: "unexpected-response", status: 302 });
      expect(redirectedRequestCount).toBe(0);
    } finally {
      await redirecting.close();
      await destination.close();
    }
  });

  it("classifies an HTML response as unexpected rather than an absent server", async () => {
    const server = await startLoopbackServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" });
      response.end("<html>not OpenCode</html>");
    });

    try {
      await expect(
        probeOpenCodeHealth(server.url, { timeoutMs: 500 }),
      ).resolves.toEqual({ kind: "unexpected-response", status: 200 });
    } finally {
      await server.close();
    }
  });

  it("aborts a stalled health request within the configured bound", async () => {
    const server = await startLoopbackServer(() => undefined);

    try {
      await expect(
        probeOpenCodeHealth(server.url, { timeoutMs: 50 }),
      ).resolves.toEqual({ kind: "timeout" });
    } finally {
      await server.close();
    }
  });
});

async function startLoopbackServer(
  handleRequest: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer(handleRequest);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The health test server did not bind to a TCP port.");
  }

  return {
    url: `http://127.0.0.1:${(address as AddressInfo).port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
