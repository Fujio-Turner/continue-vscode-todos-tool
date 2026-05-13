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

    test("emits exactly the schema's required top-level keys", () => {
      const doc = buildSessionDocument(baseSession);
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
      expect(Object.keys(item).sort()).toEqual(["contextItems", "message"]);
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
      expect((doc as any).error).toEqual({
        fileName: "history.ts",
        filePath: "/abs/core/util/history.ts",
        lineNumber: 132,
        message: "ENOSPC: no space left on device",
        stack: "Error: ENOSPC...\n    at HistoryManager.save (...:132:5)",
        extensionVersion: "1.3.39",
        extensionCommit: "affc6394f09964950387c286ff8b28c610f88736",
      });
      // Schema requires all seven keys when `error` is present
      expect(Object.keys((doc as any).error).sort()).toEqual([
        "extensionCommit",
        "extensionVersion",
        "fileName",
        "filePath",
        "lineNumber",
        "message",
        "stack",
      ]);
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
  });
});
