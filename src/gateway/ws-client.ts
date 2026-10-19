import { WebSocket } from "ws";
import { parseFrame } from "./protocol.js";

export type EventHandler = (event: string, payload: unknown) => void;

/** Thin WS client used by `sc tui --url` (remote gateway mode). */
export class GatewayClient {
  #ws: WebSocket;
  #id = 0;
  #pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  #handlers = new Set<EventHandler>();
  #closed = false;

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.on("message", (data) => this.#onMessage(data.toString()));
    ws.on("close", () => {
      this.#closed = true;
      for (const { reject } of this.#pending.values()) reject(new Error("gateway connection closed"));
      this.#pending.clear();
    });
  }

  static connect(url: string, token: string): Promise<GatewayClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => reject(new Error("connect timeout")), 8000);
      ws.on("open", () => {
        clearTimeout(timer);
        const client = new GatewayClient(ws);
        ws.send(JSON.stringify({ type: "connect", params: { token, client: "suparclaw-tui", protocol: 1 } }));
        resolve(client);
      });
      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  #onMessage(raw: string): void {
    const frame = parseFrame(raw) as { type: string; id?: string; ok?: boolean; payload?: unknown; error?: { message: string }; event?: string } | null;
    if (!frame) return;
    if (frame.type === "res" && frame.id) {
      const entry = this.#pending.get(frame.id);
      if (!entry) return;
      this.#pending.delete(frame.id);
      if (frame.ok) entry.resolve(frame.payload);
      else entry.reject(new Error(frame.error?.message ?? "request failed"));
      return;
    }
    if (frame.type === "event" && frame.event) {
      for (const handler of this.#handlers) handler(frame.event, frame.payload);
    }
  }

  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("not connected"));
    const id = `r${++this.#id}`;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ type: "req", id, method, params }));
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`${method} timed out`));
      }, 120_000);
    });
  }

  onEvent(handler: EventHandler): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  close(): void {
    this.#closed = true;
    try {
      this.#ws.close();
    } catch {
      /* ignore */
    }
  }
}