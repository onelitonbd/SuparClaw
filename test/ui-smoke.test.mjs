// Boots the built Control UI bundle against a minimal DOM stub.
//
// The real browser is not available on the build machine, so this test does
// the next best thing: it checks that every element the TypeScript looks up
// actually exists in ui/index.html, and that the bundle runs without throwing
// on start-up.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Each boot needs its own module instance: ESM caches by URL. */
let bootId = 0;

/** Collect the text of a stub node tree. */
function textOf(node) {
  if (node === null || node === undefined) return "";
  if (typeof node === "string") return node;
  const own = typeof node.textContent === "string" ? node.textContent : "";
  const kids = (node.children ?? []).map(textOf).join(" ");
  return `${own} ${kids}`;
}

/** Minimal element: enough DOM surface for the Control UI to boot. */
class El {
  constructor(tag = "div") {
    this.tagName = tag.toUpperCase();
    this.children = [];
    this.attributes = new Map();
    this.dataset = {};
    this.style = {};
    this.className = "";
    this.hidden = false;
    this.textContent = "";
    this.value = "";
    this.scrollTop = 0;
    this.scrollHeight = 1000;
    this.clientHeight = 600;
    this.scrollWidth = 800;
    this.clientWidth = 400;
    this.innerHTML = "";
    this._listeners = new Map();
    this.classList = {
      add: (...c) => { this.className = `${this.className} ${c.join(" ")}`.trim(); },
      remove: (...c) => { this.className = this.className.split(/\s+/).filter((x) => x && !c.includes(x)).join(" "); },
      toggle: (c, on) => { if (on) this.classList.add(c); else this.classList.remove(c); return on; },
      contains: (c) => this.className.split(/\s+/).includes(c),
    };
  }
  setAttribute(k, v) { this.attributes.set(k, String(v)); }
  getAttribute(k) { return this.attributes.get(k) ?? null; }
  removeAttribute(k) { this.attributes.delete(k); }
  append(...nodes) { for (const n of nodes) this.children.push(n); }
  appendChild(n) { this.children.push(n); return n; }
  remove() {}
  addEventListener(type, fn) { this._listeners.set(type, fn); }
  removeEventListener() {}
  dispatch(type, ev = {}) { this._listeners.get(type)?.(ev); }
  set onclick(fn) { this._onclick = fn; }
  get onclick() { return this._onclick; }
  set oninput(fn) { this._oninput = fn; }
  set oncontextmenu(fn) { this._oncontextmenu = fn; }
  set onkeydown(fn) { this._onkeydown = fn; }
  set onscroll(fn) { this._onscroll = fn; }
  focus() {}
  closest() { return null; }
  querySelector(sel) { return El.resolve ? El.resolve(sel) : null; }
  querySelectorAll() { return []; }
  get lastElementChild() { return this.children[this.children.length - 1] ?? null; }
  get firstElementChild() { return this.children[0] ?? null; }
  get parentElement() { return null; }
  get isConnected() { return true; }
  getBoundingClientRect() { return { top: 0, left: 0, width: 400, height: 300, right: 400, bottom: 300 }; }
  matches() { return false; }
}

async function boot() {
  const indexHtml = await readFile(join(root, "ui/index.html"), "utf8");
  let interiorHtml = "";
  try {
    interiorHtml = await readFile(join(root, "ui/interior/settings.html"), "utf8");
  } catch {}
  const html = indexHtml + "\n" + interiorHtml;
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

  const make = (tag) => new El(tag);
  const cache = new Map();
  const byId = (id) => {
    if (!ids.has(id)) return null;
    if (!cache.has(id)) cache.set(id, make("div"));
    return cache.get(id);
  };
  El.resolve = (sel) => (typeof sel === "string" && sel.startsWith("#") ? byId(sel.slice(1)) : null);

  const document = {
    documentElement: make("html"),
    body: make("body"),
    getElementById: (id) => byId(id),
    querySelector: (sel) => (sel.startsWith("#") ? byId(sel.slice(1)) : null),
    querySelectorAll: () => [],
    createElement: (tag) => make(tag),
    createTextNode: (t) => ({ nodeValue: t }),
    addEventListener() {},
    removeEventListener() {},
  };

  const listeners = new Map();
  const socket = {
    readyState: 0,
    send() {},
    close() {},
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener() {},
  };

  const winListeners = new Map();
  const win = {
    innerWidth: 1280,
    innerHeight: 800,
    addEventListener(type, fn) { winListeners.set(type, fn); },
    removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    location: { hash: "", href: "http://127.0.0.1:18790/", reload() {} },
    requestAnimationFrame: (fn) => setTimeout(fn, 0),
    getComputedStyle: () => ({ getPropertyValue: () => "" }),
  };
  win.window = win;

  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };

  const prev = {
    location: globalThis.location,
    window: globalThis.window,
    document: globalThis.document,
    localStorage: globalThis.localStorage,
    navigator: globalThis.navigator,
    WebSocket: globalThis.WebSocket,
    requestAnimationFrame: globalThis.requestAnimationFrame,
    matchMedia: globalThis.matchMedia,
    fetch: globalThis.fetch,
  };

  globalThis.window = win;
  globalThis.location = win.location;
  globalThis.document = document;
  globalThis.localStorage = localStorage;
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () => interiorHtml,
  });
  Object.defineProperty(globalThis, "navigator", {
    value: { clipboard: { writeText: async () => {} } },
    configurable: true,
    writable: true,
  });
  globalThis.WebSocket = class {
    constructor() { return socket; }
  };
  globalThis.requestAnimationFrame = win.requestAnimationFrame;
  globalThis.matchMedia = win.matchMedia;

  return {
    ids,
    byId,
    fire(type) { winListeners.get(type)?.({ type }); },
    restore: () => { Object.assign(globalThis, prev); El.resolve = null; },
  };
}

test("the Control UI bundle boots and every element it looks up exists", async () => {
  const { ids, restore } = await boot();
  try {
    const mod = await import(pathToFileURL(join(root, "dist/ui/app.js")).href + `?boot=${bootId++}`);
    assert.ok(mod, "bundle loaded");
  } finally {
    restore();
  }

  // The ids the app reaches for — keep in sync with ui/src/*.ts.
  const required = [
    "app", "chat-view", "thread", "stack", "jump", "composer", "input", "send-btn", "stop-btn",
    "tok", "model-btn", "model-name", "question", "question-body", "question-progress",
    "question-answer", "question-skip", "question-skip-one", "drawer-btn", "drawer-close", "drawer-scrim", "drawer",
    "sessions", "new-session", "sheet-overlay", "sheet-scrim", "sheet", "model-filter",
    "model-list", "sheet-add-provider", "modal-overlay", "modal-scrim", "modal", "modal-title",
    "modal-body", "modal-foot", "toasts", "settings-view", "settings-body",
    "settings-back", "settings-btn", "theme-btn", "session-btn", "session-title", "conn-dot",
    "conn-label",
    // Task 52 — the rail button and the panel node. The panel's inner ids are
    // built at boot by ui/src/terminal.ts (so they are not in index.html); this
    // boot importing app.js is what proves the panel constructs. Its contents
    // are asserted in test/ui-terminal-panel.test.mjs.
    "terminal-btn", "terminal-panel",
  ];
  const missing = required.filter((id) => !ids.has(id));
  assert.deepEqual(missing, [], `index.html is missing: ${missing.join(", ")}`);
});

test("opening settings before the gateway answers waits instead of erroring", async () => {
  const { byId, fire, restore } = await boot();
  try {
    await import(pathToFileURL(join(root, "dist/ui/app.js")).href + `?boot=${bootId++}`);
    // navigate to the settings page while the socket is still connecting
    globalThis.location.hash = "#/settings";
    fire("hashchange");
    await new Promise((r) => setTimeout(r, 30));

    const body = byId("settings-body");
    assert.ok(body, "settings body exists");
    assert.ok(body.children.length > 0, "settings renders a waiting state, not an empty page");
    const text = textOf(body);
    assert.match(text, /connecting/i, "the waiting state says it is connecting");
  } finally {
    restore();
  }
});
