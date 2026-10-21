// Settings: Defaults, Models, Providers, Skills, Tools, Gateway, Runtime —
// tabbed, one card per block.

import { el, modal, toast } from "./dom.js";
import { gateway } from "./rpc.js";

type Provider = { baseUrl: string; apiKey: string; models?: string[]; headers?: Record<string, string> };

type TabId = "model" | "models" | "providers" | "skills" | "tools" | "memory" | "gateway" | "runtime";

const TABS: { id: TabId; label: string }[] = [
  { id: "model", label: "Defaults" },
  { id: "models", label: "Models" },
  { id: "providers", label: "Providers" },
  { id: "skills", label: "Skills" },
  { id: "tools", label: "Tools" },
  { id: "memory", label: "Memory" },
  { id: "gateway", label: "Gateway" },
  { id: "runtime", label: "Runtime" },
];

export class Settings {
  #root: HTMLElement;
  #tabs: HTMLElement;
  #onChanged: () => void;
  #tab: TabId = "model";
  /** Models tab drill-down: provider name when its model list is open. */
  #modelsProvider: string | null = null;
  /** Search text on the provider model list (survives re-renders). */
  #modelQuery = "";

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
    let configured: any[] = [];
    let details: Record<string, any> = {};
    let tools: any[] = [];
    let skills: any[] = [];
    let authProfiles: any[] = [];
    let plugins: any[] = [];
    try {
      const [cfg, modelRes, toolRes, skillRes, pluginRes] = await this.#load();
      config = (cfg as any).config ?? {};
      models = (modelRes as any).models ?? [];
      modelsWarning = (modelRes as any).warning;
      configured = (modelRes as any).configured ?? [];
      details = (modelRes as any).details ?? {};
      authProfiles = (modelRes as any).auth ?? [];
      tools = (toolRes as any).tools ?? [];
      skills = (skillRes as any).skills ?? [];
      plugins = (pluginRes as any).plugins ?? [];
    } catch (err) {
      toast(`could not load config: ${(err as Error).message}`, "err");
    }

    const providers: Record<string, Provider> = config.providers ?? {};
    const defaults = config.agents?.defaults ?? {};
    const gw = config.gateway ?? {};

    this.#root.innerHTML = "";
    if (this.#tab === "model") {
      // Defaults tab offers the SELECTED models only — the strict filter.
      this.#renderModel(defaults, configured.filter((m) => m.enabled), modelsWarning);
    } else if (this.#tab === "models") {
      if (this.#modelsProvider) {
        this.#renderProviderModels(this.#modelsProvider, providers, configured, models, details, modelsWarning);
      } else {
        this.#renderModels(providers, configured, models, authProfiles, plugins);
      }
    } else if (this.#tab === "providers") this.#renderProviders(providers);
    else if (this.#tab === "skills") this.#renderSkills(skills);
    else if (this.#tab === "tools") this.#renderTools(tools);
    else if (this.#tab === "memory") await this.#renderMemory();
    else if (this.#tab === "gateway") this.#renderGateway(gw);
    else await this.#renderRuntime(config, { tools: tools.length, skills: skills.length, models: models.length });
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
        this.#modelsProvider = null;
        void this.render();
      };
      this.#tabs.append(btn);
    }
  }

  /* ---------------- model ---------------- */

  #renderModel(defaults: any, selected: any[], _warning?: string): void {
    // Pure selection: every choice comes from the models checked in the Models
    // tab — no typing refs. The fallback list is ordered and uncapped (10+).
    const options = (selected as any[]).map((m) => ({
      value: String(m.id ?? m.ref ?? ""),
      label: String(m.label || m.ref || m.id),
    }));

    const makeSelect = (value: string, emptyLabel: string): HTMLSelectElement => {
      const sel = el("select", { class: "inp mono" }) as HTMLSelectElement;
      const empty = el("option", { value: "" }, [emptyLabel]) as HTMLOptionElement;
      if (!value) empty.selected = true;
      sel.append(empty);
      for (const o of options) {
        const opt = el("option", { value: o.value }, [o.label]) as HTMLOptionElement;
        if (o.value === value) opt.selected = true;
        sel.append(opt);
      }
      // Keep a stored value visible even when its model is no longer selected.
      if (value && !options.some((o) => o.value === value)) {
        const opt = el("option", { value }, [`${value} (not selected)`]) as HTMLOptionElement;
        opt.selected = true;
        sel.append(opt);
      }
      return sel;
    };

    const defaultSel = makeSelect(String(defaults.model ?? ""), "— choose a model —");

    const fbRows = el("div", { class: "list" });
    const fallbackValues: string[] = [...(defaults.fallbacks ?? [])];
    const redrawFallbacks = (): void => {
      fbRows.innerHTML = "";
      fallbackValues.forEach((val, i) => {
        const sel = makeSelect(val, "— choose a model —");
        sel.onchange = () => {
          fallbackValues[i] = sel.value;
        };
        const up = el("button", { class: "btn sm", type: "button", "aria-label": "Move up" }, ["↑"]) as HTMLButtonElement;
        up.disabled = i === 0;
        up.onclick = () => {
          const t = fallbackValues[i - 1] as string;
          fallbackValues[i - 1] = fallbackValues[i] as string;
          fallbackValues[i] = t;
          redrawFallbacks();
        };
        const down = el("button", { class: "btn sm", type: "button", "aria-label": "Move down" }, ["↓"]) as HTMLButtonElement;
        down.disabled = i === fallbackValues.length - 1;
        down.onclick = () => {
          const t = fallbackValues[i + 1] as string;
          fallbackValues[i + 1] = fallbackValues[i] as string;
          fallbackValues[i] = t;
          redrawFallbacks();
        };
        const rm = el("button", { class: "btn sm danger", type: "button" }, ["✕"]) as HTMLButtonElement;
        rm.onclick = () => {
          fallbackValues.splice(i, 1);
          redrawFallbacks();
        };
        fbRows.append(el("div", { class: "row", style: "padding:8px 16px;gap:8px" }, [
          el("span", { class: "row__label", style: "min-width:28px" }, [`#${i + 1}`]),
          sel, up, down, rm,
        ]));
      });
    };
    redrawFallbacks();

    const add = el("button", { class: "btn", type: "button" }, ["+ Add fallback"]);
    add.onclick = () => {
      fallbackValues.push("");
      redrawFallbacks();
    };

    const save = el("button", { class: "btn pri", type: "button" }, ["Save changes"]);
    save.onclick = async () => {
      const fb = fallbackValues.map((v) => v.trim()).filter(Boolean);
      await this.#setMany([
        ["agents.defaults.model", defaultSel.value],
        ["agents.defaults.fallbacks", fb],
      ], "model saved");
    };

    this.#root.append(
      el("div", { class: "card" }, [
        el("div", { class: "modal__field" }, [
          el("label", { class: "lbl" }, ["Default model"]),
          defaultSel,
          el("p", { class: "hint" }, [
            options.length === 0
              ? "No models selected yet — check models in the Models tab first."
              : "Used for every new session. Choose from the models you selected in the Models tab.",
          ]),
        ]),
      ]),
      el("div", { class: "card", style: "padding:8px 16px" }, [
        el("div", { class: "cap", style: "padding:8px 0;display:flex;align-items:center;gap:8px" }, [
          el("span", {}, ["Fallback models"]),
          el("span", { class: "hint", style: "margin-left:auto" }, [`${fallbackValues.length} configured`]),
        ]),
        el("p", { class: "hint" }, [
          "Tried in order when a model fails (each gets its own retry budget). Add as many as you like — at least 10 fit.",
        ]),
        fbRows,
        add,
      ]),
      save,
    );
  }

  /* ---------------- models ---------------- */

  // Provider-first selection surface: a provider card opens a sub-page with
  // its fetched models; the checkbox marks which models exist "in the system"
  // (strict filter — unmarked models appear nowhere), and clicking a model
  // tunes its capabilities in a popup.

  #renderModels(
    providers: Record<string, Provider>,
    configured: any[],
    discovered: string[],
    auth: any[] = [],
    plugins: any[] = [],
  ): void {
    const selected = new Set(configured.filter((m) => m.enabled).map((m) => m.ref));
    const body = el("div", { class: "settings__body" });

    body.append(el("div", { class: "card" }, [
      el("div", { class: "row__label" }, ["Models"]),
      el("p", { class: "hint" }, [
        "Pick which models are in the system. Click a provider to see the models fetched from it — only checked models appear in the model picker and everywhere else. Connect signs a provider in via an auth profile (API key or OAuth device code).",
      ]),
    ]));

    const names = Object.keys(providers);
    if (names.length === 0) {
      body.append(el("div", { class: "card" }, [
        el("p", { class: "hint" }, ["No providers yet — connect one below, or add one in the Providers tab."]),
      ]));
    }
    for (const name of names) {
      const refs = discovered.filter((r) => r.startsWith(`${name}/`));
      const chosen = refs.filter((r) => selected.has(r)).length;
      const open = el("button", { class: "btn sm", type: "button" }, ["Open"]);
      const mine = auth.filter((p: any) => p.provider === name);
      const binding = (providers[name] as any)?.apiKey ?? "";
      const bound = mine.find((p: any) => p.id === binding) ?? null;
      const chips = mine.slice(0, 6).map((p: any) => this.#profileChip(p, name, mine));
      const connect = el("button", { class: "btn sm", type: "button" }, [bound ? "Auth…" : "Connect"]);
      connect.onclick = (e) => {
        e.stopPropagation();
        this.#connectProvider(name, plugins.find((p: any) => p.id === name) ?? null, binding);
      };
      const card = el("div", { class: "card" }, [
        el("div", { class: "prov" }, [
          el("div", { class: "prov__head" }, [
            el("span", { class: "prov__name" }, [name]),
            el("span", { class: "prov__count" }, [`${chosen} of ${refs.length} selected`]),
          ]),
          el("div", { class: "prov__url" }, [providers[name]?.baseUrl ?? ""]),
          el("div", { class: "row" }, [
            el("span", { class: "row__label" }, ["Auth"]),
            el("span", { class: "row__value" }, [
              bound
                ? `profile ${bound.id} · ${bound.ok ? "ok" : (bound.reason ?? "?")}`
                : binding
                  ? "inline key"
                  : "none — connect below",
            ]),
          ]),
          ...(chips.length ? [el("div", { class: "prov__row", style: "display:flex;gap:6px;flex-wrap:wrap" }, chips)] : []),
          el("div", { class: "prov__row", style: "display:flex;gap:6px" }, [open, connect]),
        ]),
      ]);
      const go = () => {
        this.#modelsProvider = name;
        void this.render();
      };
      open.onclick = go;
      (card as HTMLElement).style.cursor = "pointer";
      (card as HTMLElement).onclick = go;
      body.append(card);
    }

    // Local services card (their implicit local discovery): lazy scan so the
    // tab never waits on a dead 11434 — results fill in when they arrive.
    const localCard = el("div", { class: "card" }, [
      el("div", { class: "row__label" }, ["Local services"]),
      el("p", { class: "hint" }, ["scanning this device for Ollama / LM Studio / vLLM / SGLang / llama.cpp…"]),
    ]);
    body.append(localCard);
    void this.#fillLocalServices(localCard, names);

    // Their Settings → Models → Connect provider: plugins not yet configured.
    const fresh = plugins.filter((p: any) => !names.includes(p.id));
    if (fresh.length) {
      const rows = fresh.slice(0, 12).map((p: any) => {
        const b = el("button", { class: "btn sm", type: "button" }, ["Connect"]);
        b.onclick = () => this.#connectProvider(p.id, p, "");
        return el("div", { class: "row" }, [
          el("span", { class: "row__label" }, [p.id]),
          el("span", { class: "row__value" }, [p.label]),
          b,
        ]);
      });
      body.append(el("div", { class: "card" }, [
        el("div", { class: "row__label" }, ["Connect provider"]),
        el("p", { class: "hint" }, ["Provider plugins with declared auth flows — the same entry point as the CLI (`sc models auth login`)."]),
        ...rows,
      ]));
    }

    this.#root.append(body);
  }

  /** Local services discovery rows: state dot, models with ctx hints, Add. */
  async #fillLocalServices(card: HTMLElement, configuredNames: string[]): Promise<void> {
    let scan: any = null;
    try {
      scan = (await gateway.request("models.local.scan", {})) as any;
    } catch {
      /* older gateway: leave the placeholder as-is */
    }
    if (!scan?.services || !this.#root.contains(card)) return;
    card.innerHTML = "";
    card.append(el("div", { class: "row__label" }, ["Local services"]));
    const running = scan.services.filter((s: any) => s.running);
    if (running.length === 0 && scan.services.every((s: any) => !s.running)) {
      card.append(el("p", { class: "hint" }, ["no local services running — install Ollama or LM Studio and they'll appear here."]));
      return;
    }
    for (const svc of scan.services) {
      const isConfigured = configuredNames.includes(svc.id);
      const add = el("button", { class: "btn sm", type: "button" }, [
        !svc.running ? "" : isConfigured ? "↻ re-scan" : "Add",
      ]);
      if (!svc.running) (add as HTMLButtonElement).disabled = true;
      (add as HTMLButtonElement).onclick = async () => {
        add.disabled = true;
        try {
          const res: any = await gateway.request("models.local.add", { service: svc.id });
          if (!res.ok) throw new Error(res.message ?? "add failed");
          toast(`${res.message}`, "ok");
          await this.render();
        } catch (err) {
          toast((err as Error).message, "err");
          add.disabled = false;
        }
      };
      card.append(el("div", { class: "row" }, [
        el("span", { class: "row__label" }, [svc.id]),
        el("span", { class: "row__value" }, [
          svc.running
            ? `running · ${svc.models.length} model(s) · ${svc.api === "ollama" ? "native api" : "openai-compat"}${isConfigured ? " · configured" : ""}`
            : (svc.error ?? "not running"),
        ]),
        add,
      ]));
      if (svc.running && svc.models.length) {
        card.append(el("div", { class: "hint", style: "padding:0 4px 4px" }, [
          svc.models
            .slice(0, 6)
            .map((m: string) => `${m}${svc.hints?.[m]?.contextWindow ? ` (ctx ${Math.round(svc.hints[m].contextWindow / 1000)}k)` : ""}`)
            .join("  ·  ") + (svc.models.length > 6 ? `  ·  +${svc.models.length - 6} more` : ""),
        ]));
      }
    }
    card.append(el("p", { class: "hint" }, ["CLI: sc models local --add <service> — Ollama uses the native /api/chat wire (their warning: /v1 compat breaks tool calling)."]));
  }

  /** Profile chip: status dot, expiry, ordering, remove — material never shown. */
  #profileChip(p: any, provider: string, mine: any[]): HTMLElement {
    const state = p.ok ? "✔" : p.reason === "cooldown" ? "◌" : "✖";
    const chip = el(
      "span",
      {
        class: "prov__count",
        title: `${p.label || p.id}${p.reason ? ` — ${p.reason}` : ""} · fails ${p.failCount}`,
        style: `cursor:pointer;border:1px solid var(--line);border-radius:999px;padding:2px 8px;${p.ok ? "" : "color:var(--err)"}`,
      },
      [`${state} ${p.id}${p.expires ? ` (${p.expiresIn})` : ""}`],
    );
    chip.onclick = async (e) => {
      e.stopPropagation();
      const idx = mine.findIndex((x: any) => x.id === p.id);
      const up = idx > 0;
      const move = up
        ? [...mine.slice(0, idx - 1), mine[idx], mine[idx - 1], ...mine.slice(idx + 1)]
        : mine;
      if (up) {
        await gateway.request("models.auth.order", { provider, ids: move.map((x: any) => x.id) });
        await this.render();
        return;
      }
      const ok = confirm(`Remove profile "${p.id}"? The provider binding is cleared with it.`);
      if (!ok) return;
      const res: any = await gateway.request("models.auth.remove", { profile: p.id });
      res.ok === false ? toast(res.message ?? "remove failed", "err") : toast(`removed ${p.id}`, "ok");
      await this.render();
    };
    return chip;
  }

  /** Connect provider modal — paste key/token first (their Connect-provider
   * default), OAuth device-code offered when the plugin declares one. */
  #connectProvider(name: string, plugin: any | null, currentBinding: string): void {
    const methods: string[] = plugin?.authMethods?.length ? plugin.authMethods : ["api-key", "token"];
    const methodSel = el("select", { class: "inp", id: "auth-method" }) as HTMLSelectElement;
    for (const m of methods) {
      const opt = el("option", { value: m }, [m === "device-code" ? "device code (OAuth — approve in a browser)" : m.replace("-", " ")]) as HTMLOptionElement;
      methodSel.append(opt);
    }
    const keyInp = el("input", { class: "inp mono", id: "auth-key", type: "password", placeholder: "paste the credential", autocomplete: "off" }) as HTMLInputElement;
    const keyRow = el("div", { class: "modal__field" }, [
      el("label", { class: "lbl", for: "auth-key" }, [plugin?.env ? `key (env ${plugin.env} also exists)` : "key / token"]),
      keyInp,
    ]);
    const setDef = el("input", { type: "checkbox", id: "auth-def" }) as HTMLInputElement;
    const deviceBox = el("div", { class: "modal__field" }, []) as HTMLDivElement;
    deviceBox.style.display = "none";
    const syncMethod = () => {
      const dc = methodSel.value === "device-code";
      keyRow.style.display = dc ? "none" : "";
      deviceBox.style.display = dc ? "block" : "";
    };
    methodSel.onchange = syncMethod;

    let flowPoll: number | null = null;
    const stopPoll = () => {
      if (flowPoll !== null) clearInterval(flowPoll);
      flowPoll = null;
    };
    modal({
      title: `Connect ${name}`,
      confirmLabel: "Connect",
      render: (body, close) => {
        const confirmBtn = () => {
          const btn = document.querySelector("#modal-foot .btn.pri") as HTMLButtonElement | null;
          return btn;
        };
        if (plugin?.authMethods?.includes("device-code")) {
          const begin = el("button", { class: "btn", type: "button" }, ["Start device login"]);
          const note = el("p", { class: "hint" }, ["Approve in any browser — no callback needed on this machine."]);
          begin.onclick = async () => {
            begin.disabled = true;
            begin.textContent = "contacting provider…";
            try {
              const res = (await gateway.request("models.auth.beginDeviceCode", { provider: name })) as any;
              if (!res.ok) throw new Error(res.message ?? "device login unavailable");
              const { flow, userCode, verificationUri } = res;
              note.textContent = "";
              deviceBox.innerHTML = "";
              const link = el("a", { href: verificationUri, target: "_blank", rel: "noopener" }, [verificationUri]);
              deviceBox.append(
                el("p", {}, ["1. open ", link]),
                el("p", { class: "mono", style: "font-size:18px;letter-spacing:2px" }, [String(userCode)]),
                el("p", { class: "hint" }, ["2. enter the code — this window polls until approved or expired."]),
              );
              flowPoll = window.setInterval(async () => {
                try {
                  const st = (await gateway.request("models.auth.pollDeviceCode", { flow, setDefault: setDef.checked })) as any;
                  if (st.status === "pending") return;
                  stopPoll();
                  if (st.status === "ok") {
                    toast(`connected ${st.profile} (${st.models ?? 0} models discovered)`, "ok");
                    close();
                    await this.render();
                  } else {
                    toast(`device login ${st.status}: ${st.error ?? ""}`, "err");
                    close();
                  }
                } catch (err) {
                  stopPoll();
                  toast((err as Error).message, "err");
                }
              }, 3000);
            } catch (err) {
              toast((err as Error).message, "err");
              begin.disabled = false;
              begin.textContent = "Start device login";
            }
          };
          deviceBox.innerHTML = "";
          deviceBox.append(begin, note);
          // confirm button only applies to paste-key flow; hide it for device-code
          methodSel.onchange = () => {
            syncMethod();
            const b = confirmBtn();
            if (b) b.style.display = methodSel.value === "device-code" ? "none" : "";
          };
          methodSel.onchange(new Event("change"));
        }
        body.append(
          el("div", { class: "modal__field" }, [
            el("label", { class: "lbl", for: "auth-method" }, ["Method"]),
            methodSel,
            el("p", { class: "hint" }, [
              plugin?.label ?? name,
              currentBinding ? ` · currently bound to ${currentBinding}` : "",
              " — saves an auth profile and binds it to this provider (the CLI equivalent: sc models auth login).",
            ]),
          ]),
          keyRow,
          deviceBox,
          el("div", { class: "modal__field" }, [
            el("label", { class: "lbl" }, [setDef, " make it the default model"]),
          ]),
        );
      },
      onConfirm: async () => {
        try {
          const key = keyInp.value.trim();
          if (!key) {
            toast("paste the key first", "err");
            return;
          }
          const res = (await gateway.request("models.auth.addKey", {
            provider: name,
            method: methodSel.value === "token" ? "token" : "api-key",
            key,
            setDefault: setDef.checked,
          })) as any;
          if (!res.ok) {
            toast(res.message ?? "login failed", "err");
            return;
          }
          stopPoll();
          toast(`profile ${res.profile} saved${res.models ? ` · ${res.models} models discovered` : ""}`, "ok");
          await this.render();
        } catch (err) {
          toast((err as Error).message, "err");
        }
      },
    });
  }

  #renderProviderModels(
    provider: string,
    providers: Record<string, Provider>,
    configured: any[],
    discovered: string[],
    details: Record<string, any>,
    warning?: string,
  ): void {
    const byRef = new Map<string, any>();
    for (const m of configured as any[]) byRef.set(m.ref, m);
    const rows = discovered.filter((r) => r.startsWith(`${provider}/`)).sort();

    const back = el("button", { class: "btn sm", type: "button" }, ["← Providers"]);
    back.onclick = () => {
      this.#modelsProvider = null;
      void this.render();
    };
    const refresh = el("button", { class: "btn sm", type: "button" }, ["↻ Refresh"]);
    refresh.onclick = async () => {
      try {
        const res = (await gateway.request("models.list", { refresh: true })) as any;
        toast(
          res.warning ? `saved rows shown — ${res.warning}` : `${(res.models ?? []).length} models fetched`,
          res.warning ? "info" : "ok",
        );
        await this.render();
      } catch (err) {
        toast((err as Error).message, "err");
      }
    };

    const search = el("input", {
      class: "inp",
      id: "model-search",
      placeholder: "Search models…",
      autocomplete: "off",
      spellcheck: "false",
      value: this.#modelQuery,
    }) as HTMLInputElement;

    const head = el("div", { class: "settings__body" }, [
      el("div", { class: "card" }, [
        el("div", { class: "prov__head" }, [
          el("span", { class: "prov__name" }, [provider]),
          el("div", { class: "prov__row" }, [back, refresh]),
        ]),
        el("div", { class: "prov__url" }, [providers[provider]?.baseUrl ?? ""]),
        el("p", { class: "hint" }, [
          "Checked models are in the system. Click a model to tune its capabilities.",
        ]),
        warning
          ? el("p", { class: "hint", style: "color:var(--warn)" }, [warning])
          : el("span", {}),
      ]),
    ]);

    if (rows.length === 0) {
      head.append(el("div", { class: "card" }, [
        el("p", { class: "hint" }, ["No models fetched from this provider yet — try Refresh."]),
      ]));
      this.#root.append(head);
      return;
    }

    // Search box + one compact list (hairline rows), not one card per model.
    const list = el("div", { class: "list" });
    const renderRows = (): void => {
      list.innerHTML = "";
      const q = this.#modelQuery.trim().toLowerCase();
      const shown = rows.filter((ref) => !q || ref.toLowerCase().includes(q));
      if (shown.length === 0) {
        list.append(el("div", { class: "row" }, [
          el("span", { class: "hint" }, [`No models match "${this.#modelQuery.trim()}"`]),
        ]));
        return;
      }
      for (const ref of shown) {
        const entry = byRef.get(ref) as any;
        const on = Boolean(entry?.enabled);
        const tail = ref.startsWith(`${provider}/`) ? ref.slice(provider.length + 1) : ref;
        const hintCtx = details[ref]?.contextWindow as number | undefined;
        const ctx = entry?.contextWindow || hintCtx;

        const check = el("input", {
          type: "checkbox",
          class: "model-check",
          "aria-label": `select ${ref}`,
          id: `sel-${ref.replace(/[^a-z0-9]+/gi, "-")}`,
        }) as HTMLInputElement;
        check.checked = on;
        check.onchange = () => {
          void (async () => {
            try {
              await gateway.request("models.save", {
                id: entry?.id,
                ref,
                label: entry?.label ?? "",
                contextWindow: entry?.contextWindow ?? hintCtx ?? 0,
                maxTokens: entry?.maxTokens ?? 0,
                temperature: entry?.temperature,
                reasoningEffort: entry?.reasoningEffort ?? "inherit",
                enabled: check.checked,
              });
              toast(check.checked ? `${tail} is in the system` : `${tail} removed from the system`, "ok");
              await this.render();
            } catch (err) {
              check.checked = !check.checked;
              toast((err as Error).message, "err");
            }
          })();
        };

        const tune = el("button", { class: "btn sm", type: "button" }, [entry ? "Tune" : "Configure"]);
        const openTune = () => this.#modelTune(ref, entry, hintCtx, () => void this.render());
        tune.onclick = openTune;

        const name = el("span", { class: "mono", style: "flex:1;cursor:pointer;font-size:13.5px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, [
          tail,
        ]) as HTMLElement;
        name.title = ref;
        name.onclick = openTune;

        list.append(el("div", { class: "row", style: "padding:10px 16px" }, [
          check,
          name,
          ctx ? el("span", { class: "row__label", style: "white-space:nowrap" }, [`${Math.round(ctx / 1000)}k`]) : el("span", {}),
          tune,
        ]));
      }
    };
    renderRows();

    search.oninput = () => {
      this.#modelQuery = search.value;
      renderRows();
    };

    head.append(
      el("div", { class: "card", style: "padding:12px 16px" }, [
        el("div", { class: "modal__field", style: "margin:0" }, [
          el("label", { class: "lbl", for: "model-search" }, [`${rows.length} fetched models`]),
          search,
        ]),
      ]),
      el("div", { class: "card", style: "padding:0;overflow:hidden" }, [list]),
    );

    this.#root.append(head);
  }

  /** Capabilities popup for one fetched model. Save also selects it. */
  #modelTune(ref: string, existing: any | null, hintCtx: number | undefined, done: () => void): void {
    let close: () => void = () => {};
    const field = (name: string, label: string, value: string, placeholder: string, type = "text") => {
      const input = el("input", {
        id: `f-${name}`, class: "inp mono", type, value, placeholder,
        autocomplete: "off", spellcheck: "false", step: type === "number" ? "any" : undefined,
      }) as HTMLInputElement;
      return { input, wrap: el("div", { class: "modal__field" }, [el("label", { class: "lbl", for: `f-${name}` }, [label]), input]) };
    };
    const labelF = field("label", "Label (optional)", existing?.label ?? "", ref.split("/").slice(1).join("/"));
    const ctxF = field("contextWindow", "Context window (tokens)", String(existing?.contextWindow || hintCtx || ""), "auto-detect");
    const maxF = field("maxTokens", "Max output tokens (0 = provider default)", existing?.maxTokens ? String(existing.maxTokens) : "0", "0", "number");
    const tempF = field("temperature", "Temperature (blank = provider default)", typeof existing?.temperature === "number" ? String(existing.temperature) : "", "0.7", "number");

    const effortSel = el("select", { class: "inp", id: "f-effort" }) as HTMLSelectElement;
    for (const v of ["inherit", "off", "low", "medium", "high", "xhigh", "max"]) {
      const opt = el("option", { value: v }, [v]) as HTMLOptionElement;
      if ((existing?.reasoningEffort ?? "inherit") === v) opt.selected = true;
      effortSel.append(opt);
    }

    modal({
      title: ref,
      confirmLabel: existing ? "Save" : "Save & select",
      render: (body, c) => {
        close = c;
        body.append(
          labelF.wrap, ctxF.wrap, maxF.wrap, tempF.wrap,
          el("div", { class: "modal__field" }, [
            el("label", { class: "lbl", for: "f-effort" }, ["Default thinking"]),
            effortSel,
            el("p", { class: "hint" }, ["Per-model default; a session thinking choice still overrides it."]),
          ]),
          existing
            ? (() => {
                const rm = el("button", { class: "btn danger", type: "button", style: "margin-top:8px" }, ["Remove from system"]);
                rm.onclick = async () => {
                  try {
                    await gateway.request("models.remove", { id: existing.id });
                    toast(`${ref} removed`, "ok");
                    close();
                    done();
                  } catch (err) {
                    toast((err as Error).message, "err");
                  }
                };
                return rm;
              })()
            : el("span", {}),
        );
      },
      onConfirm: async () => {
        const payload: Record<string, unknown> = {
          id: existing?.id,
          ref,
          label: labelF.input.value.trim(),
          contextWindow: Number(ctxF.input.value) || hintCtx || 0,
          maxTokens: Number(maxF.input.value) || 0,
          reasoningEffort: effortSel.value,
          enabled: true,
        };
        const temp = tempF.input.value.trim();
        if (temp !== "" && Number.isFinite(Number(temp))) payload["temperature"] = Number(temp);
        try {
          await gateway.request("models.save", payload);
          toast(existing ? "saved" : `${ref} saved & selected`, "ok");
          close();
          done();
        } catch (err) {
          toast((err as Error).message, "err");
        }
      },
    });
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

  /* ---------------- skills ---------------- */

  #renderSkills(skills: any[]): void {
    const body = el("div", { class: "settings__body" });

    body.append(el("div", { class: "card" }, [
      el("div", { class: "row__label" }, ["Skills"]),
      el("p", { class: "hint" }, [
        "Instruction packs the agent can load (SKILL.md + frontmatter). The agent can also save new skills itself with the skill_save tool. Workspace entries shadow state and bundled ones of the same name.",
      ]),
    ]));

    for (const s of skills as any[]) {
      const open = el("button", { class: "btn sm", type: "button" }, ["Open"]);
      open.onclick = () => {
        void (async () => {
          try {
            const res = (await gateway.request("skills.get", { name: s.name })) as any;
            modal({
              title: s.name,
              body: el("div", {}, [
                el("p", { class: "hint" }, [s.description || "(no description)"]),
                el("pre", { class: "mono", style: "white-space:pre-wrap;font-size:12px;max-height:50vh;overflow:auto" }, [String(res.body ?? "")]),
              ]),
              confirmLabel: "",
            });
          } catch (err) {
            toast((err as Error).message, "err");
          }
        })();
      };

      const badgeStyle = s.eligible
        ? "font-size:11px;font-weight:600;color:var(--accent);background:var(--accsoft);padding:2px 8px;border-radius:999px"
        : "font-size:11px;font-weight:600;color:var(--warn);padding:2px 8px;border-radius:999px";
      body.append(el("div", { class: "card" }, [
        el("div", { class: "prov" }, [
          el("div", { class: "prov__head" }, [
            el("span", { class: "prov__name mono" }, [s.name]),
            el("span", { class: "prov__count" }, [s.root]),
          ]),
          el("div", { class: "prov__url" }, [s.description || "(no description)"]),
          el("div", { class: "prov__row" }, [
            el("span", { class: "sheet__check", style: badgeStyle }, [s.eligible ? "available" : `unavailable${s.reason ? " — " + s.reason : ""}`]),
            open,
          ]),
        ]),
      ]));
    }

    const plus = el("span");
    plus.innerHTML = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
    const add = el("button", { class: "btn pri", type: "button" }, [plus, "Add skill"]);
    add.onclick = () => this.#skillForm(() => void this.render());

    this.#root.append(body, add);
  }

  #skillForm(done: () => void): void {
    let close: () => void = () => {};
    const name = el("input", { class: "inp mono", id: "f-skill-name", placeholder: "my-skill", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
    const desc = el("input", { class: "inp", id: "f-skill-desc", placeholder: "What it does and when to use it", autocomplete: "off" }) as HTMLInputElement;
    const content = el("textarea", {
      class: "inp mono", id: "f-skill-body", rows: "12",
      placeholder: "The skill instructions in Markdown",
      style: "min-height:200px;resize:vertical",
      spellcheck: "false",
    }) as HTMLTextAreaElement;

    modal({
      title: "Add skill",
      confirmLabel: "Add",
      render: (body, c) => {
        close = c;
        body.append(
          el("div", { class: "modal__field" }, [el("label", { class: "lbl", for: "f-skill-name" }, ["Name"]), name,
            el("p", { class: "hint" }, ["1-64 lowercase letters, numbers, or hyphens."])]),
          el("div", { class: "modal__field" }, [el("label", { class: "lbl", for: "f-skill-desc" }, ["Description"]), desc,
            el("p", { class: "hint" }, ["One line: what it does AND when to use it — this is how it triggers later."])]),
          el("div", { class: "modal__field" }, [el("label", { class: "lbl", for: "f-skill-body" }, ["Content"]), content]),
        );
      },
      onConfirm: async () => {
        if (!name.value.trim()) { toast("name is required", "err"); return; }
        try {
          await gateway.request("skills.save", {
            name: name.value,
            description: desc.value,
            body: content.value,
          });
          toast(`skill "${name.value.trim().toLowerCase()}" saved`, "ok");
          close();
          done();
        } catch (err) {
          toast((err as Error).message, "err");
        }
      },
    });
  }

  /* ---------------- tools ---------------- */

  #renderTools(tools: any[]): void {
    const body = el("div", { class: "settings__body" });

    body.append(el("div", { class: "card" }, [
      el("div", { class: "row__label" }, ["Tools"]),
      el("p", { class: "hint" }, [
        `${tools.length} built-in tools the agent can call. Read-only: neither the agent nor you can add or remove tools here — they ship with the runtime.`,
      ]),
    ]));

    for (const t of tools as any[]) {
      body.append(el("div", { class: "card" }, [
        el("div", { class: "prov" }, [
          el("div", { class: "prov__head" }, [
            el("span", { class: "prov__name mono" }, [t.name]),
            el("span", { class: "prov__count" }, [t.needsApproval ? "asks approval" : "auto"]),
          ]),
          el("div", { class: "prov__url" }, [t.description || ""]),
        ]),
      ]));
    }

    this.#root.append(body);
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

  /** Runtime tab: the daemon Service card (OpenClaw status --deep + restart). */
  async #renderRuntime(config: any, counts: { tools: number; skills: number; models: number }): Promise<void> {
    let svc: any = null;
    try {
      svc = await gateway.request("service.status");
    } catch { /* offline guard already rendered */ }

    if (svc) this.#root.append(this.#serviceCard(svc));

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

  /** The daemon lifecycle card: manager, boot state, restarts, log tail. */
  #serviceCard(svc: any): HTMLElement {
    const fmtUptime = (ms: number | undefined): string => {
      const sec = Math.max(0, Math.round(Number(ms ?? 0) / 1000));
      const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
      return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${sec % 60}s` : `${sec}s`;
    };
    const modeLabel: Record<string, string> = {
      supervised: "supervised by sc gateway (restarts on crash)",
      service: "OS service",
      single: "single process — no supervisor",
      stopped: "stopped",
    };

    const restart = el("button", { class: "btn", type: "button" }, ["Restart gateway"]) as HTMLButtonElement;
    const willComeBack = svc.restartSupported === true;
    if (!willComeBack) restart.disabled = true;
    restart.onclick = () => {
      modal({
        title: "Restart the gateway?",
        body: willComeBack
          ? "The daemon stops gracefully and its supervisor starts it right back. Open chats reconnect automatically."
          : "No supervisor is running — this would STOP the gateway until you start it again.",
        confirmLabel: "Restart",
        danger: !willComeBack,
        onConfirm: async () => {
          try {
            const res: any = await gateway.request("service.restart", {});
            toast(res?.willComeBack ? "restarting — reconnecting…" : "stopping (no supervisor)…", "ok");
          } catch (err) {
            toast((err as Error).message, "err");
          }
          // The socket drops; the app's reconnect handler re-renders this page.
        },
      });
    };

    const refresh = el("button", { class: "btn sm", type: "button" }, ["↻ Refresh"]);
    refresh.onclick = () => void this.render();

    const card = el("div", { class: "card" }, [
      el("div", { class: "row" }, [
        el("span", { class: "row__label" }, ["Daemon"]),
        el("span", { class: "row__value", style: `color:${svc.running ? "var(--ok)" : "var(--err)"}` }, [
          svc.running ? "running" : "not running",
        ]),
      ]),
      el("div", { class: "row" }, [
        el("span", { class: "row__label" }, ["Mode"]),
        el("span", { class: "row__value" }, [modeLabel[String(svc.mode)] ?? String(svc.mode ?? "—")]),
      ]),
      el("div", { class: "row" }, [
        el("span", { class: "row__label" }, ["Uptime"]),
        el("span", { class: "row__value" }, [fmtUptime(svc.uptimeMs)]),
      ]),
      el("div", { class: "row" }, [
        el("span", { class: "row__label" }, ["Process"]),
        el("span", { class: "row__value" }, [svc.supervisorPid ? `child ${svc.pid} · supervisor ${svc.supervisorPid}` : svc.pid ? `pid ${svc.pid}` : "—"]),
      ]),
      el("div", { class: "row" }, [
        el("span", { class: "row__label" }, ["Service manager"]),
        el("span", { class: "row__value" }, [svc.installed ? String(svc.manager) : svc.manager ? `${svc.manager} (not installed)` : "none"]),
      ]),
      el("div", { class: "row" }, [
        el("span", { class: "row__label" }, ["Starts at boot"]),
        el("span", { class: "row__value" }, [svc.bootEnabled ? "enabled" : "disabled"]),
      ]),
      el("div", { class: "modal__foot" }, [restart, refresh]),
      el("p", { class: "hint" }, [svc.installed
        ? `Service file: ${svc.servicePath}. Logs: ${svc.logPath}`
        : "Agentic boot + crash restarts work via the supervisor. Install as an OS service too: sc service install"]),
    ]);

    // The log tail — read-only evidence, OpenClaw's `sc logs` in the UI.
    const logPre = el("pre", { class: "diary__body" }, ["loading…"]);
    void gateway.request("service.logs", { lines: 30 }).then((res: any) => {
      const lines = (res?.lines ?? []) as string[];
      logPre.textContent = lines.length ? lines.join("\n") : "(log is empty)";
    }).catch(() => { logPre.textContent = "(could not read the log)"; });

    const logsDetails = el("details", { class: "card diary" }, [
      el("summary", {}, [
        el("span", { class: "row__label" }, ["Service log (last 30 lines)"]),
        el("span", { class: "row__value mono" }, [String(svc.logPath ?? "service.log").split("/").pop() ?? "log"]),
      ]),
      logPre,
    ]);

    return el("div", { class: "settings__body" }, [card, logsDetails]);
  }

  /* ---------------- memory (OpenClaw's Dreams tab, adapted) ---------------- */

  async #renderMemory(): Promise<void> {
    let status: any = null;
    let diary: any = null;
    try {
      [status, diary] = await Promise.all([
        gateway.request("dream.status"),
        gateway.request("dream.diary"),
      ]);
    } catch (err) {
      toast(`could not load memory: ${(err as Error).message}`, "err");
    }

    const body = el("div", { class: "settings__body" });
    const fmt = (ms: number | null | undefined): string =>
      ms ? new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "never";
    const counts = status?.counts ?? { memoryLines: 0, dailyNotes: 0, diaryEntries: 0 };

    // Card 1 — dreaming controls. The nightly sweep now runs three phases
    // (light stage → REM themes → deep gate+consolidate) and reports its
    // verdict, staged backlog and rejected-by-category counts here.
    const enabled = el("input", { type: "checkbox", id: "mem-dream-enabled" }) as HTMLInputElement;
    enabled.checked = status ? status.enabled !== false : true;
    const schedule = el("input", {
      class: "inp mono", id: "mem-dream-schedule",
      value: String(status?.schedule ?? "0 3 * * *"), placeholder: "0 3 * * *",
    });

    const stateLine = !status
      ? "could not reach the gateway"
      : status.scheduleError
        ? status.scheduleError
        : status.enabled === false
          ? "off — no sweep scheduled"
          : `on — next sweep ${fmt(status.nextRunAt)}`;
    const stateValue = el("span", { class: "row__value", style: status?.scheduleError ? "color:var(--err)" : "" }, [stateLine]);

    const runBtn = el("button", { class: "btn", type: "button" }, ["Dream now"]);
    const runNote = el("p", { class: "hint" }, [""]);
    runNote.style.display = "none";
    runBtn.onclick = async () => {
      runBtn.disabled = true;
      runBtn.textContent = "Dreaming…";
      runNote.style.display = "";
      runNote.textContent = "Sweeping the daily notes into MEMORY.md — a real sweep can take a minute or two.";
      try {
        const res: any = await gateway.request("dream.run");
        toast("dream sweep done", "ok");
        // Re-render so counts, diary and next-run all refresh.
        await this.render();
        toast(`deep sleep: ${String(res?.text ?? "nothing new").slice(0, 120)}`, "ok");
      } catch (err) {
        toast((err as Error).message, "err");
        runBtn.disabled = false;
        runBtn.textContent = "Dream now";
        runNote.textContent = "";
        runNote.style.display = "none";
      }
    };

    const save = el("button", { class: "btn pri", type: "button" }, ["Save"]);
    save.onclick = async () => {
      await this.#setMany([
        ["memory.dreaming.enabled", enabled.checked],
        ["memory.dreaming.schedule", schedule.value.trim() || "0 3 * * *"],
      ], "dreaming saved");
      // Re-armed by the config hot-reload — re-render to show the new next run.
      await this.render();
    };

    body.append(el("div", { class: "card" }, [
      el("div", { class: "row" }, [
        el("span", { class: "row__label" }, ["Dreaming"]),
        stateValue,
      ]),
      el("div", { class: "row" }, [
        el("span", { class: "row__label" }, ["Last sweep"]),
        el("span", { class: "row__value" }, [status?.lastVerdict ? `${fmt(status?.lastDreamAt)} — ${String(status.lastVerdict).slice(0, 80)}` : fmt(status?.lastDreamAt)]),
      ]),
      el("div", { class: "row" }, [
        el("span", { class: "row__label" }, ["Counts"]),
        el("span", { class: "row__value" }, [`${counts.memoryLines} curated lines · ${counts.dailyNotes} daily notes · ${counts.diaryEntries} diary entries`]),
      ]),
      el("div", { class: "row" }, [
        el("span", { class: "row__label" }, ["Phases"]),
        el("span", { class: "row__value" }, [
          `${counts.staged ?? 0} staged · ${counts.promotedToday ?? 0} promoted today` +
            (status?.lastRejected && Object.keys(status.lastRejected).length
              ? ` · last rejected {${Object.entries(status.lastRejected).map(([k, v]: [string, unknown]) => `${k}:${v}`).join(", ")}}`
              : ""),
        ]),
      ]),
      el("div", { class: "modal__field" }, [
        el("label", { class: "lbl", for: "mem-dream-schedule" }, ["Schedule (cron)"]),
        schedule,
        el("p", { class: "hint" }, ["5 fields, server time. Default 0 4 * * * runs the sweep nightly at 04:00. It never appears in your cron jobs."]),
      ]),
      el("div", { class: "modal__field" }, [
        el("label", { class: "lbl", for: "mem-dream-enabled" }, ["Enabled"]),
        enabled,
      ]),
      el("div", { class: "modal__foot" }, [save, runBtn]),
      runNote,
      el("p", { class: "hint" }, [
        "The sweep is read-only on your daily notes: it only edits MEMORY.md and appends to DREAMS.md. An empty sweep records nothing new — by design.",
      ]),
    ]));

    // Card 2 — the dream diary (Deep Sleep entries, newest first). Humans-only:
    // the diary never feeds back into memory (OpenClaw's rule).
    const entries: { date: string; body: string }[] = [];
    const content = String(diary?.dreams ?? "");
    if (content.trim()) {
      const parts = content.split(/^## Deep Sleep - /m);
      for (const p of parts.slice(1)) {
        const nl = p.indexOf("\n");
        entries.push({
          date: (nl === -1 ? p : p.slice(0, nl)).trim(),
          body: (nl === -1 ? "" : p.slice(nl + 1)).trim(),
        });
      }
      entries.reverse();
    }
    const diaryList = el("div", { class: "settings__body" });
    if (entries.length === 0) {
      diaryList.append(el("p", { class: "hint" }, ["No diary entries yet — press Dream now, or wait for the schedule."]));
    }
    for (const e of entries.slice(0, 30)) {
      diaryList.append(el("details", { class: "card diary" }, [
        el("summary", {}, [
          el("span", { class: "row__label" }, [`Deep Sleep — ${e.date}`]),
          el("span", { class: "row__value" }, [`${e.body.split("\n").filter((l) => l.trim()).length} lines`]),
        ]),
        el("pre", { class: "diary__body" }, [e.body || "nothing new"]),
      ]));
    }
    body.append(el("div", { class: "card" }, [
      el("div", { class: "row__label" }, ["Dream diary"]),
      el("p", { class: "hint" }, [
        `${counts.diaryEntries} entries in ${diary?.dreamsPath ?? "DREAMS.md"}. For human reading — never promoted back into memory.`,
      ]),
    ]), diaryList);

    // Card 3 — the curated MEMORY.md the sweep (and memory tools) maintain.
    body.append(el("details", { class: "card diary" }, [
      el("summary", {}, [
        el("span", { class: "row__label" }, ["Curated memory (MEMORY.md)"]),
        el("span", { class: "row__value" }, [`${counts.memoryLines} lines`]),
      ]),
      el("pre", { class: "diary__body" }, [String(diary?.memory ?? "").trim() || "(empty — the sweep promotes durable facts here)"]),
    ]));

    this.#root.append(body);
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
        // Their Settings → Models → Connect provider picker sources from
        // plugins; best-effort so an older gateway can't break settings.
        gateway.request("models.plugins").catch(() => ({ plugins: [] }) as any),
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
