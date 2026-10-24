// Agent Trace component - vanilla JS implementation
import "./trace.css";

function formatDuration(ms) {
  if (ms < 0) ms = 0;
  if (ms < 1000) return Math.round(ms) + "ms";
  const s = ms / 1000;
  if (s < 60) return s >= 10 ? Math.round(s) + "s" : s.toFixed(1) + "s";
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  if (sec === 0) return m + "m";
  return m + "m " + sec + "s";
}

function iconFor(tool) {
  const t = (tool || "").toLowerCase();
  if (t.includes("search") || t.includes("web")) {
    return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';
  }
  if (t.includes("read") || t.includes("file") || t.includes("fs")) {
    return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/></svg>';
  }
  if (t.includes("write") || t.includes("edit")) {
    return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>';
  }
  if (t.includes("code")) {
    return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>';
  }
  return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M7 7h10M7 12h10M7 17h6"/></svg>';
}

export class AgentTrace {
  constructor(root, opts = {}) {
    this.root = root;
    this.opts = opts;
    this.runId = null;
    this.status = "idle";
    this.steps = [];
    this.groups = new Map();
    this.startTs = 0;
    this.endTs = 0;
    this.expanded = true;
    this.autoScroll = true;
    this.timerHandle = null;
    this.elapsed = 0;

    this.el = document.createElement("div");
    this.el.className = "agent-trace agent-trace--running";
    this.el.innerHTML = `
      <div class="agent-trace__card" role="region" aria-live="polite">
        <button class="agent-trace__header" aria-expanded="true" aria-controls="trace-body">
          <span class="agent-trace__icon-wrap"><span class="agent-trace__spinner"></span></span>
          <span class="agent-trace__status-text"><span class="agent-trace__status-shimmer" data-status>Working…</span></span>
          <span class="agent-trace__meta">
            <span class="agent-trace__timer" data-timer>0s</span>
            <span class="agent-trace__steps-count" data-count hidden></span>
            <span class="agent-trace__chips" data-chips></span>
            <svg class="agent-trace__chev" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>
          </span>
        </button>
        <div class="agent-trace__body" id="trace-body">
          <div class="agent-trace__body-inner">
            <div class="agent-trace__steps" data-steps></div>
          </div>
        </div>
      </div>
      <div class="agent-trace__final" data-final hidden></div>
      <button class="agent-trace__jump" data-jump>Jump to latest</button>
      <div class="sr-only" aria-live="polite" data-live></div>
    `;
    this.root.appendChild(this.el);

    this.header = this.el.querySelector(".agent-trace__header");
    this.statusEl = this.el.querySelector("[data-status]");
    this.timerEl = this.el.querySelector("[data-timer]");
    this.countEl = this.el.querySelector("[data-count]");
    this.chipsEl = this.el.querySelector("[data-chips]");
    this.body = this.el.querySelector(".agent-trace__body");
    this.stepsEl = this.el.querySelector("[data-steps]");
    this.finalEl = this.el.querySelector("[data-final]");
    this.jumpEl = this.el.querySelector("[data-jump]");
    this.liveEl = this.el.querySelector("[data-live]");

    this.header.addEventListener("click", () => {
      if (this.status === "running") return;
      this.toggle();
    });
    this.jumpEl.addEventListener("click", () => {
      this.autoScroll = true;
      this.jumpEl.classList.remove("is-visible");
      this.scrollToBottom();
    });
  }

  toggle() {
    this.expanded = !this.expanded;
    this.el.classList.toggle("agent-trace--expanded", this.expanded);
    this.header.setAttribute("aria-expanded", this.expanded ? "true" : "false");
    if (this.expanded) {
      this.body.style.maxHeight = this.body.scrollHeight + "px";
    } else {
      this.body.style.maxHeight = "0px";
    }
  }

  startTimer() {
    this.stopTimer();
    const tick = () => {
      this.elapsed = Date.now() - this.startTs;
      this.timerEl.textContent = formatDuration(this.elapsed);
    };
    tick();
    this.timerHandle = setInterval(tick, 1000);
  }

  stopTimer() {
    if (this.timerHandle) {
      clearInterval(this.timerHandle);
      this.timerHandle = null;
    }
  }

  pushEvent(ev) {
    if (ev.type === "run_start") {
      this.runId = ev.runId;
      this.status = "running";
      this.startTs = ev.ts || Date.now();
      this.expanded = true;
      this.el.classList.add("agent-trace--running");
      this.el.classList.remove("agent-trace--done");
      this.el.classList.add("agent-trace--expanded");
      this.header.setAttribute("aria-expanded", "true");
      this.body.style.maxHeight = this.body.scrollHeight + 1000 + "px";
      this.startTimer();
      this.statusEl.textContent = "Working…";
      this.statusEl.classList.add("agent-trace__status-shimmer");
      this.liveEl.textContent = "Agent started working";
      return;
    }
    if (ev.type === "thinking_start") {
      const step = { id: ev.stepId, type: "thinking", status: "running", startedAt: ev.ts || Date.now(), text: "" };
      this.steps.push(step);
      this.renderStep(step);
      this.statusEl.textContent = "Thinking…";
      this.liveEl.textContent = "Thinking";
      this.maybeScroll();
      return;
    }
    if (ev.type === "thinking_delta") {
      const step = this.steps.find((s) => s.id === ev.stepId && s.type === "thinking");
      if (step) {
        step.text += ev.text || "";
        this.renderStep(step);
        this.maybeScroll();
      }
      return;
    }
    if (ev.type === "thinking_end") {
      const step = this.steps.find((s) => s.id === ev.stepId && s.type === "thinking");
      if (step) {
        step.status = "done";
        step.endedAt = ev.ts || Date.now();
        this.renderStep(step);
      }
      return;
    }
    if (ev.type === "message_delta") {
      let step = this.steps.find((s) => s.id === ev.stepId && s.type === "message" && s.status === "running");
      if (!step) {
        step = { id: ev.stepId, type: "message", status: "running", startedAt: ev.ts || Date.now(), text: "" };
        this.steps.push(step);
        this.renderStep(step);
      }
      step.text += ev.text || "";
      if (ev.final) {
        step.status = "done";
        step.endedAt = ev.ts || Date.now();
      }
      this.renderStep(step);
      this.statusEl.textContent = "Writing answer…";
      this.maybeScroll();
      return;
    }
    if (ev.type === "tool_start") {
      const groupId = ev.groupId || ev.tool;
      if (!this.groups.has(groupId)) {
        this.groups.set(groupId, { id: groupId, tool: ev.tool, items: [], running: 0 });
      }
      const group = this.groups.get(groupId);
      group.items.push({ id: ev.stepId, tool: ev.tool, label: ev.label, icon: ev.icon, input: ev.input, status: "running", startedAt: ev.ts || Date.now() });
      group.running++;
      this.renderGroups();
      this.statusEl.textContent = ev.label || "Running tool…";
      this.liveEl.textContent = ev.label || "Running tool";
      this.maybeScroll();
      return;
    }
    if (ev.type === "tool_end") {
      // find in any group
      for (const group of this.groups.values()) {
        const item = group.items.find((i) => i.id === ev.stepId);
        if (item) {
          item.status = "done";
          item.endedAt = ev.ts || Date.now();
          item.output = ev.output;
          item.summary = ev.summary;
          item.meta = ev.meta;
          item.retried = ev.retried;
          item.retryNote = ev.retryNote;
          group.running = Math.max(0, group.running - 1);
          break;
        }
      }
      this.renderGroups();
      this.maybeScroll();
      return;
    }
    if (ev.type === "tool_error") {
      for (const group of this.groups.values()) {
        const item = group.items.find((i) => i.id === ev.stepId);
        if (item) {
          item.status = ev.willRetry ? "running" : "error";
          item.error = ev.message;
          if (!ev.willRetry) group.running = Math.max(0, group.running - 1);
          break;
        }
      }
      this.renderGroups();
      this.maybeScroll();
      return;
    }
    if (ev.type === "approval_request") {
      this.status = "waiting";
      this.statusEl.textContent = "Waiting for your approval";
      this.statusEl.classList.remove("agent-trace__status-shimmer");
      this.renderApproval(ev);
      return;
    }
    if (ev.type === "run_end") {
      this.status = ev.status;
      this.stopTimer();
      if (this.startTs) {
        this.elapsed = (ev.ts || Date.now()) - this.startTs;
        this.timerEl.textContent = formatDuration(this.elapsed);
      }
      this.el.classList.remove("agent-trace--running");
      this.el.classList.add("agent-trace--done");
      if (ev.status === "done") {
        this.statusEl.textContent = `Worked for ${formatDuration(this.elapsed)}`;
        this.statusEl.classList.remove("agent-trace__status-shimmer");
        this.updateChips();
        this.updateCount();
        // fold interim messages in collapsed view conceptually - just ensure rendering
        setTimeout(() => {
          this.expanded = false;
          this.el.classList.remove("agent-trace--expanded");
          this.header.setAttribute("aria-expanded", "false");
          this.body.style.maxHeight = "0px";
        }, 400);
      } else if (ev.status === "stopped") {
        this.statusEl.textContent = `Stopped after ${formatDuration(this.elapsed)} - ${this.countSteps()} steps`;
        this.statusEl.classList.remove("agent-trace__status-shimmer");
        this.updateChips();
        this.updateCount();
      } else {
        this.statusEl.textContent = "Run failed";
        this.statusEl.classList.remove("agent-trace__status-shimmer");
      }
      this.liveEl.textContent = "Agent finished";
      return;
    }
  }

  countSteps() {
    let c = 0;
    for (const s of this.steps) {
      if (s.type === "thinking" || s.type === "message") c++;
    }
    for (const g of this.groups.values()) {
      if (g.items.length > 0) c++;
    }
    return c;
  }

  updateCount() {
    const c = this.countSteps();
    this.countEl.textContent = c + " steps";
    this.countEl.hidden = false;
  }

  updateChips() {
    this.chipsEl.innerHTML = "";
    const seen = new Set();
    for (const g of this.groups.values()) {
      if (seen.has(g.tool)) continue;
      seen.add(g.tool);
      const chip = document.createElement("span");
      chip.className = "agent-trace__chip";
      chip.innerHTML = iconFor(g.tool);
      this.chipsEl.appendChild(chip);
    }
  }

  renderGroups() {
    // Simple render: clear and rebuild groups
    // For demo, rebuild whole steps area
    this.renderAll();
  }

  renderStep(step) {
    this.renderAll();
  }

  renderAll() {
    this.stepsEl.innerHTML = "";
    // render groups
    for (const group of this.groups.values()) {
      if (group.items.length === 0) continue;
      const g = document.createElement("div");
      g.className = "agent-trace__group";
      const header = document.createElement("div");
      header.className = "agent-trace__group-header";
      const rail = document.createElement("div");
      rail.className = "agent-trace__rail";
      rail.innerHTML = '<div class="agent-trace__rail-dot"><span class="agent-trace__circle">' + iconFor(group.tool) + '</span></div><div class="agent-trace__rail-line"></div>';
      const content = document.createElement("div");
      content.className = "agent-trace__content";
      const label = document.createElement("span");
      label.className = "agent-trace__label";
      const count = group.items.length;
      const running = group.running > 0;
      label.textContent = (group.items[0].label || group.tool) + (count > 1 ? " - " + count + " calls" : "");
      content.appendChild(label);
      if (running) {
        const spin = document.createElement("span");
        spin.className = "agent-trace__circle agent-trace__circle--spinner";
        spin.style.width = "14px";
        spin.style.height = "14px";
        content.appendChild(spin);
      } else {
        const dur = this.groupDuration(group);
        if (dur) {
          const d = document.createElement("span");
          d.className = "agent-trace__duration";
          d.textContent = dur;
          content.appendChild(d);
        }
      }
      header.appendChild(rail);
      header.appendChild(content);
      g.appendChild(header);
      // subrows
      for (const item of group.items) {
        const sub = document.createElement("div");
        sub.className = "agent-trace__subrow";
        const rail2 = document.createElement("div");
        rail2.className = "agent-trace__rail";
        rail2.innerHTML = '<div class="agent-trace__rail-dot"></div><div class="agent-trace__rail-line"></div>';
        const txt = document.createElement("span");
        txt.textContent = item.summary || item.label || "";
        const check = document.createElement("span");
        check.className = "agent-trace__subrow-check";
        check.innerHTML = running && item.status === "running" ? '<span class="agent-trace__circle agent-trace__circle--spinner" style="width:12px;height:12px"></span>' : '✓';
        sub.appendChild(rail2);
        sub.appendChild(txt);
        sub.appendChild(check);
        g.appendChild(sub);
      }
      this.stepsEl.appendChild(g);
    }
    // thinking/message steps
    for (const step of this.steps) {
      if (step.type === "thinking") {
        const row = document.createElement("div");
        row.className = "agent-trace__step" + (step.status === "done" ? " agent-trace__step--expanded" : "");
        const rail = document.createElement("div");
        rail.className = "agent-trace__rail";
        rail.innerHTML = '<div class="agent-trace__rail-dot"><span class="agent-trace__dot"></span></div><div class="agent-trace__rail-line"></div>';
        const content = document.createElement("button");
        content.className = "agent-trace__content";
        content.style.background = "transparent";
        content.style.border = "none";
        content.style.textAlign = "left";
        content.style.cursor = "pointer";
        content.innerHTML = '<span class="agent-trace__label agent-trace__label--muted">Thought for ' + formatDuration((step.endedAt || Date.now()) - step.startedAt) + '</span><svg class="agent-trace__chev-sm" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m9 18 6-6-6-6"/></svg>';
        content.onclick = (e) => {
          e.stopPropagation();
          row.classList.toggle("agent-trace__step--expanded");
        };
        const detail = document.createElement("div");
        detail.className = "agent-trace__detail agent-trace__detail--thought";
        detail.textContent = step.text || "";
        row.appendChild(rail);
        row.appendChild(content);
        row.appendChild(detail);
        this.stepsEl.appendChild(row);
      } else if (step.type === "message") {
        if (this.status === "done" && this.expanded === false) {
          // folded in collapsed view - skip displaying interim messages
          continue;
        }
        const row = document.createElement("div");
        row.className = "agent-trace__step";
        const rail = document.createElement("div");
        rail.className = "agent-trace__rail";
        rail.innerHTML = '<div class="agent-trace__rail-dot"><span class="agent-trace__dot agent-trace__dot--accent"></span></div><div class="agent-trace__rail-line"></div>';
        const content = document.createElement("div");
        content.className = "agent-trace__content";
        const label = document.createElement("span");
        label.className = "agent-trace__label";
        label.textContent = step.text;
        content.appendChild(label);
        row.appendChild(rail);
        row.appendChild(content);
        this.stepsEl.appendChild(row);
      }
    }
    if (this.expanded && this.body) {
      this.body.style.maxHeight = this.body.scrollHeight + 2000 + "px";
    }
  }

  groupDuration(group) {
    let min = Infinity, max = 0;
    for (const i of group.items) {
      if (i.startedAt && i.endedAt) {
        if (i.startedAt < min) min = i.startedAt;
        if (i.endedAt > max) max = i.endedAt;
      }
    }
    if (max > min) return formatDuration(max - min);
    return null;
  }

  renderApproval(ev) {
    const row = document.createElement("div");
    row.className = "agent-trace__step";
    const rail = document.createElement("div");
    rail.className = "agent-trace__rail";
    rail.innerHTML = '<div class="agent-trace__rail-dot"></div><div class="agent-trace__rail-line"></div>';
    const card = document.createElement("div");
    card.className = "agent-trace__approval";
    card.innerHTML = '<div>' + (ev.description || "Approval required") + '</div><div class="agent-trace__approval-actions"><button class="agent-trace__btn">Deny</button><button class="agent-trace__btn agent-trace__btn--primary">Allow</button></div>';
    row.appendChild(rail);
    row.appendChild(card);
    this.stepsEl.appendChild(row);
    this.maybeScroll();
  }

  maybeScroll() {
    if (!this.autoScroll) return;
    this.scrollToBottom();
  }

  scrollToBottom() {
    const el = this.root.querySelector(".scroll") || this.root;
    el.scrollTop = el.scrollHeight;
  }

  setFinalAnswer(htmlOrText) {
    this.finalEl.hidden = false;
    if (typeof htmlOrText === "string" && htmlOrText.trim().startsWith("<")) {
      this.finalEl.innerHTML = htmlOrText;
    } else {
      this.finalEl.textContent = htmlOrText;
    }
  }
}

export default AgentTrace;
