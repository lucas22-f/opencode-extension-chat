import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { App } from "./App";
import "./styles.css";
import {
  initialConnectionState,
  type ConnectionState,
} from "../shared/connection-state";
import { dispatchExtensionMessage } from "../shared/webview-message";

interface VsCodeApi {
  postMessage(message: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscodeApi = acquireVsCodeApi();
const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("The OpenCode Visual webview root element is missing.");
}

function WebviewApp() {
  const [connectionState, setConnectionState] =
    useState<ConnectionState>(initialConnectionState);

  useEffect(() => {
    const receiveMessage = (event: MessageEvent<unknown>): void => {
      dispatchExtensionMessage(event.data, setConnectionState);
    };

    window.addEventListener("message", receiveMessage);
    vscodeApi.postMessage({ type: "webview-ready" });
    return () => window.removeEventListener("message", receiveMessage);
  }, []);

  return (
    <App
      connectionState={connectionState}
      onConnect={() => vscodeApi.postMessage({ type: "connect" })}
      onDisconnect={() => vscodeApi.postMessage({ type: "disconnect" })}
      onOpenExpanded={() =>
        vscodeApi.postMessage({ type: "open-expanded" })
      }
    />
  );
}

createRoot(rootElement).render(<WebviewApp />);
