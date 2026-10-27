/* Shared, dependency-free eight-second product demo. No audio or user data. */
(function (root) {
  "use strict";

  const duration = 8000;
  let sequence = 0;

  function markup(id) {
    return `
      <section class="practice-promo" role="button" tabindex="0" aria-label="暂停演示" aria-describedby="${id}-description">
        <p id="${id}-description" class="promo-sr-only">打字时，英文词组通过箭头连接对应中文。Would like 合译为愿意，you 对应你。中文谐音可辅助记忆，例如 memory，记忆，谐音梅默伊。谐音帮助记忆，发音请听朗读。此演示无声音，点击画面或按空格、回车可暂停、继续，结束后可重播。</p>
        <div class="promo-view" aria-hidden="true">
          <div class="promo-light promo-light-one"></div><div class="promo-light promo-light-two"></div>
          <div class="promo-scene promo-hook" data-promo-scene="hook">
            <div class="promo-eyebrow">从看见，到记住</div>
            <div class="promo-headline">让英文，<br>和中文<span class="promo-gradient">连起来。</span></div>
            <div class="promo-hook-link"><span>English</span><svg viewBox="0 0 128 34"><path d="M2 17H118m-11-9 11 9-11 9"/></svg><span>中文</span></div>
          </div>
          <div class="promo-scene promo-arrows" data-promo-scene="arrows">
            <div class="promo-scene-heading"><span class="promo-scene-index">01</span><div><div class="promo-eyebrow">中文箭头联想</div><h2>打到哪里，意思跟到哪里。</h2></div></div>
            <div class="promo-demo-surface">
              <svg class="promo-diagram" viewBox="0 0 680 212" preserveAspectRatio="xMidYMid meet">
                <defs><marker id="${id}-arrow" markerWidth="7" markerHeight="7" refX="5.5" refY="3.5" orient="auto"><path d="M0 0L7 3.5L0 7Z" fill="context-stroke"/></marker></defs>
                <g class="promo-links" fill="none" stroke-width="2" marker-end="url(#${id}-arrow)">
                  <path data-promo-group="wish" pathLength="1" d="M78 61C78 104 93 111 93 151"/>
                  <path data-promo-group="wish" pathLength="1" d="M78 61C78 112 320 107 320 151"/>
                  <path data-promo-group="wish" pathLength="1" d="M232 61C232 111 106 104 106 151"/>
                  <path data-promo-group="wish" pathLength="1" d="M232 61C232 109 332 110 332 151"/>
                  <path data-promo-group="you" pathLength="1" d="M166 61C166 108 41 108 41 151"/>
                  <path pathLength="1" d="M286 61C286 110 152 108 152 151"/>
                  <path pathLength="1" d="M383 61C383 114 170 108 170 151"/>
                  <path pathLength="1" d="M542 61C542 112 243 108 243 151"/>
                </g>
                <g class="promo-english" font-size="32" font-weight="650">
                  <text x="28" y="43" data-promo-group="wish">Would</text><text x="139" y="43" data-promo-group="you">you</text><text x="207" y="43" data-promo-group="wish">like</text><text x="271" y="43">to</text><text x="310" y="43">exchange</text><text x="468" y="43">numbers?</text>
                </g>
                <g class="promo-chinese" font-size="29">
                  <text x="27" y="188" data-promo-group="you">你</text><text x="65" y="188" data-promo-group="wish">愿意</text><text x="128" y="188">交换</text><text x="191" y="188">电话号码</text><text x="309" y="188" data-promo-group="wish">吗</text><text x="343" y="188">？</text>
                </g>
              </svg>
              <div class="promo-demo-input"><span class="promo-input-label">正在输入</span><span class="promo-input-value" data-promo-input> would</span><span class="promo-caret"></span><span class="promo-keycap">↵</span></div>
            </div>
            <p class="promo-group-note" data-promo-note>Would … like → 愿意……吗</p>
          </div>
          <div class="promo-scene promo-mnemonic" data-promo-scene="mnemonic">
            <div class="promo-eyebrow"><span class="promo-scene-index">02</span> 中文谐音助记</div>
            <div class="promo-memory-word">memory<span class="promo-memory-dot">.</span></div>
            <div class="promo-memory-meaning">记忆</div>
            <div class="promo-memory-clue"><span>中文谐音</span><strong>梅默伊</strong><svg viewBox="0 0 36 24"><path d="M3 11v2m6-7v12m6-16v20m6-13v6m6-11v16m6-10v4"/></svg></div>
            <p class="promo-memory-note">谐音帮助记忆，发音请听朗读。</p>
          </div>
          <div class="promo-scene promo-finish" data-promo-scene="finish">
            <div class="promo-eyebrow">英语打字练习</div>
            <div class="promo-finish-title">看懂。记住。<br><span class="promo-gradient">打出来。</span></div>
            <div class="promo-feature-list"><span>箭头联想</span><span>谐音助记</span><span>逐句练习</span></div>
            <p class="promo-finish-note">把每一次输入，变成一次记忆。</p>
          </div>
        </div>
      </section>`;
  }

  function create(host) {
    const id = `practice-promo-${++sequence}`;
    host.innerHTML = markup(id);
    host.classList.add("practice-promo-host");
    host.dataset.promoDuration = String(duration);
    const view = host.querySelector(".practice-promo");
    const input = host.querySelector("[data-promo-input]");
    const note = host.querySelector("[data-promo-note]");
    const groupNodes = [...host.querySelectorAll("[data-promo-group]")];
    const media = root.matchMedia?.("(prefers-reduced-motion: reduce)");
    let reduced = !!media?.matches;
    let elapsed = reduced ? duration : 0;
    let requested = !reduced;
    let visible = typeof IntersectionObserver === "undefined";
    let running = false;
    let destroyed = false;
    let frame = null;
    let lastTime = 0;
    let lastStage = "";
    let lastGroup = "";
    let lastStatus = "";
    const typing = [[0, "w"], [160, "wo"], [320, "wou"], [480, "woul"], [640, "would"], [1550, "would "], [1750, "would y"], [1950, "would yo"], [2150, "would you"], [2800, "would you "]];

    function render() {
      const stage = elapsed < 1200 ? "hook" : elapsed < 4600 ? "arrows" : elapsed < 6500 ? "mnemonic" : "finish";
      if (lastStage !== stage) {
        host.dataset.promoStage = view.dataset.stage = stage;
        lastStage = stage;
      }
      host.dataset.promoElapsed = String(Math.round(elapsed));
      host.dataset.promoReducedMotion = String(reduced);
      const status = elapsed >= duration ? "finished" : running ? "playing" : elapsed === 0 && requested ? "ready" : "paused";
      if (lastStatus !== status) {
        host.dataset.promoStatus = view.dataset.status = status;
        const label = status === "playing" ? "暂停" : status === "finished" ? "重播" : elapsed > 0 ? "继续" : "播放";
        view.setAttribute("aria-label", label + "演示");
        lastStatus = status;
      }
      view.style.setProperty("--promo-float", `${Math.sin(elapsed / 1600) * 16}px`);
      if (stage === "arrows") {
        const local = elapsed - 1200;
        const text = typing.reduce((value, step) => local >= step[0] ? step[1] : value, "");
        if (input.textContent !== text) input.textContent = text;
        const group = local >= 1550 && local < 2800 ? "you" : "wish";
        if (lastGroup !== group) {
          host.dataset.promoGroup = view.dataset.group = group;
          groupNodes.forEach(node => node.classList.toggle("is-active", node.dataset.promoGroup === group));
          note.textContent = group === "wish" ? "Would … like → 愿意……吗 · 词组整体理解" : "you → 你 · 跟着输入，理解每个词";
          lastGroup = group;
        }
        view.style.setProperty("--promo-line-progress", String(Math.max(0, 1 - local / 500)));
      }
    }

    function stopFrame() {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
      running = false;
    }

    function tick(now) {
      frame = null;
      if (destroyed || !running) return;
      elapsed = Math.min(duration, elapsed + Math.max(0, now - lastTime));
      lastTime = now;
      if (elapsed >= duration) {
        requested = false;
        running = false;
      }
      render();
      if (running) frame = requestAnimationFrame(tick);
    }

    function reconcile() {
      if (destroyed) return;
      const shouldRun = requested && visible && !document.hidden && elapsed < duration && host.isConnected;
      if (shouldRun && !running) {
        running = true;
        lastTime = performance.now();
        frame = requestAnimationFrame(tick);
      } else if (!shouldRun && running) {
        // Count only visible playback time; background tabs never skip a scene.
        stopFrame();
      }
      render();
    }

    function play() {
      if (destroyed) return;
      if (elapsed >= duration) elapsed = 0;
      requested = true;
      reconcile();
    }

    function pause() {
      if (destroyed) return;
      requested = false;
      reconcile();
    }

    function onToggle() { if (running || requested && elapsed < duration) pause(); else play(); }
    function onKeyDown(event) {
      if (event.key !== " " && event.key !== "Enter") return;
      event.preventDefault();
      if (!event.repeat) onToggle();
    }
    function onMotionChange() {
      reduced = !!media?.matches;
      if (reduced) { elapsed = duration; requested = false; }
      reconcile();
    }
    view.addEventListener("click", onToggle);
    view.addEventListener("keydown", onKeyDown);
    document.addEventListener("visibilitychange", reconcile);
    media?.addEventListener?.("change", onMotionChange);
    const observer = typeof IntersectionObserver !== "undefined" ? new IntersectionObserver(entries => {
      visible = entries.some(entry => entry.isIntersecting && entry.intersectionRatio > 0);
      reconcile();
    }, { threshold: [0, 0.1] }) : null;
    observer?.observe(host);
    reconcile();

    return {
      play,
      pause,
      destroy() {
        if (destroyed) return;
        destroyed = true;
        requested = false;
        stopFrame();
        observer?.disconnect();
        view.removeEventListener("click", onToggle);
        view.removeEventListener("keydown", onKeyDown);
        document.removeEventListener("visibilitychange", reconcile);
        media?.removeEventListener?.("change", onMotionChange);
        host.dataset.promoStatus = "destroyed";
      }
    };
  }

  const api = { create, duration };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.PracticePromo = api;
})(globalThis);
