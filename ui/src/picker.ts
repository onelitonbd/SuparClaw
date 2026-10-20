// Model chooser — a bottom sheet: filter field, models grouped by provider,
// "Add provider…" pinned to the bottom.

import { el, fuzzy } from "./dom.js";

export function pickModel(opts: {
  current: string;
  models: string[];
  onPick: (ref: string) => void;
}): void {
  const overlay = document.getElementById("sheet-overlay") as HTMLElement | null;
  const list = document.getElementById("model-list") as HTMLElement | null;
  const filter = document.getElementById("model-filter") as HTMLInputElement | null;
  const addBtn = document.getElementById("sheet-add-provider") as HTMLElement | null;
  const scrim = document.getElementById("sheet-scrim") as HTMLElement | null;
  if (!overlay || !list || !filter || !addBtn || !scrim) return;

  const rows = opts.models.map((ref) => {
    const slash = ref.indexOf("/");
    return { ref, provider: slash > 0 ? ref.slice(0, slash) : "default" };
  });

  let selection = Math.max(0, rows.findIndex((r) => r.ref === opts.current));

  const close = () => {
    overlay.hidden = true;
    document.removeEventListener("keydown", onKey, true);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.stopPropagation(); close(); }
  };

  const render = () => {
    const q = filter.value.trim();
    const scored = rows
      .map((r) => ({ ...r, score: Math.max(fuzzy(q, r.ref), fuzzy(q, r.provider)) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref));
    list.innerHTML = "";
    if (scored.length === 0) {
      list.append(el("div", { class: "sheet__empty" }, ["No models match"]));
      return;
    }
    let group = "";
    for (const r of scored) {
      if (r.provider !== group) {
        group = r.provider;
        list.append(el("div", { class: "sheet__group" }, [group === "default" ? "default" : group]));
      }
      const check = el("span", { class: "sheet__check" });
      check.innerHTML =
        '<svg role="img" aria-label="Current model" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';
      const row = el("button", { class: "sheet__row", type: "button" }, [
        el("span", { class: "mono" }, [r.ref]),
        r.ref === opts.current ? check : null,
      ].filter(Boolean) as Node[]);
      row.onclick = () => { opts.onPick(r.ref); close(); };
      list.append(row);
    }
  };

  filter.value = "";
  filter.oninput = render;
  filter.onkeydown = (e) => {
    const items = Array.from(list.querySelectorAll(".sheet__row")) as HTMLElement[];
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      selection = Math.min(items.length - 1, Math.max(0, selection + (e.key === "ArrowDown" ? 1 : -1)));
      items[selection]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter") {
      e.preventDefault();
      items[selection]?.click();
    }
  };
  addBtn.onclick = () => {
    close();
    location.hash = "#/settings";
    setTimeout(() => document.getElementById("tab-providers")?.click(), 80);
  };
  scrim.onclick = close;

  render();
  overlay.hidden = false;
  document.addEventListener("keydown", onKey, true);
  setTimeout(() => filter.focus(), 60);
}
