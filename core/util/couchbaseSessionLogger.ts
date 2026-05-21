import { Session } from "../index.js";

export interface CouchbaseConfig {
  endpoint: string; // CB_APP_ENDPOINT, trimmed of trailing slash
  username: string; // CB_APP_USERNAME
  password: string; // CB_APP_PASSWORD
}

const COUCHBASE_SOURCE = "continue-vscode";

/**
 * Returns null when env is incomplete (logger becomes a no-op).
 */
export function loadCouchbaseConfig(): CouchbaseConfig | null {
  const endpoint = process.env.CB_APP_ENDPOINT?.trim();
  const username = process.env.CB_APP_USERNAME?.trim();
  const password = process.env.CB_APP_PASSWORD?.trim();

  console.log("[loadCouchbaseConfig] Loaded config:", {
    endpoint: endpoint ? `${endpoint.slice(0, 20)}...` : null,
    username: username ? `${username.slice(0, 3)}...` : null,
    password: password ? "******" : null,
  });

  if (!endpoint || !username || !password) {
    return null;
  }

  return {
    endpoint: endpoint.endsWith("/") ? endpoint.slice(0, -1) : endpoint,
    username,
    password,
  };
}

// ---------------------------------------------------------------------------
// Schema-aligned sanitizers
//
// The wire payload sent to Couchbase must conform strictly to
// .grokcoder/chat-session-history-schema.json. The helpers below project the
// in-memory Session/ChatHistoryItem shape onto exactly the schema's keys and
// drop everything else (PouchDB metadata, Continue-specific extras such as
// editorState/appliedRules/isGatheringContext, ContextItem.uri, etc.).
// ---------------------------------------------------------------------------

const MESSAGE_KEYS = [
  "id",
  "role",
  "content",
  "toolCalls",
  "toolCallId",
] as const;
const TOOL_CALL_KEYS = ["id", "type", "function"] as const;
const CONTEXT_ITEM_KEYS = ["name", "description", "content", "id"] as const;
const TOOL_DEF_KEYS = [
  "displayTitle",
  "function",
  "readonly",
  "type",
  "uri",
  "group",
  "originalFunctionName",
] as const;
const TOOL_OUTPUT_KEYS = ["name", "description", "content"] as const;
const PROMPT_LOG_KEYS = [
  "modelTitle",
  "modelProvider",
  "prompt",
  "completion",
  "promptTokens",
  "completionTokens",
] as const;

// Sentinel values for missing data
const NA_STRING = "N/A";
const NA_INT = -1;

function pick(
  obj: any,
  keys: readonly string[],
): Record<string, unknown> | undefined {
  if (!obj || typeof obj !== "object") return undefined;
  const out: Record<string, unknown> = {};
  for (const k of keys) {
    if (obj[k] !== undefined) out[k] = obj[k];
  }
  return out;
}

function sanitizeContent(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (p) =>
          p &&
          typeof p === "object" &&
          (p as any).type === "text" &&
          typeof (p as any).text === "string",
      )
      .map((p: any) => ({ type: "text", text: p.text }));
  }
  return "";
}

function sanitizeMessage(m: any): Record<string, unknown> {
  const picked = (pick(m, MESSAGE_KEYS) ?? {}) as Record<string, unknown>;
  if ("content" in picked) {
    picked.content = sanitizeContent(picked.content);
  }
  if (Array.isArray(picked.toolCalls)) {
    picked.toolCalls = (picked.toolCalls as any[]).map((tc: any) => {
      const out: Record<string, unknown> = {};
      if (tc?.id !== undefined) out.id = tc.id;
      if (tc?.type !== undefined) out.type = tc.type;
      if (tc?.function) {
        out.function = {
          name: tc.function.name,
          arguments: tc.function.arguments,
        };
      }
      return out;
    });
  }
  return picked;
}

function sanitizeContextItem(c: any): Record<string, unknown> {
  const picked = (pick(c, CONTEXT_ITEM_KEYS) ?? {}) as Record<string, unknown>;
  if (c?.id) {
    picked.id = {
      providerTitle: c.id.providerTitle,
      itemId: c.id.itemId,
    };
  }
  return picked;
}

type SchemaStatus = "done" | "errored" | "canceled";

/**
 * Normalize runtime status to schema whitelist. Status values "errored" and
 * "canceled" are preserved. Transient states (generating/generated/calling)
 * normalize to "done" because by the time a session is logged, they should
 * never persist; if they do, treating them as success keeps validation green.
 */
function normalizeStatus(status: unknown): SchemaStatus {
  if (status === "errored" || status === "canceled") return status;
  // generating / generated / calling / undefined → done (terminal success)
  return "done";
}

export interface ToolCallError {
  code: string; // "ANALYSIS_FAILED" | "UNKNOWN"
  message: string; // human-readable
  rawStatus: string; // original runtime status, verbatim
  rawOutput: string; // first output[].content as string
}

/**
 * Extract structured error from an errored/canceled ToolCallState.
 * Parses the JSON envelope embedded in output[0].content by the runtime.
 * Returns undefined for non-error states.
 */
function extractToolCallError(state: any): ToolCallError | undefined {
  if (state?.status !== "errored" && state?.status !== "canceled")
    return undefined;

  const first = Array.isArray(state?.output) ? state.output[0] : undefined;
  const rawOutput = typeof first?.content === "string" ? first.content : "";

  // Runtime format: `<tool> failed with the message: [{"type":"text","text":"{...json...}"}]`
  let code = "UNKNOWN";
  let message = rawOutput || "N/A";

  const jsonMatch = rawOutput.match(/"text"\s*:\s*"({.*?})"/s);
  if (jsonMatch) {
    try {
      const inner = JSON.parse(
        jsonMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"),
      );
      if (typeof inner?.code === "string") code = inner.code;
      if (typeof inner?.message === "string") message = inner.message;
    } catch {
      // fall through with rawOutput as message
    }
  }

  return {
    code,
    message,
    rawStatus: typeof state.status === "string" ? state.status : "N/A",
    rawOutput: rawOutput || "N/A",
  };
}

function sanitizeToolDefinition(t: any): Record<string, unknown> {
  const picked = (pick(t, TOOL_DEF_KEYS) ?? {}) as Record<string, unknown>;
  if (t?.function) {
    picked.function = {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    };
  }
  return picked;
}

function sanitizeToolOutput(o: any): Record<string, unknown> {
  return (pick(o, TOOL_OUTPUT_KEYS) ?? {}) as Record<string, unknown>;
}

function sanitizeToolCallState(s: any): Record<string, unknown> {
  const error = extractToolCallError(s);
  return {
    status: normalizeStatus(s?.status),
    toolCall: {
      id: s?.toolCall?.id,
      type: s?.toolCall?.type,
      function: s?.toolCall?.function && {
        name: s.toolCall.function.name,
        arguments: s.toolCall.function.arguments,
      },
    },
    toolCallId: s?.toolCallId,
    parsedArgs: s?.parsedArgs ?? {},
    tool: sanitizeToolDefinition(s?.tool),
    output: Array.isArray(s?.output) ? s.output.map(sanitizeToolOutput) : [],
    timing: sanitizeTiming(s?.timing),
    usage: sanitizeUsage(s?.usage),
    ...(error ? { error } : {}),
  };
}

function sanitizePromptLog(p: any): Record<string, unknown> {
  return (pick(p, PROMPT_LOG_KEYS) ?? {}) as Record<string, unknown>;
}

/**
 * Sanitize timing object: convert epoch ms to ISO date-time strings,
 * compute durationMs, and use sentinel values for missing data.
 *
 * Invalid intervals (endedAt < startedAt) report -1 rather than clamping
 * to 0, so downstream aggregators can distinguish "no data" from a
 * genuinely zero-length interval.
 */
function sanitizeTiming(t: any): Record<string, unknown> {
  const startedAtMs =
    typeof t?.startedAt === "number" ? t.startedAt : undefined;
  const endedAtMs = typeof t?.endedAt === "number" ? t.endedAt : undefined;
  const hasInterval =
    startedAtMs !== undefined &&
    endedAtMs !== undefined &&
    endedAtMs >= startedAtMs;
  return {
    startedAt:
      startedAtMs !== undefined
        ? new Date(startedAtMs).toISOString()
        : NA_STRING,
    endedAt:
      endedAtMs !== undefined ? new Date(endedAtMs).toISOString() : NA_STRING,
    durationMs: hasInterval ? endedAtMs! - startedAtMs! : NA_INT,
  };
}

/**
 * Sanitize usage object: extract token counts and apply sentinel values.
 * Accepts BOTH the normalized camelCase `Usage` shape used in `Session.usage`
 * / `ChatHistoryItem.usage` AND the raw provider snake_case shape that the CLI
 * stores when it assigns `fullUsage = chunk.usage` from the OpenAI-style stream
 * (`prompt_tokens`, `completion_tokens`, `prompt_tokens_details.cache_read_tokens`,
 * etc.). Without the snake_case fallback, every per-turn `usage` written by the
 * CLI sanitizes to -1.
 *
 * Prefers the provider-reported `totalTokens` when present (it may include
 * reasoning/cached tokens beyond prompt + completion); otherwise derives
 * it from promptTokens + completionTokens when both are ≥ 0.
 */
function sanitizeUsage(u: any): Record<string, unknown> {
  const pickNum = (...vals: unknown[]): number => {
    for (const v of vals) if (typeof v === "number") return v;
    return NA_INT;
  };

  const promptDetails = u?.promptTokensDetails ?? u?.prompt_tokens_details;
  const completionDetails =
    u?.completionTokensDetails ?? u?.completion_tokens_details;

  const p = pickNum(u?.promptTokens, u?.prompt_tokens);
  const c = pickNum(u?.completionTokens, u?.completion_tokens);
  const reportedTotalRaw = u?.totalTokens ?? u?.total_tokens;
  const reportedTotal =
    typeof reportedTotalRaw === "number" ? reportedTotalRaw : undefined;
  const totalTokens =
    reportedTotal !== undefined
      ? reportedTotal
      : p >= 0 && c >= 0
        ? p + c
        : NA_INT;

  const out: Record<string, unknown> = {
    promptTokens: p,
    completionTokens: c,
    totalTokens,
  };

  // Optional fields: only include if present and numeric
  const cached = promptDetails?.cachedTokens ?? promptDetails?.cached_tokens;
  if (typeof cached === "number") {
    out.cachedTokens = cached;
  }
  const cacheRead =
    promptDetails?.cacheReadTokens ?? promptDetails?.cache_read_tokens;
  if (typeof cacheRead === "number") {
    out.cacheReadTokens = cacheRead;
  }
  const cacheWrite =
    promptDetails?.cacheWriteTokens ?? promptDetails?.cache_write_tokens;
  if (typeof cacheWrite === "number") {
    out.cacheWriteTokens = cacheWrite;
  }
  const reasoning =
    completionDetails?.reasoningTokens ?? completionDetails?.reasoning_tokens;
  if (typeof reasoning === "number") {
    out.reasoningTokens = reasoning;
  }

  // Optional cost & model identity (when present at the per-turn or session level).
  // CLI stores `cost_cents` on `fullUsage`; convert back to dollars for `totalCost`.
  if (typeof u?.totalCost === "number") {
    out.totalCost = u.totalCost;
  } else if (typeof u?.cost_cents === "number") {
    out.totalCost = u.cost_cents / 100;
  }
  if (typeof u?.model === "string" && u.model.length > 0) {
    out.model = u.model;
  }
  const provider = u?.modelProvider ?? u?.model_provider;
  if (typeof provider === "string" && provider.length > 0) {
    out.modelProvider = provider;
  }

  return out;
}

/**
 * Build the top-level `sessionUsage` object from `Session.usage` (`SessionUsage`).
 * Returns undefined when no usage is present, so the field is omitted from the
 * Couchbase document rather than emitted with sentinels.
 */
function sanitizeSessionUsage(u: any): Record<string, unknown> | undefined {
  if (!u || typeof u !== "object") return undefined;
  return sanitizeUsage(u);
}

function sanitizeHistoryItem(item: any): Record<string, unknown> {
  // Accept either toolCallStates[] (persisted) or toolCallState (in-memory singular)
  const states = Array.isArray(item?.toolCallStates)
    ? item.toolCallStates
    : item?.toolCallState
      ? [item.toolCallState]
      : undefined;

  const out: Record<string, unknown> = {
    message: sanitizeMessage(item?.message),
    contextItems: Array.isArray(item?.contextItems)
      ? item.contextItems.map(sanitizeContextItem)
      : [],
    timing: sanitizeTiming(item?.timing),
    usage: sanitizeUsage(item?.usage ?? item?.message?.usage),
  };
  if (states) out.toolCallStates = states.map(sanitizeToolCallState);
  if (Array.isArray(item?.promptLogs)) {
    out.promptLogs = item.promptLogs.map(sanitizePromptLog);
  }
  return out;
}

/**
 * Collect session-level summary of all failed tool invocations.
 * One entry per errored/canceled tool call across the whole session.
 */
function collectToolErrors(
  history: any[],
  nowIso: string,
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  history.forEach((item, historyIndex) => {
    const states = Array.isArray(item?.toolCallStates)
      ? item.toolCallStates
      : [];
    for (const state of states) {
      const err = extractToolCallError(state);
      if (!err) continue;
      out.push({
        historyIndex,
        toolCallId: state?.toolCallId ?? "N/A",
        toolName:
          state?.toolCall?.function?.name ??
          state?.tool?.function?.name ??
          "N/A",
        code: err.code,
        message: err.message,
        created_at: nowIso,
      });
    }
  });
  return out;
}

/**
 * Build the Capella document body from a Session, matching the JSON schema
 * exactly. Emits only the schema's required top-level keys; all Continue- and
 * PouchDB-specific extras are dropped.
 */
export function buildSessionDocument(
  session: Session,
): Record<string, unknown> {
  const nowIso = new Date().toISOString();
  const sanitizedHistory = (session.history ?? []).map(sanitizeHistoryItem);
  const doc: Record<string, unknown> = {
    src: COUCHBASE_SOURCE,
    sessionId: session.sessionId,
    title: session.title,
    workspaceDirectory: session.workspaceDirectory,
    chatHistory: sanitizedHistory,
  };
  if (session.error !== undefined) {
    doc.error = {
      fileName: session.error.fileName,
      filePath: session.error.filePath,
      lineNumber: session.error.lineNumber,
      message: session.error.message,
      stack: session.error.stack,
      extensionVersion: session.error.extensionVersion,
      extensionCommit: session.error.extensionCommit,
      created_at: nowIso,
    };
  }
  const toolErrors = collectToolErrors(session.history ?? [], nowIso);
  if (toolErrors.length > 0) doc.toolErrors = toolErrors;
  const sessionUsage = sanitizeSessionUsage((session as any).usage);
  if (sessionUsage) doc.sessionUsage = sessionUsage;
  return doc;
}

const debug = (
  method: string,
  url: string,
  status: number | string,
  extra?: string,
) =>
  console.debug(
    `[CouchbaseSessionLogger] ${method} ${url} -> ${status}${extra ? ` ${extra}` : ""}`,
  );

/**
 * GET → PUT/PATCH the session document. Never throws.
 */
export async function logSessionToCouchbase(session: Session): Promise<void> {
  try {
    const cfg = loadCouchbaseConfig();
    if (!cfg) {
      return; // No-op when unconfigured
    }

    const url = `${cfg.endpoint}/${encodeURIComponent(session.sessionId)}`;
    const body = buildSessionDocument(session);
    const authHeader = `Basic ${Buffer.from(`${cfg.username}:${cfg.password}`).toString("base64")}`;

    try {
      // Step 1: GET to check existence and fetch _rev
      const getResponse = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
      });

      debug("GET", url, getResponse.status);

      if (getResponse.status === 200) {
        // Document exists — PATCH with _rev attached on the wire only,
        // keeping buildSessionDocument's output schema-pure.
        let existingDoc: Record<string, any> | undefined;
        try {
          existingDoc = (await getResponse.json()) as Record<string, any>;
        } catch {
          // Malformed JSON — treat as missing and fall through to PUT
          debug(
            "GET",
            url,
            getResponse.status,
            "body parse error, falling back to PUT",
          );
        }

        if (existingDoc === undefined) {
          const putResponse = await fetch(url, {
            method: "PUT",
            headers: {
              Authorization: authHeader,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(body),
          });
          debug("PUT (fallback)", url, putResponse.status);
          return;
        }

        const rev = existingDoc?._rev;
        const updateUrl = rev ? `${url}?rev=${encodeURIComponent(rev)}` : url;
        const updateBody = rev ? { ...body, _rev: rev } : body;

        const updateResponse = await fetch(updateUrl, {
          method: "PUT",
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(updateBody),
        });

        let extra: string | undefined;
        if (updateResponse.status === 201) {
          try {
            const updateJson = (await updateResponse.json()) as Record<
              string,
              any
            >;
            if (updateJson?.rev) {
              extra = `(rev=${updateJson.rev})`;
            } else if (updateJson?._rev) {
              extra = `(rev=${updateJson._rev})`;
            }
          } catch {
            // ignore body parse errors
          }
        }
        debug("PUT (update)", updateUrl, updateResponse.status, extra);
      } else if (getResponse.status === 404) {
        // Document doesn't exist — PUT
        const putResponse = await fetch(url, {
          method: "PUT",
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });

        debug("PUT", url, putResponse.status);
      }
      // Other status codes (401/403/5xx, etc.) — already logged above; return without writing.
    } catch (error) {
      console.debug(
        "[CouchbaseSessionLogger] error",
        error instanceof Error ? error.message : error,
      );
    }
  } catch (error) {
    console.debug(
      "[CouchbaseSessionLogger] error",
      error instanceof Error ? error.message : error,
    );
  }
}
