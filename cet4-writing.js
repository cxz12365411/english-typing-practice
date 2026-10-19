/* Shared CET-4 content and full-essay preview for both practice sites. */
(function (root) {
  "use strict";
  function text(value) { return typeof value === "string" && value.trim().length > 0; }
  function wordCount(value) { return (value.match(/[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*/g) || []).length; }

  function parse(data) {
    if (!data || data.version !== 1 || !Array.isArray(data.essays) || data.essays.length !== 10
      || !Array.isArray(data.expressionGroups) || data.expressionGroups.length !== 4) {
      throw new Error("Invalid CET-4 writing resource");
    }
    const categories = [], items = [], keys = new Set(), slugs = new Set();
    function addCategory(group, essay) {
      if (!text(group.id) || !/^cet4-[a-z0-9-]+$/.test(group.id) || slugs.has(group.id) || !text(group.title)) {
        throw new Error("Invalid CET-4 category");
      }
      slugs.add(group.id);
      const category = { slug: group.id, name: `${essay ? "四级作文" : "四级句型"}：${group.title}`, kind: "sentence", sortOrder: 100 + categories.length };
      categories.push(category);
      let sentences;
      let keyPrefix;
      if (essay) {
        if (!/^cet4-essay-(?:0[1-9]|10)$/.test(group.id)) throw new Error("Invalid essay ID");
        keyPrefix = `cet4-e${group.id.slice(-2)}-s`;
        if (!text(group.titleEnglish) || !text(group.prompt) || !Array.isArray(group.outline) || !group.outline.length
          || group.outline.some(note => !text(note)) || !Array.isArray(group.paragraphs) || !group.paragraphs.length
          || group.paragraphs.some(paragraph => !Array.isArray(paragraph) || !paragraph.length)) throw new Error("Invalid CET-4 essay");
        for (const frame of [group.greeting, group.closing]) {
          if (frame && (!text(frame.english) || !text(frame.meaning))) throw new Error("Invalid essay greeting or closing");
        }
        sentences = group.paragraphs.flat();
      } else {
        const groups = { opening: "开头引入", argument: "观点论证", transition: "衔接转折", conclusion: "总结建议" };
        const suffix = group.id.replace(/^cet4-phrases-/, "");
        if (groups[suffix] !== group.title || !Array.isArray(group.items) || group.items.length !== 10) throw new Error("Invalid expression group");
        keyPrefix = `cet4-${suffix}-`;
        sentences = group.items;
      }
      if (!Array.isArray(sentences) || !sentences.length) throw new Error("Empty CET-4 category");
      sentences.forEach((sentence, index) => {
        if (!sentence || !text(sentence.key) || !/^cet4-[a-z0-9-]+$/.test(sentence.key) || keys.has(sentence.key)
          || !text(sentence.english) || !text(sentence.meaning)) throw new Error("Invalid CET-4 sentence");
        const suffix = sentence.key.slice(keyPrefix.length);
        if (!sentence.key.startsWith(keyPrefix) || !/^\d{2,}$/.test(suffix) || Number(suffix) <= 0) throw new Error("Invalid stable sentence ID");
        keys.add(sentence.key);
        items.push({ key: sentence.key, english: sentence.english, meaning: sentence.meaning, categorySlug: category.slug,
          kind: "sentence", pronunciation: "", sortOrder: index + 1 });
      });
      if (essay) {
        const count = wordCount(sentences.map(sentence => sentence.english).join(" "));
        if (count < 120 || count > 180) throw new Error("Essay body must contain 120–180 words");
      }
    }
    data.essays.forEach(essay => addCategory(essay, true));
    data.expressionGroups.forEach(group => addCategory(group, false));
    return { essays: data.essays, categories, items };
  }

  function matchesEssay(essay, items) {
    const expected = essay.paragraphs.flat();
    const actual = items.filter(item => item.categorySlug === essay.id);
    if (actual.length !== expected.length) return false;
    return expected.every(sentence => {
      const matches = actual.filter(item => item.key === sentence.key);
      return matches.length === 1 && matches[0].kind === "sentence"
        && matches[0].english === sentence.english && matches[0].meaning === sentence.meaning;
    });
  }

  function node(tag, className, value) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (value !== undefined) element.textContent = value;
    return element;
  }

  class Preview {
    constructor(container) {
      this.container = container;
      this.data = null;
      this.essay = null;
      this.details = null;
      this.valid = false;
      this.position = node("p", "cet4-position");
      this.unavailable = node("p", "cet4-unavailable", "全文资料暂不可用，仍可逐句练习。");
      container.replaceChildren(this.position, this.unavailable);
      container.hidden = true;
    }
    setData(data) { this.data = parse(data); }
    build(essay) {
      const details = node("details", "cet4-preview");
      details.append(node("summary", "", "查看全文"));
      const body = node("div", "cet4-body");
      body.append(node("h3", "", essay.titleEnglish));
      body.append(node("p", "cet4-source", `原创参考范文 · 正文 ${wordCount(essay.paragraphs.flat().map(item => item.english).join(" "))} 词`));
      body.append(node("h4", "", "题目要求"), node("p", "cet4-prompt", essay.prompt));
      body.append(node("h4", "", "写作思路"));
      const outline = node("ol", "cet4-outline");
      essay.outline.forEach(note => outline.append(node("li", "", note)));
      body.append(outline, node("h4", "", "英文与中文对照"));
      function frame(value) {
        if (!value) return;
        const english = node("p", "cet4-english", value.english);
        english.lang = "en";
        const chinese = node("p", "cet4-chinese", value.meaning);
        chinese.lang = "zh-CN";
        body.append(english, chinese);
      }
      frame(essay.greeting);
      essay.paragraphs.forEach((paragraph, index) => {
        const block = node("section", "cet4-paragraph");
        block.setAttribute("aria-label", `第 ${index + 1} 段`);
        const english = node("p", "cet4-english"), chinese = node("p", "cet4-chinese");
        english.lang = "en"; chinese.lang = "zh-CN";
        paragraph.forEach((sentence, sentenceIndex) => {
          if (sentenceIndex) english.append(document.createTextNode(" "));
          for (const [parent, value] of [[english, sentence.english], [chinese, sentence.meaning]]) {
            const span = node("span", "cet4-sentence", value);
            span.dataset.cet4Key = sentence.key;
            parent.append(span);
          }
        });
        block.append(english, chinese); body.append(block);
      });
      frame(essay.closing);
      details.append(body);
      return details;
    }
    render(item, items, showEnglish) {
      const essay = this.data?.essays.find(candidate => candidate.id === item?.categorySlug
        || candidate.paragraphs.some(paragraph => paragraph.some(sentence => sentence.key === item?.key)));
      if (!essay) {
        if (this.details) this.details.open = false;
        this.essay = null;
        this.container.hidden = !item?.key?.startsWith("cet4-e");
        this.position.textContent = "";
        this.unavailable.hidden = this.container.hidden;
        if (this.details) this.details.hidden = true;
        return;
      }
      const valid = matchesEssay(essay, items);
      if (essay !== this.essay || valid !== this.valid) {
        this.details?.remove();
        this.details = valid ? this.build(essay) : null;
        if (this.details) this.container.append(this.details);
        this.essay = essay;
        this.valid = valid;
      }
      const sentences = essay.paragraphs.flat();
      const sentenceIndex = sentences.findIndex(sentence => sentence.key === item?.key);
      const paragraphIndex = essay.paragraphs.findIndex(paragraph => paragraph.some(sentence => sentence.key === item?.key));
      this.position.textContent = valid && sentenceIndex >= 0
        ? `${essay.title} · 第 ${paragraphIndex + 1} 段 · 第 ${sentenceIndex + 1} / ${sentences.length} 句`
        : "四级作文";
      this.container.hidden = false;
      this.unavailable.hidden = valid;
      if (!this.details) return;
      this.details.hidden = !showEnglish;
      if (!showEnglish) this.details.open = false;
      this.details.querySelectorAll("[data-cet4-key]").forEach(span => {
        const current = span.dataset.cet4Key === item?.key;
        span.classList.toggle("is-current", current);
        if (current) span.setAttribute("aria-current", "true");
        else span.removeAttribute("aria-current");
      });
    }
    destroy() { this.container.replaceChildren(); this.container.hidden = true; this.data = null; }
  }
  const api = { parse, wordCount, matchesEssay, create: container => new Preview(container) };
  const commonJS = typeof module !== "undefined" && module.exports;
  if (commonJS) module.exports = api;
  if (!commonJS || typeof window !== "undefined") root.Cet4Writing = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
