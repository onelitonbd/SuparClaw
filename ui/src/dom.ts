// Tiny DOM helpers + the in-app dialog stack. Native prompt/confirm/alert are
// banned here: they break the design and are ugly on mobile.

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | undefined> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
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

export function toast(text: string, kind: "info" | "error" = "info"): void {
  const host = document.getElementById("toasts");
  if (!host) return;
  const node = el("div", { class: `toast${kind === "error" ? " err" : ""}` }, [text]);
  host.append(node);
  setTimeout(() => {
    node.style.transition = "opacity .25s";
    node.style.opacity = "0";
    setTimeout(() => node.remove(), 260);
  }, 3200);
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

/** Styled modal. Returns a close() function; Esc and backdrop click close it. */
export function modal(spec: ModalSpec): () => void {
  const backdrop = document.getElementById("backdrop") as HTMLElement;
  const box = document.getElementById("modal") as HTMLElement;
  box.innerHTML = "";

  const close = () => {
    backdrop.hidden = true;
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); }
  };

  box.append(el("h4", {}, [spec.title]));
  if (spec.body) box.append(typeof spec.body === "string" ? el("p", {}, [spec.body]) : spec.body);

  const inputs: Record<string, HTMLInputElement> = {};
  for (const f of spec.fields ?? []) {
    const input = el("input", {
      id: `f-${f.name}`, type: f.type ?? "text", value: f.value ?? "", placeholder: f.placeholder ?? "",
      autocomplete: "off", spellcheck: "false",
    });
    inputs[f.name] = input;
    box.append(el("div", { class: "field" }, [el("label", { for: `f-${f.name}` }, [f.label]), input]));
  }

  if (spec.render) spec.render(box, close);

  const actions = el("div", { class: "actions" }, []);
  actions.append(el("button", { class: "btn", id: "modal-cancel" }, [spec.cancelLabel ?? "Cancel"]));
  if (spec.confirmLabel !== "") {
    actions.append(
      el("button", { class: `btn primary${spec.danger ? " danger" : ""}`, id: "modal-ok" }, [spec.confirmLabel ?? "Confirm"]),
    );
  }
  box.append(actions);

  (actions.querySelector("#modal-cancel") as HTMLElement).onclick = close;
  const ok = actions.querySelector("#modal-ok") as HTMLElement | null;
  if (ok) {
    ok.onclick = () => {
      const values: Record<string, string> = {};
      for (const [name, input] of Object.entries(inputs)) values[name] = input.value.trim();
      void spec.onConfirm?.(values);
      if (!spec.render) close();
    };
    box.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !(e.target instanceof HTMLTextAreaElement)) { e.preventDefault(); ok.click(); }
    });
  }

  backdrop.hidden = false;
  backdrop.onclick = (e) => { if (e.target === backdrop) close(); };
  document.addEventListener("keydown", onKey, true);
  setTimeout(() => (box.querySelector("input") as HTMLInputElement | null)?.focus(), 30);
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
