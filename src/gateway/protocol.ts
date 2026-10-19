// Gateway wire protocol: JSON frames over WebSocket, mirroring OpenClaw's shape.
// client -> { type:"req", id, method, params }
// server -> { type:"res", id, ok, payload | error }
// server -> { type:"event", event, payload }
// first frame must be { type:"connect", params: { token?, client? } }

export const PROTOCOL_VERSION = 1;

export type ReqFrame = { type: "req"; id: string; method: string; params?: Record<string, unknown> };
export type ConnectFrame = { type: "connect"; params?: { token?: string; client?: string; protocol?: number } };
export type ClientFrame = ConnectFrame | ReqFrame | { type: "ping" };

export type ResFrame =
  | { type: "res"; id: string; ok: true; payload: unknown }
  | { type: "res"; id: string; ok: false; error: { code: string; message: string } };

export type EventFrame = { type: "event"; event: string; payload: unknown; at: number };

export function parseFrame(line: string): ClientFrame | null {
  try {
    const parsed: unknown = JSON.parse(line);
    if (parsed && typeof parsed === "object" && typeof (parsed as { type?: unknown }).type === "string") {
      return parsed as ClientFrame;
    }
  } catch {
    /* not a frame */
  }
  return null;
}

export function okFrame(id: string, payload: unknown): ResFrame {
  return { type: "res", id, ok: true, payload };
}

export function errFrame(id: string, code: string, message: string): ResFrame {
  return { type: "res", id, ok: false, error: { code, message } };
}

export function eventFrame(event: string, payload: unknown): EventFrame {
  return { type: "event", event, payload, at: Date.now() };
}