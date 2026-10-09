export type MarkdownImportKind = "word" | "sentence";

export interface MarkdownImportGroup {
  groupId: string;
  row: number;
  title: string;
  kind: MarkdownImportKind;
}

export interface MarkdownImportRow {
  row: number;
  groupId: string;
  english: string;
  meaning: string;
  pronunciation: string;
}

export interface MarkdownImportIssue {
  row: number;
  field?: string;
  message: string;
}

export interface MarkdownImportResult {
  groups: MarkdownImportGroup[];
  rows: MarkdownImportRow[];
  errors: MarkdownImportIssue[];
  warnings: MarkdownImportIssue[];
  /** Number of non-empty, non-record lines ignored, not a character count. */
  ignoredCount: number;
}

export interface MarkdownImportOptions {
  fileName?: string;
  defaultCategoryName?: string;
}

const MAX_BYTES = 1024 * 1024;
const MAX_ROWS = 5000;

function withoutOrdinal(title: string): string {
  return title.normalize("NFKC").trim()
    .replace(/^(?:第\s*[一二三四五六七八九十百千万零〇两\d]+\s*(?:部分|章|节)|[一二三四五六七八九十百千万零〇两\d]+\s*[.、)）．]|[（(][一二三四五六七八九十百千万零〇两\d]+[)）])\s*/, "");
}

function explicitKind(title: string): MarkdownImportKind | undefined {
  const value = withoutOrdinal(title);
  if (/^单词(?:\s*[:：]|\s+|$)/.test(value)) return "word";
  if (/^句型(?:\s*[:：]|\s+|$)/.test(value)) return "sentence";
  return undefined;
}

/** This is also used when matching existing category display names. */
export function normalizeMarkdownCategoryTitle(title: string): string {
  return withoutOrdinal(title)
    .replace(/^(?:单词|句型)(?:\s*[:：]\s*|\s+|$)/, "")
    .replace(/\s+(?:\d+\s*个|\d+\s*条)\s*$/, "")
    .replace(/\s+/g, " ").trim();
}

function unwrap(value: string): string {
  const text = value.trim();
  if ((text.startsWith("**") && text.endsWith("**") && text.length >= 4)
    || (text.startsWith("__") && text.endsWith("__") && text.length >= 4)) return text.slice(2, -2).trim();
  if (text.startsWith("`") && text.endsWith("`") && text.length >= 2) return text.slice(1, -1).trim();
  return text;
}

/** Only Markdown's escaped pipe/backslash are decoded. No HTML parser is used. */
function splitCells(line: string): string[] {
  const source = line.trim();
  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]!;
    const next = source[index + 1];
    if (character === "\\" && (next === "|" || next === "\\")) {
      cell += next;
      index += 1;
    } else if (character === "|") {
      cells.push(cell.trim());
      cell = "";
    } else cell += character;
  }
  cells.push(cell.trim());
  if (source.startsWith("|")) cells.shift();
  // The scanner, unlike a regexp on the last character, distinguishes \| from \\|.
  if (cells.at(-1) === "" && source.endsWith("|")) cells.pop();
  return cells;
}

function isSeparator(cells: string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.replace(/\s/g, "")));
}

type Column = "english" | "meaning" | "pronunciation" | "stableId";

function columnName(value: string): Column | undefined {
  const name = unwrap(value).normalize("NFKC").toLowerCase().replace(/\s+/g, "");
  if (["英文", "英语", "英文答案", "english", "english/中文谐音", "英文/中文谐音"].includes(name)) return "english";
  if (["中文", "中文释义", "中文翻译", "chinese", "meaning"].includes(name)) return "meaning";
  if (["中文谐音", "谐音", "pronunciation"].includes(name)) return "pronunciation";
  if (["stableid", "stable_id"].includes(name)) return "stableId";
  return undefined;
}

function englishCell(value: string): { english: string; pronunciation: string } {
  const segments = value.split(/<br\s*\/?\s*>/i);
  const english: string[] = [];
  const pronunciation: string[] = [];
  for (const segment of segments) {
    const match = segment.trim().match(/^(?:中文谐音|谐音)\s*[:：]\s*(.*)$/);
    if (match) pronunciation.push(match[1]!.trim());
    else english.push(segment.trim());
  }
  return { english: unwrap(english.join(" ")), pronunciation: pronunciation.join(" ") };
}

/**
 * Restricted, line-oriented importer. It never renders Markdown, executes HTML,
 * resolves links, reads a file, or derives translations/pronunciations.
 */
export function parseMarkdownImport(markdown: string, options: MarkdownImportOptions = {}): MarkdownImportResult {
  const result: MarkdownImportResult = { groups: [], rows: [], errors: [], warnings: [], ignoredCount: 0 };
  const error = (row: number, field: string, message: string): void => { result.errors.push({ row, field, message }); };
  if (Buffer.byteLength(markdown, "utf8") > MAX_BYTES) {
    error(1, "markdown", "Markdown 文件不能超过 1 MiB。");
    return result;
  }
  const lines = markdown.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  type Heading = { row: number; text: string };
  let firstTitle: Heading | undefined;
  let currentHeading: Heading | undefined;
  let pending: MarkdownImportRow | undefined;
  let pendingSeen = new Set<string>();
  let table: { columns: Array<Column | undefined>; row: number; valid: boolean } | undefined;
  let fence: { character: string; length: number } | undefined;
  let candidates = 0;
  let stopped = false;
  const groupKinds = new Map<string, { explicit: boolean; conflict: boolean }>();
  const groups = new Map<string, MarkdownImportGroup>();

  function group(row: number, inferredKind: MarkdownImportKind): MarkdownImportGroup {
    const heading = currentHeading ?? firstTitle;
    const groupId = currentHeading ? `group-${currentHeading.row}` : "group-0";
    const filename = options.fileName?.replace(/\\/g, "/").split("/").at(-1)?.replace(/\.(?:md|markdown)$/i, "").trim();
    const rawTitle = heading?.text ?? (filename || options.defaultCategoryName || "");
    const kind = explicitKind(rawTitle);
    let existing = groups.get(groupId);
    if (!existing) {
      existing = { groupId, row: currentHeading?.row ?? firstTitle?.row ?? 0, title: normalizeMarkdownCategoryTitle(rawTitle), kind: kind ?? inferredKind };
      groups.set(groupId, existing);
      result.groups.push(existing);
      groupKinds.set(groupId, { explicit: kind !== undefined, conflict: false });
      if (!existing.title) error(row, "category", "没有可用的分类标题，请填写分类名或添加一级、二级标题。");
    } else {
      const state = groupKinds.get(groupId)!;
      if (!state.explicit && existing.kind !== inferredKind && !state.conflict) {
        error(row, "kind", `分类“${existing.title}”混合了单词列表和句型格式，请在标题中明确“单词：”或“句型：”，或拆分分类。`);
        state.conflict = true;
      }
    }
    return existing;
  }

  function flush(): void {
    if (!pending) return;
    for (const [field, label, maximum] of [["english", "英文", 500], ["meaning", "中文释义", 1000], ["pronunciation", "中文谐音", 500]] as const) {
      const value = pending[field];
      if (!value && field !== "pronunciation") error(pending.row, field, `${label}不能为空。`);
      if (value.length > maximum) error(pending.row, field, `${label}不能超过 ${maximum} 个字符。`);
    }
    if (!pending.pronunciation) result.warnings.push({ row: pending.row, field: "pronunciation", message: "未提供中文谐音，将保留为空，不自动生成。" });
    pending = undefined;
    pendingSeen = new Set();
  }

  function countCandidate(row: number): boolean {
    candidates += 1;
    if (candidates <= MAX_ROWS) return true;
    error(row, "markdown", "每次最多导入 5000 条题目，请拆分文件。");
    stopped = true;
    return false;
  }

  function begin(row: number, kind: MarkdownImportKind, english: string, meaning = "", pronunciation = ""): void {
    flush();
    if (!countCandidate(row)) return;
    const target = group(row, kind);
    pending = { row, groupId: target.groupId, english: english.trim(), meaning: meaning.trim(), pronunciation: pronunciation.trim() };
    result.rows.push(pending);
    pendingSeen = new Set([...(meaning ? ["meaning"] : []), ...(pronunciation ? ["pronunciation"] : [])]);
  }

  for (let index = 0; index < lines.length && !stopped; index += 1) {
    const row = index + 1;
    const source = lines[index]!;
    const line = source.trim();
    // With the Unicode flag, paired surrogate code points are not matched by
    // this range, while lone surrogates are rejected without ES2024 helpers.
    if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uFFFD\uD800-\uDFFF]/u.test(source)) {
      error(row, "markdown", "文件包含乱码、无效 UTF-8 或控制字符，请使用 UTF-8 编码保存。");
    }
    if (!line) continue;
    const fenceMatch = line.match(/^(`{3,}|~{3,})/);
    if (fence) {
      result.ignoredCount += 1;
      if (fenceMatch && fenceMatch[1]![0] === fence.character && fenceMatch[1]!.length >= fence.length
        && line.slice(fenceMatch[1]!.length).trim() === "") fence = undefined;
      continue;
    }
    if (fenceMatch) {
      flush();
      table = undefined;
      fence = { character: fenceMatch[1]![0]!, length: fenceMatch[1]!.length };
      result.ignoredCount += 1;
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
    if (heading) {
      flush();
      table = undefined;
      const depth = heading[1]!.length;
      if (depth === 1 && !firstTitle) firstTitle = { row, text: heading[2]! };
      else if (depth === 2) currentHeading = { row, text: heading[2]! };
      // Tertiary headings label items, never create categories.
      continue;
    }

    const cells = splitCells(line);
    const nextCells = splitCells(lines[index + 1] ?? "");
    const hasPipe = cells.length > 1 || line.startsWith("|");
    const namedColumns = cells.map(columnName);
    const looksLikeHeader = hasPipe && (isSeparator(nextCells) || (!table && namedColumns.some((column) => column === "english" || column === "meaning")));
    if (looksLikeHeader) {
      flush();
      const unique = new Set<Column>();
      let valid = true;
      for (const column of namedColumns) {
        if (column && unique.has(column)) { error(row, "header", "表格列名重复，请每个字段只保留一列。"); valid = false; }
        if (column) unique.add(column);
      }
      if (!unique.has("english") || !unique.has("meaning")) {
        error(row, "header", "表格必须包含“英文”和“中文释义”列（也支持 English、中文、Chinese、meaning）。");
        valid = false;
      }
      if (namedColumns.some((column) => column === undefined)) {
        error(row, "header", "表格存在无法识别的列名；请使用英文、中文释义、中文谐音，Stable ID 列会被忽略。");
        valid = false;
      }
      if (!isSeparator(nextCells) || nextCells.length !== cells.length) {
        error(row, "header", "表头后需要与列数一致的 Markdown 分隔行，例如 |---|---|---|。");
        valid = false;
      }
      table = { columns: namedColumns, row, valid };
      if (isSeparator(nextCells)) index += 1;
      continue;
    }
    if (hasPipe && (table || line.startsWith("|") || isSeparator(nextCells))) {
      flush();
      if (isSeparator(cells)) { error(row, "header", "发现没有有效表头的表格分隔行。"); continue; }
      if (!table?.valid) {
        countCandidate(row);
        error(row, "header", "这行表格没有有效的字段表头，请先修正表头。");
        continue;
      }
      if (cells.length !== table.columns.length) error(row, "columns", `表格应有 ${table.columns.length} 列，当前为 ${cells.length} 列；内容中的竖线请写成 \\|。`);
      const cellFor = (name: Column): string => cells[table!.columns.indexOf(name)] ?? "";
      const values = englishCell(cellFor("english"));
      const pronunciation = unwrap(cellFor("pronunciation"));
      if (pronunciation && values.pronunciation && pronunciation !== values.pronunciation) error(row, "pronunciation", "独立谐音列与英文单元格内的谐音不一致，请只保留一种或改为相同内容。");
      begin(row, "sentence", values.english, unwrap(cellFor("meaning")), pronunciation || values.pronunciation);
      flush();
      continue;
    }
    table = undefined;

    const metadata = line.match(/^(?:[-*+]\s+)?(?:\*\*)?(中文释义|中文翻译|中文|中文谐音|谐音)(?:\*\*)?\s*[:：]\s*(.*)$/);
    if (metadata) {
      const field = metadata[1]!.includes("谐音") ? "pronunciation" : "meaning";
      if (!pending) error(row, field, "该释义或谐音前没有对应的英文题目。");
      else if (pendingSeen.has(field)) error(row, field, "同一道题重复提供了该字段，请合并为一行。");
      else { pending[field] = metadata[2]!.trim(); pendingSeen.add(field); }
      continue;
    }
    if (/^(?:[-*+]\s+)?(?:\*\*)?(?:中文释义|中文翻译|中文谐音|谐音|中文)(?:\*\*)?(?:\s|$)/.test(line)) {
      error(row, "format", "释义和谐音字段后需要冒号，例如 中文：你好 或 谐音：哈喽。");
      continue;
    }
    if (/^[-*+]\s+\*\*/.test(line)) {
      const word = line.match(/^[-*+]\s+\*\*(.*?)\*\*\s*[:：]\s*(.*)$/);
      if (!word) {
        flush();
        if (countCandidate(row)) { group(row, "word"); error(row, "format", "单词列表格式应为 - **英文**：中文释义，谐音另起一行。"); }
      } else begin(row, "word", word[1]!, word[2]!);
      continue;
    }
    if (line.startsWith("**")) {
      const paragraph = line.match(/^\*\*(.*?)\*\*$/);
      if (!paragraph) {
        flush();
        if (countCandidate(row)) { group(row, "sentence"); error(row, "format", "段落题目应单独一行写 **英文**，中文释义和谐音另起一行。"); }
      } else begin(row, "sentence", paragraph[1]!);
      continue;
    }
    result.ignoredCount += 1;
  }
  flush();
  if (result.rows.length === 0 && result.errors.length === 0) error(1, "markdown", "没有识别到题目，请使用 Markdown 模板中的表格、单词列表或英文段落格式。");
  return result;
}
