import * as path from "path";
import { getExtensionInfo } from "./extensionInfo.js";

/**
 * Schema-aligned error block for Session.error. Mirrors the shape required by
 * .grokcoder/guides/chat-session-history-schema.json (keys: fileName,
 * filePath, lineNumber, message, stack, extensionVersion, extensionCommit —
 * all required when present).
 */
export interface SessionErrorInfo {
  fileName: string;
  filePath: string;
  lineNumber: number;
  message: string;
  stack: string;
  extensionVersion: string;
  extensionCommit: string;
}

const NA_STRING = "N/A";
const NA_LINE = -1;

/**
 * Parses a single stack frame line such as:
 *   "    at HistoryManager.save (/abs/path/history.ts:132:5)"
 *   "    at /abs/path/history.ts:132:5"
 * Returns the absolute file path and 1-based line number, or null if the line
 * cannot be parsed.
 */
function parseStackFrame(
  line: string,
): { filePath: string; lineNumber: number } | null {
  // Frame with parens: "at fnName (path:line:col)"
  let match = line.match(/\s+at\s+.*?\(([^)]+):(\d+):\d+\)\s*$/);
  if (!match) {
    // Frame without parens: "at path:line:col"
    match = line.match(/\s+at\s+([^\s][^\s:]*?):(\d+):\d+\s*$/);
  }
  if (!match) {
    return null;
  }
  const filePath = match[1];
  const lineNumber = Number.parseInt(match[2], 10);
  if (!Number.isFinite(lineNumber)) {
    return null;
  }
  return { filePath, lineNumber };
}

function isInternalFrame(filePath: string): boolean {
  return (
    filePath.startsWith("node:") ||
    filePath.startsWith("internal/") ||
    filePath.includes("/node:internal/") ||
    filePath.includes("\\node:internal\\")
  );
}

/**
 * Convert any thrown value into a schema-conformant error block.
 * - Falls back to "N/A" for missing string fields.
 * - Falls back to -1 for an unknown line number (the schema requires integer).
 * - Includes extensionVersion and extensionCommit from build-time env vars.
 */
export function toSessionErrorInfo(err: unknown): SessionErrorInfo {
  let message = NA_STRING;
  let stack = NA_STRING;

  if (err instanceof Error) {
    message = err.message || NA_STRING;
    stack = err.stack || NA_STRING;
  } else if (typeof err === "string") {
    message = err || NA_STRING;
  } else if (err && typeof err === "object") {
    const anyErr = err as { message?: unknown; stack?: unknown };
    if (typeof anyErr.message === "string" && anyErr.message.length > 0) {
      message = anyErr.message;
    } else {
      try {
        message = JSON.stringify(err);
      } catch {
        message = String(err);
      }
    }
    if (typeof anyErr.stack === "string" && anyErr.stack.length > 0) {
      stack = anyErr.stack;
    }
  } else if (err !== undefined && err !== null) {
    message = String(err);
  }

  let fileName = NA_STRING;
  let filePath = NA_STRING;
  let lineNumber = NA_LINE;

  if (stack !== NA_STRING) {
    const lines = stack.split("\n");
    for (const line of lines) {
      if (!/\s+at\s+/.test(line)) continue;
      const parsed = parseStackFrame(line);
      if (!parsed) continue;
      if (isInternalFrame(parsed.filePath)) continue;
      filePath = parsed.filePath;
      lineNumber = parsed.lineNumber;
      try {
        fileName = path.basename(parsed.filePath) || NA_STRING;
      } catch {
        fileName = NA_STRING;
      }
      break;
    }
  }

  const { extensionVersion, extensionCommit } = getExtensionInfo();

  return {
    fileName,
    filePath,
    lineNumber,
    message,
    stack,
    extensionVersion,
    extensionCommit,
  };
}
