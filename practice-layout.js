/* Shared, browser-local layout controls for the two practice sites. */
(function (root) {
  "use strict";

  const storageKey = "basicTypingLayoutSettings";
  const pageMin = 760, sideMin = 220, sideMax = 480, mainMin = 480, dividerWidth = 12;
  const controllers = new WeakMap();
  const draggingDocuments = new WeakMap();

  function clamp(value, min, max) { return Math.min(Math.max(value, min), Math.max(min, max)); }
  function defaults() { return { version: 1, pageWidth: null, sideWidth: 300 }; }

  function readSettings(win) {
    const result = defaults();
    try {
      const saved = JSON.parse(win.localStorage.getItem(storageKey));
      if (!saved || saved.version !== 1) return result;
      if (saved.pageWidth === null || (Number.isFinite(saved.pageWidth) && saved.pageWidth >= pageMin)) {
        result.pageWidth = saved.pageWidth === null ? null : Math.round(saved.pageWidth);
      }
      if (Number.isFinite(saved.sideWidth) && saved.sideWidth >= sideMin && saved.sideWidth <= sideMax) {
        result.sideWidth = Math.round(saved.sideWidth);
      }
    } catch (_) { /* Layout remains usable when browser storage is unavailable. */ }
    return result;
  }

  function startDragging(doc) {
    const previous = draggingDocuments.get(doc);
    if (previous) { previous.count += 1; return; }
    draggingDocuments.set(doc, { count: 1, existed: doc.body.classList.contains("practice-layout-dragging") });
    doc.body.classList.add("practice-layout-dragging");
  }

  function stopDragging(doc) {
    const previous = draggingDocuments.get(doc);
    if (!previous || --previous.count > 0) return;
    doc.body.classList.toggle("practice-layout-dragging", previous.existed);
    draggingDocuments.delete(doc);
  }

  function create(elements) {
    const { shell, grid, main, side, toolbarHost } = elements || {};
    if (!shell || !grid || !main || !side || !toolbarHost) return { destroy() {} };
    controllers.get(shell)?.destroy();
    const doc = shell.ownerDocument, win = doc.defaultView;
    if (!win) return { destroy() {} };

    let settings = readSettings(win);
    let destroyed = false, frame = null, drag = null, observer = null;
    let metrics = null;
    const removers = [];
    const classes = ["practice-layout", "layout-desktop", "layout-stacked", "layout-compact", "layout-small"];
    const originalClasses = new Map(classes.map(name => [name, shell.classList.contains(name)]));
    const styleNames = ["--practice-layout-width", "--practice-side-width"];
    const originalStyles = new Map(styleNames.map(name => [name, {
      value: shell.style.getPropertyValue(name), priority: shell.style.getPropertyPriority(name)
    }]));
    const requestFrame = win.requestAnimationFrame
      ? callback => win.requestAnimationFrame(callback)
      : callback => win.setTimeout(callback, 16);
    const cancelFrame = win.cancelAnimationFrame
      ? id => win.cancelAnimationFrame(id)
      : id => win.clearTimeout(id);

    function listen(target, type, callback, options) {
      target.addEventListener(type, callback, options);
      removers.push(() => target.removeEventListener(type, callback, options));
    }

    function separator(kind, label) {
      const handle = doc.createElement("div");
      handle.className = kind === "split" ? "layout-divider" : `layout-edge layout-edge-${kind}`;
      handle.dataset.layoutHandle = kind;
      handle.tabIndex = 0;
      handle.setAttribute("role", "separator");
      handle.setAttribute("aria-orientation", "vertical");
      handle.setAttribute("aria-label", label);
      handle.title = `${label}：拖动或使用左右方向键`;
      listen(handle, "pointerdown", event => beginDrag(event, kind, handle));
      listen(handle, "keydown", event => handleKey(event, kind));
      listen(handle, "lostpointercapture", event => {
        if (drag && event.pointerId === drag.pointerId) endDrag(false);
      });
      return handle;
    }

    const left = separator("left", "调整页面左侧宽度");
    const right = separator("right", "调整页面右侧宽度");
    const divider = separator("split", "调整错题本宽度");
    const toolbar = doc.createElement("div");
    toolbar.className = "layout-tools";
    const hint = doc.createElement("span");
    hint.textContent = "拖动页面两侧或中间分隔线调整宽度";
    const reset = doc.createElement("button");
    reset.type = "button";
    reset.dataset.layoutReset = "";
    reset.textContent = "恢复默认布局";
    toolbar.append(hint, reset);
    shell.classList.add("practice-layout");
    shell.append(left, right);
    grid.insertBefore(divider, side);
    toolbarHost.append(toolbar);

    function save() {
      try { win.localStorage.setItem(storageKey, JSON.stringify(settings)); } catch (_) { /* In-memory settings still apply. */ }
    }

    function setStyle(name, value) {
      if (shell.style.getPropertyValue(name) !== value) shell.style.setProperty(name, value);
    }

    function setAttribute(element, name, value) {
      const text = String(value);
      if (element.getAttribute(name) !== text) element.setAttribute(name, text);
    }

    function updateHandle(handle, hidden, min, max, value, unit) {
      if (handle.hidden !== hidden) handle.hidden = hidden;
      handle.tabIndex = hidden ? -1 : 0;
      setAttribute(handle, "aria-disabled", hidden);
      setAttribute(handle, "aria-valuemin", Math.round(min));
      setAttribute(handle, "aria-valuemax", Math.round(max));
      setAttribute(handle, "aria-valuenow", Math.round(value));
      setAttribute(handle, "aria-valuetext", `${unit} ${Math.round(value)} 像素`);
    }

    function render() {
      if (destroyed) return;
      const viewport = doc.documentElement.clientWidth || win.innerWidth || pageMin;
      const desktop = viewport > 920;
      const available = Math.max(1, viewport - (desktop ? 32 : 20));
      const width = desktop ? clamp(settings.pageWidth ?? available, pageMin, available) : available;
      setStyle("--practice-layout-width", `${Math.round(width)}px`);
      const shellWidth = shell.getBoundingClientRect().width || width;
      // The static practice grid is hidden until its question bank has loaded.
      const gridWidth = grid.clientWidth || grid.getBoundingClientRect().width || shellWidth;
      const stacked = gridWidth < 920;
      const maxSide = Math.max(sideMin, Math.min(sideMax, gridWidth - mainMin - dividerWidth));
      const sideWidth = clamp(settings.sideWidth, sideMin, maxSide);
      setStyle("--practice-side-width", `${Math.round(sideWidth)}px`);
      shell.classList.toggle("layout-desktop", desktop);
      shell.classList.toggle("layout-stacked", stacked);
      shell.classList.toggle("layout-compact", shellWidth < 1100);
      shell.classList.toggle("layout-small", shellWidth <= pageMin);
      metrics = { desktop, available, width: shellWidth, stacked, maxSide, sideWidth };
      updateHandle(left, !desktop, Math.min(pageMin, available), available, shellWidth, "页面宽度");
      updateHandle(right, !desktop, Math.min(pageMin, available), available, shellWidth, "页面宽度");
      updateHandle(divider, !desktop || stacked, sideMin, maxSide, sideWidth, "错题本宽度");
      if (drag && (!desktop || (drag.kind === "split" && stacked))) endDrag(false);
    }

    function schedule() {
      if (destroyed || frame !== null) return;
      frame = requestFrame(() => { frame = null; render(); });
    }

    function beginDrag(event, kind, handle) {
      if (destroyed || drag || event.button !== 0 || event.isPrimary === false) return;
      render();
      if (!metrics.desktop || (kind === "split" && metrics.stacked)) return;
      event.preventDefault();
      event.stopPropagation();
      drag = {
        kind, handle, pointerId: event.pointerId, startX: event.clientX,
        pageWidth: metrics.width, sideWidth: metrics.sideWidth,
        previous: { ...settings }, moved: false
      };
      startDragging(doc);
      try { handle.setPointerCapture(event.pointerId); } catch (_) { /* Window listeners also cover browsers without pointer capture. */ }
    }

    function moveDrag(event) {
      if (!drag || event.pointerId !== drag.pointerId || !Number.isFinite(event.clientX)) return;
      const distance = event.clientX - drag.startX;
      if (!distance && !drag.moved) return;
      drag.moved = true;
      if (drag.kind === "split") {
        settings.sideWidth = Math.round(clamp(drag.sideWidth - distance, sideMin, metrics.maxSide));
      } else {
        const direction = drag.kind === "right" ? 1 : -1;
        settings.pageWidth = Math.round(clamp(drag.pageWidth + direction * distance * 2, pageMin, metrics.available));
      }
      if (event.cancelable) event.preventDefault();
      schedule();
    }

    function endDrag(commit) {
      if (!drag) return;
      const finished = drag;
      drag = null;
      if (!commit) settings = finished.previous;
      else if (finished.moved) save();
      try {
        if (finished.handle.hasPointerCapture(finished.pointerId)) finished.handle.releasePointerCapture(finished.pointerId);
      } catch (_) { /* Capture may already have ended when the pointer was cancelled. */ }
      stopDragging(doc);
      schedule();
    }

    function handleKey(event, kind) {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      render();
      if (!metrics.desktop || (kind === "split" && metrics.stacked)) return;
      event.preventDefault();
      event.stopPropagation();
      endDrag(false);
      const step = event.key === "ArrowRight" ? 16 : -16;
      if (kind === "split") settings.sideWidth = Math.round(clamp(metrics.sideWidth - step, sideMin, metrics.maxSide));
      else settings.pageWidth = Math.round(clamp(metrics.width + (kind === "right" ? step : -step), pageMin, metrics.available));
      save();
      render();
    }

    listen(win, "pointermove", moveDrag, { passive: false });
    listen(win, "pointerup", event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      moveDrag(event);
      endDrag(true);
    });
    listen(win, "pointercancel", event => {
      if (drag && event.pointerId === drag.pointerId) endDrag(false);
    });
    listen(win, "blur", () => endDrag(false));
    listen(win, "keydown", event => {
      if (event.key !== "Escape" || !drag) return;
      event.preventDefault();
      event.stopPropagation();
      endDrag(false);
    });
    listen(win, "resize", () => { endDrag(false); schedule(); });
    listen(reset, "click", () => {
      endDrag(false);
      settings = defaults();
      save();
      render();
    });
    if (typeof win.ResizeObserver === "function") {
      observer = new win.ResizeObserver(schedule);
      observer.observe(shell);
      observer.observe(grid);
    }
    if (doc.fonts?.ready) doc.fonts.ready.then(schedule, () => {});

    const controller = {
      destroy() {
        if (destroyed) return;
        destroyed = true;
        endDrag(false);
        if (frame !== null) { cancelFrame(frame); frame = null; }
        observer?.disconnect();
        removers.forEach(remove => remove());
        [left, right, divider, toolbar].forEach(element => element.remove());
        originalClasses.forEach((present, name) => shell.classList.toggle(name, present));
        originalStyles.forEach(({ value, priority }, name) => {
          if (value) shell.style.setProperty(name, value, priority);
          else shell.style.removeProperty(name);
        });
        if (controllers.get(shell) === controller) controllers.delete(shell);
      }
    };
    controllers.set(shell, controller);
    render();
    return controller;
  }

  const api = { create };
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.PracticeLayout = api;
})(typeof window !== "undefined" ? window : typeof globalThis !== "undefined" ? globalThis : this);
