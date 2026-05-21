import { Session } from "../index.js";
import {
  buildSessionDocument,
  loadCouchbaseConfig,
} from "./couchbaseSessionLogger.js";

describe("couchbaseSessionLogger", () => {
  beforeEach(() => {
    delete process.env.CB_APP_ENDPOINT;
    delete process.env.CB_APP_USERNAME;
    delete process.env.CB_APP_PASSWORD;
  });

  describe("loadCouchbaseConfig", () => {
    test("returns null when env vars are missing", () => {
      expect(loadCouchbaseConfig()).toBeNull();
    });

    test("returns null when only endpoint is set", () => {
      process.env.CB_APP_ENDPOINT = "https://example.com";
      expect(loadCouchbaseConfig()).toBeNull();
    });

    test("returns null when only username is set", () => {
      process.env.CB_APP_USERNAME = "user";
      expect(loadCouchbaseConfig()).toBeNull();
    });

    test("returns null when only password is set", () => {
      process.env.CB_APP_PASSWORD = "pass";
      expect(loadCouchbaseConfig()).toBeNull();
    });

    test("returns config when all env vars are set", () => {
      process.env.CB_APP_ENDPOINT = "https://example.com/api";
      process.env.CB_APP_USERNAME = "testuser";
      process.env.CB_APP_PASSWORD = "testpass";

      expect(loadCouchbaseConfig()).toEqual({
        endpoint: "https://example.com/api",
        username: "testuser",
        password: "testpass",
      });
    });

    test("trims whitespace from env vars", () => {
      process.env.CB_APP_ENDPOINT = "  https://example.com  ";
      process.env.CB_APP_USERNAME = "  user  ";
      process.env.CB_APP_PASSWORD = "  pass  ";

      expect(loadCouchbaseConfig()).toEqual({
        endpoint: "https://example.com",
        username: "user",
        password: "pass",
      });
    });

    test("removes trailing slash from endpoint", () => {
      process.env.CB_APP_ENDPOINT = "https://example.com/api/";
      process.env.CB_APP_USERNAME = "user";
      process.env.CB_APP_PASSWORD = "pass";

      expect(loadCouchbaseConfig()?.endpoint).toBe("https://example.com/api");
    });
  });

  describe("buildSessionDocument", () => {
    const baseSession: Session = {
      sessionId: "test-session-123",
      title: "Test Session",
      workspaceDirectory: "/path/to/workspace",
      history: [],
      mode: "chat",
      chatModelTitle: "GPT-4",
      usage: {
        completionTokens: 500,
        promptTokens: 500,
        totalTokens: 1000,
        totalCost: 0.05,
      } as any,
    };

    test("emits exactly the schema's required top-level keys plus sessionUsage when present", () => {
      const doc = buildSessionDocument(baseSession);
      // baseSession has usage defined, so sessionUsage is emitted.
      expect(Object.keys(doc).sort()).toEqual([
        "chatHistory",
        "sessionId",
        "sessionUsage",
        "src",
        "title",
        "workspaceDirectory",
      ]);
    });

    test("omits sessionUsage when session.usage is absent", () => {
      const session: Session = { ...baseSession, usage: undefined };
      const doc = buildSessionDocument(session);
      expect((doc as any).sessionUsage).toBeUndefined();
      expect(Object.keys(doc).sort()).toEqual([
        "chatHistory",
        "sessionId",
        "src",
        "title",
        "workspaceDirectory",
      ]);
    });

    test("includes the required field values", () => {
      const doc = buildSessionDocument(baseSession);
      expect(doc.src).toBe("continue-vscode");
      expect(doc.sessionId).toBe("test-session-123");
      expect(doc.title).toBe("Test Session");
      expect(doc.workspaceDirectory).toBe("/path/to/workspace");
      expect(doc.chatHistory).toEqual([]);
    });

    test("renames `history` -> `chatHistory` and preserves item count", () => {
      const session: Session = {
        ...baseSession,
        history: [
          {
            message: { role: "user", content: "Hello" },
            contextItems: [],
          } as any,
          {
            message: { role: "assistant", content: "Hi" },
            contextItems: [],
          } as any,
        ],
      };
      const doc = buildSessionDocument(session);
      expect(Array.isArray(doc.chatHistory)).toBe(true);
      expect((doc.chatHistory as unknown[]).length).toBe(2);
      expect((doc as any).history).toBeUndefined();
    });

    test("drops Continue/PouchDB extras at the top level", () => {
      const doc = buildSessionDocument(baseSession);
      expect((doc as any).mode).toBeUndefined();
      expect((doc as any).chatModelTitle).toBeUndefined();
      // Note: `usage` is intentionally surfaced as the schema-aligned `sessionUsage`.
      expect((doc as any).usage).toBeUndefined();
      expect((doc as any)._id).toBeUndefined();
      expect((doc as any)._rev).toBeUndefined();
      expect((doc as any)._cv).toBeUndefined();
    });

    test("strips appliedRules / editorState / isGatheringContext from history items", () => {
      const session: Session = {
        ...baseSession,
        history: [
          {
            message: { role: "user", content: "Hi" },
            contextItems: [],
            appliedRules: [],
            editorState: { type: "doc", content: [] },
            isGatheringContext: false,
          } as any,
        ],
      };
      const doc = buildSessionDocument(session);
      const item = (doc.chatHistory as any[])[0];
      // appliedRules / editorState / isGatheringContext are stripped;
      // timing/usage are always emitted (sentinels when absent).
      expect(Object.keys(item).sort()).toEqual([
        "contextItems",
        "message",
        "timing",
        "usage",
      ]);
    });

    test("sanitizes ContextItem to schema's four required fields", () => {
      const session: Session = {
        ...baseSession,
        history: [
          {
            message: { role: "user", content: "Hi" },
            contextItems: [
              {
                content: "file body",
                description: "test.js",
                name: "test.js",
                id: { itemId: "abc", providerTitle: "file" },
                uri: { type: "file", value: "file:///x" },
                icon: "file",
                editable: true,
                hidden: false,
              } as any,
            ],
          } as any,
        ],
      };
      const doc = buildSessionDocument(session);
      const ctx = (doc.chatHistory as any[])[0].contextItems[0];
      expect(Object.keys(ctx).sort()).toEqual([
        "content",
        "description",
        "id",
        "name",
      ]);
      expect(ctx.id).toEqual({ providerTitle: "file", itemId: "abc" });
    });

    test("sanitizes Message: keeps schema keys, drops extras", () => {
      const session: Session = {
        ...baseSession,
        history: [
          {
            message: {
              id: "msg-1",
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  id: "call_1",
                  type: "function",
                  function: { name: "foo", arguments: "{}" },
                  extraneous: "DROP_ME",
                },
              ],
              extraneousField: "DROP_ME",
            } as any,
            contextItems: [],
          } as any,
        ],
      };
      const doc = buildSessionDocument(session);
      const msg = (doc.chatHistory as any[])[0].message;
      expect(msg.extraneousField).toBeUndefined();
      expect(msg.toolCalls[0].extraneous).toBeUndefined();
      expect(msg.toolCalls[0]).toEqual({
        id: "call_1",
        type: "function",
        function: { name: "foo", arguments: "{}" },
      });
    });

    test("filters non-text parts from array message content", () => {
      const session: Session = {
        ...baseSession,
        history: [
          {
            message: {
              role: "user",
              content: [
                { type: "text", text: "hello" },
                { type: "imageUrl", imageUrl: { url: "x" } },
              ],
            } as any,
            contextItems: [],
          } as any,
        ],
      };
      const doc = buildSessionDocument(session);
      const content = (doc.chatHistory as any[])[0].message.content;
      expect(content).toEqual([{ type: "text", text: "hello" }]);
    });

    test("passes through string message content unchanged", () => {
      const session: Session = {
        ...baseSession,
        history: [
          {
            message: { role: "tool", content: "result", toolCallId: "c1" },
            contextItems: [],
          } as any,
        ],
      };
      const doc = buildSessionDocument(session);
      expect((doc.chatHistory as any[])[0].message.content).toBe("result");
      expect((doc.chatHistory as any[])[0].message.toolCallId).toBe("c1");
    });

    test("normalizeStatus preserves errored/canceled and coerces transient states to done", () => {
      const baseToolCallState = {
        status: "errored",
        toolCall: {
          id: "call_1",
          type: "function",
          function: { name: "foo", arguments: "{}" },
        },
        toolCallId: "call_1",
        parsedArgs: { a: 1 },
        tool: {
          displayTitle: "foo",
          function: { name: "foo", description: "d", parameters: {} },
          readonly: false,
          type: "function",
          uri: "mcp://x/foo",
          group: "g",
          originalFunctionName: "foo",
        },
        output: [{ name: "out", description: "d", content: "x" }],
      };
      const session: Session = {
        ...baseSession,
        history: [
          {
            message: { role: "assistant", content: "" },
            contextItems: [],
            toolCallStates: [
              { ...baseToolCallState, status: "errored" },
              { ...baseToolCallState, status: "canceled" },
              { ...baseToolCallState, status: "generating" },
            ],
          } as any,
        ],
      };
      const doc = buildSessionDocument(session);
      const states = (doc.chatHistory as any[])[0].toolCallStates;
      expect(states.map((s: any) => s.status)).toEqual([
        "errored",
        "canceled",
        "done",
      ]);
    });

    test("strips ToolDefinition extras and keeps the seven required keys", () => {
      const session: Session = {
        ...baseSession,
        history: [
          {
            message: { role: "assistant", content: "" },
            contextItems: [],
            toolCallStates: [
              {
                status: "done",
                toolCall: {
                  id: "c1",
                  type: "function",
                  function: { name: "foo", arguments: "{}" },
                },
                toolCallId: "c1",
                parsedArgs: {},
                tool: {
                  displayTitle: "foo",
                  function: { name: "foo", description: "d", parameters: {} },
                  readonly: false,
                  type: "function",
                  uri: "mcp://x/foo",
                  group: "g",
                  originalFunctionName: "foo",
                  wouldLikeTo: "DROP_ME",
                  extra: "DROP_ME",
                },
                output: [],
              },
            ],
          } as any,
        ],
      };
      const doc = buildSessionDocument(session);
      const tool = (doc.chatHistory as any[])[0].toolCallStates[0].tool;
      expect(Object.keys(tool).sort()).toEqual([
        "displayTitle",
        "function",
        "group",
        "originalFunctionName",
        "readonly",
        "type",
        "uri",
      ]);
    });

    test("strips ToolOutput extras (hidden/icon)", () => {
      const session: Session = {
        ...baseSession,
        history: [
          {
            message: { role: "assistant", content: "" },
            contextItems: [],
            toolCallStates: [
              {
                status: "errored",
                toolCall: {
                  id: "c1",
                  type: "function",
                  function: { name: "foo", arguments: "{}" },
                },
                toolCallId: "c1",
                parsedArgs: {},
                tool: {
                  displayTitle: "foo",
                  function: { name: "foo", description: "d", parameters: {} },
                  readonly: false,
                  type: "function",
                  uri: "mcp://x/foo",
                  group: "g",
                  originalFunctionName: "foo",
                },
                output: [
                  {
                    name: "Tool Call Error",
                    description: "Tool Call Failed",
                    content: "boom",
                    hidden: false,
                    icon: "problems",
                  },
                ],
              },
            ],
          } as any,
        ],
      };
      const doc = buildSessionDocument(session);
      const out = (doc.chatHistory as any[])[0].toolCallStates[0].output[0];
      expect(Object.keys(out).sort()).toEqual([
        "content",
        "description",
        "name",
      ]);
    });

    test("strips PromptLog extras (e.g. completionOptions)", () => {
      const session: Session = {
        ...baseSession,
        history: [
          {
            message: { role: "assistant", content: "" },
            contextItems: [],
            promptLogs: [
              {
                modelTitle: "Grok",
                modelProvider: "xAI",
                prompt: "p",
                completion: "c",
                completionOptions: { model: "grok" },
              } as any,
            ],
          } as any,
        ],
      };
      const doc = buildSessionDocument(session);
      const log = (doc.chatHistory as any[])[0].promptLogs[0];
      expect(Object.keys(log).sort()).toEqual([
        "completion",
        "modelProvider",
        "modelTitle",
        "prompt",
      ]);
    });

    test("normalizes singular toolCallState -> plural toolCallStates", () => {
      const session: Session = {
        ...baseSession,
        history: [
          {
            message: { role: "assistant", content: "" },
            contextItems: [],
            toolCallState: {
              status: "done",
              toolCall: {
                id: "c1",
                type: "function",
                function: { name: "foo", arguments: "{}" },
              },
              toolCallId: "c1",
              parsedArgs: {},
              tool: {
                displayTitle: "foo",
                function: { name: "foo", description: "d", parameters: {} },
                readonly: false,
                type: "function",
                uri: "mcp://x/foo",
                group: "g",
                originalFunctionName: "foo",
              },
              output: [],
            },
          } as any,
        ],
      };
      const doc = buildSessionDocument(session);
      const item = (doc.chatHistory as any[])[0];
      expect(Array.isArray(item.toolCallStates)).toBe(true);
      expect(item.toolCallStates.length).toBe(1);
      expect(item.toolCallState).toBeUndefined();
    });

    test("produces a JSON-serializable document with special sessionId chars", () => {
      const session: Session = {
        ...baseSession,
        sessionId: "test/session?id=123&foo=bar",
      };
      const doc = buildSessionDocument(session);
      expect(doc.sessionId).toBe("test/session?id=123&foo=bar");
      expect(() => JSON.stringify(doc)).not.toThrow();
    });

    test("includes the schema-aligned error block when session.error is set", () => {
      const session: Session = {
        ...baseSession,
        error: {
          fileName: "history.ts",
          filePath: "/abs/core/util/history.ts",
          lineNumber: 132,
          message: "ENOSPC: no space left on device",
          stack: "Error: ENOSPC...\n    at HistoryManager.save (...:132:5)",
          extensionVersion: "1.3.39",
          extensionCommit: "affc6394f09964950387c286ff8b28c610f88736",
        },
      };
      const doc = buildSessionDocument(session);
      const { created_at, ...errorWithoutTimestamp } = (doc as any).error;
      expect(errorWithoutTimestamp).toEqual({
        fileName: "history.ts",
        filePath: "/abs/core/util/history.ts",
        lineNumber: 132,
        message: "ENOSPC: no space left on device",
        stack: "Error: ENOSPC...\n    at HistoryManager.save (...:132:5)",
        extensionVersion: "1.3.39",
        extensionCommit: "affc6394f09964950387c286ff8b28c610f88736",
      });
      // Schema requires all eight keys when `error` is present
      expect(Object.keys((doc as any).error).sort()).toEqual([
        "created_at",
        "extensionCommit",
        "extensionVersion",
        "fileName",
        "filePath",
        "lineNumber",
        "message",
        "stack",
      ]);
    });

    test("error.created_at is an ISO 8601 UTC timestamp with millisecond precision", () => {
      const session: Session = {
        ...baseSession,
        error: {
          fileName: "history.ts",
          filePath: "/abs/core/util/history.ts",
          lineNumber: 132,
          message: "ENOSPC",
          stack: "Error: ENOSPC...",
          extensionVersion: "1.3.39",
          extensionCommit: "abc",
        },
      };
      const doc = buildSessionDocument(session);
      const ts = (doc as any).error.created_at;
      expect(typeof ts).toBe("string");
      expect(ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    });

    test("error.created_at uses the deterministic system time", () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date("2026-05-13T17:42:09.123Z"));
      try {
        const session: Session = {
          ...baseSession,
          error: {
            fileName: "x",
            filePath: "x",
            lineNumber: 1,
            message: "x",
            stack: "x",
            extensionVersion: "x",
            extensionCommit: "x",
          },
        };
        const doc = buildSessionDocument(session);
        expect((doc as any).error.created_at).toBe("2026-05-13T17:42:09.123Z");
      } finally {
        jest.useRealTimers();
      }
    });

    test("supports N/A sentinels (timeout/network errors)", () => {
      const session: Session = {
        ...baseSession,
        error: {
          fileName: "N/A",
          filePath: "N/A",
          lineNumber: -1,
          message: "fetch failed",
          stack: "N/A",
          extensionVersion: "1.3.39",
          extensionCommit: "N/A",
        },
      };
      const doc = buildSessionDocument(session);
      expect((doc as any).error.fileName).toBe("N/A");
      expect((doc as any).error.filePath).toBe("N/A");
      expect((doc as any).error.lineNumber).toBe(-1);
      expect(typeof (doc as any).error.lineNumber).toBe("number");
      expect((doc as any).error.extensionVersion).toBe("1.3.39");
      expect((doc as any).error.extensionCommit).toBe("N/A");
    });

    test("omits the error key entirely when session.error is undefined", () => {
      const doc = buildSessionDocument(baseSession);
      expect("error" in doc).toBe(false);
    });

    test("output omits an undefined message id rather than emitting `undefined`", () => {
      const session: Session = {
        ...baseSession,
        history: [
          {
            message: { role: "user", content: "Hi" },
            contextItems: [],
          } as any,
        ],
      };
      const doc = buildSessionDocument(session);
      const msg = (doc.chatHistory as any[])[0].message;
      expect("id" in msg).toBe(false);
    });

    test("sanitizes an errored state with structured code/message", () => {
      const session: Session = {
        ...baseSession,
        history: [
          {
            message: { role: "assistant", content: "" },
            contextItems: [],
            toolCallStates: [
              {
                status: "errored",
                toolCall: {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "agent_router_analyze_metadata",
                    arguments: "{}",
                  },
                },
                toolCallId: "call_1",
                parsedArgs: {},
                tool: {
                  displayTitle: "foo",
                  function: {
                    name: "agent_router_analyze_metadata",
                    description: "d",
                    parameters: {},
                  },
                  readonly: false,
                  type: "function",
                  uri: "mcp://x/foo",
                  group: "g",
                  originalFunctionName: "foo",
                },
                output: [
                  {
                    name: "Tool Call Error",
                    description: "Tool Call Failed",
                    content:
                      'agent_router_analyze_metadata failed with the message: [{"type":"text","text":"{\\"code\\":\\"ANALYSIS_FAILED\\",\\"message\\":\\"The analyze_metadata tool is currently disabled due to high resource usage. ...\\"}"}]',
                  },
                ],
              },
            ],
          } as any,
        ],
      };
      const doc = buildSessionDocument(session);
      const state = (doc.chatHistory as any[])[0].toolCallStates[0];
      expect(state.status).toBe("errored");
      expect(state.error).toBeDefined();
      expect(state.error.code).toBe("ANALYSIS_FAILED");
      expect(state.error.message).toContain(
        "analyze_metadata tool is currently disabled",
      );
      expect(state.error.rawStatus).toBe("errored");
    });

    test("sanitizes an errored state with malformed output, defaulting to UNKNOWN", () => {
      const session: Session = {
        ...baseSession,
        history: [
          {
            message: { role: "assistant", content: "" },
            contextItems: [],
            toolCallStates: [
              {
                status: "errored",
                toolCall: {
                  id: "call_1",
                  type: "function",
                  function: { name: "foo", arguments: "{}" },
                },
                toolCallId: "call_1",
                parsedArgs: {},
                tool: {
                  displayTitle: "foo",
                  function: { name: "foo", description: "d", parameters: {} },
                  readonly: false,
                  type: "function",
                  uri: "mcp://x/foo",
                  group: "g",
                  originalFunctionName: "foo",
                },
                output: [
                  {
                    name: "Tool Call Error",
                    description: "Tool Call Failed",
                    content: "boom: something went wrong",
                  },
                ],
              },
            ],
          } as any,
        ],
      };
      const doc = buildSessionDocument(session);
      const state = (doc.chatHistory as any[])[0].toolCallStates[0];
      expect(state.error.code).toBe("UNKNOWN");
      expect(state.error.message).toBe("boom: something went wrong");
    });

    test("sanitizes a canceled state", () => {
      const session: Session = {
        ...baseSession,
        history: [
          {
            message: { role: "assistant", content: "" },
            contextItems: [],
            toolCallStates: [
              {
                status: "canceled",
                toolCall: {
                  id: "call_1",
                  type: "function",
                  function: { name: "foo", arguments: "{}" },
                },
                toolCallId: "call_1",
                parsedArgs: {},
                tool: {
                  displayTitle: "foo",
                  function: { name: "foo", description: "d", parameters: {} },
                  readonly: false,
                  type: "function",
                  uri: "mcp://x/foo",
                  group: "g",
                  originalFunctionName: "foo",
                },
                output: [
                  {
                    name: "Tool Call Canceled",
                    description: "User canceled",
                    content: "User pressed cancel",
                  },
                ],
              },
            ],
          } as any,
        ],
      };
      const doc = buildSessionDocument(session);
      const state = (doc.chatHistory as any[])[0].toolCallStates[0];
      expect(state.status).toBe("canceled");
      expect(state.error).toBeDefined();
      expect(state.error.rawStatus).toBe("canceled");
    });

    test("normalizes generating/generated/calling to done with no error", () => {
      const session: Session = {
        ...baseSession,
        history: [
          {
            message: { role: "assistant", content: "" },
            contextItems: [],
            toolCallStates: [
              {
                status: "generating",
                toolCall: {
                  id: "call_1",
                  type: "function",
                  function: { name: "foo", arguments: "{}" },
                },
                toolCallId: "call_1",
                parsedArgs: {},
                tool: {
                  displayTitle: "foo",
                  function: { name: "foo", description: "d", parameters: {} },
                  readonly: false,
                  type: "function",
                  uri: "mcp://x/foo",
                  group: "g",
                  originalFunctionName: "foo",
                },
                output: [],
              },
            ],
          } as any,
        ],
      };
      const doc = buildSessionDocument(session);
      const state = (doc.chatHistory as any[])[0].toolCallStates[0];
      expect(state.status).toBe("done");
      expect("error" in state).toBe(false);
    });

    test("buildSessionDocument collects one toolErrors[] entry per errored tool call", () => {
      const session: Session = {
        ...baseSession,
        history: [
          {
            message: { role: "assistant", content: "" },
            contextItems: [],
            toolCallStates: [
              {
                status: "errored",
                toolCall: {
                  id: "call_1",
                  type: "function",
                  function: {
                    name: "agent_router_analyze_metadata",
                    arguments: "{}",
                  },
                },
                toolCallId: "call_1",
                parsedArgs: {},
                tool: {
                  displayTitle: "foo",
                  function: {
                    name: "agent_router_analyze_metadata",
                    description: "d",
                    parameters: {},
                  },
                  readonly: false,
                  type: "function",
                  uri: "mcp://x/foo",
                  group: "g",
                  originalFunctionName: "foo",
                },
                output: [
                  {
                    name: "Tool Call Error",
                    description: "Tool Call Failed",
                    content:
                      'agent_router_analyze_metadata failed with the message: [{"type":"text","text":"{\\"code\\":\\"ANALYSIS_FAILED\\",\\"message\\":\\"The analyze_metadata tool is currently disabled due to high resource usage. ...\\"}"}]',
                  },
                ],
              },
            ],
          } as any,
        ],
      };
      const doc = buildSessionDocument(session);
      expect("toolErrors" in doc).toBe(true);
      const toolErrors = doc.toolErrors as any[];
      expect(toolErrors.length).toBe(1);
      expect(toolErrors[0].historyIndex).toBe(0);
      expect(toolErrors[0].toolCallId).toBe("call_1");
      expect(toolErrors[0].toolName).toBe("agent_router_analyze_metadata");
      expect(toolErrors[0].code).toBe("ANALYSIS_FAILED");
      expect(toolErrors[0].message).toContain(
        "analyze_metadata tool is currently disabled",
      );
      expect(toolErrors[0].created_at).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
    });

    test("session-level error.created_at and toolErrors[].created_at share a single timestamp", () => {
      const erroredToolCallState = {
        status: "errored",
        toolCall: {
          id: "call_1",
          type: "function",
          function: { name: "foo", arguments: "{}" },
        },
        toolCallId: "call_1",
        parsedArgs: {},
        tool: {
          displayTitle: "foo",
          function: { name: "foo", description: "d", parameters: {} },
          readonly: false,
          type: "function",
          uri: "mcp://x/foo",
          group: "g",
          originalFunctionName: "foo",
        },
        output: [
          {
            name: "Tool Call Error",
            description: "Tool Call Failed",
            content: "boom",
          },
        ],
      };
      const session: Session = {
        ...baseSession,
        error: {
          fileName: "x",
          filePath: "x",
          lineNumber: 1,
          message: "x",
          stack: "x",
          extensionVersion: "x",
          extensionCommit: "x",
        },
        history: [
          {
            message: { role: "assistant", content: "" },
            contextItems: [],
            toolCallStates: [erroredToolCallState, erroredToolCallState],
          } as any,
        ],
      };
      const doc = buildSessionDocument(session);
      const toolErrors = (doc as any).toolErrors as any[];
      expect(toolErrors.length).toBe(2);
      expect(toolErrors[0].created_at).toBe((doc as any).error.created_at);
      expect(toolErrors[1].created_at).toBe((doc as any).error.created_at);
    });

    test("omits toolErrors[] entirely when session has no failures", () => {
      const session: Session = {
        ...baseSession,
        history: [
          {
            message: { role: "assistant", content: "" },
            contextItems: [],
            toolCallStates: [
              {
                status: "done",
                toolCall: {
                  id: "call_1",
                  type: "function",
                  function: { name: "foo", arguments: "{}" },
                },
                toolCallId: "call_1",
                parsedArgs: {},
                tool: {
                  displayTitle: "foo",
                  function: { name: "foo", description: "d", parameters: {} },
                  readonly: false,
                  type: "function",
                  uri: "mcp://x/foo",
                  group: "g",
                  originalFunctionName: "foo",
                },
                output: [],
              },
            ],
          } as any,
        ],
      };
      const doc = buildSessionDocument(session);
      expect("toolErrors" in doc).toBe(false);
    });

    test("sanitizeToolCallState for a done state has no error key", () => {
      const session: Session = {
        ...baseSession,
        history: [
          {
            message: { role: "assistant", content: "" },
            contextItems: [],
            toolCallStates: [
              {
                status: "done",
                toolCall: {
                  id: "call_1",
                  type: "function",
                  function: { name: "foo", arguments: "{}" },
                },
                toolCallId: "call_1",
                parsedArgs: {},
                tool: {
                  displayTitle: "foo",
                  function: { name: "foo", description: "d", parameters: {} },
                  readonly: false,
                  type: "function",
                  uri: "mcp://x/foo",
                  group: "g",
                  originalFunctionName: "foo",
                },
                output: [],
              },
            ],
          } as any,
        ],
      };
      const doc = buildSessionDocument(session);
      const state = (doc.chatHistory as any[])[0].toolCallStates[0];
      expect("error" in state).toBe(false);
    });

    test("emits timing and usage on every chatHistory item with sentinels when missing", () => {
      const now = Date.now();
      const session: Session = {
        ...baseSession,
        history: [
          {
            message: {
              role: "user",
              content: "hello",
              usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 },
            },
            contextItems: [],
            timing: {
              startedAt: now,
              endedAt: now + 1000,
              durationMs: 1000,
            },
          } as any,
          {
            message: { role: "assistant", content: "hi" },
            contextItems: [],
            // Missing timing and usage: should get sentinels
          } as any,
        ],
      };
      const doc = buildSessionDocument(session);
      const history = doc.chatHistory as any[];

      // First item has real timing/usage
      expect(history[0].timing).toBeDefined();
      expect(history[0].timing.durationMs).toBe(1000);
      expect(history[0].timing.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}/); // ISO date
      expect(history[0].usage).toBeDefined();
      expect(history[0].usage.promptTokens).toBe(10);

      // Second item should have sentinels
      expect(history[1].timing).toBeDefined();
      expect(history[1].timing.durationMs).toBe(-1);
      expect(history[1].timing.startedAt).toBe("N/A");
      expect(history[1].usage).toBeDefined();
      expect(history[1].usage.promptTokens).toBe(-1);
      expect(history[1].usage.completionTokens).toBe(-1);
    });

    test("emits timing and usage on every toolCallState with sentinels when missing", () => {
      const now = Date.now();
      const session: Session = {
        ...baseSession,
        history: [
          {
            message: { role: "assistant", content: "" },
            contextItems: [],
            toolCallStates: [
              {
                status: "done",
                toolCall: {
                  id: "call_1",
                  type: "function",
                  function: { name: "foo", arguments: "{}" },
                },
                toolCallId: "call_1",
                parsedArgs: {},
                tool: {
                  displayTitle: "foo",
                  function: { name: "foo", description: "d", parameters: {} },
                  readonly: false,
                  type: "function",
                  uri: "mcp://x/foo",
                  group: "g",
                  originalFunctionName: "foo",
                },
                output: [],
                timing: {
                  startedAt: now,
                  endedAt: now + 500,
                  durationMs: 500,
                },
                usage: {
                  promptTokens: 5,
                  completionTokens: 2,
                  totalTokens: 7,
                },
              },
              {
                status: "done",
                toolCall: {
                  id: "call_2",
                  type: "function",
                  function: { name: "bar", arguments: "{}" },
                },
                toolCallId: "call_2",
                parsedArgs: {},
                tool: {
                  displayTitle: "bar",
                  function: { name: "bar", description: "d", parameters: {} },
                  readonly: false,
                  type: "function",
                  uri: "mcp://x/bar",
                  group: "g",
                  originalFunctionName: "bar",
                },
                output: [],
                // Missing timing and usage
              },
            ],
          } as any,
        ],
      };
      const doc = buildSessionDocument(session);
      const states = (doc.chatHistory as any[])[0].toolCallStates;

      // First tool call has real timing/usage
      expect(states[0].timing).toBeDefined();
      expect(states[0].timing.durationMs).toBe(500);
      expect(states[0].usage.promptTokens).toBe(5);

      // Second tool call should have sentinels
      expect(states[1].timing).toBeDefined();
      expect(states[1].timing.durationMs).toBe(-1);
      expect(states[1].usage.promptTokens).toBe(-1);
    });

    test("durationMs is calculated correctly from startedAt/endedAt", () => {
      const now = Date.now();
      const session: Session = {
        ...baseSession,
        history: [
          {
            message: { role: "user", content: "hi" },
            contextItems: [],
            timing: {
              startedAt: now,
              endedAt: now + 2500,
              durationMs: 2500,
            },
          } as any,
        ],
      };
      const doc = buildSessionDocument(session);
      const item = (doc.chatHistory as any[])[0];
      expect(item.timing.durationMs).toBe(2500);
    });

    test("totalTokens is derived from promptTokens + completionTokens", () => {
      const session: Session = {
        ...baseSession,
        history: [
          {
            message: { role: "user", content: "hi" },
            contextItems: [],
            usage: {
              promptTokens: 100,
              completionTokens: 50,
              totalTokens: 150,
            },
          } as any,
        ],
      };
      const doc = buildSessionDocument(session);
      const item = (doc.chatHistory as any[])[0];
      expect(item.usage.totalTokens).toBe(150);
    });

    test("totalTokens is -1 when either promptTokens or completionTokens is missing", () => {
      const session: Session = {
        ...baseSession,
        history: [
          {
            message: { role: "user", content: "hi" },
            contextItems: [],
            usage: {
              promptTokens: 100,
              completionTokens: undefined,
              totalTokens: undefined,
            },
          } as any,
        ],
      };
      const doc = buildSessionDocument(session);
      const item = (doc.chatHistory as any[])[0];
      expect(item.usage.totalTokens).toBe(-1);
    });

    test("optional cachedTokens and reasoningTokens are included when present", () => {
      const session: Session = {
        ...baseSession,
        history: [
          {
            message: { role: "user", content: "hi" },
            contextItems: [],
            usage: {
              promptTokens: 100,
              completionTokens: 50,
              totalTokens: 150,
              promptTokensDetails: { cachedTokens: 10 },
              completionTokensDetails: { reasoningTokens: 5 },
            },
          } as any,
        ],
      };
      const doc = buildSessionDocument(session);
      const item = (doc.chatHistory as any[])[0];
      expect(item.usage.cachedTokens).toBe(10);
      expect(item.usage.reasoningTokens).toBe(5);
    });

    test("history items include timing and usage in required fields check", () => {
      const now = Date.now();
      const session: Session = {
        ...baseSession,
        history: [
          {
            message: { role: "user", content: "hi" },
            contextItems: [],
            timing: {
              startedAt: now,
              endedAt: now + 1000,
              durationMs: 1000,
            },
            usage: {
              promptTokens: 10,
              completionTokens: 20,
              totalTokens: 30,
            },
          } as any,
        ],
      };
      const doc = buildSessionDocument(session);
      const item = (doc.chatHistory as any[])[0];
      expect(Object.keys(item).sort()).toContain("timing");
      expect(Object.keys(item).sort()).toContain("usage");
      expect(item.timing).toHaveProperty("startedAt");
      expect(item.timing).toHaveProperty("endedAt");
      expect(item.timing).toHaveProperty("durationMs");
      expect(item.usage).toHaveProperty("promptTokens");
      expect(item.usage).toHaveProperty("completionTokens");
      expect(item.usage).toHaveProperty("totalTokens");
    });

    test("toolCallStates include timing and usage in required fields check", () => {
      const now = Date.now();
      const session: Session = {
        ...baseSession,
        history: [
          {
            message: { role: "assistant", content: "" },
            contextItems: [],
            toolCallStates: [
              {
                status: "done",
                toolCall: {
                  id: "call_1",
                  type: "function",
                  function: { name: "foo", arguments: "{}" },
                },
                toolCallId: "call_1",
                parsedArgs: {},
                tool: {
                  displayTitle: "foo",
                  function: { name: "foo", description: "d", parameters: {} },
                  readonly: false,
                  type: "function",
                  uri: "mcp://x/foo",
                  group: "g",
                  originalFunctionName: "foo",
                },
                output: [],
                timing: {
                  startedAt: now,
                  endedAt: now + 500,
                  durationMs: 500,
                },
                usage: {
                  promptTokens: 5,
                  completionTokens: 2,
                  totalTokens: 7,
                },
              },
            ],
          } as any,
        ],
      };
      const doc = buildSessionDocument(session);
      const state = (doc.chatHistory as any[])[0].toolCallStates[0];
      expect(Object.keys(state).sort()).toContain("timing");
      expect(Object.keys(state).sort()).toContain("usage");
      expect(state.timing).toHaveProperty("startedAt");
      expect(state.timing).toHaveProperty("endedAt");
      expect(state.timing).toHaveProperty("durationMs");
      expect(state.usage).toHaveProperty("promptTokens");
      expect(state.usage).toHaveProperty("completionTokens");
      expect(state.usage).toHaveProperty("totalTokens");
    });

    // -----------------------------------------------------------------------
    // Couchbase token-usage enrichment (couchbase-token-usage-enrichment-plan)
    // -----------------------------------------------------------------------

    test("emits sessionUsage mirroring Session.usage when present", () => {
      const session: Session = {
        ...baseSession,
        usage: {
          promptTokens: 1234,
          completionTokens: 567,
          totalTokens: 1801,
          totalCost: 0.0123,
          promptTokensDetails: {
            cachedTokens: 100,
            cacheWriteTokens: 50,
          },
        } as any,
      };
      const doc = buildSessionDocument(session);
      expect(doc.sessionUsage).toBeDefined();
      const su = doc.sessionUsage as any;
      expect(su.promptTokens).toBe(1234);
      expect(su.completionTokens).toBe(567);
      expect(su.totalTokens).toBe(1801);
      expect(su.cachedTokens).toBe(100);
      expect(su.cacheWriteTokens).toBe(50);
      expect(su.totalCost).toBe(0.0123);
    });

    test("sessionUsage.totalCost preserves number type (not coerced to integer)", () => {
      const session: Session = {
        ...baseSession,
        usage: {
          promptTokens: 10,
          completionTokens: 5,
          totalTokens: 15,
          totalCost: 0.000123,
        } as any,
      };
      const doc = buildSessionDocument(session);
      expect((doc.sessionUsage as any).totalCost).toBe(0.000123);
      expect(typeof (doc.sessionUsage as any).totalCost).toBe("number");
    });

    test("per-turn usage surfaces cacheWriteTokens from promptTokensDetails", () => {
      const session: Session = {
        ...baseSession,
        history: [
          {
            message: { role: "assistant", content: "hi" },
            contextItems: [],
            usage: {
              promptTokens: 100,
              completionTokens: 50,
              totalTokens: 150,
              promptTokensDetails: {
                cachedTokens: 20,
                cacheWriteTokens: 30,
              },
            },
          } as any,
        ],
      };
      const doc = buildSessionDocument(session);
      const item = (doc.chatHistory as any[])[0];
      expect(item.usage.cachedTokens).toBe(20);
      expect(item.usage.cacheWriteTokens).toBe(30);
    });

    test("per-turn usage includes totalCost, model, and modelProvider when present", () => {
      const session: Session = {
        ...baseSession,
        history: [
          {
            message: { role: "assistant", content: "hi" },
            contextItems: [],
            usage: {
              promptTokens: 10,
              completionTokens: 5,
              totalTokens: 15,
              totalCost: 0.0045,
              model: "claude-3-5-sonnet",
              modelProvider: "anthropic",
            },
          } as any,
        ],
      };
      const doc = buildSessionDocument(session);
      const item = (doc.chatHistory as any[])[0];
      expect(item.usage.totalCost).toBe(0.0045);
      expect(item.usage.model).toBe("claude-3-5-sonnet");
      expect(item.usage.modelProvider).toBe("anthropic");
    });

    test("per-turn usage accepts CLI snake_case fullUsage shape (prompt_tokens/completion_tokens)", () => {
      // CLI stores raw OpenAI-style chunk.usage as message.usage; without snake_case
      // support, sanitizeUsage emits -1 for every token field.
      const session: Session = {
        ...baseSession,
        history: [
          {
            message: {
              role: "assistant",
              content: "hi",
              usage: {
                prompt_tokens: 1234,
                completion_tokens: 56,
                total_tokens: 1290,
                prompt_tokens_details: {
                  cached_tokens: 100,
                  cache_read_tokens: 80,
                  cache_write_tokens: 20,
                },
                completion_tokens_details: {
                  reasoning_tokens: 8,
                },
                model: "gpt-4o",
                cost_cents: 12,
              },
            },
            contextItems: [],
          } as any,
        ],
      };
      const doc = buildSessionDocument(session);
      const usage = (doc.chatHistory as any[])[0].usage;
      expect(usage.promptTokens).toBe(1234);
      expect(usage.completionTokens).toBe(56);
      expect(usage.totalTokens).toBe(1290);
      expect(usage.cachedTokens).toBe(100);
      expect(usage.cacheReadTokens).toBe(80);
      expect(usage.cacheWriteTokens).toBe(20);
      expect(usage.reasoningTokens).toBe(8);
      expect(usage.model).toBe("gpt-4o");
      expect(usage.totalCost).toBeCloseTo(0.12);
    });

    test("promptLogs surface promptTokens and completionTokens when provided", () => {
      const session: Session = {
        ...baseSession,
        history: [
          {
            message: { role: "assistant", content: "hi" },
            contextItems: [],
            promptLogs: [
              {
                modelTitle: "GPT-4",
                modelProvider: "openai",
                prompt: "p",
                completion: "c",
                promptTokens: 42,
                completionTokens: 17,
              },
            ],
          } as any,
        ],
      };
      const doc = buildSessionDocument(session);
      const log = (doc.chatHistory as any[])[0].promptLogs[0];
      expect(log.promptTokens).toBe(42);
      expect(log.completionTokens).toBe(17);
      expect(log.modelTitle).toBe("GPT-4");
    });
  });
});
