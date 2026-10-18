export const DIAGNOSTICS_CHANNEL_NAME = "OpenCode Visual Diagnostics";

const MAX_RECORDS = 200;
const MAX_TRANSCRIPT_CHARACTERS = 32_768;
const MAX_COUNT = 100_000;
const MAX_DURATION_MS = 86_400_000;
const MAX_CHARACTER_COUNT = 1_000_000;

declare const diagnosticFlowBrand: unique symbol;

export type DiagnosticFlow = string & {
  readonly [diagnosticFlowBrand]: true;
};

export type HealthDiagnosticOutcome =
  | "healthy"
  | "version-mismatch"
  | "authentication-required"
  | "unreachable"
  | "timeout"
  | "invalid-response"
  | "unexpected-response"
  | "invalid-configuration";

export type HistoryDropReason =
  | "invalid-id"
  | "unsupported-shape"
  | "no-renderable-text";

export type PromptDiagnosticReason =
  | "invalid-input"
  | "duplicate-attempt"
  | "invalid-session"
  | "session-changed"
  | "connection-not-ready"
  | "submission-in-progress"
  | "server-rejected"
  | "response-invalid"
  | "transport-uncertain"
  | "context-changed"
  | "interrupted";

export type ActivityDiagnosticReason =
  | "http-error"
  | "request-failed"
  | "invalid-shape"
  | "sdk-unavailable";

export type DiagnosticEvent =
  | {
      type: "connection.check.started";
      flow: DiagnosticFlow;
      mode: "connection" | "health-only";
      origin?: string;
    }
  | {
      type: "connection.check.finished";
      flow: DiagnosticFlow;
      mode: "connection" | "health-only";
      outcome: HealthDiagnosticOutcome;
      durationMs: number;
      origin?: string;
      httpStatus?: number;
      expectedVersion?: string;
      actualVersion?: string;
    }
  | {
      type: "prompt.submission.started";
      flow: DiagnosticFlow;
      characterCount: number;
      delivery: "steer" | "queue";
    }
  | {
      type: "prompt.submission.finished";
      flow: DiagnosticFlow;
      outcome: "accepted" | "rejected" | "unknown";
      durationMs: number;
      httpStatus?: number;
      reason?: PromptDiagnosticReason;
    }
  | {
      type: "history.reload.started";
      flow: DiagnosticFlow;
    }
  | {
      type: "history.reload.finished";
      flow: DiagnosticFlow;
      outcome: "empty" | "success" | "failure" | "cancelled";
      durationMs: number;
      rawCount?: number;
      mappedCount?: number;
      droppedCount?: number;
      droppedReasons?: Record<HistoryDropReason, number>;
      failureReason?: "request" | "invalid-response";
    }
  | {
      type: "stream.connection.started";
      flow: DiagnosticFlow;
    }
  | {
      type: "stream.connection.ready";
      flow: DiagnosticFlow;
      phase: "connected" | "reconnected";
    }
  | {
      type: "stream.connection.failed";
      flow: DiagnosticFlow;
      reason: "retry" | "ended" | "transport";
    }
  | {
      type: "session.activity.failed";
      flow: DiagnosticFlow;
      reason: ActivityDiagnosticReason;
      httpStatus?: number;
    };

export interface DiagnosticsSink {
  createFlow(): DiagnosticFlow;
  record(event: DiagnosticEvent): void;
}

export class DiagnosticsRecorder implements DiagnosticsSink {
  private readonly lines: string[] = [];
  private totalCharacters = 0;
  private nextFlowNumber = 0;
  private nextRecordNumber = 0;
  private recordsSinceOutputRefresh = 0;

  constructor(
    private readonly appendLine?: (line: string) => void,
    private readonly replaceOutput?: (lines: string[]) => void,
  ) {}

  createFlow(): DiagnosticFlow {
    this.nextFlowNumber = this.nextFlowNumber >= MAX_COUNT ? 1 : this.nextFlowNumber + 1;
    return `flow-${this.nextFlowNumber}` as DiagnosticFlow;
  }

  record(event: DiagnosticEvent): void {
    const safeEvent = sanitizeEvent(event);
    if (!safeEvent) return;

    this.nextRecordNumber = this.nextRecordNumber >= MAX_COUNT ? 1 : this.nextRecordNumber + 1;
    const line = JSON.stringify({
      timestamp: new Date().toISOString(),
      sequence: this.nextRecordNumber,
      ...safeEvent,
    });
    if (line.length > MAX_TRANSCRIPT_CHARACTERS) return;

    let evictedRecord = false;
    while (
      this.lines.length > 0 &&
      (this.lines.length >= MAX_RECORDS ||
        this.totalCharacters + line.length + 1 > MAX_TRANSCRIPT_CHARACTERS)
    ) {
      const removed = this.lines.shift();
      if (removed) this.totalCharacters -= removed.length + 1;
      evictedRecord = true;
    }

    this.lines.push(line);
    this.totalCharacters += line.length + 1;
    try {
      if (evictedRecord && this.replaceOutput) {
        this.recordsSinceOutputRefresh += 1;
        if (this.recordsSinceOutputRefresh >= 50) {
          this.recordsSinceOutputRefresh = 0;
          this.replaceOutput([...this.lines]);
          return;
        }
      }
      this.appendLine?.(line);
    } catch {
      // Diagnostics must never affect the extension's product flow.
    }
  }

  getTranscript(): string {
    return this.lines.join("\n");
  }

  get recordCount(): number {
    return this.lines.length;
  }
}

export const noDiagnostics: DiagnosticsSink = {
  createFlow: () => "flow-0" as DiagnosticFlow,
  record: () => undefined,
};

export function sanitizeDiagnosticOrigin(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      value.includes("?") ||
      value.includes("#")
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}

function sanitizeEvent(event: unknown): Record<string, unknown> | undefined {
  if (!isRecord(event)) return undefined;
  const flow = sanitizeFlow(event.flow);
  if (!flow || typeof event.type !== "string") return undefined;

  switch (event.type) {
    case "connection.check.started": {
      const mode = event.mode;
      if (mode !== "connection" && mode !== "health-only") return undefined;
      const origin = sanitizeDiagnosticOrigin(event.origin);
      return {
        event: event.type,
        flow,
        mode,
        ...(origin ? { origin } : {}),
      };
    }
    case "connection.check.finished": {
      const mode = event.mode;
      const outcome = event.outcome;
      const durationMs = sanitizeDuration(event.durationMs);
      if (
        (mode !== "connection" && mode !== "health-only") ||
        !isHealthOutcome(outcome) ||
        durationMs === undefined
      ) {
        return undefined;
      }
      const origin = sanitizeDiagnosticOrigin(event.origin);
      const httpStatus = sanitizeHttpStatus(event.httpStatus);
      const expectedVersion = sanitizeVersion(event.expectedVersion);
      const actualVersion = sanitizeVersion(event.actualVersion);
      return {
        event: event.type,
        flow,
        mode,
        outcome,
        durationMs,
        ...(origin ? { origin } : {}),
        ...(httpStatus === undefined ? {} : { httpStatus }),
        ...(expectedVersion ? { expectedVersion } : {}),
        ...(actualVersion ? { actualVersion } : {}),
      };
    }
    case "prompt.submission.started": {
      const characterCount = sanitizeCharacterCount(event.characterCount);
      const delivery = event.delivery;
      if (
        characterCount === undefined ||
        (delivery !== "steer" && delivery !== "queue")
      ) {
        return undefined;
      }
      return { event: event.type, flow, characterCount, delivery };
    }
    case "prompt.submission.finished": {
      const outcome = event.outcome;
      const durationMs = sanitizeDuration(event.durationMs);
      if (
        (outcome !== "accepted" && outcome !== "rejected" && outcome !== "unknown") ||
        durationMs === undefined
      ) {
        return undefined;
      }
      const httpStatus = sanitizeHttpStatus(event.httpStatus);
      const reason = isPromptReason(event.reason) ? event.reason : undefined;
      return {
        event: event.type,
        flow,
        outcome,
        durationMs,
        ...(httpStatus === undefined ? {} : { httpStatus }),
        ...(reason ? { reason } : {}),
      };
    }
    case "history.reload.started":
      return { event: event.type, flow };
    case "history.reload.finished": {
      const outcome = event.outcome;
      const durationMs = sanitizeDuration(event.durationMs);
      if (
        (outcome !== "empty" &&
          outcome !== "success" &&
          outcome !== "failure" &&
          outcome !== "cancelled") ||
        durationMs === undefined
      ) {
        return undefined;
      }
      const rawCount = sanitizeCount(event.rawCount);
      const mappedCount = sanitizeCount(event.mappedCount);
      const droppedCount = sanitizeCount(event.droppedCount);
      const droppedReasons = sanitizeDroppedReasons(event.droppedReasons);
      const failureReason =
        event.failureReason === "request" || event.failureReason === "invalid-response"
          ? event.failureReason
          : undefined;
      return {
        event: event.type,
        flow,
        outcome,
        durationMs,
        ...(rawCount === undefined ? {} : { rawCount }),
        ...(mappedCount === undefined ? {} : { mappedCount }),
        ...(droppedCount === undefined ? {} : { droppedCount }),
        ...(droppedReasons ? { droppedReasons } : {}),
        ...(failureReason ? { failureReason } : {}),
      };
    }
    case "stream.connection.started":
      return { event: event.type, flow };
    case "stream.connection.ready":
      if (event.phase !== "connected" && event.phase !== "reconnected") return undefined;
      return { event: event.type, flow, phase: event.phase };
    case "stream.connection.failed":
      if (
        event.reason !== "retry" &&
        event.reason !== "ended" &&
        event.reason !== "transport"
      ) {
        return undefined;
      }
      return { event: event.type, flow, reason: event.reason };
    case "session.activity.failed": {
      const reason = event.reason;
      if (
        reason !== "http-error" && reason !== "request-failed" &&
        reason !== "invalid-shape" && reason !== "sdk-unavailable"
      ) return undefined;
      const httpStatus = sanitizeHttpStatus(event.httpStatus);
      return {
        event: event.type,
        flow,
        reason,
        ...(httpStatus === undefined ? {} : { httpStatus }),
      };
    }
    default:
      return undefined;
  }
}

function sanitizeFlow(value: unknown): DiagnosticFlow | undefined {
  return typeof value === "string" && /^flow-[1-9]\d{0,7}$/.test(value)
    ? (value as DiagnosticFlow)
    : undefined;
}

function sanitizeDuration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(Math.round(value), MAX_DURATION_MS)
    : undefined;
}

function sanitizeCharacterCount(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_CHARACTER_COUNT
    ? value
    : undefined;
}

function sanitizeCount(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_COUNT
    ? value
    : undefined;
}

function sanitizeHttpStatus(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : undefined;
}

function sanitizeVersion(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 32) return undefined;
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  return match?.[0] === value ? value : undefined;
}

function sanitizeDroppedReasons(
  value: unknown,
): Record<HistoryDropReason, number> | undefined {
  if (!isRecord(value)) return undefined;
  const invalidID = sanitizeCount(value["invalid-id"]);
  const unsupportedShape = sanitizeCount(value["unsupported-shape"]);
  const noRenderableText = sanitizeCount(value["no-renderable-text"]);
  if (
    invalidID === undefined ||
    unsupportedShape === undefined ||
    noRenderableText === undefined
  ) {
    return undefined;
  }
  return {
    "invalid-id": invalidID,
    "unsupported-shape": unsupportedShape,
    "no-renderable-text": noRenderableText,
  };
}

function isHealthOutcome(value: unknown): value is HealthDiagnosticOutcome {
  return (
    value === "healthy" ||
    value === "version-mismatch" ||
    value === "authentication-required" ||
    value === "unreachable" ||
    value === "timeout" ||
    value === "invalid-response" ||
    value === "unexpected-response" ||
    value === "invalid-configuration"
  );
}

function isPromptReason(value: unknown): value is PromptDiagnosticReason {
  return (
    value === "invalid-input" ||
    value === "duplicate-attempt" ||
    value === "invalid-session" ||
    value === "session-changed" ||
    value === "connection-not-ready" ||
    value === "submission-in-progress" ||
    value === "server-rejected" ||
    value === "response-invalid" ||
    value === "transport-uncertain" ||
    value === "context-changed" ||
    value === "interrupted"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
