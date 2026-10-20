import { describe, expect, it } from "vitest";
import {
  DiagnosticsRecorder,
  sanitizeDiagnosticOrigin,
  type DiagnosticEvent,
} from "../src/extension/diagnostics";

describe("OpenCode Visual diagnostics recorder", () => {
  it("keeps only allowlisted fields and excludes content, IDs, secrets, and unsafe URLs", () => {
    const writtenLines: string[] = [];
    const diagnostics = new DiagnosticsRecorder((line) => writtenLines.push(line));
    const flow = diagnostics.createFlow();

    diagnostics.record({
      type: "prompt.submission.started",
      flow,
      characterCount: 48,
      delivery: "steer",
      prompt: "PRIVATE_PROMPT_CONTENT",
      sessionID: "ses_private_identifier",
      requestID: "request_private_identifier",
    } as unknown as DiagnosticEvent);
    diagnostics.record({
      type: "connection.check.started",
      flow,
      mode: "health-only",
      origin: "https://user:secret@opencode.example/path?token=private#fragment",
      authorization: "Bearer private-secret",
    } as unknown as DiagnosticEvent);
    diagnostics.record({
      type: "connection.check.finished",
      flow,
      mode: "health-only",
      outcome: "healthy",
      durationMs: 7,
      expectedVersion: "1.19.0",
      actualVersion: "1.19.0 token=private-secret",
      sdkError: "PRIVATE_SDK_ERROR",
    } as unknown as DiagnosticEvent);
    diagnostics.record({
      type: "session.activity.failed",
      flow,
      reason: "http-error",
      httpStatus: 503,
      responseBody: "PRIVATE_ACTIVITY_ERROR",
      sessionID: "ses_private_identifier",
    } as unknown as DiagnosticEvent);

    const transcript = diagnostics.getTranscript();
    expect(writtenLines).toEqual(transcript.split("\n"));
    expect(transcript).toContain('"characterCount":48');
    expect(transcript).toContain('"delivery":"steer"');
    expect(transcript).toContain('"expectedVersion":"1.19.0"');
    expect(transcript).toContain('"reason":"http-error","httpStatus":503');
    for (const privateValue of [
      "PRIVATE_PROMPT_CONTENT",
      "ses_private_identifier",
      "request_private_identifier",
      "user:secret",
      "token=private-secret",
      "PRIVATE_SDK_ERROR",
      "Bearer private-secret",
      "opencode.example",
      "PRIVATE_ACTIVITY_ERROR",
    ]) {
      expect(transcript).not.toContain(privateValue);
    }

    expect(
      sanitizeDiagnosticOrigin("https://opencode.example:4096"),
    ).toBe("https://opencode.example:4096");
    expect(
      sanitizeDiagnosticOrigin("https://user:secret@opencode.example?token=private"),
    ).toBeUndefined();
  });

  it("records choice-discovery failure categories and status without response details", () => {
    const diagnostics = new DiagnosticsRecorder();
    const flow = diagnostics.createFlow();

    diagnostics.record({
      type: "choice.discovery.failed",
      flow,
      choice: "model",
      reason: "http-error",
      httpStatus: 503,
      responseBody: "PRIVATE_MODEL_RESPONSE",
      requestUrl: "http://127.0.0.1/private-path?token=secret",
      modelID: "PRIVATE_MODEL_ID",
      providerID: "PRIVATE_PROVIDER_ID",
      error: "PRIVATE_MODEL_ERROR",
    } as unknown as DiagnosticEvent);
    diagnostics.record({
      type: "choice.discovery.failed",
      flow,
      choice: "model",
      reason: "http-error",
      httpStatus: 600,
    });
    diagnostics.record({
      type: "choice.discovery.failed",
      flow,
      choice: "model",
      reason: "invalid-shape",
      shapeIssue: "variants",
      shapePath: "models[99].variants[18].id",
    } as unknown as DiagnosticEvent);
    diagnostics.record({
      type: "choice.discovery.failed",
      flow,
      choice: "model",
      reason: "invalid-shape",
      shapeIssue: "PRIVATE_MODEL_ID",
    } as unknown as DiagnosticEvent);
    diagnostics.record({
      type: "choice.discovery.failed",
      flow,
      choice: "model",
      reason: "invalid-shape",
      shapeIssue: 42,
    } as unknown as DiagnosticEvent);
    diagnostics.record({
      type: "choice.discovery.failed",
      flow,
      choice: "model",
      reason: "http-error",
      shapeIssue: "variants",
    } as unknown as DiagnosticEvent);

    const transcript = diagnostics.getTranscript();
    expect(transcript).toContain('"event":"choice.discovery.failed"');
    expect(transcript).toContain('"choice":"model","reason":"http-error","httpStatus":503');
    expect(transcript).toContain('"shapeIssue":"variants"');
    expect(transcript).not.toContain("PRIVATE_MODEL_ID");
    expect(transcript).not.toContain("models[99].variants[18].id");
    expect(transcript).not.toContain("PRIVATE_MODEL_RESPONSE");
    expect(transcript).not.toContain("PRIVATE_MODEL_ERROR");
    expect(transcript).not.toContain("PRIVATE_MODEL_ID");
    expect(transcript).not.toContain("PRIVATE_PROVIDER_ID");
    expect(transcript).not.toContain("private-path");
    expect(transcript).not.toContain("token=secret");
    const records = transcript
      .split(String.fromCharCode(10))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records[1]).not.toHaveProperty("httpStatus");
    expect(records[3]).not.toHaveProperty("shapeIssue");
    expect(records[4]).not.toHaveProperty("shapeIssue");
    expect(records[5]).not.toHaveProperty("shapeIssue");
  });

  it("records choice-discovery lifecycle facts without response values or IDs", () => {
    const diagnostics = new DiagnosticsRecorder();
    const flow = diagnostics.createFlow();
    diagnostics.record({
      type: "choice.discovery.started",
      flow,
      choice: "model",
      modelID: "PRIVATE_MODEL_ID",
    } as unknown as DiagnosticEvent);
    diagnostics.record({
      type: "choice.discovery.finished",
      flow,
      choice: "model",
      outcome: "ready",
      durationMs: 34,
      itemCount: 2_001,
      modelIDs: ["PRIVATE_MODEL_ID"],
      response: "PRIVATE_MODEL_RESPONSE",
    } as unknown as DiagnosticEvent);
    diagnostics.record({
      type: "choice.discovery.finished",
      flow,
      choice: "model",
      outcome: "superseded",
      durationMs: 12,
      itemCount: 99,
      modelID: "PRIVATE_MODEL_ID",
    } as unknown as DiagnosticEvent);
    diagnostics.record({
      type: "choice.discovery.finished",
      flow,
      choice: "model",
      outcome: "pending",
      durationMs: 1,
    } as unknown as DiagnosticEvent);
    diagnostics.record({
      type: "choice.discovery.finished",
      flow,
      choice: "model",
      outcome: "ready",
      durationMs: -1,
      itemCount: 1,
    } as unknown as DiagnosticEvent);
    diagnostics.record({
      type: "choice.discovery.finished",
      flow,
      choice: "model",
      outcome: "ready",
      durationMs: "PRIVATE_DURATION",
      itemCount: 1,
    } as unknown as DiagnosticEvent);

    const records = diagnostics
      .getTranscript()
      .split(String.fromCharCode(10))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records[0]).toMatchObject({
      event: "choice.discovery.started",
      choice: "model",
    });
    expect(records[1]).toMatchObject({
      event: "choice.discovery.finished",
      choice: "model",
      outcome: "ready",
      durationMs: 34,
      itemCount: 2_001,
    });
    expect(records[2]).toMatchObject({
      event: "choice.discovery.finished",
      choice: "model",
      outcome: "superseded",
      durationMs: 12,
    });
    expect(records[2]).not.toHaveProperty("itemCount");
    expect(records).toHaveLength(3);
    expect(diagnostics.getTranscript()).not.toContain("PRIVATE_MODEL_ID");
    expect(diagnostics.getTranscript()).not.toContain("PRIVATE_MODEL_RESPONSE");
  });

  it("keeps history shape diagnostics to allowlisted failure categories", () => {
    const diagnostics = new DiagnosticsRecorder();
    const flow = diagnostics.createFlow();
    diagnostics.record({
      type: "history.reload.finished",
      flow,
      outcome: "failure",
      durationMs: 1,
      failureReason: "invalid-response",
      failureDetail: "cursor-field",
      issuePath: "cursor.next[0]",
      issueValue: "PRIVATE_CURSOR_VALUE",
    } as unknown as DiagnosticEvent);
    diagnostics.record({
      type: "history.reload.finished",
      flow,
      outcome: "failure",
      durationMs: 1,
      failureReason: "invalid-response",
      failureDetail: "PRIVATE_CURSOR_VALUE",
    } as unknown as DiagnosticEvent);
    diagnostics.record({
      type: "history.reload.finished",
      flow,
      outcome: "failure",
      durationMs: 1,
      failureReason: "request",
      failureDetail: "cursor-field",
    } as unknown as DiagnosticEvent);
    diagnostics.record({
      type: "history.reload.finished",
      flow,
      outcome: "success",
      durationMs: 1,
      failureReason: "invalid-response",
      failureDetail: "cursor-field",
    } as unknown as DiagnosticEvent);
    diagnostics.record({
      type: "history.reload.finished",
      flow,
      outcome: "failure",
      durationMs: 1,
      failureReason: "invalid-response",
      failureDetail: "cursor-next-field",
    });
    diagnostics.record({
      type: "history.reload.finished",
      flow,
      outcome: "failure",
      durationMs: 1,
      failureReason: "invalid-response",
      failureDetail: "cursor-previous-field",
    });

    const records = diagnostics
      .getTranscript()
      .split(String.fromCharCode(10))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records[0]).toMatchObject({
      outcome: "failure",
      failureReason: "invalid-response",
      failureDetail: "cursor-field",
    });
    expect(records[1]).not.toHaveProperty("failureDetail");
    expect(records[2]).not.toHaveProperty("failureDetail");
    expect(records[3]).not.toHaveProperty("failureDetail");
    expect(records[4]).toMatchObject({ failureDetail: "cursor-next-field" });
    expect(records[5]).toMatchObject({ failureDetail: "cursor-previous-field" });
    expect(diagnostics.getTranscript()).not.toContain("PRIVATE_CURSOR_VALUE");
    expect(diagnostics.getTranscript()).not.toContain("cursor.next[0]");
  });

  it("includes only stable numeric versions in Output and copied diagnostics", () => {
    const writtenLines: string[] = [];
    const diagnostics = new DiagnosticsRecorder((line) => writtenLines.push(line));
    const flow = diagnostics.createFlow();
    const stableVersion = "1.19.0";
    const privateMarker = ["private", "session", "identifier"].join("-");
    const rejectedVersions = [
      `${stableVersion}-${privateMarker}`,
      `${stableVersion}+${privateMarker}`,
      `v${stableVersion}`,
      `1.x.0+${privateMarker}`,
      `${stableVersion}\n`,
    ];

    diagnostics.record({
      type: "connection.check.finished",
      flow,
      mode: "health-only",
      outcome: "healthy",
      durationMs: 7,
      expectedVersion: stableVersion,
      actualVersion: stableVersion,
    });
    for (const actualVersion of rejectedVersions) {
      diagnostics.record({
        type: "connection.check.finished",
        flow,
        mode: "health-only",
        outcome: "version-mismatch",
        durationMs: 7,
        expectedVersion: stableVersion,
        actualVersion,
      });
    }

    const output = writtenLines.join("\n");
    const copiedTranscript = diagnostics.getTranscript();
    expect(output).toContain('"actualVersion":"1.19.0"');
    expect(copiedTranscript).toContain('"actualVersion":"1.19.0"');
    for (const rejectedVersion of rejectedVersions) {
      expect(
        output.includes(rejectedVersion),
        "unsafe version metadata unexpectedly appeared in Output",
      ).toBe(false);
      expect(
        copiedTranscript.includes(rejectedVersion),
        "unsafe version metadata unexpectedly appeared in copied diagnostics",
      ).toBe(false);
    }

    const hasUnsafeActualVersion = (lines: string[]): boolean =>
      lines.some((line) => {
        const record = JSON.parse(line) as Record<string, unknown>;
        return record.actualVersion !== undefined && record.actualVersion !== stableVersion;
      });
    expect(
      hasUnsafeActualVersion(writtenLines),
      "unsafe actualVersion unexpectedly appeared in Output",
    ).toBe(false);
    expect(
      hasUnsafeActualVersion(copiedTranscript.split("\n")),
      "unsafe actualVersion unexpectedly appeared in copied diagnostics",
    ).toBe(false);
  });

  it("bounds the in-memory transcript to its newest records", () => {
    const outputLines: string[] = [];
    const diagnostics = new DiagnosticsRecorder(
      (line) => outputLines.push(line),
      (lines) => outputLines.splice(0, outputLines.length, ...lines),
    );

    for (let index = 0; index < 405; index += 1) {
      diagnostics.record({
        type: "stream.connection.started",
        flow: diagnostics.createFlow(),
      });
    }

    expect(diagnostics.recordCount).toBe(200);
    expect(diagnostics.getTranscript().split("\n")).toHaveLength(200);
    expect(diagnostics.getTranscript().length).toBeLessThanOrEqual(32_768);
    expect(outputLines.length).toBeLessThanOrEqual(250);
  });
});
