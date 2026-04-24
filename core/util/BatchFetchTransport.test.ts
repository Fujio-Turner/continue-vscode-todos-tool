import { BatchFetchTransport } from "./BatchFetchTransport";

function jsonResponse(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("BatchFetchTransport", () => {
  beforeEach(() => {
    global.fetch = jest.fn() as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function createTransport(): BatchFetchTransport {
    return new BatchFetchTransport({
      endpoint: "https://example.com/logs",
      username: "user",
      password: "pass",
      flushIntervalMs: 60_000,
      timeoutMs: 10_000,
    });
  }

  test("uses PUT when session document does not exist", async () => {
    const transport = createTransport();
    const fetchMock = global.fetch as unknown as jest.Mock;
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404))
      .mockResolvedValueOnce(jsonResponse(201));

    transport.log(
      { level: "info", message: "hello", sessionId: "session-a" },
      () => undefined,
    );

    await transport.flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://example.com/logs/session-a",
    );
    expect(fetchMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({ method: "GET" }),
    );
    expect(fetchMock.mock.calls[1][1]).toEqual(
      expect.objectContaining({ method: "PUT" }),
    );

    const putBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(putBody.events).toHaveLength(1);
    expect(putBody._rev).toBeUndefined();
    expect(putBody).not.toHaveProperty("chatHistory");

    transport.close();
  });

  test("uses PATCH with _rev when session document already exists", async () => {
    const transport = createTransport();
    const fetchMock = global.fetch as unknown as jest.Mock;
    fetchMock
      .mockResolvedValueOnce(jsonResponse(200, { _rev: "2-abcd", events: [] }))
      .mockResolvedValueOnce(jsonResponse(200));

    transport.log(
      { level: "info", message: "hello", sessionId: "session-a" },
      () => undefined,
    );

    await transport.flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]).toEqual(
      expect.objectContaining({ method: "PATCH" }),
    );

    const patchBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(patchBody._rev).toBe("2-abcd");
    expect(patchBody.events).toHaveLength(1);
    expect(patchBody).not.toHaveProperty("chatHistory");

    transport.close();
  });

  test("preserves top-level chatHistory when patching existing document", async () => {
    const transport = createTransport();
    const fetchMock = global.fetch as unknown as jest.Mock;
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          _rev: "2-abcd",
          chatHistory: [{ role: "user", content: "hello" }],
          events: [{ prior: true }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse(200));

    transport.log(
      { level: "info", message: "hello", sessionId: "session-a" },
      () => undefined,
    );

    await transport.flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]).toEqual(
      expect.objectContaining({ method: "PATCH" }),
    );

    const patchBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(patchBody.chatHistory).toEqual([{ role: "user", content: "hello" }]);
    expect(patchBody.events).toHaveLength(2);

    transport.close();
  });

  test("falls back to PUT when existing document has no revision", async () => {
    const transport = createTransport();
    const fetchMock = global.fetch as unknown as jest.Mock;
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, { events: [{ prior: true }], tag: "x" }),
      )
      .mockResolvedValueOnce(jsonResponse(201));

    transport.log(
      { level: "info", message: "hello", sessionId: "session-a" },
      () => undefined,
    );

    await transport.flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]).toEqual(
      expect.objectContaining({ method: "PUT" }),
    );

    const putBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(putBody._rev).toBeUndefined();
    expect(putBody.events).toHaveLength(2);
    expect(putBody.tag).toBe("x");
    expect(putBody).not.toHaveProperty("chatHistory");

    transport.close();
  });

  test("preserves top-level chatHistory during fallback PUT", async () => {
    const transport = createTransport();
    const fetchMock = global.fetch as unknown as jest.Mock;
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse(200, {
          chatHistory: [{ role: "assistant", content: "ack" }],
          events: [{ prior: true }],
          tag: "x",
        }),
      )
      .mockResolvedValueOnce(jsonResponse(201));

    transport.log(
      { level: "info", message: "hello", sessionId: "session-a" },
      () => undefined,
    );

    await transport.flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][1]).toEqual(
      expect.objectContaining({ method: "PUT" }),
    );

    const putBody = JSON.parse(fetchMock.mock.calls[1][1].body as string);
    expect(putBody.chatHistory).toEqual([
      { role: "assistant", content: "ack" },
    ]);
    expect(putBody.events).toHaveLength(2);
    expect(putBody.tag).toBe("x");

    transport.close();
  });

  test("splits mixed-session batches into separate request flows", async () => {
    const transport = createTransport();
    const fetchMock = global.fetch as unknown as jest.Mock;
    fetchMock
      .mockResolvedValueOnce(jsonResponse(404))
      .mockResolvedValueOnce(jsonResponse(201))
      .mockResolvedValueOnce(jsonResponse(404))
      .mockResolvedValueOnce(jsonResponse(201));

    transport.log(
      { level: "info", message: "one", sessionId: "session-a" },
      () => undefined,
    );
    transport.log(
      { level: "info", message: "two", sessionId: "session-b" },
      () => undefined,
    );

    await transport.flush();

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://example.com/logs/session-a",
    );
    expect(fetchMock.mock.calls[2][0]).toBe(
      "https://example.com/logs/session-b",
    );

    transport.close();
  });

  test("skips remote logging when sessionId is missing", async () => {
    const transport = createTransport();
    const fetchMock = global.fetch as unknown as jest.Mock;

    transport.log({ level: "info", message: "hello" }, () => undefined);
    await transport.flush();

    expect(fetchMock).not.toHaveBeenCalled();

    transport.close();
  });

  test("requeues only failed session groups", async () => {
    const transport = createTransport();
    const fetchMock = global.fetch as unknown as jest.Mock;

    fetchMock
      .mockResolvedValueOnce(jsonResponse(404))
      .mockResolvedValueOnce(new Response("failed", { status: 500 }))
      .mockResolvedValueOnce(jsonResponse(404))
      .mockResolvedValueOnce(jsonResponse(201));

    transport.log(
      { level: "info", message: "one", sessionId: "session-a" },
      () => undefined,
    );
    transport.log(
      { level: "info", message: "two", sessionId: "session-b" },
      () => undefined,
    );

    await transport.flush();

    fetchMock
      .mockResolvedValueOnce(jsonResponse(404))
      .mockResolvedValueOnce(jsonResponse(201));
    await transport.flush();

    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(fetchMock.mock.calls[4][0]).toBe(
      "https://example.com/logs/session-a",
    );
    expect(fetchMock.mock.calls[5][0]).toBe(
      "https://example.com/logs/session-a",
    );

    transport.close();
  });
});
