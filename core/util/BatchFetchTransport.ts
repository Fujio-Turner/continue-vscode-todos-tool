import Transport from "winston-transport";

export type BatchFetchTransportOptions = {
  endpoint: string;
  username: string;
  password: string;

  flushIntervalMs?: number;
  maxBatchSize?: number;
  maxBatchBytes?: number;
  timeoutMs?: number;
  headers?: Record<string, string>;
};

type RemoteLogEvent = {
  timestamp: string;
  level: unknown;
  message: unknown;
  meta: Record<string, unknown>;
};

type QueuedEvent = {
  sessionId: string;
  event: RemoteLogEvent;
  bytes: number;
};

type ExistingLogDocument = {
  _rev?: string;
  rev?: string;
  events?: unknown;
  chatHistory?: unknown;
  [key: string]: unknown;
};

export class BatchFetchTransport extends Transport {
  private endpoint: string;
  private headers: Record<string, string>;
  private flushIntervalMs: number;
  private maxBatchSize: number;
  private maxBatchBytes: number;
  private timeoutMs: number;

  private queue: QueuedEvent[] = [];
  private queueBytes = 0;
  private flushing = false;
  private timer: NodeJS.Timeout;

  constructor(opts: BatchFetchTransportOptions) {
    super();

    this.endpoint = opts.endpoint;
    this.flushIntervalMs = opts.flushIntervalMs ?? 2000;
    this.maxBatchSize = opts.maxBatchSize ?? 50;
    this.maxBatchBytes = opts.maxBatchBytes ?? 256 * 1024;
    this.timeoutMs = opts.timeoutMs ?? 5000;

    const authHeader =
      "Basic " +
      Buffer.from(`${opts.username}:${opts.password}`, "utf8").toString(
        "base64",
      );

    this.headers = {
      "content-type": "application/json",
      authorization: authHeader,
      ...(opts.headers ?? {}),
    };

    this.timer = setInterval(() => void this.flush(), this.flushIntervalMs);
    this.timer.unref?.();
  }

  log(info: any, callback: () => void) {
    setImmediate(() => this.emit("logged", info));
    callback();

    const sessionId =
      typeof info.sessionId === "string" ? info.sessionId.trim() : "";
    if (!sessionId) {
      return;
    }

    const event: RemoteLogEvent = {
      timestamp: new Date().toISOString(),
      level: info.level,
      message: info.message,
      meta: Object.fromEntries(
        Object.entries(info).filter(([k]) => !["level", "message"].includes(k)),
      ),
    };

    // Track approximate bytes for flush threshold
    const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");

    this.queue.push({ sessionId, event, bytes });
    this.queueBytes += bytes;

    if (
      this.queue.length >= this.maxBatchSize ||
      this.queueBytes >= this.maxBatchBytes
    ) {
      void this.flush();
    }
  }

  async flush() {
    if (this.flushing) return;
    if (this.queue.length === 0) return;

    this.flushing = true;

    const batch = this.queue;
    this.queue = [];
    this.queueBytes = 0;

    try {
      const eventsBySessionId = new Map<string, QueuedEvent[]>();
      for (const queued of batch) {
        const current = eventsBySessionId.get(queued.sessionId) ?? [];
        current.push(queued);
        eventsBySessionId.set(queued.sessionId, current);
      }

      const failed: QueuedEvent[] = [];
      for (const [sessionId, queuedEvents] of eventsBySessionId.entries()) {
        try {
          await this.upsertSessionEvents(sessionId, queuedEvents);
        } catch (err) {
          failed.push(...queuedEvents);
          this.emit("warn", err);
        }
      }

      if (failed.length > 0) {
        this.queue = failed.concat(this.queue);
        this.queueBytes = this.queue.reduce(
          (total, item) => total + item.bytes,
          0,
        );
      }
    } catch (err) {
      // Re-queue on unexpected failure.
      this.queue = batch.concat(this.queue);
      this.queueBytes = this.queue.reduce(
        (total, item) => total + item.bytes,
        0,
      );
      this.emit("warn", err);
    } finally {
      this.flushing = false;
    }
  }

  private buildSessionEndpoint(sessionId: string): string {
    const base = this.endpoint.replace(/\/+$/, "");
    return `${base}/${encodeURIComponent(sessionId)}`;
  }

  private getRevision(existing: ExistingLogDocument): string | undefined {
    const revision = existing._rev ?? existing.rev;
    return typeof revision === "string" && revision.length > 0
      ? revision
      : undefined;
  }

  private mergeDocument(
    existing: ExistingLogDocument | null,
    newEvents: RemoteLogEvent[],
  ): ExistingLogDocument {
    const existingEvents = Array.isArray(existing?.events)
      ? existing.events
      : [];
    const existingChatHistory =
      existing && Object.prototype.hasOwnProperty.call(existing, "chatHistory")
        ? existing.chatHistory
        : undefined;

    return {
      ...(existing ?? {}),
      events: [...existingEvents, ...newEvents],
      chatHistory: existingChatHistory,
    };
  }

  private async request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      return await fetch(url, {
        ...init,
        headers: this.headers,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(t);
    }
  }

  private async getExistingDocument(
    sessionId: string,
  ): Promise<ExistingLogDocument | null> {
    const url = this.buildSessionEndpoint(sessionId);
    const res = await this.request(url, {
      method: "GET",
    });

    if (res.status === 404) {
      return null;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Log GET failed for session ${sessionId}: ${res.status} ${res.statusText} ${text}`.trim(),
      );
    }

    const body = await res.json().catch(() => null);
    if (!body || typeof body !== "object") {
      throw new Error(`Log GET returned invalid JSON for session ${sessionId}`);
    }

    return body as ExistingLogDocument;
  }

  private async putDocument(
    sessionId: string,
    document: ExistingLogDocument,
  ): Promise<void> {
    const url = this.buildSessionEndpoint(sessionId);
    const res = await this.request(url, {
      method: "PUT",
      body: JSON.stringify(document),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Log PUT failed for session ${sessionId}: ${res.status} ${res.statusText} ${text}`.trim(),
      );
    }
  }

  private async patchDocument(
    sessionId: string,
    document: ExistingLogDocument,
  ): Promise<void> {
    const url = this.buildSessionEndpoint(sessionId);
    const res = await this.request(url, {
      method: "PATCH",
      body: JSON.stringify(document),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Log PATCH failed for session ${sessionId}: ${res.status} ${res.statusText} ${text}`.trim(),
      );
    }
  }

  private async upsertSessionEvents(
    sessionId: string,
    queuedEvents: QueuedEvent[],
  ): Promise<void> {
    const events = queuedEvents.map((item) => item.event);
    const existing = await this.getExistingDocument(sessionId);

    if (!existing) {
      await this.putDocument(sessionId, { events });
      return;
    }

    const merged = this.mergeDocument(existing, events);
    const revision = this.getRevision(existing);

    if (!revision) {
      delete merged._rev;
      delete merged.rev;
      await this.putDocument(sessionId, merged);
      return;
    }

    merged._rev = revision;
    await this.patchDocument(sessionId, merged);
  }

  override close() {
    clearInterval(this.timer);
    void this.flush();
  }
}
