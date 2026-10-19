// Model chooser: searchable, grouped by provider, keyboard navigable.

import { el, fuzzy, modal } from "./dom.js";

export function pickModel(opts: {
  current: string;
  models: string[];
  onPick: (ref: string) => void;
}): void {
  const rows: { ref: string; provider: string; score: number }[] = opts.models.map((ref) => {
    const slash = ref.indexOf("/");
    return { ref, provider: slash > 0 ? ref.slice(0, slash) : "default", score: 0 };
  });

  let selection = Math.max(0, rows.findIndex((r) => r.ref === opts.current));

  modal({
    title: "Choose model",
    confirmLabel: "",
    cancelLabel: "Close",
    render: (box, close) => {
      const search = el("input", { placeholder: "filter models…  (↑↓ move · ⏎ select)", autocomplete: "off", spellcheck: "false" });
      const list = el("div", { class: "picker-list" });
      box.append(search, list);

      const renderList = () => {
        const q = search.value.trim();
        const scored = rows
          .map((r) => ({ ...r, score: Math.max(fuzzy(q, r.ref), fuzzy(q, r.provider)) }))
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score || a.ref.localeCompare(b.ref));
        list.innerHTML = "";
        if (scored.length === 0) {
          list.append(el("p", { style: "color:var(--muted);padding:12px" }, ["no models match — add providers in Settings"]));
          return;
        }
        let group = "";
        for (const [i, r] of scored.entries()) {
          if (r.provider !== group) {
            group = r.provider;
            list.append(el("div", { class: "picker-group" }, [group]));
          }
          const item = el("button", { class: `picker-item${i === selection ? " sel" : ""}`, type: "button" }, [
            el("span", { class: "check" }, [r.ref === opts.current ? "✓" : ""]),
            el("span", { class: "ref" }, [r.provider === "default" ? r.ref : r.ref.slice(r.provider.length + 1)]),
            el("span", { class: "prov" }, [r.provider === "default" ? "" : r.provider]),
          ]);
          item.onclick = () => { opts.onPick(r.ref); close(); };
          item.onmouseenter = () => {
            selection = i;
            list.querySelectorAll(".picker-item").forEach((n) => n.classList.remove("sel"));
            item.classList.add("sel");
          };
          list.append(item);
        }
        (list.querySelectorAll(".picker-item")[0] as HTMLElement | null)?.scrollIntoView({ block: "nearest" });
      };

      search.oninput = () => { selection = 0; renderList(); };
      search.onkeydown = (e) => {
        const items = Array.from(list.querySelectorAll(".picker-item")) as HTMLElement[];
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          selection = Math.min(items.length - 1, Math.max(0, selection + (e.key === "ArrowDown" ? 1 : -1)));
          items.forEach((n, i) => n.classList.toggle("sel", i === selection));
          items[selection]?.scrollIntoView({ block: "nearest" });
        } else if (e.key === "Enter") {
          e.preventDefault();
          items[selection]?.click();
        }
      };
      renderList();
      setTimeout(() => search.focus(), 40);
    },
  });
}
