/* Shared by the standalone pages and account app. No translation service is used. */
(function (root) {
  "use strict";

  const tokenPattern = /_{4}|[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;
  const colors = ["#286c9c", "#8b5d22", "#27765b", "#80568d", "#a04e51", "#626b28"];
  const svgNS = "http://www.w3.org/2000/svg";
  let sequence = 0;

  function tokenize(text) {
    return Array.from(text.matchAll(tokenPattern), (match) => ({ text: match[0], start: match.index, end: match.index + match[0].length }));
  }

  function key(english, meaning) {
    return JSON.stringify([english, meaning]);
  }

  function validateEntry(entry) {
    if (!entry || typeof entry.english !== "string" || typeof entry.meaning !== "string"
      || !Array.isArray(entry.zhParts) || !entry.zhParts.length
      || entry.zhParts.some((part) => typeof part !== "string" || !part.length)
      || entry.zhParts.join("") !== entry.meaning
      || !Array.isArray(entry.groups) || !entry.groups.length) return false;
    const tokens = tokenize(entry.english);
    if (!tokens.length) return false;
    const coverage = tokens.map(() => 0);
    const chineseCoverage = new Set();
    for (const group of entry.groups) {
      if (!group || !Array.isArray(group.en) || !group.en.length || !Array.isArray(group.zh) || !group.zh.length
        || (group.note !== undefined && typeof group.note !== "string")
        || new Set(group.en).size !== group.en.length || new Set(group.zh).size !== group.zh.length) return false;
      for (const index of group.en) {
        if (!Number.isInteger(index) || index < 0 || index >= tokens.length) return false;
        coverage[index] += 1;
      }
      for (const index of group.zh) {
        if (!Number.isInteger(index) || index < 0 || index >= entry.zhParts.length
          || !/[\p{L}\p{N}_]/u.test(entry.zhParts[index])) return false;
        chineseCoverage.add(index);
      }
    }
    return coverage.every((count) => count === 1)
      && entry.zhParts.every((part, index) => !/[\p{L}\p{N}_]/u.test(part) || chineseCoverage.has(index));
  }

  function runs(indices) {
    const result = [];
    for (const index of [...indices].sort((a, b) => a - b)) {
      const last = result[result.length - 1];
      if (last && last[last.length - 1] === index - 1) last.push(index);
      else result.push([index]);
    }
    return result;
  }

  class Renderer {
    constructor(elements) {
      Object.assign(this, elements);
      this.id = `word-alignment-${++sequence}`;
      this.entries = new Map();
      this.entry = null;
      this.frame = null;
      this.pinned = null;
      this.hovered = null;
      this.focused = null;
      this.destroyed = false;
      this.listeners = [];
      this.listen(this.english, "pointerover", (event) => {
        this.hovered = this.groupForNode(event.target);
        this.highlight();
      });
      this.listen(this.english, "pointerleave", () => {
        this.hovered = null;
        this.highlight();
      });
      this.listen(this.english, "focusin", (event) => {
        // A stationary pointer must not override a new keyboard focus.
        this.hovered = null;
        this.focused = this.groupForNode(event.target);
        this.highlight();
      });
      this.listen(this.english, "focusout", () => {
        this.focused = null;
        this.highlight();
      });
      this.listen(this.english, "click", (event) => {
        const group = this.groupForNode(event.target);
        if (group !== null) {
          this.pinned = group;
          this.highlight();
        }
      });
      this.listen(this.scroll, "keydown", (event) => {
        if (event.key === "Escape") {
          this.pinned = this.hovered = this.focused = null;
          this.highlight();
        }
      });
      if (typeof ResizeObserver !== "undefined") {
        this.observer = new ResizeObserver(() => this.scheduleDraw());
        this.observer.observe(this.stage);
        this.observer.observe(this.scroll);
      }
      this.listen(window, "resize", () => this.scheduleDraw());
      document.fonts?.ready.then(() => this.scheduleDraw());
      if (document.fonts) this.listen(document.fonts, "loadingdone", () => this.scheduleDraw());
    }

    listen(target, type, listener) {
      target.addEventListener(type, listener);
      this.listeners.push(() => target.removeEventListener(type, listener));
    }

    destroy() {
      if (this.destroyed) return;
      this.destroyed = true;
      this.listeners.forEach((remove) => remove());
      this.listeners = [];
      this.observer?.disconnect();
      if (this.frame !== null) cancelAnimationFrame(this.frame);
      this.frame = null;
      this.entry = null;
      this.entries.clear();
      this.tokenNodes = this.zhNodes = this.paths = [];
    }

    setData(data) {
      if (this.destroyed) return;
      this.entries.clear();
      if (data?.version !== 1 || !Array.isArray(data.entries)) return;
      const duplicates = new Set();
      for (const entry of data.entries) {
        if (!validateEntry(entry)) continue;
        const entryKey = key(entry.english, entry.meaning);
        if (this.entries.has(entryKey)) duplicates.add(entryKey);
        this.entries.set(entryKey, entry);
      }
      for (const entryKey of duplicates) this.entries.delete(entryKey);
    }

    groupForNode(node) {
      const button = node.closest?.(".alignment-token");
      return button && this.entry && this.english.contains(button) ? Number(button.dataset.group) : null;
    }

    render(item, { enabled = true, showEnglish = true } = {}) {
      if (this.destroyed) return;
      const nextKey = item ? key(item.word, item.meaning) : null;
      const changed = this.currentKey !== nextKey;
      this.currentKey = nextKey;
      this.entry = null;
      this.pinned = this.hovered = this.focused = null;
      if (this.frame !== null) cancelAnimationFrame(this.frame);
      this.frame = null;
      this.stage.classList.remove("has-alignment", "has-highlight");
      this.scroll.classList.remove("is-aligned");
      this.scroll.removeAttribute("tabindex");
      this.scroll.removeAttribute("aria-label");
      this.svg.replaceChildren();
      this.svg.setAttribute("hidden", "");
      this.note.textContent = "";
      this.note.hidden = true;
      this.english.textContent = item ? (showEnglish ? item.word : "•".repeat(item.word.length)) : "暂无词条";
      this.meaning.textContent = item?.meaning || "当前筛选没有可练习的内容。";
      if (changed) this.scroll.scrollLeft = 0;
      if (!item || !enabled || !showEnglish) return;

      const tokens = tokenize(item.word);
      const entry = item.kind === "word" && tokens.length === 1
        ? { english: item.word, meaning: item.meaning, zhParts: [item.meaning], groups: [{ en: [0], zh: [0] }] }
        : this.entries.get(nextKey);
      if (!entry) return;
      this.entry = entry;
      this.tokens = tokens;
      this.tokenNodes = [];
      this.zhNodes = [];
      this.paths = [];
      const groupByToken = new Map();
      entry.groups.forEach((group, groupIndex) => group.en.forEach((index) => groupByToken.set(index, groupIndex)));
      const englishFragment = document.createDocumentFragment();
      let offset = 0;
      tokens.forEach((token, index) => {
        englishFragment.append(document.createTextNode(item.word.slice(offset, token.start)));
        const button = document.createElement("button");
        button.type = "button";
        button.className = "alignment-token";
        button.textContent = token.text;
        button.dataset.enIndex = String(index);
        const groupIndex = groupByToken.get(index);
        button.dataset.group = String(groupIndex);
        button.style.setProperty("--link-color", colors[groupIndex % colors.length]);
        button.setAttribute("aria-label", `${token.text}，对应：${entry.groups[groupIndex].zh.map((n) => entry.zhParts[n]).join("…")}`);
        englishFragment.append(button);
        this.tokenNodes.push(button);
        offset = token.end;
      });
      englishFragment.append(document.createTextNode(item.word.slice(offset)));
      this.english.replaceChildren(englishFragment);
      const chineseFragment = document.createDocumentFragment();
      entry.zhParts.forEach((part, index) => {
        const span = document.createElement("span");
        span.className = "alignment-zh";
        span.textContent = part;
        span.dataset.zhIndex = String(index);
        chineseFragment.append(span);
        this.zhNodes.push(span);
      });
      this.meaning.replaceChildren(chineseFragment);
      this.stage.classList.add("has-alignment");
      this.scroll.classList.add("is-aligned");
      this.scroll.tabIndex = 0;
      this.scroll.setAttribute("aria-label", "中英文对应图，可左右滚动查看完整句子");
      this.svg.removeAttribute("hidden");
      this.note.hidden = false;
      this.highlight();
      this.scheduleDraw();
    }

    scheduleDraw() {
      if (this.destroyed || !this.entry || this.frame !== null) return;
      this.frame = requestAnimationFrame(() => {
        this.frame = null;
        this.draw();
      });
    }

    draw() {
      if (this.destroyed || !this.entry) return;
      const bounds = this.stage.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      this.svg.setAttribute("viewBox", `0 0 ${bounds.width} ${bounds.height}`);
      this.svg.replaceChildren();
      this.paths = [];
      const defs = document.createElementNS(svgNS, "defs");
      this.svg.append(defs);
      this.entry.groups.forEach((group, groupIndex) => {
        const color = colors[groupIndex % colors.length];
        const marker = document.createElementNS(svgNS, "marker");
        marker.id = `${this.id}-${groupIndex}`;
        marker.setAttribute("viewBox", "0 0 8 8");
        marker.setAttribute("refX", "4");
        marker.setAttribute("refY", "4");
        marker.setAttribute("markerWidth", "6");
        marker.setAttribute("markerHeight", "6");
        marker.setAttribute("orient", "auto");
        const head = document.createElementNS(svgNS, "path");
        head.setAttribute("d", "M 0 0 L 8 4 L 0 8 Z");
        head.setAttribute("fill", color);
        marker.append(head);
        defs.append(marker);
        for (const targetRun of runs(group.zh)) {
          const first = this.zhNodes[targetRun[0]].getBoundingClientRect();
          const last = this.zhNodes[targetRun[targetRun.length - 1]].getBoundingClientRect();
          group.en.forEach((tokenIndex, sourceIndex) => {
            const source = this.tokenNodes[tokenIndex].getBoundingClientRect();
            const sx = source.left + source.width / 2 - bounds.left;
            const sy = source.bottom - bounds.top + 7;
            const tx = first.left - bounds.left + (last.right - first.left) * (sourceIndex + 1) / (group.en.length + 1);
            const ty = first.top - bounds.top - 9;
            const middle = sy + (ty - sy) / 2;
            const path = document.createElementNS(svgNS, "path");
            path.setAttribute("d", `M ${sx} ${sy} C ${sx} ${middle}, ${tx} ${middle}, ${tx} ${ty}`);
            path.setAttribute("marker-end", `url(#${marker.id})`);
            path.classList.add("alignment-path");
            path.style.setProperty("--link-color", color);
            path.dataset.group = String(groupIndex);
            path.dataset.enIndex = String(tokenIndex);
            path.dataset.zhIndices = targetRun.join(",");
            this.svg.append(path);
            this.paths.push(path);
          });
        }
      });
      this.highlight();
    }

    highlight() {
      if (this.destroyed || !this.entry) return;
      const active = this.hovered ?? this.focused ?? this.pinned;
      this.stage.classList.toggle("has-highlight", active !== null);
      for (const node of [...this.tokenNodes, ...this.paths]) {
        node.classList.toggle("is-highlighted", Number(node.dataset.group) === active);
      }
      this.zhNodes.forEach((node, index) => {
        const selected = active !== null && this.entry.groups[active].zh.includes(index);
        node.classList.toggle("is-highlighted", selected);
        if (selected) node.style.setProperty("--link-color", colors[active % colors.length]);
      });
      if (active === null) {
        this.note.textContent = "移到或点击英文词，查看它对应的中文含义。";
        return;
      }
      const group = this.entry.groups[active];
      const english = runs(group.en).map((part) => this.entry.english.slice(this.tokens[part[0]].start, this.tokens[part[part.length - 1]].end)).join(" … ");
      const chinese = runs(group.zh).map((part) => part.map((index) => this.entry.zhParts[index]).join("")).join(" … ");
      this.note.textContent = `${english} → ${chinese}${group.note ? `。${group.note}` : ""}`;
    }
  }

  const api = { tokenize, key, validateEntry, create: (elements) => new Renderer(elements) };
  const commonJS = typeof module !== "undefined" && module.exports;
  if (commonJS) module.exports = api;
  // Bundlers can provide module.exports in a browser too; the SPA still needs this global.
  if (!commonJS || typeof window !== "undefined") root.WordAlignment = api;
})(globalThis);
