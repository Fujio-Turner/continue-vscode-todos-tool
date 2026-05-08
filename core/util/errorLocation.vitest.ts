import { describe, expect, test } from "vitest";

import { toSessionErrorInfo } from "./errorLocation";

describe("toSessionErrorInfo", () => {
  test("Error with stack → real fileName/filePath/lineNumber", () => {
    const err = new Error("boom");
    err.stack =
      "Error: boom\n" +
      "    at HistoryManager.save (/home/user/proj/core/util/history.ts:132:5)\n" +
      "    at Object.<anonymous> (/home/user/proj/core/util/history.test.ts:50:3)";

    const info = toSessionErrorInfo(err);

    expect(info.message).toBe("boom");
    expect(info.fileName).toBe("history.ts");
    expect(info.filePath).toBe("/home/user/proj/core/util/history.ts");
    expect(info.lineNumber).toBe(132);
    expect(info.stack).toContain("HistoryManager.save");
  });

  test("Error with parens-less frame is parsed", () => {
    const err = new Error("nope");
    err.stack = "Error: nope\n    at /a/b/c.ts:7:1";

    const info = toSessionErrorInfo(err);

    expect(info.fileName).toBe("c.ts");
    expect(info.filePath).toBe("/a/b/c.ts");
    expect(info.lineNumber).toBe(7);
  });

  test("Error with stack containing only node:internal frames → N/A", () => {
    const err = new Error("internal-only");
    err.stack =
      "Error: internal-only\n" +
      "    at process.processTicksAndRejections (node:internal/process/task_queues:96:5)";

    const info = toSessionErrorInfo(err);

    expect(info.message).toBe("internal-only");
    expect(info.fileName).toBe("N/A");
    expect(info.filePath).toBe("N/A");
    expect(info.lineNumber).toBe(-1);
  });

  test("Error without stack → all N/A / -1", () => {
    const err = new Error("nostack");
    err.stack = undefined;

    const info = toSessionErrorInfo(err);

    expect(info.message).toBe("nostack");
    expect(info.stack).toBe("N/A");
    expect(info.fileName).toBe("N/A");
    expect(info.filePath).toBe("N/A");
    expect(info.lineNumber).toBe(-1);
  });

  test("string thrown → message populated, locations N/A / -1", () => {
    const info = toSessionErrorInfo("plain string failure");

    expect(info.message).toBe("plain string failure");
    expect(info.stack).toBe("N/A");
    expect(info.fileName).toBe("N/A");
    expect(info.filePath).toBe("N/A");
    expect(info.lineNumber).toBe(-1);
  });

  test("undefined thrown → all N/A / -1", () => {
    const info = toSessionErrorInfo(undefined);

    expect(info.message).toBe("N/A");
    expect(info.stack).toBe("N/A");
    expect(info.fileName).toBe("N/A");
    expect(info.filePath).toBe("N/A");
    expect(info.lineNumber).toBe(-1);
  });

  test("null thrown → all N/A / -1", () => {
    const info = toSessionErrorInfo(null);

    expect(info.message).toBe("N/A");
    expect(info.stack).toBe("N/A");
    expect(info.fileName).toBe("N/A");
    expect(info.filePath).toBe("N/A");
    expect(info.lineNumber).toBe(-1);
  });

  test("plain object with message + stack is honored", () => {
    const info = toSessionErrorInfo({
      message: "fetch failed",
      stack:
        "TypeError: fetch failed\n" +
        "    at fetchHandler (/srv/app/net/fetch.ts:42:11)",
    });

    expect(info.message).toBe("fetch failed");
    expect(info.fileName).toBe("fetch.ts");
    expect(info.filePath).toBe("/srv/app/net/fetch.ts");
    expect(info.lineNumber).toBe(42);
  });

  test("timeout-style error with no parseable user frames → N/A locations", () => {
    const err = new Error("Request timed out");
    err.stack =
      "Error: Request timed out\n" +
      "    at Timeout._onTimeout (node:internal/timers:476:21)\n" +
      "    at listOnTimeout (node:internal/timers:573:17)";

    const info = toSessionErrorInfo(err);

    expect(info.message).toBe("Request timed out");
    expect(info.fileName).toBe("N/A");
    expect(info.filePath).toBe("N/A");
    expect(info.lineNumber).toBe(-1);
    expect(info.stack).toContain("Request timed out");
  });

  test("always returns all 5 schema keys (string types + integer line)", () => {
    const info = toSessionErrorInfo(undefined);
    expect(Object.keys(info).sort()).toEqual([
      "fileName",
      "filePath",
      "lineNumber",
      "message",
      "stack",
    ]);
    expect(typeof info.fileName).toBe("string");
    expect(typeof info.filePath).toBe("string");
    expect(typeof info.lineNumber).toBe("number");
    expect(Number.isInteger(info.lineNumber)).toBe(true);
    expect(typeof info.message).toBe("string");
    expect(typeof info.stack).toBe("string");
  });
});
