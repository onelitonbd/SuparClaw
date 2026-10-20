// Settings: Model, Providers, Gateway, Runtime — tabbed, one card per block.

import { el, modal, toast } from "./dom.js";
import { gateway } from "./rpc.js";

type Provider = { baseUrl: string; apiKey: string; models?: string[]; headers?: Record<string, string> };

type TabId = "model" | "providers" | "gateway" | "runtime";

const TABS: { id: TabId; label: string }[] = [
  { id: "model", label: "Model" },
  { id: "providers", label: "Providers" },
  { id: "gateway", label: "Gateway" },
  { id: "runtime", label: "Runtime" },
];

export class Settings {
  #root: HTMLElement;
  #tabs: HTMLElement;
  #onChanged: () => void;
  #tab: TabId = "model";

  constructor(root: HTMLElement, onChanged: () => void) {
    this.#root = root;
    this.#tabs = document.getElementById("settings-tabs") as HTMLElement;
    this.#onChanged = onChanged;
  }

  async render(): Promise<void> {
    this.#renderTabs();

    // The gateway answers over the WebSocket. If it is not connected yet
    // (page just loaded, or reconnecting) every request would reject with
    // "not connected to gateway" — show a waiting state instead, and let
    // main.ts call render() again once the socket is up.
    if (gateway.state !== "online") {
      this.#root.innerHTML = "";
      this.#root.append(el("div", { class: "card" }, [
        el("div", { class: "row" }, [
          el("span", { class: "row__label" }, ["Gateway"]),
          el("span", { class: "row__value", style: "color:var(--warn)" }, [
            gateway.state === "unauthorized" ? "unauthorized" : "connecting…",
          ]),
        ]),
        el("p", { class: "hint" }, [
          gateway.state === "unauthorized"
            ? "The gateway rejected the connection. Reconnect and this page will reload."
            : "Waiting for the gateway to answer. This page fills in as soon as it does.",
        ]),
      ]));
      return;
    }

    let config: any = {};
    let models: string[] = [];
    let modelsWarning: string | undefined;
    let tools = 0, skills = 0;
    try {
      const [cfg, modelRes, toolRes, skillRes] = await this.#load();
      config = (cfg as any).config ?? {};
      models = (modelRes as any).models ?? [];
      modelsWarning = (modelRes as any).warning;
      tools = ((toolRes as any).tools ?? []).length;
      skills = ((skillRes as any).skills ?? []).length;
    } catch (err) {
      toast(`could not load config: ${(err as Error).message}`, "err");
    }

    const providers: Record<string, Provider> = config.providers ?? {};
    const defaults = config.agents?.defaults ?? {};
    const gw = config.gateway ?? {};

    this.#root.innerHTML = "";
    if (this.#tab === "model") this.#renderModel(defaults, models, modelsWarning);
    else if (this.#tab === "providers") this.#renderProviders(providers);
    else if (this.#tab === "gateway") this.#renderGateway(gw);
    else this.#renderRuntime(config, { tools, skills, models: models.length });
  }

  #renderTabs(): void {
    this.#tabs.innerHTML = "";
    for (const t of TABS) {
      const btn = el("button", {
        class: `tab${t.id === this.#tab ? " is-active" : ""}`,
        type: "button",
        id: `tab-${t.id}`,
      }, [t.label]);
      btn.onclick = () => {
        this.#tab = t.id;
        void this.render();
      };
      this.#tabs.append(btn);
    }
  }

  /* ---------------- model ---------------- */

  #renderModel(defaults: any, models: string[], warning?: string): void {
    const input = el("input", {
      class: "inp mono",
      id: "default-model",
      value: defaults.model ?? "",
      placeholder: "provider/model",
      autocomplete: "off",
      spellcheck: "false",
    });
    const fallback = el("input", {
      class: "inp mono",
      id: "fallback-models",
      value: (defaults.fallbacks ?? []).join(", "),
      placeholder: "provider/model, provider/model",
      autocomplete: "off",
      spellcheck: "false",
    });

    const saved = el("div", { class: "list" });
    for (const m of models.slice(0, 20)) {
      const isDef = m === defaults.model;
      const action = isDef
        ? el("span", { class: "sheet__check", style: "font-size:12px;font-weight:600;color:var(--accent);background:var(--accsoft);padding:3px 10px;border-radius:999px" }, ["Default"])
        : el("button", { class: "btn sm", type: "button" }, ["Set default"]);
      if (!isDef) {
        (action as HTMLElement).onclick = () => {
          input.value = m;
          toast("default model updated — save to apply", "info");
        };
      }
      saved.append(el("div", { class: "row" }, [
        el("span", { class: "session__text" }, [
          el("span", { class: "session__title mono" }, [m]),
          el("span", { class: "session__meta" }, [m.includes("/") ? (m.split("/")[0] ?? "default") : "default"]),
        ]),
        action,
      ] as Node[]));
    }

    const save = el("button", { class: "btn pri", type: "button" }, ["Save changes"]);
    save.onclick = async () => {
      const fb = fallback.value.split(",").map((s) => s.trim()).filter(Boolean);
      await this.#setMany([
        ["agents.defaults.model", input.value.trim()],
        ["agents.defaults.fallbacks", fb],
      ], "model saved");
    };

    this.#root.append(
      el("div", { class: "card" }, [
        el("label", { class: "lbl", for: "default-model" }, ["Default model"]),
        input,
        el("p", { class: "hint" }, ["Used for every new session."]),
        el("div", { class: "modal__field" }, [
          el("label", { class: "lbl", for: "fallback-models" }, ["Fallbacks"]),
          fallback,
          el("p", { class: "hint" }, ["Tried in order when the default model fails."]),
        ]),
      ]),
      el("div", { class: "card", style: "padding:8px 16px" }, [
        el("div", { class: "cap", style: "padding:8px 0;display:flex;align-items:center;gap:8px" }, [
          el("span", {}, ["Available models"]),
          (() => {
            const refresh = el("button", { class: "btn sm", type: "button", style: "margin-left:auto" }, [
              "↻ Refresh",
            ]);
            refresh.onclick = async () => {
              try {
                const res = (await gateway.request("models.list", { refresh: true })) as any;
                toast(
                  res.warning ? `saved rows shown — ${res.warning}` : `${(res.models ?? []).length} models`,
                  res.warning ? "info" : "ok",
                );
                await this.render();
              } catch (err) {
                toast((err as Error).message, "err");
              }
            };
            return refresh;
          })(),
        ]),
        warning
          ? el("p", { class: "hint", style: "color:var(--warn)" }, [warning])
          : el("span", {}),
        saved,
      ]),
      save,
    );
  }

  /* ---------------- providers ---------------- */

  #renderProviders(providers: Record<string, Provider>): void {
    const body = el("div", { class: "settings__body" });
    for (const [name, p] of Object.entries(providers)) {
      const edit = el("button", { class: "btn", type: "button" }, ["Edit"]);
      edit.onclick = () => this.#providerForm(name, providers, () => void this.render());
      const remove = el("button", { class: "btn danger", type: "button" }, ["Remove"]);
      remove.onclick = () => this.#removeProvider(name, providers, () => void this.render());

      body.append(el("div", { class: "card" }, [
        el("div", { class: "prov" }, [
          el("div", { class: "prov__head" }, [
            el("span", { class: "prov__name" }, [name]),
            el("span", { class: "prov__count" }, [`${(p.models ?? []).length} models`]),
          ]),
          el("div", { class: "prov__url" }, [p.baseUrl ?? ""]),
          el("div", { class: "prov__key" }, [maskKey(p.apiKey ?? "")]),
          el("div", { class: "prov__row" }, [edit, remove]),
        ]),
      ]));
    }

    const plus = el("span");
    plus.innerHTML = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
    const add = el("button", { class: "btn pri", type: "button" }, [plus, "Add provider"]);
    add.onclick = () => this.#providerForm(null, providers, () => void this.render());

    this.#root.append(body, add);
  }

  /* ---------------- gateway ---------------- */

  #renderGateway(gw: any): void {
    const port = el("input", {
      class: "inp mono", id: "gw-port", value: String(gw.port ?? 18790), inputmode: "numeric",
    });
    const mode = el("input", {
      class: "inp mono", id: "gw-mode", value: gw.auth?.mode ?? "token",
    });
    const rawToken = String(gw.auth?.token ?? "");
    const token = el("div", { class: "inp mono" }, [rawToken ? "••••••••" + rawToken.slice(-4) : "Not set"]);

    const save = el("button", { class: "btn pri", type: "button" }, ["Save and restart gateway"]);
    save.onclick = async () => {
      await this.#setMany([
        ["gateway.port", Number(port.value) || (gw.port ?? 18790)],
        ["gateway.auth.mode", mode.value.trim() || "token"],
      ], "gateway saved — reconnecting");
      location.reload();
    };

    this.#root.append(
      el("div", { class: "card" }, [
        el("div", {}, [
          el("label", { class: "lbl", for: "gw-port" }, ["Port"]),
          port,
        ]),
        el("div", { class: "modal__field" }, [
          el("span", { class: "lbl" }, ["Auth token"]),
          token,
          el("p", { class: "hint" }, ["Clients send this token when they connect."]),
        ]),
        el("div", { class: "modal__field" }, [
          el("label", { class: "lbl", for: "gw-mode" }, ["Auth mode"]),
          mode,
          el("p", { class: "hint" }, ["token requires a secret; none allows any local client."]),
        ]),
      ]),
      save,
    );
  }

  /* ---------------- runtime ---------------- */

  #renderRuntime(config: any, counts: { tools: number; skills: number; models: number }): void {
    const rows: [string, string, string?][] = [
      ["Status", "Running", "color:var(--ok)"],
      ["Version", "0.1.0"],
      ["Tools", String(counts.tools)],
      ["Skills", String(counts.skills)],
      ["Models", String(counts.models)],
      ["Telegram", config.channels?.telegram?.enabled ? "on" : "off"],
      ["Cron", config.cron?.enabled ? `${config.cron.jobs ?? 0} jobs` : "off"],
      ["Providers", String(Object.keys(config.providers ?? {}).length)],
    ];

    const list = el("div", { class: "card", style: "padding:0;overflow:hidden" });
    for (const [k, v, style] of rows) {
      list.append(el("div", { class: "row", style: "padding:14px 16px" }, [
        el("span", { class: "row__label" }, [k]),
        el("span", { class: "row__value", style }, [v]),
      ]));
    }

    const tiles = el("div", { class: "tiles" }, [
      tile(String(counts.tools), "tools"),
      tile(String(counts.skills), "skills"),
      tile(String(counts.models), "models"),
      tile(String(Object.keys(config.providers ?? {}).length), "providers"),
    ]);

    this.#root.append(tiles, list);
  }

  /* ---------------- helpers ---------------- */

  /** The four calls the settings page needs, with one retry for a socket that
   *  is still settling. */
  async #load(): Promise<any[]> {
    const call = () =>
      Promise.all([
        gateway.request("config.get"),
        gateway.request("models.list"),
        gateway.request("tools.list"),
        gateway.request("skills.list"),
      ]);
    try {
      return await call();
    } catch (err) {
      await new Promise((r) => setTimeout(r, 400));
      if (gateway.state !== "online") throw err;
      return await call();
    }
  }

  async #setMany(pairs: [string, unknown][], message: string): Promise<void> {
    try {
      for (const [path, value] of pairs) {
        await gateway.request("config.set", { path, value });
      }
      toast(message, "ok");
      this.#onChanged();
    } catch (err) {
      toast((err as Error).message, "err");
    }
  }

  #providerForm(name: string | null, providers: Record<string, Provider>, done: () => void): void {
    modal({
      title: name ? `Edit ${name}` : "Add provider",
      fields: [
        { name: "name", label: "Name", value: name ?? "", placeholder: "openrouter" },
        { name: "baseUrl", label: "Base URL", value: name ? providers[name]?.baseUrl ?? "" : "", placeholder: "https://openrouter.ai/api/v1" },
        { name: "apiKey", label: "API key", type: "password", value: "", placeholder: name ? "leave blank to keep current key" : "sk-…" },
        { name: "models", label: "Models (comma separated)", value: name ? (providers[name]?.models ?? []).join(", ") : "", placeholder: "gpt-4o-mini, claude-3.5-sonnet" },
      ],
      confirmLabel: name ? "Save" : "Add",
      onConfirm: async (v) => {
        const providerName = ((v.name ?? "") || name || "").trim();
        if (!providerName) { toast("name is required", "err"); return; }
        const typedKey = (v.apiKey ?? "").trim();
        // Blank key on edit = keep the stored key (the wire only ever carries
        // the redaction sentinel — see src/config/redact.ts).
        const apiKey = typedKey || (name ? providers[name]?.apiKey ?? "" : "");
        const models = (v.models ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        try {
          // The shared path (same as CLI/TUI/Telegram): when the models field
          // is left empty, the gateway discovers the provider's live list.
          const res = (await gateway.request("providers.add", {
            name: providerName,
            previousName: name ?? "",
            baseUrl: (v.baseUrl ?? "").trim(),
            apiKey,
            models,
          })) as any;
          if (name && name !== providerName) {
            await gateway.request("providers.remove", { name });
          }
          toast(String(res.message ?? (name ? `${providerName} updated` : `${providerName} added`)).split("\n")[0] ?? "saved", "ok");
          done();
          this.#onChanged();
        } catch (err) {
          toast((err as Error).message, "err");
        }
      },
    });
  }

  #removeProvider(name: string, providers: Record<string, Provider>, done: () => void): void {
    modal({
      title: "Remove provider?",
      body: `This removes ${name} and its ${(providers[name]?.models ?? []).length} models. Sessions using them fall back to the default model.`,
      confirmLabel: "Remove",
      danger: true,
      onConfirm: async () => {
        try {
          const res = (await gateway.request("providers.remove", { name })) as any;
          toast(String(res.message ?? `${name} removed`).split("\n")[0] ?? "removed", "ok");
          done();
          this.#onChanged();
        } catch (err) {
          toast((err as Error).message, "err");
        }
      },
    });
  }
}

function tile(value: string, label: string): HTMLElement {
  return el("div", { class: "card tile" }, [
    el("div", { class: "tile__v" }, [value]),
    el("div", { class: "tile__k" }, [label]),
  ]);
}

function maskKey(key: string): string {
  if (!key) return "—";
  // The gateway already redacts secrets on the wire ("__redacted__:••••1234").
  if (key.startsWith("__redacted__:")) return key.slice("__redacted__:".length) || "••••";
  return key.length > 8 ? `${key.slice(0, 3)}••••••••${key.slice(-4)}` : "••••••••";
}
