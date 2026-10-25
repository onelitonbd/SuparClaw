// Settings: Defaults, Models, Providers, Skills, Tools, Gateway, Runtime —
// tabbed, one card per block.

import { el, fuzzy, icon, modal, toast } from "./dom.js";
import { AVATAR_ACCEPT, isStoredAvatar, prepareAvatar } from "./avatar.js";
import { friendlyModelName } from "./model-name.js";
import { gateway } from "./rpc.js";
import { loadPrefs, savePrefs, permissionState, sendTest, supported } from "./notifications.js";

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
    desc: "What the agent may run on this device, and what needs your approval.",
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
      this.#renderAgentDefaults(defaults);
    } else if (this.#tab === "models") {
      if (this.#modelsProvider) {
        this.#renderProviderModels(this.#modelsProvider, providers, configured, models, details, modelsWarning);
      } else {
        this.#renderModels(providers, configured, models, authProfiles, plugins);
      }
    } else if (this.#tab === "providers") this.#renderProviders(providers);
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
      const empty = el("option", { value: "" }, [placeholder]) as HTMLOptionElement;
      if (!v) empty.selected = true;
      sel.append(empty);
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
   *  reasoning + usage-visibility defaults — their Agents Defaults page. */
  #renderAgentDefaults(d: any): void {
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
      "1–40. How many tool calls one turn may make.");
    const budget = mkNum("ad-budget", "Context budget", Number(d.contextBudgetChars ?? 200000),
      "Characters, minimum 2000. Scales to ~70% of the model window when one is known.");
    const concur = mkNum("ad-concurrent", "Concurrent runs", Number(d.maxConcurrent ?? 0),
      "0 = auto (max(8, CPU × 4)).");
    const queueSel = mkSel("ad-queue", "Legacy queue mode", String(d.queueMode ?? "followup"),
      [["steer", "steer"], ["followup", "followup"]],
      "Kept for old configs — superseded by messages.queue.mode, which wins when both are set.");
    const reasoning = mkSel("ad-reasoning", "Reasoning effort", String(d.reasoningEffort ?? "inherit"),
      [["inherit", "inherit"], ["off", "off"], ["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "xhigh"], ["max", "max"]],
      "Sent to the provider as-is; inherit follows the model.");
    const viewSel = mkSel("ad-rview", "Show thinking blocks", String(d.reasoningView ?? "on"),
      [["on", "on"], ["off", "off"]],
      "Blocks are stored either way — off only hides them here.");
    const usageSel = mkSel("ad-usage", "Reply footer", String(d.usage ?? "tokens"),
      [["off", "off"], ["tokens", "tokens"], ["full", "full"], ["cost", "cost"]],
      "Cost needs a pricing card per model and degrades to tokens — never a guess.");
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
      sec("Loop & limits", [iterations.node, budget.node, concur.node, queueSel.node]),
      sec("Reasoning & replies", [reasoning.node, viewSel.node, usageSel.node]),
      sec("Subagents", [subConcur.node, subModel.node, subDepth.node, subThink.node, subDeleg.node]),
      el("div", { class: "setfoot" }, [note, saveD]),
    ]);
    const clearDirty = this.#dirtyWatch(card, note);

    saveD.onclick = async () => {
      const ok = await this.#setMany(
        [
          ["agents.defaults.maxToolIterations", Math.max(1, Math.min(40, Number(iterations.input.value) || 12))],
          ["agents.defaults.contextBudgetChars", Math.max(2000, Number(budget.input.value) || 60000)],
          ["agents.defaults.queueMode", queueSel.sel.value],
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

  #renderModels(
    providers: Record<string, Provider>,
    configured: any[],
    discovered: string[],
    auth: any[] = [],
    plugins: any[] = [],
  ): void {
    const selected = new Set(configured.filter((m) => m.enabled).map((m) => m.ref));
    const body = el("div", { class: "settings__stack" });

    this.#root.append(el("div", { class: "card setcard" }, [
      el("div", { class: "setcard__head" }, [
        el("h3", {}, ["Models"]),
        el("p", { class: "hint" }, [
          "Pick which models are in the system. Click a provider to see the models fetched from it — only checked models appear in the model picker and everywhere else. Connect signs a provider in via an auth profile (API key or OAuth device code).",
        ]),
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
      const card = el("div", { class: "card prov-card" }, [
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
          ...(chips.length ? [el("div", { class: "prov__row" }, chips)] : []),
          el("div", { class: "prov__row" }, [open, connect]),
        ]),
      ]);
      const go = () => {
        this.#modelsProvider = name;
        void this.render();
      };
      open.onclick = go;
      card.classList.add("prov-card");
      (card as HTMLElement).onclick = go;
      this.#root.append(card);
    }

    // Local services card (their implicit local discovery): lazy scan so the
    // tab never waits on a dead 11434 — results fill in when they arrive.
    const localCard = el("div", { class: "card" }, [
      el("h3", {}, ["Local services"]),
      el("p", { class: "hint" }, ["Scanning this device for Ollama, LM Studio, vLLM, SGLang and llama.cpp…"]),
    ]);
    this.#root.append(localCard);
    void this.#fillLocalServices(localCard, names);

    // Their Settings → Models → Connect provider: plugins not yet configured.
    const fresh = plugins.filter((p: any) => !names.includes(p.id));
    if (fresh.length) {
      const rows = fresh.slice(0, 12).map((p: any) => {
        const b = el("button", { class: "btn sm", type: "button" }, ["Connect"]);
        b.onclick = () => this.#connectProvider(p.id, p, "");
        return el("div", { class: "ledger__row" }, [
          el("div", { class: "ledger__main" }, [
            el("div", { class: "ledger__pattern" }, [p.id]),
            el("div", { class: "ledger__meta" }, [p.label]),
          ]),
          b,
        ]);
      });
      this.#root.append(el("div", { class: "card setcard" }, [
      el("div", { class: "setcard__head" }, [
        el("h3", {}, ["Connect provider"]),
        el("p", { class: "hint" }, ["Provider plugins with declared auth flows — the same entry point as the CLI (`sc models auth login`)."]),
      ]),
      ...rows,
    ]));
    }

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
    card.append(el("h3", {}, ["Local services"]));
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
      card.append(el("div", { class: "ledger__row" }, [
        el("div", { class: "ledger__main" }, [
          el("div", { class: "ledger__pattern" }, [svc.id]),
          el("div", { class: "ledger__meta" }, [
            svc.running
              ? `running · ${svc.models.length} model(s) · ${svc.api === "ollama" ? "native api" : "openai-compat"}${isConfigured ? " · configured" : ""}`
              : (svc.error ?? "not running"),
          ]),
        ]),
        add,
      ]));
      if (svc.running && svc.models.length) {
        card.append(el("div", { class: "hint" }, [
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
        class: `chip${p.ok ? "" : " is-err"}`,
        title: `${p.label || p.id}${p.reason ? ` — ${p.reason}` : ""} · fails ${p.failCount}`,
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
        el("div", { class: "prov__head" }, [
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

        // The name opens the tuner, so it is a button — a span with a click
        // handler would be invisible to the keyboard.
        const name = el("button", { class: "pickrow__name mono", type: "button", title: ref }, [tail]);
        name.onclick = openTune;

        list.append(el("div", { class: "pickrow" }, [
          check,
          name,
          ctx ? el("span", { class: "pickrow__meta" }, [`${Math.round(ctx / 1000)}k ctx`]) : el("span", {}),
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

    const effortDd = this.#dropdown({
      id: "f-effort",
      value: existing?.reasoningEffort ?? "inherit",
      label: "Default thinking",
      placeholder: "— choose —",
      options: ["inherit", "off", "low", "medium", "high", "xhigh", "max"].map((v) => ({ value: v, label: v })),
    });
    const effortSel = effortDd.sel;

    modal({
      title: ref,
      confirmLabel: existing ? "Save" : "Save & select",
      render: (body, c) => {
        close = c;
        body.append(
          labelF.wrap, ctxF.wrap, maxF.wrap, tempF.wrap,
          el("div", { class: "modal__field" }, [
            el("label", { class: "lbl", for: "f-effort-btn" }, ["Default thinking"]),
            effortDd.node,
            el("p", { class: "hint" }, ["Per-model default; a session thinking choice still overrides it."]),
          ]),
          existing
            ? (() => {
                const rm = el("button", { class: "btn danger", type: "button" }, ["Remove from system"]);
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

  /** Provider auth & connectivity buttons (P4 #44 — their Connect provider:
   *  one-tap device-code sign-in, credential probe, connection test). All
   *  three surface the gateway's own verdict text — no client-side guesses. */
  #providerAuthButtons(name: string): HTMLElement[] {
    const test = el("button", { class: "btn", type: "button", id: `prov-test-${name}`, title: "providers.test" }, ["Test"]) as HTMLButtonElement;
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

    const probe = el("button", { class: "btn", type: "button", id: `prov-probe-${name}`, title: "models.auth.probe" }, ["Probe"]) as HTMLButtonElement;
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

    const signin = el("button", { class: "btn pri", type: "button", id: `prov-signin-${name}`, title: "OAuth device code" }, ["Sign in"]) as HTMLButtonElement;
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

  #renderProviders(providers: Record<string, Provider>): void {
    this.#root.append(el("div", { class: "card setcard" }, [
      el("div", { class: "setcard__head" }, [
        el("h3", {}, ["Providers"]),
        el("p", { class: "hint" }, ["Base URLs and credentials for each endpoint. Test and probe a provider before relying on it."]),
      ]),
    ]));
    for (const [name, p] of Object.entries(providers)) {
      const edit = el("button", { class: "btn", type: "button" }, ["Edit"]);
      edit.onclick = () => this.#providerForm(name, providers, () => void this.render());
      const remove = el("button", { class: "btn danger", type: "button" }, ["Remove"]);
      remove.onclick = () => this.#removeProvider(name, providers, () => void this.render());

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
  #cfgSel(id: string, cur: string, options: [string, string][]): HTMLSelectElement {
    const sel = el("select", { class: "in", id }) as HTMLSelectElement;
    for (const [v, label] of options) {
      sel.append(el("option", { value: v, ...(cur === v ? { selected: "" } : {}) }, [label]));
    }
    return sel;
  }
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

  /** Exec policy (P4 #38 — their tools.exec page): the full safety surface:
   *  enabled/approvals, ask fallback with nobody-to-ask, safe-bin lists,
   *  sandbox/Proot, unattended sources, timeout. */
  #execPolicyCard(config: any): HTMLElement {
    const x = config.tools?.exec ?? {};
    const enabledCb = this.#cfgCheck("x-enabled", "Exec enabled", Boolean(x.enabled));
    const approvalsCb = this.#cfgCheck("x-approvals", "Approvals (legacy bool — blank mode follows this)", x.approvals !== false);
    const inlineCb = this.#cfgCheck("x-inline", "Never auto-allow inline eval (node -e, bash -c …)", Boolean(x.strictInlineEval));
    const prootCb = this.#cfgCheck("x-proot", "Proot filesystem jail (strict mode; needs proot binary)", Boolean(x.sandboxProot));
    const modeSel = this.#cfgSel("x-mode", String(x.mode ?? ""), [
      ["", "inherit (follow approvals bool)"], ["deny", "deny"], ["allowlist", "allowlist"], ["ask", "ask"], ["full", "full"],
    ]);
    const askSel = this.#cfgSel("x-askfb", String(x.askFallback ?? "deny"), [
      ["deny", "deny"], ["allowlist", "allowlist"], ["full", "full"],
    ]);
    const unatSel = this.#cfgSel("x-unattended", String(x.unattended ?? "deny"), [
      ["deny", "deny — decline loudly (default)"], ["allowlist", "allowlist — safe bins only"], ["all", "all — auto-allow"],
    ]);
    const sandSel = this.#cfgSel("x-sandbox", String(x.sandbox ?? "off"), [
      ["off", "off (plain)"], ["strict", "strict (scrubbed env + prlimit caps)"],
    ]);
    const binsF = this.#cfgStr("x-bins", "Safe bins (comma)", (x.safeBins ?? []).join(", "), "cut, uniq, head, tail, tr, wc");
    const dirsF = this.#cfgStr("x-dirs", "Safe-bin trusted dirs (comma)", (x.safeBinTrustedDirs ?? []).join(", "), "/bin, /usr/bin");
    const timeoutF = this.#cfgNum("x-timeout", "Timeout per command (ms, 1000–600000)", Number(x.timeoutMs ?? 600000), "safety cap only — a hung command cannot block a session forever");

    const save = el("button", { class: "btn", type: "button", id: "exec-policy-save" }, ["Save"]) as HTMLButtonElement;
    save.onclick = () => {
      void this.#setMany(
        [
          ["tools.exec.enabled", enabledCb.input.checked],
          ["tools.exec.approvals", approvalsCb.input.checked],
          ["tools.exec.mode", /^(deny|allowlist|ask|full)$/.test(modeSel.value) ? modeSel.value : ""],
          ["tools.exec.askFallback", askSel.value],
          ["tools.exec.strictInlineEval", inlineCb.input.checked],
          ["tools.exec.safeBins", binsF.input.value.split(",").map((v) => v.trim()).filter(Boolean)],
          ["tools.exec.safeBinTrustedDirs", dirsF.input.value.split(",").map((v) => v.trim()).filter(Boolean)],
          ["tools.exec.timeoutMs", Math.max(1000, Math.min(600000, Number(timeoutF.input.value) || 600000))],
          ["tools.exec.sandbox", sandSel.value],
          ["tools.exec.sandboxProot", prootCb.input.checked],
          ["tools.exec.unattended", unatSel.value],
        ],
        "exec policy saved — applies to the next tool call",
      );
    };

    return el("div", { class: "card exec-policy" }, [
      el("h3", {}, ["Exec policy"]),
      enabledCb.node, approvalsCb.node,
      this.#cfgField("x-mode", "Policy mode", modeSel, "deny | allowlist | ask | full — blank follows the legacy approvals bool (their unset-is-a-state rule)"),
      this.#cfgField("x-askfb", "Ask fallback (no client connected)", askSel),
      inlineCb.node, binsF.node, dirsF.node, timeoutF.node,
      this.#cfgField("x-sandbox", "Sandbox", sandSel),
      prootCb.node,
      this.#cfgField("x-unattended", "Unattended sources (cron/webhook)", unatSel, "every unattended auto-decision is audited to the log + transcript"),
      el("div", { class: "setfoot" }, [save]),
    ]);
  }

  /** Code Mode card (P4 #38 — their tools.codeMode): sandboxed JS execution
   *  of tool calls for preferred models. */
  #codeModeCard(config: any): HTMLElement {
    const c = config.tools?.codeMode ?? {};
    const enSel = this.#cfgSel("cm-enabled", String(c.enabled ?? "auto"), [
      ["auto", "auto (preferred models only)"], ["true", "true (always)"], ["false", "false"],
    ]);
    const exSel = this.#cfgSel("cm-executor", String(c.executor ?? "node"), [
      ["node", "node (default)"], ["quickjs", "quickjs"],
    ]);
    const timeoutF = this.#cfgNum("cm-timeout", "Timeout (ms, 100–60000)", Number(c.timeoutMs ?? 10000));
    const charsF = this.#cfgNum("cm-chars", "Max code chars", Number(c.maxCodeChars ?? 32768));
    const outF = this.#cfgNum("cm-out", "Max output bytes", Number(c.maxOutputBytes ?? 65536));
    const pendF = this.#cfgNum("cm-pend", "Max pending tool calls", Number(c.maxPendingToolCalls ?? 16));
    const directF = this.#cfgStr("cm-direct", "Direct-only tools (comma)", (c.directOnly ?? []).join(", "), "tool names that may never be code-wrapped");
    const save = el("button", { class: "btn", type: "button", id: "codemode-save" }, ["Save"]) as HTMLButtonElement;
    save.onclick = () => {
      void this.#setMany(
        [
          ["tools.codeMode.enabled", enSel.value],
          ["tools.codeMode.executor", exSel.value],
          ["tools.codeMode.timeoutMs", Math.max(100, Math.min(60000, Number(timeoutF.input.value) || 10000))],
          ["tools.codeMode.maxCodeChars", Math.max(1024, Number(charsF.input.value) || 32768)],
          ["tools.codeMode.maxOutputBytes", Math.max(1024, Math.min(10485760, Number(outF.input.value) || 65536))],
          ["tools.codeMode.maxPendingToolCalls", Math.max(1, Math.min(128, Number(pendF.input.value) || 16))],
          ["tools.codeMode.directOnly", directF.input.value.split(",").map((v) => v.trim()).filter(Boolean)],
        ],
        "code mode saved",
      );
    };
    return el("div", { class: "card" }, [
      el("h3", {}, ["Code mode"]),
      this.#cfgField("cm-enabled", "Enabled", enSel),
      this.#cfgField("cm-executor", "Executor", exSel),
      timeoutF.node, charsF.node, outF.node, pendF.node, directF.node,
      el("div", { class: "setfoot" }, [save]),
    ]);
  }

  /** Media understanding card (P4 #38 — their tools.media): per-capability
   *  limits + preferred models + transcript echo. Per-capability model refs
   *  use the configured models list (plain text, e.g. openai/vision-model). */
  #mediaCard(config: any): HTMLElement {
    const m = config.tools?.media ?? {};
    const concF = this.#cfgNum("md-conc", "Concurrency", Number(m.concurrency ?? 2));
    const img = m.image ?? {};
    const aud = m.audio ?? {};
    const pdf = m.pdf ?? {};
    const imgCb = this.#cfgCheck("md-img-on", "Image understanding", img.enabled !== false);
    const imgModel = this.#cfgStr("md-img-model", "Preferred image model", String(img.preferredModel ?? ""), "provider/model ref");
    const imgChars = this.#cfgNum("md-img-chars", "Image max chars", Number(img.maxChars ?? 500));
    const imgBytes = this.#cfgNum("md-img-bytes", "Image max bytes", Number(img.maxBytes ?? 10485760));
    const imgTimeout = this.#cfgNum("md-img-timeout", "Image timeout (s)", Number(img.timeoutSeconds ?? 60));
    const imgAllCb = this.#cfgCheck("md-img-all", "Send ALL attachments to the model", Boolean(img.attachments_all));
    const audCb = this.#cfgCheck("md-aud-on", "Audio transcription", aud.enabled !== false);
    const audModel = this.#cfgStr("md-aud-model", "Preferred audio model", String(aud.preferredModel ?? ""), "provider/model ref");
    const audBytes = this.#cfgNum("md-aud-bytes", "Audio max bytes", Number(aud.maxBytes ?? 20971520));
    const audTimeout = this.#cfgNum("md-aud-timeout", "Audio timeout (s)", Number(aud.timeoutSeconds ?? 60));
    const audLang = this.#cfgStr("md-aud-lang", "Audio language", String(aud.language ?? ""), "e.g. en (blank = auto)");
    const audEchoCb = this.#cfgCheck("md-aud-echo", "Echo transcript to chat", Boolean(aud.echoTranscript));
    const audFmt = this.#cfgStr("md-aud-fmt", "Echo format", String(aud.echoFormat ?? '📝 "{transcript}"'), "use {transcript}");
    const pdfCb = this.#cfgCheck("md-pdf-on", "PDF understanding", pdf.enabled !== false);
    const pdfBytes = this.#cfgNum("md-pdf-bytes", "PDF max bytes", Number(pdf.maxBytes ?? 10485760));
    const pdfChars = this.#cfgNum("md-pdf-chars", "PDF max chars", Number(pdf.maxChars ?? 4000));
    const pdfTimeout = this.#cfgNum("md-pdf-timeout", "PDF timeout (s)", Number(pdf.timeoutSeconds ?? 60));

    const save = el("button", { class: "btn", type: "button", id: "media-save" }, ["Save"]) as HTMLButtonElement;
    save.onclick = () => {
      void this.#setMany(
        [
          ["tools.media.concurrency", Math.max(1, Number(concF.input.value) || 2)],
          ["tools.media.image", {
            enabled: imgCb.input.checked,
            preferredModel: imgModel.input.value.trim(),
            prompt: String(img.prompt ?? ""),
            maxChars: Math.max(0, Number(imgChars.input.value) || 500),
            maxBytes: Math.max(0, Number(imgBytes.input.value) || 10485760),
            timeoutSeconds: Math.max(0, Number(imgTimeout.input.value) || 60),
            attachments_all: imgAllCb.input.checked,
          }],
          ["tools.media.audio", {
            enabled: audCb.input.checked,
            preferredModel: audModel.input.value.trim(),
            maxBytes: Math.max(0, Number(audBytes.input.value) || 20971520),
            timeoutSeconds: Math.max(0, Number(audTimeout.input.value) || 60),
            language: audLang.input.value.trim(),
            echoTranscript: audEchoCb.input.checked,
            echoFormat: audFmt.input.value.trim() || '📝 "{transcript}"',
          }],
          ["tools.media.pdf", {
            enabled: pdfCb.input.checked,
            maxBytes: Math.max(0, Number(pdfBytes.input.value) || 10485760),
            maxChars: Math.max(0, Number(pdfChars.input.value) || 4000),
            timeoutSeconds: Math.max(0, Number(pdfTimeout.input.value) || 60),
          }],
        ],
        "media understanding saved",
      );
    };

    return el("div", { class: "card" }, [
      el("h3", {}, ["Media understanding"]),
      concF.node,
      imgCb.node, imgModel.node, imgChars.node, imgBytes.node, imgTimeout.node, imgAllCb.node,
      el("div", { class: "usage-h" }, ["Audio"]),
      audCb.node, audModel.node, audBytes.node, audTimeout.node, audLang.node, audEchoCb.node, audFmt.node,
      el("div", { class: "usage-h" }, ["PDF"]),
      pdfCb.node, pdfBytes.node, pdfChars.node, pdfTimeout.node,
      el("div", { class: "setfoot" }, [save]),
    ]);
  }

  async #webSearchCard(): Promise<HTMLElement> {
    let st: any;
    try {
      st = await gateway.request("web.search.get");
    } catch (err) {
      return el("div", { class: "card" }, [
        el("h3", {}, ["Web search"]),
        el("p", { class: "hint" }, [`Search config unread — ${(err as Error).message}`]),
      ]);
    }
    const IDS = st.providers.map((p: any) => p.id as string);
    const configured = st.provider as string;
    const enableBox = el("input", { type: "checkbox" }) as HTMLInputElement;
    enableBox.checked = st.enabled === true;
    enableBox.onchange = async () => {
      try {
        await gateway.request("config.set", { path: "tools.web.search.enabled", value: enableBox.checked });
        toast(`web search ${enableBox.checked ? "enabled" : "disabled"}`);
        void this.render();
      } catch (err) { toast((err as Error).message, "err"); }
    };

    const pills = el("div", { class: "seg", role: "group", "aria-label": "Search provider" },
      ["auto", ...IDS].map((id) => {
        const p = st.providers.find((x: any) => x.id === id);
        const ready = id === "auto" ? st.providers.some((x: any) => x.ready) : p?.ready;
        const b = el("button", {
          class: `seg__btn${ready ? "" : " is-off"}`,
          type: "button",
          "aria-pressed": configured === id ? "true" : "false",
        }, [id]) as HTMLButtonElement;
        b.title = id === "auto"
          ? "First ready provider by fixed order"
          : ready ? `${p.configBaseUrl || ""}` : "not ready — set its credentials below";
        b.onclick = async () => {
          try {
            await gateway.request("config.set", { path: "tools.web.search.provider", value: id === "auto" ? "" : id });
            toast(`search provider: ${id}`);
            void this.render();
          } catch (err) { toast((err as Error).message, "err"); }
        };
        return b;
      }));

    // credential rows for the currently-selected api-backed provider
    const sel = configured !== "auto" ? st.providers.find((x: any) => x.id === configured) : null;
    const credRows: HTMLElement[] = [];
    if (sel && !sel.keyFree) {
      const inp = el("input", { class: "inp mono", type: "password", placeholder: `${sel.id.toUpperCase()}_API_KEY env, or paste here`, autocomplete: "off" }) as HTMLInputElement;
      const save = el("button", { class: "btn sm" }, [sel.hasKey ? "Replace key · " + ((st.keyMasks?.[sel.id] as string) || "set") : "Save key"]) as HTMLButtonElement;
      save.onclick = async () => {
        if (!inp.value.trim()) { toast("key is empty", "err"); return; }
        try {
          await gateway.request("config.set", { path: `tools.web.search.${sel.id}.apiKey`, value: inp.value.trim() });
          toast(`${sel.id} key saved`);
          void this.render();
        } catch (err) { toast((err as Error).message, "err"); }
      };
      credRows.push(el("div", { class: "settings__inline" }, [inp, save]));
    } else if (sel && sel.keyFree) {
      const inp = el("input", { class: "inp mono", value: sel.configBaseUrl || "", placeholder: sel.id === "searxng" ? "https://searx.example.com" : "https://html.duckduckgo.com" }) as HTMLInputElement;
      const save = el("button", { class: "btn sm" }, ["Save URL"]) as HTMLButtonElement;
      save.onclick = async () => {
        try {
          await gateway.request("config.set", { path: `tools.web.search.${sel.id}.baseUrl`, value: inp.value.trim() });
          toast(`${sel.id} base URL saved`);
          void this.render();
        } catch (err) { toast((err as Error).message, "err"); }
      };
      credRows.push(el("div", { class: "settings__inline" }, [inp, save]));
    }

    const testOut = el("p", { class: "hint", "aria-live": "polite" }, []);
    const testBtn = el("button", { class: "btn sm" }, ["Test search"]) as HTMLButtonElement;
    testBtn.onclick = async () => {
      testBtn.disabled = true;
      testOut.textContent = "searching…";
      try {
        const r = await gateway.request("web.search.test", { provider: configured === "auto" ? undefined : configured }) as any;
        testOut.textContent = r.ok
          ? `✓ ${r.provider} · ${r.count} result(s) in ${r.tookMs}ms — ${r.firstTitles.join(" · ") || "(empty)"}`
          : `✗ ${r.message ?? "failed"}`;
      } catch (err) {
        testOut.textContent = `✗ ${(err as Error).message}`;
      }
      testBtn.disabled = false;
    };

    return el("div", { class: "card web-search" }, [
      el("div", { class: "setcard__head" }, [
        el("h3", {}, ["Web search"]),
        el("p", { class: "hint" }, [
          "Provider used by the web_search tool. Auto picks the first API-keyed provider found; key-free providers are only used when selected.",
        ]),
      ]),
      el("div", { class: "row" }, [
        el("div", { class: "row__main" }, [
          el("span", { class: "row__label" }, ["Enable the web_search tool"]),
          el("span", { class: "hint" }, [st.enabled ? `${configured} · cache ${st.cacheTtlMinutes}m` : "currently disabled"]),
        ]),
        enableBox,
      ]),
      el("div", { class: "setsec" }, [
        el("div", { class: "setsec__head" }, [el("span", { class: "cap" }, ["Provider"])]),
        pills,
        ...credRows,
      ]),
      el("div", { class: "setfoot" }, [testOut, testBtn]),
    ]);
  }

  /* ---------------- tools: exec & approvals ---------------- */

  async #execApprovalsCard(): Promise<HTMLElement> {
    let st: any;
    try {
      st = await gateway.request("approvals.get");
    } catch (err) {
      return el("div", { class: "card" }, [
        el("h3", {}, ["Exec & approvals"]),
        el("p", { class: "hint" }, [`Policy unread — ${(err as Error).message}`]),
      ]);
    }
    const MODES = ["deny", "allowlist", "ask", "full"] as const;

    const pills = el("div", { class: "seg", role: "group", "aria-label": "Exec mode" },
      MODES.map((m) => {
        const b = el("button", {
          class: "seg__btn",
          type: "button",
          "aria-pressed": st.mode === m ? "true" : "false",
        }, [m]) as HTMLButtonElement;
        b.onclick = async () => {
          try {
            await gateway.request("approvals.setMode", { mode: m });
            toast(`exec mode: ${m}`);
            void this.render();
          } catch (err) { toast((err as Error).message, "err"); }
        };
        return b;
      }));

    const fb = el("select", { class: "inp", id: "exec-ask-fallback" }, [
      ...(["deny", "allowlist", "full"] as const).map((v) => {
        const o = el("option", { value: v }, [v]) as HTMLOptionElement;
        if (st.askFallback === v) o.selected = true;
        return o;
      }),
    ]) as HTMLSelectElement;
    fb.onchange = async () => {
      try {
        await gateway.request("approvals.setMode", { mode: st.mode, askFallback: fb.value });
        toast(`no-surface fallback: ${fb.value}`);
        void this.render();
      } catch (err) { toast((err as Error).message, "err"); }
    };

    const strictBox = el("input", { type: "checkbox" }) as HTMLInputElement;
    strictBox.checked = st.strictInlineEval === true;
    strictBox.onchange = async () => {
      try {
        await gateway.request("approvals.setMode", { mode: st.mode, strictInlineEval: strictBox.checked });
        toast(`strict inline eval ${strictBox.checked ? "on" : "off"}`);
        void this.render();
      } catch (err) { toast((err as Error).message, "err"); }
    };

    const presets = el("div", { class: "settings__inline" },
      (["cautious", "deny-all", "yolo"] as const).map((name) => {
        const b = el("button", { class: `btn sm${name === "yolo" ? " is-warn" : ""}`, type: "button" }, [name]) as HTMLButtonElement;
        b.onclick = async () => {
          try {
            const r = await gateway.request("approvals.preset", { name }) as any;
            toast(r.message ?? `preset ${name}`);
            void this.render();
          } catch (err) { toast((err as Error).message, "err"); }
        };
        return b;
      }));

    // ---- ledger (live search + compact rows; rule: long lists) ----
    const entries: any[] = Array.isArray(st.entries) ? st.entries : [];
    const list = el("div", { class: "list" });
    const ago = (ts?: number) => {
      if (!ts) return "never used";
      const m = Math.max(0, Math.round((Date.now() - ts) / 60000));
      return m < 1 ? "used <1m ago" : m < 60 ? `used ${m}m ago` : m < 1440 ? `used ${Math.round(m / 60)}h ago` : `used ${Math.round(m / 1440)}d ago`;
    };
    const renderRows = (): void => {
      list.innerHTML = "";
      const q = this.#execQuery.trim().toLowerCase();
      const shown = entries.filter((e) => !q || String(e.pattern).toLowerCase().includes(q) || String(e.argPattern ?? "").toLowerCase().includes(q));
      if (shown.length === 0) {
        list.append(el("p", { class: "hint" }, [
          entries.length === 0 ? "No allowlist entries — every new command asks." : "No entries match the search.",
        ]));
        return;
      }
      for (const e of shown) {
        const revoke = el("button", {
          class: "ibtn",
          type: "button",
          "aria-label": "Revoke entry",
          title: "Revoke entry",
        }, ["✕"]) as HTMLButtonElement;
        revoke.onclick = async () => {
          try {
            await gateway.request("approvals.entry.revoke", { id: e.id });
            toast("entry revoked");
            void this.render();
          } catch (err) { toast((err as Error).message, "err"); }
        };
        const kind = el("span", { class: `settings__tag${e.source === "allow-always" ? " is-warn" : ""}` }, [
          e.source === "allow-always" ? "always" : "manual",
        ]);
        const detail = e.source === "allow-always"
          ? `exact argv · ${String(e.cwd ?? "?").replace(/^\/data\/data\/com\.termux\/files\/home/, "~")} · ${ago(e.lastUsedAt)}`
          : [e.argPattern ? `argv /${e.argPattern}/` : null, e.lastUsedAt ? ago(e.lastUsedAt) : null, e.lastResolvedPath ? e.lastResolvedPath : null].filter(Boolean).join(" · ") || "path/name match";
        list.append(el("div", { class: "ledger__row" }, [
          el("div", { class: "ledger__main" }, [
            el("div", { class: "ledger__pattern" }, [String(e.pattern)]),
            el("div", { class: "ledger__meta" }, [detail]),
          ]),
          kind,
          revoke,
        ]));
      }
    };
    renderRows();

    const search = el("input", { class: "inp", placeholder: "Search entries…", value: this.#execQuery, autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
    search.oninput = () => { this.#execQuery = search.value; renderRows(); };

    const patternInp = el("input", { class: "inp mono", placeholder: "rg or /opt/homebrew/bin/rg or ~/.local/bin/*" }) as HTMLInputElement;
    const argInp = el("input", { class: "inp mono", placeholder: "argv regex (optional), e.g. ^safe\\.py$" }) as HTMLInputElement;
    const addBtn = el("button", { class: "btn", type: "button" }, ["+ Add entry"]) as HTMLButtonElement;
    addBtn.onclick = async () => {
      try {
        await gateway.request("approvals.entry.add", { pattern: patternInp.value, argPattern: argInp.value || undefined });
        toast("allowlist entry added");
        patternInp.value = "";
        argInp.value = "";
        void this.render();
      } catch (err) { toast((err as Error).message, "err"); }
    };

    return el("div", { class: "card exec-approvals" }, [
      el("div", { class: "setcard__head" }, [
        el("h3", {}, ["Exec & approvals"]),
        el("p", { class: "hint" }, [
          "How host shell commands get authorized. Allowlist & safe bins run without prompts (argv-literal, no shell); misses follow the mode. Allow always mints an exact-argv grant bound to this directory.",
        ]),
      ]),
      el("div", { class: "setgrid" }, [
        el("div", { class: "setfield" }, [
          el("span", { class: "lbl" }, ["Mode"]),
          pills,
        ]),
        el("div", { class: "setfield" }, [
          el("label", { class: "lbl", for: "exec-ask-fallback" }, ["Ask fallback (no surface connected)"]),
          fb,
          el("p", { class: "hint" }, ["Every unattended auto-decision is written to the log and the transcript."]),
        ]),
      ]),
      el("div", { class: "row" }, [
        el("div", { class: "row__main" }, [
          el("span", { class: "row__label" }, ["Never auto-allow inline eval"]),
          el("span", { class: "hint" }, ["node -e, bash -c and friends always need a real approval."]),
        ]),
        strictBox,
      ]),
      el("div", { class: "setsec" }, [
        el("div", { class: "setsec__head" }, [
          el("span", { class: "cap" }, ["Presets"]),
        ]),
        presets,
      ]),
      el("div", { class: "setsec" }, [
        el("div", { class: "setsec__head" }, [
          el("span", { class: "cap" }, ["Allowlist"]),
          el("span", { class: "setsec__count" }, [`${entries.length} entries`]),
        ]),
        search,
        el("div", { class: "ledger" }, [list]),
      ]),
      el("div", { class: "setsec" }, [
        el("div", { class: "setsec__head" }, [el("span", { class: "cap" }, ["Add an entry by hand"])]),
        patternInp,
        argInp,
        el("div", { class: "settings__inline" }, [addBtn]),
      ]),
    ]);
  }

  async #renderTools(tools: any[], config: any = {}): Promise<void> {
    const body = el("div", { class: "settings__stack" });

    body.append(await this.#execApprovalsCard());
    body.append(this.#execPolicyCard(config));
    body.append(this.#codeModeCard(config));
    body.append(this.#mediaCard(config));
    body.append(await this.#webSearchCard());

    body.append(el("div", { class: "card" }, [
      el("h3", {}, ["Built-in tools"]),
      el("p", { class: "hint" }, [
        `${tools.length} tools the agent can call. Read-only: neither the agent nor you can add or remove them here — they ship with the runtime.`,
      ]),
      ...(tools as any[]).map((t) =>
        el("div", { class: "prov" }, [
          el("div", { class: "prov__head" }, [
            el("span", { class: "prov__name mono" }, [t.name]),
            el("span", { class: `settings__tag${t.needsApproval ? " is-warn" : ""}` }, [
              t.needsApproval ? "asks approval" : "auto",
            ]),
          ]),
          el("div", { class: "prov__url" }, [t.description || ""]),
        ])),
    ]));

    this.#root.append(body);
  }

  /* ---------------- gateway ---------------- */



  /** Usage dashboard (P4 #34 — their Usage page): totals cards, daily
   *  rollups, session + model aggregates from `usage.report`. Cost only shows
   *  when a pricing card covered every contributing run — n/a otherwise
   *  (their never-guess-a-price rule). */
  #usageDays = 30;
  #usageSession = "";
  #usageReport: any = null;

  async #renderUsage(): Promise<void> {
    const body = el("div", { class: "settings__stack" });
    this.#root.innerHTML = "";
    this.#root.append(body);
    body.append(el("div", { class: "hint" }, ["Loading usage report…"]));
    let res: any;
    try {
      res = await gateway.request("usage.report", {
        days: this.#usageDays,
        ...(this.#usageSession ? { sessionKey: this.#usageSession } : {}),
      });
    } catch (err) {
      body.innerHTML = "";
      body.append(el("div", { class: "hint" }, [`usage report failed: ${(err as Error).message}`]));
      return;
    }
    this.#usageReport = res.report;
    const report = res.report;
    body.innerHTML = "";

    const fmtTok = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
    const fmtUsd = (c: number | null, unknown: number) =>
      c !== null ? `$${c >= 0.01 ? c.toFixed(2) : c.toFixed(4)}` : unknown > 0 ? "n/a" : "$0.00";

    const selectField = (label: string, options: { value: string; label: string }[], value: string, onchange: (v: string) => void) => {
      const sel = el("select", { class: "in" }, options.map((o) => el("option", { value: o.value, ...(o.value === value ? { selected: "" } : {}) }, [o.label])) as Node[]);
      (sel as HTMLSelectElement).onchange = () => onchange((sel as HTMLSelectElement).value);
      return el("label", { class: "field" }, [el("span", { class: "cap" }, [label]), sel]);
    };

    const toolbar = el("div", { class: "usage-toolbar" }, [
      selectField(
        "Period",
        [
          { value: "7", label: "Last 7 days" },
          { value: "30", label: "Last 30 days" },
          { value: "90", label: "Last 90 days" },
          { value: "0", label: "All time" },
        ],
        String(this.#usageDays),
        (v) => { this.#usageDays = Number(v); void this.#renderUsage(); },
      ),
      selectField(
        "Session",
        [
          { value: "", label: "All sessions" },
          ...((res.sessions ?? []) as string[]).map((k) => ({ value: k, label: k })),
        ],
        this.#usageSession,
        (v) => { this.#usageSession = v; void this.#renderUsage(); },
      ),
    ]);
    const exJson = el("button", { class: "btn", type: "button", id: "usage-export-json" }, ["Export JSON"]) as HTMLButtonElement;
    exJson.onclick = () => this.#usageExport("json");
    const exCsv = el("button", { class: "btn", type: "button", id: "usage-export-csv" }, ["Export CSV (daily)"]) as HTMLButtonElement;
    exCsv.onclick = () => this.#usageExport("csv");
    toolbar.append(el("span", { class: "settings__spacer" }), exJson, exCsv);
    body.append(toolbar);

    const t = report.total;
    body.append(el("div", { class: "usage-cards" }, [
      el("div", { class: "usage-card" }, [el("span", { class: "usage-card__value" }, [fmtTok(t.inputTokens)]), el("span", { class: "cap" }, ["input tokens"])]),
      el("div", { class: "usage-card" }, [el("span", { class: "usage-card__value" }, [fmtTok(t.outputTokens)]), el("span", { class: "cap" }, ["output tokens"])]),
      el("div", { class: "usage-card" }, [el("span", { class: "usage-card__value" }, [String(t.runs)]), el("span", { class: "cap" }, ["runs"])]),
      el("div", { class: "usage-card" }, [el("span", { class: "usage-card__value" }, [fmtUsd(t.costUsd, t.unknownPriceRuns)]), el("span", { class: "cap" }, ["cost"])]),
    ]));
    if (t.costUsd === null && t.unknownPriceRuns > 0) {
      body.append(el("div", { class: "hint" }, [`${t.unknownPriceRuns}/${t.runs} run(s) used a model with no pricing card — cost is partial (their never-guess-a-price rule).`]));
    }

    const addTable = (title: string, rows: { key: string; runs: number; in: number; out: number; cost: number | null; unknown: number }[], empty: string, cls: string) => {
      body.append(el("div", { class: "usage-h" }, [title]));
      if (rows.length === 0) {
        body.append(el("div", { class: "hint" }, [empty]));
        return;
      }
      const thead = el("tr", {}, ["Day / key", "Runs", "In", "Out", "Cost"].map((h) => el("th", {}, [h])) as Node[]);
      const tbody = el("tbody", {}, rows.map((r) => el("tr", {}, [
        el("td", { class: "usage-key" }, [r.key]),
        el("td", { class: "usage-num", "data-v": String(r.runs) }, [String(r.runs)]),
        el("td", { class: "usage-num" }, [fmtTok(r.in)]),
        el("td", { class: "usage-num" }, [fmtTok(r.out)]),
        el("td", { class: "usage-num" }, [fmtUsd(r.cost, r.unknown)]),
      ] as Node[])) as Node[]);
      body.append(el("table", { class: `usage-table ${cls}` }, [el("thead", {}, [thead]), tbody]));
    };

    addTable(
      "Daily rollup",
      report.perDay.map((d: any) => ({ key: d.day, runs: d.runs, in: d.inputTokens, out: d.outputTokens, cost: d.costUsd, unknown: d.unknownPriceRuns })),
      "No runs recorded in this period.",
      "usage-table--daily",
    );
    addTable(
      "Per session",
      report.perSession.map((x: any) => ({ key: x.session, runs: x.runs, in: x.inputTokens, out: x.outputTokens, cost: x.costUsd, unknown: x.unknownPriceRuns })),
      "No sessions with usage yet.",
      "usage-table--sessions",
    );
    addTable(
      "Per model",
      report.perModel.map((m: any) => ({ key: m.model, runs: m.runs, in: m.inputTokens, out: m.outputTokens, cost: m.costUsd, unknown: m.unknownPriceRuns })),
      "No models with usage yet.",
      "usage-table--models",
    );
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
  async #renderConfigEditor(config: any): Promise<void> {
    let schema: any = null;
    try {
      schema = (await gateway.request("config.schema", {}) as any).schema ?? null;
    } catch (err) {
      toast(`config.schema unavailable: ${(err as Error).message}`, "err");
    }
    const REDACTED_PREFIX = "__redacted__:";
    const isRedacted = (v: unknown): v is string => typeof v === "string" && v.startsWith(REDACTED_PREFIX);

    const toolbar = el("div", { class: "cfg-toolbar" });
    const search = el("input", { class: "inp", id: "cfg-filter", type: "search", placeholder: "Filter settings…", "aria-label": "Filter settings" }) as HTMLInputElement;
    const formBtn = el("button", { class: "btn cfg-mode is-active", type: "button" }, ["Form"]);
    const rawBtn = el("button", { class: "btn cfg-mode", type: "button" }, ["Raw"]);
    toolbar.append(search, formBtn, rawBtn);

    const formHost = el("div", { id: "cfg-form" });
    const rawHost = el("div", { id: "cfg-raw", hidden: "" });
    const rawBanner = el("div", { class: "cfg-banner", hidden: "" });
    const rawArea = el("textarea", { class: "inp mono", id: "cfg-raw-text", rows: "22", spellcheck: "false" }) as HTMLTextAreaElement;
    rawArea.value = JSON.stringify(config, null, 2);
    const rawSave = el("button", { class: "btn pri", type: "button" }, ["Apply raw config"]);
    rawSave.onclick = async () => {
      rawBanner.hidden = true;
      try {
        await gateway.request("config.replace", { text: rawArea.value });
        toast("config applied", "ok");
        this.#onChanged();
        void this.render();
      } catch (err) {
        rawBanner.textContent = `Settings not applied: ${(err as Error).message}`;
        rawBanner.hidden = false;
      }
    };
    rawHost.append(
      el("p", { class: "hint" }, ["JSON5 document. Redacted secrets shown as __redacted__:… keep the stored value; \${ENV_VAR} refs stay as authored. Validation errors never clobber the running config."]),
      rawBanner, rawArea, rawSave);

    const saveBar = el("div", { class: "cfg-savebar" });
    formBtn.onclick = () => { formHost.hidden = false; saveBar.hidden = false; rawHost.hidden = true; formBtn.classList.add("is-active"); rawBtn.classList.remove("is-active"); };
    rawBtn.onclick = () => { formHost.hidden = true; saveBar.hidden = true; rawHost.hidden = false; rawBtn.classList.add("is-active"); formBtn.classList.remove("is-active"); };

    if (!schema?.fields) {
      formHost.append(el("div", { class: "card" }, [el("p", { class: "hint" }, ["Schema unavailable — use Raw mode."])]));
      this.#root.append(toolbar, formHost, rawHost);
      return;
    }

    type Kind = "bool" | "num" | "str" | "text" | "enum" | "list" | "json";
    const fieldRow = (labelText: string, path: string, kind: Kind, cur: unknown, extra?: { values?: string[] }): HTMLElement => {
      let input: HTMLElement;
      if (kind === "bool") {
        input = el("input", { type: "checkbox", id: `cfg-${path}` }) as HTMLInputElement;
        (input as HTMLInputElement).checked = Boolean(cur);
      } else if (kind === "enum") {
        const sel = el("select", { class: "inp", id: `cfg-${path}` }) as HTMLSelectElement;
        for (const opt of extra?.values ?? []) sel.append(el("option", { value: opt, ...(opt === cur ? { selected: "" } : {}) }, [opt]));
        input = sel;
      } else if (kind === "text") {
        input = el("textarea", { class: "inp mono", id: `cfg-${path}`, rows: "3" }) as HTMLTextAreaElement;
        (input as HTMLTextAreaElement).value = typeof cur === "string" && !isRedacted(cur) ? cur : "";
      } else if (kind === "list" || kind === "json") {
        input = el("textarea", { class: "inp mono", id: `cfg-${path}`, rows: "3", spellcheck: "false" }) as HTMLTextAreaElement;
        (input as HTMLTextAreaElement).value = kind === "list"
          ? (Array.isArray(cur) ? cur : []).join("\n")
          : JSON.stringify(cur ?? (kind === "json" ? {} : []), null, 2);
      } else {
        const attrs: Record<string, string> = { class: "inp mono", id: `cfg-${path}` };
        if (kind === "num") attrs["inputmode"] = "decimal";
        input = el("input", attrs) as HTMLInputElement;
        if (!(typeof cur === "string" && isRedacted(cur))) (input as HTMLInputElement).value = cur === undefined || cur === null ? "" : String(cur);
      }
      const redacted = isRedacted(cur);
      if (redacted && (kind === "str" || kind === "text")) {
        (input as HTMLInputElement).setAttribute("placeholder", `${cur.slice(REDACTED_PREFIX.length)} — leave blank to keep`);
      }
      const row = el("div", { class: "modal__field", "data-cfg-path": path, "data-cfg-kind": kind, ...(redacted ? { "data-cfg-redacted": "1" } : {}) }, [
        el("label", { class: "lbl", for: `cfg-${path}` }, [labelText]),
        input,
      ]);
      (row as any).__initial = kind === "bool" ? Boolean(cur) : (input as HTMLInputElement).value ?? "";
      return row;
    };

    const renderNode = (node: any, path: string, cur: unknown, into: HTMLElement): void => {
      if (!node || typeof node !== "object") return;
      // `hidden` leaves are stored but not edited as text here (the avatar is a
      // 32,000-character data URL; nobody should meet it in a textbox). The raw
      // JSON5 editor still shows the file exactly as it is.
      if (node.hidden === true) return;
      switch (node.t) {
        case "bool": into.append(fieldRow(path.split(".").pop() ?? path, path, "bool", cur)); return;
        case "int": case "float": into.append(fieldRow(path.split(".").pop() ?? path, path, "num", cur)); return;
        case "string": into.append(fieldRow(path.split(".").pop() ?? path, path, "str", cur)); return;
        case "text": into.append(fieldRow(path.split(".").pop() ?? path, path, "text", cur)); return;
        case "enum": into.append(fieldRow(path.split(".").pop() ?? path, path, "enum", cur, { values: node.values })); return;
        case "array":
          if (node.of?.t === "string") into.append(fieldRow(path.split(".").pop() ?? path, path, "list", cur));
          else into.append(fieldRow(path.split(".").pop() ?? path, path, "json", cur ?? []));
          return;
        case "record": case "any":
          into.append(fieldRow(path.split(".").pop() ?? path, path, "json", cur ?? {}));
          return;
        case "object": {
          const box = el("div", { class: "cfg-group", "data-cfg-group": path });
          box.append(el("h4", { class: "cfg-group__title" }, [path.split(".").pop() ?? path]));
          const obj = (cur && typeof cur === "object" ? cur : {}) as Record<string, unknown>;
          for (const [key, child] of Object.entries(node.fields ?? {})) {
            renderNode(child, path ? `${path}.${key}` : key, obj[key] ?? (child as any).default, box);
          }
          into.append(box);
          return;
        }
        default: return;
      }
    };

    const sections: [string, any][] = Object.entries(schema.fields);
    for (const [name, node] of sections) {
      const card = el("div", { class: "card cfg-section", "data-cfg-section": name });
      card.append(el("h3", {}, [name]));
      const cur = (config as Record<string, unknown>)[name];
      if ((node as any).t === "object") {
        for (const [key, child] of Object.entries((node as any).fields ?? {})) {
          renderNode(child, `${name}.${key}`, (cur as any)?.[key] ?? (child as any).default, card);
        }
      } else {
        renderNode(node, name, cur, card);
      }
      formHost.append(card);
    }

    search.addEventListener("input", () => {
      const q = search.value.trim().toLowerCase();
      for (const card of Array.from(formHost.querySelectorAll<HTMLElement>(".cfg-section"))) {
        let anyVisible = false;
        for (const row of Array.from(card.querySelectorAll<HTMLElement>("[data-cfg-path]"))) {
          const match = !q || (row.dataset["cfgPath"] ?? "").toLowerCase().includes(q);
          row.hidden = !match;
          if (match) anyVisible = true;
        }
        card.hidden = !anyVisible;
      }
    });

    const saveBtn = el("button", { class: "btn pri", type: "button" }, ["Save changes"]);
    saveBtn.onclick = async () => {
      const pairs: [string, unknown][] = [];
      const errors: string[] = [];
      for (const row of Array.from(formHost.querySelectorAll<HTMLElement>("[data-cfg-path]"))) {
        if (row.hidden) continue;
        const path = row.dataset["cfgPath"]!;
        const kind = row.dataset["cfgKind"] as Kind;
        const inputEl = row.querySelector("input, textarea, select") as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
        const initial = (row as any).__initial;
        let value: unknown;
        try {
          if (kind === "bool") value = (inputEl as HTMLInputElement).checked;
          else if (kind === "num") value = inputEl.value === "" ? initial : Number(inputEl.value);
          else if (kind === "list") value = (inputEl as HTMLTextAreaElement).value.split("\n").map((v) => v.trim()).filter(Boolean);
          else if (kind === "json") value = JSON.parse((inputEl as HTMLTextAreaElement).value);
          else value = inputEl.value;
        } catch {
          errors.push(`${path}: invalid JSON`);
          continue;
        }
        if (row.dataset["cfgRedacted"] === "1" && (value === "" || value === undefined)) continue;
        if (kind === "bool" ? value !== initial : String(value) !== String(initial) && !(kind === "list" && JSON.stringify(value) === JSON.stringify(initial?.split?.("\n") ?? initial))) {
          // list inputs compare on text anyway; bool on checked state.
          if (kind === "list" && (inputEl as HTMLTextAreaElement).value === initial) continue;
          pairs.push([path, value]);
        }
      }
      if (errors.length > 0) { toast(errors.join("; "), "err"); return; }
      if (pairs.length === 0) { toast("no changes", "info"); return; }
      await this.#setMany(pairs, `${pairs.length} setting(s) saved`);
      void this.render();
    };
    saveBar.append(saveBtn);

    this.#root.append(toolbar, formHost, saveBar, rawHost);
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
    const num = (labelText: string, key: string, cur: number, hint?: string) => {
      const inp = el("input", { class: "inp mono", id: `ch-${key}`, value: String(cur ?? 0), inputmode: "numeric" });
      return el("div", { class: "modal__field", "data-ch-key": key, "data-ch-kind": "num" }, [
        el("label", { class: "lbl", for: `ch-${key}` }, [labelText]),
        inp,
        ...(hint ? [el("p", { class: "hint" }, [hint])] : []),
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

    const save = el("button", { class: "btn pri", type: "button" }, ["Save channel settings"]);
    save.onclick = async () => {
      const pairs: [string, unknown][] = [];
      for (const node of Array.from(this.#root.querySelectorAll<HTMLElement>("[data-ch-key]"))) {
        const key = node.dataset["chKey"]!;
        const kind = node.dataset["chKind"]!;
        if (kind === "bool") {
          pairs.push([key, (node.querySelector("input") as HTMLInputElement).checked]);
        } else if (kind === "num") {
          pairs.push([key, Number((node.querySelector("input, textarea") as HTMLInputElement).value) || 0]);
        } else if (kind === "list") {
          pairs.push([key, (node.querySelector("textarea") as HTMLTextAreaElement).value.split("\n").map((v) => v.trim()).filter(Boolean)]);
        } else {
          pairs.push([key, (node.querySelector("select, input") as HTMLInputElement).value.trim()]);
        }
      }
      if (tokenInp.value.trim()) pairs.push(["channels.telegram.token", tokenInp.value.trim()]);
      await this.#setMany(pairs, "channel settings saved — telegram reconnects now");
      tokenInp.value = "";
      // Authoritative reconnect: config.set now hot-applies the channel, and
      // the visible outcome tells the user whether it actually connected.
      const enabledNow = pairs.find(([k]) => k === "channels.telegram.enabled");
      const wantOn = enabledNow ? Boolean(enabledNow[1]) : Boolean(channels.telegram?.enabled);
      if (wantOn) connectBtn.click();
      else void refreshStatus();
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
        if (res.ok) toast(`telegram connected as @${res.username ?? "?"}`, "ok");
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
          el("p", { class: "hint" }, [
            tg.token
              ? `Saved token ends …${String(tg.token).slice(-4)}. Paste a new one, or put \${TELEGRAM_TOKEN} / a SecretRef in config.json5 (see: sc secrets refs).`
              : "From @BotFather. To keep it out of config.json5 put \${TELEGRAM_TOKEN} or a SecretRef there instead (see: sc secrets refs).",
          ]),
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
        num("Batch window (ms)", "channels.telegram.batchMs", tg.batchMs ?? 0,
          "Rapid-fire messages are merged before one reply. 0 disables batching."),
        pick("Typing indicator", "channels.telegram.typing.mode", typing.mode ?? "instant", ["instant", "thinking", "message", "never"],
          "instant on receive; thinking on first model output; message only beside replies; never."),
        num("Typing refresh (seconds)", "channels.telegram.typing.intervalSeconds", typing.intervalSeconds ?? 5),
        num("Media size cap (MB)", "channels.telegram.mediaMaxMb", tg.mediaMaxMb ?? 10),
        check("Send photos to the vision model", "channels.telegram.vision", Boolean(tg.vision ?? true),
          "When off, photos are described by media understanding only."),
      ]),
      el("div", { class: "card" }, [
        el("h3", {}, ["Bot-loop protection"]),
        check("Enable", "channels.telegram.botLoopProtection.enabled", Boolean(blp.enabled ?? true),
          "Drops feedback loops when a partner bot answers every message."),
        num("Max events per window", "channels.telegram.botLoopProtection.maxEventsPerWindow", blp.maxEventsPerWindow ?? 10),
        num("Window (seconds)", "channels.telegram.botLoopProtection.windowSeconds", blp.windowSeconds ?? 60),
        num("Cooldown (seconds)", "channels.telegram.botLoopProtection.cooldownSeconds", blp.cooldownSeconds ?? 300),
      ]),
      save,
    );
  }

  /** Gateway tab (P4 #40 — their Gateway page): the full surface, not just
   *  port + auth.mode — bind/net access, allowed hosts/origins, Control-UI
   *  serving, the OpenAI HTTP endpoint toggle, and the loaded config path. */
  #renderGateway(gw: any, configPath = ""): void {
    const port = el("input", {
      class: "inp mono", id: "gw-port", value: String(gw.port ?? 18790), inputmode: "numeric", autocomplete: "off",
    }) as HTMLInputElement;
    const bindSel = el("select", { class: "in", id: "gw-bind" }) as HTMLSelectElement;
    for (const [v, lab] of [["loopback", "loopback (local only)"], ["lan", "lan (reachable on the network)"]] as [string, string][]) {
      bindSel.append(el("option", { value: v, ...(String(gw.bind ?? "loopback") === v ? { selected: "" } : {}) }, [lab]));
    }
    const modeSel = el("select", { class: "in", id: "gw-mode" }) as HTMLSelectElement;
    for (const [v, lab] of [["token", "token"], ["none", "none"]] as [string, string][]) {
      modeSel.append(el("option", { value: v, ...(String(gw.auth?.mode ?? "token") === v ? { selected: "" } : {}) }, [lab]));
    }
    const bypassCb = el("input", { type: "checkbox", id: "gw-bypass" }) as HTMLInputElement;
    bypassCb.checked = gw.auth?.loopbackBypass !== false;
    const tokenNew = el("input", { class: "inp mono", id: "gw-token-new", type: "password", placeholder: "leave blank to keep", autocomplete: "off" }) as HTMLInputElement;
    const rawToken = String(gw.auth?.token ?? "");
    const token = el("div", { class: "inp mono" }, [rawToken ? "••••••••" + rawToken.slice(-4) : "Not set"]);
    const hostsInp = el("input", { class: "inp mono", id: "gw-hosts", value: (gw.allowedHosts ?? []).join(", "), placeholder: "blank = any host", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
    const originsInp = el("input", { class: "inp mono", id: "gw-origins", value: (gw.allowedOrigins ?? []).join(", "), placeholder: "blank = any origin", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
    const uiCb = el("input", { type: "checkbox", id: "gw-cui" }) as HTMLInputElement;
    uiCb.checked = gw.controlUi?.enabled !== false;
    const basePathInp = el("input", { class: "inp mono", id: "gw-basepath", value: String(gw.controlUi?.basePath ?? ""), placeholder: "e.g. /ui (blank = root)", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
    const httpCb = el("input", { type: "checkbox", id: "gw-openai" }) as HTMLInputElement;
    httpCb.checked = Boolean(gw.http?.endpoints?.chatCompletions?.enabled);

    const save = el("button", { class: "btn pri", type: "button", id: "gateway-save" }, ["Save and restart gateway"]) as HTMLButtonElement;
    save.onclick = async () => {
      const pairs: [string, unknown][] = [
        ["gateway.port", Number(port.value) || (gw.port ?? 18790)],
        ["gateway.bind", bindSel.value],
        ["gateway.auth.mode", /^(token|none)$/.test(modeSel.value) ? modeSel.value : "token"],
        ["gateway.auth.loopbackBypass", bypassCb.checked],
        ["gateway.allowedHosts", hostsInp.value.split(",").map((x) => x.trim()).filter(Boolean)],
        ["gateway.allowedOrigins", originsInp.value.split(",").map((x) => x.trim()).filter(Boolean)],
        ["gateway.controlUi.enabled", uiCb.checked],
        ["gateway.controlUi.basePath", basePathInp.value.trim()],
        ["gateway.http.endpoints.chatCompletions.enabled", httpCb.checked],
      ];
      if (tokenNew.value.trim()) pairs.push(["gateway.auth.token", tokenNew.value.trim()]);
      await this.#setMany(pairs, "gateway saved — reconnecting");
      location.reload();
    };

    this.#root.append(
      el("div", { class: "card" }, [
        el("div", { class: "modal__field" }, [el("label", { class: "lbl", for: "gw-port" }, ["Port"]), port]),
        el("div", { class: "modal__field" }, [
          el("label", { class: "lbl", for: "gw-bind" }, ["Bind"]),
          bindSel,
          el("p", { class: "hint" }, ["lan exposes the WebSocket + Control UI on your network — pair it with the token."]),
        ]),
        el("div", { class: "modal__field" }, [
          el("span", { class: "lbl" }, ["Auth token"]),
          token,
          tokenNew,
          el("p", { class: "hint" }, ["Clients send this token when they connect; blank keeps the stored one."]),
        ]),
        el("div", { class: "modal__field" }, [
          el("label", { class: "lbl", for: "gw-mode" }, ["Auth mode"]),
          modeSel,
          el("p", { class: "hint" }, ["token requires a secret; none allows any local client."]),
        ]),
        el("div", { class: "row" }, [
          el("span", { class: "row__label" }, ["Loopback bypass (no token needed from localhost)"]),
          bypassCb,
        ]),
      ]),
      el("div", { class: "card" }, [
        el("h3", {}, ["Network access"]),
        el("div", { class: "modal__field" }, [
          el("label", { class: "lbl", for: "gw-hosts" }, ["Allowed hosts (comma)"]),
          hostsInp,
          el("p", { class: "hint" }, ["Reject connections with an unlisted Host header."]),
        ]),
        el("div", { class: "modal__field" }, [
          el("label", { class: "lbl", for: "gw-origins" }, ["Allowed origins (comma)"]),
          originsInp,
          el("p", { class: "hint" }, ["Reject WebSocket upgrades from browsers outside the list — their CSRF guard."]),
        ]),
      ]),
      el("div", { class: "card" }, [
        el("h3", {}, ["Control UI"]),
        el("div", { class: "row" }, [el("span", { class: "row__label" }, ["Serve this web app from the gateway"]), uiCb]),
        el("div", { class: "modal__field" }, [
          el("label", { class: "lbl", for: "gw-basepath" }, ["Base path"]),
          basePathInp,
          el("p", { class: "hint" }, ["Mount the UI under a prefix (their controlUi.basePath) for reverse-proxy setups."]),
        ]),
      ]),
      el("div", { class: "card" }, [
        el("h3", {}, ["OpenAI-compatible HTTP endpoint"]),
        el("div", { class: "row" }, [
          el("span", { class: "row__label" }, ["POST /v1/chat/completions (Bearer = gateway token)"]),
          httpCb,
        ]),
        el("p", { class: "hint" }, ["Off by default — it grants full agent access over plain HTTP (their operator-grade warning)."]),
      ]),
      el("div", { class: "settings__actions" }, [save]),
      ...(configPath ? [el("p", { class: "hint" }, [`Config: ${configPath}`])] : []),
    );
  }


  /* ---------------- automations (P3 #27 — their Automation settings page) ---------------- */

  async #renderAutomations(config: any): Promise<void> {
    let state: any = null;
    try {
      state = await gateway.request("automations.state");
    } catch (err) {
      toast((err as Error).message, "err");
    }
    // Cron editor (P4 #35) — richer data (jobs + last runs) than
    // automations.state; reconcile happens server-side on every list.
    let cronData: any = null;
    try {
      cronData = await gateway.request("cron.list");
    } catch { /* covered by state fallback */ }

    const row = (label: string, value: string, style = ""): HTMLElement =>
      el("div", { class: "row" }, [
        el("span", { class: "row__label" }, [label]),
        el("span", { class: "row__value", style }, [value]),
      ]);
    const card = (title: string, rows: HTMLElement[], extra: Node[] = []): HTMLElement =>
      el("div", { class: "card" }, [el("h3", {}, [title]), ...rows, ...extra]);

    // ----- cron (P4 #35: full editor — their Cron page) -----
    const cronRows: HTMLElement[] = [];
    const cronCardExtra: Node[] = [];
    const jobs: any[] = cronData?.jobs ?? state?.cron?.jobs ?? [];
    const lastRunByJob = new Map<string, any>();
    for (const r of cronData?.runs ?? []) {
      if (!lastRunByJob.has(r.job_id)) lastRunByJob.set(r.job_id, r);
    }
    if (state?.cron?.enabled === false) {
      cronRows.push(row("Scheduler", "disabled"));
    } else {
      cronRows.push(row("Scheduler", `on · ${jobs.length} jobs`));
    }
    for (const j of jobs) {
      const enabled = Number(j.enabled ?? 1) === 1;
      const last = lastRunByJob.get(String(j.id));
      const meta = [
        `${j.schedule ?? j.expr ?? j.cron ?? ""}${j.tz ? ` [${j.tz}]` : ""}`,
        last ? `· last ${last.status ?? "run"} ${new Date(Number(last.started_at)).toLocaleString()}` : "",
        j.delivery_mode ? `· ${j.delivery_mode}${j.delivery_to ? ` → ${j.delivery_to}` : ""}` : "",
      ].filter(Boolean).join(" ");
      cronRows.push(
        el("div", { class: "row cron-job", "data-job": String(j.id) }, [
          el("div", { class: "cron-job__body" }, [
            el("span", { class: "row__label" }, [String(j.name ?? j.id ?? "job")]),
            el("span", { class: "hint cron-job__meta" }, [meta]),
          ]),
          (() => {
            const toggle = el("button", {
              class: `btn cron-job__toggle${enabled ? " is-on" : ""}`,
              type: "button",
              id: `cron-toggle-${j.id}`,
              "aria-pressed": enabled ? "true" : "false",
            }, [enabled ? "On" : "Off"]) as HTMLButtonElement;
            toggle.onclick = async () => {
              try {
                await gateway.request("cron.upsert", { id: String(j.id), name: String(j.name ?? j.id), schedule: String(j.schedule ?? j.expr ?? ""), prompt: String(j.prompt ?? ""), enabled: !enabled });
                await this.#renderAutomations(config);
              } catch (err) { toast((err as Error).message, "err"); }
            };
            return toggle;
          })(),
          (() => {
            const edit = el("button", { class: "btn", type: "button", id: `cron-edit-${j.id}` }, ["Edit…"]) as HTMLButtonElement;
            edit.onclick = () => this.#cronJobDialog(j, config);
            return edit;
          })(),
          (() => {
            const del = el("button", { class: "btn danger", type: "button", id: `cron-del-${j.id}` }, ["Delete"]) as HTMLButtonElement;
            del.onclick = async () => {
              if (!window.confirm(`Delete cron job "${j.name ?? j.id}"?`)) return;
              try {
                await gateway.request("cron.remove", { id: String(j.id) });
                toast(`removed ${j.id}`, "ok");
                await this.#renderAutomations(config);
              } catch (err) { toast((err as Error).message, "err"); }
            };
            return del;
          })(),
        ]),
      );
    }
    if (jobs.length === 0 && state?.cron?.enabled !== false) {
      cronCardExtra.push(el("p", { class: "hint" }, ["No jobs yet — give the agent time-based work."]));
    }
    const newJob = el("button", { class: "btn", type: "button", id: "cron-new" }, ["+ New job"]) as HTMLButtonElement;
    newJob.onclick = () => this.#cronJobDialog(null, config);
    cronCardExtra.push(newJob);
    this.#root.append(card("Cron jobs", cronRows, cronCardExtra));

    // ----- heartbeat -----
    const hb = state?.heartbeat ?? {};
    const everyIn = el("input", { class: "inp mono", id: "hb-every", value: String(hb.every ?? "30m") });
    const lightCb = el("input", { type: "checkbox" });
    (lightCb as HTMLInputElement).checked = Boolean(hb.lightContext);
    const isoCb = el("input", { type: "checkbox" });
    (isoCb as HTMLInputElement).checked = Boolean(hb.isolatedSession);
    const saveHb = el("button", { class: "btn", type: "button" }, ["Save"]);
    saveHb.onclick = async () => {
      await this.#setMany(
        [
          ["agents.defaults.heartbeat.every", everyIn.value.trim() || "30m"],
          ["agents.defaults.heartbeat.lightContext", (lightCb as HTMLInputElement).checked],
          ["agents.defaults.heartbeat.isolatedSession", (isoCb as HTMLInputElement).checked],
        ],
        "heartbeat saved — rebuilds on next tick",
      );
    };
    this.#root.append(card("Heartbeat", [
      row("Cadence", hb.armed ? `${hb.every ?? "30m"} · armed` : `${hb.every ?? "30m"} · not running`, hb.armed ? "color:var(--ok)" : "color:var(--warn)"),
      row("Target", String(hb.target ?? "owner")),
      row("Last DM", hb.lastTargetChat ? String(hb.lastTargetChat) : "—"),
      el("div", { class: "modal__field" }, [
        el("label", { class: "lbl", for: "hb-every" }, ["every (e.g. 30m, 1h, 0m to disable)"]),
        everyIn,
      ]),
      el("div", { class: "row" }, [el("span", { class: "row__label" }, ["lightContext"]), lightCb]),
      el("div", { class: "row" }, [el("span", { class: "row__label" }, ["isolatedSession"]), isoCb]),
    ], [
      el("p", { class: "hint" }, [
        "Standing orders (their automation/standing-orders) live in AGENTS.md and are injected every session; heartbeat only pokes the agent to act on them. Quiet by default via the NO_REPLY contract.",
      ]),
      saveHb,
    ]));

    // ----- imap (P4 #36: status AND editing — their automation/imap form) -----
    const imapRows: HTMLElement[] = [];
    const imap = state?.imap ?? {};
    // Live watcher status rows stay (cursor health came from the poller),
    // followed by the editable account forms from the redacted config.
    if (!imap.enabled) {
      imapRows.push(row("Watcher", "disabled"));
    } else {
      for (const a of imap.accounts ?? []) {
        imapRows.push(row(
          `${a.name} · ${a.mailbox}`,
          `${a.unhealthy ? "unhealthy" : `cursor ${a.cursor}`}${a.skips ? ` · ${a.skips} skip(s)` : ""}${a.lastError ? " · " + a.lastError.slice(0, 60) : ""}`,
          a.unhealthy ? "color:var(--err)" : "color:var(--ok)",
        ));
      }
    }
    const imapCfg = config.imap ?? {};
    const accounts: Record<string, any> = imapCfg.accounts ?? {};
    const imapMasterCb = el("input", { type: "checkbox", id: "imap-enabled" }) as HTMLInputElement;
    imapMasterCb.checked = Boolean(imapCfg.enabled);
    imapMasterCb.onchange = () => void this.#setMany([["imap.enabled", imapMasterCb.checked]], imapMasterCb.checked ? "imap watcher enabled" : "imap watcher disabled");
    imapRows.push(el("div", { class: "row" }, [el("span", { class: "row__label" }, ["Enabled"]), imapMasterCb]));
    for (const [aname, acc] of Object.entries(accounts)) {
      const bits = [
        `${acc.secure === false ? "" : "ssl "}${acc.host ?? "?"}:${acc.port ?? 993}`,
        acc.user ? String(acc.user) : "",
        `mailbox ${acc.mailbox ?? "INBOX"}`,
        `${acc.watch?.mode ?? "auto"}${acc.watch?.mode === "interval" || acc.watch?.mode === "auto" ? ` / ${acc.watch?.pollSeconds ?? 60}s` : ""}`,
        Number(acc.enabled ?? 1) === 0 ? "· disabled" : "",
      ].filter(Boolean).join(" · ");
      const editBtn = el("button", { class: "btn", type: "button", id: `imap-edit-${aname}` }, ["Edit…"]) as HTMLButtonElement;
      editBtn.onclick = () => this.#imapAccountDialog(aname, acc, config);
      const delBtn = el("button", { class: "btn danger", type: "button", id: `imap-del-${aname}` }, ["Delete"]) as HTMLButtonElement;
      delBtn.onclick = async () => {
        if (!window.confirm(`Delete IMAP account "${aname}" and its watcher config?`)) return;
        try {
          await gateway.request("config.unset", { path: `imap.accounts.${aname}` });
          toast(`removed account ${aname}`, "ok");
          this.#onChanged();
        } catch (err) { toast((err as Error).message, "err"); }
      };
      imapRows.push(el("div", { class: "row cron-job", "data-account": aname }, [
        el("div", { class: "cron-job__body" }, [
          el("span", { class: "row__label" }, [aname]),
          el("span", { class: "hint cron-job__meta" }, [bits]),
        ]),
        editBtn, delBtn,
      ]));
    }
    const addAcc = el("button", { class: "btn", type: "button", id: "imap-add" }, ["+ Add account"]) as HTMLButtonElement;
    addAcc.onclick = () => this.#imapAccountDialog(null, null, config);
    this.#root.append(card("IMAP mail watcher", imapRows, [
      el("p", { class: "hint" }, [
        "Their automation/imap: baseline on start, UIDVALIDITY dedupe, sender allowlist, no-replay restarts. Password fields stay blank to keep the stored secret — or set passwordEnv to reference \${ENV}.",
      ]),
      addAcc,
    ]));

    // ----- inbound hooks (P4 #36: token/path/mappings form) -----
    const hooksCfg = config.hooks ?? {};
    const hookRows: HTMLElement[] = [];
    const hookEnabledCb = el("input", { type: "checkbox", id: "hooks-enabled" }) as HTMLInputElement;
    hookEnabledCb.checked = Boolean(hooksCfg.enabled);
    hookEnabledCb.onchange = () => void this.#setMany([["hooks.enabled", hookEnabledCb.checked]], hookEnabledCb.checked ? "inbound hooks enabled" : "inbound hooks disabled");
    hookRows.push(el("div", { class: "row" }, [
      el("span", { class: "row__label" }, ["Enabled (needs enabled + token set to live)"]),
      hookEnabledCb,
    ]));
    const hookPathInp = el("input", { class: "inp mono", id: "hooks-path", value: String(hooksCfg.path ?? "/hooks"), autocomplete: "off" }) as HTMLInputElement;
    const hookTokenInp = el("input", { class: "inp mono", id: "hooks-token-out", type: "password", placeholder: "leave blank to keep the stored token", autocomplete: "off" }) as HTMLInputElement;
    const hookAskCb = el("input", { type: "checkbox", id: "hooks-ask" }) as HTMLInputElement;
    hookAskCb.checked = Boolean(hooksCfg.allowRequestSessionKey);
    const saveHooks = el("button", { class: "btn", type: "button", id: "hooks-save" }, ["Save hook settings"]) as HTMLButtonElement;
    saveHooks.onclick = async () => {
      const pairs: [string, unknown][] = [
        ["hooks.path", hookPathInp.value.trim() || "/hooks"],
        ["hooks.allowRequestSessionKey", hookAskCb.checked],
      ];
      if (hookTokenInp.value.trim()) pairs.push(["hooks.token", hookTokenInp.value.trim()]);
      hookTokenInp.value = "";
      await this.#setMany(pairs, "hook settings saved");
    };
    hookRows.push(el("div", { class: "modal__field" }, [el("label", { class: "lbl", for: "hooks-path" }, ["Path"]), hookPathInp]));
    hookRows.push(el("div", { class: "modal__field" }, [el("label", { class: "lbl", for: "hooks-token-out" }, ["Bearer token (write-only)"]), hookTokenInp]));
    hookRows.push(el("div", { class: "row" }, [el("span", { class: "row__label" }, ["allowRequestSessionKey"]), hookAskCb]));

    const mappings: Record<string, any> = hooksCfg.mappings ?? {};
    for (const [mname, m] of Object.entries(mappings)) {
      const editBtn = el("button", { class: "btn", type: "button", id: `hook-map-edit-${mname}` }, ["Edit…"]) as HTMLButtonElement;
      editBtn.onclick = () => this.#hookMappingDialog(mname, m, config);
      const delBtn = el("button", { class: "btn danger", type: "button", id: `hook-map-del-${mname}` }, ["Delete"]) as HTMLButtonElement;
      delBtn.onclick = async () => {
        if (!window.confirm(`Delete hook mapping "${mname}"?`)) return;
        try {
          await gateway.request("config.unset", { path: `hooks.mappings.${mname}` });
          toast(`removed mapping ${mname}`, "ok");
          this.#onChanged();
        } catch (err) { toast((err as Error).message, "err"); }
      };
      const desc = `${m.action ?? "agent"}${m.sessionKey ? ` → ${m.sessionKey}` : ""}${(m.message ?? m.text ?? "") ? ` — "${String(m.message ?? m.text).slice(0, 48)}"` : ""}`;
      hookRows.push(el("div", { class: "row cron-job", "data-mapping": mname }, [
        el("div", { class: "cron-job__body" }, [
          el("span", { class: "row__label" }, [mname]),
          el("span", { class: "hint cron-job__meta" }, [desc]),
        ]),
        editBtn, delBtn,
      ]));
    }
    if (Object.keys(mappings).length === 0) {
      hookRows.push(el("p", { class: "hint" }, ["No mappings — unmatched hook paths 404 (their unmapped-hook rule)."]));
    }
    const addMap = el("button", { class: "btn", type: "button", id: "hook-map-add" }, ["+ Add mapping"]) as HTMLButtonElement;
    addMap.onclick = () => this.#hookMappingDialog(null, null, config);
    this.#root.append(card("Inbound hooks", hookRows, [saveHooks, addMap]));

    // ----- message queue (P4 #37 — their command-queue settings) -----
    const queueCfg = config.messages?.queue ?? {};
    const qModeSel = el("select", { class: "in", id: "queue-mode" }) as HTMLSelectElement;
    for (const v of ["steer", "followup", "collect", "interrupt"]) {
      qModeSel.append(el("option", { value: v, ...(String(queueCfg.mode ?? "steer") === v ? { selected: "" } : {}) }, [v]));
    }
    const qCap = el("input", { class: "inp mono", id: "queue-cap", value: String(queueCfg.cap ?? 20), autocomplete: "off" }) as HTMLInputElement;
    const qDrop = el("select", { class: "in", id: "queue-drop" }) as HTMLSelectElement;
    for (const v of ["summarize", "old", "new"]) {
      qDrop.append(el("option", { value: v, ...(String(queueCfg.drop ?? "summarize") === v ? { selected: "" } : {}) }, [v]));
    }
    const qDebounce = el("input", { class: "inp mono", id: "queue-debounce", value: String(queueCfg.debounceMs ?? 500), autocomplete: "off" }) as HTMLInputElement;
    const qTg = el("select", { class: "in", id: "queue-by-tg" }) as HTMLSelectElement;
    const tgCur = String(queueCfg.byChannel?.telegram ?? "");
    const tgChoices: [string, string][] = [["", "inherit (default)"], ["steer", "steer"], ["followup", "followup"], ["collect", "collect"], ["interrupt", "interrupt"]];
    for (const [v, label] of tgChoices) {
      qTg.append(el("option", { value: v, ...(tgCur === v ? { selected: "" } : {}) }, [label]));
    }
    const saveQueue = el("button", { class: "btn", type: "button", id: "queue-save" }, ["Save"]) as HTMLButtonElement;
    saveQueue.onclick = () => {
      const pairs: [string, unknown][] = [
        ["messages.queue.mode", qModeSel.value],
        ["messages.queue.cap", Math.max(1, Number(qCap.value) || 20)],
        ["messages.queue.drop", qDrop.value],
        ["messages.queue.debounceMs", Math.max(0, Number(qDebounce.value) || 0)],
      ];
      pairs.push(["messages.queue.byChannel", { ...(qTg.value ? { telegram: qTg.value } : {}) }]);
      void this.#setMany(pairs, "queue settings saved");
    };
    this.#root.append(card("Message queue", [
      el("div", { class: "modal__field" }, [
        el("label", { class: "lbl", for: "queue-mode" }, ["Default mode"]),
        qModeSel,
        el("span", { class: "hint" }, ["steer: inject at tool boundaries · followup: run after the active turn · collect: merge in the quiet window · interrupt: kill and run newest"]),
      ]),
      el("div", { class: "modal__field" }, [el("label", { class: "lbl", for: "queue-cap" }, ["Cap (inputs held per session)"]), qCap]),
      el("div", { class: "modal__field" }, [el("label", { class: "lbl", for: "queue-drop" }, ["On overflow (drop)"]), qDrop]),
      el("div", { class: "modal__field" }, [el("label", { class: "lbl", for: "queue-debounce" }, ["Debounce (ms)"]), qDebounce]),
      el("div", { class: "modal__field" }, [
        el("label", { class: "lbl", for: "queue-by-tg" }, ["Per-channel override: telegram"]),
        qTg,
      ]),
    ], [
      el("p", { class: "hint" }, ["The chat header switch overrides these per session (queue.set); byChannel wins over the default here (their precedence)."]),
      saveQueue,
    ]));

    // ----- memory.dreaming schedule (P4 #36) -----
    const dreaming = config.memory?.dreaming ?? {};
    const dreamCb = el("input", { type: "checkbox", id: "dreaming-enabled" }) as HTMLInputElement;
    dreamCb.checked = dreaming.enabled !== false;
    const dreamSched = el("input", { class: "inp mono", id: "dreaming-schedule", value: String(dreaming.schedule ?? "0 3 * * *"), autocomplete: "off" }) as HTMLInputElement;
    const saveDream = el("button", { class: "btn", type: "button", id: "dreaming-save" }, ["Save"]) as HTMLButtonElement;
    saveDream.onclick = () => void this.#setMany(
      [
        ["memory.dreaming.enabled", dreamCb.checked],
        ["memory.dreaming.schedule", dreamSched.value.trim() || "0 3 * * *"],
      ],
      "dreaming schedule saved — the gateway daemon runs the next pass",
    );
    this.#root.append(card("Memory dreaming", [
      el("div", { class: "row" }, [el("span", { class: "row__label" }, ["Enabled"]), dreamCb]),
      el("div", { class: "modal__field" }, [
        el("label", { class: "lbl", for: "dreaming-schedule" }, ["Schedule (5-field cron — the gateway daemon runs it)"]),
        dreamSched,
      ]),
    ], [
      el("p", { class: "hint" }, ["Their default 0 3 * * * — nightly consolidation turns session transcripts into durable memory notes."]),
      saveDream,
    ]));
  }

  /** Cron job editor dialog (P4 #35 — their Add/Edit job flow): the same
   *  validated contract as `sc cron add` — schedule + IANA zone checked by
   *  croner server-side (`bad_schedule`), webhook delivery needs a target
   *  (`bad_request`). Edits keep the job id + session key. */
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
    const tzF = tf("tz", "Timezone (IANA, optional)", String(job?.tz ?? ""), "e.g. Asia/Dhaka — default: cron.timezone/host");
    const deliverySel = el("select", { class: "in", id: "cron-f-delivery" }) as HTMLSelectElement;
    for (const v of ["", "none", "announce", "webhook"]) {
      const opt = el("option", { value: v, ...(String(job?.delivery_mode ?? "") === v || (!job?.delivery_mode && v === "") ? { selected: "" } : {}) }, [v === "" ? "default (cron.delivery)" : v]);
      deliverySel.append(opt);
    }
    const toF = tf("to", "Delivery target (optional)", String(job?.delivery_to ?? ""), "telegram:<chatId> · session:<key> · https://…");
    const suppressCb = el("input", { type: "checkbox", id: "cron-f-suppress" }) as HTMLInputElement;
    suppressCb.checked = Number(job?.delivery_suppress_empty ?? 1) === 1;
    const enabledCb = el("input", { type: "checkbox", id: "cron-f-enabled" }) as HTMLInputElement;
    enabledCb.checked = Number(job?.enabled ?? 1) === 1;

    const body = el("div", {}, [
      nameF.node, schedF.node, promptF.node, tzF.node,
      el("div", { class: "modal__field" }, [
        el("label", { class: "lbl", for: "cron-f-delivery" }, ["Delivery"]),
        deliverySel,
        el("span", { class: "hint" }, ["none = keep it in the session only · announce = push to chat · webhook = POST to URL"]),
      ]),
      toF.node,
      el("div", { class: "row" }, [el("span", { class: "row__label" }, ["Suppress empty results"]), suppressCb]),
      el("div", { class: "row" }, [el("span", { class: "row__label" }, ["Enabled"]), enabledCb]),
    ]);

    modal({
      title: job ? `Edit job: ${job.name ?? job.id}` : "New cron job",
      render: (box) => { box.append(body); },
      confirmLabel: job ? "Save job" : "Create job",
      onConfirm: async () => {
        try {
          const res = (await gateway.request("cron.upsert", {
            ...(job?.id ? { id: String(job.id) } : {}),
            name: nameF.input.value.trim(),
            schedule: schedF.input.value.trim(),
            prompt: promptF.input.value.trim(),
            tz: tzF.input.value.trim() || undefined,
            deliveryMode: deliverySel.value || undefined,
            deliveryTo: toF.input.value.trim() || undefined,
            suppressEmpty: suppressCb.checked,
            enabled: enabledCb.checked,
          })) as any;
          toast(`${job ? "saved" : "created"} ${res.job?.name ?? nameF.input.value} · next ${res.next ?? "?"}`, "ok");
          await this.#renderAutomations(config);
        } catch (err) {
          toast((err as Error).message, "err");
        }
      },
    });
  }

  /** IMAP account editor (P4 #36): leaf writes only — the account object is
   *  never round-tripped, so a redacted password can never be persisted as a
   *  sentinel string. Blank password = keep (their editor contract). */
  #imapAccountDialog(origName: string | null, acc: any | null, config: any): void {
    const tf = (idSuffix: string, label: string, value: string, placeholder: string) => {
      const input = el("input", { id: `imap-f-${idSuffix}`, class: "inp", type: "text", value, placeholder, autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
      return { input, node: el("div", { class: "modal__field" }, [el("label", { class: "lbl", for: `imap-f-${idSuffix}` }, [label]), input]) };
    };
    const nameF = tf("name", "Account name", String(origName ?? ""), "e.g. work");
    if (origName) nameF.input.disabled = true; // record key ≙ id: edits keep it
    const hostF = tf("host", "Host", String(acc?.host ?? ""), "imap.example.com");
    const portF = tf("port", "Port", String(acc?.port ?? 993), "993");
    const secureCb = el("input", { type: "checkbox", id: "imap-f-secure" }) as HTMLInputElement;
    secureCb.checked = acc?.secure !== false;
    const enabledCb = el("input", { type: "checkbox", id: "imap-f-enabled" }) as HTMLInputElement;
    enabledCb.checked = Number(acc?.enabled ?? 1) !== 0;
    const userF = tf("user", "Username", String(acc?.user ?? ""), "bot@example.com");
    const pwF = tf("password", origName ? "Password (blank keeps stored)" : "Password", "", origName ? "leave blank to keep" : "app password");
    if (origName) pwF.input.type = "password";
    const pwEnvF = tf("passwenv", "passwordEnv (optional)", String(acc?.passwordEnv ?? ""), "e.g. IMAP_PASS — uses ${IMAP_PASS} env");
    const mbxF = tf("mailbox", "Mailbox", String(acc?.mailbox ?? "INBOX"), "INBOX");
    const watchSel = el("select", { class: "in", id: "imap-f-watch" }) as HTMLSelectElement;
    for (const v of ["auto", "idle", "interval"]) {
      watchSel.append(el("option", { value: v, ...(String(acc?.watch?.mode ?? "auto") === v ? { selected: "" } : {}) }, [v]));
    }
    const pollF = tf("poll", "Poll seconds (interval/auto)", String(acc?.watch?.pollSeconds ?? 60), "60");
    const sendersF = tf("senders", "Allowed senders (comma list, blank = all)", (acc?.allowedSenders ?? []).join(", "), "alice@x.com, bob@y.io");
    const authSel = el("select", { class: "in", id: "imap-f-authmin" }) as HTMLSelectElement;
    for (const v of ["unverified", "mutable", "asserted", "verified"]) {
      authSel.append(el("option", { value: v, ...(String(acc?.senderAuth?.min ?? "unverified") === v ? { selected: "" } : {}) }, [v]));
    }
    const deliverCb = el("input", { type: "checkbox", id: "imap-f-deliver" }) as HTMLInputElement;
    deliverCb.checked = Boolean(acc?.deliver);
    const toF = tf("to", "Deliver to (optional)", String(acc?.to ?? ""), "telegram:<chatId> | session:<key>");
    const bodyCb = el("input", { type: "checkbox", id: "imap-f-body" }) as HTMLInputElement;
    bodyCb.checked = acc?.includeBody !== false;

    modal({
      title: origName ? `Edit IMAP account: ${origName}` : "New IMAP account",
      render: (box) => {
        box.append(
          nameF.node, hostF.node, portF.node, userF.node, pwF.node, pwEnvF.node, mbxF.node,
          el("div", { class: "modal__field" }, [el("label", { class: "lbl", for: "imap-f-watch" }, ["Watch mode"]), watchSel]),
          pollF.node, sendersF.node,
          el("div", { class: "modal__field" }, [
            el("label", { class: "lbl", for: "imap-f-authmin" }, ["Sender auth floor"]),
            authSel,
            el("span", { class: "hint" }, ["unverified is our only functioning floor without a DMARC verifier (see src/automation/imap.ts)."]),
          ]),
          el("div", { class: "row" }, [el("span", { class: "row__label" }, ["Enabled"]), enabledCb]),
          el("div", { class: "row" }, [el("span", { class: "row__label" }, ["SSL (secure)"]), secureCb]),
          el("div", { class: "row" }, [el("span", { class: "row__label" }, ["Deliver results"]), deliverCb]),
          toF.node,
          el("div", { class: "row" }, [el("span", { class: "row__label" }, ["Include body"]), bodyCb]),
        );
      },
      confirmLabel: origName ? "Save account" : "Add account",
      onConfirm: async () => {
        const rawName = origName ?? nameF.input.value.trim();
        if (!rawName) { toast("account name is required", "err"); return; }
        const aname = rawName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "account";
        if (aname.includes(".")) { toast("account name may not contain dots", "err"); return; }
        const senders = sendersF.input.value.split(",").map((x) => x.trim()).filter(Boolean);
        const base = `imap.accounts.${aname}`;
        const pairs: [string, unknown][] = [
          [`${base}.enabled`, enabledCb.checked],
          [`${base}.host`, hostF.input.value.trim()],
          [`${base}.port`, Math.max(1, Math.min(65535, Number(portF.input.value) || 993))],
          [`${base}.secure`, secureCb.checked],
          [`${base}.user`, userF.input.value.trim()],
          [`${base}.mailbox`, mbxF.input.value.trim() || "INBOX"],
          [`${base}.watch`, { mode: watchSel.value, pollSeconds: Math.max(15, Number(pollF.input.value) || 60) }],
          [`${base}.allowedSenders`, senders],
          [`${base}.senderAuth`, { ...(acc?.senderAuth ?? {}), min: authSel.value }],
          [`${base}.deliver`, deliverCb.checked],
          [`${base}.to`, toF.input.value.trim()],
          [`${base}.includeBody`, bodyCb.checked],
        ];
        if (pwEnvF.input.value.trim()) pairs.push([`${base}.passwordEnv`, pwEnvF.input.value.trim()]);
        if (pwF.input.value) pairs.push([`${base}.password`, pwF.input.value]);
        await this.#setMany(pairs, origName ? `account ${aname} saved` : `account ${aname} added`);
        this.#onChanged();
      },
    });
  }

  /** Hook mapping editor (P4 #36): action + payload per path suffix. The name
   *  is the record key (URL segment), so it's write-once like account names. */
  #hookMappingDialog(origName: string | null, m: any | null, config: any): void {
    const tf = (idSuffix: string, label: string, value: string, placeholder: string) => {
      const input = el("input", { id: `hmap-f-${idSuffix}`, class: "inp", type: "text", value, placeholder, autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
      return { input, node: el("div", { class: "modal__field" }, [el("label", { class: "lbl", for: `hmap-f-${idSuffix}` }, [label]), input]) };
    };
    const nameF = tf("name", "Mapping name (URL segment)", String(origName ?? ""), "e.g. github");
    if (origName) nameF.input.disabled = true;
    const actionSel = el("select", { class: "in", id: "hmap-f-action" }) as HTMLSelectElement;
    for (const v of ["agent", "wake"]) {
      actionSel.append(el("option", { value: v, ...(String(m?.action ?? "agent") === v ? { selected: "" } : {}) }, [v === "agent" ? "agent — run the payload" : "wake — nudge the main session"]));
    }
    const msgF = tf("message", "Message template", String(m?.message ?? m?.text ?? ""), "{{body}} or a fixed instruction");
    const keyF = tf("sessionkey", "Session key (optional)", String(m?.sessionKey ?? ""), "blank = hook main session");

    modal({
      title: origName ? `Edit hook mapping: ${origName}` : "New hook mapping",
      render: (box) => {
        box.append(
          nameF.node,
          el("div", { class: "modal__field" }, [el("label", { class: "lbl", for: "hmap-f-action" }, ["Action"]), actionSel]),
          msgF.node, keyF.node,
          el("p", { class: "hint" }, ["POST {gateway}{path}/{name} with Authorization: Bearer <hooks.token>. Their templates support {{body}}, {{subject}} placeholders."]),
        );
      },
      confirmLabel: origName ? "Save mapping" : "Add mapping",
      onConfirm: async () => {
        const rawName = origName ?? nameF.input.value.trim();
        if (!rawName) { toast("mapping name is required", "err"); return; }
        const mname = rawName.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "mapping";
        if (mname.includes(".")) { toast("mapping name may not contain dots", "err"); return; }
        await this.#setMany(
          [[`hooks.mappings.${mname}`, {
            action: actionSel.value,
            ...(msgF.input.value.trim() ? { message: msgF.input.value.trim() } : {}),
            ...(keyF.input.value.trim() ? { sessionKey: keyF.input.value.trim() } : {}),
          }]],
          origName ? `mapping ${mname} saved` : `mapping ${mname} added`,
        );
        this.#onChanged();
      },
    });
  }

  /* ---------------- alerts (their Settings → Notifications page) ---------------- */

  #renderAlerts(): void {
    const prefs = loadPrefs();
    const state = permissionState();

    const stateRow = el("div", { class: "row" }, [
      el("span", { class: "row__label" }, ["Browser permission"]),
      el("span", { class: `row__value${state === "granted" ? " is-ok" : state === "denied" ? " is-err" : ""}` }, [state]),
    ]);

    if (!supported()) {
      this.#root.append(el("div", { class: "card" }, [
        stateRow,
        el("p", { class: "hint" }, ["This browser has no Notification support — only the status surface is available (their unsupported-browser row)."]),
      ]));
      return;
    }

    const toggle = (key: "enabled" | "reply" | "approvals", label: string, hintText: string): HTMLElement => {
      const cb = el("input", { type: "checkbox" }) as HTMLInputElement;
      cb.checked = prefs[key];
      cb.onchange = () => {
        prefs[key] = cb.checked;
        savePrefs(prefs);
      };
      return el("div", {}, [
        el("div", { class: "row" }, [el("span", { class: "row__label" }, [label]), cb]),
        el("p", { class: "hint" }, [hintText]),
      ]);
    };

    const fromIn = el("input", { class: "inp mono", placeholder: "22:00", value: prefs.quietFrom });
    const toIn = el("input", { class: "inp mono", placeholder: "08:00", value: prefs.quietTo });
    fromIn.onchange = () => { prefs.quietFrom = (fromIn as HTMLInputElement).value.trim(); savePrefs(prefs); };
    toIn.onchange = () => { prefs.quietTo = (toIn as HTMLInputElement).value.trim(); savePrefs(prefs); };

    const testBtn = el("button", { class: "btn", type: "button" }, ["Send test"]);
    testBtn.onclick = async () => {
      const ok = await sendTest();
      toast(ok ? "test sent" : "Notification API unavailable", ok ? "ok" : "err");
    };

    this.#root.append(el("div", { class: "card" }, [
      stateRow,
      toggle("enabled", "Enable notifications", "Alerts appear when the page is hidden — generic lock-screen text only (their privacy rule: no prompts, commands, or excerpts)."),
      toggle("approvals", "Approval requests", "On by default (their default category)."),
      toggle("reply", "Final replies", "Opt-in (their every-other-category-off rule)."),
      el("div", { class: "row" }, [
        el("span", { class: "row__label" }, ["Quiet hours"]),
        el("div", { class: "row__value" }, [fromIn, " – ", toIn]),
      ]),
      el("p", { class: "hint" }, ["Alerts inside quiet hours are skipped, not queued (their quiet-hours rule)."]),
      testBtn,
    ]));
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

    const list = el("div", { class: "card card--flush" });
    for (const [k, v, style] of rows) {
      list.append(el("div", { class: "row" }, [
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
        el("span", { class: `row__value${svc.running ? " is-ok" : " is-err"}` }, [
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

    return el("div", { class: "settings__stack" }, [card, logsDetails]);
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

    const body = el("div", { class: "settings__stack" });
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
    const stateValue = el("span", { class: `row__value${status?.scheduleError ? " is-err" : ""}` }, [stateLine]);

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
    const diaryList = el("div", { class: "settings__stack" });
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
