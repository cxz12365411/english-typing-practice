/* Shared writing content and full-essay preview for both practice sites. */
(function (root) {
  "use strict";
  function text(value) { return typeof value === "string" && value.trim().length > 0; }
  function wordCount(value) { return (value.match(/[A-Za-z0-9]+(?:['’\-][A-Za-z0-9]+)*/g) || []).length; }

  function bilingual(value) { return text(value?.english) && text(value?.meaning); }
  function gaokaoLabel(essay) { return essay.type === "continuation" ? "高考读后续写" : "高考应用文"; }
  function graduateLabel(essay) {
    return `考研英语${essay.track === "one" ? "一" : "二"}·${essay.type === "short" ? "小" : "大"}作文`;
  }

  function parseGraduate(data) {
    const fail = field => { throw new Error(`Invalid graduate writing resource: ${field}`); };
    if (data.version !== 1 || data.sourceLabel !== "原创模拟题与参考范文"
      || !Array.isArray(data.essays) || data.essays.length !== 8) fail("essay list");
    const categories = [], items = [], englishTexts = new Set();
    data.essays.forEach((essay, index) => {
      const number = String(index + 1).padStart(2, "0");
      const slug = `grad-essay-${number}`;
      const firstTrack = index < 4;
      const short = index % 4 < 2;
      if (essay?.id !== slug || essay.track !== (firstTrack ? "one" : "two") || essay.type !== (short ? "short" : "long")
        || !text(essay.title) || !text(essay.titleEnglish) || !text(essay.prompt)
        || !Array.isArray(essay.outline) || !essay.outline.length || !essay.outline.every(text)
        || !Array.isArray(essay.paragraphs) || !essay.paragraphs.length
        || essay.paragraphs.some(paragraph => !Array.isArray(paragraph) || !paragraph.length)) fail(slug);
      if ([essay.greeting, essay.closing].some(frame => frame !== undefined && !bilingual(frame))) fail(`${slug} framing`);
      const material = essay.material;
      if (short) {
        if (material !== undefined) fail(`${slug} short writing material`);
      } else if (firstTrack) {
        if (material?.kind !== "picture" || !bilingual(material)) fail(`${slug} picture`);
      } else if (material?.kind !== "table" || !text(material.caption)
          || !Array.isArray(material.columns) || material.columns.length < 2 || !material.columns.every(text)
          || !Array.isArray(material.rows) || !material.rows.length || material.rows.some(row =>
            !Array.isArray(row) || row.length !== material.columns.length || !row.every(text))) {
        fail(`${slug} table`);
      }
      const sentences = essay.paragraphs.flat();
      const count = wordCount(sentences.map(sentence => sentence?.english ?? "").join(" "));
      const [min, max] = short ? [90, 115] : firstTrack ? [160, 200] : [140, 165];
      if (sentences.length !== (short ? 6 : 9) || count < min || count > max) fail(`${slug} length`);
      categories.push({ slug, name: `${graduateLabel(essay)}：${essay.title}`, kind: "sentence", sortOrder: 320 + index });
      sentences.forEach((sentence, offset) => {
        const key = `grad-e${number}-s${String(offset + 1).padStart(2, "0")}`;
        if (!bilingual(sentence) || sentence.key !== key || englishTexts.has(sentence.english)) fail(key);
        englishTexts.add(sentence.english);
        items.push({ key, english: sentence.english, meaning: sentence.meaning, categorySlug: slug,
          kind: "sentence", pronunciation: "", sortOrder: offset + 1 });
      });
    });
    return { essays: data.essays, categories, items };
  }

  function parseGaokao(data) {
    const fail = field => { throw new Error(`Invalid Gaokao writing resource: ${field}`); };
    if (data.version !== 1 || data.sourceLabel !== "原创模拟题与参考范文"
      || !Array.isArray(data.essays) || data.essays.length !== 10) fail("essay list");
    const categories = [], items = [], englishTexts = new Set();
    data.essays.forEach((essay, index) => {
      const number = String(index + 1).padStart(2, "0");
      const slug = `gaokao-essay-${number}`;
      const continuation = index >= 6;
      const type = continuation ? "continuation" : "application";
      if (essay?.id !== slug || essay.type !== type || !text(essay.title) || !text(essay.titleEnglish)
        || !text(essay.prompt) || !Array.isArray(essay.outline) || !essay.outline.length
        || !essay.outline.every(text) || !Array.isArray(essay.paragraphs) || !essay.paragraphs.length
        || essay.paragraphs.some(paragraph => !Array.isArray(paragraph) || !paragraph.length)) fail(slug);
      if ([essay.greeting, essay.closing].some(frame => frame !== undefined && !bilingual(frame))) fail(`${slug} framing`);
      const starts = new Set();
      if (continuation) {
        if (!text(essay.reading?.english) || !text(essay.reading?.summary)
          || wordCount(essay.reading.english) < 200 || wordCount(essay.reading.english) > 300
          || essay.paragraphs.length !== 2 || essay.paragraphs.some(paragraph => paragraph.length !== 5)
          || !Array.isArray(essay.paragraphStarts) || essay.paragraphStarts.length !== 2
          || !essay.paragraphStarts.every(bilingual)) fail(`${slug} continuation material`);
        essay.paragraphStarts.forEach(start => starts.add(start.english));
        if (starts.size !== 2) fail(`${slug} paragraph starts`);
      } else if (essay.reading !== undefined || essay.paragraphStarts !== undefined) fail(`${slug} application material`);
      const sentences = essay.paragraphs.flat();
      const count = wordCount(sentences.map(sentence => sentence?.english ?? "").join(" "));
      if (sentences.length !== (continuation ? 10 : 6)
        || count < (continuation ? 140 : 75) || count > (continuation ? 160 : 95)) fail(`${slug} length`);
      categories.push({ slug, name: `${gaokaoLabel(essay)}：${essay.title}`, kind: "sentence", sortOrder: 300 + index });
      sentences.forEach((sentence, offset) => {
        const key = `gaokao-e${number}-s${String(offset + 1).padStart(2, "0")}`;
        if (!bilingual(sentence) || sentence.key !== key || starts.has(sentence.english) || englishTexts.has(sentence.english)) fail(key);
        englishTexts.add(sentence.english);
        items.push({ key, english: sentence.english, meaning: sentence.meaning, categorySlug: slug,
          kind: "sentence", pronunciation: "", sortOrder: offset + 1 });
      });
    });
    return { essays: data.essays, categories, items };
  }

  function parse(data) {
    if (data?.exam === "gaokao") return parseGaokao(data);
    if (data?.exam === "graduate") return parseGraduate(data);
    const advanced = data?.level === 6;
    const prefix = advanced ? "cet6" : "cet4";
    const label = advanced ? "六级" : "四级";
    const essayCount = advanced ? 6 : 10;
    const expressionCount = advanced ? 6 : 10;
    if (!data || data.version !== 1 || !Array.isArray(data.essays) || data.essays.length !== essayCount
      || !Array.isArray(data.expressionGroups) || data.expressionGroups.length !== 4) {
      throw new Error("Invalid CET-4 writing resource");
    }
    const categories = [], items = [], keys = new Set(), slugs = new Set();
    function addCategory(group, essay) {
      if (!text(group.id) || !new RegExp(`^${prefix}-[a-z0-9-]+$`).test(group.id) || slugs.has(group.id) || !text(group.title)) {
        throw new Error("Invalid CET-4 category");
      }
      slugs.add(group.id);
      const category = { slug: group.id, name: `${label}${essay ? "作文" : "句型"}：${group.title}`, kind: "sentence", sortOrder: (advanced ? 200 : 100) + categories.length };
      categories.push(category);
      let sentences;
      let keyPrefix;
      if (essay) {
        if (!new RegExp(`^${prefix}-essay-(?:0[1-9]|10)$`).test(group.id)) throw new Error("Invalid essay ID");
        keyPrefix = `${prefix}-e${group.id.slice(-2)}-s`;
        if (!text(group.titleEnglish) || !text(group.prompt) || !Array.isArray(group.outline) || !group.outline.length
          || group.outline.some(note => !text(note)) || !Array.isArray(group.paragraphs) || !group.paragraphs.length
          || group.paragraphs.some(paragraph => !Array.isArray(paragraph) || !paragraph.length)) throw new Error("Invalid CET-4 essay");
        for (const frame of [group.greeting, group.closing]) {
          if (frame && (!text(frame.english) || !text(frame.meaning))) throw new Error("Invalid essay greeting or closing");
        }
        sentences = group.paragraphs.flat();
      } else {
        const groups = { opening: "开头引入", argument: "观点论证", transition: "衔接转折", conclusion: "总结建议" };
        const suffix = group.id.replace(new RegExp(`^${prefix}-phrases-`), "");
        if (groups[suffix] !== group.title || !Array.isArray(group.items) || group.items.length !== expressionCount) throw new Error("Invalid expression group");
        keyPrefix = `${prefix}-${suffix}-`;
        sentences = group.items;
      }
      if (!Array.isArray(sentences) || !sentences.length) throw new Error("Empty CET-4 category");
      sentences.forEach((sentence, index) => {
        if (!sentence || !text(sentence.key) || !new RegExp(`^${prefix}-[a-z0-9-]+$`).test(sentence.key) || keys.has(sentence.key)
          || !text(sentence.english) || !text(sentence.meaning)) throw new Error("Invalid CET-4 sentence");
        const suffix = sentence.key.slice(keyPrefix.length);
        if (!sentence.key.startsWith(keyPrefix) || !/^\d{2,}$/.test(suffix) || Number(suffix) <= 0) throw new Error("Invalid stable sentence ID");
        keys.add(sentence.key);
        items.push({ key: sentence.key, english: sentence.english, meaning: sentence.meaning, categorySlug: category.slug,
          kind: "sentence", pronunciation: "", sortOrder: index + 1 });
      });
      if (essay) {
        const count = wordCount(sentences.map(sentence => sentence.english).join(" "));
        if (count < (advanced ? 150 : 120) || count > (advanced ? 200 : 180)) throw new Error("Essay body must contain 120–180 words");
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

  function buildMaterialTable(material) {
    const scroll = node("div", "writing-table-scroll");
    scroll.tabIndex = 0;
    scroll.setAttribute("role", "region");
    scroll.setAttribute("aria-label", "题目数据表，可左右滚动");
    const table = node("table", "writing-table");
    table.append(node("caption", "", material.caption));
    const head = table.createTHead().insertRow();
    material.columns.forEach(value => {
      const cell = node("th", "", value);
      cell.scope = "col";
      head.append(cell);
    });
    const tableBody = table.createTBody();
    material.rows.forEach(cells => {
      const row = tableBody.insertRow();
      const header = node("th", "", cells[0]);
      header.scope = "row";
      row.append(header, ...cells.slice(1).map(value => node("td", "", value)));
    });
    scroll.append(table);
    return scroll;
  }

  class Preview {
    constructor(container) {
      this.container = container;
      this.data = null;
      this.essay = null;
      this.details = null;
      this.materials = null;
      this.valid = false;
      this.position = node("p", "cet4-position");
      this.unavailable = node("p", "cet4-unavailable", "全文资料暂不可用，仍可逐句练习。");
      container.replaceChildren(this.position, this.unavailable);
      container.hidden = true;
    }
    setData(data) {
      const parsed = parse(data);
      const prefix = data.exam === "graduate" ? "grad-" : data.exam === "gaokao" ? "gaokao-" : data.level === 6 ? "cet6-" : "cet4-";
      this.data = { ...parsed, essays: [...(this.data?.essays || []).filter(essay => !essay.id.startsWith(prefix)), ...parsed.essays] };
    }
    buildMaterials(essay) {
      const details = node("details", `writing-materials ${essay.id.startsWith("gaokao-") ? "gaokao-materials" : "graduate-materials"}`);
      const body = node("div", "cet4-body");
      body.append(node("p", "cet4-source", "原创模拟题"),
        node("h4", "", "题目要求"), node("p", "cet4-prompt", essay.prompt));
      if (essay.type === "continuation") {
        const reading = node("p", "gaokao-reading", essay.reading.english);
        reading.lang = "en";
        body.append(node("h4", "", "阅读材料"), reading,
          node("h4", "", "中文梗概"), node("p", "", essay.reading.summary),
          node("h4", "", "给定段首句"));
        const starts = node("ol", "cet4-outline");
        essay.paragraphStarts.forEach(start => {
          const item = node("li");
          const english = node("p", "cet4-english", start.english);
          english.lang = "en";
          item.append(english, node("p", "cet4-chinese", start.meaning));
          starts.append(item);
        });
        body.append(starts);
      }
      if (essay.material?.kind === "picture") {
        const english = node("p", "writing-picture", essay.material.english);
        english.lang = "en";
        body.append(node("h4", "", "图画描述"), english, node("p", "writing-picture", essay.material.meaning));
      } else if (essay.material?.kind === "table") {
        body.append(node("h4", "", "图表数据"), buildMaterialTable(essay.material));
      }
      details.append(node("summary", "", "题目与材料"), body);
      return details;
    }
    build(essay) {
      const details = node("details", "cet4-preview");
      details.append(node("summary", "", "查看全文"));
      const body = node("div", "cet4-body");
      const gaokao = essay.id.startsWith("gaokao-");
      const graduate = essay.id.startsWith("grad-");
      body.append(node("h3", "", essay.titleEnglish));
      body.append(node("p", "cet4-source", `原创参考范文 · 正文 ${wordCount(essay.paragraphs.flat().map(item => item.english).join(" "))} 词`));
      if (!gaokao && !graduate) body.append(node("h4", "", "题目要求"), node("p", "cet4-prompt", essay.prompt));
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
        const start = gaokao ? essay.paragraphStarts?.[index] : null;
        if (start) {
          english.append(node("strong", "", start.english), document.createTextNode(" "));
          chinese.append(node("strong", "", start.meaning));
        }
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
        if (this.materials) this.materials.open = false;
        this.essay = null;
        this.container.hidden = !/^(?:cet[46]|gaokao|grad)-e/.test(item?.key || "");
        this.position.textContent = "";
        this.unavailable.hidden = this.container.hidden;
        if (this.details) this.details.hidden = true;
        if (this.materials) this.materials.hidden = true;
        return;
      }
      const valid = matchesEssay(essay, items);
      const gaokao = essay.id.startsWith("gaokao-");
      const graduate = essay.id.startsWith("grad-");
      if (essay !== this.essay || valid !== this.valid) {
        this.details?.remove();
        this.materials?.remove();
        this.materials = valid && (gaokao || graduate) ? this.buildMaterials(essay) : null;
        this.details = valid ? this.build(essay) : null;
        if (this.materials) this.container.append(this.materials);
        if (this.details) this.container.append(this.details);
        this.essay = essay;
        this.valid = valid;
      }
      const sentences = essay.paragraphs.flat();
      const sentenceIndex = sentences.findIndex(sentence => sentence.key === item?.key);
      const paragraphIndex = essay.paragraphs.findIndex(paragraph => paragraph.some(sentence => sentence.key === item?.key));
      this.position.textContent = valid && sentenceIndex >= 0
        ? `${essay.title} · 第 ${paragraphIndex + 1} 段 · 第 ${sentenceIndex + 1} / ${sentences.length} 句`
        : (graduate ? graduateLabel(essay) : gaokao ? gaokaoLabel(essay) : essay.id.startsWith("cet6-") ? "六级作文" : "四级作文");
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
