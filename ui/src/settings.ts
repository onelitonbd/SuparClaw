// Settings: Defaults, Models, Providers, Skills, Tools, Gateway, Runtime —
// tabbed, one card per block.

import { el, fuzzy, icon, modal, toast } from "./dom.js";
import { AVATAR_ACCEPT, isStoredAvatar, prepareAvatar } from "./avatar.js";
import { friendlyModelName } from "./model-name.js";
import { gateway } from "./rpc.js";
import { askPermission, loadPrefs, permissionState, savePrefs, sendTest } from "./notifications.js";

type Provider = { baseUrl: string; apiKey: string; models?: string[]; headers?: Record<string, string> };

type TabId = "model" | "models" | "providers" | "channels" | "usage" | "skills" | "tools" | "memory" | "automations" | "alerts" | "config" | "gateway" | "runtime" | "system";

const TABS: { id: TabId; label: string; group?: string }[] = [
  { id: "model", label: "Defaults", group: "Chat" },
  { id: "models", label: "Models", group: "Chat" },
  { id: "providers", label: "Providers", group: "Chat" },
  { id: "channels", label: "Channels", group: "Integrations" },
  { id: "usage", label: "Usage", group: "Monitoring" },
  { id: "skills", label: "Skills", group: "Agent" },
  { id: "tools", label: "Tools", group: "Agent" },
  { id: "memory", label: "Memory", group: "Agent" },
  { id: "automations", label: "Automations", group: "Agent" },
  { id: "alerts", label: "Alerts", group: "System" },
  { id: "gateway", label: "Gateway", group: "System" },
  { id: "runtime", label: "Runtime", group: "System" },
  { id: "config", label: "All settings", group: "Advanced" },
  { id: "system", label: "System", group: "Advanced" },
];

const TAB_ALIASES: Record<string, TabId> = {
  defaults: "model",
  chat: "model",
  models: "models",
  providers: "providers",
  channels: "channels",
  usage: "usage",
  skills: "skills",
  tools: "tools",
  memory: "memory",
  automations: "automations",
  alerts: "alerts",
  notifications: "alerts",
  config: "config",
  all: "config",
  gateway: "gateway",
  runtime: "runtime",
  system: "system",
};

/** One line icon per section. Built as trusted markup and inserted through
 *  icon() — never as an el() string child, where it would show up as text. */
const glyph = (body: string): string =>
  `<svg aria-hidden="true" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

/**
 * Section chrome: the rail icon, the one-line answer to "what is this page for",
 * and the words someone actually types when looking for it. Kept apart from TABS
 * so the tab list stays the single source of ids, labels and groups (contracts
 * other tests and the hash router read).
 */
const TAB_META: Record<TabId, { icon: string; desc: string; keywords: string }> = {
  model: {
    icon: glyph('<path d="M12 3.5l2.1 5.4 5.4 2.1-5.4 2.1L12 18.5l-2.1-5.4L4.5 11l5.4-2.1z"/>'),
    desc: "Your agent's name and voice, the model every chat starts on, and the limits it runs under.",
    keywords: "default fallback chat reasoning effort identity persona emoji name voice limits iterations run queue subagent",
  },
  models: {
    icon: glyph('<path d="M12 3.5l8 4.2-8 4.2-8-4.2z"/><path d="M4 12.4l8 4.2 8-4.2"/><path d="M4 16.6l8 4.2 8-4.2"/>'),
    desc: "Only the models you switch on here show up in the app.",
    keywords: "enable disable catalog check context window",
  },
  providers: {
    icon: glyph('<circle cx="8.5" cy="15.5" r="3.5"/><path d="M11 13l8.5-8.5"/><path d="M16.5 7.5l2.5 2.5"/><path d="M14.5 9.5L17 12"/>'),
    desc: "The endpoint and key behind every model.",
    keywords: "api key base url endpoint credential auth",
  },
  channels: {
    icon: glyph('<path d="M4.5 5.5h15v10h-9l-6 4.5z"/>'),
    desc: "Where the agent can reach you, starting with Telegram.",
    keywords: "telegram bot token chat pairing typing",
  },
  usage: {
    icon: glyph('<path d="M5 20V11"/><path d="M12 20V5"/><path d="M19 20v-6"/>'),
    desc: "Tokens, runs and cost for the period you pick.",
    keywords: "cost spend tokens report export daily",
  },
  skills: {
    icon: glyph('<path d="M5 5.5A2.5 2.5 0 0 1 7.5 3H19v15H7.5A2.5 2.5 0 0 0 5 20.5z"/><path d="M9 7.5h6"/>'),
    desc: "Instruction packs the agent loads when a task calls for them.",
    keywords: "skill markdown pack install workspace",
  },
  tools: {
    icon: glyph('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M8 10l2.5 2.5L8 15"/><path d="M13 15h4"/>'),
    desc: "What the agent may run, read and fetch on this device — and what needs your approval.",
    keywords: "exec shell approval sandbox code mode media web search policy",
  },
  memory: {
    icon: glyph('<rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="M7.5 9.5h9"/><path d="M7.5 13.5h5"/>'),
    desc: "What the agent remembers, and where those notes live.",
    keywords: "dream diary memory notes curated sweep",
  },
  automations: {
    icon: glyph('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>'),
    desc: "Cron jobs, hooks and email triggers that run without you.",
    keywords: "cron schedule hook imap queue webhook",
  },
  alerts: {
    icon: glyph('<path d="M6.5 9.5a5.5 5.5 0 0 1 11 0c0 4.5 2 5.5 2 5.5h-15s2-1 2-5.5z"/><path d="M10 18.5a2 2 0 0 0 4 0"/>'),
    desc: "Which events buzz your phone, and how to test them.",
    keywords: "notifications push quiet hours browser permission",
  },
  gateway: {
    icon: glyph('<rect x="3.5" y="5" width="17" height="6" rx="2"/><rect x="3.5" y="13" width="17" height="6" rx="2"/><path d="M7 8h.01M7 16h.01"/>'),
    desc: "The port, bind and auth the daemon listens on.",
    keywords: "port bind token host origin control ui http endpoint restart",
  },
  runtime: {
    icon: glyph('<path d="M3 12h4l2.5-6.5 4 13L16.5 12H21"/>'),
    desc: "Live state of the running daemon.",
    keywords: "service uptime process restart version daemon",
  },
  config: {
    icon: glyph('<path d="M9.5 4H8a2 2 0 0 0-2 2v3.5L4.5 12 6 14.5V18a2 2 0 0 0 2 2h1.5"/><path d="M14.5 4H16a2 2 0 0 1 2 2v3.5L19.5 12 18 14.5V18a2 2 0 0 1-2 2h-1.5"/>'),
    desc: "Every setting in the config file, leaf by leaf.",
    keywords: "raw json5 schema editor advanced all settings",
  },
  system: {
    icon: glyph('<rect x="3.5" y="4.5" width="17" height="11" rx="2"/><path d="M9 20h6"/><path d="M12 15.5V20"/>'),
    desc: "Diagnostics, updates and backups.",
    keywords: "doctor security audit update backup secrets restore",
  },
};

/** One choice in a custom dropdown: `value` is what gets stored, `label` is
 *  what a human reads, `title` keeps the raw ref on hover, `group` puts a
 *  header over its rows (provider sections in a model menu). */
type DdOption = { value: string; label: string; title?: string; group?: string };

/** What #dropdown hands back: the hidden value store, the rendered node, and a
 *  setter (the add-fallback control resets itself through it). */
type Dd = { sel: HTMLSelectElement; node: HTMLElement; set: (v: string) => void };

/** What one provider row states. Computed once per render so the row and the
 *  summary line above it can never disagree about what is configured. */
type ProviderFacts = {
  url: string;
  total: number;
  chosen: number;
  count: string;
  profiles: any[];
  bound: string;
  state: { text: string; tone: "ok" | "warn" | "err" | "idle" };
};

/** Close hooks of every open dropdown — Settings shows one menu at a time. */
const openDds = new Set<() => void>();

export class Settings {
  #root: HTMLElement;
  #nav: HTMLElement | null = null;
  #search: HTMLInputElement | null = null;
  #sidebar: HTMLElement | null = null;
  #menu: HTMLElement | null = null;
  #scrim: HTMLElement | null = null;
  #title: HTMLElement | null = null;
  #desc: HTMLElement | null = null;
  #readout: HTMLElement | null = null;
  #clear: HTMLButtonElement | null = null;
  #drawerClose: HTMLButtonElement | null = null;
  #main: HTMLElement | null = null;
  #onChanged: () => void;
  #tab: TabId = "model";
  #hash: string = "";
  /** Models tab drill-down: provider name when its model list is open. */
  #modelsProvider: string | null = null;
  /** Search text on the provider model list (survives re-renders). */
  #modelQuery = "";
  /** Live search on the exec allowlist ledger (rule: long lists get it). */
  #execQuery = "";
  /** Non-empty while the All-settings page holds a draft that was never sent.
   *  render() consults it before painting a different section, so a draft cannot
   *  be dropped by a nav click or a hash change. */
  #configDirty: (() => string) | null = null;

  constructor(root: HTMLElement, onChanged: () => void) {
    this.#root = root;
    this.#nav = document.getElementById("settings-nav") as HTMLElement | null;
    this.#search = document.getElementById("settings-search") as HTMLInputElement | null;
    this.#sidebar = document.getElementById("settings-sidebar");
    this.#menu = document.getElementById("settings-menu");
    this.#scrim = document.getElementById("settings-scrim");
    this.#title = document.getElementById("settings-title");
    this.#desc = document.getElementById("settings-desc");
    this.#readout = document.getElementById("settings-readout");
    this.#clear = document.getElementById("settings-search-clear") as HTMLButtonElement | null;
    this.#drawerClose = document.getElementById("settings-drawer-close") as HTMLButtonElement | null;
    // The pane that scrolls is above the render root; absent in the small DOM
    // some render tests build, so every use is guarded.
    this.#main = this.#root.closest(".settings__main") as HTMLElement | null;
    this.#onChanged = onChanged;
    // main.ts builds a fresh Settings per route change: always rebind so the
    // handlers belong to the live instance (the elements are static).
    if (this.#search) {
      this.#search.oninput = () => this.#renderNav();
      this.#search.onkeydown = (e: KeyboardEvent) => {
        // Escape in Search settings clears the field before leaving Settings.
        if (e.key === "Escape" && !e.isComposing && this.#search!.value) {
          e.stopPropagation();
          this.#search!.value = "";
          this.#renderNav();
        }
      };
    }
    // The field clears from the keyboard (Escape above) and from the button
    // phones can see; both leave the open section alone.
    if (this.#clear) {
      this.#clear.onclick = () => {
        if (!this.#search) return;
        this.#search.value = "";
        this.#renderNav();
        this.#search.focus();
      };
    }
    if (this.#drawerClose) {
      this.#drawerClose.onclick = () => this.#setDrawer(false);
    }
    if (this.#menu) {
      this.#menu.onclick = () => this.#setDrawer(!this.#sidebar?.classList.contains("is-open"));
    }
    if (this.#scrim) {
      this.#scrim.onclick = () => this.#setDrawer(false);
    }
  }

  /** Narrow viewports swap the sidebar for a slide-over drawer. */
  #setDrawer(open: boolean): void {
    this.#sidebar?.classList.toggle("is-open", open);
    this.#menu?.setAttribute("aria-expanded", String(open));
    if (this.#scrim) this.#scrim.hidden = !open;
  }

  setHash(hash: string): void {
    this.#hash = hash || "";
    const m = this.#hash.match(/#\/settings\/?([^/?#]+)?/);
    if (m && m[1]) {
      const key = decodeURIComponent(m[1]).toLowerCase();
      if (TAB_ALIASES[key]) {
        this.#tab = TAB_ALIASES[key];
      } else if ((TABS as any[]).some((t) => t.id === key)) {
        this.#tab = key as TabId;
      }
    }
  }

  async render(): Promise<void> {
    // The All-settings page is rebuilt from the file on every render, so a draft
    // that was never sent would vanish. Refuse the section change instead: put
    // the tab back (a hash change already moved the address bar), say why, and
    // paint the page that owns the draft. setHash() itself never refuses, so the
    // revert cannot loop.
    const blocked = this.#configDirty?.() ?? "";
    if (blocked && this.#tab !== "config") {
      this.#tab = "config";
      try { location.hash = "#/settings/config"; } catch { /* the render tests mount without a location */ }
      toast(blocked, "err");
    }
    this.#configDirty = null;
    // The page head and the readout follow the open section; both are painted
    // before any data lands so the chrome never looks half-built.
    if (this.#title) this.#title.textContent = TABS.find((t) => t.id === this.#tab)?.label ?? "Settings";
    if (this.#desc) {
      const desc = TAB_META[this.#tab]?.desc ?? "";
      this.#desc.textContent = desc;
      this.#desc.hidden = !desc;
    }
    this.#renderNav();
    this.#renderReadout(null, "", gateway.state);

    // The gateway answers over the WebSocket. If it is not connected yet
    // (page just loaded, or reconnecting) every request would reject with
    // "not connected to gateway" — show a waiting state instead, and let
    // main.ts call render() again once the socket is up.
    if (gateway.state !== "online") {
      this.#root.innerHTML = "";
      this.#root.append(el("div", { class: "settings__waiting", role: "status" }, [
        el("span", { class: "settings__waiting-dot", "aria-hidden": "true" }),
        el("h2", {}, [
          gateway.state === "unauthorized" ? "The gateway rejected this connection" : "Waiting for the gateway",
        ]),
        el("p", {}, [
          gateway.state === "unauthorized"
            ? "Reconnect and this page fills in as soon as the new session is live."
            : "Connecting to the daemon now. This page fills in as soon as it answers.",
        ]),
      ]));
      return;
    }

    let config: any = {};
    let configPath = "";
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
      configPath = String((cfg as any).path ?? "");
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

    // Now the readout can say which model and which file, not just "online".
    this.#renderReadout(config, configPath, gateway.state);

    this.#root.innerHTML = "";
    if (this.#tab === "model") {
      // Defaults tab offers the SELECTED models only — the strict filter.
      this.#renderModel(defaults, configured.filter((m) => m.enabled), modelsWarning);
      this.#renderAgentIdentity(config);
      this.#renderAgentDefaults(defaults, configured.filter((m) => m.enabled));
    } else if (this.#tab === "models") {
      if (this.#modelsProvider) {
        this.#renderProviderModels(this.#modelsProvider, providers, configured, models, details, modelsWarning);
      } else {
        this.#renderModels(providers, configured, models, authProfiles, plugins, modelsWarning);
      }
    } else if (this.#tab === "providers") this.#renderProviders(providers, config, authProfiles);
    else if (this.#tab === "channels") this.#renderChannels(config.channels ?? {});
    else if (this.#tab === "usage") void this.#renderUsage();
    else if (this.#tab === "skills") this.#renderSkills(skills);
    else if (this.#tab === "tools") await this.#renderTools(tools, config);
    else if (this.#tab === "memory") await this.#renderMemory();
    else if (this.#tab === "automations") await this.#renderAutomations(config);
    else if (this.#tab === "alerts") this.#renderAlerts();
    else if (this.#tab === "config") await this.#renderConfigEditor(config);
    else if (this.#tab === "gateway") this.#renderGateway(gw, configPath);
    else if (this.#tab === "system") await this.#renderSystem(config);
    else await this.#renderRuntime(config, { tools: tools.length, skills: skills.length, models: models.length });
  }

  #setTab(id: TabId): void {
    this.#tab = id;
    this.#modelsProvider = null;
    this.#setDrawer(false);
    // A section change starts at the top of the page (guarded: the render tests
    // mount #settings-body without the scrolling pane around it).
    const main = this.#main;
    if (main && typeof main.scrollTo === "function") main.scrollTo({ top: 0 });
    try {
      const map: Record<string, string> = {
        model: "defaults",
        models: "models",
        providers: "providers",
        channels: "channels",
        usage: "usage",
        skills: "skills",
        tools: "tools",
        memory: "memory",
        automations: "automations",
        alerts: "alerts",
        config: "config",
        gateway: "gateway",
        runtime: "runtime",
        system: "system",
      };
      location.hash = "#/settings/" + (map[id] || id);
    } catch {}
    void this.render();
  }

  #renderNav(): void {
    const raw = this.#search?.value ?? "";
    const q = raw.trim().toLowerCase();
    // One owner for the clear button: whatever changed the query, this runs.
    if (this.#clear) this.#clear.hidden = !raw;
    if (!this.#nav) return;
    this.#nav.innerHTML = "";

    const matches = (t: (typeof TABS)[number]): boolean => {
      if (!q) return true;
      const meta = TAB_META[t.id];
      return [t.label, t.group ?? "", meta.desc, meta.keywords].join(" ").toLowerCase().includes(q);
    };

    const groups = new Map<string, typeof TABS>();
    for (const t of TABS) {
      if (!matches(t)) continue;
      const g = t.group || "Other";
      if (!groups.has(g)) groups.set(g, []);
      (groups.get(g) as (typeof TABS)).push(t);
    }

    if (!groups.size) {
      this.#nav.append(
        el("p", { class: "settings__nav-empty" }, [`Nothing matches “${raw.trim()}”.`]),
        el("p", { class: "settings__nav-empty-hint" }, ["Try a section name like Models, Gateway or Cron."]),
      );
      return;
    }

    for (const [g, items] of groups) {
      const grp = el("div", { class: "settings__group" }, [
        el("div", { class: "settings__group-label" }, [g]),
      ]);
      for (const t of items) {
        const active = t.id === this.#tab;
        const btn = el("button", {
          class: `settings__nav-item${active ? " is-active" : ""}`,
          type: "button",
          ...(active ? { "aria-current": "page" } : {}),
        }, [
          icon(TAB_META[t.id].icon, "settings__nav-icon"),
          el("span", { class: "settings__nav-label" }, [t.label]),
        ]);
        btn.onclick = () => this.#setTab(t.id);
        grp.append(btn);
      }
      this.#nav.append(grp);
    }
  }

  /**
   * The bar's live readout: is the daemon up, which model a new chat starts on,
   * and which file these edits land in. Three facts, rebuilt on every render —
   * it is the one loud element on the surface, so it has to earn the attention.
   */
  #renderReadout(config: any, configPath: string, state: string): void {
    const host = this.#readout;
    if (!host) return;
    host.innerHTML = "";

    const label =
      state === "online" ? "online" : state === "unauthorized" ? "unauthorized" : state === "offline" ? "offline" : "connecting";
    const tone = state === "online" ? "is-ok" : state === "offline" ? "is-err" : "is-warn";
    host.append(
      el("span", { class: "settings__fact" }, [
        el("span", { class: `settings__dot ${tone}`, "aria-hidden": "true" }),
        el("span", { class: "settings__fact-v" }, [label]),
      ]),
    );

    const model = String(config?.agents?.defaults?.model ?? "").trim();
    if (model) {
      const provider = model.split("/")[0] ?? "";
      host.append(
        el("span", { class: "settings__fact settings__fact--model", title: model }, [
          el("span", { class: "settings__fact-k" }, ["Model"]),
          el("span", { class: "settings__fact-v mono" }, [friendlyModelName(model, provider)]),
        ]),
      );
    }

    const file = configPath ? configPath.split(/[\\/]/).pop() ?? configPath : "";
    if (file) {
      host.append(
        el("span", { class: "settings__fact settings__fact--config", title: configPath }, [
          el("span", { class: "settings__fact-k" }, ["Config"]),
          el("span", { class: "settings__fact-v mono" }, [file]),
        ]),
      );
    }
  }

  /* ---------------- custom dropdown ---------------- */

  /**
   * Custom listbox — never a native <select>, which browsers render and behave
   * as they please. A hidden <select> keeps the value store, so save handlers
   * still read `.value` and field ids stay exactly where they were.
   *
   * Their spec: "Model menus with more than eight choices include search …
   * short menus stay compact." So search appears by itself past eight choices.
   */
  #dropdown(opts: {
    id: string;
    buttonId?: string;
    value: string;
    /** Field label — the button announces "label: value". */
    label: string;
    placeholder: string;
    options: DdOption[];
    searchable?: boolean;
  }): Dd {
    const { id, value, placeholder, label } = opts;
    const buttonId = opts.buttonId ?? `${id}-btn`;
    const choices = opts.options;
    const present = (v: string): boolean => choices.some((o) => o.value === v);
    const text = (v: string): string => {
      const hit = choices.find((o) => o.value === v);
      if (hit) return hit.label;
      return v ? `${v} (not selected)` : placeholder;
    };

    // The store: a hidden <select> so `sel.value` keeps working everywhere.
    const sel = el("select", { id, class: "dd__store", hidden: "", tabindex: "-1", "aria-hidden": "true" }) as HTMLSelectElement;
    const fill = (v: string): void => {
      sel.innerHTML = "";
      // The placeholder is only a stand-in for "nothing chosen". When a real
      // choice has the empty value ("use the configured default"), the choices
      // already carry it — adding the placeholder too would put the same entry in
      // the store twice and print it twice in a read-out.
      if (!choices.some((o) => o.value === "")) {
        const empty = el("option", { value: "" }, [placeholder]) as HTMLOptionElement;
        if (!v) empty.selected = true;
        sel.append(empty);
      }
      for (const o of choices) {
        const opt = el("option", { value: o.value }, [o.label]) as HTMLOptionElement;
        if (o.value === v) opt.selected = true;
        sel.append(opt);
      }
      // A stored value whose model was removed stays visible, not dropped.
      if (v && !present(v)) {
        const orphan = el("option", { value: v }, [`${v} (not selected)`]) as HTMLOptionElement;
        orphan.selected = true;
        sel.append(orphan);
      }
    };
    fill(value);

    const val = el("span", { class: `dd__val${present(value) ? "" : " is-empty"}` }, [text(value)]);
    const btn = el("button", {
      class: "dd__btn",
      id: buttonId,
      type: "button",
      "aria-haspopup": "listbox",
      "aria-expanded": "false",
      "aria-controls": `${id}-menu`,
      "aria-label": `${label}: ${text(value)}`,
    }, [val]) as HTMLButtonElement;

    const searchable = opts.searchable ?? choices.length > 8;
    const search = searchable
      ? (el("input", { class: "dd__search", type: "search", placeholder: "Search…", autocomplete: "off", "aria-label": `Search ${label}` }) as HTMLInputElement)
      : null;
    const optsWrap = el("div", { class: "dd__opts" });
    const menu = el("div", { class: "dd__menu", id: `${id}-menu`, role: "listbox", "aria-label": label, hidden: "" },
      [...(search ? [search] : []), optsWrap]);

    // Search scores the match, so a typed query ranks — it never reorders the
    // saved value, and dismissing the menu leaves the selection alone.
    const row = (o: DdOption): HTMLElement => {
      const on = o.value === sel.value;
      const node = el("button", {
        class: `dd__opt${on ? " is-on" : ""}`,
        type: "button",
        role: "option",
        "aria-selected": String(on),
        title: o.title ?? o.value,
      }, [el("span", { class: "dd__opt-label" }, [o.label])]);
      if (on) node.append(el("span", { class: "dd__tick" }, ["✓"]));
      node.onclick = () => set(o.value);
      return node;
    };
    const paint = (): void => {
      const q = (search?.value ?? "").trim();
      optsWrap.innerHTML = "";
      if (q) {
        const hits = choices
          .map((o) => ({ o, s: Math.max(fuzzy(q, o.label), fuzzy(q, o.title ?? ""), fuzzy(q, o.value)) }))
          .filter((h) => h.s > 0)
          .sort((a, b) => b.s - a.s);
        if (!hits.length) {
          optsWrap.append(el("div", { class: "dd__empty" }, ["No match"]));
          return;
        }
        for (const { o } of hits) optsWrap.append(row(o));
        return;
      }
      // Untyped: provider headers keep same-named models apart, in the order
      // the catalog listed them.
      const groups = new Map<string, DdOption[]>();
      for (const o of choices) {
        const g = o.group ?? "";
        if (!groups.has(g)) groups.set(g, []);
        groups.get(g)!.push(o);
      }
      for (const [g, list] of groups) {
        if (g) optsWrap.append(el("div", { class: "dd__group" }, [g]));
        for (const o of list) optsWrap.append(row(o));
      }
    };

    const close = (): void => {
      openDds.delete(close);
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      dd.classList.remove("is-open");
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onOutside, true);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close();
        btn.focus();
      }
    };
    const onOutside = (e: Event): void => {
      if (!dd.contains(e.target as Node)) close();
    };
    const open = (): void => {
      for (const c of [...openDds]) c(); // one menu at a time
      if (search) search.value = "";
      paint();
      dd.classList.remove("dd--up");
      menu.hidden = false;
      btn.setAttribute("aria-expanded", "true");
      // Flip upward only when the menu would spill past whatever clips it
      // (the settings pane and a modal body both scroll on their own).
      const r = btn.getBoundingClientRect();
      let clipTop = 0;
      let clipBottom = window.innerHeight ?? 0;
      let n: HTMLElement | null = dd.parentElement;
      while (n) {
        if (n.scrollHeight > n.clientHeight) {
          const br = n.getBoundingClientRect();
          clipTop = Math.max(clipTop, br.top);
          clipBottom = Math.min(clipBottom, br.bottom);
          break;
        }
        n = n.parentElement;
      }
      const h = menu.offsetHeight ?? 0;
      if (r.bottom + h + 8 > clipBottom && r.top - h - 8 >= clipTop) dd.classList.add("dd--up");
      dd.classList.add("is-open");
      openDds.add(close);
      document.addEventListener("keydown", onKey, true);
      document.addEventListener("mousedown", onOutside, true);
      if (search) search.focus();
    };
    const set = (v: string): void => {
      fill(v);
      val.textContent = text(v);
      val.classList.toggle("is-empty", !present(v));
      btn.setAttribute("aria-label", `${label}: ${text(v)}`);
      sel.dispatchEvent(new Event("change", { bubbles: true }));
      close();
      btn.focus(); // keep focus where the user was, not on a hidden menu
    };

    btn.onclick = () => (menu.hidden ? open() : close());
    if (search) {
      search.oninput = () => paint();
      search.onkeydown = (e) => {
        if (e.key !== "Enter") return;
        const first = optsWrap.querySelector(".dd__opt") as HTMLButtonElement | null;
        if (first) {
          e.preventDefault();
          first.click();
        }
      };
    }

    const dd = el("div", { class: "dd" }, [sel, btn, menu]);
    return { sel, node: dd, set };
  }

  /* ---------------- model ---------------- */

  #renderModel(defaults: any, selected: any[], _warning?: string): void {
    // Pure selection: every choice comes from the models checked in the Models
    // tab — no typing refs. The fallback list is ordered and uncapped (10+).
    const options: DdOption[] = (selected as any[]).map((m) => {
      // Label first, then the id — never the bare provider ref, which would
      // name the model "Openrouter".
      const raw = String(m.label || m.id || m.ref || "");
      const value = String(m.id ?? m.ref ?? "");
      const provider = String(m.ref ?? m.id ?? "").split("/")[0];
      // Rows sit under a provider header and drop its prefix, so the eye reads
      // the model — the stored id never changes.
      return { value, label: friendlyModelName(raw, provider), group: provider, title: value };
    });
    const byValue = new Map(options.map((o) => [o.value, o]));
    const providerOf = (v: string): string => byValue.get(v)?.group ?? (v.split("/")[0] || "");
    const nameOf = (v: string): string => byValue.get(v)?.label ?? (v ? friendlyModelName(v) : "— choose a model —");
    const ctxOf = (v: string): string => {
      const hit = (selected as any[]).find((m) => String(m.id ?? m.ref ?? "") === v);
      const n = Number(hit?.contextWindow ?? 0);
      if (n <= 0) return "—";
      return n >= 1_000_000 ? `${Number((n / 1_000_000).toFixed(1))}M` : `${Math.round(n / 1000)}k`;
    };

    const defaultDd = this.#dropdown({
      id: "defaults-model",
      value: String(defaults.model ?? ""),
      label: "Default model",
      placeholder: "— choose a model —",
      options,
    });
    defaultDd.node.classList.add("dd--hero");

    // Fallbacks are ONE field, not a growing list of selects: rows in priority
    // order, remove/reorder from the row, one menu adds the next — and that
    // menu only offers models not already in the chain.
    const fallbackValues: string[] = [...(defaults.fallbacks ?? [])];
    const chips = el("div", { class: "fbs" });
    const addWrap = el("div", { class: "fbs__add" });
    const count = el("span", { class: "setsec__count" }, [""]);

    /* ---- the hero: the page's answer, kept in step with the draft ---- */
    const heroModel = el("strong", { class: "def-hero__model" }, [""]);
    const heroProv = el("span", {}, [""]);
    const heroChain = el("div", { class: "def-hero__chain" });
    const factCtx = el("span", { class: "def-hero__fact-v" }, [""]);
    const factFb = el("span", { class: "def-hero__fact-v" }, [""]);
    const heroWarn = el("p", { class: "def-hero__warn", hidden: "" }, []);
    const heroEmpty = el("p", { class: "def-hero__empty", hidden: "" }, [
      "No models are switched on yet — open Models, check the ones you want, then come back and pick a default.",
    ]);
    const under = el("p", { class: "def-under" }, [""]);

    const sync = (): void => {
      const current = defaultDd.sel.value;
      const known = byValue.has(current);
      heroModel.textContent = current ? nameOf(current) : "— choose a model —";
      heroProv.textContent = current ? providerOf(current) : "no default yet";
      factCtx.textContent = current ? ctxOf(current) : "—";
      factFb.textContent = String(fallbackValues.length);
      // The raw ref: the one machine value on this page you cannot read off
      // any control, and the one you would paste into config.json5.
      under.textContent = current || "nothing chosen yet";

      // A stale default (configured, but no longer switched on) is a real state:
      // say it rather than rendering a chain that cannot start.
      const stale = Boolean(current) && !known && options.length > 0;
      heroWarn.hidden = !stale;
      heroWarn.textContent = stale ? "This model is not switched on in Models — pick one below." : "";
      heroEmpty.hidden = options.length > 0;

      heroChain.innerHTML = "";
      if (options.length === 0) return;
      if (!current) {
        heroChain.append(el("span", { class: "def-hero__lead" }, ["No model chosen yet."]));
        return;
      }
      const steps: string[] = [current, ...fallbackValues.filter((v) => v !== current)];
      steps.slice(0, 4).forEach((v, i) => {
        if (i > 0) heroChain.append(el("span", { class: "def-hero__more", "aria-hidden": "true" }, ["›"]));
        heroChain.append(el("span", { class: `def-hero__step${i === 0 ? " is-default" : ""}` }, [
          el("b", {}, [String(i + 1)]),
          el("span", { title: v }, [nameOf(v)]),
        ]));
      });
      const hidden = steps.length - 4;
      if (hidden > 0) heroChain.append(el("span", { class: "def-hero__more" }, [`+${hidden} more`]));
      if (fallbackValues.filter((v) => v !== current).length === 0) {
        heroChain.append(el("span", { class: "def-hero__lead" }, ["no fallback behind it"]));
      }
    };

    const redrawFallbacks = (): void => {
      chips.innerHTML = "";
      fallbackValues.forEach((v, i) => {
        const opt = options.find((o) => o.value === v);
        const chip = el("div", { class: "fb" }, [
          el("span", { class: "fb__n" }, [String(i + 1)]),
          el("span", { class: "fb__t", title: opt?.title ?? v }, [opt?.label ?? friendlyModelName(v)]),
          el("span", { class: "fb__p" }, [providerOf(v)]),
        ]);
        const swap = (dir: -1 | 1, name: string): HTMLButtonElement => {
          const b = el("button", { class: "fb__b", type: "button", "aria-label": `${name} ${opt?.label ?? v}` }, [dir < 0 ? "‹" : "›"]) as HTMLButtonElement;
          b.disabled = i + dir < 0 || i + dir >= fallbackValues.length;
          b.onclick = () => {
            const j = i + dir;
            const tmp = fallbackValues[i] as string;
            fallbackValues[i] = fallbackValues[j] as string;
            fallbackValues[j] = tmp;
            redrawFallbacks();
          };
          return b;
        };
        const rm = el("button", { class: "fb__b fb__b--x", type: "button", "aria-label": `Remove ${opt?.label ?? v}` }, ["✕"]) as HTMLButtonElement;
        rm.onclick = () => {
          fallbackValues.splice(i, 1);
          redrawFallbacks();
        };
        chip.append(swap(-1, "Move earlier"), swap(1, "Move later"), rm);
        chips.append(chip);
      });
      if (!fallbackValues.length) chips.append(el("span", { class: "fbs__empty" }, ["No fallbacks — one model only."]));

      const used = new Set(fallbackValues);
      const left = options.filter((o) => !used.has(o.value));
      addWrap.innerHTML = "";
      if (left.length) {
        const addDd = this.#dropdown({
          id: "fallback-add",
          value: "",
          label: "Add a fallback model",
          placeholder: "+ Add fallback",
          options: left,
        });
        addDd.sel.addEventListener("change", () => {
          const v = addDd.sel.value;
          if (!v) return;
          fallbackValues.push(v);
          redrawFallbacks();
        });
        addWrap.append(addDd.node);
      } else {
        addWrap.append(el("p", { class: "hint" }, [
          options.length ? "Every switched-on model is already in the chain." : "No models selected yet — check models in the Models tab first.",
        ]));
      }
      count.textContent = `${fallbackValues.length} configured`;
      sync();
    };
    defaultDd.sel.addEventListener("change", sync);

    const note = el("span", { class: "setfoot__note", "aria-live": "polite" }, []);
    const save = el("button", { class: "btn pri", type: "button" }, ["Save model"]);
    const card = el("div", { class: "card setcard" }, [
      el("div", { class: "setcard__head" }, [
        el("h3", {}, ["Model"]),
        el("p", { class: "hint" }, [
          options.length === 0
            ? "No models selected yet — check models in the Models tab first."
            : "The model a new chat starts on, and the ladder behind it when a provider fails.",
        ]),
      ]),
      this.#field("Default model", defaultDd.node, {
        hint: "Used for every new session. Choose from the models switched on in Models; the id under it is what config.json5 stores.",
      }),
      under,
      el("div", { class: "setsec" }, [
        el("div", { class: "setsec__head" }, [
          el("span", { class: "cap" }, ["Fallback chain"]),
          count,
        ]),
        el("p", { class: "hint" }, [
          "Tried in order when a model fails — each gets its own retry budget. Nothing here runs in parallel with the default.",
        ]),
        chips,
        addWrap,
      ]),
      el("div", { class: "setfoot" }, [note, save]),
    ]);
    const clearDirty = this.#dirtyWatch(card, note);

    save.onclick = async () => {
      const fb = fallbackValues.map((v) => v.trim()).filter(Boolean);
      const ok = await this.#setMany([
        ["agents.defaults.model", defaultDd.sel.value],
        ["agents.defaults.fallbacks", fb],
      ], "model saved");
      if (ok) clearDirty();
    };

    // The hero goes first on the page: the answer before the controls.
    this.#root.append(hero(), card);
    redrawFallbacks();

    function hero(): HTMLElement {
      return el("div", { class: "def-hero" }, [
        el("div", { class: "def-hero__main" }, [
          el("span", { class: "def-hero__label" }, ["Starts on"]),
          heroModel,
          el("span", { class: "def-hero__prov" }, [heroProv]),
          heroWarn,
          heroEmpty,
          heroChain,
        ]),
        el("div", { class: "def-hero__facts" }, [
          el("span", { class: "def-hero__fact" }, [el("span", { class: "def-hero__fact-k" }, ["context"]), factCtx]),
          el("span", { class: "def-hero__fact" }, [el("span", { class: "def-hero__fact-k" }, ["fallbacks"]), factFb]),
        ]),
      ]);
    }
  }

  /** Agent identity (P4 #39 — their Personal identity page): the face the agent
   *  wears, the name it answers to, and the voice it speaks in.
   *
   *  The icon is a choice between the two marks this product actually has (🦀 crab,
   *  🦞 claw), not a free-text emoji box: an arbitrary glyph lets the agent look
   *  like anything, and a text field is the wrong control for a two-value choice.
   *  #identity-emoji survives as a hidden value store — the same pattern the
   *  .dd__store selects use — so the save path and every script that reads it keep
   *  working while the visible surface is a picker.
   *
   *  The portrait is picked from any PNG/JPEG/WebP, centre-cropped square and
   *  shrunk to a bounded data URL (ui/src/avatar.ts) that lives in the config, so
   *  the face travels with backups and `sc config`. */
  #renderAgentIdentity(config: any): void {
    const id = config.agents?.identity ?? {};
    const presets: { glyph: string; label: string }[] = [
      { glyph: "🦀", label: "Crab" },
      { glyph: "🦞", label: "Claw" },
    ];
    const storedEmoji = String(id.emoji ?? "").trim() || "🦀";
    // null = the stored icon is not one of the presets (an old hand-edited 🐙).
    // Nothing is rewritten: the tile shows what is stored and says so.
    let picked: string | null = presets.some((p) => p.glyph === storedEmoji) ? storedEmoji : null;
    let portrait = isStoredAvatar(id.avatar) ? String(id.avatar) : "";
    let busy = false;

    const mkField = (iid: string, label: string, value: string, placeholder: string, narrow = false) => {
      const input = el("input", { class: "inp", id: iid, value, placeholder, autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
      return { input, node: this.#field(label, input, { forId: iid, narrow }) };
    };
    const nameField = mkField("identity-name", "Name", String(id.name ?? "SuparClaw"), "SuparClaw");

    // Value stores, not controls: hidden inputs the save path reads.
    const emojiStore = el("input", { id: "identity-emoji", type: "hidden", value: picked ?? storedEmoji }) as HTMLInputElement;
    emojiStore.value = picked ?? storedEmoji;
    const avatarStore = el("input", { id: "identity-avatar", type: "hidden", value: portrait }) as HTMLInputElement;
    avatarStore.value = portrait;

    // --- the face: a portrait tile with the two photo actions under it ---
    const tile = el("div", { class: "def-portrait", "aria-hidden": "true" }, []);
    const addPhoto = el("button", { class: "btn sm def-photo__add", id: "identity-photo-btn", type: "button" }, ["Add photo"]) as HTMLButtonElement;
    const dropPhoto = el("button", { class: "def-photo__remove", id: "identity-photo-clear", type: "button" }, ["Remove"]) as HTMLButtonElement;
    const fileInput = el("input", { id: "identity-photo", type: "file", accept: AVATAR_ACCEPT, hidden: "" }) as HTMLInputElement;
    const face = el("div", { class: "def-face" }, [
      tile,
      el("div", { class: "def-photo" }, [addPhoto, dropPhoto, fileInput]),
    ]);

    // --- the icon picker ---
    const icons = el("div", { class: "def-icons", role: "group", "aria-label": "Icon" }, []);
    const tiles = presets.map((p) => {
      const btn = el("button", { class: "def-icon", type: "button", "aria-pressed": "false" }, [
        el("span", { class: "def-icon__glyph", "aria-hidden": "true" }, [p.glyph]),
        el("span", { class: "def-icon__label" }, [p.label]),
      ]) as HTMLButtonElement;
      btn.onclick = () => {
        // Re-picking the current icon is a no-op, so it cannot dirty the card.
        if (picked === p.glyph) return;
        picked = p.glyph;
        emojiStore.value = p.glyph;
        repaint();
        this.#dirtyMark(dirtyNote);
      };
      icons.append(btn);
      return btn;
    });
    const presetNote = el("p", { class: "def-note", hidden: "" }, []);
    const iconField = this.#field("Icon", icons);

    // The persona is prose — a real textarea, not a one-line input.
    const area = el("textarea", {
      class: "inp",
      id: "identity-theme",
      placeholder: "a warm, sharp, resourceful personal AI companion…",
      rows: "4",
      autocomplete: "off",
      spellcheck: "false",
    }) as HTMLTextAreaElement;
    area.value = String(id.theme ?? "");
    const voice = this.#field("Voice", area, {
      forId: "identity-theme",
      hint: "Written into the system prompt — this is how it talks, not what it knows.",
    });

    // Identity is the most human thing on this page, so it shows the agent
    // instead of only naming fields. The preview mirrors the draft (what Save
    // would commit) and is decorative: aria-hidden, since the same words are in
    // the fields beside it.
    const previewFace = el("span", { class: "def-preview__face" }, []);
    const previewWho = el("span", { class: "def-preview__who" }, []);
    const previewQuote = el("p", { class: "def-preview__quote" }, []);
    const preview = el("div", { class: "def-preview", "aria-hidden": "true" }, [
      previewFace,
      el("div", { class: "def-preview__body" }, [previewWho, previewQuote]),
    ]);

    const status = el("p", { class: "def-photo__status", role: "status" }, []);

    /** First visible glyph of a string. Emoji are not one code unit — 👩🏽‍💻 is a
     *  ZWJ sequence — so cut on a grapheme, never on .slice(). */
    const firstGlyph = (s: string): string => {
      try {
        const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
        const first = seg.segment(s)[Symbol.iterator]().next();
        return first.done ? "" : String(first.value.segment).slice(0, 12);
      } catch {
        return Array.from(s).slice(0, 2).join("");
      }
    };
    const setStatus = (message: string): void => {
      status.textContent = message;
      status.hidden = message === "";
    };

    const repaint = (): void => {
      // Same fallbacks the save handler applies, so the preview never promises a
      // blank name or icon that would not be stored.
      const name = nameField.input.value.trim() || "SuparClaw";
      const glyph = picked ?? (firstGlyph(storedEmoji) || "🦀");
      const theme = area.value.trim();

      for (let i = 0; i < presets.length; i += 1) {
        const on = picked === presets[i]?.glyph;
        tiles[i]?.setAttribute("aria-pressed", on ? "true" : "false");
      }
      presetNote.hidden = picked !== null;
      presetNote.textContent = picked === null
        ? `Saved icon ${firstGlyph(storedEmoji)} isn't one of the presets — pick one to replace it.`
        : "";

      tile.innerHTML = "";
      tile.append(
        portrait
          ? el("img", { class: "def-portrait__img", src: portrait, alt: "", decoding: "async", draggable: "false" })
          : el("span", { class: "def-portrait__glyph" }, [glyph]),
      );

      dropPhoto.hidden = !portrait;
      addPhoto.disabled = busy;
      addPhoto.textContent = busy ? "Preparing…" : portrait ? "Change photo" : "Add photo";

      previewFace.innerHTML = "";
      previewFace.append(
        portrait
          ? el("img", { class: "def-preview__img", src: portrait, alt: "", decoding: "async" })
          : el("span", { class: "def-preview__glyph" }, [glyph]),
      );
      previewWho.textContent = name;
      previewQuote.textContent = theme ? `“${theme}”` : "No voice set — it will introduce itself with the default persona.";
    };

    const dirtyNote = el("span", { class: "setfoot__note", "aria-live": "polite" }, []);
    const saveId = el("button", { class: "btn", type: "button", id: "identity-save" }, ["Save identity"]) as HTMLButtonElement;
    const card = el("div", { class: "card setcard agent-identity" }, [
      el("div", { class: "setcard__head" }, [
        el("h3", {}, ["Identity"]),
        el("p", { class: "hint" }, ["Who the agent says it is, everywhere it speaks."]),
      ]),
      el("div", { class: "def-identity" }, [
        face,
        el("div", { class: "def-identity__fields" }, [nameField.node, iconField, presetNote, emojiStore, avatarStore]),
        el("div", { class: "def-identity__foot" }, [
          status,
          el("p", { class: "hint" }, [
            "PNG, JPEG or WebP · cropped square · kept in your config. The model hears the agent's name and voice; it is never shown this picture.",
          ]),
        ]),
      ]),
      voice,
      preview,
      el("div", { class: "setfoot" }, [dirtyNote, saveId]),
    ]);
    const clearDirty = this.#dirtyWatch(card, dirtyNote);

    addPhoto.onclick = () => {
      if (!busy) fileInput.click();
    };
    dropPhoto.onclick = () => {
      if (!portrait) return;
      portrait = "";
      avatarStore.value = "";
      setStatus("Photo removed — save to keep that.");
      repaint();
      this.#dirtyMark(dirtyNote);
    };
    fileInput.onchange = async () => {
      const file = fileInput.files && fileInput.files[0];
      // Clearing the input lets the same file be picked twice in a row.
      fileInput.value = "";
      if (!file) return;
      busy = true;
      setStatus("");
      repaint();
      try {
        const next = await prepareAvatar(file);
        portrait = next;
        avatarStore.value = next;
        setStatus("Photo ready — save to keep it.");
        this.#dirtyMark(dirtyNote);
      } catch (err) {
        const message = (err as Error)?.message || "That picture could not be used.";
        setStatus(message);
        toast(message, "err");
      } finally {
        busy = false;
        repaint();
      }
    };

    saveId.onclick = async () => {
      const root = this.#root;
      const name = (root.querySelector("#identity-name") as HTMLInputElement).value.trim();
      const emoji = (root.querySelector("#identity-emoji") as HTMLInputElement).value.trim();
      const theme = (root.querySelector("#identity-theme") as HTMLTextAreaElement).value.trim();
      const avatar = (root.querySelector("#identity-avatar") as HTMLInputElement).value;
      const ok = await this.#setMany(
        [
          ["agents.identity.name", name || "SuparClaw"],
          ["agents.identity.emoji", emoji || "🦀"],
          ["agents.identity.theme", theme],
          // Never persist a string the renderer would refuse to show.
          ["agents.identity.avatar", isStoredAvatar(avatar) ? avatar : ""],
        ],
        "identity saved — new sessions greet with it immediately",
      );
      if (ok) clearDirty();
    };

    nameField.input.addEventListener("input", repaint);
    area.addEventListener("input", repaint);

    this.#root.append(card);
    setStatus("");
    repaint();
  }

  /** Agent defaults (P4 #39): loop limits, lane caps, subagent budget,
   *  reasoning + usage-visibility defaults — their Agents Defaults page.
   *
   *  There is no context-budget field: the history budget is derived from the
   *  model's declared context window (Settings → Models → Tune), so the card
   *  states where the number comes from instead of pretending the user can set
   *  it here. `selected` is the enabled model profiles, used only for that line. */
  #renderAgentDefaults(d: any, selected: any[] = []): void {
    // Labels name the thing; ranges, units and consequences live in the hint
    // under the control. A label that documents itself is a label nobody reads.
    const mkNum = (
      iid: string,
      label: string,
      cur: number,
      hint?: string,
      mode: "numeric" | "text" = "numeric",
    ) => {
      const input = el("input", {
        class: "inp mono",
        id: iid,
        value: String(cur),
        autocomplete: "off",
        inputmode: mode === "numeric" ? "numeric" : "text",
      }) as HTMLInputElement;
      return { input, node: this.#field(label, input, { forId: iid, hint }) };
    };
    const mkSel = (iid: string, label: string, cur: string, options: [string, string][], hint?: string) => {
      const dd = this.#dropdown({
        id: iid,
        value: cur,
        label,
        placeholder: "— choose —",
        options: options.map(([value, lab]) => ({ value, label: lab })),
      });
      // The trigger is a button, so the visible label is text, not a label[for];
      // the button itself announces "label: value".
      return { sel: dd.sel, node: this.#field(label, dd.node, { hint }) };
    };
    const sub = d.subagents ?? {};
    const iterations = mkNum("ad-iterations", "Tool iterations", Number(d.maxToolIterations ?? 12),
      "No ceiling — one turn keeps working until it answers. The loop guard still stops a repeat.");
    const concur = mkNum("ad-concurrent", "Concurrent runs", Number(d.maxConcurrent ?? 0),
      "0 = auto (max(8, CPU × 4)).");
    const reasoning = mkSel("ad-reasoning", "Reasoning effort", String(d.reasoningEffort ?? "inherit"),
      [["inherit", "inherit"], ["off", "off"], ["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "xhigh"], ["max", "max"]],
      "Sent to the provider as-is; inherit follows the model.");
    const viewSel = mkSel("ad-rview", "Show thinking blocks", String(d.reasoningView ?? "on"),
      [["on", "on"], ["off", "off"]],
      "Blocks are stored either way — off only hides them here.");
    const usageSel = mkSel("ad-usage", "Reply footer", String(d.usage ?? "tokens"),
      [["off", "off"], ["tokens", "tokens"], ["full", "full"], ["cost", "cost"]],
      "Cost needs a pricing card per model; without one the footer says so and shows tokens — never a guess.");
    const subConcur = mkNum("ad-sub-concurrent", "Subagent lane cap", Number(sub.maxConcurrent ?? 8),
      "Children per spawning session, plus the background lane.");
    const subModel = mkNum("ad-sub-model", "Subagent model", 0,
      "Blank inherits the caller's model.", "text");
    subModel.input.value = String(sub.model ?? "");
    const subDepth = mkNum("ad-sub-depth", "Subagent depth", Number(sub.maxDepth ?? 1),
      "1–4. At 1, children cannot spawn children.");
    const subThink = mkSel("ad-sub-think", "Subagent thinking", String(sub.thinking ?? ""),
      [["", "inherit caller"], ["off", "off"], ["low", "low"], ["medium", "medium"], ["high", "high"]],
      "Overrides what the caller chose.");
    const subDeleg = mkSel("ad-sub-deleg", "Delegation", String(sub.delegationMode ?? "inherit"),
      [["inherit", "inherit"], ["prefer", "prefer (:main)"], ["suggest", "suggest"]],
      "It is prompt guidance only — nothing is enforced by it.");

    // Where the history budget comes from, in the same numbers the runtime uses.
    // ui/src cannot import server code, so these three constants are repeated from
    // src/agent/context-budget.ts (test/context-budget.test.mjs asserts they agree).
    const CHARS_PER_TOKEN = 4;
    const WINDOW_SHARE = 0.7;
    const MAX_HISTORY_CHARS = 400_000;
    const budgetLine = (): HTMLElement => {
      const current = String(d.model ?? "");
      const hit = (selected as any[]).find((m) => String(m.id ?? m.ref ?? "") === current);
      const window = Number(hit?.contextWindow ?? 0);
      if (window > 0) {
        const raw = Math.round(window * CHARS_PER_TOKEN * WINDOW_SHARE);
        const chars = Math.max(8000, Math.min(raw, MAX_HISTORY_CHARS));
        const fmt = (n: number): string => (n >= 1_000_000 ? `${Number((n / 1_000_000).toFixed(1))}M` : `${Math.round(n / 1000)}k`);
        const label = String(hit?.label || hit?.id || hit?.ref || current);
        // Say which number is the cap when it binds, or the arithmetic reads wrong
        // (a 200k window "should" be 560k characters, not 400k).
        const amount = raw > MAX_HISTORY_CHARS
          ? `${fmt(raw)} characters would fit (capped at ${fmt(MAX_HISTORY_CHARS)})`
          : `about ${fmt(chars)} characters fit`;
        return el("p", { class: "hint" }, [
          `History follows the model: ${friendlyModelName(label, String(hit?.ref ?? "").split("/")[0] || "")} declares a ${fmt(window)} window, so ${amount} and compaction starts before that. Change it per model in Models → Tune.`,
        ]);
      }
      return el("p", { class: "hint" }, [
        "No context window is set for the model this session starts on, so history falls back to 200,000 characters. Give the model a window in Models → Tune and this follows it — and it can never exceed the window.",
      ]);
    };

    const sec = (title: string, nodes: HTMLElement[], note?: string): HTMLElement =>
      el("div", { class: "def-sec" }, [
        el("div", { class: "def-sec__head" }, [
          el("span", { class: "cap" }, [title]),
          ...(note ? [el("span", { class: "def-sec__note" }, [note])] : []),
        ]),
        el("div", { class: "setgrid" }, nodes),
      ]);

    const note = el("span", { class: "setfoot__note", "aria-live": "polite" }, []);
    const saveD = el("button", { class: "btn", type: "button", id: "agent-defaults-save" }, ["Save run limits"]) as HTMLButtonElement;
    const card = el("div", { class: "card setcard agent-defaults" }, [
      el("div", { class: "setcard__head" }, [
        el("h3", {}, ["Run limits"]),
        el("p", { class: "hint" }, ["What one turn may do when a session brings no settings of its own."]),
      ]),
      el("div", { class: "def-sec" }, [
        el("div", { class: "def-sec__head" }, [el("span", { class: "cap" }, ["Loop & limits"])]),
        el("div", { class: "setgrid" }, [iterations.node, concur.node]),
        budgetLine(),
      ]),
      sec("Reasoning & replies", [reasoning.node, viewSel.node, usageSel.node]),
      sec("Subagents", [subConcur.node, subModel.node, subDepth.node, subThink.node, subDeleg.node]),
      el("div", { class: "setfoot" }, [note, saveD]),
    ]);
    const clearDirty = this.#dirtyWatch(card, note);

    saveD.onclick = async () => {
      const ok = await this.#setMany(
        [
          ["agents.defaults.maxToolIterations", Math.max(1, Math.trunc(Number(iterations.input.value)) || 12)],
          ["agents.defaults.maxConcurrent", Math.max(0, Number(concur.input.value) || 0)],
          ["agents.defaults.reasoningEffort", reasoning.sel.value],
          ["agents.defaults.reasoningView", viewSel.sel.value],
          ["agents.defaults.usage", usageSel.sel.value],
          ["agents.defaults.subagents.maxConcurrent", Math.max(1, Number(subConcur.input.value) || 8)],
          ["agents.defaults.subagents.model", subModel.input.value.trim()],
          ["agents.defaults.subagents.maxDepth", Math.max(1, Math.min(4, Number(subDepth.input.value) || 1))],
          ["agents.defaults.subagents.thinking", subThink.sel.value],
          ["agents.defaults.subagents.delegationMode", subDeleg.sel.value],
        ],
        "run limits saved — applies to new runs immediately",
      );
      if (ok) clearDirty();
    };

    this.#root.append(card);
  }

  /* ---------------- models ---------------- */

  // Provider-first selection surface: a provider card opens a sub-page with
  // its fetched models; the checkbox marks which models exist "in the system"
  // (strict filter — unmarked models appear nowhere), and clicking a model
  // tunes its capabilities in a popup.

  /** Two letters for a provider. No brand assets ship with the app, so the mark
   *  comes from the id: "lm-studio" → LS, "openrouter" → OR, "openai" → OI.
   *
   *  A single-word id takes its first and last letter, not its first two: the
   *  obvious "first two" gives openai and openrouter the same mark, which is
   *  exactly what a monogram is supposed to prevent. */
  #providerMark(id: string): string {
    const parts = id.split(/[^a-z0-9]+/i).filter(Boolean);
    const whole = parts.join("");
    const letters = parts.length > 1
      ? `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`
      : whole.length > 1
        ? `${whole[0]}${whole[whole.length - 1]}`
        : whole;
    return (letters || "?").toUpperCase();
  }

  /** The facts one provider row is built from.
   *
   *  The count is deliberately two numbers from two sources: the numerator is
   *  the enabled rows in the config (the truth), the denominator is what the
   *  provider last advertised. Deriving both from discovery — as this page used
   *  to — showed "0 of 0 selected" whenever a refresh failed, even with twelve
   *  models saved and switched on. */
  #providerFacts(
    name: string,
    providers: Record<string, Provider>,
    configured: any[],
    discovered: string[],
    auth: any[],
  ): ProviderFacts {
    const prefix = `${name}/`;
    const total = discovered.filter((ref) => ref.startsWith(prefix)).length;
    const chosen = (configured as any[]).filter(
      (m) => String(m?.ref ?? "").startsWith(prefix) && Boolean(m?.enabled),
    ).length;
    const bound = String((providers[name] as any)?.apiKey ?? "").trim();
    const profiles = (auth as any[]).filter((p: any) => p?.provider === name);
    const profile = bound ? (profiles.find((p: any) => p.id === bound) ?? null) : null;
    // A saved profile id that no longer exists is a failure worth naming; a
    // value that is not a profile id is the key itself, sitting in the config.
    const profileShaped = /^sc_[a-z0-9]+$/i.test(bound);
    let state: ProviderFacts["state"];
    if (!bound) state = { text: "no key yet", tone: "idle" };
    else if (profile) {
      state = profile.ok
        ? { text: `${profile.id}${profile.expires ? ` · ${profile.expiresIn}` : ""}`, tone: "ok" }
        : { text: `${profile.id} · ${profile.reason ?? "not usable"}`, tone: "warn" };
    } else if (profileShaped) state = { text: "profile missing", tone: "err" };
    else state = { text: "key in the config", tone: "ok" };
    if (total === 0 && chosen === 0 && state.tone === "ok") state = { text: "no models fetched yet", tone: state.tone };

    return {
      url: String((providers[name] as any)?.baseUrl ?? ""),
      total,
      chosen,
      profiles,
      bound,
      state,
      count: total > 0 ? `${chosen} of ${total}` : chosen > 0 ? `${chosen} in the system` : "",
    };
  }

  /** One sentence answering "what is in the system?", plus a second only when
   *  something needs doing. */
  #modelsSummary(all: ProviderFacts[]): string {
    if (all.length === 0) return "No models in the system yet.";
    const total = all.reduce((n, f) => n + f.chosen, 0);
    const providers = all.length;
    const sentences = [
      `${total} ${total === 1 ? "model" : "models"} in the system across ${providers} ${providers === 1 ? "provider" : "providers"}.`,
    ];
    const noKey = all.filter((f) => f.state.tone === "idle").length;
    const broken = all.filter((f) => f.state.tone === "err").length;
    if (noKey > 0) sentences.push(`${noKey} ${noKey === 1 ? "provider needs" : "providers need"} a key.`);
    if (broken > 0) sentences.push(`${broken} ${broken === 1 ? "provider has" : "providers have"} a missing auth profile.`);
    return sentences.join(" ");
  }

  /** One provider: monogram, name + count, endpoint + auth chips, state + actions.
   *  The name and Open are real buttons — the old card put an onclick on a div
   *  around its own buttons, which handed keyboard users half the page. */
  #providerRow(name: string, facts: ProviderFacts, onOpen: () => void, onConnect: () => void): HTMLElement {
    const open = el("button", {
      class: "models__name",
      type: "button",
      title: name,
      "aria-label": `Open ${name}`,
    }, [name]);
    open.onclick = onOpen;

    const count = facts.count ? el("span", { class: "models__count" }, [facts.count]) : null;
    const meta: (Node | string)[] = [];
    if (facts.url) meta.push(el("span", { class: "models__url" }, [facts.url]));
    if (facts.profiles.length) {
      meta.push(el("div", { class: "models__chips" }, facts.profiles.map((p: any) => this.#profileChip(p, name, facts.profiles))));
    }

    const state = el("span", { class: `models__state models__state--${facts.state.tone}` }, [
      el("span", { class: `models__dot models__dot--${facts.state.tone}`, "aria-hidden": "true" }),
      facts.state.text,
    ]);
    const openBtn = el("button", {
      class: "btn sm models__open",
      type: "button",
      "aria-label": `Open ${name}`,
    }, ["Open", el("span", { class: "models__chev", "aria-hidden": "true" }, ["›"])]);
    openBtn.onclick = onOpen;
    const authBtn = el("button", {
      class: "btn sm",
      type: "button",
      "aria-label": `${facts.bound ? "Auth" : "Connect"} ${name}`,
    }, [facts.bound ? "Auth…" : "Connect"]);
    authBtn.onclick = (e) => {
      e.stopPropagation();
      onConnect();
    };

    return el("li", { class: "models__row", "data-provider": name }, [
      el("span", { class: "models__mark", "aria-hidden": "true" }, [this.#providerMark(name)]),
      el("div", { class: "models__main" }, [
        el("div", { class: "models__head" }, count ? [open, count] : [open]),
        ...(meta.length ? [el("div", { class: "models__meta" }, meta)] : []),
      ]),
      el("div", { class: "models__side" }, [state, el("div", { class: "models__actions" }, [openBtn, authBtn])]),
    ]);
  }

  /** Models tab: which providers exist, what each one is doing, and the two ways
   *  to add another. Two ruled panels of hairline rows — the previous layout was
   *  one identical card per provider (and one for each way of adding a provider),
   *  which spent four elevations on three lines of facts each. */
  #renderModels(
    providers: Record<string, Provider>,
    configured: any[],
    discovered: string[],
    auth: any[] = [],
    plugins: any[] = [],
    warning?: string,
  ): void {
    const names = Object.keys(providers).sort((a, b) => a.localeCompare(b));
    const facts = new Map(names.map((name) => [name, this.#providerFacts(name, providers, configured, discovered, auth)]));

    const panel = el("div", { class: "card setcard models__panel" }, [
      el("div", { class: "setcard__head" }, [
        el("h3", {}, ["In the system"]),
        el("p", { class: "hint", id: "models-summary" }, [this.#modelsSummary([...facts.values()])]),
      ]),
    ]);
    // The stale-catalog reason used to reach the provider page only, so this tab
    // showed old numbers with no explanation.
    if (warning) panel.append(el("p", { class: "hint is-warn models__warn" }, [warning]));
    if (names.length === 0) {
      const go = el("button", { class: "btn sm", type: "button", id: "models-empty-providers" }, ["Go to Providers"]);
      go.onclick = () => this.#setTab("providers");
      panel.append(el("div", { class: "models__empty" }, [
        el("p", { class: "hint" }, ["No provider is configured yet. Add one below, or connect a plugin."]),
        go,
      ]));
    } else {
      const list = el("ul", { class: "models__list" });
      for (const name of names) {
        const onOpen = (): void => {
          this.#modelsProvider = name;
          void this.render();
        };
        const binding = String((providers[name] as any)?.apiKey ?? "");
        const onConnect = (): void => {
          this.#connectProvider(name, (plugins as any[]).find((p: any) => p.id === name) ?? null, binding);
        };
        list.append(this.#providerRow(name, facts.get(name)!, onOpen, onConnect));
      }
      panel.append(list);
    }
    this.#root.append(panel);

    // Add a provider: local runtimes on this device and plugins that can sign in.
    // Both are the same kind of thing (a row with one action), so they share a
    // panel with one caption each instead of owning a card apiece.
    const deviceRows = el("div", { class: "ledger" }, [
      el("div", { class: "ledger__row" }, [
        el("div", { class: "ledger__main" }, [
          el("div", { class: "ledger__pattern" }, ["Local services"]),
          el("div", { class: "ledger__meta" }, ["Scanning this device for Ollama, LM Studio, vLLM, SGLang and llama.cpp…"]),
        ]),
      ]),
    ]);
    const groups: HTMLElement[] = [
      el("div", { class: "models__group" }, [
        el("div", { class: "cap models__grouphead" }, ["On this device"]),
        deviceRows,
      ]),
    ];
    const fresh = (plugins as any[]).filter((p: any) => !names.includes(p.id));
    if (fresh.length) {
      const rows = fresh.slice(0, 12).map((p: any) => {
        const connect = el("button", { class: "btn sm", type: "button", "aria-label": `Connect ${p.label || p.id}` }, ["Connect"]);
        connect.onclick = () => this.#connectProvider(p.id, p, "");
        return el("div", { class: "ledger__row" }, [
          el("div", { class: "ledger__main" }, [
            el("div", { class: "ledger__pattern" }, [String(p.id)]),
            el("div", { class: "ledger__meta" }, [String(p.label ?? "")]),
          ]),
          connect,
        ]);
      });
      groups.push(el("div", { class: "models__group" }, [
        el("div", { class: "cap models__grouphead" }, ["Provider plugins"]),
        el("div", { class: "ledger" }, rows),
      ]));
    }
    const addPanel = el("div", { class: "card setcard models__panel" }, [
      el("div", { class: "setcard__head" }, [
        el("h3", {}, ["Add a provider"]),
        el("p", { class: "hint" }, ["Sign in to a hosted provider, or use a runtime already running on this device."]),
      ]),
      ...groups,
      el("p", { class: "hint models__foot" }, [
        "CLI: sc models local --add <service> — Ollama uses the native /api/chat wire (their warning: /v1 compat breaks tool calling).",
      ]),
    ]);
    this.#root.append(addPanel);
    void this.#fillLocalServices(deviceRows, names);
  }

  /** Local services discovery rows: state, models with ctx hints, Add. Fills the
   *  ledger passed in (the "On this device" group) instead of owning a card, and
   *  says plainly when the gateway has no scanner — a thrown request used to
   *  leave "Scanning…" on screen forever. */
  async #fillLocalServices(into: HTMLElement, configuredNames: string[]): Promise<void> {
    let scan: any = null;
    try {
      scan = (await gateway.request("models.local.scan", {})) as any;
    } catch {
      /* older gateway without local discovery */
    }
    // The tab may have changed while the scan was in the air.
    if (!this.#root.contains(into)) return;
    into.innerHTML = "";
    if (!scan?.services) {
      into.append(el("div", { class: "ledger__row" }, [
        el("div", { class: "ledger__main" }, [
          el("div", { class: "ledger__pattern" }, ["Local discovery"]),
          el("div", { class: "ledger__meta" }, ["not available in this gateway — connect a provider below, or in the Providers tab."]),
        ]),
      ]));
      return;
    }
    const services = [...(scan.services as any[])].sort(
      (a, b) => Number(Boolean(b.running)) - Number(Boolean(a.running)) || String(a.id).localeCompare(String(b.id)),
    );
    if (services.every((svc) => !svc.running)) {
      into.append(el("div", { class: "ledger__row" }, [
        el("div", { class: "ledger__main" }, [
          el("div", { class: "ledger__pattern" }, ["Nothing running"]),
          el("div", { class: "ledger__meta" }, ["install Ollama or LM Studio and it appears here — or add a provider in the Providers tab."]),
        ]),
      ]));
      return;
    }
    for (const svc of services) {
      const isConfigured = configuredNames.includes(svc.id);
      const add = el("button", {
        class: "btn sm",
        type: "button",
        "aria-label": `${isConfigured ? "Re-scan" : "Add"} ${svc.id}`,
      }, [!svc.running ? "" : isConfigured ? "↻ re-scan" : "Add"]) as HTMLButtonElement;
      if (!svc.running) add.disabled = true;
      add.onclick = async () => {
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
      const models: string[] = Array.isArray(svc.models) ? svc.models : [];
      const hint = svc.running && models.length
        ? `${models.slice(0, 6).map((m: string) => `${m}${svc.hints?.[m]?.contextWindow ? ` (ctx ${Math.round(svc.hints[m].contextWindow / 1000)}k)` : ""}`).join(" · ")}${models.length > 6 ? ` · +${models.length - 6} more` : ""}`
        : "";
      into.append(el("div", { class: "ledger__row" }, [
        el("div", { class: "ledger__main" }, [
          el("div", { class: "ledger__pattern" }, [svc.id]),
          el("div", { class: "ledger__meta" }, [
            svc.running
              ? `running · ${models.length} model${models.length === 1 ? "" : "s"} · ${svc.api === "ollama" ? "native api" : "openai-compat"}${isConfigured ? " · configured" : ""}`
              : (svc.error ?? "not running"),
          ]),
          ...(hint ? [el("div", { class: "ledger__meta" }, [hint])] : []),
        ]),
        add,
      ]));
    }
  }

  /** Profile chip: status dot, expiry, ordering, remove — material never shown.
   *  A button, because clicking it reorders or removes: a span made that
   *  keyboard-invisible. */
  #profileChip(p: any, provider: string, mine: any[]): HTMLElement {
    const state = p.ok ? "✔" : p.reason === "cooldown" ? "◌" : "✖";
    const chip = el(
      "button",
      {
        class: `chip${p.ok ? "" : " is-err"}`,
        type: "button",
        title: `${p.label || p.id}${p.reason ? ` — ${p.reason}` : ""} · fails ${p.failCount}`,
        "aria-label": `Move ${p.id} up, or remove it`,
      },
      [`${state} ${p.id}${p.expires ? ` (${p.expiresIn})` : ""}`],
    ) as HTMLButtonElement;
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
    const methodDd = this.#dropdown({
      id: "auth-method",
      value: methods[0] ?? "",
      label: "Method",
      placeholder: "— choose —",
      options: methods.map((m) => ({ value: m, label: m === "device-code" ? "device code (OAuth — approve in a browser)" : m.replace("-", " ") })),
    });
    const methodSel = methodDd.sel;
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
                el("p", { class: "code-display" }, [String(userCode)]),
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
            el("label", { class: "lbl", for: "auth-method-btn" }, ["Method"]),
            methodDd.node,
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

    this.#root.append(el("div", { class: "card" }, [
        el("div", { class: "prov__head models__detailhead" }, [
          el("span", { class: "prov__name" }, [provider]),
          el("div", { class: "prov__row" }, [back, refresh]),
        ]),
        el("div", { class: "prov__url" }, [providers[provider]?.baseUrl ?? ""]),
        el("p", { class: "hint" }, [
          "Checked models are in the system. Click a model to tune its capabilities.",
        ]),
        warning
          ? el("p", { class: "hint is-warn" }, [warning])
          : el("span", {}),
      ]));

    if (rows.length === 0) {
      this.#root.append(el("div", { class: "card" }, [
        el("p", { class: "hint" }, ["No models fetched from this provider yet — try Refresh."]),
      ]));
      return;
    }

    // Search box + one compact list (hairline rows), not one card per model.
    const list = el("div", { class: "list" });
    const renderRows = (): void => {
      list.innerHTML = "";
      const q = this.#modelQuery.trim().toLowerCase();
      const shown = rows.filter((ref) => !q || ref.toLowerCase().includes(q));
      if (shown.length === 0) {
        list.append(el("p", { class: "hint" }, [
          `No models match “${this.#modelQuery.trim()}”`,
        ]));
        return;
      }
      for (const ref of shown) {
        const entry = byRef.get(ref) as any;
        const on = Boolean(entry?.enabled);
        // Google's ids are "google/models/gemini-…", so the segment after the
        // provider is itself a constant ("models/") on every row — a fifth of the
        // width a phone can spare for the name. Only the label shortens: the stored
        // ref, the title and the tuner all keep the exact id.
        const tail = (ref.startsWith(`${provider}/`) ? ref.slice(provider.length + 1) : ref)
          .replace(/^models\//, "");
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

        // Named, because a page of identical "Tune" buttons says nothing to a
        // screen reader about which model it is about to open.
        const tuneLabel = entry ? "Tune" : "Configure";
        const tune = el("button", { class: "btn sm", type: "button", "aria-label": `${tuneLabel} ${tail}` }, [tuneLabel]);
        const openTune = () => this.#modelTune(ref, entry, hintCtx, () => void this.render());
        tune.onclick = openTune;

        // The name opens the tuner, so it is a button — a span with a click
        // handler would be invisible to the keyboard. A saved label shows here,
        // otherwise the popup's Label field would look like it did nothing: it
        // is what the chat model picker calls this model.
        const label = String(entry?.label ?? "").trim();
        const name = el("button", { class: label ? "pickrow__name" : "pickrow__name mono", type: "button", title: ref }, [label || tail]);
        name.onclick = openTune;

        list.append(el("div", { class: "pickrow" }, [
          check,
          name,
          el("span", { class: "pickrow__meta" }, [ctx ? `${Math.round(ctx / 1000)}k ctx` : ""]),
          tune,
        ]));
      }
    };
    renderRows();

    search.oninput = () => {
      this.#modelQuery = search.value;
      renderRows();
    };

    this.#root.append(
      el("div", { class: "card" }, [
        el("label", { class: "lbl", for: "model-search" }, [`Search ${rows.length} fetched models`]),
        search,
      ]),
      el("div", { class: "card card--flush" }, [list]),
    );
  }

  /** Capabilities popup for one fetched model.
   *
   *  Two promises it has to keep, because both were once broken here: a blank
   *  field must really be blank afterwards (temperature is sent as an explicit
   *  null, which the gateway treats as "delete the override"), and editing a
   *  model must never change whether it is in the system — only a new model is
   *  selected on save, which is what "Save & select" says. */
  #modelTune(ref: string, existing: any | null, hintCtx: number | undefined, done: () => void): void {
    let close: () => void = () => {};
    let saving = false;
    const field = (name: string, label: string, value: string, placeholder: string, type = "text") => {
      const input = el("input", {
        id: `f-${name}`, class: "inp mono", type, value, placeholder,
        autocomplete: "off", spellcheck: "false", step: type === "number" ? "any" : undefined,
      }) as HTMLInputElement;
      return { input, wrap: el("div", { class: "modal__field" }, [el("label", { class: "lbl", for: `f-${name}` }, [label]), input]) };
    };
    const labelF = field("label", "Label (optional)", existing?.label ?? "", ref.split("/").slice(1).join("/"));
    // The field shows what is *stored*. A provider hint is a starting point, not
    // a saved value: prefilling it on an existing row would silently turn
    // "unknown" into a number the next time anything else was edited.
    const storedCtx = typeof existing?.contextWindow === "number" && existing.contextWindow > 0 ? String(existing.contextWindow) : "";
    const ctxF = field("contextWindow", "Context window (tokens)", storedCtx || (existing ? "" : hintCtx ? String(hintCtx) : ""), "unknown");
    // This is the only place a context window is entered, and it is the number the
    // history budget and the compaction trigger are derived from — say so here
    // rather than in a Settings page that no longer has a field of its own.
    ctxF.wrap.append(el("p", { class: "hint" }, [
      "Drives the history budget (about 70% of it, in characters) and when compaction starts. Blank = the provider's published figure when there is one, otherwise unknown.",
    ]));
    const maxF = field("maxTokens", "Max output tokens (0 = provider default)", existing?.maxTokens ? String(existing.maxTokens) : "0", "0", "number");
    const tempF = field("temperature", "Temperature (blank = provider default)", typeof existing?.temperature === "number" ? String(existing.temperature) : "", "0.7", "number");
    const problem = el("p", { class: "hint hint--err", role: "alert", hidden: "" }, []);

    const effortDd = this.#dropdown({
      id: "f-effort",
      value: existing?.reasoningEffort ?? "inherit",
      label: "Default thinking",
      placeholder: "— choose —",
      options: ["inherit", "off", "low", "medium", "high", "xhigh", "max"].map((v) => ({ value: v, label: v })),
    });
    const effortSel = effortDd.sel;
    // Editing keeps the row's switch; only a model that is not in the system yet
    // is added to it. Tune is not a place where models come back from the dead.
    const willEnable = existing && typeof existing.enabled === "boolean" ? existing.enabled : true;
    const confirmText = existing ? "Save" : "Save & select";

    modal({
      title: ref,
      confirmLabel: confirmText,
      render: (body, c) => {
        close = c;
        body.append(
          labelF.wrap, ctxF.wrap, maxF.wrap, tempF.wrap,
          el("div", { class: "modal__field" }, [
            el("label", { class: "lbl", for: "f-effort-btn" }, ["Default thinking"]),
            effortDd.node,
            el("p", { class: "hint" }, ["Per-model default; a session thinking choice still overrides it."]),
          ]),
          problem,
          existing
            ? (() => {
                const rm = el("button", { class: "btn danger", type: "button" }, ["Remove from system"]);
                rm.onclick = async () => {
                  if (saving) return;
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
        if (saving) return;
        // Blank means "no override"; anything else has to be a number a provider
        // can accept. A typo used to become 0 (or the provider's figure) with a
        // "saved" toast, which is the quietest way to lose what someone typed.
        const bad: { name: string; input: HTMLInputElement }[] = [];
        const readNumber = (f: { input: HTMLInputElement }, name: string, whole: boolean): number | null => {
          const input = f.input;
          input.removeAttribute("aria-invalid");
          const raw = input.value.trim();
          if (raw === "") return null;
          const n = Number(raw);
          if (!Number.isFinite(n) || n < 0) {
            input.setAttribute("aria-invalid", "true");
            bad.push({ name, input });
            return null;
          }
          return whole ? Math.round(n) : n;
        };
        const ctx = readNumber(ctxF, "context window", true);
        const max = readNumber(maxF, "max output tokens", true);
        const temp = readNumber(tempF, "temperature", false);
        if (bad.length) {
          problem.textContent = `Not saved — ${bad.map((b) => b.name).join(" and ")} must be a number, 0 or more, or blank.`;
          problem.removeAttribute("hidden");
          bad[0]?.input.focus();
          return;
        }
        problem.textContent = "";
        problem.setAttribute("hidden", "");

        const payload: Record<string, unknown> = {
          id: existing?.id,
          ref,
          label: labelF.input.value.trim(),
          contextWindow: ctx ?? hintCtx ?? 0,
          maxTokens: max ?? 0,
          // null, not absent: the gateway reads absent as "keep the last value"
          // (that is what the row checkbox relies on) and null as "clear it".
          temperature: temp,
          reasoningEffort: effortSel.value,
          enabled: willEnable,
        };
        saving = true;
        const okBtn = (document.getElementById("modal-foot") as HTMLElement | null)?.querySelector<HTMLButtonElement>(".btn.pri") ?? null;
        if (okBtn) {
          okBtn.disabled = true;
          okBtn.textContent = "Saving…";
        }
        try {
          await gateway.request("models.save", payload);
          toast(existing ? (willEnable ? "saved" : "saved — still switched off") : `${ref} saved & selected`, "ok");
          close();
          done();
        } catch (err) {
          saving = false;
          if (okBtn) {
            okBtn.disabled = false;
            okBtn.textContent = confirmText;
          }
          toast((err as Error).message, "err");
        }
      },
    });
  }

  /* ---------------- providers ---------------- */

  /** Provider auth & connectivity buttons (P4 #44 — their Connect provider:
   *  one-tap device-code sign-in, credential probe, connection test). All
   *  three surface the gateway's own verdict text — no client-side guesses. */
  #providerAuthButtons(name: string): HTMLElement[] {
    // Every provider card carries the same five buttons, so each one is named
    // with the provider it acts on — "Test" alone says nothing on card four.
    const test = el("button", { class: "btn", type: "button", id: `prov-test-${name}`, title: "providers.test", "aria-label": `Test ${name}` }, ["Test"]) as HTMLButtonElement;
    test.onclick = async () => {
      test.disabled = true;
      try {
        const res = (await gateway.request("providers.test", { name })) as { ok: boolean; message?: string };
        toast(`${name}: ${res.ok ? "connection ok" : "failed"}${res.message ? ` — ${res.message}` : ""}`, res.ok ? "ok" : "err");
      } catch (err) {
        toast((err as Error).message, "err");
      } finally {
        test.disabled = false;
      }
    };

    const probe = el("button", { class: "btn", type: "button", id: `prov-probe-${name}`, title: "models.auth.probe", "aria-label": `Probe ${name}` }, ["Probe"]) as HTMLButtonElement;
    probe.onclick = async () => {
      probe.disabled = true;
      try {
        const res = (await gateway.request("models.auth.probe", { provider: name })) as any;
        const report = res.probe;
        const healthy = Number(report?.healthy ?? report?.okCount ?? 0);
        const total = Number(report?.total ?? 0);
        const stale = Number(report?.stale ?? 0);
        const dead = Number(report?.dead ?? 0);
        toast(
          total > 0
            ? `probe ${name}: ${healthy}/${total} healthy${stale ? ` · ${stale} stale` : ""}${dead ? ` · ${dead} dead` : ""}`
            : `probe ${name}: canonical credential ${report?.canonicalOk ? "reachable" : "unusable"}`,
          dead > 0 || report?.canonicalOk === false ? "err" : "ok",
        );
      } catch (err) {
        toast((err as Error).message, "err");
      } finally {
        probe.disabled = false;
      }
    };

    const signin = el("button", { class: "btn pri", type: "button", id: `prov-signin-${name}`, title: "OAuth device code", "aria-label": `Sign in to ${name}` }, ["Sign in"]) as HTMLButtonElement;
    signin.onclick = () => void this.#deviceCodeFlow(name);
    return [signin, probe, test];
  }

  /** Device-code login (P4 #44): begin → show the code + verification URL →
   *  poll until done / cancel — exactly their Connect-provider card flow. */
  async #deviceCodeFlow(name: string): Promise<void> {
    let start: any;
    try {
      start = await gateway.request("models.auth.beginDeviceCode", { provider: name });
    } catch (err) {
      toast((err as Error).message, "err");
      return;
    }
    // A provider without a device flow answers ok:false rather than failing the
    // request — opening the code dialog anyway showed "—" for 90 poll intervals.
    if (start?.ok === false || start?.error) {
      toast(String(start.error ?? `device login is not available for ${name}`), "err");
      return;
    }
    const flow = String(start.flow ?? "");
    const code = String(start.userCode ?? start.user_code ?? "—");
    const uri = String(start.verificationUri ?? start.verification_url ?? "");
    const statusEl = el("p", { class: "hint" }, ["Waiting for the sign-in to complete…"]);
    const codeBox = el("div", { class: "device-code mono", id: `device-code-${name}` }, [code]);
    const link = uri ? el("a", { href: uri, target: "_blank", rel: "noreferrer" }, [uri]) : null;
    const close = modal({
      title: `Sign in: ${name}`,
      body: el("div", {}, [
        el("p", {}, ["Enter this code at the provider's activation page:"]),
        codeBox,
        ...(link ? [el("p", {}, [link])] : []),
        statusEl,
      ]),
      confirmLabel: "",
      cancelLabel: "Cancel",
    });
    // Poll on an interval until the flow completes, expires, or the modal is
    // closed — the RPC reports done/error itself.
    const tick = async (): Promise<boolean> => {
      try {
        const res = (await gateway.request("models.auth.pollDeviceCode", { flow, setDefault: true })) as any;
        if (res.done === true || res.status === "done" || res.ok === true) {
          statusEl.textContent = `signed in — credential stored for ${name}. Thank you!`;
          toast(`signed in: ${name}`, "ok");
          void this.render();
          return true;
        }
        if (res.error || res.status === "error" || res.status === "expired") {
          statusEl.textContent = `sign-in failed: ${res.error ?? res.status}`;
          return true;
        }
        statusEl.textContent = "Waiting for the sign-in to complete…";
        return false;
      } catch (err) {
        statusEl.textContent = `poll failed: ${(err as Error).message}`;
        return true;
      }
    };
    for (let i = 0; i < 90; i++) {
      await new Promise((r) => setTimeout(r, 2500));
      if (document.getElementById("modal-overlay")!.hidden) { close(); return; } // cancelled
      if (await tick()) return;
    }
    statusEl.textContent = "Timed out waiting for the sign-in — try again.";
  }

  #renderProviders(providers: Record<string, Provider>, config: any, auth: any[] = []): void {
    this.#root.append(el("div", { class: "card setcard" }, [
      el("div", { class: "setcard__head" }, [
        el("h3", {}, ["Providers"]),
        el("p", { class: "hint" }, ["Base URLs and credentials for each endpoint. Test and probe a provider before relying on it."]),
      ]),
    ]));
    // Sorted like every other list in Settings: this is the page where you come
    // looking for one provider by name, and insertion order gives no hints.
    for (const [name, p] of Object.entries(providers).sort(([a], [b]) => a.localeCompare(b))) {
      const edit = el("button", { class: "btn", type: "button", "aria-label": `Edit ${name}` }, ["Edit"]);
      edit.onclick = () => this.#providerForm(name, providers, () => void this.render());
      const remove = el("button", { class: "btn danger", type: "button", "aria-label": `Remove ${name}` }, ["Remove"]);
      remove.onclick = () => this.#removeProvider(name, providers, config, auth, () => void this.render());

      this.#root.append(el("div", { class: "card" }, [
        el("div", { class: "prov" }, [
          el("div", { class: "prov__head" }, [
            el("span", { class: "prov__name" }, [name]),
            el("span", { class: "prov__count" }, [`${(p.models ?? []).length} models`]),
          ]),
          el("div", { class: "prov__url" }, [p.baseUrl ?? ""]),
          el("div", { class: "prov__key" }, [maskKey(p.apiKey ?? "")]),
          el("div", { class: "prov__row" }, [...this.#providerAuthButtons(name), edit, remove]),
        ]),
      ]));
    }

    const plus = el("span");
    plus.innerHTML = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
    const add = el("button", { class: "btn pri", type: "button" }, [plus, "Add provider"]);
    add.onclick = () => this.#providerForm(null, providers, () => void this.render());

    this.#root.append(el("div", { class: "card setcard" }, [
      el("div", { class: "setcard__head" }, [
        el("h3", {}, ["Add a provider"]),
        el("p", { class: "hint" }, ["Custom endpoint: base URL + API key (or sign in via a provider plugin above)."]),
      ]),
      el("div", { class: "setfoot" }, [add]),
    ]));
  }

  /* ---------------- skills ---------------- */

  #renderSkills(skills: any[]): void {
    const body = el("div", { class: "settings__stack" });
    // One panel for the whole catalog: these are peers of each other, not a
    // stack of separate things to configure.
    const card = el("div", { class: "card" }, [
      el("h3", {}, ["Skills"]),
      el("p", { class: "hint" }, [
        "Instruction packs the agent can load (SKILL.md + frontmatter). The agent can also save new skills itself with the skill_save tool. Workspace entries shadow state and bundled ones of the same name.",
      ]),
    ]);

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
                el("pre", { class: "codeblock" }, [String(res.body ?? "")]),
              ]),
              confirmLabel: "",
            });
          } catch (err) {
            toast((err as Error).message, "err");
          }
        })();
      };

      const badge = el("span", { class: `settings__tag${s.eligible ? " is-ok" : " is-warn"}` }, [
        s.eligible ? "available" : `unavailable${s.reason ? ` — ${s.reason}` : ""}`,
      ]);
      card.append(el("div", { class: "prov" }, [
        el("div", { class: "prov__head" }, [
          el("span", { class: "prov__name mono" }, [s.name]),
          el("span", { class: "prov__count" }, [s.root]),
        ]),
        el("div", { class: "prov__url" }, [s.description || "(no description)"]),
        el("div", { class: "prov__row" }, [badge, open]),
      ]));
    }

    const plus = el("span");
    plus.innerHTML = '<svg aria-hidden="true" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
    const add = el("button", { class: "btn pri", type: "button" }, [plus, "Add skill"]);
    add.onclick = () => this.#skillForm(() => void this.render());
    card.append(el("div", { class: "setfoot" }, [add]));

    body.append(card);
    this.#root.append(body);
  }

  #skillForm(done: () => void): void {
    let close: () => void = () => {};
    const name = el("input", { class: "inp mono", id: "f-skill-name", placeholder: "my-skill", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
    const desc = el("input", { class: "inp", id: "f-skill-desc", placeholder: "What it does and when to use it", autocomplete: "off" }) as HTMLInputElement;
    const content = el("textarea", {
      class: "inp mono", id: "f-skill-body", rows: "12",
      placeholder: "The skill instructions in Markdown",
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

  /* ---------------- tools: web search ---------------- */

  /** Small field/cell builders shared by the tools config cards (P4 #38). */
  #cfgField(id: string, label: string, input: HTMLInputElement | HTMLSelectElement, hint?: string): HTMLElement {
    return el("div", { class: "modal__field" }, [
      el("label", { class: "lbl", for: id }, [label]),
      input,
      ...(hint ? [el("span", { class: "hint" }, [hint])] : []),
    ]);
  }
  #cfgNum(id: string, label: string, cur: number, hint?: string): { input: HTMLInputElement; node: HTMLElement } {
    const input = el("input", { class: "inp mono", id, value: String(cur), autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
    return { input, node: this.#cfgField(id, label, input, hint) };
  }
  #cfgStr(id: string, label: string, cur: string, placeholder = "", hint?: string): { input: HTMLInputElement; node: HTMLElement } {
    const input = el("input", { class: "inp mono", id, value: cur, placeholder, autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
    return { input, node: this.#cfgField(id, label, input, hint) };
  }
  #cfgCheck(id: string, label: string, cur: boolean): { input: HTMLInputElement; node: HTMLElement } {
    const input = el("input", { id, type: "checkbox" }) as HTMLInputElement;
    input.checked = cur;
    return { input, node: el("div", { class: "row" }, [el("span", { class: "row__label" }, [label]), input]) };
  }

  /** Exec & approvals (P4 #38 — their tools.exec page + their approvals
   *  ledger). ONE section with ONE draft and ONE atomic write.
   *
   *  It used to be two cards, and `mode`, `askFallback` and `strictInlineEval`
   *  lived in both: instant RPCs in one, staged behind a Save in the other. The
   *  same setting could be live in one card and stale in the other, presets
   *  rewrote fields someone was editing, and the "Save" fired eleven separate
   *  config.set frames so a rejected value left the policy half applied.
   *
   *  Grants are the exception: they live in the approvals ledger (sqlite), not
   *  in config, so adding and revoking stay immediate — there is nothing to
   *  stage when a decision is remembered the moment you make it. */
  async #execCard(config: any): Promise<HTMLElement> {
    const x = config.tools?.exec ?? {};
    let st: any = null;
    let stError = "";
    try {
      st = await gateway.request("approvals.get");
    } catch (err) {
      // The policy comes from config, so losing this RPC must not take the
      // whole section down with it — only the grants list.
      stError = (err as Error).message;
    }
    const entries: any[] = Array.isArray(st?.entries) ? st.entries : [];
    const effMode = String(st?.mode ?? (x.approvals === false ? "full" : "ask"));
    const MODE_TEXT: Record<string, string> = {
      deny: "Refuses every shell command.",
      allowlist: "Runs only allowlisted commands and safe bins; everything else is refused.",
      ask: "Anything not on the allowlist asks you first. This is the default.",
      full: "Runs anything without asking. Only on a machine you would hand a shell to.",
    };

    /* ---- draft: every policy control stages here, Save applies the lot ---- */

    let modeValue = String(x.mode ?? "");
    const mark = (): void => this.#dirtyMark(note);
    const note = el("span", { class: "setfoot__note", "aria-live": "polite" }, []);

    const enabledCb = el("input", { type: "checkbox", id: "exec-enabled" }) as HTMLInputElement;
    enabledCb.checked = Boolean(x.enabled);

    // The status line reads the draft, not the stored config, so it answers
    // "what happens if I save this?" while the radio is still being moved.
    const statusTag = el("span", { class: "settings__tag" });
    const statusNote = el("span", { class: "setcard__status-note", "aria-live": "polite" });
    const enabledHint = el("span", { class: "hint" });
    const draftMode = (): string => modeValue || (legacyCb.checked ? "ask" : "full");
    const syncStatus = (): void => {
      const on = enabledCb.checked;
      const mode = draftMode();
      statusTag.textContent = on ? `mode ${mode}` : "exec off";
      statusTag.className = `settings__tag${on && mode !== "deny" ? " is-ok" : " is-warn"}`;
      statusNote.textContent = on
        ? MODE_TEXT[mode] ?? MODE_TEXT["ask"]!
        : "The agent has no shell tool while this is off.";
      enabledHint.textContent = on
        ? "Registered: the agent can ask to run commands on this machine."
        : "Off: the tool is not registered at all, so nothing below has any effect until you switch it on and save.";
    };
    enabledCb.onchange = () => { syncStatus(); mark(); };

    const modeRadios = new Map<string, HTMLInputElement>();
    const modeGroup = el("div", { class: "setcard__modes", role: "radiogroup", "aria-label": "Exec mode" });
    const modeRowOf = new Map<string, HTMLElement>();
    const syncMode = (): void => {
      for (const [value, row] of modeRowOf) row.classList.toggle("is-on", value === modeValue);
      legacyRow.hidden = modeValue !== "";
      for (const [value, radio] of modeRadios) radio.checked = value === modeValue;
    };
    const pickMode = (value: string): void => {
      modeValue = value;
      syncMode();
      syncStatus();
    };
    const MODES: { value: string; label: string; text: string }[] = [
      { value: "deny", label: "deny", text: MODE_TEXT["deny"]! },
      { value: "allowlist", label: "allowlist", text: MODE_TEXT["allowlist"]! },
      { value: "ask", label: "ask", text: MODE_TEXT["ask"]! },
      { value: "full", label: "full", text: MODE_TEXT["full"]! },
      { value: "", label: "follow the legacy approvals switch", text: "Legacy: switch on = ask, off = full. Kept so older configs keep working." },
    ];
    for (const m of MODES) {
      const id = `exec-mode-${m.value || "legacy"}`;
      const radio = el("input", { type: "radio", name: "exec-mode", id, value: m.value, "aria-describedby": `${id}-desc` }) as HTMLInputElement;
      radio.checked = modeValue === m.value;
      radio.onchange = () => {
        if (!radio.checked) return;
        pickMode(m.value);
        mark();
      };
      modeRadios.set(m.value, radio);
      const row = el("div", { class: "setcard__mode" }, [
        el("div", { class: "setcard__mode-main" }, [
          el("label", { class: "setcard__mode-label", for: id }, [m.label]),
          el("span", { class: "hint", id: `${id}-desc` }, [m.text]),
        ]),
        radio,
      ]);
      row.dataset["mode"] = m.value;
      modeRowOf.set(m.value, row);
      modeGroup.append(row);
    }

    const legacyCb = el("input", { type: "checkbox", id: "exec-approvals" }) as HTMLInputElement;
    legacyCb.checked = x.approvals !== false;
    legacyCb.onchange = () => { syncStatus(); mark(); };
    const legacyRow = el("div", { class: "row exec__legacy" }, [
      el("div", { class: "row__main" }, [
        el("label", { class: "row__label", for: "exec-approvals" }, ["Legacy approvals switch"]),
        el("span", { class: "hint" }, ["Only read while the mode above follows it: on = ask, off = full."]),
      ]),
      legacyCb,
    ]);

    const strictCb = el("input", { type: "checkbox", id: "exec-strict-inline" }) as HTMLInputElement;
    strictCb.checked = Boolean(x.strictInlineEval);
    strictCb.onchange = mark;
    const strictRow = el("div", { class: "row" }, [
      el("div", { class: "row__main" }, [
        el("label", { class: "row__label", for: "exec-strict-inline" }, ["Never auto-allow inline eval"]),
        el("span", { class: "hint" }, ["node -e, bash -c, awk, sed, make, xargs and find -exec always need a real approval."]),
      ]),
      strictCb,
    ]);

    const askDd = this.#dropdown({
      id: "exec-ask-fallback",
      value: String(x.askFallback ?? "deny"),
      label: "Fallback for an unseen prompt",
      placeholder: "choose…",
      options: [
        { value: "deny", label: "refuse it — and say so (default)" },
        { value: "allowlist", label: "run it only if it is a safe bin" },
        { value: "full", label: "run it anyway" },
      ],
    });
    const unatDd = this.#dropdown({
      id: "exec-unattended",
      value: String(x.unattended ?? "deny"),
      label: "Runs with nobody watching",
      placeholder: "choose…",
      options: [
        { value: "deny", label: "refuse it — and say so (default)" },
        { value: "allowlist", label: "run it only if it is a safe bin" },
        { value: "all", label: "run anything" },
      ],
    });
    askDd.sel.addEventListener("change", mark);
    unatDd.sel.addEventListener("change", mark);

    const timeoutInp = el("input", {
      class: "inp mono", id: "exec-timeout", inputmode: "numeric", autocomplete: "off", spellcheck: "false",
      value: String(Number(x.timeoutMs ?? 600000)),
    }) as HTMLInputElement;
    const timeoutEcho = el("span", { class: "setcard__echo", "aria-live": "polite" }, []);
    const syncEcho = (): void => {
      const n = Number(timeoutInp.value.trim());
      timeoutEcho.textContent = Number.isFinite(n) && n >= 1000 ? `≈ ${Math.round((n / 60000) * 10) / 10} min` : "";
    };
    timeoutInp.oninput = () => { syncEcho(); mark(); };
    syncEcho();

    let sandbox = String(x.sandbox ?? "") === "strict" ? "strict" : "off";
    const sandboxBtns = new Map<string, HTMLButtonElement>();
    const sandboxSeg = el("div", { class: "seg", role: "group", "aria-label": "Sandbox" });
    for (const opt of [
      { value: "off", label: "off", title: "Plain: the command inherits this process's environment." },
      { value: "strict", label: "strict", title: "strict (scrubbed env + prlimit caps)" },
    ]) {
      const b = el("button", { class: "seg__btn", type: "button", "aria-pressed": String(sandbox === opt.value), title: opt.title }, [opt.label]) as HTMLButtonElement;
      b.onclick = () => {
        sandbox = opt.value;
        syncSandbox();
        mark();
      };
      sandboxBtns.set(opt.value, b);
      sandboxSeg.append(b);
    }
    const prootCb = el("input", { type: "checkbox", id: "exec-proot" }) as HTMLInputElement;
    prootCb.checked = Boolean(x.sandboxProot);
    prootCb.onchange = mark;
    const prootRow = el("div", { class: "row" }, [
      el("div", { class: "row__main" }, [
        el("label", { class: "row__label", for: "exec-proot" }, ["Proot filesystem jail"]),
        el("span", { class: "hint" }, ["Needs the strict sandbox and a proot binary (Termux). Ignored otherwise."]),
      ]),
      prootCb,
    ]);
    function syncSandbox(): void {
      for (const [value, b] of sandboxBtns) b.setAttribute("aria-pressed", String(sandbox === value));
      prootCb.disabled = sandbox !== "strict";
      prootRow.classList.toggle("is-off", sandbox !== "strict");
    }

    // Only these bins have a stdin-only profile in the evaluator. A name that
    // is not on this list does nothing at all — which is exactly the trap the
    // old free-text box set, so the list is the control now.
    const SAFE_BINS = ["cut", "uniq", "head", "tail", "tr", "wc"];
    const bins = new Set<string>((Array.isArray(x.safeBins) ? x.safeBins : []).map(String));
    const binsWrap = el("div", { class: "seg seg--wrap", role: "group", "aria-label": "Safe bins" });
    const binChip = (bin: string, supported: boolean): HTMLButtonElement => {
      const b = el("button", {
        class: `seg__btn${supported ? "" : " is-off"}`,
        type: "button",
        id: `exec-bin-${bin}`,
        "aria-pressed": String(bins.has(bin)),
        title: supported ? `${bin} may run without asking when its argv is a stdin-only shape` : `${bin} has no stdin-only profile — this name does nothing`,
      }, [bin]) as HTMLButtonElement;
      b.onclick = () => {
        if (bins.has(bin)) bins.delete(bin);
        else bins.add(bin);
        b.setAttribute("aria-pressed", String(bins.has(bin)));
        mark();
      };
      return b;
    };
    for (const bin of SAFE_BINS) binsWrap.append(binChip(bin, true));
    for (const bin of [...bins].filter((b) => !SAFE_BINS.includes(b))) binsWrap.append(binChip(bin, false));

    const dirsInp = el("input", {
      class: "inp mono", id: "exec-trusted-dirs", autocomplete: "off", spellcheck: "false",
      value: (Array.isArray(x.safeBinTrustedDirs) ? x.safeBinTrustedDirs : []).join(", "),
      placeholder: "/bin, /usr/bin",
    }) as HTMLInputElement;
    dirsInp.oninput = mark;

    const problem = el("p", { class: "hint hint--err", role: "alert", hidden: "" }, []);
    const save = el("button", { class: "btn pri", type: "button", id: "exec-policy-save" }, ["Save exec policy"]) as HTMLButtonElement;
    let saving = false;
    save.onclick = async () => {
      if (saving) return;
      problem.textContent = "";
      problem.setAttribute("hidden", "");
      timeoutInp.removeAttribute("aria-invalid");
      const timeoutRaw = timeoutInp.value.trim();
      const timeoutMs = Number(timeoutRaw);
      // Refuse, never clamp: silently turning 50 ms into 1000 is how a policy
      // setting becomes a lie.
      if (!timeoutRaw || !Number.isFinite(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) {
        timeoutInp.setAttribute("aria-invalid", "true");
        problem.textContent = "Not saved — the timeout has to be between 1000 and 600000 ms.";
        problem.removeAttribute("hidden");
        timeoutInp.focus();
        return;
      }
      const chosen = [...modeRadios.entries()].find(([, radio]) => radio.checked)?.[0] ?? "";
      // One write for the whole block, merged over what is stored so a key this
      // page does not render survives a save.
      const block: Record<string, unknown> = {
        ...structuredClone(x),
        enabled: enabledCb.checked,
        approvals: legacyCb.checked,
        mode: /^(deny|allowlist|ask|full)$/.test(chosen) ? chosen : "",
        askFallback: this.#selValue(askDd.sel),
        strictInlineEval: strictCb.checked,
        safeBins: [...bins],
        safeBinTrustedDirs: dirsInp.value.split(",").map((v) => v.trim()).filter(Boolean),
        timeoutMs: Math.round(timeoutMs),
        sandbox,
        sandboxProot: prootCb.checked,
        unattended: this.#selValue(unatDd.sel),
      };
      saving = true;
      save.disabled = true;
      save.textContent = "Saving…";
      try {
        await gateway.request("config.set", { path: "tools.exec", value: block });
        clearDirty();
        toast("exec policy saved — applies to the next tool call", "ok");
        this.#onChanged();
        void this.render();
      } catch (err) {
        problem.textContent = `not saved — ${(err as Error).message}`;
        problem.removeAttribute("hidden");
        toast(`not saved — ${(err as Error).message}`, "err");
      } finally {
        saving = false;
        save.disabled = false;
        save.textContent = "Save exec policy";
      }
    };

    /* ---- grants: the approvals ledger (immediate, its own RPCs) ---- */

    const ago = (ts?: number): string => {
      if (!ts) return "never used";
      const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
      return m < 1 ? "used <1m ago" : m < 60 ? `used ${m}m ago` : m < 1440 ? `used ${Math.round(m / 60)}h ago` : `used ${Math.round(m / 1440)}d ago`;
    };
    const shortDir = (dir: string): string => String(dir || "?").replace(/^\/data\/data\/com\.termux\/files\/home/, "~").replace(/^\/home\/[^/]+/, "~");

    const grantRow = (e: any): HTMLElement => {
      const always = e.source === "allow-always";
      const cmd = String(e.lastUsedCommand ?? e.command ?? "");
      const meta = always
        ? [`exact command`, `in ${shortDir(e.cwd)}`, ago(e.lastUsedAt)].join(" · ")
        : [e.argPattern ? `argv /${e.argPattern}/` : "name or path match", ago(e.lastUsedAt), e.lastResolvedPath ? String(e.lastResolvedPath) : null].filter(Boolean).join(" · ");
      const revoke = el("button", {
        class: "btn sm danger", type: "button", "aria-label": `Revoke ${e.pattern}`,
      }, ["Revoke"]) as HTMLButtonElement;
      let armed = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const disarm = (): void => {
        armed = false;
        if (timer) clearTimeout(timer);
        timer = null;
        revoke.textContent = "Revoke";
        revoke.classList.remove("is-warn");
      };
      revoke.onclick = async () => {
        // Revoking a grant is a security decision: one click arms, the second
        // one acts, and the arm expires on its own.
        if (!armed) {
          armed = true;
          revoke.textContent = "Confirm revoke";
          revoke.classList.add("is-warn");
          timer = setTimeout(disarm, 4000);
          return;
        }
        disarm();
        revoke.disabled = true;
        try {
          await gateway.request("approvals.entry.revoke", { id: e.id });
          toast("grant revoked", "ok");
          void this.render();
        } catch (err) {
          toast((err as Error).message, "err");
          revoke.disabled = false;
        }
      };
      const main = el("div", { class: "ledger__main" }, [
        el("div", { class: "ledger__pattern", title: String(e.pattern) }, [String(e.pattern)]),
        el("div", { class: "ledger__meta" }, [meta]),
        ...(cmd ? [el("div", { class: "exec__cmd", title: cmd }, [`$ ${cmd}`])] : []),
      ]);
      return el("div", { class: "ledger__row" }, [
        main,
        el("span", { class: `settings__tag${always ? " is-warn" : ""}` }, [always ? "always" : "manual"]),
        revoke,
      ]);
    };

    const list = el("div", { class: "ledger" });
    const renderRows = (): void => {
      list.innerHTML = "";
      const q = this.#execQuery.trim().toLowerCase();
      const shown = entries.filter((e) => !q || [e.pattern, e.argPattern, e.lastUsedCommand, e.command]
        .some((v) => String(v ?? "").toLowerCase().includes(q)));
      if (shown.length === 0) {
        list.append(el("p", { class: "hint" }, [
          entries.length === 0
            ? effMode === "full"
              ? "No grants — full mode does not need any; every command already runs."
              : "No grants yet. Anything that is not a safe bin asks first."
            : "No grants match the search.",
        ]));
        return;
      }
      for (const e of shown) list.append(grantRow(e));
    };
    renderRows();
    const search = el("input", {
      class: "inp", id: "exec-grant-search", placeholder: "Search grants — pattern, command, regex…",
      value: this.#execQuery, autocomplete: "off", spellcheck: "false",
    }) as HTMLInputElement;
    search.oninput = () => {
      this.#execQuery = search.value;
      renderRows();
    };

    const patternInp = el("input", { class: "inp mono", id: "exec-grant-pattern", placeholder: "rg, /opt/homebrew/bin/rg or ~/.local/bin/*", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
    const argInp = el("input", { class: "inp mono", id: "exec-grant-argv", placeholder: "argv regex (optional), e.g. ^safe\\.py$", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
    const addProblem = el("p", { class: "hint hint--err", role: "alert", hidden: "" }, []);
    const addBtn = el("button", { class: "btn", type: "button", id: "exec-grant-add" }, ["Add grant"]) as HTMLButtonElement;
    addBtn.onclick = async () => {
      addProblem.textContent = "";
      addProblem.setAttribute("hidden", "");
      if (!patternInp.value.trim()) {
        addProblem.textContent = "A pattern is required — a binary name, a path, or a glob.";
        addProblem.removeAttribute("hidden");
        patternInp.focus();
        return;
      }
      addBtn.disabled = true;
      try {
        await gateway.request("approvals.entry.add", {
          pattern: patternInp.value.trim(),
          argPattern: argInp.value.trim() || undefined,
        });
        patternInp.value = "";
        argInp.value = "";
        toast("grant added", "ok");
        void this.render();
      } catch (err) {
        addProblem.textContent = (err as Error).message;
        addProblem.removeAttribute("hidden");
      } finally {
        addBtn.disabled = false;
      }
    };

    /* ---- assembly ---- */

    const modeSection = el("div", { class: "setsec" }, [
      el("div", { class: "setsec__head" }, [
        el("span", { class: "cap" }, ["Mode"]),
        el("span", { class: "setsec__count" }, ["4 modes + legacy"]),
      ]),
      modeGroup,
      legacyRow,
      el("div", { class: "settings__inline exec__presets" }, [
        el("span", { class: "cap" }, ["Start from"]),
        (() => {
          const b = el("button", { class: "btn sm", type: "button", id: "exec-preset-cautious", title: "ask + refuse when nobody can answer" }, ["Cautious"]);
          b.onclick = () => { pickMode("ask"); askDd.set("deny"); mark(); };
          return b;
        })(),
        (() => {
          const b = el("button", { class: "btn sm", type: "button", id: "exec-preset-deny", title: "deny + refuse" }, ["Deny all"]);
          b.onclick = () => { pickMode("deny"); askDd.set("deny"); mark(); };
          return b;
        })(),
        (() => {
          const b = el("button", { class: "btn sm is-warn", type: "button", id: "exec-preset-yolo", title: "full + run even unattended" }, ["YOLO"]);
          b.onclick = () => { pickMode("full"); askDd.set("full"); unatDd.set("all"); mark(); };
          return b;
        })(),
      ]),
      strictRow,
    ]);

    const fallbackSection = el("div", { class: "setsec" }, [
      el("div", { class: "setsec__head" }, [
        el("span", { class: "cap" }, ["When nobody can answer"]),
        el("span", { class: "setsec__count" }, ["2 rules"]),
      ]),
      this.#setField("exec-ask-fallback", "If a prompt cannot be shown (no UI connected)", askDd.node, undefined, null),
      this.#setField("exec-unattended", "Runs with nobody watching (cron jobs, webhooks)", unatDd.node,
        "every unattended auto-decision is audited — it is written to the log and the session transcript", null),
    ]);

    const limitsSection = el("div", { class: "setsec" }, [
      el("div", { class: "setsec__head" }, [
        el("span", { class: "cap" }, ["Limits & sandbox"]),
        el("span", { class: "setsec__count" }, ["3 settings"]),
      ]),
      el("div", { class: "setfield" }, [
        el("label", { class: "lbl", for: "exec-timeout" }, ["Timeout per command (ms)"]),
        el("div", { class: "setline" }, [timeoutInp, timeoutEcho]),
        el("p", { class: "hint" }, ["1000–600000. A safety cap only — a hung command cannot block a session forever."]),
      ]),
      el("div", { class: "setfield" }, [
        el("span", { class: "lbl" }, ["Sandbox"]),
        sandboxSeg,
        el("p", { class: "hint" }, ["Strict scrubs the environment, caps the process tree with prlimit, and — with the jail below — binds only the workspace read-write."]),
      ]),
      prootRow,
    ]);

    const safeBinsSection = el("div", { class: "setsec" }, [
      el("div", { class: "setsec__head" }, [
        el("span", { class: "cap" }, ["Safe bins"]),
        el("span", { class: "setsec__count" }, [`${[...bins].filter((b) => SAFE_BINS.includes(b)).length} of ${SAFE_BINS.length}`]),
      ]),
      binsWrap,
      el("p", { class: "hint" }, ["These run without asking when their arguments are a stdin-only shape (no file operands). Only the six above have a profile — any other name is ignored."]),
      el("div", { class: "setfield" }, [
        el("label", { class: "lbl", for: "exec-trusted-dirs" }, ["Trusted directories (comma separated)"]),
        dirsInp,
        el("p", { class: "hint" }, ["A safe bin must resolve inside one of these; /bin and /usr/bin by default."]),
      ]),
    ]);

    // Everything above is a draft: one zone, one Save, one write.
    const policyZone = el("div", { class: "exec__policy" }, [modeSection, fallbackSection, limitsSection, safeBinsSection]);
    const clearDirty = this.#dirtyWatch(policyZone, note);
    // Grants live outside the draft zone on purpose: revoking one applies
    // immediately, so it must never read as an unsaved policy change.
    syncMode();
    syncSandbox();
    syncStatus();

    const grantsSection = el("div", { class: "setsec exec-grants" }, [
      el("div", { class: "setsec__head" }, [
        el("span", { class: "cap" }, ["Grants"]),
        el("span", { class: "setsec__count" }, [`${entries.length} ${entries.length === 1 ? "grant" : "grants"}`]),
      ]),
      ...(stError
        ? [el("p", { class: "hint" }, [`Grants could not be read — ${stError}`])]
        : [
            search,
            list,
            el("div", { class: "exec__add" }, [
              el("span", { class: "lbl" }, ["Add a grant by hand"]),
              el("div", { class: "settings__inline" }, [patternInp, argInp, addBtn]),
              addProblem,
              el("p", { class: "hint" }, ["A bare name matches only commands found on PATH; a path or glob matches the resolved binary. The argv regex applies to the arguments after the binary."]),
            ]),
          ]),
    ]);

    return el("div", { class: "card exec-card" }, [
      el("div", { class: "setcard__head" }, [
        el("h3", {}, ["Exec & approvals"]),
        el("p", { class: "hint" }, [
          "How shell commands get authorized. Allowlisted commands and safe bins run without asking; anything else follows the mode. “Allow always” mints a grant for one exact command in one directory.",
        ]),
      ]),
      el("div", { class: "setcard__status" }, [statusTag, statusNote]),
      el("div", { class: "row exec__enabled" }, [
        el("div", { class: "row__main" }, [
          el("label", { class: "row__label", for: "exec-enabled" }, ["Exec tool"]),
          enabledHint,
        ]),
        enabledCb,
      ]),
      policyZone,
      grantsSection,
      el("div", { class: "setfoot" }, [note, problem, save]),
    ]);
  }

  /** Code Mode card (P4 #38 — their tools.codeMode): the model writes one JS
   *  cell per turn and calls tools inside it, instead of calling them one by one.
   *
   *  The card is written around one question the old one could not answer — "is it
   *  running right now?" — because "auto" silently depends on the model, and the
   *  only executor that works in this build is one of the two the schema accepts. */
  async #codeModeCard(config: any, tools: any[] = []): Promise<HTMLElement> {
    const x = config.tools?.codeMode ?? {};
    let st: any = null;
    let stError = "";
    try {
      st = await gateway.request("codeMode.get");
    } catch (err) {
      // Engagement is a read; the policy below comes from config, so losing the
      // RPC costs the status line and nothing else.
      stError = (err as Error).message;
    }

    // The catalog decides what a direct-only name can even refer to. When the RPC
    // failed, the page's own tools.list is the same list.
    const catalog: string[] = Array.isArray(st?.catalog)
      ? st.catalog.map(String)
      : tools.map((t) => String(t?.name ?? "")).filter((n) => n && n !== "exec" && n !== "wait");
    const preferred: string[] = Array.isArray(st?.preferred) ? st.preferred.map(String) : [];
    const model = String(st?.model ?? "");
    const preferredMatch = st?.preferredMatch === true;
    const matched = new Set<string>(Array.isArray(st?.preferredMatched) ? st.preferredMatched.map(String) : []);

    /* ---- draft ---- */

    let modeValue = ["false", "true", "auto"].includes(String(x.enabled ?? "")) ? String(x.enabled) : "auto";
    let executor = String(x.executor ?? "") === "quickjs" ? "quickjs" : "node";
    const note = el("span", { class: "setfoot__note", "aria-live": "polite" }, []);
    const mark = (): void => this.#dirtyMark(note);

    const statusTag = el("span", { class: "settings__tag" });
    const statusNote = el("span", { class: "setcard__status-note", "aria-live": "polite" });

    const direct = new Set<string>(
      (Array.isArray(x.directOnly) ? x.directOnly : []).map(String).filter(Boolean),
    );
    const hiddenCount = (): number => catalog.filter((n) => !direct.has(n)).length;

    const draftEngages = (): "yes" | "waiting" | "no" => {
      if (modeValue === "false") return "no";
      if (modeValue === "true") return "yes";
      return preferredMatch ? "yes" : "waiting";
    };
    const syncStatus = (): void => {
      const tone = (warn: boolean): void => { statusTag.className = `settings__tag${warn ? " is-warn" : " is-ok"}`; };
      if (stError) {
        // Not knowing is its own state: claiming "off" would be as wrong as claiming on.
        statusTag.textContent = "unknown";
        tone(true);
        statusNote.textContent = `Engagement could not be read — ${stError}. The policy below still saves.`;
        return;
      }
      const state = draftEngages();
      if (executor !== "node") {
        statusTag.textContent = "off — executor missing";
        tone(true);
        statusNote.textContent = "Every cell stops with executor_unavailable: node is the only executor bundled in this build.";
        return;
      }
      if (state === "no") {
        statusTag.textContent = "off";
        tone(true);
        statusNote.textContent = "The model calls tools one at a time, as it does today.";
        return;
      }
      if (state === "waiting") {
        statusTag.textContent = "on, waiting for a preferred model";
        tone(true);
        statusNote.textContent = model
          ? `auto engages only for the families listed below, and ${model} is not one of them — so no cell runs.`
          : "auto needs a default model on the list below; none is set yet, so no cell runs.";
        return;
      }
      statusTag.textContent = "engaged now";
      tone(false);
      statusNote.textContent = `The model sees only exec and wait; ${hiddenCount()} tool${hiddenCount() === 1 ? "" : "s"} become async globals inside the cell.`;
    };

    /* ---- mode ladder ---- */

    const MODES: { value: string; id: string; label: string; text: string }[] = [
      { value: "false", id: "cm-mode-off", label: "off", text: "Off — the model calls tools one at a time, as today." },
      { value: "auto", id: "cm-mode-auto", label: "auto (preferred models only)", text: "Auto — engages only for the model families listed below. This is the default." },
      { value: "true", id: "cm-mode-on", label: "always", text: "Always — engages for every model, including ones the list was not written for." },
    ];
    const modeRadios = new Map<string, HTMLInputElement>();
    const modeRows = new Map<string, HTMLElement>();
    const modeGroup = el("div", { class: "setcard__modes", role: "radiogroup", "aria-label": "When code mode runs" });
    const syncMode = (): void => {
      for (const [value, row] of modeRows) row.classList.toggle("is-on", value === modeValue);
      for (const [value, radio] of modeRadios) radio.checked = value === modeValue;
    };
    for (const m of MODES) {
      const radio = el("input", { type: "radio", name: "cm-mode", id: m.id, value: m.value, "aria-describedby": `${m.id}-desc` }) as HTMLInputElement;
      radio.checked = modeValue === m.value;
      radio.onchange = () => {
        if (!radio.checked) return;
        modeValue = m.value;
        syncMode();
        syncStatus();
        mark();
      };
      modeRadios.set(m.value, radio);
      const row = el("div", { class: "setcard__mode" }, [
        el("div", { class: "setcard__mode-main" }, [
          el("label", { class: "setcard__mode-label", for: m.id }, [m.label]),
          el("span", { class: "hint", id: `${m.id}-desc` }, [m.text]),
        ]),
        radio,
      ]);
      row.dataset["mode"] = m.value;
      modeRows.set(m.value, row);
      modeGroup.append(row);
    }

    // The families "auto" means. A dot on the ones the configured model matches,
    // so the rule is legible instead of implied.
    const families = el("div", { class: "setcard__tags", role: "group", "aria-label": "Preferred model families" },
      preferred.length
        ? preferred.map((label) => el("span", {
            class: `settings__tag${matched.has(label) ? " is-ok" : ""}`,
            title: matched.has(label) ? "your default model is one of these" : "",
          }, [label]))
        : [el("span", { class: "hint" }, ["the preferred family list could not be read"])]);

    /* ---- executor ---- */

    const executorSeg = el("div", { class: "seg", role: "group", "aria-label": "Executor" });
    const executorBtns = new Map<string, HTMLButtonElement>();
    for (const opt of [
      { value: "node", label: "node", title: "Bundled: a worker thread holds each cell." },
      { value: "quickjs", label: "quickjs", title: "Not bundled in this build — every cell stops instead of falling back." },
    ]) {
      const bundled = opt.value === "node";
      const b = el("button", {
        class: `seg__btn${bundled ? "" : " is-off"}`,
        type: "button",
        id: `cm-executor-${opt.value}`,
        "aria-pressed": String(executor === opt.value),
        title: opt.title,
      }, [opt.label]) as HTMLButtonElement;
      b.onclick = () => {
        executor = opt.value;
        syncExecutor();
        syncStatus();
        mark();
      };
      executorBtns.set(opt.value, b);
      executorSeg.append(b);
    }
    function syncExecutor(): void {
      for (const [value, b] of executorBtns) b.setAttribute("aria-pressed", String(executor === value));
    }

    /* ---- numbers: refuse, never clamp ---- */

    const number = (id: string, label: string, cur: number, hint: string): {
      input: HTMLInputElement; echo: HTMLElement; node: HTMLElement;
    } => {
      const input = el("input", {
        class: "inp mono", id, inputmode: "numeric", autocomplete: "off", spellcheck: "false",
        value: String(Number(cur)),
      }) as HTMLInputElement;
      const echo = el("span", { class: "setcard__echo", "aria-live": "polite" });
      input.oninput = () => { syncEchoes(); mark(); };
      return { input, echo, node: el("div", { class: "setfield" }, [
        el("label", { class: "lbl", for: id }, [label]),
        el("div", { class: "setline" }, [input, echo]),
        el("p", { class: "hint" }, [hint]),
      ]) };
    };
    const nTimeout = number("cm-timeout", "Timeout per call (ms)", Number(x.timeoutMs ?? 10000),
      "100–60000. Also the ceiling for a wait call, unless the model passes its own.");
    const nChars = number("cm-chars", "Max code chars", Number(x.maxCodeChars ?? 32768),
      "At least 1024. A longer cell is refused before it runs.");
    const nOut = number("cm-out", "Max output bytes", Number(x.maxOutputBytes ?? 65536),
      "1024–10485760. Longer stdout is truncated, and the result says it was.");
    const nPend = number("cm-pend", "Max pending tool calls", Number(x.maxPendingToolCalls ?? 16),
      "1–128. Calls in flight before the bridge refuses more inside one cell.");
    const bytes = (n: number): string => (n >= 1048576 ? `${Math.round((n / 1048576) * 10) / 10} MB` : `${Math.round((n / 1024) * 10) / 10} KB`);
    function syncEchoes(): void {
      const t = Number(nTimeout.input.value.trim());
      nTimeout.echo.textContent = Number.isFinite(t) && t >= 100 ? `≈ ${Math.round((t / 1000) * 10) / 10} s` : "";
      const c = Number(nChars.input.value.trim());
      nChars.echo.textContent = Number.isFinite(c) && c >= 1024 ? bytes(c) : "";
      const o = Number(nOut.input.value.trim());
      nOut.echo.textContent = Number.isFinite(o) && o >= 1024 ? bytes(o) : "";
      const p = Number(nPend.input.value.trim());
      nPend.echo.textContent = Number.isFinite(p) && p >= 1 ? `calls` : "";
    }
    syncEchoes();

    /* ---- direct-only chips: from the catalog, never free text ---- */

    const chipsWrap = el("div", { class: "seg seg--wrap", role: "group", "aria-label": "Direct-only tools" });
    const chip = (name: string, known: boolean): HTMLButtonElement => {
      const b = el("button", {
        class: `seg__btn${known ? "" : " is-off"}`,
        type: "button",
        id: `cm-direct-${name}`,
        "aria-pressed": String(direct.has(name)),
        title: known
          ? `${name} stays visible next to exec instead of becoming a guest global`
          : `${name} is not in this build's tool catalog — this entry does nothing`,
      }, [name]) as HTMLButtonElement;
      b.onclick = () => {
        if (direct.has(name)) direct.delete(name);
        else direct.add(name);
        b.setAttribute("aria-pressed", String(direct.has(name)));
        syncStatus();
        mark();
      };
      return b;
    };
    for (const name of catalog) chipsWrap.append(chip(name, true));
    for (const name of [...direct].filter((n) => !catalog.includes(n))) chipsWrap.append(chip(name, false));

    /* ---- save: one write for the whole block ---- */

    const problem = el("p", { class: "hint hint--err", role: "alert", hidden: "" }, []);
    const save = el("button", { class: "btn pri", type: "button", id: "codemode-save" }, ["Save code mode"]) as HTMLButtonElement;
    let saving = false;
    save.onclick = async () => {
      if (saving) return;
      problem.textContent = "";
      problem.setAttribute("hidden", "");
      const fields = [nTimeout, nChars, nOut, nPend];
      for (const f of fields) f.input.removeAttribute("aria-invalid");
      const bad: { input: HTMLInputElement; msg: string }[] = [];
      const readInt = (f: { input: HTMLInputElement }, label: string, lo: number, hi: number | null): number => {
        const raw = f.input.value.trim();
        const n = Number(raw);
        const ok = raw !== "" && Number.isInteger(n) && n >= lo && (hi === null || n <= hi);
        if (!ok) {
          f.input.setAttribute("aria-invalid", "true");
          bad.push({
            input: f.input,
            msg: `${label} must be ${hi === null ? `at least ${lo}` : `${lo}–${hi}`}${raw === "" ? " (not blank)" : ""}`,
          });
          return Number.NaN;
        }
        return n;
      };
      const timeoutMs = readInt(nTimeout, "timeout", 100, 60000);
      const maxCodeChars = readInt(nChars, "max code chars", 1024, null);
      const maxOutputBytes = readInt(nOut, "max output bytes", 1024, 10485760);
      const maxPendingToolCalls = readInt(nPend, "max pending tool calls", 1, 128);
      if (bad.length) {
        problem.textContent = `Not saved — ${bad.map((b) => b.msg).join("; ")}.`;
        problem.removeAttribute("hidden");
        bad[0]?.input.focus();
        return;
      }
      const block: Record<string, unknown> = {
        ...structuredClone(x),
        enabled: modeValue,
        executor,
        timeoutMs,
        maxCodeChars,
        maxOutputBytes,
        maxPendingToolCalls,
        directOnly: [...direct],
      };
      saving = true;
      save.disabled = true;
      save.textContent = "Saving…";
      try {
        await gateway.request("config.set", { path: "tools.codeMode", value: block });
        clearDirty();
        toast("code mode saved — applies to the next turn", "ok");
        this.#onChanged();
        void this.render();
      } catch (err) {
        problem.textContent = `not saved — ${(err as Error).message}`;
        problem.removeAttribute("hidden");
        toast(`not saved — ${(err as Error).message}`, "err");
      } finally {
        saving = false;
        save.disabled = false;
        save.textContent = "Save code mode";
      }
    };

    /* ---- assembly ---- */

    const runSection = el("div", { class: "setsec" }, [
      el("div", { class: "setsec__head" }, [
        el("span", { class: "cap" }, ["When it runs"]),
        el("span", { class: "setsec__count" }, ["3 options"]),
      ]),
      modeGroup,
      el("div", { class: "setfield" }, [
        el("span", { class: "lbl" }, ["auto means these model families"]),
        families,
        el("p", { class: "hint" }, ["Matched against the default model on the Defaults tab; anything else waits until you pick “always”."]),
      ]),
      el("div", { class: "setfield" }, [
        el("span", { class: "lbl" }, ["Executor"]),
        executorSeg,
        el("p", { class: "hint" }, ["node is the only executor bundled here. quickjs is accepted by the schema and listed for parity, but a cell that asks for it stops with executor_unavailable rather than falling back."]),
      ]),
    ]);

    const limitsSection = el("div", { class: "setsec" }, [
      el("div", { class: "setsec__head" }, [
        el("span", { class: "cap" }, ["Cell limits"]),
        el("span", { class: "setsec__count" }, ["4 limits"]),
      ]),
      el("div", { class: "setgrid" }, [nTimeout.node, nChars.node, nOut.node, nPend.node]),
    ]);

    const directSection = el("div", { class: "setsec" }, [
      el("div", { class: "setsec__head" }, [
        el("span", { class: "cap" }, ["Direct-only tools"]),
        el("span", { class: "setsec__count" }, [`${direct.size} kept out`]),
      ]),
      chipsWrap,
      el("p", { class: "hint" }, [
        "These stay visible next to exec. Every other tool is only reachable from inside the cell as an async global — and those calls still go through exec policy and approvals, so code mode is not a way around the section above."
      ]),
    ]);

    // One subtree for the dirty watch: every control below is a draft edit, and
    // nothing outside it (the catalog card, the grants above) is part of the draft.
    const policyZone = el("div", { class: "cm__policy" }, [runSection, limitsSection, directSection]);
    const clearDirty = this.#dirtyWatch(policyZone, note);

    syncMode();
    syncExecutor();
    syncStatus();

    return el("div", { class: "card code-mode-card" }, [
      el("div", { class: "setcard__head" }, [
        el("h3", {}, ["Code mode"]),
        el("p", { class: "hint" }, [
          "The model writes one JavaScript cell per turn and calls tools inside it, instead of calling them one at a time. Useful for loops and multi-step work; it does not raise what the agent may do.",
        ]),
      ]),
      el("div", { class: "setcard__status" }, [statusTag, statusNote]),
      policyZone,
      el("div", { class: "setfoot" }, [note, problem, save]),
    ]);
  }

  /** Media understanding card (P4 #38 — their tools.media): images, voice notes
   *  and PDFs are turned into text before the model sees them.
   *
   *  Three questions the old card could not answer, and this one has to: what
   *  handles each capability (the page never showed the model ladder), what a
   *  limit of 0 actually means (the runtime reads it as "the default"), and
   *  whether the audio echo format is even reachable (it is only read when the
   *  echo is on). */
  async #mediaCard(config: any): Promise<HTMLElement> {
    const x = config.tools?.media ?? {};
    let rt: any = null;
    let rtError = "";
    try {
      // The capability defaults live in the engine; copying them here is how a
      // "0 = 500 chars" hint becomes a lie the first time they change.
      rt = await gateway.request("media.get");
    } catch (err) {
      rtError = (err as Error).message;
    }
    const defaults: Record<string, { maxBytes?: number; maxChars?: number | null; timeoutSeconds?: number }> =
      (rt?.defaults ?? {}) as Record<string, any>;
    const ladder: { label: string; capabilities: string[]; valid: boolean }[] = Array.isArray(rt?.models)
      ? rt.models.map((m: any) => ({
          label: String(m.label ?? ""),
          capabilities: Array.isArray(m.capabilities) ? m.capabilities.map(String) : [],
          valid: m.valid !== false,
        }))
      : (Array.isArray(x.models) ? x.models : []).map((m: any) => ({
          label: m?.type === "cli" ? `cli:${m.command || "?"}` : [m.provider, m.model].filter(Boolean).join("/") || "provider (auto model)",
          capabilities: Array.isArray(m?.capabilities) ? m.capabilities.map(String) : [],
          valid: true,
        }));

    const note = el("span", { class: "setfoot__note", "aria-live": "polite" }, []);
    const mark = (): void => this.#dirtyMark(note);
    const problem = el("p", { class: "hint hint--err", role: "alert", hidden: "" }, []);

    /* ---- draft ---- */

    let imgOn = x.image?.enabled !== false;
    let audOn = x.audio?.enabled !== false;
    let pdfOn = x.pdf?.enabled !== false;
    let echoOn = Boolean(x.audio?.echoTranscript);
    let attachAll = Boolean(x.image?.attachments_all);

    const statusTag = el("span", { class: "settings__tag" });
    const statusNote = el("span", { class: "setcard__status-note", "aria-live": "polite" });
    // Group counts follow the draft too, so a toggle is answered everywhere it matters.
    const capCount = { image: el("span", { class: "setsec__count" }), audio: el("span", { class: "setsec__count" }), pdf: el("span", { class: "setsec__count" }) };
    const allCount = el("span", { class: "setsec__count" });
    const onList = (): string[] => [
      ...(imgOn ? ["images"] : []), ...(audOn ? ["voice notes"] : []), ...(pdfOn ? ["PDFs"] : []),
    ];
    const offList = (): string[] => [
      ...(!imgOn ? ["images"] : []), ...(!audOn ? ["voice notes"] : []), ...(!pdfOn ? ["PDFs"] : []),
    ];
    const syncStatus = (): void => {
      const on = onList();
      statusTag.textContent = `${on.length} of 3 on`;
      statusTag.className = `settings__tag${on.length > 0 ? " is-ok" : " is-warn"}`;
      const off = offList();
      statusNote.textContent = on.length === 0
        ? "Nothing is turned into text: an attachment reaches the model as a file path only."
        : off.length === 0
          ? "Images, voice notes and PDFs are turned into text before the model sees them."
          : `Not processed: ${off.join(", ")}.`;
      capCount.image.textContent = imgOn ? "on" : "off";
      capCount.audio.textContent = audOn ? "on" : "off";
      capCount.pdf.textContent = pdfOn ? "on" : "off";
      // One control in this group, so its count is that control's value.
      allCount.textContent = `concurrency ${nConc.input.value.trim() || "?"}`;
    };

    /* ---- numbers: 0 is the runtime's "use the default", and it is shown ---- */

    const fmtBytes = (n: number): string =>
      n >= 1048576 ? `${Math.round((n / 1048576) * 10) / 10} MB` : `${Math.round((n / 1024) * 10) / 10} KB`;
    const echoFor = (n: number, kind: "chars" | "bytes" | "seconds" | "count", def: number | null | undefined): string => {
      if (kind === "count") return Number.isFinite(n) && n >= 1 ? `${n} at a time` : "";
      if (n === 0) {
        if (def === null || def === undefined) return `default`;
        return `default (${kind === "bytes" ? fmtBytes(def) : kind === "seconds" ? `${def} s` : `${def} chars`})`;
      }
      if (kind === "bytes") return fmtBytes(n);
      if (kind === "seconds") return `${n} s`;
      return `${n} chars`;
    };
    interface NumField { input: HTMLInputElement; echo: HTMLElement; node: HTMLElement; }
    const makeNum = (id: string, label: string, cur: number, kind: "chars" | "bytes" | "seconds" | "count", capKey: string | null, key: string | null, hint: string): NumField => {
      const input = el("input", {
        class: "inp mono", id, inputmode: "numeric", autocomplete: "off", spellcheck: "false",
        value: String(Number.isFinite(Number(cur)) ? Number(cur) : 0),
      }) as HTMLInputElement;
      const echo = el("span", { class: "setcard__echo", "aria-live": "polite" }, []);
      const sync = (): void => {
        const n = Number(input.value.trim());
        const def = capKey && key ? (defaults[capKey]?.[key as "maxBytes" | "maxChars" | "timeoutSeconds"] ?? null) : null;
        echo.textContent = Number.isFinite(n) && n >= 0 ? echoFor(n, kind, def) : "";
      };
      input.oninput = () => { sync(); mark(); };
      sync();
      return {
        input,
        echo,
        node: el("div", { class: "setfield" }, [
          el("label", { class: "lbl", for: id }, [label]),
        el("div", { class: "setline" }, [input, echo]),
          el("p", { class: "hint" }, [hint]),
        ]),
      };
    };

    const nConc = makeNum("md-conc", "Attachments at once", Number(x.concurrency ?? 2), "count", null, null,
      "How many attachments are processed in parallel. At least 1.");
    nConc.input.addEventListener("input", () => syncStatus());
    const nImgChars = makeNum("md-img-chars", "Max description chars", Number(x.image?.maxChars ?? 500), "chars", "image", "maxChars",
      "0 = the default. A longer description is cut at this many characters.");
    const nImgBytes = makeNum("md-img-bytes", "Max image bytes", Number(x.image?.maxBytes ?? 10485760), "bytes", "image", "maxBytes",
      "0 = the default. A bigger file is skipped, not downscaled.");
    const nImgTimeout = makeNum("md-img-timeout", "Image timeout (s)", Number(x.image?.timeoutSeconds ?? 60), "seconds", "image", "timeoutSeconds",
      "0 = the default. Per attachment.");
    const nAudBytes = makeNum("md-aud-bytes", "Max audio bytes", Number(x.audio?.maxBytes ?? 20971520), "bytes", "audio", "maxBytes",
      "0 = the default. A bigger file is skipped.");
    const nAudTimeout = makeNum("md-aud-timeout", "Transcription timeout (s)", Number(x.audio?.timeoutSeconds ?? 60), "seconds", "audio", "timeoutSeconds",
      "0 = the default. Per voice note.");
    const nPdfBytes = makeNum("md-pdf-bytes", "Max PDF bytes", Number(x.pdf?.maxBytes ?? 10485760), "bytes", "pdf", "maxBytes",
      "0 = the default. A bigger file is skipped.");
    const nPdfChars = makeNum("md-pdf-chars", "Max extracted chars", Number(x.pdf?.maxChars ?? 4000), "chars", "pdf", "maxChars",
      "0 = the default. Text past this is dropped.");
    const nPdfTimeout = makeNum("md-pdf-timeout", "PDF timeout (s)", Number(x.pdf?.timeoutSeconds ?? 60), "seconds", "pdf", "timeoutSeconds",
      "0 = the default. Per file.");

    /* ---- per-capability controls ---- */

    const row = (id: string, label: string, hint: string, checked: boolean, onToggle: (v: boolean) => void): HTMLElement => {
      const cb = el("input", { type: "checkbox", id }) as HTMLInputElement;
      cb.checked = checked;
      cb.onchange = () => { onToggle(cb.checked); syncStatus(); mark(); };
      return el("div", { class: "row" }, [
        el("div", { class: "row__main" }, [
          el("label", { class: "row__label", for: id }, [label]),
          el("span", { class: "hint" }, [hint]),
        ]),
        cb,
      ]);
    };

    const lane = (cap: "image" | "audio" | "pdf"): string => {
      const mine = ladder.filter((m) => m.capabilities.includes(cap));
      if (mine.length > 0) {
        const bad = mine.some((m) => !m.valid);
        return `tries ${mine.map((m) => m.label).join(" → ")}${bad ? " — incomplete entries are skipped" : ""}`;
      }
      if (cap === "image") return "no media model is configured, so the model that answers also describes the image";
      if (cap === "audio") return "no media model is configured: a provider key first (groq, openai, xai, deepgram, google, elevenlabs, mistral), then whisper-cli or whisper on PATH";
      return "PDF text is extracted locally — no model needed";
    };

    const modelSelect = (id: string, label: string, cap: "image" | "audio", cur: string): Dd => {
      const options: DdOption[] = [{ value: "", label: "auto (first that works)" }];
      for (const m of ladder) {
        if (!m.capabilities.includes(cap)) continue;
        options.push({
          value: m.label,
          label: m.valid ? m.label : `${m.label} (incomplete — skipped)`,
          title: m.label,
        });
      }
      // A hand-written value is kept and labelled, never silently dropped.
      if (cur && !options.some((o) => o.value === cur)) {
        options.push({ value: cur, label: `${cur} — not in the ladder`, title: cur });
      }
      const dd = this.#dropdown({ id, value: cur, label, placeholder: "— choose a model —", options });
      dd.sel.addEventListener("change", mark);
      return dd;
    };
    const imgModel = modelSelect("md-img-model", "Preferred image model", "image", String(x.image?.preferredModel ?? ""));
    const audModel = modelSelect("md-aud-model", "Preferred audio model", "audio", String(x.audio?.preferredModel ?? ""));

    const imgPrompt = el("input", {
      class: "inp", id: "md-img-prompt", autocomplete: "off", spellcheck: "false",
      value: String(x.image?.prompt ?? ""),
      placeholder: "Describe the image in <= 500 chars.",
    }) as HTMLInputElement;
    imgPrompt.oninput = mark;

    const attachSeg = el("div", { class: "seg", role: "group", "aria-label": "How many images per turn" });
    const attachBtns = new Map<string, HTMLButtonElement>();
    for (const opt of [
      { mode: "first", id: "md-img-first", label: "first image only", title: "One image per turn — the runtime's default." },
      { mode: "all", id: "md-img-all", label: "up to 10", title: "Every image in the turn, capped at 10 by the runtime." },
    ]) {
      const b = el("button", {
        class: "seg__btn", type: "button", id: opt.id, title: opt.title,
        "aria-pressed": String((attachAll ? "all" : "first") === opt.mode),
      }, [opt.label]) as HTMLButtonElement;
      b.onclick = () => {
        attachAll = opt.mode === "all";
        for (const [mode, btn] of attachBtns) btn.setAttribute("aria-pressed", String((attachAll ? "all" : "first") === mode));
        mark();
      };
      attachBtns.set(opt.mode, b);
      attachSeg.append(b);
    }

    const audLang = el("input", {
      class: "inp mono", id: "md-aud-lang", autocomplete: "off", spellcheck: "false",
      value: String(x.audio?.language ?? ""), placeholder: "blank = detect",
    }) as HTMLInputElement;
    audLang.oninput = mark;

    const echoCb = el("input", { type: "checkbox", id: "md-aud-echo" }) as HTMLInputElement;
    echoCb.checked = echoOn;
    const audFmt = el("input", {
      class: "inp mono", id: "md-aud-fmt", autocomplete: "off", spellcheck: "false",
      value: String(x.audio?.echoFormat ?? ""), placeholder: '📝 "{transcript}"',
    }) as HTMLInputElement;
    audFmt.oninput = mark;
    const fmtField = el("div", { class: "setfield" }, [
      el("label", { class: "lbl", for: "md-aud-fmt" }, ["Echo format"]),
      audFmt,
      el("p", { class: "hint" }, ['Must contain {transcript}, or every note is answered with the same fixed text. Blank = the shipped default 📝 "{transcript}".']),
    ]);
    const syncEcho = (): void => {
      audFmt.disabled = !echoOn;
      fmtField.classList.toggle("is-off", !echoOn);
    };
    echoCb.onchange = () => { echoOn = echoCb.checked; syncEcho(); syncStatus(); mark(); };

    /* ---- groups ---- */

    const capSection = (title: string, cap: "image" | "audio" | "pdf", children: HTMLElement[]): HTMLElement =>
      el("div", { class: "setsec" }, [
        el("div", { class: "setsec__head" }, [
          el("span", { class: "cap" }, [title]),
          capCount[cap],
        ]),
        ...children,
        el("p", { class: "hint" }, [`Handled by: ${lane(cap)}.`]),
      ]);

    const allSection = el("div", { class: "setsec" }, [
      el("div", { class: "setsec__head" }, [
        el("span", { class: "cap" }, ["All capabilities"]),
        allCount,
      ]),
      nConc.node,
    ]);

    const imageSection = capSection("Images", "image", [
      row("md-img-on", "Describe images", "Turn each image into a description before the model sees the turn.", imgOn, (v) => { imgOn = v; }),
      this.#setField("md-img-model", "Preferred model", imgModel.node,
        "Only orders the media ladder above. On the automatic lane it is ignored — the reply model describes the image.", null),
      el("div", { class: "setfield" }, [
        el("label", { class: "lbl", for: "md-img-prompt" }, ["Description prompt"]),
        imgPrompt,
        el("p", { class: "hint" }, ["Blank = the runtime default, `Describe the image in <= 500 chars.`"]),
      ]),
      el("div", { class: "setgrid" }, [nImgChars.node, nImgBytes.node, nImgTimeout.node]),
      el("div", { class: "setfield" }, [
        el("span", { class: "lbl" }, ["Images per turn"]),
        attachSeg,
      ]),
    ]);

    const audioSection = capSection("Voice notes & audio", "audio", [
      row("md-aud-on", "Transcribe audio", "Voice notes, audio files and voice messages become text first.", audOn, (v) => { audOn = v; }),
      this.#setField("md-aud-model", "Preferred model", audModel.node,
        "On the automatic lane this is the transcription model (default gpt-4o-mini-transcribe); with a media ladder it pulls that entry first.", null),
      el("div", { class: "setgrid" }, [nAudBytes.node, nAudTimeout.node]),
      el("div", { class: "setfield" }, [
        el("label", { class: "lbl", for: "md-aud-lang" }, ["Language"]),
        audLang,
        el("p", { class: "hint" }, ["Blank lets the transcriber detect it. A code like `en` or `bn` skips detection."]),
      ]),
      el("div", { class: "row" }, [
        el("div", { class: "row__main" }, [
          el("label", { class: "row__label", for: "md-aud-echo" }, ["Echo the transcript into the chat"]),
          el("span", { class: "hint" }, ["Posts the transcript back as a message, so you can see what was heard."]),
        ]),
        echoCb,
      ]),
      fmtField,
    ]);

    const pdfSection = capSection("PDFs", "pdf", [
      row("md-pdf-on", "Read PDFs", "Text is extracted from each PDF and attached to the turn.", pdfOn, (v) => { pdfOn = v; }),
      el("div", { class: "setgrid" }, [nPdfChars.node, nPdfBytes.node, nPdfTimeout.node]),
    ]);

    /* ---- save: one write for the whole block ---- */

    const save = el("button", { class: "btn pri", type: "button", id: "media-save" }, ["Save media"]) as HTMLButtonElement;
    let saving = false;
    save.onclick = async () => {
      if (saving) return;
      problem.textContent = "";
      problem.setAttribute("hidden", "");
      const fields: NumField[] = [nConc, nImgChars, nImgBytes, nImgTimeout, nAudBytes, nAudTimeout, nPdfBytes, nPdfChars, nPdfTimeout];
      for (const f of fields) f.input.removeAttribute("aria-invalid");
      audFmt.removeAttribute("aria-invalid");
      const bad: { input: HTMLInputElement; msg: string }[] = [];
      const readInt = (f: NumField, label: string, min: number): number => {
        const raw = f.input.value.trim();
        const n = Number(raw);
        if (raw === "" || !Number.isInteger(n) || n < min) {
          f.input.setAttribute("aria-invalid", "true");
          bad.push({
            input: f.input,
            msg: raw === ""
              ? `${label} needs a number (0 means the default)`
              : `${label} must be a whole number from ${min}`,
          });
          return 0;
        }
        return n;
      };
      const concurrency = readInt(nConc, "attachments at once", 1);
      const imgChars = readInt(nImgChars, "image max chars", 0);
      const imgBytes = readInt(nImgBytes, "image max bytes", 0);
      const imgTimeout = readInt(nImgTimeout, "image timeout", 0);
      const audBytes = readInt(nAudBytes, "audio max bytes", 0);
      const audTimeout = readInt(nAudTimeout, "transcription timeout", 0);
      const pdfBytes = readInt(nPdfBytes, "pdf max bytes", 0);
      const pdfChars = readInt(nPdfChars, "pdf max chars", 0);
      const pdfTimeout = readInt(nPdfTimeout, "pdf timeout", 0);
      const fmt = audFmt.value.trim();
      // Only validated while it is reachable: with the echo off the runtime never
      // reads the format, so blocking the save for it would be noise.
      if (echoOn && fmt && !fmt.includes("{transcript}")) {
        audFmt.setAttribute("aria-invalid", "true");
        bad.push({ input: audFmt, msg: "the echo format needs {transcript}" });
      }
      if (bad.length > 0) {
        problem.textContent = `Not saved — ${bad.map((b) => b.msg).join("; ")}.`;
        problem.removeAttribute("hidden");
        bad[0]?.input.focus();
        return;
      }
      // Merged, not rebuilt: a key this page does not render (or one the schema
      // grows later) survives a save.
      const block: Record<string, unknown> = {
        ...structuredClone(x),
        concurrency,
        image: {
          ...(x.image ?? {}),
          enabled: imgOn,
          preferredModel: this.#selValue(imgModel.sel),
          prompt: imgPrompt.value.trim(),
          maxChars: imgChars,
          maxBytes: imgBytes,
          timeoutSeconds: imgTimeout,
          attachments_all: attachAll,
        },
        audio: {
          ...(x.audio ?? {}),
          enabled: audOn,
          preferredModel: this.#selValue(audModel.sel),
          maxBytes: audBytes,
          timeoutSeconds: audTimeout,
          language: audLang.value.trim(),
          echoTranscript: echoOn,
          echoFormat: fmt,
        },
        pdf: {
          ...(x.pdf ?? {}),
          enabled: pdfOn,
          maxBytes: pdfBytes,
          maxChars: pdfChars,
          timeoutSeconds: pdfTimeout,
        },
      };
      saving = true;
      save.disabled = true;
      save.textContent = "Saving…";
      try {
        await gateway.request("config.set", { path: "tools.media", value: block });
        clearDirty();
        toast("media understanding saved — applies to the next turn", "ok");
        this.#onChanged();
        void this.render();
      } catch (err) {
        problem.textContent = `not saved — ${(err as Error).message}`;
        problem.removeAttribute("hidden");
        toast(`not saved — ${(err as Error).message}`, "err");
      } finally {
        saving = false;
        save.disabled = false;
        save.textContent = "Save media";
      }
    };

    /* ---- assembly ---- */

    const policyZone = el("div", { class: "media__policy" }, [allSection, imageSection, audioSection, pdfSection]);
    const clearDirty = this.#dirtyWatch(policyZone, note);
    syncEcho();
    syncStatus();

    return el("div", { class: "card media-card" }, [
      el("div", { class: "setcard__head" }, [
        el("h3", {}, ["Media understanding"]),
        el("p", { class: "hint" }, [
          "Attachments are turned into text before the model sees the turn. Each capability can be switched off on its own; off means the file reaches the model as a path only.",
        ]),
      ]),
      el("div", { class: "setcard__status" }, [statusTag, statusNote]),
      ...(rtError ? [el("p", { class: "hint" }, [`Defaults and the media ladder could not be read — ${rtError}. Numbers below still save; 0 still means the default.`])] : []),
      policyZone,
      el("div", { class: "setfoot" }, [note, problem, save]),
    ]);
  }

  /** Web search card: which provider answers, what it needs, and how much it
   *  returns.
   *
   *  The old card wrote config on every click, showed credentials only for the
   *  already-selected provider (so configuring Brave meant first switching the
   *  agent to Brave), could not touch maxResults or the cache TTL, and collapsed
   *  to a single sentence when the RPC failed. */
  async #webSearchCard(config: any = {}): Promise<HTMLElement> {
    const x = config.tools?.web?.search ?? {};
    let st: any = null;
    let stError = "";
    try {
      st = await gateway.request("web.search.get");
    } catch (err) {
      stError = (err as Error).message;
    }
    const providers: { id: string; ready: boolean; keyFree: boolean; hasKey: boolean; configBaseUrl: string }[] =
      Array.isArray(st?.providers)
        ? st.providers.map((p: any) => ({
            id: String(p.id),
            ready: p.ready === true,
            keyFree: p.keyFree === true,
            hasKey: p.hasKey === true,
            configBaseUrl: String(p.configBaseUrl ?? ""),
          }))
        : [];
    const masks: Record<string, string> = (st?.keyMasks ?? {}) as Record<string, string>;
    const effective = String(st?.effective ?? "");
    const candidates: string[] = Array.isArray(st?.autoCandidates) ? st.autoCandidates.map(String) : [];
    const savedProvider = String(x.provider ?? "");

    /* ---- draft ---- */

    let enabled = x.enabled !== false;
    let provider = savedProvider;
    const keys = new Map<string, string>();
    const urls = new Map<string, string>();
    for (const p of providers) {
      if (p.keyFree) urls.set(p.id, String(x[p.id]?.baseUrl ?? ""));
    }

    const note = el("span", { class: "setfoot__note", "aria-live": "polite" }, []);
    const mark = (): void => this.#dirtyMark(note);
    const problem = el("p", { class: "hint hint--err", role: "alert", hidden: "" }, []);
    const statusTag = el("span", { class: "settings__tag" });
    const statusNote = el("span", { class: "setcard__status-note", "aria-live": "polite" });

    const syncStatus = (): void => {
      const chosen = provider ? providers.find((p) => p.id === provider) : null;
      if (!enabled) {
        statusTag.textContent = "off";
        statusTag.className = "settings__tag is-warn";
        statusNote.textContent = "The web_search tool is not offered to the agent at all.";
        return;
      }
      if (provider) {
        statusTag.textContent = `on · ${provider}`;
        if (chosen && !chosen.ready) {
          statusTag.className = "settings__tag is-warn";
          statusNote.textContent = "An explicit provider wins and never falls back: every search fails until its "
            + (chosen.keyFree ? "base URL is set." : "key is set.");
          return;
        }
        statusTag.className = "settings__tag is-ok";
        statusNote.textContent = "Explicit provider — there is no fallback if it starts failing.";
        return;
      }
      statusTag.textContent = effective ? `on · auto → ${effective}` : "on · auto → nothing ready";
      statusTag.className = `settings__tag${effective ? " is-ok" : " is-warn"}`;
      statusNote.textContent = candidates.length > 0
        ? `auto uses the first ready provider in this order: ${candidates.join(" → ")}. DuckDuckGo is only used when chosen.`
        : "No provider is ready yet: add a key below, or choose searxng and give it a URL.";
    };

    /* ---- provider choice: stages, never writes ---- */

    const providerSeg = el("div", { class: "seg seg--wrap", role: "group", "aria-label": "Search provider" });
    const providerBtns = new Map<string, HTMLButtonElement>();
    const providerOptions: { id: string; label: string; ready: boolean; reason: string }[] = [
      {
        id: "",
        label: "auto",
        ready: Boolean(effective),
        reason: candidates.length > 0
          ? `first ready provider: ${candidates.join(" → ")}`
          : "nothing is ready — auto has nothing to use",
      },
      ...providers.map((p) => ({
        id: p.id,
        label: p.id,
        ready: p.ready,
        reason: p.ready
          ? "ready"
          : p.keyFree
            ? "not ready — needs a base URL"
            : "not ready — needs an API key (choosing it anyway makes every search fail)",
      })),
    ];
    for (const opt of providerOptions) {
      const b = el("button", {
        class: `seg__btn${opt.ready ? "" : " is-off"}`,
        type: "button",
        id: opt.id ? `ws-provider-${opt.id}` : "ws-provider-auto",
        "aria-pressed": String(provider === opt.id),
        title: opt.reason,
      }, [opt.label]) as HTMLButtonElement;
      b.onclick = () => {
        provider = opt.id;
        for (const [id, btn] of providerBtns) btn.setAttribute("aria-pressed", String(provider === id));
        syncStatus();
        mark();
      };
      providerBtns.set(opt.id, b);
      providerSeg.append(b);
    }

    /* ---- credentials: every provider at once ---- */

    const credRows: HTMLElement[] = [];
    for (const p of providers) {
      if (p.keyFree) {
        const input = el("input", {
          class: "inp mono", id: `ws-url-${p.id}`, autocomplete: "off", spellcheck: "false",
          value: urls.get(p.id) ?? "",
          placeholder: p.id === "searxng" ? "https://searx.example.com" : "https://html.duckduckgo.com",
        }) as HTMLInputElement;
        input.oninput = () => { urls.set(p.id, input.value); mark(); };
        credRows.push(el("div", { class: "setfield" }, [
          el("label", { class: "lbl", for: `ws-url-${p.id}` }, [`${p.id} base URL`]),
          input,
          el("p", { class: "hint" }, [
            p.id === "searxng"
              ? (p.ready ? "Ready — auto can use it." : "Not ready until a URL is set. auto can use searxng once it is; DuckDuckGo never is.")
              : "Blank uses the public endpoint. DuckDuckGo is never picked by auto.",
          ]),
        ]));
        continue;
      }
      const mask = masks[p.id] ?? "";
      const fromEnv = p.hasKey && !mask;
      const state = mask ? `stored · ${mask.replace("__redacted__:", "")}` : fromEnv ? "from the environment" : "no key";
      const input = el("input", {
        class: "inp mono", type: "password", id: `ws-key-${p.id}`, autocomplete: "off", spellcheck: "false",
        placeholder: p.hasKey
          ? `${state} — leave blank to keep`
          : `${p.id.toUpperCase()}_API_KEY in the environment, or paste one here`,
      }) as HTMLInputElement;
      input.oninput = () => { keys.set(p.id, input.value); mark(); };
      credRows.push(el("div", { class: "setfield" }, [
        el("label", { class: "lbl", for: `ws-key-${p.id}` }, [`${p.id} API key`]),
        el("div", { class: "settings__inline" }, [
          input,
          el("span", { class: `settings__tag${p.ready ? " is-ok" : " is-warn"}` }, [state]),
        ]),
        el("p", { class: "hint" }, [
          fromEnv
            ? `Read from the environment — nothing is stored in the config file. Typing here stores one and shadows it.`
            : "Stored in the config file, masked on the wire. Blank keeps whatever is there.",
        ]),
      ]));
    }

    /* ---- limits ---- */

    interface Num { input: HTMLInputElement; echo: HTMLElement; node: HTMLElement; }
    const num = (id: string, label: string, cur: number, hint: string, echo: (n: number) => string): Num => {
      const input = el("input", {
        class: "inp mono", id, inputmode: "numeric", autocomplete: "off", spellcheck: "false", value: String(cur),
      }) as HTMLInputElement;
      const echoEl = el("span", { class: "setcard__echo", "aria-live": "polite" }, []);
      const sync = (): void => {
        const n = Number(input.value.trim());
        echoEl.textContent = Number.isFinite(n) ? echo(n) : "";
      };
      input.oninput = () => { sync(); mark(); };
      sync();
      return {
        input,
        echo: echoEl,
        node: el("div", { class: "setfield" }, [
          el("label", { class: "lbl", for: id }, [label]),
          el("div", { class: "setline" }, [input, echoEl]),
          el("p", { class: "hint" }, [hint]),
        ]),
      };
    };
    const nMax = num("ws-max", "Results per search", Number(x.maxResults ?? 5),
      "1–10. What the tool is allowed to return in one call.",
      (n) => (Number.isInteger(n) && n >= 1 && n <= 10 ? `${n} result${n === 1 ? "" : "s"}` : ""));
    const nCache = num("ws-cache", "Cache TTL (minutes)", Number(x.cacheTtlMinutes ?? 15),
      "0–1440. 0 bypasses the cache completely, for both reads and writes.",
      (n) => (n === 0 ? "cache bypassed" : Number.isInteger(n) && n > 0 ? `${n} min` : ""));

    /* ---- test (immediate: it acts, it does not write) ---- */

    const testOut = el("p", { class: "hint", id: "ws-test-out", "aria-live": "polite" }, []);
    const testBtn = el("button", { class: "btn sm", type: "button", id: "ws-test" }, ["Test saved settings"]) as HTMLButtonElement;
    testBtn.onclick = async () => {
      testBtn.disabled = true;
      testOut.textContent = "searching…";
      try {
        const r = (await gateway.request("web.search.test", {
          provider: savedProvider || undefined,
        })) as any;
        testOut.textContent = r.ok
          ? `✓ ${r.provider} · ${r.count} result(s) in ${r.tookMs}ms — ${(r.firstTitles ?? []).join(" · ") || "(no titles)"}`
          : `✗ ${r.message ?? "failed"}`;
      } catch (err) {
        testOut.textContent = `✗ ${(err as Error).message}`;
      }
      testBtn.disabled = false;
    };

    /* ---- save ---- */

    const save = el("button", { class: "btn pri", type: "button", id: "websearch-save" }, ["Save web search"]) as HTMLButtonElement;
    let saving = false;
    save.onclick = async () => {
      if (saving) return;
      problem.textContent = "";
      problem.setAttribute("hidden", "");
      nMax.input.removeAttribute("aria-invalid");
      nCache.input.removeAttribute("aria-invalid");
      const bad: { input: HTMLInputElement; msg: string }[] = [];
      const readInt = (f: Num, label: string, lo: number, hi: number): number => {
        const raw = f.input.value.trim();
        const n = Number(raw);
        if (raw === "" || !Number.isInteger(n) || n < lo || n > hi) {
          f.input.setAttribute("aria-invalid", "true");
          bad.push({ input: f.input, msg: `${label} must be a whole number ${lo}–${hi}` });
          return lo;
        }
        return n;
      };
      const maxResults = readInt(nMax, "results per search", 1, 10);
      const cacheTtlMinutes = readInt(nCache, "cache TTL", 0, 1440);
      if (bad.length > 0) {
        problem.textContent = `Not saved — ${bad.map((b) => b.msg).join("; ")}.`;
        problem.removeAttribute("hidden");
        bad[0]?.input.focus();
        return;
      }
      const block: Record<string, unknown> = {
        ...structuredClone(x),
        enabled,
        // Empty string is auto, and must stay empty: "auto" is not a backend id.
        provider,
        maxResults,
        cacheTtlMinutes,
      };
      for (const p of providers) {
        if (p.keyFree) {
          block[p.id] = { ...(x[p.id] ?? {}), baseUrl: (urls.get(p.id) ?? "").trim() };
          continue;
        }
        const typed = (keys.get(p.id) ?? "").trim();
        block[p.id] = { ...(x[p.id] ?? {}), apiKey: typed || String(x[p.id]?.apiKey ?? "") };
      }
      saving = true;
      save.disabled = true;
      save.textContent = "Saving…";
      try {
        await gateway.request("config.set", { path: "tools.web.search", value: block });
        clearDirty();
        toast("web search saved — applies to the next search", "ok");
        this.#onChanged();
        void this.render();
      } catch (err) {
        problem.textContent = `not saved — ${(err as Error).message}`;
        problem.removeAttribute("hidden");
        toast(`not saved — ${(err as Error).message}`, "err");
      } finally {
        saving = false;
        save.disabled = false;
        save.textContent = "Save web search";
      }
    };

    /* ---- assembly ---- */

    const enableCb = el("input", { type: "checkbox", id: "ws-enabled" }) as HTMLInputElement;
    enableCb.checked = enabled;
    enableCb.onchange = () => { enabled = enableCb.checked; syncStatus(); mark(); };

    const policyZone = el("div", { class: "ws__policy" }, [
      el("div", { class: "row" }, [
        el("div", { class: "row__main" }, [
          el("label", { class: "row__label", for: "ws-enabled" }, ["Offer the web_search tool"]),
          el("span", { class: "hint" }, ["When off, the agent has no way to search the web at all."]),
        ]),
        enableCb,
      ]),
      el("div", { class: "setsec" }, [
        el("div", { class: "setsec__head" }, [
          el("span", { class: "cap" }, ["Provider"]),
          el("span", { class: "setsec__count" }, [provider ? "explicit" : "auto"]),
        ]),
        providerSeg,
        el("p", { class: "hint" }, ["A not-ready provider can still be chosen — you may be about to paste its key — but an explicit choice never falls back."]),
        // The test acts on the saved config, so it belongs beside the choice it
        // exercises — not in the commit band with Save.
        el("div", { class: "settings__inline" }, [testBtn]),
        testOut,
      ]),
      el("div", { class: "setsec" }, [
        el("div", { class: "setsec__head" }, [
          el("span", { class: "cap" }, ["Credentials"]),
          el("span", { class: "setsec__count" }, [`${providers.filter((p) => p.ready).length} ready`]),
        ]),
        ...(credRows.length > 0
          ? credRows
          : [el("p", { class: "hint" }, ["The provider list could not be read, so there is nothing to configure here right now. The limits below still save."])]),
      ]),
      el("div", { class: "setsec" }, [
        el("div", { class: "setsec__head" }, [
          el("span", { class: "cap" }, ["Limits"]),
          el("span", { class: "setsec__count" }, ["2 limits"]),
        ]),
        el("div", { class: "setgrid" }, [nMax.node, nCache.node]),
      ]),
    ]);
    const clearDirty = this.#dirtyWatch(policyZone, note);
    syncStatus();

    return el("div", { class: "card web-search" }, [
      el("div", { class: "setcard__head" }, [
        el("h3", {}, ["Web search"]),
        el("p", { class: "hint" }, [
          "Backs the web_search tool. auto picks the first ready provider; an explicit choice is used as-is, with no fallback.",
        ]),
      ]),
      el("div", { class: "setcard__status" }, [statusTag, statusNote]),
      ...(stError ? [el("p", { class: "hint" }, [`Provider list could not be read — ${stError}. Everything below still saves.`])] : []),
      policyZone,
      el("div", { class: "setfoot" }, [note, problem, save]),
    ]);
  }

  async #renderTools(tools: any[], config: any = {}): Promise<void> {
    const body = el("div", { class: "settings__stack" });

    body.append(await this.#execCard(config));
    body.append(await this.#codeModeCard(config, tools));
    body.append(await this.#mediaCard(config));
    body.append(await this.#webSearchCard(config));

    // The inventory is the *registered* list (tools.list → service.loop.tools), which
    // is why a tool switched off in a card above disappears from it. Say so once,
    // here, instead of letting the reader guess whether it was never built in.
    const asksApproval = (tools as any[]).filter((t) => t.needsApproval === true).length;
    body.append(el("div", { class: "card tools-inventory" }, [
      el("div", { class: "setcard__head" }, [
        el("h3", {}, ["Built-in tools"]),
        el("p", { class: "hint" }, [
          "The inventory of what this build registers. Read-only: neither the agent nor you can add or remove a tool here.",
        ]),
      ]),
      el("div", { class: "setcard__status" }, [
        el("span", { class: "settings__tag" }, [`${tools.length} registered`]),
        el("span", { class: "setcard__status-note" }, [
          asksApproval === 0
            ? "None of them asks for approval before running."
            : `${asksApproval} of them ask${asksApproval === 1 ? "s" : ""} for approval before running.`,
        ]),
      ]),
      el("p", { class: "hint" }, [
        "Only registered tools are listed: switch one off above (exec, web search, pdf) — or the fs and memory switches on the Config tab — and it leaves this list.",
      ]),
      el("p", { class: "hint" }, [
        "Code mode picks from the same catalog, minus exec and wait, which it provides itself.",
      ]),
      ...(tools as any[]).map((t) =>
        el("div", { class: "prov" }, [
          el("div", { class: "prov__head" }, [
            el("span", { class: "prov__name mono" }, [t.name]),
            el("span", { class: `settings__tag${t.needsApproval ? " is-warn" : ""}` }, [
              t.needsApproval ? "asks approval" : "no approval",
            ]),
          ]),
          el("div", { class: "tool__desc" }, [t.description || ""]),
        ])),
      el("div", { class: "setfoot" }, [
        el("span", { class: "setfoot__note" }, ["Read-only inventory — nothing on this card changes the config."]),
      ]),
    ]));

    this.#root.append(body);
  }

  /* ---------------- gateway ---------------- */



  /** Usage dashboard (P4 #34 — their Usage page): totals, daily rollups and
   *  session/model aggregates from `usage.report`. Cost only appears when a
   *  pricing card covered every contributing run — never-guess-a-price: a total
   *  we cannot compute says n/a instead of inventing a number. */
  #usageDays = 30;
  #usageSession = "";
  #usageReport: any = null;
  /** Where focus goes back to after a re-render rebuilds the controls. */
  #usageFocus: string | null = null;

  /** A session key's last two segments — the part that tells two chats apart —
   *  while the menu keeps the whole key as its title. */
  #usageSessionLabel(key: string): string {
    const parts = key.split(":");
    return parts.length > 2 ? parts.slice(-2).join(":") : key;
  }

  async #renderUsage(): Promise<void> {
    const body = el("div", { class: "settings__stack" });
    this.#root.innerHTML = "";
    this.#root.append(body);
    body.append(el("p", { class: "hint", role: "status" }, ["Loading usage report…"]));

    // A re-render replaces every control, so the pick that caused it would
    // otherwise drop the keyboard user at the top of the page.
    const finish = (): void => {
      const id = this.#usageFocus;
      this.#usageFocus = null;
      if (id) (document.getElementById(id) as HTMLElement | null)?.focus();
    };
    const rerenderFor = (id: string): void => {
      this.#usageFocus = id;
      void this.#renderUsage();
    };

    let res: any;
    try {
      res = await gateway.request("usage.report", {
        days: this.#usageDays,
        ...(this.#usageSession ? { sessionKey: this.#usageSession } : {}),
      });
    } catch (err) {
      body.innerHTML = "";
      const retry = el("button", { class: "btn pri", type: "button", id: "usage-retry" }, ["Try again"]);
      retry.onclick = () => rerenderFor("usage-retry");
      body.append(el("div", { class: "card usage-empty" }, [
        el("p", { class: "usage-empty__title" }, ["The usage report could not be loaded"]),
        el("p", { class: "hint" }, [(err as Error).message]),
        el("div", { class: "usage-empty__actions" }, [retry]),
      ]));
      finish();
      return;
    }
    this.#usageReport = res.report;
    const report = res.report;
    const t = report.total;
    body.innerHTML = "";

    const fmtTok = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
    // Zero is "$0.00" (four decimals on nothing reads like a rounding bug), a
    // real sub-cent amount keeps its precision, and an unknown cost says so.
    const fmtUsd = (c: number | null, unknown: number) =>
      c === null ? (unknown > 0 ? "n/a" : "$0.00") : c === 0 ? "$0.00" : c >= 0.01 ? `$${c.toFixed(2)}` : `$${c.toFixed(4)}`;
    const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

    const PERIODS = [
      { value: "7", label: "Last 7 days" },
      { value: "30", label: "Last 30 days" },
      { value: "90", label: "Last 90 days" },
      { value: "0", label: "All time" },
    ];
    const periodLabel = PERIODS.find((p) => p.value === String(this.#usageDays))?.label ?? `Last ${this.#usageDays} days`;

    // Same dropdown as every other Settings page: button + listbox, search once
    // the list is long, keyboard and focus handled in one place.
    const periodDd = this.#dropdown({
      id: "usage-period",
      value: String(this.#usageDays),
      label: "Period",
      placeholder: "Last 30 days",
      options: PERIODS,
      searchable: false,
    });
    periodDd.sel.onchange = () => {
      this.#usageDays = Number(periodDd.sel.value);
      rerenderFor("usage-period-btn");
    };
    const sessionDd = this.#dropdown({
      id: "usage-session",
      value: this.#usageSession,
      label: "Session",
      placeholder: "All sessions",
      searchable: true,
      options: ((res.sessions ?? []) as string[]).map((k) => ({ value: k, label: this.#usageSessionLabel(k), title: k })),
    });
    sessionDd.sel.onchange = () => {
      this.#usageSession = sessionDd.sel.value;
      rerenderFor("usage-session-btn");
    };

    const nothing = t.runs === 0;
    const refresh = el("button", { class: "btn", type: "button", id: "usage-refresh", title: "Fetch the report again" }, ["Refresh"]) as HTMLButtonElement;
    refresh.onclick = () => rerenderFor("usage-refresh");
    const exJson = el("button", { class: "btn", type: "button", id: "usage-export-json", title: "The whole report as JSON" }, ["Export JSON"]) as HTMLButtonElement;
    exJson.onclick = () => this.#usageExport("json");
    const exCsv = el("button", { class: "btn", type: "button", id: "usage-export-csv", title: "Daily rows for this period, one line per day" }, ["Export CSV (daily)"]) as HTMLButtonElement;
    exCsv.onclick = () => this.#usageExport("csv");
    for (const b of [exJson, exCsv]) {
      b.disabled = nothing;
      if (nothing) b.title = "Nothing to export for this period yet";
    }

    body.append(el("div", { class: "usage-toolbar" }, [
      el("div", { class: "field field--period" }, [el("span", { class: "cap" }, ["Period"]), periodDd.node]),
      el("div", { class: "field field--session" }, [el("span", { class: "cap" }, ["Session"]), sessionDd.node]),
      el("div", { class: "usage-actions" }, [refresh, exJson, exCsv]),
    ]));

    // What every number below covers, restated where the numbers are.
    body.append(el("p", { class: "usage-scope" }, [
      `${periodLabel} · ${this.#usageSession ? `session ${this.#usageSession}` : "all sessions"}`,
    ]));

    const card = (value: string, label: string, title: string) =>
      el("div", { class: "usage-card", title }, [
        el("span", { class: "usage-card__value" }, [value]),
        el("span", { class: "cap" }, [label]),
      ]);
    body.append(el("div", { class: "usage-cards" }, [
      card(fmtTok(t.inputTokens), "Input tokens", `${t.inputTokens.toLocaleString()} input tokens`),
      card(fmtTok(t.outputTokens), "Output tokens", `${t.outputTokens.toLocaleString()} output tokens`),
      card(String(t.runs), t.runs === 1 ? "Run" : "Runs", `${t.runs.toLocaleString()} completed runs`),
      card(fmtUsd(t.costUsd, t.unknownPriceRuns), "Cost", t.costUsd === null ? "n/a — a run in this period has no pricing card" : `$${t.costUsd.toFixed(6)}`),
    ]));
    if (t.cachedInput > 0) {
      body.append(el("p", { class: "hint" }, [`${fmtTok(t.cachedInput)} of the input tokens were served from cache.`]));
    }
    if (t.unknownPriceRuns > 0) {
      body.append(el("p", { class: "hint" }, [
        `${plural(t.unknownPriceRuns, "run")} of ${t.runs} used a model with no pricing card, so cost is not a real total — set a price on Models → Tune to get one.`,
      ]));
    }

    if (nothing) {
      // One empty state, not three tables that each say "nothing" differently.
      const actions: HTMLElement[] = [];
      if (this.#usageSession) {
        const clearSession = el("button", { class: "btn", type: "button", id: "usage-clear-session" }, ["Show all sessions"]);
        clearSession.onclick = () => {
          this.#usageSession = "";
          rerenderFor("usage-clear-session");
        };
        actions.push(clearSession);
      }
      if (this.#usageDays !== 0) {
        const allTime = el("button", { class: "btn pri", type: "button", id: "usage-all-time" }, ["Show all time"]);
        allTime.onclick = () => {
          this.#usageDays = 0;
          rerenderFor("usage-all-time");
        };
        actions.push(allTime);
      }
      body.append(el("div", { class: "card usage-empty" }, [
        el("p", { class: "usage-empty__title" }, [
          this.#usageSession ? "No runs for this session in this period" : this.#usageDays !== 0 ? `No runs in the ${periodLabel.toLowerCase()}` : "No usage recorded yet",
        ]),
        el("p", { class: "hint" }, [
          "A run is recorded whenever the agent answers, with the tokens the provider reported. Numbers appear here as soon as one finishes.",
        ]),
        ...(actions.length ? [el("div", { class: "usage-empty__actions" }, actions)] : []),
      ]));
      finish();
      return;
    }

    const costCell = (c: number | null, unknown: number): HTMLElement =>
      c === null
        ? el("td", { class: "usage-num usage-na", title: unknown ? `${plural(unknown, "run")} here used a model with no pricing card` : "no pricing card" }, ["n/a"])
        : el("td", { class: "usage-num", title: `$${c.toFixed(6)}` }, [fmtUsd(c, unknown)]);

    const section = (
      title: string,
      note: string,
      firstColumn: string,
      rows: { key: string; runs: number; in: number; out: number; cost: number | null; unknown: number }[],
      empty: string,
      cls: string,
    ) => {
      const content = el("div");
      if (rows.length === 0) {
        content.append(el("p", { class: "hint" }, [empty]));
      } else {
        const table = el("table", { class: `usage-table ${cls}`, "aria-label": `${title}: ${firstColumn}, runs, input tokens, output tokens, cost` }, [
          el("thead", {}, [el("tr", {}, [
            el("th", { scope: "col" }, [firstColumn]),
            el("th", { scope: "col", class: "usage-num" }, ["Runs"]),
            el("th", { scope: "col", class: "usage-num" }, ["Input tokens"]),
            el("th", { scope: "col", class: "usage-num" }, ["Output tokens"]),
            el("th", { scope: "col", class: "usage-num" }, ["Cost"]),
          ])]),
          el("tbody", {}, rows.map((r) => el("tr", {}, [
            el("td", { class: "usage-key", title: r.key }, [r.key]),
            el("td", { class: "usage-num", "data-v": String(r.runs) }, [String(r.runs)]),
            el("td", { class: "usage-num", title: `${r.in.toLocaleString()} input tokens` }, [fmtTok(r.in)]),
            el("td", { class: "usage-num", title: `${r.out.toLocaleString()} output tokens` }, [fmtTok(r.out)]),
            costCell(r.cost, r.unknown),
          ] as Node[])) as Node[]),
        ]);
        content.append(el("div", { class: "usage-tablewrap" }, [table]));
      }
      return el("div", { class: "setsec" }, [
        el("div", { class: "setsec__head" }, [
          el("span", { class: "cap" }, [title]),
          el("span", { class: "setsec__count" }, [note]),
        ]),
        content,
      ]);
    };

    body.append(
      section(
        "Daily rollup",
        `${plural(report.perDay.length, "day")} · newest first`,
        "Day",
        report.perDay.map((d: any) => ({ key: d.day, runs: d.runs, in: d.inputTokens, out: d.outputTokens, cost: d.costUsd, unknown: d.unknownPriceRuns })),
        "No runs recorded in this period.",
        "usage-table--daily",
      ),
      section(
        "Per session",
        `${plural(report.perSession.length, "session")} · by tokens`,
        "Session",
        report.perSession.map((x: any) => ({ key: x.session, runs: x.runs, in: x.inputTokens, out: x.outputTokens, cost: x.costUsd, unknown: x.unknownPriceRuns })),
        "No sessions with usage yet.",
        "usage-table--sessions",
      ),
      section(
        "Per model",
        `${plural(report.perModel.length, "model")} · by runs`,
        "Model",
        report.perModel.map((m: any) => ({ key: m.model, runs: m.runs, in: m.inputTokens, out: m.outputTokens, cost: m.costUsd, unknown: m.unknownPriceRuns })),
        "No models with usage yet.",
        "usage-table--models",
      ),
    );
    finish();
  }

  #usageExport(kind: "json" | "csv"): void {
    const report = this.#usageReport;
    if (!report) return;
    let content: string, mime: string, name: string;
    if (kind === "json") {
      content = JSON.stringify(report, null, 2);
      mime = "application/json";
      name = `usage-${this.#usageDays || "all"}d.json`;
    } else {
      const lines = ["day,runs,input_tokens,output_tokens,cost_usd"];
      for (const d of report.perDay) {
        lines.push(`${d.day},${d.runs},${d.inputTokens},${d.outputTokens},${d.costUsd === null ? "" : d.costUsd.toFixed(6)}`);
      }
      content = lines.join("\n");
      mime = "text/csv";
      name = `usage-daily-${this.#usageDays || "all"}d.csv`;
    }
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = el("a", { href: url, download: name }) as HTMLAnchorElement;
    document.body.append(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    toast(`usage exported (${name})`, "ok");
  }

  /** All-settings tab (P4 #32 — their schema-driven Settings): every config
   *  key renders from the config.schema descriptors (form mode), plus a raw
   *  JSON5 editor with validation (raw mode). Failed saves show the gateway's
   *  reason and keep the draft — their "Settings not applied" flow. */
  /** “All settings”: every leaf the config schema knows, editable, in the same
   *  card/section/field language as the rest of Settings.
   *
   *  The page is a *form over the schema*, so three rules keep it honest:
   *  - what it shows is the value the daemon is using (`config.get` is the
   *    parsed config, defaults filled in);
   *  - what it writes is only the rows the user actually changed (a record row
   *    that was never touched is never re-sent);
   *  - what it cannot do, it says: a bad number, a bad JSON blob or a rejection
   *    from the gateway is printed under the row, and the rest of the draft
   *    stays where it is. */
  async #renderConfigEditor(config: any): Promise<void> {
    let schema: any = null;
    let schemaErr = "";
    try {
      schema = (await gateway.request("config.schema", {}) as any).schema ?? null;
    } catch (err) {
      schemaErr = (err as Error).message;
      toast(`config.schema unavailable: ${schemaErr}`, "err");
    }
    const REDACTED_PREFIX = "__redacted__:";
    const isRedacted = (v: unknown): v is string => typeof v === "string" && v.startsWith(REDACTED_PREFIX);

    type Kind = "bool" | "num" | "str" | "text" | "enum" | "list" | "json";
    type CfgRow = {
      path: string;
      el: HTMLElement;
      control: HTMLElement;
      error: HTMLElement;
      initial: unknown;
      read: () => unknown;
      write: (value: unknown) => void;
    };
    const rows: CfgRow[] = [];
    const hiddenPaths: string[] = [];
    const fallbackFor = (node: any): unknown => {
      if (node?.t === "array") return [];
      if (node?.t === "record" || node?.t === "object") return {};
      return node?.default ?? "";
    };

    /* ---------------- toolbar ---------------- */

    const search = el("input", {
      class: "inp", id: "cfg-filter", type: "search",
      placeholder: "Filter settings…", "aria-label": "Filter settings",
    }) as HTMLInputElement;
    const countEl = el("span", { class: "setsec__count", "aria-live": "polite" }, [""]);
    const formBtn = el("button", { class: "btn cfg-mode is-active", type: "button", id: "cfg-mode-form", "aria-pressed": "true" }, ["Form"]) as HTMLButtonElement;
    const rawBtn = el("button", { class: "btn cfg-mode", type: "button", id: "cfg-mode-raw", "aria-pressed": "false" }, ["Raw"]) as HTMLButtonElement;
    const toolbar = el("div", { class: "cfg-toolbar" }, [search, countEl, formBtn, rawBtn]);

    const pageHint = el("p", { class: "hint" }, [
      "These are the values the daemon is using; a key the file leaves out shows its default. Only rows you change are written.",
    ]);
    const formHost = el("div", { class: "settings__stack", id: "cfg-form" });
    const emptyHint = el("p", { class: "hint", id: "cfg-empty", hidden: "" }, [""]);
    const saveNote = el("p", { class: "hint", id: "cfg-state", "aria-live": "polite" }, ["Everything is saved."]);
    const discardBtn = el("button", { class: "btn", type: "button", id: "cfg-discard" }, ["Discard"]) as HTMLButtonElement;
    const saveBtn = el("button", { class: "btn pri", type: "button", id: "cfg-save" }, ["Save changes"]) as HTMLButtonElement;
    const saveBar = el("div", { class: "cfg-savebar" }, [saveNote, discardBtn, saveBtn]);

    const rawBanner = el("div", { class: "cfg-banner", hidden: "" });
    const rawArea = el("textarea", { class: "inp mono", id: "cfg-raw-text", rows: "24", spellcheck: "false", "aria-label": "Raw JSON5 config" }) as HTMLTextAreaElement;
    const rawSave = el("button", { class: "btn pri", type: "button", id: "cfg-raw-apply" }, ["Apply raw config"]) as HTMLButtonElement;
    // It restores the document the form would write (which is the file, when the
    // form is clean). "Reload from file" would be a lie while edits are pending.
    const rawReload = el("button", { class: "btn", type: "button", id: "cfg-raw-reload" }, ["Reset text"]) as HTMLButtonElement;
    const rawCard = el("div", { class: "card" }, [
      el("div", { class: "setcard__head" }, [
        el("h3", {}, ["Raw config"]),
        el("p", { class: "hint" }, [
          "The whole file as JSON5, including the form's unsaved edits. Applying validates the document first; a rejected document never touches the running config.",
        ]),
      ]),
      rawBanner,
      rawArea,
      el("div", { class: "settings__actions" }, [rawReload, rawSave]),
    ]);
    const rawHost = el("div", { id: "cfg-raw", hidden: "" }, [rawCard]);

    /* ---------------- row builders ---------------- */

    /** One control's value in, one value out. `read` throws a sentence the row
     *  prints when the text cannot become the type the schema declares. */
    const markError = (row: CfgRow, message: string): void => {
      row.error.textContent = message;
      row.error.hidden = false;
      row.control.setAttribute("aria-invalid", "true");
    };
    const clearError = (row: CfgRow): void => {
      row.error.textContent = "";
      row.error.hidden = true;
      row.control.removeAttribute("aria-invalid");
    };

    const attach = (rowEl: HTMLElement, path: string, kind: Kind): void => {
      rowEl.dataset["cfgPath"] = path;
      rowEl.dataset["cfgKind"] = kind;
      // The attribute form is part of the page's contract (tests and the save
      // walk both target `[data-cfg-kind]`), so set it as well as the dataset.
      rowEl.setAttribute("data-cfg-kind", kind);
    };

    const buildLeaf = (path: string, node: any, cur: unknown): HTMLElement => {
      // The per-leaf id is part of the page's contract: a control is addressable
      // by the dotted key it writes.
      const leaf = { id: `cfg-${path}`, label: humanKey(path.split(".").pop() ?? path) };
      const { id, label } = leaf;
      const kind: Kind =
        node.t === "bool" ? "bool"
        : node.t === "int" || node.t === "float" ? "num"
        : node.t === "enum" ? "enum"
        : node.t === "string" ? "str"
        : node.t === "text" ? "text"
        : node.t === "array" && node.of?.t === "string" ? "list"
        : "json";
      const error = el("p", { class: "hint hint--err", hidden: "" });
      const redacted = isRedacted(cur);

      if (kind === "bool") {
        const box = el("input", { type: "checkbox", id }) as HTMLInputElement;
        const initial = Boolean(cur);
        box.checked = initial;
        const rowEl = el("div", { class: "row" }, [
          el("div", { class: "row__main" }, [
            el("label", { class: "row__label", for: id }, [label]),
          ]),
          box,
          error,
        ]);
        attach(rowEl, path, kind);
        rows.push({
          path, el: rowEl, control: box, error, initial,
          read: () => box.checked,
          write: (value) => { box.checked = Boolean(value); },
        });
        return rowEl;
      }

      let control: HTMLElement;
      let initial: unknown;
      let read: () => unknown;
      let write: (value: unknown) => void;
      let hint = "";

      if (kind === "num") {
        const input = el("input", { class: "inp mono", id, inputmode: "decimal", autocomplete: "off" }) as HTMLInputElement;
        const start = cur === undefined || cur === null || cur === "" ? "" : String(cur);
        input.value = start;
        initial = start === "" ? null : Number(start);
        const min = typeof node.min === "number" ? node.min : undefined;
        const max = typeof node.max === "number" ? node.max : undefined;
        hint = min !== undefined && max !== undefined ? `${min} to ${max}.` : min !== undefined ? `At least ${min}.` : max !== undefined ? `At most ${max}.` : "";
        read = (): unknown => {
          const text = input.value.trim();
          if (text === "") return initial; // a blank field keeps what is stored
          const n = Number(text);
          if (!Number.isFinite(n)) throw new Error("Enter a number.");
          if (min !== undefined && n < min) throw new Error(`Enter a number between ${min} and ${max ?? "…"}.`);
          if (max !== undefined && n > max) throw new Error(`Enter a number between ${min ?? "…"} and ${max}.`);
          return n;
        };
        write = (value) => { input.value = value === null || value === undefined ? "" : String(value); };
        control = input;
      } else if (kind === "enum") {
        const dd = this.#dropdown({
          id,
          value: String(cur ?? node.default ?? ""),
          label,
          placeholder: String(node.default ?? "choose one"),
          options: (node.values ?? []).map((v: string) => ({ value: v, label: humanKey(v) })),
        });
        initial = dd.sel.value;
        read = () => dd.sel.value;
        write = (value) => { dd.set(String(value ?? "")); };
        control = dd.node;
      } else if (kind === "list") {
        const area = el("textarea", { class: "inp mono", id, rows: "3", spellcheck: "false" }) as HTMLTextAreaElement;
        const start = Array.isArray(cur) ? cur.map(String) : [];
        area.value = start.join("\n");
        initial = start;
        hint = "One entry per line.";
        read = () => area.value.split("\n").map((v) => v.trim()).filter(Boolean);
        write = (value) => { area.value = (Array.isArray(value) ? value.map(String) : []).join("\n"); };
        control = area;
      } else if (kind === "json") {
        const area = el("textarea", { class: "inp mono", id, rows: "3", spellcheck: "false" }) as HTMLTextAreaElement;
        const start = cur === undefined ? fallbackFor(node) : cur;
        area.value = JSON.stringify(cur === undefined ? fallbackFor(node) : start, null, 2);
        initial = JSON.parse(JSON.stringify(start ?? null));
        hint = "JSON; the whole record is replaced when this row is saved.";
        read = () => {
          try {
            return JSON.parse(area.value);
          } catch (err) {
            throw new Error(`Not valid JSON — ${(err as Error).message}.`);
          }
        };
        write = (value) => { area.value = JSON.stringify(value ?? null, null, 2); };
        control = area;
      } else if (kind === "text") {
        const area = el("textarea", { class: "inp mono", id, rows: "3" }) as HTMLTextAreaElement;
        area.value = redacted ? "" : String(cur ?? "");
        initial = redacted ? "" : String(cur ?? "");
        if (redacted) area.setAttribute("placeholder", `${String(cur).slice(REDACTED_PREFIX.length)} — stored; leave blank to keep`);
        read = () => area.value;
        write = (value) => { area.value = String(value ?? ""); };
        control = area;
      } else {
        const input = el("input", { class: "inp mono", id, autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
        input.value = redacted ? "" : String(cur ?? "");
        initial = redacted ? "" : String(cur ?? "");
        if (redacted) input.setAttribute("placeholder", `${String(cur).slice(REDACTED_PREFIX.length)} — stored; leave blank to keep`);
        read = () => input.value;
        write = (value) => { input.value = String(value ?? ""); };
        control = input;
      }

      const rowEl = this.#setField(id, label, control, hint, kind === "enum" ? null : id);
      rowEl.append(error);
      attach(rowEl, path, kind);
      if (redacted) rowEl.setAttribute("data-cfg-redacted", "1");
      rows.push({ path, el: rowEl, control, error, initial, read, write });
      return rowEl;
    };

    /** Walk one schema node into `into`. Objects become `.cfg-group` boxes with
     *  the dotted path beside the title, so a row's key is never a guess. */
    const walk = (node: any, path: string, cur: unknown, into: HTMLElement): void => {
      if (!node || typeof node !== "object" || node.hidden === true) {
        if (node?.hidden === true) hiddenPaths.push(path);
        return;
      }
      if (node.t !== "object") {
        into.append(buildLeaf(path, node, cur));
        return;
      }
      const box = el("div", { class: "cfg-group", "data-cfg-group": path });
      box.append(el("div", { class: "cfg-group__title" }, [
        el("span", {}, [humanKey(path.split(".").pop() ?? path)]),
        el("span", { class: "setcard__echo" }, [path]),
      ]));
      const obj = (cur && typeof cur === "object" ? cur : {}) as Record<string, unknown>;
      for (const [key, child] of Object.entries(node.fields ?? {})) {
        walk(child, path ? `${path}.${key}` : key, obj[key] ?? (child as any).default, box);
      }
      into.append(box);
    };

    /* ---------------- the form ---------------- */

    if (schema?.fields) {
      for (const [section, node] of Object.entries(schema.fields)) {
        const card = el("div", { class: "card cfg-section", "data-cfg-section": section });
        const head = el("div", { class: "setcard__head" }, [el("h3", {}, [humanKey(section)])]);
        card.append(head);
        const before = rows.length;
        const cur = (config as Record<string, unknown>)?.[section];
        if ((node as any).t === "object") {
          for (const [key, child] of Object.entries(((node as any).fields ?? {}) as Record<string, any>)) {
            walk(child, `${section}.${key}`, (cur as any)?.[key] ?? child.default, card);
          }
        } else {
          walk(node, section, cur, card);
        }
        const n = rows.length - before;
        head.append(el("p", { class: "hint" }, [`${n} setting${n === 1 ? "" : "s"}`]));
        formHost.append(card);
      }
      if (hiddenPaths.length > 0) {
        formHost.append(el("div", { class: "card cfg-viewonly" }, [
          el("div", { class: "setcard__head" }, [
            el("h3", {}, ["Not edited here"]),
            el("p", { class: "hint" }, [
              `${hiddenPaths.length} key${hiddenPaths.length === 1 ? " is" : "s are"} stored in the file but marked view-only. Raw shows ${hiddenPaths.length === 1 ? "it" : "them"} as authored.`,
            ]),
          ]),
          el("pre", { class: "diary__body" }, [hiddenPaths.join("\n")]),
        ]));
      }
      formHost.append(emptyHint);
    } else {
      formHost.append(el("div", { class: "card" }, [
        el("div", { class: "setcard__head" }, [
          el("h3", {}, ["Schema unavailable"]),
          el("p", { class: "hint" }, [
            `The config schema could not be read${schemaErr ? ` — ${schemaErr}` : ""}. Raw still edits the file.`,
          ]),
        ]),
      ]));
      formBtn.disabled = true;
      search.disabled = true;
      saveBar.hidden = true;
      pageHint.hidden = true;
    }

    /* ---------------- state ---------------- */

    const pendingRows = (): CfgRow[] => rows.filter((row) => {
      try {
        return !sameValue(row.read(), row.initial);
      } catch {
        return true;
      }
    });
    const draftDocument = (): Record<string, unknown> => {
      const doc = JSON.parse(JSON.stringify(config ?? {})) as Record<string, unknown>;
      for (const row of rows) {
        try {
          const value = row.read();
          if (!sameValue(value, row.initial)) setIn(doc, row.path, value);
        } catch { /* an invalid row keeps its saved value; Raw cannot apply nonsense */ }
      }
      return doc;
    };
    const serialize = (): string => JSON.stringify(draftDocument(), null, 2);
    const rawDirty = (): boolean => !rawHost.hidden && rawArea.value !== serialize();

    const updateFooter = (): void => {
      const pending = pendingRows().length + (rawDirty() ? 1 : 0);
      saveNote.textContent = pending === 0
        ? "Everything is saved."
        : `${pending} change${pending === 1 ? "" : "s"} not saved.`;
      saveBtn.disabled = pending === 0;
      discardBtn.disabled = pending === 0;
      rawReload.disabled = rawArea.value === serialize();
      const shown = rows.filter((row) => !row.el.hidden).length;
      countEl.textContent = rows.length === 0 ? ""
        : search.value.trim() ? `${shown} of ${rows.length} shown`
        : `${rows.length} settings`;
    };

    const focusRow = (row: CfgRow): void => {
      // A row hidden by the filter must be brought back before it is blamed.
      if (row.el.hidden) {
        search.value = "";
        applyFilter();
      }
      (row.control.querySelector("input, textarea, select, button") as HTMLElement | null)?.focus?.();
      row.el.scrollIntoView?.({ block: "center" });
    };

    /* ---------------- filter (a view, never a gate) ---------------- */

    const applyFilter = (): void => {
      const q = search.value.trim().toLowerCase();
      for (const card of Array.from(formHost.querySelectorAll<HTMLElement>(".cfg-section"))) {
        let visible = 0;
        for (const row of Array.from(card.querySelectorAll<HTMLElement>("[data-cfg-path]"))) {
          const hit = !q || (row.dataset["cfgPath"] ?? "").toLowerCase().includes(q);
          row.hidden = !hit;
          if (hit) visible += 1;
        }
        for (const group of Array.from(card.querySelectorAll<HTMLElement>(".cfg-group"))) {
          group.hidden = !group.querySelector("[data-cfg-path]:not([hidden])");
        }
        card.hidden = visible === 0;
      }
      const anyVisible = rows.some((row) => !row.el.hidden);
      emptyHint.hidden = anyVisible || rows.length === 0;
      emptyHint.textContent = anyVisible ? "" : `Nothing matches “${search.value.trim()}”.`;
      updateFooter();
    };
    search.addEventListener("input", applyFilter);

    /* ---------------- discard ---------------- */

    discardBtn.onclick = () => {
      for (const row of rows) {
        row.write(row.initial);
        clearError(row);
      }
      rawBanner.hidden = true;
      updateFooter();
    };

    /* ---------------- save ---------------- */

    saveBtn.onclick = async () => {
      for (const row of rows) clearError(row);
      const changed: CfgRow[] = [];
      for (const row of rows) {
        try {
          if (!sameValue(row.read(), row.initial)) changed.push(row);
        } catch (err) {
          markError(row, (err as Error).message);
          focusRow(row);
          saveNote.textContent = "Nothing was sent — fix the highlighted row first.";
          return;
        }
      }
      if (changed.length === 0) {
        toast("no changes", "info");
        updateFooter();
        return;
      }
      saveBtn.disabled = true;
      let saved = 0;
      for (const row of changed) {
        try {
          const value = row.read();
          await gateway.request("config.set", { path: row.path, value });
          row.initial = value;
          saved += 1;
          updateFooter();
        } catch (err) {
          markError(row, (err as Error).message);
          focusRow(row);
          saveNote.textContent = `${saved} saved, ${changed.length - saved} not saved: ${row.path} — ${(err as Error).message}`;
          if (saved > 0) this.#onChanged();
          saveBtn.disabled = false;
          toast(`${row.path} not saved: ${(err as Error).message}`, "err");
          return;
        }
      }
      toast(`${saved} setting${saved === 1 ? "" : "s"} saved`, "ok");
      this.#onChanged();
      void this.render();
    };

    /* ---------------- Form ⇄ Raw ---------------- */

    const setMode = (raw: boolean): void => {
      formHost.hidden = raw;
      saveBar.hidden = raw;
      rawHost.hidden = !raw;
      // The filter and the count describe the form; the page hint describes the
      // form's diff. Raw brings its own sentence, so they step aside with it.
      search.hidden = raw;
      countEl.hidden = raw;
      pageHint.hidden = raw;
      formBtn.classList.toggle("is-active", !raw);
      rawBtn.classList.toggle("is-active", raw);
      formBtn.setAttribute("aria-pressed", String(!raw));
      rawBtn.setAttribute("aria-pressed", String(raw));
      if (raw) {
        rawArea.value = serialize();
        rawBanner.hidden = true;
      }
      updateFooter();
    };
    rawHost.hidden = true;
    formBtn.onclick = () => {
      const bad = rows.find((row) => !row.error.hidden);
      if (bad) {
        toast("Fix the highlighted row first.", "err");
        focusRow(bad);
        return;
      }
      if (rawDirty()) {
        toast("The raw text has unsaved edits — apply or reload it first.", "err");
        return;
      }
      setMode(false);
    };
    rawBtn.onclick = () => setMode(true);

    rawReload.onclick = () => {
      rawArea.value = serialize();
      rawBanner.hidden = true;
      updateFooter();
    };
    rawSave.onclick = async () => {
      rawBanner.hidden = true;
      rawSave.disabled = true;
      try {
        await gateway.request("config.replace", { text: rawArea.value });
        toast("config applied", "ok");
        this.#onChanged();
        void this.render();
      } catch (err) {
        rawBanner.textContent = `Settings not applied: ${(err as Error).message}`;
        rawBanner.hidden = false;
      } finally {
        rawSave.disabled = false;
      }
    };

    // Keystrokes move the footer's count; one delegated listener for 149 rows.
    formHost.addEventListener("input", updateFooter);
    formHost.addEventListener("change", updateFooter);
    rawArea.addEventListener("input", updateFooter);

    /* ---------------- assembly ---------------- */

    this.#root.append(el("div", { class: "settings__stack" }, [toolbar, pageHint, formHost, saveBar, rawHost]));

    // A draft that never reached the file blocks a section change (render()
    // reverts the tab and says so) instead of vanishing on the next render.
    this.#configDirty = () => {
      const pending = pendingRows().length;
      if (pending > 0) return `${pending} unsaved change${pending === 1 ? "" : "s"} — save or discard them first.`;
      if (rawDirty()) return "The raw text has unsaved edits — apply or reload them first.";
      return "";
    };

    updateFooter();
  }

  /** Channels tab (P4 #31 — their Channels pages, scoped to our one channel):
   *  every channels.telegram.* key editable; the token edits through the
   *  redaction sentinel so it never crosses the socket, and the hint points
   *  at \${ENV}/SecretRef storage (P3 #30) instead of plaintext. */
  #renderChannels(channels: any): void {
    const tg = channels.telegram ?? {};
    const typing = tg.typing ?? {};
    const blp = tg.botLoopProtection ?? {};

    const check = (labelText: string, key: string, cur: boolean, hint?: string) => {
      const box = el("input", { type: "checkbox", id: `ch-${key}` }) as HTMLInputElement;
      box.checked = cur;
      return el("div", { class: "row", "data-ch-key": key, "data-ch-kind": "bool" }, [
        el("span", { class: "row__label" }, [labelText]),
        el("span", { class: "row__value" }, [box]),
        ...(hint ? [el("p", { class: "hint" }, [hint])] : []),
      ]);
    };
    // Numbers carry their schema bounds: the save refuses to send a blank or
    // out-of-range value instead of letting `Number(x) || 0` turn it into 0 and
    // bounce off the gateway halfway through the form.
    const num = (labelText: string, key: string, cur: number, opts: { min: number; max: number; hint?: string }) => {
      const inp = el("input", {
        class: "inp mono", id: `ch-${key}`, value: String(cur ?? 0), inputmode: "numeric", autocomplete: "off",
      }) as HTMLInputElement;
      return el("div", {
        class: "modal__field", "data-ch-key": key, "data-ch-kind": "num",
        "data-ch-min": String(opts.min), "data-ch-max": String(opts.max), "data-ch-label": labelText,
      }, [
        el("label", { class: "lbl", for: `ch-${key}` }, [labelText]),
        inp,
        ...(opts.hint ? [el("p", { class: "hint" }, [opts.hint])] : []),
      ]);
    };
    const pick = (labelText: string, key: string, cur: string, options: string[], hint?: string) => {
      const sel = el("select", { class: "inp", id: `ch-${key}` }) as HTMLSelectElement;
      for (const opt of options) sel.append(el("option", { value: opt, ...(opt === cur ? { selected: "" } : {}) }, [opt]));
      return el("div", { class: "modal__field", "data-ch-key": key, "data-ch-kind": "str" }, [
        el("label", { class: "lbl", for: `ch-${key}` }, [labelText]),
        sel,
        ...(hint ? [el("p", { class: "hint" }, [hint])] : []),
      ]);
    };
    const list = (labelText: string, key: string, cur: string[], hint?: string) => {
      const ta = el("textarea", { class: "inp mono", id: `ch-${key}`, rows: "3" }) as HTMLTextAreaElement;
      ta.value = (cur ?? []).join("\n");
      return el("div", { class: "modal__field", "data-ch-key": key, "data-ch-kind": "list" }, [
        el("label", { class: "lbl", for: `ch-${key}` }, [labelText]),
        ta,
        ...(hint ? [el("p", { class: "hint" }, [hint])] : []),
      ]);
    };

    const tokenInp = el("input", {
      class: "inp mono", id: "ch-token", type: "password",
      placeholder: tg.token ? "leave blank to keep current token" : "123456:ABC…",
    }) as HTMLInputElement;
    const tokenHint = el("p", { class: "hint" }, [
      tg.token
        ? `Saved token ends …${String(tg.token).slice(-4)}. Paste a new one, or put \${TELEGRAM_TOKEN} / a SecretRef in config.json5 (see: sc secrets refs).`
        : "From @BotFather. To keep it out of config.json5 put \${TELEGRAM_TOKEN} or a SecretRef there instead (see: sc secrets refs).",
    ]);
    const problem = el("p", { class: "hint hint--err", role: "alert", hidden: "" }, []);
    let saving = false;

    const save = el("button", { class: "btn pri", type: "button" }, ["Save channel settings"]);
    save.onclick = async () => {
      if (saving) return;
      // ONE write for the whole block. This used to post one config.set per
      // control, so a single bad value was rejected halfway and left a channel
      // that matched neither the page nor the old config — silently.
      const block: Record<string, unknown> = structuredClone((channels.telegram ?? {}) as Record<string, unknown>);
      const relOf = (key: string): string => key.replace(/^channels\.telegram\./, "");
      const bad: { label: string; input: HTMLInputElement }[] = [];
      for (const node of Array.from(this.#root.querySelectorAll<HTMLElement>("[data-ch-key]"))) {
        const kind = node.dataset["chKind"]!;
        const rel = relOf(String(node.dataset["chKey"]!));
        const input = node.querySelector("input, textarea, select") as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
        if (!input) continue;
        if (kind === "bool") {
          setIn(block, rel, (input as HTMLInputElement).checked);
        } else if (kind === "num") {
          input.removeAttribute("aria-invalid");
          const raw = String(input.value).trim();
          const n = Number(raw);
          const min = Number(node.dataset["chMin"]);
          const max = Number(node.dataset["chMax"]);
          if (raw === "" || !Number.isFinite(n) || n < min || n > max) {
            input.setAttribute("aria-invalid", "true");
            bad.push({ label: String(node.dataset["chLabel"] ?? rel), input: input as HTMLInputElement });
          } else {
            setIn(block, rel, Math.round(n));
          }
        } else if (kind === "list") {
          setIn(block, rel, (input as HTMLTextAreaElement).value.split("\n").map((v) => v.trim()).filter(Boolean));
        } else {
          setIn(block, rel, String(input.value).trim());
        }
      }
      if (bad.length) {
        problem.textContent = `Not saved — ${bad.map((b) => b.label.toLowerCase()).join(", ")} ${bad.length === 1 ? "is" : "are"} outside the allowed range.`;
        problem.removeAttribute("hidden");
        bad[0]?.input.focus();
        return;
      }
      problem.textContent = "";
      problem.setAttribute("hidden", "");
      const typedToken = tokenInp.value.trim();
      // Blank field = keep the stored token: the redacted sentinel rides along in
      // the block and config.set resolves it server-side. This is the one
      // control that is not simply read off the page.
      if (typedToken) setIn(block, relOf("channels.telegram.token"), typedToken);
      const wantOn = Boolean(block["enabled"]);
      saving = true;
      save.disabled = true;
      save.textContent = "Saving…";
      try {
        await gateway.request("config.set", { path: "channels.telegram", value: block });
        // Show what was stored (ints), not what was typed.
        for (const node of Array.from(this.#root.querySelectorAll<HTMLElement>('[data-ch-key][data-ch-kind="num"]'))) {
          const stored = readIn(block, relOf(String(node.dataset["chKey"]!)));
          const input = node.querySelector("input") as HTMLInputElement | null;
          if (input && typeof stored === "number") input.value = String(stored);
        }
        if (typedToken) {
          tokenInp.value = "";
          tokenInp.placeholder = "leave blank to keep current token";
          tokenHint.textContent = `Saved token ends …${typedToken.slice(-4)}. Paste a new one, or put \${TELEGRAM_TOKEN} / a SecretRef in config.json5 (see: sc secrets refs).`;
        }
        toast(wantOn ? "channel settings saved — telegram reconnects now" : "channel settings saved — telegram is off", "ok");
        this.#onChanged();
        // Authoritative reconnect: it returns the real outcome (and diagnoses a
        // blocked network or a dead proxy) instead of leaving a silent watcher.
        if (wantOn) connectBtn.click();
        else void refreshStatus();
      } catch (err) {
        // Beside the button as well as in a toast: a toast is gone in a few
        // seconds, and "was it saved?" must stay answerable.
        problem.textContent = `not saved — ${(err as Error).message}`;
        problem.removeAttribute("hidden");
        toast(`not saved — ${(err as Error).message}`, "err");
      } finally {
        saving = false;
        save.disabled = false;
        save.textContent = "Save channel settings";
      }
    };

    // Live channel status + one-tap connect (their Settings → Channels card
    // shows connected/offline with the real reason, and a Connect action).
    const statusRow = el("div", { class: "row diag-row", id: "tg-status" }, [
      el("span", { class: "diag-mark diag-mark--warn" }, ["…"]),
      el("span", { class: "row__label" }, ["Checking channel status…"]),
    ]);
    const refreshStatus = async (): Promise<void> => {
      try {
        const res = (await gateway.request("channels.status")) as { telegram: { enabled: boolean; hasToken: boolean; running: boolean; username: string; error: string } };
        const st = res.telegram;
        statusRow.innerHTML = "";
        statusRow.append(
          el("span", { class: `diag-mark diag-mark--${!st.enabled ? "warn" : st.running ? "ok" : "fail"}` }, [!st.enabled ? "▲" : st.running ? "✔" : "✖"]),
          el("span", { class: "row__label" }, [
            !st.enabled
              ? "Telegram channel is disabled — tick Enable and save below."
              : st.running
                ? `Connected${st.username ? ` as @${st.username}` : ""}`
                : `Offline${st.error ? ` — ${st.error}` : " (not connected)"}`,
          ]),
        );
      } catch {
        statusRow.innerHTML = "";
        statusRow.append(el("span", { class: "hint" }, ["gateway offline — status unavailable"]));
      }
    };
    const connectBtn = el("button", { class: "btn pri", type: "button", id: "tg-connect" }, ["Connect now"]) as HTMLButtonElement;
    connectBtn.onclick = async () => {
      connectBtn.disabled = true;
      try {
        const res = (await gateway.request("channels.telegram.connect")) as { ok: boolean; username?: string; error?: string };
        const handle = String(res.username ?? "").trim();
        if (res.ok) toast(handle ? `telegram connected as @${handle}` : "telegram connected", "ok");
        else toast(`telegram connect failed: ${res.error ?? "unknown"}`, "err");
      } catch (err) {
        toast((err as Error).message, "err");
      } finally {
        connectBtn.disabled = false;
        void refreshStatus();
      }
    };
    void refreshStatus();

    this.#root.append(
      el("div", { class: "card" }, [
        el("h3", {}, ["Connection"]),
        statusRow,
        el("div", { class: "row row--actions" }, [
          connectBtn,
          el("p", { class: "hint" }, ["Applies the saved config right away — no gateway restart needed. `sc channels status` prints the same state."]),
        ]),
      ]),
      el("div", { class: "card" }, [
        el("h3", {}, ["Telegram"]),
        check("Enable the channel", "channels.telegram.enabled", Boolean(tg.enabled)),
        el("div", { class: "modal__field" }, [
          el("label", { class: "lbl", for: "ch-token" }, ["Bot token"]),
          tokenInp,
          tokenHint,
        ]),
        (() => {
          const inp = el("input", { class: "inp mono", id: "ch-proxy", value: String(tg.proxy ?? ""), placeholder: "http://127.0.0.1:8080  (empty = direct)" });
          return el("div", { class: "modal__field", "data-ch-key": "channels.telegram.proxy", "data-ch-kind": "str" }, [
            el("label", { class: "lbl", for: "ch-proxy" }, ["API proxy (optional)"]),
            inp,
            el("p", { class: "hint" }, [
              "Where api.telegram.org is blocked by the carrier, route the bot through a HTTP(S)/SOCKS proxy (a local VPN app's HTTP port works). TELEGRAM_PROXY / HTTPS_PROXY env also apply.",
            ]),
          ]);
        })(),
        pick("DM policy", "channels.telegram.dmPolicy", tg.dmPolicy ?? "pairing", ["pairing", "open", "allowlist"],
          "pairing asks new senders to pair; open replies to everyone; allowlist replies only to the list below."),
        list("DM allowlist (user ids or @names, one per line)", "channels.telegram.allowFrom", tg.allowFrom ?? []),
        pick("Group policy", "channels.telegram.groupPolicy", tg.groupPolicy ?? "allowlist", ["allowlist", "open", "off"]),
        list("Group allowlist (chat ids, one per line)", "channels.telegram.groupAllowFrom", tg.groupAllowFrom ?? []),
        check("Only respond when mentioned in groups", "channels.telegram.mentionGated", Boolean(tg.mentionGated ?? true)),
        check("Allow bot senders", "channels.telegram.allowBots", Boolean(tg.allowBots),
          "Off ignores messages from other bots."),
      ]),
      el("div", { class: "card" }, [
        el("h3", {}, ["Messages"]),
        pick("Draft streaming to Telegram", "channels.telegram.streaming", tg.streaming ?? "off", ["off", "partial", "progress"]),
        num("Batch window (ms)", "channels.telegram.batchMs", tg.batchMs ?? 0, {
          min: 0, max: 5000, hint: "Rapid-fire messages are merged before one reply. 0 disables batching.",
        }),
        pick("Typing indicator", "channels.telegram.typing.mode", typing.mode ?? "instant", ["instant", "thinking", "message", "never"],
          "instant on receive; thinking on first model output; message only beside replies; never."),
        num("Typing refresh (seconds)", "channels.telegram.typing.intervalSeconds", typing.intervalSeconds ?? 5, { min: 1, max: 30 }),
        num("Media size cap (MB)", "channels.telegram.mediaMaxMb", tg.mediaMaxMb ?? 10, { min: 1, max: 100 }),
        check("Send photos to the vision model", "channels.telegram.vision", Boolean(tg.vision ?? true),
          "When off, photos are described by media understanding only."),
      ]),
      el("div", { class: "card" }, [
        el("h3", {}, ["Bot-loop protection"]),
        check("Enable", "channels.telegram.botLoopProtection.enabled", Boolean(blp.enabled ?? true),
          "Drops feedback loops when a partner bot answers every message."),
        num("Max events per window", "channels.telegram.botLoopProtection.maxEventsPerWindow", blp.maxEventsPerWindow ?? 10, { min: 1, max: 1000 }),
        num("Window (seconds)", "channels.telegram.botLoopProtection.windowSeconds", blp.windowSeconds ?? 60, { min: 5, max: 3600 }),
        num("Cooldown (seconds)", "channels.telegram.botLoopProtection.cooldownSeconds", blp.cooldownSeconds ?? 300, { min: 5, max: 86400 }),
      ]),
      problem,
      save,
    );
  }

  /** Gateway tab (their Gateway page): how the daemon listens, who may connect,
   *  and which surfaces it serves.
   *
   *  One card, five sections, one commit — every setting here shapes the same
   *  thing and a restart applies all of it at once, so five footers would only
   *  mean five saves for one restart. The status strip describes the *saved*
   *  listener and follows the draft: the exposure of a control is the reason to
   *  show it at the moment it is chosen. */
  #renderGateway(gw: any, configPath = ""): void {
    const savedPort = String(gw.port ?? 18790);
    const savedBind = String(gw.bind ?? "loopback") === "lan" ? "lan" : "loopback";
    const savedMode = String(gw.auth?.mode ?? "token") === "none" ? "none" : "token";
    const rawToken = String(gw.auth?.token ?? "");
    // config.get masks the token as `__redacted__:••••wxyz`; the tail is the only
    // part the page is allowed to know, and the field stays write-only.
    const tokenTail = rawToken.startsWith("__redacted__:")
      ? rawToken.slice("__redacted__:".length).replace(/^•+/, "")
      : rawToken.slice(-4);

    const strip = this.#statusStrip();
    /** What the band says when there is nothing to report. It comes back after a
     *  save, because #commit blanks the note and an empty band says nothing. */
    const RESTING = "Every change is written to the config file at once; port and bind wait for a restart.";
    const note = el("span", { class: "setfoot__note", "aria-live": "polite" }, [RESTING]);
    const problem = el("p", { class: "hint hint--err" }, []);
    problem.setAttribute("hidden", "");

    /* ---- controls ---- */

    const portIn = el("input", {
      class: "inp mono",
      id: "gw-port",
      value: savedPort,
      inputmode: "numeric",
      autocomplete: "off",
      spellcheck: "false",
    }) as HTMLInputElement;
    const addrEcho = el("span", { class: "setcard__echo" }, [savedBind === "lan" ? `ws://0.0.0.0:${savedPort}` : `ws://localhost:${savedPort}`]);
    const portErr = el("p", { class: "hint hint--err" }, []);
    portErr.setAttribute("hidden", "");

    const bindDd = this.#dropdown({
      id: "gw-bind",
      value: savedBind,
      label: "Bind",
      placeholder: "loopback",
      options: [
        { value: "loopback", label: "loopback — this machine only" },
        { value: "lan", label: "lan — anywhere on your network" },
      ],
    });

    const modeDd = this.#dropdown({
      id: "gw-mode",
      value: savedMode,
      label: "Auth mode",
      placeholder: "token",
      options: [
        { value: "token", label: "token — every client sends the token" },
        { value: "none", label: "none — anything that reaches the port gets in" },
      ],
    });
    const modeWarn = el("p", { class: "hint is-warn" }, [
      "Auth is off. Anything that can reach the port can drive the agent; the token below is kept but never checked.",
    ]);
    modeWarn.setAttribute("hidden", "");

    const tokenIn = el("input", {
      class: "inp mono",
      id: "gw-token-new",
      type: "password",
      placeholder: "leave blank to keep the stored one",
      autocomplete: "off",
    }) as HTMLInputElement;
    const tokenEcho = el("span", { class: "setcard__echo" }, [tokenTail ? `stored — ends in ${tokenTail}` : "none stored"]);

    const bypassCb = el("input", { type: "checkbox", id: "gw-bypass" }) as HTMLInputElement;
    bypassCb.checked = gw.auth?.loopbackBypass !== false;

    const hostsIn = el("input", {
      class: "inp mono",
      id: "gw-hosts",
      value: (gw.allowedHosts ?? []).join(", "),
      placeholder: "blank — loopback and private names only",
      autocomplete: "off",
      spellcheck: "false",
    }) as HTMLInputElement;
    const hostsEcho = el("span", { class: "setcard__echo" }, [""]);

    const originsIn = el("input", {
      class: "inp mono",
      id: "gw-origins",
      value: (gw.allowedOrigins ?? []).join(", "),
      placeholder: "blank — same origin only",
      autocomplete: "off",
      spellcheck: "false",
    }) as HTMLInputElement;
    const originsEcho = el("span", { class: "setcard__echo" }, [""]);

    const uiCb = el("input", { type: "checkbox", id: "gw-cui" }) as HTMLInputElement;
    uiCb.checked = gw.controlUi?.enabled !== false;
    const baseIn = el("input", {
      class: "inp mono",
      id: "gw-basepath",
      value: String(gw.controlUi?.basePath ?? ""),
      placeholder: "blank — served at the root",
      autocomplete: "off",
      spellcheck: "false",
    }) as HTMLInputElement;
    const baseEcho = el("span", { class: "setcard__echo" }, [""]);
    const baseErr = el("p", { class: "hint hint--err" }, []);
    baseErr.setAttribute("hidden", "");

    const httpCb = el("input", { type: "checkbox", id: "gw-openai" }) as HTMLInputElement;
    httpCb.checked = Boolean(gw.http?.endpoints?.chatCompletions?.enabled);
    const httpWarn = el("p", { class: "hint is-warn" }, [
      "The endpoint answers 503 until a token is set; it never serves anonymous requests.",
    ]);
    httpWarn.setAttribute("hidden", "");

    /* ---- derived, live ---- */

    const list = (raw: string): string[] => raw.split(",").map((s) => s.trim()).filter(Boolean);
    /** A Host entry is a bare name with an optional port — `hostnameOf()` strips
     *  the port and lowercases, so a scheme or a path here could never match. */
    const okHost = (h: string): boolean =>
      /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?(:\d{1,5})?$/.test(h) || /^\[[0-9a-fA-F:]+\](:\d{1,5})?$/.test(h);
    /** An origin must parse as a URL — `originAllowed()` silently skips the ones
     *  that do not, so a scheme-less entry would just never match. */
    const okOrigin = (o: string): boolean => {
      try {
        const u = new URL(o);
        return u.protocol === "http:" || u.protocol === "https:";
      } catch {
        return false;
      }
    };
    /** The port the page is talking about — the saved one while the field holds
     *  something that is not a port yet, so the address never reads `:abc`. */
    const shownPort = (): string => {
      const raw = portIn.value.trim();
      return /^\d{1,5}$/.test(raw) ? raw : savedPort;
    };
    const currentBind = (): "loopback" | "lan" => (this.#selValue(bindDd.sel) === "lan" ? "lan" : "loopback");
    const currentMode = (): "token" | "none" => (this.#selValue(modeDd.sel) === "none" ? "none" : "token");

    const syncStatus = (): void => {
      const p = shownPort();
      // Auth off is its own warning, written once under the mode control; the
      // strip states the exposure and stops there rather than repeating it.
      const noAuth = currentMode() === "none";
      if (currentBind() === "lan") {
        strip.set(
          "network",
          "is-warn",
          noAuth
            ? `0.0.0.0:${p} — reachable from your network, and auth is off.`
            : `0.0.0.0:${p} — reachable from your network; clients still send the token.`,
        );
        return;
      }
      strip.set(
        "local only",
        noAuth ? "is-warn" : "is-ok",
        noAuth
          ? `127.0.0.1:${p} — this machine only, but auth is off.`
          : `127.0.0.1:${p} — this machine only; every client sends the token.`,
      );
    };

    const syncAddress = (): void => {
      addrEcho.textContent = currentBind() === "lan" ? `ws://0.0.0.0:${shownPort()}` : `ws://localhost:${shownPort()}`;
      syncStatus();
    };

    const syncEchoes = (): void => {
      const hosts = list(hostsIn.value);
      hostsEcho.textContent = hosts.length === 0
        ? "blank — loopback and private names only"
        : `${hosts.length} extra ${hosts.length === 1 ? "host" : "hosts"}`;
      const origins = list(originsIn.value);
      originsEcho.textContent = origins.length === 0
        ? "blank — same origin only"
        : `${origins.length} extra ${origins.length === 1 ? "origin" : "origins"}`;
      // What the prefix resolves to, so the path is never a guess.
      const raw = baseIn.value.trim().replace(/\/$/, "");
      baseEcho.textContent = raw === "" ? "/" : `${raw}/`;
      syncAddress();
    };

    const syncWarnings = (): void => {
      if (currentMode() === "none") modeWarn.removeAttribute("hidden");
      else modeWarn.setAttribute("hidden", "");
      const hasToken = Boolean(tokenIn.value.trim()) || Boolean(rawToken);
      if (httpCb.checked && !hasToken) httpWarn.removeAttribute("hidden");
      else httpWarn.setAttribute("hidden", "");
    };

    /* ---- fields (each built before the rule that mirrors it) ---- */

    /** Label, the input at full width, then what the value resolves to. The echo
     *  is the whole point: it answers "so what does that mean?" without a second
     *  paragraph of prose. (A <div> wrapper: `.setcard__echo` is a span and a <p>
     *  would get the user agent's margins.) */
    const fieldWithEcho = (id: string, label: string, input: HTMLElement, echo: HTMLElement, hint: string): HTMLElement =>
      el("div", { class: "setfield" }, [
        el("label", { class: "lbl", for: id }, [label]),
        input,
        el("div", { class: "setecho" }, [echo]),
        el("p", { class: "hint" }, [hint]),
      ]);

    const portField = this.#setField(
      "gw-port",
      "Port",
      el("div", { class: "setline" }, [portIn, addrEcho]),
      "1 to 65535. The daemon claims the port when it starts, so a change waits for a restart.",
    );
    portField.append(portErr);

    const tokenField = fieldWithEcho(
      "gw-token-new",
      "New token",
      tokenIn,
      tokenEcho,
      "Write-only: blank keeps the stored token. A new one applies to the next connection.",
    );

    const baseField = fieldWithEcho(
      "gw-basepath",
      "Base path",
      baseIn,
      baseEcho,
      "Mount the web app under a prefix for a reverse proxy.",
    );
    baseField.append(baseErr);

    /** Two controls that cannot act are not allowed to look like they can. The
     *  token field is deliberately exempt: the HTTP endpoint needs a token even
     *  when the socket itself asks for none. */
    const syncAvailability = (): void => {
      bypassCb.disabled = currentMode() === "none";
      baseIn.disabled = !uiCb.checked;
      baseField.className = `setfield${uiCb.checked ? "" : " is-off"}`;
      syncWarnings();
    };

    /* ---- sections ---- */

    const listener = this.#section("Listener", "2 settings", [
      portField,
      this.#setField(
        "gw-bind",
        "Bind",
        bindDd.node,
        "A network bind opens the port to every device that can route here. Keep a token set.",
        null,
      ),
    ]);

    const auth = this.#section("Authentication", "3 settings", [
      this.#setField("gw-mode", "Auth mode", modeDd.node, undefined, null),
      modeWarn,
      tokenField,
      this.#settingRow(
        "Skip the token for local clients",
        "Only meaningful with a token: browsers and native clients on this machine then connect without one.",
        bypassCb,
        "gw-bypass",
      ),
    ]);

    const trust = this.#section("Network trust", "2 settings", [
      fieldWithEcho(
        "gw-hosts",
        "Allowed hosts",
        hostsIn,
        hostsEcho,
        "Comma-separated Host names for a reverse proxy or a public name. Loopback names, private addresses and .local are always accepted.",
      ),
      fieldWithEcho(
        "gw-origins",
        "Allowed origins",
        originsIn,
        originsEcho,
        "Comma-separated browser origins, e.g. https://ui.example.com. Same-origin requests are always allowed.",
      ),
    ]);

    const controlUi = this.#section("Control UI", "2 settings", [
      this.#settingRow(
        "Serve the Control UI from this daemon",
        "Off answers 404 for the web app. This page keeps working until you reload it.",
        uiCb,
        "gw-cui",
      ),
      baseField,
    ]);

    const httpApi = this.#section("HTTP API", "1 setting", [
      this.#settingRow(
        "OpenAI-compatible API",
        "POST /v1/chat/completions with the gateway token as Bearer. Off by default — it hands full agent access to anything holding that token.",
        httpCb,
        "gw-openai",
      ),
      httpWarn,
    ]);

    const zone = el("div", {}, [listener, auth, trust, controlUi, httpApi]);
    this.#dirtyWatch(zone, note);

    for (const inp of [portIn, baseIn, hostsIn, originsIn]) {
      inp.addEventListener("input", () => {
        // The first keystroke after a refusal clears the mark it left: the fields
        // are a draft, and an error belongs to the attempt, not to the field.
        portErr.setAttribute("hidden", "");
        baseErr.setAttribute("hidden", "");
        portIn.removeAttribute("aria-invalid");
        baseIn.removeAttribute("aria-invalid");
        hostsIn.removeAttribute("aria-invalid");
        originsIn.removeAttribute("aria-invalid");
        problem.setAttribute("hidden", "");
        syncEchoes();
      });
    }
    bindDd.sel.addEventListener("change", () => {
      syncAddress();
      syncWarnings();
    });
    modeDd.sel.addEventListener("change", () => {
      syncAvailability();
      syncStatus();
    });
    uiCb.addEventListener("change", syncAvailability);
    httpCb.addEventListener("change", syncWarnings);
    tokenIn.addEventListener("input", syncWarnings);

    /* ---- commit ---- */

    const save = el("button", { class: "btn pri", type: "button", id: "gateway-save" }, ["Save gateway"]) as HTMLButtonElement;
    save.onclick = async () => {
      const portRaw = portIn.value.trim();
      if (!/^\d+$/.test(portRaw) || Number(portRaw) < 1 || Number(portRaw) > 65535) {
        portErr.textContent = "The port has to be a whole number from 1 to 65535.";
        portErr.removeAttribute("hidden");
        portIn.setAttribute("aria-invalid", "true");
        portIn.focus();
        problem.textContent = "Not saved — the port is not a number from 1 to 65535.";
        problem.removeAttribute("hidden");
        return;
      }
      // The prefix is mounted by string slicing, so it has to start at the root;
      // one trailing slash is normalised away (the echo shows the result).
      const baseRaw = baseIn.value.trim().replace(/\/$/, "");
      if (baseRaw && !baseRaw.startsWith("/")) {
        baseErr.textContent = "Start the path with a slash — /ui, not ui.";
        baseErr.removeAttribute("hidden");
        baseIn.setAttribute("aria-invalid", "true");
        baseIn.focus();
        problem.textContent = "Not saved — the base path has to start with a slash.";
        problem.removeAttribute("hidden");
        return;
      }
      const hosts = list(hostsIn.value);
      const badHost = hosts.find((h) => !okHost(h));
      if (badHost) {
        hostsIn.setAttribute("aria-invalid", "true");
        hostsIn.focus();
        problem.textContent = `Not saved — "${badHost}" is not a host name; use a bare name like gw.example.com.`;
        problem.removeAttribute("hidden");
        return;
      }
      const origins = list(originsIn.value);
      const badOrigin = origins.find((o) => !okOrigin(o));
      if (badOrigin) {
        originsIn.setAttribute("aria-invalid", "true");
        originsIn.focus();
        problem.textContent = `Not saved — "${badOrigin}" is not an origin; put https:// in front.`;
        problem.removeAttribute("hidden");
        return;
      }

      const port = Number(portRaw);
      const bind = currentBind();
      const pairs: [string, unknown][] = [
        ["gateway.port", port],
        ["gateway.bind", bind],
        ["gateway.auth.mode", currentMode()],
        ["gateway.auth.loopbackBypass", bypassCb.checked],
        ["gateway.allowedHosts", hosts],
        ["gateway.allowedOrigins", origins],
        ["gateway.controlUi.enabled", uiCb.checked],
        ["gateway.controlUi.basePath", baseRaw],
        ["gateway.http.endpoints.chatCompletions.enabled", httpCb.checked],
      ];
      // Write-only: an untouched field keeps whatever is stored.
      if (tokenIn.value.trim()) pairs.push(["gateway.auth.token", tokenIn.value.trim()]);

      // Only the socket address waits for a restart (http.listen runs once at
      // startup); auth, trust, controlUi and the HTTP API are read per request.
      const listenerMoved = port !== Number(savedPort) || bind !== savedBind;
      save.disabled = true;
      save.textContent = "Saving…";
      const ok = await this.#commit(
        pairs,
        note,
        problem,
        listenerMoved ? "gateway saved — the listener changes when the daemon restarts" : "gateway saved",
      );
      save.disabled = false;
      save.textContent = "Save gateway";
      if (!ok) return;
      if (tokenIn.value.trim()) {
        tokenEcho.textContent = `stored — ends in ${tokenIn.value.trim().slice(-4)}`;
        tokenIn.value = "";
      }
      // No re-render: every field already holds what was written, and a re-render
      // would wipe the sentence that says the new address is not live yet.
      note.textContent = listenerMoved
        ? "Saved. The daemon still serves the old address until it restarts."
        : RESTING;
      syncWarnings();
      syncStatus();
    };

    /* ---- assembly ---- */

    const card = el("div", { class: "card gw-card" }, [
      el("div", { class: "setcard__head" }, [
        el("h3", {}, ["Gateway"]),
        el("p", { class: "hint" }, ["How the daemon listens, who may connect, and which surfaces it serves."]),
      ]),
      strip.node,
      ...(configPath
        ? [this.#factRow("Config file", configPath, "Every change here is written to this file.")]
        : []),
      zone,
      el("div", { class: "setfoot" }, [note, problem, save]),
    ]);

    // The restart lives on Runtime — one owner, with its own supervisor caveat.
    // This page points at it the way Automations points at Memory.
    const openRuntime = el("button", { class: "btn sm", type: "button", id: "gw-open-runtime" }, ["Open Runtime"]) as HTMLButtonElement;
    openRuntime.onclick = () => this.#setTab("runtime");

    this.#root.append(el("div", { class: "settings__stack" }, [
      card,
      el("div", { class: "settings__inline gw-pointer" }, [
        el("p", { class: "hint" }, ["Port and bind are read when the daemon starts; Runtime has the restart."]),
        openRuntime,
      ]),
    ]));

    syncAvailability();
    syncEchoes();
  }


  /* ---------------- automations (OpenClaw's Automation page, adapted) ---------------- */

  /** Five cards: cron, heartbeat, mail, hooks, queue.
   *
   *  One rule decides how everything behaves: a *setting* is edited into a draft
   *  and committed by the card's footer, while a *record* (a job, a mailbox, a
   *  mapping, a job's enabled state) acts immediately through its own dialog or
   *  verb. Before this, the two models were mixed inside single cards. */
  async #renderAutomations(config: any): Promise<void> {
    // Two independent reads: the job editor is useful even when the runtime state
    // cannot be read, and vice versa.
    let state: any = null;
    let stateErr = "";
    try {
      state = await gateway.request("automations.state");
    } catch (err) {
      stateErr = (err as Error).message;
    }
    let cronData: any = null;
    try {
      cronData = await gateway.request("cron.list");
    } catch (err) {
      stateErr ||= (err as Error).message;
    }

    const body = el("div", { class: "settings__stack" }, [
      this.#cronCard(config, state, cronData, stateErr),
      this.#heartbeatCard(config, state, stateErr),
      this.#imapCard(config, state, stateErr),
      this.#hooksCard(config, stateErr),
      this.#queueCard(config, stateErr),
    ]);

    // The dream sweep is a Memory-tab setting and its editor lives there. One
    // line and a way to reach it, instead of a second copy of the same two keys.
    const go = el("button", { class: "btn sm", type: "button", id: "auto-open-memory" }, ["Open Memory"]) as HTMLButtonElement;
    go.onclick = () => this.#setTab("memory");
    body.append(el("div", { class: "settings__inline auto-pointer" }, [
      el("p", { class: "hint" }, ["The nightly dream sweep — its switch, schedule and diary — is on the Memory tab."]),
      go,
    ]));

    this.#root.append(body);
  }

  #cronCard(config: any, state: any, cronData: any, loadErr: string): HTMLElement {
    const jobsKnown = Boolean(cronData?.jobs) || Boolean(state?.cron?.jobs);
    const jobs: any[] = cronData?.jobs ?? state?.cron?.jobs ?? [];
    const stateKnown = Boolean(state?.cron);
    const runs = new Map<string, any>();
    for (const r of (cronData?.runs ?? []) as any[]) {
      if (!runs.has(String(r.job_id))) runs.set(String(r.job_id), r);
    }

    const strip = this.#statusStrip();
    const note = el("span", { class: "setfoot__note", "aria-live": "polite" }, []);
    const problem = el("p", { class: "hint hint--err" }, []);
    problem.setAttribute("hidden", "");

    // `cron.enabled` is a config leaf this card also writes, so config wins over
    // the runtime snapshot: after a save the page must not disagree with itself.
    const schedulerCb = el("input", { type: "checkbox", id: "cron-enabled" }) as HTMLInputElement;
    const cfgEnabled = config?.cron?.enabled;
    schedulerCb.checked = typeof cfgEnabled === "boolean"
      ? cfgEnabled
      : stateKnown ? state.cron.enabled !== false : true;

    const syncStatus = (): void => {
      if (!stateKnown && !jobsKnown) {
        strip.set("unknown", "", `Could not read the runtime state${loadErr ? ` — ${loadErr}` : ""}.`);
        return;
      }
      if (!schedulerCb.checked) {
        strip.set("off", "is-warn", "Nothing fires while the scheduler is off. The jobs below are kept.");
        return;
      }
      const active = jobs.filter((j) => Number(j.enabled ?? 1) === 1).length;
      const paused = jobs.length - active;
      const lastAt = Math.max(
        jobs.reduce((max, j) => Math.max(max, Number(j.last_run_at ?? 0)), 0),
        ...[...runs.values()].map((r) => Number(r.started_at ?? 0)),
      );
      strip.set(
        "on",
        "is-ok",
        (paused > 0
          ? `${paused} ${paused === 1 ? "job is" : "jobs are"} paused. `
          : `${jobs.length} ${jobs.length === 1 ? "job is" : "jobs are"} scheduled and running. `) +
          (lastAt ? `The last one fired ${this.#relTime(lastAt)}.` : "Nothing has fired yet."),
      );
    };
    schedulerCb.onchange = () => syncStatus();

    const save = el("button", { class: "btn pri", type: "button", id: "cron-save" }, ["Save scheduler"]) as HTMLButtonElement;
    save.onclick = async () => {
      save.disabled = true;
      save.textContent = "Saving…";
      const ok = await this.#commit(
        [["cron.enabled", schedulerCb.checked]],
        note,
        problem,
        schedulerCb.checked ? "scheduler saved — jobs fire on the next tick" : "scheduler saved — nothing fires until it is back on",
      );
      save.disabled = false;
      save.textContent = "Save scheduler";
      if (ok) void this.render();
    };

    const jobRows = jobs.map((j) => {
      const enabled = Number(j.enabled ?? 1) === 1;
      const last = runs.get(String(j.id));
      const lastAt = Number(j.last_run_at ?? 0) || Number(last?.started_at ?? 0);
      const facts: (Node | string)[] = [
        el("span", { class: "mono" }, [String(j.schedule ?? "")]),
        j.tz ? `, ${String(j.tz)}` : "",
        lastAt ? `, last ${last?.status ? `${String(last.status)} ` : "ran "}${this.#relTime(lastAt)}` : ", not run yet",
        j.delivery_mode === "announce" ? `, posts the result to ${String(j.delivery_to ?? "a chat")}` : "",
        j.delivery_mode === "webhook" ? `, POSTs the result to ${String(j.delivery_to ?? "a URL")}` : "",
        j.delivery_mode === "none" ? ", keeps the result in its own session" : "",
      ];
      const stateTag = el("span", { class: `settings__tag${enabled ? " is-ok" : ""}` }, [enabled ? "on" : "paused"]);
      const name = String(j.name ?? j.id);
      const flip = el("button", {
        class: "btn sm cron-job__toggle",
        type: "button",
        id: `cron-toggle-${j.id}`,
        "aria-pressed": enabled ? "true" : "false",
        "aria-label": `${enabled ? "Pause" : "Resume"} ${name}`,
      }, [enabled ? "Pause" : "Resume"]) as HTMLButtonElement;
      flip.onclick = async () => {
        flip.disabled = true;
        try {
          // Same validated path as `sc cron add`: the running scheduler reconciles.
          await gateway.request("cron.upsert", {
            id: String(j.id), name, schedule: String(j.schedule ?? ""),
            prompt: String(j.prompt ?? ""), enabled: !enabled,
          });
          toast(`${name} ${enabled ? "paused" : "resumed"}`, "ok");
          await this.render();
        } catch (err) {
          flip.disabled = false;
          toast((err as Error).message, "err");
        }
      };
      const edit = el("button", {
        class: "btn sm", type: "button", id: `cron-edit-${j.id}`, "aria-label": `Edit ${name}`,
      }, ["Edit…"]) as HTMLButtonElement;
      edit.onclick = () => this.#cronJobDialog(j, config);
      const del = el("button", {
        class: "btn sm danger", type: "button", id: `cron-del-${j.id}`, "aria-label": `Delete ${name}`,
      }, ["Delete"]) as HTMLButtonElement;
      del.onclick = () => modal({
        title: `Delete ${name}?`,
        body: "Its next run will not happen. Runs already recorded stay in the history.",
        confirmLabel: "Delete job",
        danger: true,
        onConfirm: async () => {
          try {
            await gateway.request("cron.remove", { id: String(j.id) });
            toast(`removed ${name}`, "ok");
            await this.render();
          } catch (err) {
            toast((err as Error).message, "err");
          }
        },
      });
      return this.#recordRow(name, facts, [stateTag, flip, edit, del], "cron-job");
    });

    const newJob = el("button", { class: "btn sm", type: "button", id: "cron-new" }, ["+ New job"]) as HTMLButtonElement;
    newJob.onclick = () => this.#cronJobDialog(null, config);

    const zone = el("div", {}, [
      this.#section("Scheduler", "1 setting", [
        this.#settingRow(
          "Run scheduled jobs",
          "Off keeps every job below but fires none of them until this is back on.",
          schedulerCb,
          "cron-enabled",
        ),
      ]),
      this.#section("Jobs", jobs.length === 1 ? "1 job" : `${jobs.length} jobs`, [
        ...(!jobsKnown
          ? [el("p", { class: "hint" }, [`Could not read the job list${loadErr ? ` — ${loadErr}` : ""}.`])]
          : jobs.length === 0
            ? [el("p", { class: "hint" }, ["No jobs yet — a job is a prompt plus a schedule."])]
            : jobRows),
        el("div", { class: "settings__inline" }, [newJob]),
      ]),
    ]);
    this.#dirtyWatch(zone, note);
    syncStatus();

    return el("div", { class: "card auto-cron" }, [
      el("div", { class: "setcard__head" }, [
        el("h3", {}, ["Cron jobs"]),
        el("p", { class: "hint" }, ["Prompts the agent runs on a schedule, whether or not anyone is chatting."]),
      ]),
      strip.node,
      zone,
      el("div", { class: "setfoot" }, [note, problem, save]),
    ]);
  }

  #heartbeatCard(config: any, state: any, loadErr: string): HTMLElement {
    const hbCfg: any = config?.agents?.defaults?.heartbeat ?? {};
    const hb: any = state?.heartbeat ?? null;

    const strip = this.#statusStrip();
    const note = el("span", { class: "setfoot__note", "aria-live": "polite" }, []);
    const problem = el("p", { class: "hint hint--err" }, []);
    problem.setAttribute("hidden", "");

    const every = el("input", {
      class: "inp mono",
      id: "hb-every",
      value: String(hb?.every ?? hbCfg.every ?? "30m"),
      placeholder: "30m",
      autocomplete: "off",
      spellcheck: "false",
    }) as HTMLInputElement;
    const everyErr = el("p", { class: "hint hint--err" }, []);
    everyErr.setAttribute("hidden", "");

    const targetDd = this.#dropdown({
      id: "hb-target",
      value: String(hbCfg.target ?? hb?.target ?? "owner"),
      label: "Where the heartbeat goes",
      placeholder: "owner",
      options: [
        { value: "owner", label: "owner — the first paired Telegram chat" },
        { value: "last", label: "last — wherever it spoke most recently" },
        { value: "none", label: "none — run, but never send" },
      ],
    });

    const lightCb = el("input", { type: "checkbox", id: "hb-light" }) as HTMLInputElement;
    lightCb.checked = Boolean(hbCfg.lightContext ?? hb?.lightContext);
    const isoCb = el("input", { type: "checkbox", id: "hb-isolated" }) as HTMLInputElement;
    isoCb.checked = Boolean(hbCfg.isolatedSession ?? hb?.isolatedSession);

    const syncStatus = (): void => {
      if (!hb) {
        strip.set("unknown", "", `Could not read the heartbeat state${loadErr ? ` — ${loadErr}` : ""}.`);
        return;
      }
      strip.set(
        hb.armed ? "armed" : "idle",
        hb.armed ? "is-ok" : "is-warn",
        hb.armed
          ? `Runs every ${String(hb.every ?? every.value.trim())}. Its last answer reached ${hb.lastTargetChat ? String(hb.lastTargetChat) : "no one — nothing to send to"}.`
          : "Not running: either the cadence is 0m, or the delivery target has no chat to reach.",
      );
    };
    every.addEventListener("input", () => {
      if (everyErr.hasAttribute("hidden")) return;
      everyErr.setAttribute("hidden", "");
      every.removeAttribute("aria-invalid");
      problem.setAttribute("hidden", "");
    });

    const save = el("button", { class: "btn pri", type: "button", id: "hb-save" }, ["Save heartbeat"]) as HTMLButtonElement;
    save.onclick = async () => {
      const raw = every.value.trim().toLowerCase();
      // `0m` is the documented off switch; the floor is one minute.
      if (raw !== "0m" && !/^[1-9]\d*[smh]$/.test(raw)) {
        everyErr.textContent = "Use a number and a unit — 30m, 1h, 90s — or 0m to turn the cadence off.";
        everyErr.removeAttribute("hidden");
        every.setAttribute("aria-invalid", "true");
        problem.textContent = "Not saved — the cadence is not a duration.";
        problem.removeAttribute("hidden");
        every.focus();
        return;
      }
      save.disabled = true;
      save.textContent = "Saving…";
      const ok = await this.#commit([
        ["agents.defaults.heartbeat.every", raw],
        ["agents.defaults.heartbeat.target", this.#selValue(targetDd.sel)],
        ["agents.defaults.heartbeat.lightContext", lightCb.checked],
        ["agents.defaults.heartbeat.isolatedSession", isoCb.checked],
      ], note, problem, "heartbeat saved — the next tick uses it");
      save.disabled = false;
      save.textContent = "Save heartbeat";
      if (ok) void this.render();
    };

    const zone = el("div", {}, [
      this.#section("Cadence", "4 settings", [
        this.#setField("hb-every", "Every", every, "A number and a unit: 30m, 1h, 90s. The floor is one minute; 0m turns the cadence off."),
        this.#setField("hb-target", "Where it goes", targetDd.node, "A heartbeat with nowhere to send still runs — its answer is dropped.", null),
        this.#settingRow(
          "Light context",
          "Sends only the recent conversation instead of the workspace files.",
          lightCb,
          "hb-light",
        ),
        this.#settingRow(
          "Isolated session",
          "Each heartbeat runs in a fresh session, so it cannot see this chat's history.",
          isoCb,
          "hb-isolated",
        ),
        everyErr,
      ]),
    ]);
    this.#dirtyWatch(zone, note);
    syncStatus();

    return el("div", { class: "card auto-heartbeat" }, [
      el("div", { class: "setcard__head" }, [
        el("h3", {}, ["Heartbeat"]),
        el("p", { class: "hint" }, [
          "A periodic nudge so the agent can act on the standing orders in AGENTS.md. It stays quiet unless there is something worth saying.",
        ]),
      ]),
      strip.node,
      zone,
      el("div", { class: "setfoot" }, [note, problem, save]),
    ]);
  }

  #imapCard(config: any, state: any, loadErr: string): HTMLElement {
    const cfg: any = config?.imap ?? {};
    const accounts: Record<string, any> = cfg.accounts ?? {};
    const names = Object.keys(accounts);
    const live: any[] = state?.imap?.enabled ? (state.imap.accounts ?? []) : [];

    const strip = this.#statusStrip();
    const note = el("span", { class: "setfoot__note", "aria-live": "polite" }, []);
    const problem = el("p", { class: "hint hint--err" }, []);
    problem.setAttribute("hidden", "");

    const masterCb = el("input", { type: "checkbox", id: "imap-enabled" }) as HTMLInputElement;
    masterCb.checked = Boolean(cfg.enabled);

    const syncStatus = (): void => {
      const unhealthy = live.filter((a) => a.unhealthy).length;
      strip.set(
        masterCb.checked ? "on" : "off",
        masterCb.checked ? (unhealthy ? "is-warn" : "is-ok") : "",
        !masterCb.checked
          ? "Nothing is being read. The accounts below are kept."
          : names.length === 0
            ? "On, but no mailbox is configured yet."
            : unhealthy
              ? `${unhealthy} ${unhealthy === 1 ? "mailbox is" : "mailboxes are"} reporting an error.`
              : "Every configured mailbox is reading without error.",
      );
    };
    masterCb.onchange = () => syncStatus();

    const save = el("button", { class: "btn pri", type: "button", id: "imap-save" }, ["Save watcher"]) as HTMLButtonElement;
    save.onclick = async () => {
      save.disabled = true;
      save.textContent = "Saving…";
      const ok = await this.#commit([["imap.enabled", masterCb.checked]], note, problem,
        masterCb.checked ? "watcher saved — it starts on the next tick" : "watcher saved — nothing is being read now");
      save.disabled = false;
      save.textContent = "Save watcher";
      if (ok) void this.render();
    };

    // The runtime read carries where each account has got to, not why it is idling:
    // the watch mode is a setting and is stated on the account row below.
    const liveRows = live.map((a) => this.#factRow(
      String(a.name),
      a.unhealthy ? "error" : `cursor ${String(a.cursor ?? 0)}`,
      [
        `Reading ${String(a.mailbox ?? "INBOX")}`,
        a.skips ? `${String(a.skips)} ${a.skips === 1 ? "message" : "messages"} skipped` : "",
        a.lastError ? String(a.lastError) : "",
      ].filter(Boolean).join(", "),
      a.unhealthy ? "is-err" : "is-ok",
    ));

    const watchWords = (w: any): string => {
      const mode = String(w?.mode ?? "auto");
      const secs = Number(w?.pollSeconds ?? 60);
      return mode === "idle" ? "pushed as it arrives"
        : mode === "interval" ? `checked every ${secs}s`
          : `pushed as it arrives, checked every ${secs}s as a fallback`;
    };

    const accountRows = names.map((aname) => {
      const acc = accounts[aname] ?? {};
      const facts = [
        `${String(acc.host ?? "?")}:${String(acc.port ?? 993)}`,
        acc.secure === false ? "unencrypted" : "TLS",
        acc.user ? String(acc.user) : "",
        String(acc.mailbox ?? "INBOX"),
        watchWords(acc.watch),
        Number(acc.enabled ?? 1) === 0 ? "turned off" : "",
      ].filter(Boolean).join(", ");
      const edit = el("button", {
        class: "btn sm", type: "button", id: `imap-edit-${aname}`, "aria-label": `Edit ${aname}`,
      }, ["Edit…"]) as HTMLButtonElement;
      edit.onclick = () => this.#imapAccountDialog(aname, acc, config);
      const del = el("button", {
        class: "btn sm danger", type: "button", id: `imap-del-${aname}`, "aria-label": `Delete ${aname}`,
      }, ["Delete"]) as HTMLButtonElement;
      del.onclick = () => modal({
        title: `Delete mailbox ${aname}?`,
        body: "The account and its cursor are removed; nothing in the mailbox itself is touched.",
        confirmLabel: "Delete mailbox",
        danger: true,
        onConfirm: async () => {
          try {
            await gateway.request("config.unset", { path: `imap.accounts.${aname}` });
            toast(`removed account ${aname}`, "ok");
            this.#onChanged();
            await this.render();
          } catch (err) {
            toast((err as Error).message, "err");
          }
        },
      });
      return this.#recordRow(aname, facts, [edit, del], "imap-account");
    });

    const addAcc = el("button", { class: "btn sm", type: "button", id: "imap-add" }, ["+ Add account"]) as HTMLButtonElement;
    addAcc.onclick = () => this.#imapAccountDialog(null, null, config);

    const zone = el("div", {}, [
      this.#section("Watcher", "1 setting", [
        this.#settingRow(
          "Read this mail",
          "The gateway idles or polls each account below and hands new mail to the agent.",
          masterCb,
          "imap-enabled",
        ),
      ]),
      this.#section("Live status", live.length === 1 ? "1 mailbox" : `${live.length} mailboxes`, [
        ...(!masterCb.checked
          ? [el("p", { class: "hint" }, ["No cursor data — the watcher is off."])]
          : liveRows.length === 0
            ? [el("p", { class: "hint" }, [`Nothing read yet this run${loadErr ? ` — ${loadErr}` : "."}`])]
            : liveRows),
      ]),
      this.#section("Accounts", names.length === 1 ? "1 account" : `${names.length} accounts`, [
        ...(names.length === 0
          ? [el("p", { class: "hint" }, ["No accounts yet — add one to let the agent read a mailbox."])]
          : accountRows),
        el("div", { class: "settings__inline" }, [addAcc]),
      ]),
    ]);
    this.#dirtyWatch(zone, note);
    syncStatus();

    return el("div", { class: "card auto-imap" }, [
      el("div", { class: "setcard__head" }, [
        el("h3", {}, ["IMAP mail watcher"]),
        el("p", { class: "hint" }, ["Each account remembers where it got to, so a restart never replays mail it has already read."]),
      ]),
      strip.node,
      zone,
      el("div", { class: "setfoot" }, [note, problem, save]),
    ]);
  }

  #hooksCard(config: any, stateErr: string): HTMLElement {
    const cfg: any = config?.hooks ?? {};
    const mappings: Record<string, any> = cfg.mappings ?? {};
    const names = Object.keys(mappings);
    const hasToken = Boolean(cfg.token);
    const path = String(cfg.path ?? "/hooks");

    const strip = this.#statusStrip();
    const note = el("span", { class: "setfoot__note", "aria-live": "polite" }, []);
    const problem = el("p", { class: "hint hint--err" }, []);
    problem.setAttribute("hidden", "");

    const enabledCb = el("input", { type: "checkbox", id: "hooks-enabled" }) as HTMLInputElement;
    enabledCb.checked = Boolean(cfg.enabled);
    const pathInp = el("input", {
      class: "inp mono", id: "hooks-path", value: path, placeholder: "/hooks", autocomplete: "off", spellcheck: "false",
    }) as HTMLInputElement;
    const tokenInp = el("input", {
      class: "inp mono", id: "hooks-token-out", type: "password",
      placeholder: hasToken ? "stored — leave blank to keep it" : "paste a token", autocomplete: "off",
    }) as HTMLInputElement;
    const askCb = el("input", { type: "checkbox", id: "hooks-ask" }) as HTMLInputElement;
    askCb.checked = Boolean(cfg.allowRequestSessionKey);

    const syncStatus = (): void => {
      strip.set(
        !enabledCb.checked ? "off" : hasToken ? "live" : "on, no token",
        !enabledCb.checked ? "" : hasToken ? "is-ok" : "is-warn",
        !enabledCb.checked
          ? "Every request is refused while this is off."
          : hasToken
            ? `Accepting at ${String(cfg.path ?? "/hooks")}; each request needs the bearer token.`
            : "On, but no token is stored — every request is refused without one.",
      );
    };
    enabledCb.onchange = () => syncStatus();
    pathInp.addEventListener("input", () => {
      if (enabledCb.checked && hasToken) {
        strip.set("live", "is-ok", `Accepting at ${pathInp.value.trim() || "/hooks"}; each request needs the bearer token.`);
      }
    });

    const save = el("button", { class: "btn pri", type: "button", id: "hooks-save" }, ["Save hook settings"]) as HTMLButtonElement;
    save.onclick = async () => {
      const typed = tokenInp.value.trim();
      const nextPath = pathInp.value.trim() || "/hooks";
      if (!nextPath.startsWith("/")) {
        problem.textContent = "Not saved — the path has to start with a slash.";
        problem.removeAttribute("hidden");
        pathInp.setAttribute("aria-invalid", "true");
        pathInp.focus();
        return;
      }
      save.disabled = true;
      save.textContent = "Saving…";
      const pairs: [string, unknown][] = [
        ["hooks.enabled", enabledCb.checked],
        ["hooks.path", nextPath],
        ["hooks.allowRequestSessionKey", askCb.checked],
      ];
      // Write-only: the stored token only changes when something is typed here.
      if (typed) pairs.push(["hooks.token", typed]);
      const ok = await this.#commit(pairs, note, problem, "hook settings saved");
      save.disabled = false;
      save.textContent = "Save hook settings";
      if (ok) {
        tokenInp.value = "";
        pathInp.removeAttribute("aria-invalid");
        void this.render();
      }
    };

    const mappingRows = names.map((mname) => {
      const m = mappings[mname] ?? {};
      const facts = [
        m.action === "wake" ? "nudges the main session" : "runs the payload as a turn",
        m.sessionKey ? `in session ${String(m.sessionKey)}` : "",
        m.message ?? m.text ? `sends “${String(m.message ?? m.text).slice(0, 48)}”` : "",
      ].filter(Boolean).join(", ");
      const edit = el("button", {
        class: "btn sm", type: "button", id: `hook-map-edit-${mname}`, "aria-label": `Edit ${mname}`,
      }, ["Edit…"]) as HTMLButtonElement;
      edit.onclick = () => this.#hookMappingDialog(mname, m, config);
      const del = el("button", {
        class: "btn sm danger", type: "button", id: `hook-map-del-${mname}`, "aria-label": `Delete ${mname}`,
      }, ["Delete"]) as HTMLButtonElement;
      del.onclick = () => modal({
        title: `Delete mapping ${mname}?`,
        body: `A POST to ${path}/${mname} will answer 404 afterwards. The rest of the configuration is untouched.`,
        confirmLabel: "Delete mapping",
        danger: true,
        onConfirm: async () => {
          try {
            await gateway.request("config.unset", { path: `hooks.mappings.${mname}` });
            toast(`removed mapping ${mname}`, "ok");
            this.#onChanged();
            await this.render();
          } catch (err) {
            toast((err as Error).message, "err");
          }
        },
      });
      return this.#recordRow(mname, facts, [edit, del], "hook-map");
    });

    const addMap = el("button", { class: "btn sm", type: "button", id: "hook-map-add" }, ["+ Add mapping"]) as HTMLButtonElement;
    addMap.onclick = () => this.#hookMappingDialog(null, null, config);

    const zone = el("div", {}, [
      this.#section("Endpoint", "4 settings", [
        this.#settingRow(
          "Accept inbound hooks",
          "Needs a token as well — with either missing, every request is refused.",
          enabledCb,
          "hooks-enabled",
        ),
        this.#setField("hooks-path", "Path", pathInp, "Where the endpoints live. A mapping named github answers at this path, then /github."),
        this.#setField("hooks-token-out", "Bearer token", tokenInp, "Write-only: blank keeps the stored token. Every request has to send it.", null),
        this.#settingRow(
          "Trust a session key from the request",
          "Lets an agent hook choose the session it lands in. Wake hooks always reach the main session.",
          askCb,
          "hooks-ask",
        ),
      ]),
      this.#section("Mappings", names.length === 1 ? "1 mapping" : `${names.length} mappings`, [
        ...(names.length === 0
          ? [el("p", { class: "hint" }, ["No mappings yet — anything unmatched answers 404."])]
          : mappingRows),
        el("div", { class: "settings__inline" }, [addMap]),
      ]),
    ]);
    this.#dirtyWatch(zone, note);
    syncStatus();

    return el("div", { class: "card auto-hooks" }, [
      el("div", { class: "setcard__head" }, [
        el("h3", {}, ["Inbound hooks"]),
        el("p", { class: "hint" }, ["HTTP endpoints that push work into the agent — a webhook from a repo, a shortcut from your phone."]),
      ]),
      strip.node,
      zone,
      el("div", { class: "setfoot" }, [note, problem, save]),
    ]);
  }

  #queueCard(config: any, stateErr: string): HTMLElement {
    const cfg: any = config?.messages?.queue ?? {};
    const modeWords: Record<string, string> = {
      steer: "steer — inject into the live turn",
      followup: "followup — run after the active turn",
      collect: "collect — merge queued messages into one turn",
      interrupt: "interrupt — stop the turn, run the newest",
    };
    // The sentence form ("it folds …"), because the status line reads as prose.
    const overflowWords: Record<string, string> = {
      summarize: "folds the oldest into one message",
      old: "drops the oldest message",
      new: "drops the newest message",
    };
    const dropWords: Record<string, string> = {
      summarize: "summarize — fold the oldest into one message",
      old: "old — drop the oldest message",
      new: "new — drop the newest message",
    };
    const curMode = String(cfg.mode ?? "steer");
    const curDrop = String(cfg.drop ?? "summarize");
    const curTg = String(cfg.byChannel?.telegram ?? "");

    const strip = this.#statusStrip();
    const note = el("span", { class: "setfoot__note", "aria-live": "polite" }, []);
    const problem = el("p", { class: "hint hint--err" }, []);
    problem.setAttribute("hidden", "");

    const modeDd = this.#dropdown({
      id: "queue-mode",
      value: curMode,
      label: "Default mode",
      placeholder: "steer",
      options: Object.entries(modeWords).map(([value, label]) => ({ value, label, title: value })),
    });
    const dropDd = this.#dropdown({
      id: "queue-drop",
      value: curDrop,
      label: "On overflow",
      placeholder: "summarize",
      options: Object.entries(dropWords).map(([value, label]) => ({ value, label, title: value })),
    });
    const tgDd = this.#dropdown({
      id: "queue-by-tg",
      value: curTg,
      label: "Telegram override",
      placeholder: "inherit",
      options: [
        { value: "", label: "inherit — use the default above" },
        ...Object.entries(modeWords).map(([value, label]) => ({ value, label, title: value })),
      ],
    });

    const cap = el("input", { class: "inp mono", id: "queue-cap", value: String(cfg.cap ?? 20), autocomplete: "off" }) as HTMLInputElement;
    const debounce = el("input", { class: "inp mono", id: "queue-debounce", value: String(cfg.debounceMs ?? 500), autocomplete: "off" }) as HTMLInputElement;
    const capErr = el("p", { class: "hint hint--err" }, []);
    capErr.setAttribute("hidden", "");
    const debErr = el("p", { class: "hint hint--err" }, []);
    debErr.setAttribute("hidden", "");

    const syncStatus = (): void => {
      const mode = this.#selValue(modeDd.sel);
      const drop = this.#selValue(dropDd.sel);
      const tg = this.#selValue(tgDd.sel);
      const overflow = overflowWords[drop] ?? drop;
      strip.set(
        mode,
        "is-ok",
        `Holds ${cap.value.trim() || "20"} messages per session. Past that it ${overflow}.` +
          (tg ? ` Telegram uses ${tg}.` : ""),
      );
    };
    modeDd.sel.addEventListener("change", syncStatus);
    dropDd.sel.addEventListener("change", syncStatus);
    tgDd.sel.addEventListener("change", syncStatus);
    cap.addEventListener("input", () => {
      syncStatus();
      if (capErr.hasAttribute("hidden")) return;
      capErr.setAttribute("hidden", "");
      cap.removeAttribute("aria-invalid");
      problem.setAttribute("hidden", "");
    });
    debounce.addEventListener("input", () => {
      if (debErr.hasAttribute("hidden")) return;
      debErr.setAttribute("hidden", "");
      debounce.removeAttribute("aria-invalid");
      problem.setAttribute("hidden", "");
    });

    const save = el("button", { class: "btn pri", type: "button", id: "queue-save" }, ["Save queue"]) as HTMLButtonElement;
    save.onclick = async () => {
      const capRaw = cap.value.trim();
      const debRaw = debounce.value.trim();
      // No silent clamps: 0 is not "20", and text is not a number.
      if (!/^[1-9]\d*$/.test(capRaw)) {
        capErr.textContent = "A whole number, 1 or more — this is how many messages one session may hold.";
        capErr.removeAttribute("hidden");
        cap.setAttribute("aria-invalid", "true");
        problem.textContent = "Not saved — the cap is not a number of 1 or more.";
        problem.removeAttribute("hidden");
        cap.focus();
        return;
      }
      if (!/^\d+$/.test(debRaw)) {
        debErr.textContent = "A whole number of milliseconds — 0 means no wait at all.";
        debErr.removeAttribute("hidden");
        debounce.setAttribute("aria-invalid", "true");
        problem.textContent = "Not saved — the debounce is not a number.";
        problem.removeAttribute("hidden");
        debounce.focus();
        return;
      }
      save.disabled = true;
      save.textContent = "Saving…";
      const tg = this.#selValue(tgDd.sel);
      const ok = await this.#commit([
        ["messages.queue.mode", this.#selValue(modeDd.sel)],
        ["messages.queue.cap", Number(capRaw)],
        ["messages.queue.drop", this.#selValue(dropDd.sel)],
        ["messages.queue.debounceMs", Number(debRaw)],
        ["messages.queue.byChannel", { ...(tg ? { telegram: tg } : {}) }],
      ], note, problem, "queue settings saved");
      save.disabled = false;
      save.textContent = "Save queue";
      if (ok) void this.render();
    };

    const zone = el("div", {}, [
      this.#section("While the agent is busy", "3 settings", [
        this.#setField("queue-mode", "Default mode", modeDd.node, "What happens to a message that arrives while a turn is running.", null),
        this.#setField("queue-cap", "Cap", el("div", { class: "setline" }, [cap, el("span", { class: "setcard__echo" }, ["messages"])]),
          "Held per session. The next message past the cap is dropped the way the overflow rule below says."),
        this.#setField("queue-debounce", "Debounce", el("div", { class: "setline" }, [debounce, el("span", { class: "setcard__echo" }, ["ms"])]),
          "How long to wait before merging queued messages. 0 merges immediately."),
        capErr,
        debErr,
      ]),
      this.#section("On overflow", "1 rule", [
        this.#setField("queue-drop", "When the cap is reached", dropDd.node, "Applies to whichever message has to go.", null),
      ]),
      this.#section("Per channel", "1 override", [
        this.#setField("queue-by-tg", "Telegram", tgDd.node, "A channel's own choice wins over the default mode above. A session's switch in the chat header wins over both.", null),
      ]),
    ]);
    this.#dirtyWatch(zone, note);
    syncStatus();

    return el("div", { class: "card auto-queue" }, [
      el("div", { class: "setcard__head" }, [
        el("h3", {}, ["Message queue"]),
        el("p", { class: "hint" }, ["What happens to a new message while the agent is still working on the last one."]),
      ]),
      strip.node,
      zone,
      el("div", { class: "setfoot" }, [note, problem, save]),
    ]);
  }

  /** Cron job editor (their Add/Edit job flow): the same validated contract as
   *  `sc cron add` — schedule + IANA zone checked by croner server-side — with the
   *  same checks done here first, so a typo is refused by the field that has it.
   *  Edits keep the job id + session key. */
  #cronJobDialog(job: any | null, config: any): void {
    const tf = (idSuffix: string, label: string, value: string, placeholder: string, mono = true) => {
      const input = el("input", {
        id: `cron-f-${idSuffix}`,
        class: mono ? "inp mono" : "inp",
        type: "text",
        value,
        placeholder,
        autocomplete: "off",
        spellcheck: "false",
      }) as HTMLInputElement;
      return {
        input,
        node: el("div", { class: "modal__field" }, [
          el("label", { class: "lbl", for: `cron-f-${idSuffix}` }, [label]),
          input,
        ]),
      };
    };
    const nameF = tf("name", "Name", String(job?.name ?? ""), "e.g. morning-brief", false);
    const schedF = tf("schedule", "Schedule (cron)", String(job?.schedule ?? job?.expr ?? ""), "e.g. 0 9 * * 1-5");
    const promptF = tf("prompt", "Prompt", String(job?.prompt ?? ""), "What the agent should do when it fires", false);
    const tzF = tf("tz", "Timezone (IANA, optional)", String(job?.tz ?? ""), "e.g. Asia/Dhaka — blank uses the host zone");
    const deliveryDd = this.#dropdown({
      id: "cron-f-delivery",
      value: String(job?.delivery_mode ?? ""),
      label: "Delivery",
      placeholder: "the configured default",
      options: [
        { value: "", label: "the configured default" },
        { value: "none", label: "none — keep it in the session" },
        { value: "announce", label: "announce — post the result to a chat" },
        { value: "webhook", label: "webhook — POST the result to a URL" },
      ],
    });
    const toF = tf("to", "Delivery target (optional)", String(job?.delivery_to ?? ""), "telegram:<chatId> · session:<key> · https://…");
    const suppressCb = el("input", { type: "checkbox", id: "cron-f-suppress" }) as HTMLInputElement;
    suppressCb.checked = Number(job?.delivery_suppress_empty ?? 1) === 1;
    const enabledCb = el("input", { type: "checkbox", id: "cron-f-enabled" }) as HTMLInputElement;
    enabledCb.checked = Number(job?.enabled ?? 1) === 1;
    const problem = el("p", { class: "hint hint--err" }, []);
    problem.setAttribute("hidden", "");

    const body = el("div", {}, [
      el("div", { class: "modal__sec" }, [
        el("span", { class: "cap" }, ["The job"]),
        nameF.node,
        schedF.node,
        promptF.node,
        tzF.node,
      ]),
      el("div", { class: "modal__sec" }, [
        el("span", { class: "cap" }, ["What happens to the result"]),
        el("div", { class: "modal__field" }, [
        el("label", { class: "lbl", for: "cron-f-delivery" }, ["Delivery"]),
        deliveryDd.node,
      ]),
        toF.node,
        el("div", { class: "row" }, [
          el("div", { class: "row__main" }, [
            el("label", { class: "row__label", for: "cron-f-suppress" }, ["Suppress empty results"]),
            el("span", { class: "hint" }, ["Sends nothing when a run finds nothing worth reporting."]),
          ]),
          suppressCb,
        ]),
      ]),
      el("div", { class: "row" }, [
        el("div", { class: "row__main" }, [
          el("label", { class: "row__label", for: "cron-f-enabled" }, ["Enabled"]),
          el("span", { class: "hint" }, ["Off keeps the job and its history but stops it firing."]),
        ]),
        enabledCb,
      ]),
      problem,
    ]);

    const fail = (message: string, focus?: HTMLInputElement): void => {
      problem.textContent = message;
      problem.removeAttribute("hidden");
      focus?.focus();
    };

    let close: () => void = () => {};
    modal({
      title: job ? `Edit job: ${job.name ?? job.id}` : "New cron job",
      render: (box, done) => {
        close = done;
        box.append(body);
      },
      confirmLabel: job ? "Save job" : "Create job",
      onConfirm: async () => {
        const name = nameF.input.value.trim();
        const schedule = schedF.input.value.trim();
        const prompt = promptF.input.value.trim();
        const tz = tzF.input.value.trim();
        const delivery = this.#selValue(deliveryDd.sel);
        const to = toF.input.value.trim();
        if (!name || !schedule || !prompt) {
          fail("Name, schedule and prompt are all required.", !name ? nameF.input : !schedule ? schedF.input : promptF.input);
          return;
        }
        const parts = schedule.split(/\s+/).filter(Boolean);
        if (!/^@[a-z]+$/i.test(schedule) && (parts.length < 5 || parts.length > 7)) {
          fail("That is not a cron schedule — 5 fields, e.g. 0 9 * * 1-5.", schedF.input);
          return;
        }
        if (tz) {
          try {
            new Intl.DateTimeFormat("en", { timeZone: tz });
          } catch {
            fail(`"${tz}" is not an IANA timezone — e.g. Asia/Dhaka.`, tzF.input);
            return;
          }
        }
        if (delivery === "webhook" && !to) {
          fail("Webhook delivery needs a target URL.", toF.input);
          return;
        }
        try {
          const res = (await gateway.request("cron.upsert", {
            ...(job?.id ? { id: String(job.id) } : {}),
            name,
            schedule,
            prompt,
            tz: tz || undefined,
            deliveryMode: delivery || undefined,
            deliveryTo: to || undefined,
            suppressEmpty: suppressCb.checked,
            enabled: enabledCb.checked,
          })) as any;
          toast(`${job ? "saved" : "created"} ${res.job?.name ?? name} · next ${res.next ?? "?"}`, "ok");
          close();
          await this.render();
        } catch (err) {
          fail((err as Error).message);
        }
      },
    });
  }

  /** IMAP account editor: leaf writes only — the account object is never
   *  round-tripped, so a redacted password can never be persisted as a sentinel
   *  string. Blank password = keep (their editor contract). */
  #imapAccountDialog(origName: string | null, acc: any | null, config: any): void {
    const tf = (idSuffix: string, label: string, value: string, placeholder: string, hint?: string) => {
      const input = el("input", { id: `imap-f-${idSuffix}`, class: "inp", type: "text", value, placeholder, autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
      return {
        input,
        node: el("div", { class: "modal__field" }, [
          el("label", { class: "lbl", for: `imap-f-${idSuffix}` }, [label]),
          input,
          ...(hint ? [el("span", { class: "hint" }, [hint])] : []),
        ]),
      };
    };
    const nameF = tf("name", "Account name", String(origName ?? ""), "e.g. work", "Used as the record key — letters, digits, dot, dash.");
    if (origName) nameF.input.disabled = true; // record key ≙ id: edits keep it
    const hostF = tf("host", "Host", String(acc?.host ?? ""), "imap.example.com");
    const portF = tf("port", "Port", String(acc?.port ?? 993), "993");
    const secureCb = el("input", { type: "checkbox", id: "imap-f-secure" }) as HTMLInputElement;
    secureCb.checked = acc?.secure !== false;
    const enabledCb = el("input", { type: "checkbox", id: "imap-f-enabled" }) as HTMLInputElement;
    enabledCb.checked = Number(acc?.enabled ?? 1) !== 0;
    const userF = tf("user", "Username", String(acc?.user ?? ""), "bot@example.com");
    const pwF = tf("password", origName ? "Password (blank keeps stored)" : "Password", "", origName ? "leave blank to keep" : "app password");
    pwF.input.type = "password";
    const pwEnvF = tf("passwenv", "Environment variable (optional)", String(acc?.passwordEnv ?? ""), "e.g. IMAP_PASS", "Reads the password from that variable instead of the config file.");
    const mbxF = tf("mailbox", "Mailbox", String(acc?.mailbox ?? "INBOX"), "INBOX");
    const watchDd = this.#dropdown({
      id: "imap-f-watch",
      value: String(acc?.watch?.mode ?? "auto"),
      label: "Watch mode",
      placeholder: "auto",
      options: [
        { value: "auto", label: "auto — real time, with polling as a fallback" },
        { value: "idle", label: "idle only — the server pushes new mail" },
        { value: "interval", label: "interval — check on a timer" },
      ],
    });
    const pollF = tf("poll", "Poll seconds", String(acc?.watch?.pollSeconds ?? 60), "60", "Used for polling; the floor is 15 seconds.");
    const sendersF = tf("senders", "Allowed senders (optional)", (acc?.allowedSenders ?? []).join(", "), "alice@x.com, bob@y.io",
      "Comma-separated addresses. Blank accepts every sender; @x.com accepts the whole domain.");
    const authDd = this.#dropdown({
      id: "imap-f-authmin",
      value: String(acc?.senderAuth?.min ?? "unverified"),
      label: "Sender authentication floor",
      placeholder: "unverified",
      options: [
        { value: "mutable", label: "mutable — no floor, any sender header passes" },
        { value: "unverified", label: "unverified — this build's floor" },
        { value: "asserted", label: "asserted — needs a DMARC verifier (not bundled)" },
        { value: "verified", label: "verified — needs a DMARC verifier (not bundled)" },
      ],
    });
    const authWarn = el("p", { class: "hint is-warn" }, ["This build has no DMARC verifier, so this floor can never be met: the watcher refuses to start and every message is rejected. Use unverified."]);
    authWarn.setAttribute("hidden", "");
    const syncAuthWarn = (): void => {
      const v = this.#selValue(authDd.sel);
      if (v === "asserted" || v === "verified") authWarn.removeAttribute("hidden");
      else authWarn.setAttribute("hidden", "");
    };
    authDd.sel.addEventListener("change", syncAuthWarn);
    syncAuthWarn();
    const deliverCb = el("input", { type: "checkbox", id: "imap-f-deliver" }) as HTMLInputElement;
    deliverCb.checked = Boolean(acc?.deliver);
    const toF = tf("to", "Deliver to (optional)", String(acc?.to ?? ""), "telegram:<chatId> | session:<key>");
    const bodyCb = el("input", { type: "checkbox", id: "imap-f-body" }) as HTMLInputElement;
    bodyCb.checked = acc?.includeBody !== false;
    const problem = el("p", { class: "hint hint--err" }, []);
    problem.setAttribute("hidden", "");

    let close: () => void = () => {};
    modal({
      title: origName ? `Edit IMAP account: ${origName}` : "New IMAP account",
      render: (box, done) => {
        close = done;
        box.append(
          el("div", { class: "modal__sec" }, [
            el("span", { class: "cap" }, ["Connection"]),
            nameF.node, hostF.node, portF.node, userF.node, pwF.node, pwEnvF.node,
            el("div", { class: "row" }, [
              el("div", { class: "row__main" }, [
                el("label", { class: "row__label", for: "imap-f-secure" }, ["Encrypted (TLS)"]),
                el("span", { class: "hint" }, ["Port 993 is usually TLS; port 143 usually is not."]),
              ]),
              secureCb,
            ]),
          ]),
          el("div", { class: "modal__sec" }, [
            el("span", { class: "cap" }, ["What gets read"]),
            mbxF.node,
            el("div", { class: "modal__field" }, [
              el("label", { class: "lbl", for: "imap-f-watch" }, ["Watch mode"]),
              watchDd.node,
            ]),
            pollF.node,
            sendersF.node,
            el("div", { class: "modal__field" }, [
              el("label", { class: "lbl", for: "imap-f-authmin" }, ["Sender authentication floor"]),
              authDd.node,
              authWarn,
            ]),
          ]),
          el("div", { class: "modal__sec" }, [
            el("span", { class: "cap" }, ["Where the answer goes"]),
            el("div", { class: "row" }, [
              el("div", { class: "row__main" }, [
                el("label", { class: "row__label", for: "imap-f-deliver" }, ["Deliver results"]),
                el("span", { class: "hint" }, ["Hands the run's answer to the chat named below."]),
              ]),
              deliverCb,
            ]),
            toF.node,
            el("div", { class: "row" }, [
              el("div", { class: "row__main" }, [
                el("label", { class: "row__label", for: "imap-f-body" }, ["Include the message body"]),
                el("span", { class: "hint" }, ["Off sends the subject and sender only."]),
              ]),
              bodyCb,
            ]),
            el("div", { class: "row" }, [
              el("div", { class: "row__main" }, [
                el("label", { class: "row__label", for: "imap-f-enabled" }, ["Enabled"]),
                el("span", { class: "hint" }, ["Off keeps the account but stops reading it."]),
              ]),
              enabledCb,
            ]),
          ]),
          problem,
        );
      },
      confirmLabel: origName ? "Save account" : "Add account",
      onConfirm: async () => {
        const rawName = origName ?? nameF.input.value.trim();
        if (!rawName) {
          problem.textContent = "The account needs a name — it is the record key.";
          problem.removeAttribute("hidden");
          nameF.input.focus();
          return;
        }
        const aname = rawName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "account";
        if (aname.includes(".")) {
          problem.textContent = "The name may not contain dots.";
          problem.removeAttribute("hidden");
          nameF.input.focus();
          return;
        }
        const host = hostF.input.value.trim();
        if (!host) {
          problem.textContent = "The host is required.";
          problem.removeAttribute("hidden");
          hostF.input.focus();
          return;
        }
        const portRaw = portF.input.value.trim();
        if (!/^\d+$/.test(portRaw) || Number(portRaw) < 1 || Number(portRaw) > 65535) {
          problem.textContent = "The port has to be a whole number between 1 and 65535.";
          problem.removeAttribute("hidden");
          portF.input.focus();
          return;
        }
        const pollRaw = pollF.input.value.trim();
        if (!/^\d+$/.test(pollRaw) || Number(pollRaw) < 15) {
          problem.textContent = "Poll seconds has to be a whole number of at least 15.";
          problem.removeAttribute("hidden");
          pollF.input.focus();
          return;
        }
        const senders = sendersF.input.value.split(",").map((x) => x.trim()).filter(Boolean);
        const base = `imap.accounts.${aname}`;
        const pairs: [string, unknown][] = [
          [`${base}.enabled`, enabledCb.checked],
          [`${base}.host`, host],
          [`${base}.port`, Number(portRaw)],
          [`${base}.secure`, secureCb.checked],
          [`${base}.user`, userF.input.value.trim()],
          [`${base}.mailbox`, mbxF.input.value.trim() || "INBOX"],
          [`${base}.watch`, { mode: this.#selValue(watchDd.sel), pollSeconds: Number(pollRaw) }],
          [`${base}.allowedSenders`, senders],
          [`${base}.senderAuth`, { ...(acc?.senderAuth ?? {}), min: this.#selValue(authDd.sel) }],
          [`${base}.deliver`, deliverCb.checked],
          [`${base}.to`, toF.input.value.trim()],
          [`${base}.includeBody`, bodyCb.checked],
        ];
        if (pwEnvF.input.value.trim()) pairs.push([`${base}.passwordEnv`, pwEnvF.input.value.trim()]);
        // Blank keeps the stored secret: the field is the only way to set one.
        if (pwF.input.value) pairs.push([`${base}.password`, pwF.input.value]);
        try {
          for (const [path, value] of pairs) await gateway.request("config.set", { path, value });
          toast(origName ? `account ${aname} saved` : `account ${aname} added`, "ok");
          this.#onChanged();
          close();
          await this.render();
        } catch (err) {
          problem.textContent = `not saved — ${(err as Error).message}`;
          problem.removeAttribute("hidden");
        }
      },
    });
  }

  /** Hook mapping editor: action + payload per path suffix. The name is the
   *  record key (URL segment), so it is write-once like account names. */
  #hookMappingDialog(origName: string | null, m: any | null, config: any): void {
    const tf = (idSuffix: string, label: string, value: string, placeholder: string, hint?: string) => {
      const input = el("input", { id: `hmap-f-${idSuffix}`, class: "inp", type: "text", value, placeholder, autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
      return {
        input,
        node: el("div", { class: "modal__field" }, [
          el("label", { class: "lbl", for: `hmap-f-${idSuffix}` }, [label]),
          input,
          ...(hint ? [el("span", { class: "hint" }, [hint])] : []),
        ]),
      };
    };
    const nameF = tf("name", "Mapping name (URL segment)", String(origName ?? ""), "e.g. github", "The last part of the URL — letters, digits, dot, dash.");
    if (origName) nameF.input.disabled = true;
    const actionDd = this.#dropdown({
      id: "hmap-f-action",
      value: String(m?.action ?? "agent"),
      label: "Action",
      placeholder: "agent",
      options: [
        { value: "agent", label: "agent — run the payload as a turn" },
        { value: "wake", label: "wake — nudge the main session" },
      ],
    });
    const msgF = tf("message", "Message template", String(m?.message ?? m?.text ?? ""), "{{body}} or a fixed instruction", "{{body}} and {{subject}} are filled from the request.");
    const keyF = tf("sessionkey", "Session key (optional)", String(m?.sessionKey ?? ""), "blank = the hook's own session");
    const problem = el("p", { class: "hint hint--err" }, []);
    problem.setAttribute("hidden", "");

    let close: () => void = () => {};
    modal({
      title: origName ? `Edit hook mapping: ${origName}` : "New hook mapping",
      render: (box, done) => {
        close = done;
        box.append(
          nameF.node,
          el("div", { class: "modal__field" }, [
            el("label", { class: "lbl", for: "hmap-f-action" }, ["Action"]),
            actionDd.node,
          ]),
          msgF.node,
          keyF.node,
          el("p", { class: "hint" }, ["Send a POST to this path followed by the mapping name, with `Authorization: Bearer <token>`."]),
          problem,
        );
      },
      confirmLabel: origName ? "Save mapping" : "Add mapping",
      onConfirm: async () => {
        const rawName = origName ?? nameF.input.value.trim();
        if (!rawName) {
          problem.textContent = "The mapping needs a name — it is the last part of the URL.";
          problem.removeAttribute("hidden");
          nameF.input.focus();
          return;
        }
        const mname = rawName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "mapping";
        if (mname.includes(".")) {
          problem.textContent = "The name may not contain dots.";
          problem.removeAttribute("hidden");
          nameF.input.focus();
          return;
        }
        try {
          await gateway.request("config.set", {
            path: `hooks.mappings.${mname}`,
            value: {
              action: this.#selValue(actionDd.sel),
              ...(msgF.input.value.trim() ? { message: msgF.input.value.trim() } : {}),
              ...(keyF.input.value.trim() ? { sessionKey: keyF.input.value.trim() } : {}),
            },
          });
          toast(origName ? `mapping ${mname} saved` : `mapping ${mname} added`, "ok");
          this.#onChanged();
          close();
          await this.render();
        } catch (err) {
          problem.textContent = `not saved — ${(err as Error).message}`;
          problem.removeAttribute("hidden");
        }
      },
    });
  }

  /* ---------------- alerts — this browser's notifications ---------------- */

  /** Alerts: what this browser may announce, and when it stays quiet.
   *
   *  Nothing on this card reaches the gateway — the prefs live in this browser's
   *  localStorage — so the card ends in the same footer band as every other one,
   *  but the commit writes that store. The state words describe what can appear
   *  right now; the raw permission API ("default") is not an answer anyone can
   *  act on, so it never reaches the page. */
  #renderAlerts(): void {
    const prefs = loadPrefs();
    const perm = permissionState();
    const stack = el("div", { class: "settings__stack" });

    const head = (hint: string): HTMLElement =>
      el("div", { class: "setcard__head" }, [
        el("h3", {}, ["Browser alerts"]),
        el("p", { class: "hint" }, [hint]),
      ]);

    // No Notification constructor in this browser: say so once, keep no controls
    // that would write prefs nothing can ever read.
    if (perm === "unsupported") {
      const strip = this.#statusStrip();
      strip.set("unsupported", "", "This browser cannot show notifications, so there is nothing to set here.");
      stack.append(el("div", { class: "card alerts-card" }, [
        head("Alerts are a banner from this browser when the agent needs your attention."),
        strip.node,
      ]));
      this.#root.append(stack);
      return;
    }

    /** Where these values live. The one fact a reader of this page must not miss. */
    const PERSIST = "Saved in this browser only — not in the config file, and not on your other devices.";

    const strip = this.#statusStrip();
    const note = el("span", { class: "setfoot__note", "aria-live": "polite" }, [PERSIST]);
    const problem = el("p", { class: "hint hint--err" }, []);
    problem.setAttribute("hidden", "");

    const enabledCb = el("input", { type: "checkbox", id: "alerts-enabled" }) as HTMLInputElement;
    enabledCb.checked = prefs.enabled;
    const approvalsCb = el("input", { type: "checkbox", id: "alerts-approvals" }) as HTMLInputElement;
    approvalsCb.checked = prefs.approvals;
    const replyCb = el("input", { type: "checkbox", id: "alerts-reply" }) as HTMLInputElement;
    replyCb.checked = prefs.reply;

    // A hand-edited store can hold anything; coerce before it reaches an attribute.
    const storedFromValue = String(prefs.quietFrom ?? "");
    const storedToValue = String(prefs.quietTo ?? "");
    const fromIn = el("input", {
      class: "inp mono",
      id: "alerts-quiet-from",
      value: storedFromValue,
      placeholder: "22:00",
      autocomplete: "off",
      spellcheck: "false",
      "aria-label": "Quiet hours start",
    }) as HTMLInputElement;
    const toIn = el("input", {
      class: "inp mono",
      id: "alerts-quiet-to",
      value: storedToValue,
      placeholder: "08:00",
      autocomplete: "off",
      spellcheck: "false",
      "aria-label": "Quiet hours end",
    }) as HTMLInputElement;

    /** `22:00` → `22:00`, `8:00` → `08:00`, anything else → "". The engine's own
     *  parser is looser and silently ignores what it cannot read; a page that does
     *  that would show a window that does nothing. */
    const parseTime = (raw: string): string => {
      const m = /^(\d{1,2}):(\d{2})$/.exec(raw);
      if (!m) return "";
      const h = Number(m[1]);
      const min = Number(m[2]);
      if (h > 23 || min > 59) return "";
      return `${String(h).padStart(2, "0")}:${m[2]}`;
    };

    /** The draft's own problem, in words, with the field(s) that carry it. */
    const quietProblem = (from: string, to: string): { message: string; fields: HTMLInputElement[] } | null => {
      const f = from ? parseTime(from) : "";
      const t = to ? parseTime(to) : "";
      if (from && !f) return { message: "The start is not a 24-hour time — use 22:00, not 10pm.", fields: [fromIn] };
      if (to && !t) return { message: "The end is not a 24-hour time — use 08:00, not 8am.", fields: [toIn] };
      if (Boolean(from) !== Boolean(to)) {
        return { message: "Set both times, or clear both to turn quiet hours off.", fields: [from ? toIn : fromIn] };
      }
      if (f && f === t) {
        return {
          message: "The start and the end are the same, which would silence every alert. Clear both to turn quiet hours off.",
          fields: [fromIn, toIn],
        };
      }
      return null;
    };

    const quietErr = el("p", { class: "hint hint--err", id: "alerts-quiet-err" }, []);
    quietErr.setAttribute("hidden", "");

    // A window stored by an older build (or edited by hand) may not be usable. Say
    // which way the engine is already treating it, instead of pretending it works.
    const storedFrom = storedFromValue.trim();
    const storedTo = storedToValue.trim();
    const storedOkFrom = storedFrom ? parseTime(storedFrom) : "";
    const storedOkTo = storedTo ? parseTime(storedTo) : "";
    if ((storedFrom && !storedOkFrom) || (storedTo && !storedOkTo) || Boolean(storedFrom) !== Boolean(storedTo)) {
      quietErr.textContent = "The saved window is not two valid times, so it is being ignored. Fix it below, or clear both.";
      quietErr.removeAttribute("hidden");
    } else if (storedOkFrom && storedOkFrom === storedOkTo) {
      quietErr.textContent = "The saved window starts and ends at the same time, which silences every alert. Clear both to turn quiet hours off.";
      quietErr.removeAttribute("hidden");
    }

    const quietField = el("div", { class: "setfield" }, [
      el("span", { class: "lbl" }, ["Window"]),
      el("div", { class: "setline alerts-quiet" }, [
        fromIn,
        el("span", { class: "setcard__echo" }, ["to"]),
        toIn,
      ]),
      el("p", { class: "hint" }, [
        "24-hour times. Leave both empty for no quiet hours; a window that crosses midnight is fine. Alerts in the window are dropped, not queued.",
      ]),
      quietErr,
    ]);

    // The tag answers "can an alert appear right now?" in order of what the reader
    // has to act on: the switch first (it is off on a fresh install), then the
    // browser's own answer. A blocked browser under an off switch is not "off" —
    // but the switch is still the thing to turn on, so the row below says blocked.
    const syncStatus = (): void => {
      if (!enabledCb.checked) {
        strip.set("off", "", "Nothing is sent, whatever is selected below.");
        return;
      }
      if (perm === "denied") {
        strip.set("blocked", "is-warn", "This browser blocks notifications for this site, so nothing below can be sent.");
        return;
      }
      if (perm === "default") {
        strip.set("not asked", "is-warn", "Nothing below can be sent until this browser is asked — use the button above.");
        return;
      }
      const a = approvalsCb.checked;
      const r = replyCb.checked;
      const kinds = a && r ? "Approval requests and finished replies are announced" : a ? "Approval requests are announced" : r ? "Finished replies are announced" : "";
      strip.set(
        "on",
        kinds ? "is-ok" : "is-warn",
        kinds ? `${kinds} while the tab is in the background.` : "Nothing is selected below, so no alert will appear.",
      );
    };

    /** One dependency to respect: nothing below the master switch can do anything
     *  while it is off, so nothing below it looks live either. */
    const syncAvailability = (): void => {
      const on = enabledCb.checked;
      for (const cb of [approvalsCb, replyCb]) cb.disabled = !on;
      for (const inp of [fromIn, toIn]) inp.disabled = !on;
      quietField.className = `setfield${on ? "" : " is-off"}`;
    };

    const askBtn = el("button", { class: "btn", type: "button", id: "alerts-ask" }, ["Ask this browser"]) as HTMLButtonElement;
    askBtn.onclick = async () => {
      askBtn.disabled = true;
      askBtn.textContent = "Asking…";
      const next = await askPermission();
      if (next === "granted") toast("this browser now allows alerts", "ok");
      else if (next === "denied") toast("the request was blocked — the browser's site settings can undo that", "err");
      else toast("the browser kept its previous answer");
      await this.render();
    };

    // Granted and blocked are facts here, not choices: the page cannot give or take
    // the permission, and a button that pretends to would be a lie.
    const permissionRow =
      perm === "granted"
        ? this.#factRow(
          "Browser permission",
          "allowed",
          "Granted to this site. The browser's own site settings are the only place to take it back.",
        )
        : perm === "denied"
          ? this.#factRow(
            "Browser permission",
            "blocked",
            "Site settings → Notifications is the only way back.",
          )
          : this.#settingRow(
            "Browser permission",
            "The browser shows its own prompt; this page cannot grant it for you.",
            askBtn,
            "alerts-ask",
          );

    const masterRow = this.#settingRow(
      "Send alerts from this browser",
      "One switch for this browser; the kinds below decide what it announces.",
      enabledCb,
      "alerts-enabled",
    );

    const announce = this.#section("What gets announced", "2 settings", [
      this.#settingRow("Approval requests", "A tool call is waiting for your answer.", approvalsCb, "alerts-approvals"),
      this.#settingRow("Finished replies", "A turn finished while you were in another tab.", replyCb, "alerts-reply"),
      el("p", { class: "hint" }, [
        "An alert says that something needs you — never the prompt, the tool's arguments or the reply.",
      ]),
    ]);

    const quiet = this.#section("Quiet hours", "2 times", [quietField]);

    const testNote = el("p", { class: "hint", "aria-live": "polite" }, []);
    testNote.setAttribute("hidden", "");
    const testBtn = el("button", { class: "btn", type: "button", id: "alerts-test" }, ["Send test"]) as HTMLButtonElement;
    // A test needs a permission to test with. "Not asked" still allows the click:
    // it is a user gesture, so the browser will show its prompt there.
    testBtn.disabled = perm === "denied";
    testBtn.onclick = async () => {
      testBtn.disabled = true;
      testBtn.textContent = "Sending…";
      testNote.removeAttribute("hidden");
      testNote.textContent = "Asking this browser to show one…";
      const ok = await sendTest();
      testBtn.disabled = perm === "denied";
      testBtn.textContent = "Send test";
      if (permissionState() !== perm) {
        // The click was this browser's first ask, so the card now has a different
        // fact to show. The toast keeps the outcome; the re-render keeps the row.
        toast(ok ? "test sent — this browser now allows alerts" : "the browser did not show it", ok ? "ok" : "err");
        void this.render();
        return;
      }
      testNote.textContent = ok
        ? "Sent — a banner should have appeared just now."
        : "Nothing appeared: this browser is not allowing notifications for this site.";
    };

    const test = this.#section("Send a test", "1 action", [
      el("p", { class: "hint" }, [
        perm === "denied"
          ? "The browser is blocking notifications for this site, so a test cannot appear."
          : "Sends one now, using the browser's permission. It ignores the switches above, so it still works with alerts off.",
      ]),
      el("div", { class: "settings__inline" }, [testBtn]),
      testNote,
    ]);

    const zone = el("div", {}, [masterRow, announce, quiet, test]);
    this.#dirtyWatch(zone, note);

    for (const inp of [fromIn, toIn]) {
      inp.addEventListener("input", () => {
        quietErr.setAttribute("hidden", "");
        inp.removeAttribute("aria-invalid");
        problem.setAttribute("hidden", "");
      });
    }
    enabledCb.onchange = () => {
      syncAvailability();
      syncStatus();
    };
    approvalsCb.onchange = () => syncStatus();
    replyCb.onchange = () => syncStatus();

    const save = el("button", { class: "btn pri", type: "button", id: "alerts-save" }, ["Save alerts"]) as HTMLButtonElement;
    save.onclick = () => {
      const from = fromIn.value.trim();
      const to = toIn.value.trim();
      const bad = quietProblem(from, to);
      if (bad) {
        quietErr.textContent = bad.message;
        quietErr.removeAttribute("hidden");
        for (const f of bad.fields) f.setAttribute("aria-invalid", "true");
        bad.fields[0]?.focus();
        problem.textContent = "Not saved — the quiet hours are not a usable window.";
        problem.removeAttribute("hidden");
        return;
      }
      try {
        // One write for the whole card: a half-written prefs object is worse than
        // none, and this store can refuse (private browsing, quota).
        savePrefs({
          enabled: enabledCb.checked,
          approvals: approvalsCb.checked,
          reply: replyCb.checked,
          quietFrom: from ? parseTime(from) : "",
          quietTo: to ? parseTime(to) : "",
        });
      } catch (err) {
        problem.textContent = `not saved — this browser refused the write (${(err as Error).message})`;
        problem.removeAttribute("hidden");
        return;
      }
      delete note.dataset["dirty"];
      toast("alerts saved — this browser only", "ok");
      // The status line and the normalised times come back from the store, so the
      // page never shows a draft it did not actually save.
      void this.render();
    };

    syncAvailability();
    syncStatus();

    stack.append(el("div", { class: "card alerts-card" }, [
      head("A banner from this browser when the agent needs your attention — only while the tab is in the background."),
      strip.node,
      permissionRow,
      zone,
      el("div", { class: "setfoot" }, [note, problem, save]),
    ]));
    this.#root.append(stack);
  }

  /* ---------------- runtime ---------------- */

  /** Runtime tab: the daemon Service card (OpenClaw status --deep + restart). */
  /* ---------------- system (P4 #41-#43 — their System care + Updates +
   *  Backup + Secrets pages, one System tab at our scale) ---------------- */

  async #renderSystem(config: any): Promise<void> {
    const body = el("div", { class: "settings__stack" });
    this.#root.innerHTML = "";
    this.#root.append(body);

    const mkCard = (title: string, kids: Node[]): HTMLElement =>
      el("div", { class: "card" }, [el("h3", {}, [title]), ...kids]);

    // ---------- Doctor ----------
    const docBody = el("div", {}, [el("p", { class: "hint" }, ["Probes have not run this session."])]);
    const runDoctor = el("button", { class: "btn", type: "button", id: "doctor-run" }, ["Run doctor"]) as HTMLButtonElement;
    runDoctor.onclick = async () => {
      docBody.innerHTML = "";
      docBody.append(el("p", { class: "hint" }, ["Running probes…"]));
      try {
        const res = (await gateway.request("system.doctor")) as any;
        docBody.innerHTML = "";
        for (const c of res.checks ?? []) {
          docBody.append(el("div", { class: "row diag-row" }, [
            el("span", { class: `diag-mark diag-mark--${c.status}` }, [c.status === "ok" ? "✔" : c.status === "warn" ? "▲" : "✖"]),
            el("span", { class: "row__label" }, [String(c.name)]),
            el("span", { class: "hint diag-row__detail" }, [String(c.detail), ...(c.fix ? [`  ·  fix: ${c.fix}`] : [])]),
          ]));
        }
        docBody.append(el("p", { class: "hint" }, [`${res.fails} failing, ${res.warns} warning(s)`]));
        const err = docBody.querySelector("");
        void err;
      } catch (err) {
        docBody.innerHTML = "";
        docBody.append(el("p", { class: "hint" }, [`doctor failed: ${(err as Error).message}`]));
      }
    };
    body.append(mkCard("Doctor — system checks", [docBody, runDoctor]));

    // ---------- Security audit ----------
    const secBody = el("div", {}, [el("p", { class: "hint" }, ["No audit run this session."])]);
    const runAudit = el("button", { class: "btn", type: "button", id: "security-audit-run" }, ["Run security audit"]) as HTMLButtonElement;
    runAudit.onclick = async () => {
      secBody.innerHTML = "";
      secBody.append(el("p", { class: "hint" }, ["Auditing posture…"]));
      try {
        const res = (await gateway.request("system.securityAudit")) as any;
        secBody.innerHTML = "";
        for (const f of res.findings ?? []) {
          secBody.append(el("div", { class: "row diag-row" }, [
            el("span", { class: `diag-mark diag-mark--${f.status}` }, [f.status === "ok" ? "✔" : f.status === "warn" ? "▲" : "✖"]),
            el("span", { class: "row__label" }, [String(f.name)]),
            el("span", { class: "hint diag-row__detail" }, [String(f.detail), ...(f.fix ? [`  ·  fix: ${f.fix}`] : [])]),
          ]));
        }
        secBody.append(el("p", { class: "hint" }, [`${res.fails} critical, ${res.warns} warning(s) — the CLI's \`sc security audit\` reads the same posture.`]));
      } catch (err) {
        secBody.innerHTML = "";
        secBody.append(el("p", { class: "hint" }, [`audit failed: ${(err as Error).message}`]));
      }
    };
    body.append(mkCard("Security audit", [secBody, runAudit]));

    // ---------- Updates ----------
    const updStatus = el("p", { class: "hint" }, ["Not checked this session."]);
    let checkedSha = "";
    let checkedBehind = false;
    const updBtn = el("button", { class: "btn", type: "button", id: "update-check" }, ["Check for updates"]) as HTMLButtonElement;
    const applyBtn = el("button", { class: "btn pri", type: "button", id: "update-apply", disabled: "true" }, ["Update now"]) as HTMLButtonElement;
    updBtn.onclick = async () => {
      updStatus.textContent = "Checking remote…";
      applyBtn.disabled = true;
      try {
        const res = (await gateway.request("system.update.check")) as any;
        if (!res.ok) {
          updStatus.textContent = res.error ?? "check failed";
          return;
        }
        checkedSha = String(res.remoteSha ?? "");
        checkedBehind = res.behind === true;
        updStatus.textContent = res.upToDate
          ? `up to date — ${res.slug}@${res.ref} ${String(res.currentSha ?? "").slice(0, 7)}`
          : `update available: ${String(res.currentSha ?? "").slice(0, 7)} → ${String(res.remoteSha ?? "").slice(0, 7)} on ${res.ref} (${res.remoteDate})`;
        applyBtn.disabled = !checkedBehind;
      } catch (err) {
        updStatus.textContent = `check failed: ${(err as Error).message}`;
      }
    };
    applyBtn.onclick = () => {
      // Their staged-build apply. Typed confirm: echo the target sha so a stale
      // check cannot silently swap in a different commit (RPC re-verifies too).
      const target = checkedSha ? checkedSha.slice(0, 12) : "";
      modal({
        title: "Apply update",
        body: el("div", {}, [
          el("p", {}, [`Download, build in staging, then swap to ${target}. Your current install stays in place until the staged build passes.`]),
          el("p", { class: "hint" }, [`Type ${target} to confirm. The gateway restarts afterwards (sc service restart).`]),
        ]),
        fields: [{ name: "sha", label: "Confirm target sha", placeholder: target }],
        confirmLabel: "Update",
        danger: true,
        onConfirm: async (values) => {
          applyBtn.disabled = true;
          updStatus.textContent = "Updating (staged build — this can take a few minutes)…";
          try {
            const res = (await gateway.request("system.update.apply", { sha: values["sha"]?.trim() ?? "" })) as any;
            if (!res.ok) {
              updStatus.textContent = res.error ?? "update failed — install unchanged";
              applyBtn.disabled = checkedBehind;
              return;
            }
            updStatus.textContent = res.upToDate
              ? "already up to date — nothing swapped"
              : `updated to ${String(res.sha ?? "").slice(0, 7)} — restart the service to run the new build`;
          } catch (err) {
            updStatus.textContent = `update failed: ${(err as Error).message}`;
            applyBtn.disabled = checkedBehind;
          }
        },
      });
    };
    body.append(mkCard("Software update", [updStatus, el("div", { class: "row row--actions" }, [updBtn, applyBtn])]));

    // ---------- Backup & restore (P4 #42) ----------
    const backupList = el("div", {}, [el("p", { class: "hint" }, ["Archives load on open."])]);
    let backupDir = "";
    const renderBackups = (rows: { file: string; size: number; mtime: string }[]): void => {
      backupList.innerHTML = "";
      if (rows.length === 0) {
        backupList.append(el("p", { class: "hint" }, ["No archives here yet — creates land in the state dir's backups/ folder."]));
        return;
      }
      for (const r of rows) {
        const full = `${backupDir}/${r.file}`.replace(/\/+$/g, "");
        const vt = el("button", { class: "btn", type: "button", title: "Verify archive" }, ["Verify"]) as HTMLButtonElement;
        vt.onclick = async () => {
          vt.disabled = true;
          try {
            const v = (await gateway.request("backup.verify", { archive: `${backupDir}/${r.file}` })) as any;
            toast(
              v.ok
                ? `verified: ${r.file} (${v.files ?? "?"} entries)`
                : `verify failed: ${(v.errors ?? []).join("; ") || "corrupt"}`,
              v.ok ? "ok" : "err",
            );
            void full;
          } catch (err) { toast((err as Error).message, "err"); }
          finally { vt.disabled = false; }
        };
        const rs = el("button", { class: "btn danger", type: "button" }, ["Restore…"]) as HTMLButtonElement;
        rs.onclick = () => {
          modal({
            title: `Restore ${r.file}`,
            body: el("div", {}, [
              el("p", {}, ["This swaps the config, state database snapshot and workspace payload into the state dir, then you restart the gateway."]),
              el("p", { class: "hint" }, ["The current state is replaced — create a fresh backup first if unsure."]),
            ]),
            confirmLabel: "Restore",
            danger: true,
            onConfirm: async () => {
              try {
                const res = (await gateway.request("backup.restore", { archive: `${backupDir}/${r.file}` })) as any;
                toast(`restored ${res.restored} file(s) — ${res.restart}`, "ok");
              } catch (err) {
                toast(`restore failed: ${(err as Error).message}`, "err");
              }
            },
          });
        };
        backupList.append(el("div", { class: "row cron-job", "data-archive": r.file }, [
          el("div", { class: "cron-job__body" }, [
            el("span", { class: "row__label" }, [r.file]),
            el("span", { class: "hint cron-job__meta" }, [`${(r.size / 1048576).toFixed(2)} MiB · ${r.mtime.slice(0, 19).replace("T", " ")}`]),
          ]),
          vt, rs,
        ]));
      }
    };
    const loadBackups = async (): Promise<void> => {
      try {
        const res = (await gateway.request("backup.list")) as any;
        backupDir = String(res.dir ?? "");
        renderBackups(res.backups ?? []);
      } catch { /* handler below swaps in the error */ }
    };
    const wsCb = el("input", { type: "checkbox", id: "backup-workspace" }) as HTMLInputElement;
    wsCb.checked = true;
    const cfgOnlyCb = el("input", { type: "checkbox", id: "backup-config-only" }) as HTMLInputElement;
    const createBtn = el("button", { class: "btn pri", type: "button", id: "backup-create" }, ["Create backup"]) as HTMLButtonElement;
    createBtn.onclick = async () => {
      createBtn.disabled = true;
      createBtn.textContent = "Creating…";
      try {
        const res = (await gateway.request("backup.create", {
          includeWorkspace: wsCb.checked,
          onlyConfig: cfgOnlyCb.checked,
          verify: true,
        })) as any;
        toast(
          `backup written: ${String(res.archivePath ?? "").split("/").pop()} (${res.files} file(s), ${(Number(res.bytes ?? 0) / 1048576).toFixed(2)} MiB${res.verified === false ? ", verification reported problems" : ", verified"})`,
          res.verified === false ? "err" : "ok",
        );
        for (const w of res.warnings ?? []) toast(`warn: ${w}`, "info");
        await loadBackups();
      } catch (err) {
        toast(`backup failed: ${(err as Error).message}`, "err");
      } finally {
        createBtn.disabled = false;
        createBtn.textContent = "Create backup";
      }
    };
    body.append(mkCard("Backup & restore", [
      backupList,
      el("div", { class: "row" }, [el("span", { class: "row__label" }, ["Include workspace"]), wsCb]),
      el("div", { class: "row" }, [el("span", { class: "row__label" }, ["Only config (skip state + workspace)"]), cfgOnlyCb]),
      el("p", { class: "hint" }, ["Consistent SQLite snapshot + atomic writes, archives never overwritten (P3 #29 parity with sc backup)."]),
      createBtn,
    ]));
    void loadBackups();

    // ---------- Secrets (P4 #43) ----------
    const secFindings = el("div", {}, [el("p", { class: "hint" }, ["Not audited this session."])]);
    const runSecrets = el("button", { class: "btn", type: "button", id: "secrets-audit-run" }, ["Audit secrets"]) as HTMLButtonElement;
    runSecrets.onclick = async () => {
      secFindings.innerHTML = "";
      secFindings.append(el("p", { class: "hint" }, ["Scanning the config for plaintext creds + unresolved refs…"]));
      try {
        const res = (await gateway.request("secrets.audit")) as any;
        secFindings.innerHTML = "";
        if (res.note) secFindings.append(el("p", { class: "hint" }, [String(res.note)]));
        else if (res.error) secFindings.append(el("p", { class: "hint" }, [String(res.error)]));
        else if ((res.findings ?? []).length === 0) {
          secFindings.append(el("div", { class: "row diag-row" }, [
            el("span", { class: "diag-mark diag-mark--ok" }, ["✔"]),
            el("span", { class: "row__label" }, ["No plaintext credentials or unresolved refs"]),
          ]));
        }
        for (const f of res.findings ?? []) {
          secFindings.append(el("div", { class: "row diag-row" }, [
            el("span", { class: "diag-mark diag-mark--fail" }, ["✖"]),
            el("span", { class: "hint diag-row__detail" }, [String(f)]),
          ]));
        }
        for (const w of res.warnings ?? []) {
          secFindings.append(el("div", { class: "row diag-row" }, [
            el("span", { class: "diag-mark diag-mark--warn" }, ["▲"]),
            el("span", { class: "hint diag-row__detail" }, [String(w)]),
          ]));
        }
      } catch (err) {
        secFindings.innerHTML = "";
        secFindings.append(el("p", { class: "hint" }, [`secrets audit failed: ${(err as Error).message}`]));
      }
    };
    const providersList = (Object.entries(config.providers ?? {}) as [string, any][]).map(([name, p]) =>
      el("div", { class: "row" }, [
        el("span", { class: "row__label" }, [name]),
        el("span", { class: "hint" }, [String(p.apiKey ?? "") === "" ? "no key (env only)" : /profiles|:/.test(String(p.apiKey)) && !String(p.apiKey).startsWith("sk-") ? `binding: ${String(p.apiKey).slice(0, 24)}…` : "stored credential (redacted)"]),
      ]),
    );
    body.append(mkCard("Secrets", [
      (providersList.length > 0
        ? el("div", {}, [el("div", { class: "setsec__head" }, [el("span", { class: "cap" }, ["Configured providers"])]), ...providersList])
        : el("p", { class: "hint" }, ["No providers configured yet."])),
      el("p", { class: "hint" }, [
        "Recipes: store raw keys in the environment as ${OPENAI_API_KEY} (channels tab hint) or use a SecretRef — {source: 'env' | 'file' | 'exec', provider, id}. See `sc secrets refs` for the exact shapes + validation patterns.",
      ]),
      secFindings,
      runSecrets,
    ]));
  }

  /** Runtime tab: the daemon behind this page — how it runs, what it has loaded,
   *  and the one action that restarts it.
   *
   *  Every fact here comes from the daemon's own payload. A read that fails says
   *  so; there is no fallback "Running", no hardcoded version and no config key
   *  standing in for a live value (the earlier page printed all three, plus
   *  `config.cron.jobs` — a field the schema has never had). */
  async #renderRuntime(config: any, counts: { tools: number; skills: number; models: number }): Promise<void> {
    // Two independent reads. The log is still evidence when the status call
    // fails, and the counts are still worth showing when the log cannot be read.
    let svc: any = null;
    let statusErr = "";
    try {
      svc = await gateway.request("service.status");
    } catch (err) {
      statusErr = (err as Error).message;
    }
    let logs: any = null;
    let logsErr = "";
    try {
      logs = await gateway.request("service.logs", { lines: 30 });
    } catch (err) {
      logsErr = (err as Error).message;
    }

    const openGateway = el("button", { class: "btn sm", type: "button", id: "runtime-open-gateway" }, ["Open Gateway"]) as HTMLButtonElement;
    openGateway.onclick = () => this.#setTab("gateway");

    this.#root.append(el("div", { class: "settings__stack" }, [
      this.#processCard(svc, statusErr, counts, config),
      this.#logCard(logs, logsErr),
      el("div", { class: "settings__inline" }, [
        el("p", { class: "hint" }, ["Port and bind are set on the Gateway tab."]),
        openGateway,
      ]),
    ]));
  }

  /** The daemon card: one status line, the facts it reports about itself, and the
   *  single action this tab owns. */
  #processCard(svc: any, loadErr: string, counts: { tools: number; skills: number; models: number }, config: any): HTMLElement {
    const strip = this.#statusStrip();
    const v = (svc ?? {}) as any;
    const installed = Boolean(v.installed);
    const supervised = Boolean(v.supervised);
    const running = Boolean(v.running);
    // Names in words, never the payload's keys; anything unknown prints itself.
    const managerWords: Record<string, string> = {
      "systemd-user": "systemd (user)",
      launchd: "launchd (macOS)",
      "termux-services": "Termux services (runit)",
    };
    const manager = v.manager ? managerWords[String(v.manager)] ?? String(v.manager) : "";
    const uptime = typeof v.uptimeMs === "number" ? fmtUptime(v.uptimeMs) : "";
    const sessionsKnown = typeof v.sessions === "number";
    const busy = Array.isArray(v.busy) ? v.busy.length : 0;

    // The strip answers "is it running, and would it come back?" in that order,
    // and claims nothing the payload does not support.
    if (!svc) {
      strip.set("unknown", "", `Could not read the daemon status${loadErr ? ` — ${loadErr}` : ""}.`);
    } else if (!running) {
      strip.set("answering", "is-warn", installed
        ? `This page is talking to the daemon, but there is no live pid record — the ${manager || "service"} service can still start it again.`
        : "This page is talking to the daemon, but there is no live pid record — a restart cannot be promised.");
    } else if (supervised) {
      strip.set("running", "is-ok", `Supervised by sc gateway — it starts the daemon again after a crash.${uptime ? ` Up ${uptime}.` : ""}`);
    } else if (installed) {
      strip.set("running", "is-ok", `Started by ${manager || "the service manager"} — it starts the daemon again after a crash.${uptime ? ` Up ${uptime}.` : ""}`);
    } else {
      strip.set("running", "is-warn", `No supervisor and no service: a crash leaves it down.${uptime ? ` Up ${uptime}.` : ""}`);
    }

    const processFacts: Node[] = [];
    const supervision: Node[] = [];
    if (svc) {
      processFacts.push(
        this.#factRow(
          "Process ids",
          v.pid ? (v.supervisorPid ? `child ${v.pid} · supervisor ${v.supervisorPid}` : `pid ${v.pid}`) : "not reported",
          "Reported from the pid record the daemon writes when it starts.",
        ),
        this.#factRow(
          "Uptime",
          running && uptime ? uptime : "unknown",
          v.startedAt ? `Started ${this.#relTime(v.startedAt)} — ${this.#when(v.startedAt)}.` : "Start time not recorded.",
        ),
        this.#factRow(
          "Listening on",
          v.port ? `port ${v.port}` : "not reported",
          running
            ? "The port the daemon wrote when it started. Bind and port are set on the Gateway tab."
            : "The port in the pid record. Bind and port are set on the Gateway tab.",
        ),
        this.#factRow(
          "Sessions",
          sessionsKnown ? String(v.sessions) : "unknown",
          sessionsKnown
            ? `${busy > 0 ? `${busy} working right now.` : "None are working right now."}${Number(v.sessions) >= 200 ? " The count stops at 200." : ""}`
            : "Not reported by this daemon.",
        ),
        this.#factRow("Version", String(v.version ?? "") || "unknown", "Reported by the daemon."),
      );

      const howRuns: [string, string] = running && supervised
        ? ["supervised by sc gateway", "The parent process restarts it after a crash."]
        : installed
          ? [`${manager || "service manager"} service`, "The service manager restarts it after a crash."]
          : running
            ? ["unsupervised", "Nothing restarts it after a crash."]
            : ["no live record", "Nothing is watching this process, so a restart would leave it down."];
      supervision.push(
        this.#factRow("How it runs", howRuns[0], howRuns[1]),
        this.#factRow(
          "Service manager",
          installed ? `${manager} — installed` : manager ? `${manager} — not installed` : "none installed",
          installed ? `Service file: ${String(v.servicePath ?? "")}` : "Nothing is installed as a service.",
        ),
        this.#factRow(
          "Starts at boot",
          installed ? (v.bootEnabled ? "enabled" : "disabled") : "not installed",
          installed
            ? (v.bootEnabled ? "The service manager starts it when the device boots." : "The service manager would not start it at boot.")
            : "Install a service first.",
        ),
      );
      if (!installed) {
        supervision.push(el("p", { class: "hint" }, [
          "Install it on the device — this page cannot: ",
          el("span", { class: "setcard__echo" }, ["sc service install"]),
        ]));
      }
    }

    // Two reasons a restart cannot be offered, each with its own sentence, and the
    // button disabled in exactly those states — so no dialog can stop the daemon
    // with nothing left to start it again.
    const canRestart = v.restartSupported === true && (running || installed);
    const restartWhy = !running
      ? installed
        ? `The pid record is gone, but the ${manager || "service"} service starts the daemon again within a second or two. Open chats reconnect by themselves; a reply that is mid-flight is cut off.`
        : "The daemon is answering, but its pid record is gone and nothing is installed as a service, so a restart would not come back. Restart it on the device."
      : v.restartSupported !== true
        ? "Nothing would start it again: no supervisor and no service. Start it with sc gateway (which supervises itself) or install it as a service first."
        : `${supervised ? "The supervisor" : `The ${manager || "service"} manager`} starts the daemon again within a second or two. Open chats reconnect by themselves; a reply that is mid-flight is cut off.`;

    const restart = el("button", { class: "btn", type: "button", id: "runtime-restart" }, ["Restart gateway"]) as HTMLButtonElement;
    restart.disabled = !canRestart;
    restart.onclick = () => {
      modal({
        title: "Restart the gateway?",
        body: "The daemon stops and is started again. Open chats reconnect by themselves; a reply that is mid-flight is cut off.",
        confirmLabel: "Restart",
        onConfirm: async () => {
          restart.disabled = true;
          restart.textContent = "Restarting…";
          try {
            const res: any = await gateway.request("service.restart", {});
            // The server's own answer decides the sentence, not the page's guess.
            toast(
              res?.willComeBack ? "restarting — this page reconnects by itself" : "stopping — nothing will start it again",
              res?.willComeBack ? "ok" : "err",
            );
            // The socket drops now; main.ts renders this tab again when it returns.
          } catch (err) {
            restart.disabled = false;
            restart.textContent = "Restart gateway";
            toast((err as Error).message, "err");
          }
        },
      });
    };

    const readAt = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const refresh = el("button", { class: "btn", type: "button", id: "runtime-refresh" }, ["Refresh"]) as HTMLButtonElement;
    refresh.onclick = () => void this.render();

    const loaded = this.#section("Loaded", "4 facts", [
      this.#factRow("Tools", String(counts.tools), "Registered and callable by the agent."),
      this.#factRow("Skills", String(counts.skills), "Found on this device; the eligible ones load into a turn."),
      this.#factRow("Models", String(counts.models), "The catalog this gateway can see."),
      this.#factRow("Providers", String(Object.keys(config?.providers ?? {}).length), "Configured in the config file."),
    ]);

    return el("div", { class: "card runtime-process" }, [
      el("div", { class: "setcard__head" }, [
        el("h3", {}, ["Gateway process"]),
        el("p", { class: "hint" }, ["The daemon behind this page: how it runs, what it has loaded, and how to restart it."]),
      ]),
      strip.node,
      ...(svc
        ? [
          this.#section("Process", "5 facts", processFacts),
          this.#section("Supervision", "3 facts", supervision),
          this.#section("Restart", "1 action", [
            el("p", { class: "hint" }, [restartWhy]),
            el("div", { class: "settings__inline" }, [restart]),
          ]),
        ]
        : [
          el("p", { class: "hint" }, [
            "The process behind this page, its supervision and whether a restart would come back are unknown until this read succeeds. Refresh tries again.",
          ]),
        ]),
      loaded,
      el("div", { class: "setfoot" }, [
        el("span", { class: "setfoot__note", "aria-live": "polite" }, [`Read at ${readAt}.`]),
        refresh,
      ]),
    ]);
  }

  /** The daemon's own log: a reader on the pattern the memory tab uses — a head,
   *  a count and the path the lines came from, then the text. The path is the one
   *  the server says it read, not `svc.logPath`: the tail falls back to the app
   *  log when the service log is empty. */
  #logCard(logs: any, loadErr: string): HTMLElement {
    const lines: string[] = Array.isArray(logs?.lines) ? (logs.lines as unknown[]).map(String) : [];
    const path = String(logs?.path ?? "");
    const tag = loadErr ? "unavailable" : lines.length === 0 ? "empty" : lines.length === 1 ? "1 line" : `${lines.length} lines`;
    const bodyText = loadErr
      ? `Could not read the log — ${loadErr}`
      : lines.length > 0 ? lines.join("\n") : "(the log is empty)";

    return el("div", { class: "card runtime-log" }, [
      el("div", { class: "setcard__head" }, [
        el("h3", {}, ["Service log"]),
        el("p", { class: "hint" }, ["The daemon's own log, oldest first. It is read when this page opens — Refresh reads it again."]),
      ]),
      el("div", { class: "setcard__status" }, [
        el("span", { class: "settings__tag" }, [tag]),
        el("span", { class: "setcard__status-note" }, [loadErr ? "The log file could not be read." : path]),
      ]),
      el("pre", { class: "diary__body" }, [bodyText]),
    ]);
  }

  /* ---------------- memory (OpenClaw's Dreams tab, adapted) ---------------- */

  async #renderMemory(): Promise<void> {
    // Three independent reads. A failure in one must not blank the page, and the
    // stored schedule has to survive the status call failing — otherwise the field
    // would silently re-default to 0 3 and a save would overwrite the real value.
    let loadErr = "";
    const grab = async (method: string): Promise<any> => {
      try {
        return await gateway.request(method);
      } catch (err) {
        loadErr ||= (err as Error).message;
        return null;
      }
    };
    const [status, diary, cfgRes] = await Promise.all([
      grab("dream.status"),
      grab("dream.diary"),
      grab("config.get"),
    ]);
    if (!status && loadErr) toast(`could not load memory: ${loadErr}`, "err");

    const dreamCfg: any = ((cfgRes?.config ?? null)?.memory?.dreaming ?? {}) as any;
    const counts = status?.counts ?? {
      memoryLines: 0, dailyNotes: 0, diaryEntries: 0, staged: 0, promotedToday: 0,
    };
    /* ---- state ---- */

    const scheduleError = String(status?.scheduleError ?? "");
    const schedValue = String(status?.schedule ?? dreamCfg.schedule ?? "0 3 * * *");
    let enabled = status ? status.enabled !== false : dreamCfg.enabled !== false;

    const stateTag = el("span", {
      class: `settings__tag${!status ? "" : scheduleError ? " is-warn" : enabled ? " is-ok" : ""}`,
    }, [!status ? "unknown" : scheduleError ? "invalid schedule" : enabled ? "on" : "off"]);
    const stateNote = el("span", { class: "setcard__status-note" }, [
      !status
        ? `Could not read the sweep state${loadErr ? ` — ${loadErr}` : ""}.`
        : scheduleError
          ? scheduleError
          : enabled
            ? status?.nextRunAt
              ? `Next sweep ${this.#relTime(status.nextRunAt)} — ${this.#when(status.nextRunAt)}.`
              : "No next sweep could be computed for this schedule."
            : "No sweep is scheduled. Dream now still runs one on demand.",
    ]);

    // The engine's rejection categories, in words. An unknown key is de-hyphenated
    // rather than dropped: a new verdict must stay readable, and the raw object
    // ({"deduped":1}) must never reach the page.
    const rejectWords: Record<string, string> = {
      deduped: "already in memory",
      "secret-masked": "looked like a secret",
      "below-score": "below the score gate",
      "few-signals": "too few signals",
      "stale-source": "the source changed",
    };
    const rejectionBits = Object.entries((status?.lastRejected ?? {}) as Record<string, number>)
      .filter(([, n]) => Number(n) > 0)
      .map(([k, n]) => `${n} ${rejectWords[k] ?? k.replace(/-/g, " ")}`);

    /* ---- controls ---- */

    const enabledCb = el("input", { type: "checkbox", id: "mem-dream-enabled" }) as HTMLInputElement;
    enabledCb.checked = enabled;

    const schedule = el("input", {
      class: "inp mono",
      id: "mem-dream-schedule",
      value: schedValue,
      placeholder: "0 3 * * *",
      autocomplete: "off",
      spellcheck: "false",
    }) as HTMLInputElement;

    const schedErr = el("p", { class: "hint hint--err", id: "mem-dream-sched-err" }, []);
    schedErr.setAttribute("hidden", "");

    const syncStatus = (): void => {
      stateTag.textContent = !status ? "unknown" : scheduleError ? "invalid schedule" : enabled ? "on" : "off";
      stateTag.className = `settings__tag${!status ? "" : scheduleError ? " is-warn" : enabled ? " is-ok" : ""}`;
      stateNote.textContent = !status
        ? `Could not read the sweep state${loadErr ? ` — ${loadErr}` : ""}.`
        : scheduleError
          ? scheduleError
          : enabled
            ? status?.nextRunAt
              ? `Next sweep ${this.#relTime(status.nextRunAt)} — ${this.#when(status.nextRunAt)}.`
              : "No next sweep could be computed for this schedule."
            : "No sweep is scheduled. Dream now still runs one on demand.";
    };
    enabledCb.onchange = () => { enabled = enabledCb.checked; syncStatus(); };

    const note = el("span", { class: "setfoot__note", "aria-live": "polite" }, []);
    const problem = el("p", { class: "hint hint--err" }, []);
    problem.setAttribute("hidden", "");

    const save = el("button", { class: "btn pri", type: "button", id: "mem-dream-save" }, ["Save dreaming"]) as HTMLButtonElement;
    save.onclick = async () => {
      const raw = schedule.value.trim();
      const parts = raw.split(/\s+/).filter(Boolean);
      // croner takes 5, 6 or 7 parts, or an @nickname — refusing @daily here would
      // be a new bug in the name of validation. A blank field is a real refusal,
      // not a silent substitution of the default.
      const ok = /^@[a-z]+$/i.test(raw) || (parts.length >= 5 && parts.length <= 7);
      if (!ok) {
        const msg = raw
          ? "Not a cron schedule — 5 fields, e.g. 0 3 * * *."
          : "A schedule is required — 0 3 * * * runs the sweep at 03:00.";
        schedErr.textContent = msg;
        schedErr.removeAttribute("hidden");
        schedule.setAttribute("aria-invalid", "true");
        problem.textContent = raw ? "Not saved — the schedule is not a cron expression." : "Not saved — the schedule is empty.";
        problem.removeAttribute("hidden");
        schedule.focus();
        return;
      }
      // One write for the whole block, merged over what is stored, so a failure
      // cannot leave enabled written and schedule not.
      const block = { ...structuredClone(dreamCfg), enabled: enabledCb.checked, schedule: raw };
      save.disabled = true;
      save.textContent = "Saving…";
      try {
        await gateway.request("config.set", { path: "memory.dreaming", value: block });
        note.textContent = "";
        delete note.dataset["dirty"];
        schedErr.setAttribute("hidden", "");
        schedule.removeAttribute("aria-invalid");
        problem.setAttribute("hidden", "");
        toast("dreaming saved — the next sweep follows the new schedule", "ok");
        this.#onChanged();
        // Re-armed by the config hot-reload: re-render for the new next run.
        void this.render();
      } catch (err) {
        problem.textContent = `not saved — ${(err as Error).message}`;
        problem.removeAttribute("hidden");
        toast(`not saved — ${(err as Error).message}`, "err");
      } finally {
        save.disabled = false;
        save.textContent = "Save dreaming";
      }
    };

    schedule.addEventListener("input", () => {
      if (schedErr.hasAttribute("hidden")) return;
      schedErr.setAttribute("hidden", "");
      schedule.removeAttribute("aria-invalid");
      problem.setAttribute("hidden", "");
    });

    const runBtn = el("button", { class: "btn", type: "button", id: "mem-dream-run" }, ["Dream now"]) as HTMLButtonElement;
    // The note belongs to the button, not to the commit band: it reports what this
    // click is doing, and it is announced when it appears.
    const runNote = el("p", { class: "hint", "aria-live": "polite" }, []);
    runNote.setAttribute("hidden", "");
    runBtn.onclick = async () => {
      runBtn.disabled = true;
      runBtn.textContent = "Dreaming…";
      runNote.removeAttribute("hidden");
      runNote.textContent = "Sweeping the daily notes into MEMORY.md — a large day can take a minute or two.";
      try {
        const res: any = await gateway.request("dream.run");
        const first = String(res?.text ?? "nothing new").split("\n")[0] ?? "";
        toast(`dream sweep done — ${first.slice(0, 120)}`, "ok");
        // Re-render so the counts, the diary and the next run all refresh.
        await this.render();
      } catch (err) {
        runBtn.disabled = false;
        runBtn.textContent = "Dream now";
        runNote.textContent = `sweep failed — ${(err as Error).message}`;
        toast((err as Error).message, "err");
      }
    };

    /* ---- what it keeps: a number per place, one line of explanation each ---- */

    const fact = (label: string, value: string, hint: string): HTMLElement =>
      el("div", { class: "row" }, [
        el("div", { class: "row__main" }, [
          el("span", { class: "row__label" }, [label]),
          el("span", { class: "hint" }, [hint]),
        ]),
        el("span", { class: "row__value" }, [value]),
      ]);

    const lastBits = [
      String(status?.lastVerdict ?? "").trim(),
      counts.staged ? `${counts.staged} staged` : "",
      rejectionBits.length ? `rejected ${rejectionBits.join(", ")}` : "",
    ].filter(Boolean);

    const policyZone = el("div", { class: "memory__policy" }, [
      fact(
        "Last sweep",
        status?.lastDreamAt ? this.#relTime(status.lastDreamAt) : "never",
        lastBits.length
          ? lastBits.join(" · ")
          : "No sweep has run yet — press Dream now, or wait for the schedule.",
      ),
      el("div", { class: "setsec" }, [
        el("div", { class: "setsec__head" }, [
          el("span", { class: "cap" }, ["Sweep"]),
          el("span", { class: "setsec__count" }, ["2 settings"]),
        ]),
        el("div", { class: "row" }, [
          el("div", { class: "row__main" }, [
            el("label", { class: "row__label", for: "mem-dream-enabled" }, ["Dream on a schedule"]),
            el("span", { class: "hint" }, ["Runs the sweep on the schedule below. Off: nothing runs on its own, but Dream now still works."]),
          ]),
          enabledCb,
        ]),
        el("div", { class: "setfield" }, [
          el("label", { class: "lbl", for: "mem-dream-schedule" }, ["Schedule (cron)"]),
          schedule,
          el("p", { class: "hint" }, ["5 fields, server time. The default is 0 3 * * * — 03:00 every night. This job never appears in Automations."]),
          el("p", { class: "hint" }, ["The same switch and schedule also appear on the Automations tab — one setting with two editors, so either page shows what the other wrote."]),
          schedErr,
        ]),
      ]),
      el("div", { class: "setsec" }, [
        el("div", { class: "setsec__head" }, [
          el("span", { class: "cap" }, ["What it keeps"]),
          el("span", { class: "setsec__count" }, ["3 places"]),
        ]),
        fact(
          "Curated memory",
          `${counts.memoryLines} ${counts.memoryLines === 1 ? "line" : "lines"}`,
          "MEMORY.md — the durable facts the sweep promotes. The memory tools edit it too.",
        ),
        fact(
          "Daily notes",
          `${counts.dailyNotes} ${counts.dailyNotes === 1 ? "file" : "files"}`,
          "One file per day under memory/. The sweep reads them and never edits them.",
        ),
        fact(
          "Dream diary",
          `${counts.diaryEntries} ${counts.diaryEntries === 1 ? "entry" : "entries"}`,
          "DREAMS.md — one entry per sweep, for you to read. It is never fed back into memory.",
        ),
      ]),
      el("div", { class: "setsec" }, [
        el("div", { class: "setsec__head" }, [
          el("span", { class: "cap" }, ["Run a sweep now"]),
          el("span", { class: "setsec__count" }, ["1 action"]),
        ]),
        el("p", { class: "hint" }, ["Uses the saved settings above, and runs even when the schedule is off."]),
        el("div", { class: "settings__inline" }, [runBtn]),
        runNote,
      ]),
    ]);
    const clearDirty = this.#dirtyWatch(policyZone, note);
    syncStatus();

    /* ---- the diary: entries inside the card, newest first ---- */

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
      // Sort by date rather than trusting the file's order: the file is append-only
      // today, but a hand-edited or merged DREAMS.md must still read newest first.
      entries.sort((a, b) => b.date.localeCompare(a.date));
    }
    const shown = entries.slice(0, 30);
    const lines = (body: string): number => body.split("\n").filter((l) => l.trim()).length;
    const diaryBody = el("div", { class: "diary-list" });
    if (diary === null) {
      diaryBody.append(el("p", { class: "hint" }, [`Could not read the diary${loadErr ? ` — ${loadErr}` : ""}.`]));
    } else if (shown.length === 0) {
      diaryBody.append(el("p", { class: "hint" }, ["No entries yet — press Dream now, or wait for the schedule."]));
    }
    for (const e of shown) {
      diaryBody.append(el("details", { class: "diary__entry" }, [
        el("summary", {}, [
          el("span", { class: "row__label" }, [`Deep Sleep — ${e.date}`]),
          el("span", { class: "row__value" }, [`${lines(e.body)} ${lines(e.body) === 1 ? "line" : "lines"}`]),
        ]),
        el("pre", { class: "diary__body" }, [e.body || "nothing new"]),
      ]));
    }

    const diaryCount = diary === null ? "unavailable" : `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`;
    const diaryNote = diary === null
      ? "The diary file could not be read."
      : [
        String(diary.dreamsPath ?? "DREAMS.md"),
        entries.length > shown.length ? `showing the ${shown.length} most recent` : "",
      ].filter(Boolean).join(" · ");

    const memoryText = String(diary?.memory ?? "").trim();

    const body = el("div", { class: "settings__stack" }, [
      el("div", { class: "card memory-dream" }, [
        el("div", { class: "setcard__head" }, [
          el("h3", {}, ["Dreaming"]),
          el("p", { class: "hint" }, [
            "A nightly sweep that folds the day's notes into MEMORY.md — light stage, themes, then consolidation.",
          ]),
        ]),
        el("div", { class: "setcard__status" }, [stateTag, stateNote]),
        policyZone,
        el("div", { class: "setfoot" }, [note, problem, save]),
      ]),
      el("div", { class: "card memory-diary" }, [
        el("div", { class: "setcard__head" }, [
          el("h3", {}, ["Dream diary"]),
          el("p", { class: "hint" }, [
            "One entry per sweep, newest first. Written for you to read — it is never fed back into memory.",
          ]),
        ]),
        el("div", { class: "setcard__status" }, [
          el("span", { class: "settings__tag" }, [diaryCount]),
          el("span", { class: "setcard__status-note" }, [diaryNote]),
        ]),
        diaryBody,
      ]),
      el("div", { class: "card memory-curated" }, [
        el("div", { class: "setcard__head" }, [
          el("h3", {}, ["Curated memory"]),
          el("p", { class: "hint" }, [
            "MEMORY.md — what the sweep promotes and what the agent reads at the start of a turn. Read-only here: edit it with the memory tools or in the file.",
          ]),
        ]),
        el("div", { class: "setcard__status" }, [
          el("span", { class: "settings__tag" }, [
            counts.memoryLines === 1 ? "1 line" : `${counts.memoryLines} lines`,
          ]),
          el("span", { class: "setcard__status-note" }, [String(diary?.memoryPath ?? "MEMORY.md")]),
        ]),
        el("pre", { class: "diary__body" }, [
          diary === null
            ? "Could not read MEMORY.md."
            : memoryText || "(empty — the sweep promotes durable facts here)",
        ]),
      ]),
    ]);

    clearDirty();
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

  /** Writes a batch of config leaves. Returns whether every write landed, so a
   *  caller can keep its "unsaved changes" marker honest — the toast alone
   *  cannot tell the form what happened. */
  async #setMany(pairs: [string, unknown][], message: string): Promise<boolean> {
    try {
      for (const [path, value] of pairs) {
        await gateway.request("config.set", { path, value });
      }
      toast(message, "ok");
      this.#onChanged();
      return true;
    } catch (err) {
      toast((err as Error).message, "err");
      return false;
    }
  }

  /** A field inside a settings card: label, control, explanatory sentence.
   *  `#cfgField` is the modal idiom (`modal__field`); a card wants `setfield`. */
  #setField(id: string, label: string, input: HTMLElement, hint?: string, forId: string | null = id): HTMLElement {
    return el("div", { class: "setfield" }, [
      // A `for` label only when the control it names can take focus. A dropdown
      // is a button next to a `display: none` store; its own aria-label names it.
      forId ? el("label", { class: "lbl", for: forId }, [label]) : el("span", { class: "lbl" }, [label]),
      input,
      ...(hint ? [el("p", { class: "hint" }, [hint])] : []),
    ]);
  }

  /** A distance in words ("in 3 h", "3 h ago"), used wherever a status line or a
   *  record row has to say *when* without printing a timestamp to the second. */
  #relTime(ms?: number | null): string {
    if (!ms) return "never";
    const mins = Math.round((ms - Date.now()) / 60000);
    const abs = Math.abs(mins);
    if (abs < 1) return mins >= 0 ? "in under a minute" : "under a minute ago";
    const span = abs < 60 ? `${abs} min` : abs < 1440 ? `${Math.round(abs / 60)} h` : `${Math.round(abs / 1440)} d`;
    return mins > 0 ? `in ${span}` : `${span} ago`;
  }

  /** The exact time, for the sentence that already said the distance. */
  #when(ms?: number | null): string {
    return ms ? new Date(ms).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "never";
  }

  /** A card's state line: a dot and words, then one sentence. Returned with a
   *  setter so a switch can keep it honest without a re-render. */
  #statusStrip(): { node: HTMLElement; set: (tag: string, tone: string, note: string) => void } {
    const tag = el("span", { class: "settings__tag" }, [""]);
    const note = el("span", { class: "setcard__status-note", "aria-live": "polite" }, [""]);
    const node = el("div", { class: "setcard__status" }, [tag, note]);
    return {
      node,
      set: (text: string, tone: string, sentence: string): void => {
        tag.textContent = text;
        tag.className = `settings__tag${tone ? ` ${tone}` : ""}`;
        note.textContent = sentence;
      },
    };
  }

  /** A boolean's row: what it does on the left (with the consequence), the switch
   *  on the right. The label is the control's name. */
  #settingRow(label: string, hint: string, control: HTMLElement, forId?: string): HTMLElement {
    return el("div", { class: "row" }, [
      el("div", { class: "row__main" }, [
        forId ? el("label", { class: "row__label", for: forId }, [label]) : el("span", { class: "row__label" }, [label]),
        el("span", { class: "hint" }, [hint]),
      ]),
      control,
    ]);
  }

  /** A read-only fact: a short value on the right, the explanation under the label. */
  #factRow(label: string, value: string, hint: string, tone: "" | "is-ok" | "is-warn" | "is-err" = ""): HTMLElement {
    return el("div", { class: "row" }, [
      el("div", { class: "row__main" }, [
        el("span", { class: "row__label" }, [label]),
        el("span", { class: "hint" }, [hint]),
      ]),
      el("span", { class: `row__value${tone ? ` ${tone}` : ""}` }, [value]),
    ]);
  }

  /** A named section with its count — the count is a quantity of what it holds. */
  #section(title: string, count: string, children: Node[]): HTMLElement {
    return el("div", { class: "setsec" }, [
      el("div", { class: "setsec__head" }, [
        el("span", { class: "cap" }, [title]),
        el("span", { class: "setsec__count" }, [count]),
      ]),
      ...children,
    ]);
  }

  /** A record's row: name and facts on the left, its verbs on the right, in the
   *  same order on every row (state, verb, edit, delete). */
  #recordRow(name: string, facts: string | (string | Node)[], controls: HTMLElement[], kind: string): HTMLElement {
    return el("div", { class: `row setrec ${kind}` }, [
      el("div", { class: "row__main" }, [
        el("span", { class: "row__label" }, [name]),
        el("span", { class: "hint" }, Array.isArray(facts) ? facts : [facts]),
      ]),
      el("div", { class: "cron-job__act" }, controls),
    ]);
  }

  /** Commit a card's draft. Unlike #setMany it puts the gateway's own refusal in
   *  the card's footer instead of only in a toast, so the sentence stays put. */
  async #commit(pairs: [string, unknown][], note: HTMLElement, problem: HTMLElement, okMessage: string): Promise<boolean> {
    try {
      for (const [path, value] of pairs) await gateway.request("config.set", { path, value });
      note.textContent = "";
      delete note.dataset["dirty"];
      problem.setAttribute("hidden", "");
      toast(okMessage, "ok");
      this.#onChanged();
      return true;
    } catch (err) {
      problem.textContent = `not saved — ${(err as Error).message}`;
      problem.removeAttribute("hidden");
      toast(`not saved — ${(err as Error).message}`, "err");
      return false;
    }
  }

  /** Read a select through its options rather than `.value`: the same helper then
   *  works for a preset (which sets a select programmatically) and for a save. */
  #selValue(sel: HTMLSelectElement): string {
    const os = [...sel.querySelectorAll("option")];
    return (os.find((o) => o.selected) ?? os[0])?.value ?? "";
  }

  /** One field on a settings page: short label, the control, then the sentence
   *  that explains it. `forId` only for real inputs — a dropdown trigger is a
   *  button and already names itself through aria-label. */
  #field(
    labelText: string,
    control: HTMLElement,
    opts: { hint?: string; forId?: string; narrow?: boolean } = {},
  ): HTMLElement {
    const label = opts.forId
      ? el("label", { class: "lbl", for: opts.forId }, [labelText])
      : el("span", { class: "lbl" }, [labelText]);
    return el("div", { class: `def-field${opts.narrow ? " def-field--narrow" : ""}` }, [
      label,
      control,
      ...(opts.hint ? [el("p", { class: "hint" }, [opts.hint])] : []),
    ]);
  }

  /** Watches a card for real edits and reports them through a footer note.
   *  Dropdown *searches* live inside the card and are not edits, so events from
   *  a menu are ignored; the hidden store's own change (a pick) is not. */
  /** The single place "there are unsaved edits" is written, so a DOM event and a
   *  programmatic change (picking an icon, setting a photo) say the same thing. */
  #dirtyMark(note: HTMLElement): void {
    note.textContent = "Unsaved changes";
    note.dataset["dirty"] = "1";
  }

  #dirtyWatch(card: HTMLElement, note: HTMLElement): () => void {
    const mark = (e: Event): void => {
      const t = e.target as HTMLElement | null;
      // Menus own their own state (typing in search is not an edit), and the photo
      // cluster reports its own outcome: the file input's `change` fires before the
      // decode finishes, so relying on it would claim an edit for a failed upload.
      if (t?.closest?.(".dd__menu") || t?.closest?.(".def-photo")) return;
      this.#dirtyMark(note);
    };
    card.addEventListener("input", mark);
    card.addEventListener("change", mark);
    return () => {
      note.textContent = "";
      delete note.dataset["dirty"];
    };
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
            // The refs already follow the new name (the gateway remaps them);
            // this only drops the old record. If it survives, say so instead of
            // leaving two providers behind silently.
            try {
              await gateway.request("providers.remove", { name });
            } catch (err) {
              toast(`renamed, but ${name} could not be removed: ${(err as Error).message}`, "err");
            }
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

  /** Remove one provider. The dialog counts what actually goes — including the
   *  saved models and credentials that only exist because of it — because a
   *  delete that leaves dead models in the picker is worse than no delete. */
  #removeProvider(name: string, providers: Record<string, Provider>, config: any, auth: any[], done: () => void): void {
    const advertised = (providers[name]?.models ?? []).length;
    // Names are matched case-insensitively: a key stored as "MultiRouter" owns
    // "MultiRouter/…" wherever the casing drifted.
    const owns = (ref: unknown): boolean =>
      String(ref ?? "").toLowerCase().startsWith(`${name.toLowerCase()}/`);
    const saved = Object.entries((config?.models ?? {}) as Record<string, any>)
      .filter(([, m]) => owns(m?.ref)).length;
    const creds = (auth ?? []).filter((p) => String(p?.provider ?? "").toLowerCase() === name.toLowerCase()).length;
    const def = String(config?.agents?.defaults?.model ?? "");
    const isDefault = owns(def);

    const lines = [`This removes ${name} and its ${advertised} models.`];
    if (saved) lines.push(`${saved} saved model${saved === 1 ? "" : "s"} in the system will be removed with it.`);
    if (creds) lines.push(`${creds} stored credential${creds === 1 ? "" : "s"} for it will be deleted.`);
    lines.push(
      isDefault
        ? `Your default model is ${def} — pick another one after this, or the agent has nothing to run.`
        : "Sessions that were using one of them will need another model.",
    );

    modal({
      title: "Remove provider?",
      body: lines.join(" "),
      confirmLabel: "Remove",
      danger: true,
      onConfirm: async () => {
        try {
          // purgeAuth: this is the user saying "remove it", not a rename
          // dropping the superseded record — the stored keys go with it.
          const res = (await gateway.request("providers.remove", { name, purgeAuth: true })) as any;
          // The gateway's message is a report: first line what happened, then any
          // warning (a default model left pointing at nothing). Splitting at the
          // first newline used to throw the warning away.
          const [head, ...rest] = String(res.message ?? `${name} removed`).split("\n").filter(Boolean);
          toast(head ?? `${name} removed`, "ok");
          for (const line of rest) toast(line.trim(), "err");
          done();
          this.#onChanged();
        } catch (err) {
          toast((err as Error).message, "err");
        }
      },
    });
  }
}

/** Write a dotted path inside a plain object — "typing.mode" sets
 *  `{ typing: { mode } }` without replacing the sibling keys. */
function setIn(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let cur: Record<string, unknown> = target;
  for (const part of parts.slice(0, -1)) {
    const next = cur[part];
    if (!next || typeof next !== "object") cur[part] = {};
    cur = cur[part] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]!] = value;
}

/** Read a dotted path back out; `undefined` when any step is missing. */
function readIn(source: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, part) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[part] : undefined), source);
}

/** A schema key as a human label: `basePath` → "Base path", `apiKey` → "API key",
 *  `botLoopProtection` → "Bot loop protection". Used for cards, groups and the
 *  choices of an enum, so the page never prints a camelCase identifier. */
function humanKey(key: string): string {
  const acronyms: Record<string, string> = {
    api: "API", url: "URL", uri: "URI", ui: "UI", http: "HTTP", https: "HTTPS",
    imap: "IMAP", smtp: "SMTP", pdf: "PDF", id: "ID", ip: "IP", tts: "TTS",
    stt: "STT", llm: "LLM", dns: "DNS", json: "JSON", ttl: "TTL", ms: "ms",
  };
  const proper: Record<string, string> = {
    openai: "OpenAI", duckduckgo: "DuckDuckGo", searxng: "SearXNG", imap: "IMAP",
    telegram: "Telegram", github: "GitHub",
  };
  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  if (words.length === 0) return key;
  return words
    .map((w, i) => {
      if (proper[w]) return proper[w];
      if (acronyms[w] && w.length <= 4) return acronyms[w];
      return i === 0 ? w.charAt(0).toUpperCase() + w.slice(1) : w;
    })
    .join(" ");
}

/** JSON-value equality, which is all the config holds. */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** A duration in the shortest honest form: `3d 4h`, `2h 5m`, `5m 4s`, `8s`. */
function fmtUptime(ms?: number): string {
  const sec = Math.max(0, Math.round(Number(ms ?? 0) / 1000));
  const d = Math.floor(sec / 86400), h = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60);
  return d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : m > 0 ? `${m}m ${sec % 60}s` : `${sec}s`;
}

function maskKey(key: string): string {
  if (!key) return "—";
  // The gateway already redacts secrets on the wire ("__redacted__:••••1234").
  if (key.startsWith("__redacted__:")) return key.slice("__redacted__:".length) || "••••";
  return key.length > 8 ? `${key.slice(0, 3)}••••••••${key.slice(-4)}` : "••••••••";
}
