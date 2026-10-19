import type { ChatSessionDiff } from "../shared/chat-state";

type DiffRowKind = "context" | "addition" | "deletion" | "nonewline";

interface DiffRow {
  kind: DiffRowKind;
  oldNumber: number | null;
  newNumber: number | null;
  text: string;
}

interface DiffHunk {
  header: string;
  oldCount: number;
  newCount: number;
  rows: DiffRow[];
}

const HUNK_HEADER_PATTERN =
  /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:[^\r\n]*)$/;

const NO_NEWLINE_MARKER = "\\ No newline at end of file";

function safeCount(value: string | undefined): number | null {
  const count = value === undefined ? 1 : Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function safeStart(value: string): number | null {
  const start = Number(value);
  return Number.isSafeInteger(start) && start >= 0 ? start : null;
}

const FILE_HEADER_PREFIXES = [
  "diff --git ",
  "index ",
  "--- ",
  "+++ ",
  "old mode ",
  "new mode ",
  "new file mode ",
  "deleted file mode ",
  "similarity index ",
  "dissimilarity index ",
  "rename from ",
  "rename to ",
  "copy from ",
  "copy to ",
  "Binary files ",
  "GIT binary patch",
];

/**
 * Parse a unified diff into hunks. Returns null when the patch is not a
 * recognizable unified diff, so callers can show an escaped fallback instead
 * of inventing line numbers.
 */
export function parseUnifiedPatch(patch: string): DiffHunk[] | null {
  const lines = patch.split("\n");
  // An ordinary trailing newline leaves one empty final element; any other
  // empty payload line is malformed, not silently discarded.
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let consumedOld = 0;
  let consumedNew = 0;
  let oldNext = 0;
  let newNext = 0;

  for (const line of lines) {
    if (line === "") return null;
    if (line.startsWith("@@")) {
      if (
        current &&
        (consumedOld !== current.oldCount || consumedNew !== current.newCount)
      ) {
        return null;
      }
      const match = HUNK_HEADER_PATTERN.exec(line);
      if (!match) return null;
      const oldStart = safeStart(match[1]);
      const newStart = safeStart(match[3]);
      const oldCount = safeCount(match[2]);
      const newCount = safeCount(match[4]);
      if (
        oldStart === null ||
        newStart === null ||
        oldCount === null ||
        newCount === null
      ) {
        return null;
      }
      current = { header: line, oldCount, newCount, rows: [] };
      hunks.push(current);
      consumedOld = 0;
      consumedNew = 0;
      oldNext = oldStart;
      newNext = newStart;
      continue;
    }
    if (!current) {
      // Known file-level headers may appear before the first hunk.
      if (FILE_HEADER_PREFIXES.some((prefix) => line.startsWith(prefix))) continue;
      return null;
    }
    if (line.startsWith("\\")) {
      // Only the exact standard marker, after a content row, is honored.
      if (line !== NO_NEWLINE_MARKER) return null;
      const previous = current.rows[current.rows.length - 1];
      if (!previous || previous.kind === "nonewline") return null;
      current.rows.push({
        kind: "nonewline",
        oldNumber: null,
        newNumber: null,
        text: line,
      });
      continue;
    }
    const kind: DiffRowKind | null = line.startsWith("+")
      ? "addition"
      : line.startsWith("-")
        ? "deletion"
        : line.startsWith(" ")
          ? "context"
          : null;
    if (!kind) return null;
    if ((kind === "context" || kind === "deletion") && current.oldCount === 0) {
      return null;
    }
    if ((kind === "context" || kind === "addition") && current.newCount === 0) {
      return null;
    }
    let oldNumber: number | null = null;
    let newNumber: number | null = null;
    if (kind === "context") {
      oldNumber = oldNext++;
      newNumber = newNext++;
      consumedOld += 1;
      consumedNew += 1;
    } else if (kind === "addition") {
      newNumber = newNext++;
      consumedNew += 1;
    } else if (kind === "deletion") {
      oldNumber = oldNext++;
      consumedOld += 1;
    }
    current.rows.push({ kind, oldNumber, newNumber, text: line });
  }
  if (
    current &&
    (consumedOld !== current.oldCount || consumedNew !== current.newCount)
  ) {
    return null;
  }

  return hunks.length > 0 ? hunks : null;
}

export function SessionDiffView({ diffs }: { diffs: ChatSessionDiff[] }) {
  return (
    <details aria-label="Session file changes" className="session-diff-view">
      <summary>Session file changes ({diffs.length})</summary>
      <ul>
        {diffs.map((diff, index) => (
          <li key={`${diff.file ?? "file"}:${index}`} className="session-diff-file">
            <div className="session-diff-heading">
              <code>{diff.file ?? "File path not provided"}</code>
              {diff.status && <span>{diff.status}</span>}
              <span>
                +{diff.additions} −{diff.deletions}
              </span>
            </div>
            <DiffPatchBody patch={diff.patch} />
          </li>
        ))}
      </ul>
    </details>
  );
}

function DiffPatchBody({ patch }: { patch?: string }) {
  if (patch === undefined || patch.trim() === "") {
    return <p className="session-diff-missing">Patch not provided</p>;
  }
  const hunks = parseUnifiedPatch(patch);
  if (!hunks) {
    return <pre className="session-diff-raw">{patch}</pre>;
  }
  return (
    <div className="session-diff-body">
      {hunks.map((hunk, hunkIndex) => (
        <div key={hunkIndex} className="session-diff-hunk">
          <div className="session-diff-hunk-header">{hunk.header}</div>
          {hunk.rows.map((row, rowIndex) => (
            <div
              key={rowIndex}
              className={`session-diff-line session-diff-${row.kind}`}
            >
              <span className="session-diff-gutter session-diff-gutter-old">
                {row.oldNumber ?? ""}
              </span>
              <span className="session-diff-gutter session-diff-gutter-new">
                {row.newNumber ?? ""}
              </span>
              <span className="session-diff-marker">
                {row.kind === "addition"
                  ? "+"
                  : row.kind === "deletion"
                    ? "-"
                    : row.kind === "context"
                      ? " "
                      : ""}
              </span>
              <span className="session-diff-content">
                {row.kind === "nonewline" ? row.text : row.text.slice(1)}
              </span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
