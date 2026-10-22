// Settings → Notifications (their web/notifications contract, local-Notification
// lane — no external push relay): one master toggle per browser, approvals
// default ON, final-reply opt-in, quiet-hours suppression, "send test".
// Payloads stay generic (their privacy rule: generic lock-screen text — no
// prompts, commands, or message excerpts in the alert body).

export interface NotificationPrefs {
  enabled: boolean;
  reply: boolean;
  approvals: boolean;
  quietFrom: string; // "22:00" local; "" disables quiet hours
  quietTo: string;
}

const LS_KEY = "sc.alerts";

const DEFAULTS: NotificationPrefs = {
  enabled: false,
  reply: false,
  approvals: true, // their default: approval requests are enabled by default
  quietFrom: "",
  quietTo: "",
};

export function loadPrefs(): NotificationPrefs {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULTS };
    const v = JSON.parse(raw) as Partial<NotificationPrefs>;
    return { ...DEFAULTS, ...v, enabled: Boolean(v.enabled) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(p: NotificationPrefs): void {
  localStorage.setItem(LS_KEY, JSON.stringify(p));
}

export function supported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

/** in quiet hours? overnight windows wrap midnight; zero-width = always quiet. */
export function inQuietHours(from: string, to: string, d = new Date()): boolean {
  if (!from || !to) return false;
  const parse = (s: string): number => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
    return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
  };
  const f = parse(from), t = parse(to);
  if (f < 0 || t < 0) return false;
  const cur = d.getHours() * 60 + d.getMinutes();
  if (f === t) return true;
  return f < t ? cur >= f && cur < t : cur >= f || cur < t;
}

/** Info string for the settings page (their status surface). */
export function permissionState(): "unsupported" | "denied" | "granted" | "default" {
  if (!supported()) return "unsupported";
  return Notification.permission as "denied" | "granted" | "default";
}

/** Ask once (their "first chat send" auto-prompt — one shot per browser). */
export function askOnceOnFirstSend(): void {
  if (localStorage.getItem("sc.alerts.asked") === "1") return;
  localStorage.setItem("sc.alerts.asked", "1");
  if (!supported() || Notification.permission !== "default") return;
  void Notification.requestPermission();
}

async function show(title: string, body: string): Promise<void> {
  if (Notification.permission !== "granted") {
    const perm = await Notification.requestPermission();
    if (perm !== "granted") return;
  }
  try {
    new Notification(title, { body, icon: "/favicon.ico" });
  } catch {
    /* mobile/desktop quirks non-fatal */
  }
}

/** Gateway event hook — called from main.ts's fan-out. */
export function onGatewayEvent(event: string, payload: { sessionKey?: string; event?: { type?: string; text?: string; name?: string } }): void {
  if (event !== "chat") return;
  const prefs = loadPrefs();
  if (!prefs.enabled || !supported()) return;
  const ev = payload.event ?? {};
  if (inQuietHours(prefs.quietFrom, prefs.quietTo)) return;
  if (ev.type === "approval" && prefs.approvals) {
    // generic lock-screen text only (their privacy rule); name missing → plain.
    void show("Approval requested", ev.name ? `“${ev.name}” needs a decision.` : "A tool call needs a decision.");
  } else if (ev.type === "final" && prefs.reply && document.hidden) {
    void show("Reply ready", "The agent finished a reply.");
  }
}

/** Settings "Send test" (their Settings → Notifications test). */
export async function sendTest(): Promise<boolean> {
  if (!supported()) return false;
  await show("Test notification", "Notifications are working.");
  return true;
}
