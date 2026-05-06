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
] as const;

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

/**
 * Schema enum for ToolCallState.status is ["done"] only. Real values include
 * "errored", "canceled", "generating", "generated", "calling". Coerce all to
 * "done" to satisfy the schema; failure detail is preserved inside output[].
 */
function coerceStatus(_status: unknown): "done" {
  return "done";
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
  return {
    status: coerceStatus(s?.status),
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
  };
}

function sanitizePromptLog(p: any): Record<string, unknown> {
  return (pick(p, PROMPT_LOG_KEYS) ?? {}) as Record<string, unknown>;
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
  };
  if (states) out.toolCallStates = states.map(sanitizeToolCallState);
  if (Array.isArray(item?.promptLogs)) {
    out.promptLogs = item.promptLogs.map(sanitizePromptLog);
  }
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
  return {
    src: COUCHBASE_SOURCE,
    sessionId: session.sessionId,
    title: session.title,
    workspaceDirectory: session.workspaceDirectory,
    chatHistory: (session.history ?? []).map(sanitizeHistoryItem),
  };
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
        const patchBody = rev ? { ...body, _rev: rev } : body;

        const patchResponse = await fetch(url, {
          method: "PATCH",
          headers: {
            Authorization: authHeader,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(patchBody),
        });

        let extra: string | undefined;
        if (patchResponse.status === 201) {
          try {
            const patchJson = (await patchResponse.json()) as Record<
              string,
              any
            >;
            if (patchJson?._rev) {
              extra = `(rev=${patchJson._rev})`;
            }
          } catch {
            // ignore body parse errors
          }
        }
        debug("PATCH", url, patchResponse.status, extra);
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
