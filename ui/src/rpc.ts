// Gateway WebSocket client: connect/reconnect, request/response, event fan-out.

export type ConnState = "connecting" | "online" | "offline" | "unauthorized";

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };
export type EventHandler = (event: string, payload: any) => void;

export class Gateway {
  #ws: WebSocket | null = null;
  #pending = new Map<string, Pending>();
  #handlers = new Set<EventHandler>();
  /** What this gateway said it can answer (`hello-ok.methods`). */
  #methods: Set<string> | null = null;
  #warned = new Set<string>();
  #state: ConnState = "connecting";
  #token = localStorage.getItem("sc.token") || "";
  #attempt = 0;
  #closedByUs = false;

  onState: ((state: ConnState) => void) | null = null;

  get state(): ConnState { return this.#state; }
  get token(): string { return this.#token; }

  setToken(token: string): void {
    this.#token = token;
    localStorage.setItem("sc.token", token);
  }

  on(handler: EventHandler): () => void {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  connect(): void {
    this.#closedByUs = false;
    this.#setState("connecting");
    const proto = location.protocol === "https:" ? "wss" : "ws";
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${proto}://${location.host}/ws`);
    } catch {
      this.#scheduleReconnect();
      return;
    }
    this.#ws = ws;

    ws.onopen = () => {
      this.#send({ type: "connect", params: this.#token ? { token: this.#token } : {} });
    };
    ws.onclose = (ev) => {
      this.#ws = null;
      this.#flush(new Error("gateway disconnected"));
      if (ev.code === 4401) { this.#setState("unauthorized"); return; }
      this.#setState("offline");
      this.#scheduleReconnect();
    };
    ws.onerror = () => { /* onclose follows */ };
    ws.onmessage = (ev) => {
      let frame: any;
      try { frame = JSON.parse(ev.data as string); } catch { return; }
      if (frame.type === "hello-ok") {
        this.#attempt = 0;
        if (Array.isArray(frame.methods)) this.#methods = new Set(frame.methods.map(String));
        this.#setState("online");
        return;
      }
      if (frame.type === "res") {
        const p = this.#pending.get(frame.id);
        if (!p) return;
        this.#pending.delete(frame.id);
        frame.ok ? p.resolve(frame.payload) : p.reject(new Error(frame.error?.message ?? "request failed"));
        return;
      }
      if (frame.type === "event") {
        for (const h of this.#handlers) {
          try { h(frame.event, frame.payload); } catch { /* one bad handler must not break the rest */ }
        }
      }
    };
  }

  request<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.#ws || this.#ws.readyState !== WebSocket.OPEN) {
        reject(new Error("not connected to gateway"));
        return;
      }
      // Task 26 (audit 1): the gateway ships its method list in `hello-ok`.
      // Nothing used to read it, so a build/test/prod mismatch was invisible
      // until a click silently failed. Warn once per method, then keep going.
      if (this.#methods && !this.#methods.has(method) && !this.#warned.has(method)) {
        this.#warned.add(method);
        console.warn(`[gateway] this server does not advertise ${method}`);
      }
      const id = "r" + Math.random().toString(36).slice(2) + Date.now().toString(36);
      this.#pending.set(id, { resolve, reject });
      this.#send({ type: "req", id, method, params });
      setTimeout(() => {
        if (this.#pending.has(id)) {
          this.#pending.delete(id);
          reject(new Error(`${method} timed out`));
        }
      }, 30_000);
    });
  }

  close(): void {
    this.#closedByUs = true;
    this.#ws?.close();
  }

  #send(frame: unknown): void {
    this.#ws?.send(JSON.stringify(frame));
  }

  #flush(err: Error): void {
    for (const [, p] of this.#pending) p.reject(err);
    this.#pending.clear();
  }

  #setState(state: ConnState): void {
    if (this.#state === state) return;
    this.#state = state;
    this.onState?.(state);
  }

  #scheduleReconnect(): void {
    if (this.#closedByUs) return;
    const delay = Math.min(30_000, 600 * 2 ** this.#attempt++) + Math.random() * 250;
    setTimeout(() => { if (!this.#ws) this.connect(); }, delay);
  }
}

export const gateway = new Gateway();
