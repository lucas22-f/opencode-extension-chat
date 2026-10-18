import { beforeEach, describe, expect, it, vi } from "vitest";

const vscodeMocks = vi.hoisted(() => ({
  joinPath: vi.fn(),
  readFile: vi.fn(),
}));

vi.mock("vscode", () => ({
  Uri: { joinPath: vscodeMocks.joinPath },
  workspace: { fs: { readFile: vscodeMocks.readFile } },
}));

import {
  createWebviewHtml,
  createWebviewOptions,
} from "../src/extension/webview-html";

interface TestUri {
  path: string;
  toString(): string;
}

const extensionUri = createUri("/extension") as unknown as Parameters<
  typeof createWebviewOptions
>[0];
const cspSource = "vscode-webview://test-source";

describe("generated Webview security boundary", () => {
  let manifestText: string;

  beforeEach(() => {
    manifestText = JSON.stringify({
      "index.html": {
        file: "assets/index-entry.js",
        css: ["assets/index-style.css"],
      },
    });
    vscodeMocks.joinPath.mockReset();
    vscodeMocks.joinPath.mockImplementation(
      (base: TestUri, ...segments: string[]) =>
        createUri([base.path.replace(/\/$/, ""), ...segments].join("/")),
    );
    vscodeMocks.readFile.mockReset();
    vscodeMocks.readFile.mockImplementation(async () =>
      new TextEncoder().encode(manifestText),
    );
  });

  it("limits local resources to the built Webview root", () => {
    const options = createWebviewOptions(extensionUri);

    expect(options.enableScripts).toBe(true);
    expect(options.localResourceRoots?.map((root) => (root as unknown as TestUri).path)).toEqual([
      "/extension/dist/webview",
    ]);
  });

  it("uses a per-render nonce, restrictive CSP, and converted root-local asset URIs", async () => {
    const asWebviewUri = vi.fn((asset: TestUri) =>
      createUri(`webview-resource:${asset.path}`),
    );
    const webview = {
      cspSource,
      asWebviewUri,
    } as unknown as Parameters<typeof createWebviewHtml>[0];

    const html = await createWebviewHtml(webview, extensionUri);

    const script = html.match(/<script type="module" nonce="([^"]+)" src="([^"]+)"><\/script>/);
    expect(script).not.toBeNull();
    const nonce = script?.[1];
    expect(nonce).toMatch(/^[A-Za-z0-9+/]{24}$/);
    expect(html).toContain(`script-src 'nonce-${nonce}' ${cspSource}`);
    expect(html).toContain(`style-src ${cspSource}`);
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("base-uri 'none'");
    expect(html).toContain("form-action 'none'");
    expect(html).toContain("object-src 'none'");
    expect(html).toContain('href="webview-resource:/extension/dist/webview/assets/index-style.css"');
    expect(script?.[2]).toBe(
      "webview-resource:/extension/dist/webview/assets/index-entry.js",
    );
    expect(asWebviewUri).toHaveBeenCalledTimes(2);
    expect(asWebviewUri.mock.calls.map(([asset]) => asset.path)).toEqual([
      "/extension/dist/webview/assets/index-entry.js",
      "/extension/dist/webview/assets/index-style.css",
    ]);
  });

  it.each([
    {
      label: "parent-traversal script",
      manifest: { "index.html": { file: "../outside.js" } },
      expectedConversions: 0,
    },
    {
      label: "absolute script",
      manifest: { "index.html": { file: "/outside.js" } },
      expectedConversions: 0,
    },
    {
      label: "parent-traversal stylesheet",
      manifest: {
        "index.html": { file: "assets/index.js", css: ["assets/../outside.css"] },
      },
      expectedConversions: 1,
    },
    {
      label: "empty asset path segment",
      manifest: { "index.html": { file: "assets//index.js" } },
      expectedConversions: 0,
    },
  ])("rejects $label manifest paths", async ({ manifest, expectedConversions }) => {
    manifestText = JSON.stringify(manifest);
    const asWebviewUri = vi.fn((asset: TestUri) =>
      createUri(`webview-resource:${asset.path}`),
    );
    const webview = {
      cspSource,
      asWebviewUri,
    } as unknown as Parameters<typeof createWebviewHtml>[0];

    await expect(createWebviewHtml(webview, extensionUri)).rejects.toThrow(
      "The webview manifest contains an invalid asset path.",
    );
    expect(asWebviewUri).toHaveBeenCalledTimes(expectedConversions);
    expect(asWebviewUri.mock.calls.map(([asset]) => asset.path)).toEqual(
      expectedConversions === 0
        ? []
        : ["/extension/dist/webview/assets/index.js"],
    );
  });
});

function createUri(path: string): TestUri {
  return {
    path,
    toString: () => path,
  };
}
