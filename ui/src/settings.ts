// Settings: model defaults, providers, gateway, runtime — laid out with
// OpenClaw's settings vocabulary (.settings-workspace > .settings-group >
// .settings-section__header + .settings-row > .settings-row__control).

import { el, esc, modal, toast } from "./dom.js";
import { gateway } from "./rpc.js";

type Provider = { baseUrl: string; apiKey: string; models?: string[]; headers?: Record<string, string> };

export class Settings {
  #root: HTMLElement;
  #onChanged: () => void;

  constructor(root: HTMLElement, onChanged: () => void) {
    this.#root = root;
    this.#onChanged = onChanged;
  }

  async render(): Promise<void> {
    this.#root.innerHTML = "";
    const wrap = el("div", { class: "settings-workspace" });

    let config: any = {};
    let models: string[] = [];
    let tools = 0, skills = 0;
    try {
      const [cfg, modelRes, toolRes, skillRes] = await Promise.all([
        gateway.request("config.get"),
        gateway.request("models.list"),
        gateway.request("tools.list"),
        gateway.request("skills.list"),
      ]);
      config = (cfg as any).config ?? {};
      models = (modelRes as any).models ?? [];
      tools = ((toolRes as any).tools ?? []).length;
      skills = ((skillRes as any).skills ?? []).length;
    } catch (err) {
      toast(`could not load config: ${(err as Error).message}`, "error");
    }

    const providers: Record<string, Provider> = config.providers ?? {};
    const defaults = config.agents?.defaults ?? {};
    const gw = config.gateway ?? {};

    // On phones the settings sidebar (which owns the back button) lives in the
    // off-canvas drawer, so the workspace carries its own way out.
    const back = el("button", { class: "btn btn--xs sc-settings-back", id: "settings-back-inline" }, ["← back to chat"]);
    back.onclick = () => { location.hash = ""; };
    wrap.append(back);

    // ---- defaults ----
    const modelInput = el("input", {
      class: "settings-input", value: defaults.model ?? "", placeholder: "provider/model", list: "model-list",
    });
    const datalist = el("datalist", { id: "model-list" });
    for (const m of models) datalist.append(el("option", { value: m }));
    const fallbackInput = el("input", {
      class: "settings-input", value: (defaults.fallbacks ?? []).join(", "), placeholder: "provider/model, provider/model",
    });

    const defaultsCard = el("section", { class: "settings-group" }, [
      header("Model", "Used for every new message. Type to pick an existing model or write any provider/model reference.",
        [el("button", { class: "btn primary", id: "save-model" }, ["Save"])]),
      row("default model", modelInput),
      row("fallbacks (comma separated)", fallbackInput),
    ]);
    wrap.append(defaultsCard, datalist);

    // ---- providers ----
    const table = el("table", { class: "sc-table" }, [
      el("thead", {}, [el("tr", {}, [
        el("th", {}, ["provider"]), el("th", {}, ["base url"]), el("th", {}, ["models"]), el("th", {}, [""]),
      ])]),
    ]);
    const tbody = el("tbody");
    table.append(tbody);

    const renderProviders = () => {
      tbody.innerHTML = "";
      const names = Object.keys(providers);
      if (names.length === 0) {
        tbody.append(el("tr", {}, [
          el("td", { colspan: "4", class: "sc-empty-row" }, ["no providers yet — add one below"]),
        ]));
      }
      for (const name of names) {
        const p = providers[name] as Provider;
        const tr = el("tr", {}, [
          el("td", { class: "mono" }, [name]),
          el("td", { class: "mono" }, [esc(p.baseUrl ?? "")]),
          el("td", {}, [String((p.models ?? []).length)]),
        ]);
        const actions = el("td", { class: "sc-actions" });
        const edit = el("button", { class: "btn btn--xs" }, ["Edit"]);
        edit.onclick = () => this.#providerForm(name, providers, renderProviders);
        const del = el("button", { class: "btn btn--xs danger" }, ["Remove"]);
        del.onclick = () => this.#removeProvider(name, providers, renderProviders);
        actions.append(edit, del);
        tr.append(actions);
        tbody.append(tr);
      }
    };
    renderProviders();

    const providersCard = el("section", { class: "settings-group" }, [
      header("Providers",
        "Any OpenAI-compatible endpoint: OpenAI, OpenRouter, Groq, Ollama, LM Studio, or your own server. Changes apply live — no restart.",
        [
          el("button", { class: "btn btn--xs", id: "test-models" }, ["Test models"]),
          el("button", { class: "btn btn--xs primary", id: "add-provider" }, ["＋ Add provider"]),
        ]),
      table,
    ]);
    wrap.append(providersCard);

    // ---- gateway ----
    const modeSelect = el("select", { class: "settings-select" });
    for (const m of ["token", "none"]) modeSelect.append(el("option", { value: m }, [m]));
    modeSelect.value = gw.auth?.mode ?? "token";
    const bypassSelect = el("select", { class: "settings-select" });
    for (const [v, label] of [["true", "on (this phone needs no token)"], ["false", "off (always require token)"]] as const) {
      bypassSelect.append(el("option", { value: v }, [label]));
    }
    bypassSelect.value = String(gw.auth?.loopbackBypass ?? true);

    const gwCard = el("section", { class: "settings-group" }, [
      header("Gateway", `Listening on 127.0.0.1:${gw.port ?? 18790}. Remote clients need the token printed by sc token.`,
        [el("button", { class: "btn primary", id: "save-gw" }, ["Save"])]),
      row("auth mode", modeSelect),
      row("loopback bypass", bypassSelect),
    ]);
    wrap.append(gwCard);

    // ---- runtime ----
    wrap.append(el("section", { class: "settings-group" }, [
      header("Runtime", "What this gateway is running right now."),
      el("div", { class: "sc-stat-row" }, [
        stat("tools", String(tools)),
        stat("skills", String(skills)),
        stat("models", String(models.length)),
        stat("telegram", config.channels?.telegram?.enabled ? "on" : "off"),
        stat("cron", config.cron?.enabled ? "on" : "off"),
      ]),
    ]));

    this.#root.append(wrap);

    // ---- wiring ----
    (wrap.querySelector("#add-provider") as HTMLElement).onclick = () =>
      this.#providerForm(null, providers, renderProviders);
    (wrap.querySelector("#save-model") as HTMLElement).onclick = async () => {
      const fb = fallbackInput.value.split(",").map((s) => s.trim()).filter(Boolean);
      await this.#setMany([
        ["agents.defaults.model", modelInput.value.trim()],
        ["agents.defaults.fallbacks", fb],
      ], "model saved");
    };
    (wrap.querySelector("#test-models") as HTMLElement).onclick = async () => {
      try {
        const res = await gateway.request("models.list");
        const list = (res as any).models ?? [];
        toast(list.length ? `${list.length} models available` : "no models — add a provider first");
      } catch (err) {
        toast((err as Error).message, "error");
      }
    };
    (wrap.querySelector("#save-gw") as HTMLElement).onclick = async () => {
      await this.#setMany([
        ["gateway.auth.mode", modeSelect.value],
        ["gateway.auth.loopbackBypass", bypassSelect.value === "true"],
      ], "gateway saved — reconnecting");
      location.reload();
    };
  }

  async #setMany(pairs: [string, unknown][], message: string): Promise<void> {
    try {
      for (const [path, value] of pairs) {
        await gateway.request("config.set", { path, value });
      }
      toast(message);
      this.#onChanged();
    } catch (err) {
      toast((err as Error).message, "error");
    }
  }

  #providerForm(
    name: string | null,
    providers: Record<string, Provider>,
    done: () => void,
  ): void {
    modal({
      title: name ? `Edit ${name}` : "Add provider",
      fields: [
        { name: "name", label: "name", value: name ?? "", placeholder: "openrouter", },
        { name: "baseUrl", label: "base url", value: name ? providers[name]?.baseUrl ?? "" : "", placeholder: "https://openrouter.ai/api/v1" },
        { name: "apiKey", label: "api key", value: name ? providers[name]?.apiKey ?? "" : "", placeholder: "sk-…" },
        { name: "models", label: "models (comma separated)", value: name ? (providers[name]?.models ?? []).join(", ") : "", placeholder: "gpt-4o-mini, claude-3.5-sonnet" },
      ],
      confirmLabel: name ? "Save" : "Add",
      onConfirm: async (v) => {
        const providerName = ((v.name ?? "") || name || "").trim();
        if (!providerName) { toast("provider name is required", "error"); return; }
        const next: Record<string, Provider> = { ...providers };
        if (name && name !== providerName) delete next[name];
        next[providerName] = {
          baseUrl: (v.baseUrl ?? "").trim(),
          apiKey: (v.apiKey ?? "").trim(),
          models: (v.models ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        };
        try {
          await gateway.request("config.set", { path: "providers", value: next });
          toast(name ? `${providerName} updated` : `${providerName} added`);
          done();
          this.#onChanged();
        } catch (err) {
          toast((err as Error).message, "error");
        }
      },
    });
  }

  #removeProvider(
    name: string,
    providers: Record<string, Provider>,
    done: () => void,
  ): void {
    modal({
      title: `Remove ${name}?`,
      body: "Models from this provider stop working immediately.",
      confirmLabel: "Remove",
      danger: true,
      onConfirm: async () => {
        const next = { ...providers };
        delete next[name];
        try {
          await gateway.request("config.set", { path: "providers", value: next });
          toast(`${name} removed`);
          done();
          this.#onChanged();
        } catch (err) {
          toast((err as Error).message, "error");
        }
      },
    });
  }
}

/* ---- layout helpers ---- */

function header(title: string, desc: string, actions: HTMLElement[] = []): HTMLElement {
  return el("div", { class: "settings-section__header" }, [
    el("div", { class: "settings-section__copy" }, [
      el("h2", { class: "settings-section__heading" }, [title]),
      el("p", { class: "settings-section__desc" }, [desc]),
    ]),
    el("div", { class: "settings-section__actions" }, actions),
  ]);
}

function row(label: string, control: HTMLElement): HTMLElement {
  return el("div", { class: "settings-row" }, [
    el("span", { class: "settings-row__text" }, [label]),
    el("div", { class: "settings-row__control" }, [control]),
  ]);
}

function stat(label: string, value: string): HTMLElement {
  return el("span", { class: "sc-stat" }, [`${label} `, el("b", {}, [value])]);
}
