// Tiny DOM helpers + the in-app dialog/toast layer. Native prompt/confirm/alert
// are banned here: they break the design and are unusable on a phone.

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Record<string, string | undefined>,
  children?: (Node | string)[],
): HTMLElementTagNameMap[K];
export function el(
  tag: string,
  attrs?: Record<string, string | undefined>,
  children?: (Node | string)[],
): HTMLElement;
export function el(
  tag: string,
  attrs: Record<string, string | undefined> = {},
  children: (Node | string)[] = [],
): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined) continue;
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  for (const c of children) node.append(c);
  return node;
}

export const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] as string);

/**
 * Trusted icon markup → real DOM nodes. Strings passed to el() stay TEXT (so
 * message content can never become HTML); icon() is the ONLY place module
 * constants like SPARKLE may be parsed as markup — before this existed, the
 * raw "<svg …>" strings rendered as visible text in every message head.
 */
export function icon(html: string, cls?: string): HTMLElement {
  const node = el("span", cls ? { class: cls } : {});
  node.innerHTML = html;
  return node;
}

export type Tone = "ok" | "err" | "info";

/** Toast: a dot + message, stacked under the rail. */
export function toast(text: string, tone: Tone = "info"): void {
  const host = document.getElementById("toasts");
  if (!host) return;
  const node = el("div", { class: `toast toast--${tone}` }, [
    el("span", { class: "toast__dot" }),
    el("span", {}, [text]),
  ]);
  host.append(node);
  setTimeout(() => {
    node.style.opacity = "0";
    node.style.transform = "translateY(-6px)";
    node.style.transition = "opacity .2s ease, transform .2s ease";
    setTimeout(() => node.remove(), 220);
  }, 3000);
}

export interface ModalSpec {
  title: string;
  body?: Node | string;
  fields?: { name: string; label: string; value?: string; placeholder?: string; type?: string }[];
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm?: (values: Record<string, string>) => void | Promise<void>;
  render?: (box: HTMLElement, close: () => void) => void;
}

/** Styled modal. Returns a close() function; Esc and the scrim close it. */
export function modal(spec: ModalSpec): () => void {
  const overlay = document.getElementById("modal-overlay") as HTMLElement | null;
  const box = document.getElementById("modal") as HTMLElement | null;
  const title = document.getElementById("modal-title") as HTMLElement | null;
  const body = document.getElementById("modal-body") as HTMLElement | null;
  const foot = document.getElementById("modal-foot") as HTMLElement | null;
  if (!overlay || !box || !body || !foot || !title) return () => {};

  title.textContent = spec.title;
  body.innerHTML = "";
  foot.innerHTML = "";

  const close = () => {
    overlay.hidden = true;
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); }
  };

  if (spec.body) {
    body.append(typeof spec.body === "string" ? el("p", {}, [spec.body]) : spec.body);
  }

  const inputs: Record<string, HTMLInputElement> = {};
  for (const f of spec.fields ?? []) {
    const input = el("input", {
      id: `f-${f.name}`,
      type: f.type ?? "text",
      value: f.value ?? "",
      placeholder: f.placeholder ?? "",
      autocomplete: "off",
      spellcheck: "false",
      class: f.type === "password" ? "inp mono" : "inp",
    });
    inputs[f.name] = input;
    body.append(el("div", { class: "modal__field" }, [
      el("label", { class: "lbl", for: `f-${f.name}` }, [f.label]),
      input,
    ]));
  }

  if (spec.render) spec.render(body, close);

  const cancel = el("button", { class: "btn", type: "button" }, [spec.cancelLabel ?? "Cancel"]);
  cancel.onclick = close;
  foot.append(cancel);

  if (spec.confirmLabel !== "") {
    const ok = el("button", {
      class: spec.danger ? "btn danger-pri" : "btn pri",
      type: "button",
    }, [spec.confirmLabel ?? "Confirm"]);
    ok.onclick = () => {
      const values: Record<string, string> = {};
      for (const [name, input] of Object.entries(inputs)) values[name] = input.value.trim();
      void spec.onConfirm?.(values);
      if (!spec.render) close();
    };
    body.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); ok.click(); }
    });
    foot.append(ok);
  }

  overlay.hidden = false;
  document.addEventListener("keydown", onKey, true);
  setTimeout(() => (body.querySelector("input") as HTMLInputElement | null)?.focus(), 40);
  return close;
}

export function fmtTime(ts: number): string {
  if (!ts) return "";
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " +
      d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

/** Fuzzy subsequence match: "gm" matches "gpt-4o-mini". Scored for ranking. */
export function fuzzy(needle: string, hay: string): number {
  if (!needle) return 1;
  const n = needle.toLowerCase();
  const h = hay.toLowerCase();
  const direct = h.indexOf(n);
  if (direct === 0) return 1000;
  if (direct > 0) return 800 - direct;
  let score = 0, hi = 0;
  for (const ch of n) {
    const found = h.indexOf(ch, hi);
    if (found < 0) return 0;
    score += found === hi ? 3 : 1;
    hi = found + 1;
  }
  return score;
}
