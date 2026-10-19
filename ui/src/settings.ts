// Settings: provider setup, default model, fallbacks, gateway summary.

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
    const wrap = el("div", { class: "wrap" });

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

    wrap.append(el("button", { class: "back-link", id: "back" }, ["← back to chat"]));

    // ---- defaults ----
    const modelInput = el("input", { value: defaults.model ?? "", placeholder: "provider/model", list: "model-list" });
    const datalist = el("datalist", { id: "model-list" });
    for (const m of models) datalist.append(el("option", { value: m }));
    const fallbackInput = el("input", { value: (defaults.fallbacks ?? []).join(", "), placeholder: "provider/model, provider/model" });

    const defaultsCard = el("div", { class: "card-block" }, [
      el("h2", {}, ["Model"]),
      el("p", { class: "desc" }, ["Used for every new message. Type to pick an existing model or write any provider/model reference."]),
      el("div", { class: "grid2" }, [
        el("div", { class: "field" }, [el("label", {}, ["default model"]), modelInput]),
        el("div", { class: "field" }, [el("label", {}, ["fallbacks (comma separated)"]), fallbackInput]),
      ]),
      el("div", { class: "row-actions" }, [
        el("button", { class: "btn primary", id: "save-model" }, ["Save model"]),
      ]),
    ]);
    wrap.append(defaultsCard, datalist);

    // ---- providers ----
    const table = el("table", { class: "data" }, [
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
        tbody.append(el("tr", {}, [el("td", { colspan: "4", style: "color:var(--muted)" }, ["no providers yet — add one below"])]));
      }
      for (const name of names) {
        const p = providers[name] as Provider;
        const tr = el("tr", {}, [
          el("td", { class: "mono" }, [name]),
          el("td", { class: "mono" }, [esc(p.baseUrl ?? "")]),
          el("td", {}, [String((p.models ?? []).length)]),
        ]);
        const actions = el("td", { style: "text-align:right;white-space:nowrap" });
        const edit = el("button", { class: "btn" }, ["Edit"]);
        edit.onclick = () => this.#providerForm(name, providers, renderProviders);
        const del = el("button", { class: "btn danger", style: "margin-left:6px" }, ["Remove"]);
        del.onclick = () => this.#removeProvider(name, providers, renderProviders);
        actions.append(edit, del);
        tr.append(actions);
        tbody.append(tr);
      }
    };
    renderProviders();

    const providersCard = el("div", { class: "card-block" }, [
      el("h2", {}, ["Providers"]),
      el("p", { class: "desc" }, ["Any OpenAI-compatible endpoint: OpenAI, OpenRouter, Groq, Ollama, LM Studio, or your own server. Changes apply live — no restart."]),
      table,
      el("div", { class: "row-actions" }, [
        el("button", { class: "btn", id: "test-models" }, ["Test list models"]),
        el("button", { class: "btn primary", id: "add-provider" }, ["＋ Add provider"]),
      ]),
    ]);
    wrap.append(providersCard);

    // ---- gateway ----
    const gwCard = el("div", { class: "card-block" }, [
      el("h2", {}, ["Gateway"]),
      el("p", { class: "desc" }, [`Listening on 127.0.0.1:${gw.port ?? 18790}. Remote clients need the token printed by `, el("code", {}, ["sc token"]), "."]),
      el("div", { class: "grid2" }, [
        el("div", { class: "field" }, [el("label", {}, ["auth mode"]), (() => {
          const s = el("select");
          for (const m of ["token", "none"]) s.append(el("option", { value: m, selected: gw.auth?.mode === m ? "" : undefined }, [m]));
          s.value = gw.auth?.mode ?? "token";
          return s;
        })()]),
        el("div", { class: "field" }, [el("label", {}, ["loopback bypass"]), (() => {
          const s = el("select");
          for (const [v, label] of [["true", "on (this phone needs no token)"], ["false", "off (always require token)"]] as const) {
            s.append(el("option", { value: v }, [label]));
          }
          s.value = String(gw.auth?.loopbackBypass ?? true);
          return s;
        })()]),
      ]),
      el("div", { class: "row-actions" }, [
        el("button", { class: "btn primary", id: "save-gw" }, ["Save gateway"]),
      ]),
    ]);
    wrap.append(gwCard);

    // ---- status ----
    wrap.append(el("div", { class: "card-block" }, [
      el("h2", {}, ["Runtime"]),
      el("p", { class: "desc" }, [`tools ${tools} · skills ${skills} · telegram ${config.channels?.telegram?.enabled ? "on" : "off"} · cron ${config.cron?.enabled ? "on" : "off"}`]),
    ]));

    this.#root.append(wrap);

    // ---- wiring ----
    (wrap.querySelector("#back") as HTMLElement).onclick = () => { location.hash = ""; };
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
      const mode = (wrap.querySelector("#save-gw")!.closest(".card-block")!.querySelector("select") as HTMLSelectElement).value;
      const selects = wrap.querySelectorAll(".card-block select") as NodeListOf<HTMLSelectElement>;
      const bypass = selects[1]?.value === "true";
      await this.#setMany([
        ["gateway.auth.mode", mode],
        ["gateway.auth.loopbackBypass", bypass],
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
