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

/** The browser's own answer about alerts for this site. */
export type PermissionState = "unsupported" | "denied" | "granted" | "default";

export function permissionState(): PermissionState {
  if (!supported()) return "unsupported";
  return Notification.permission as "denied" | "granted" | "default";
}

/** Ask the browser, from a click. It shows its own prompt; the page cannot grant
 *  anything on its own, and a denied state cannot be undone from here. */
export async function askPermission(): Promise<PermissionState> {
  if (!supported()) return "unsupported";
  if (Notification.permission === "default") {
    try {
      // Old Safari returns nothing; both shapes are awaited the same way.
      await Notification.requestPermission();
    } catch {
      /* a refused prompt is the same as a denial */
    }
  }
  return permissionState();
}

/** Ask once (their "first chat send" auto-prompt — one shot per browser). */
export function askOnceOnFirstSend(): void {
  if (localStorage.getItem("sc.alerts.asked") === "1") return;
  localStorage.setItem("sc.alerts.asked", "1");
  if (!supported() || Notification.permission !== "default") return;
  void Notification.requestPermission();
}

/** Show one alert. Returns whether the browser actually displayed it, so a caller
 *  cannot claim success after a refusal. */
async function show(title: string, body: string): Promise<boolean> {
  if (!supported()) return false;
  if (Notification.permission !== "granted") {
    if ((await askPermission()) !== "granted") return false;
  }
  try {
    new Notification(title, { body, icon: "/favicon.ico" });
    return true;
  } catch {
    /* mobile/desktop quirks non-fatal */
    return false;
  }
}

/** Gateway event hook — called from main.ts's fan-out. */
export function onGatewayEvent(event: string, payload: { sessionKey?: string; event?: { type?: string; text?: string; name?: string } }): void {
  if (event !== "chat") return;
  const prefs = loadPrefs();
  if (!prefs.enabled || !supported()) return;
  // Only while the tab is in the background: a banner over the chat you are
  // already reading is noise, and this is the rule the Settings page states.
  if (document.hidden !== true) return;
  // A gateway event is not a user gesture, so it can never raise the permission
  // prompt — it can only use a permission that was granted earlier.
  if (Notification.permission !== "granted") return;
  const ev = payload.event ?? {};
  if (inQuietHours(prefs.quietFrom, prefs.quietTo)) return;
  if (ev.type === "approval" && prefs.approvals) {
    // generic lock-screen text only (their privacy rule); name missing → plain.
    void show("Approval requested", ev.name ? `“${ev.name}” needs a decision.` : "A tool call needs a decision.");
  } else if (ev.type === "final" && prefs.reply) {
    void show("Reply ready", "The agent finished a reply.");
  }
}

/** Settings "Send test": true only when a notification was really shown. */
export async function sendTest(): Promise<boolean> {
  return show("Test notification", "Notifications are working.");
}
