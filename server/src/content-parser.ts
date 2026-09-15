export type ContentKind = "word" | "sentence";

export interface ParsedCategory {
  slug: string;
  name: string;
  kind: ContentKind;
  sortOrder: number;
}

export interface ParsedItem {
  key: string;
  categorySlug: string;
  kind: ContentKind;
  english: string;
  meaning: string;
  pronunciation: string;
  sortOrder: number;
}

export interface ParsedContent {
  categories: ParsedCategory[];
  items: ParsedItem[];
}

export function parseWordMarkdown(markdown: string): ParsedContent {
  const categories: ParsedCategory[] = [];
  const items: ParsedItem[] = [];
  let current: ParsedCategory | undefined;
  let pending: ParsedItem | undefined;

  for (const rawLine of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const heading = rawLine.match(/^##\s+\d+\.\s+(.+?)(?:\s+\d+\s*个)?\s*$/);
    if (heading?.[1]) {
      const sortOrder = categories.length + 1;
      current = {
        slug: `words-${sortOrder}`,
        name: `单词：${heading[1].trim()}`,
        kind: "word",
        sortOrder
      };
      categories.push(current);
      pending = undefined;
      continue;
    }

    const entry = rawLine.match(/^-\s+\*\*(.+?)\*\*[：:]\s*(.+)$/);
    if (entry?.[1] && entry[2] && current) {
      pending = {
        key: `word-${String(items.length + 1).padStart(4, "0")}`,
        categorySlug: current.slug,
        kind: "word",
        english: entry[1].trim(),
        meaning: entry[2].trim(),
        pronunciation: "",
        sortOrder: items.filter((item) => item.categorySlug === current!.slug).length + 1
      };
      items.push(pending);
      continue;
    }

    const pronunciation = rawLine.match(/^\s+-\s+中文谐音[：:]\s*(.+)$/);
    if (pronunciation?.[1] && pending) pending.pronunciation = pronunciation[1].trim();
  }

  return { categories, items };
}

export function parseSentenceMarkdown(markdown: string): ParsedContent {
  const categories: ParsedCategory[] = [];
  const items: ParsedItem[] = [];
  const itemKeys = new Set<string>();
  let current: ParsedCategory | undefined;

  for (const rawLine of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    const heading = rawLine.match(/^##\s+\d+\.\s+(.+?)\s*$/);
    if (heading?.[1]) {
      const sortOrder = categories.length + 1;
      current = {
        slug: `sentences-${sortOrder}`,
        name: `句型：${heading[1].trim()}`,
        kind: "sentence",
        sortOrder
      };
      categories.push(current);
      continue;
    }
    if (!current || !rawLine.startsWith("|") || /^\|\s*(?:English|---)/i.test(rawLine)) continue;
    const cells = rawLine.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 2 || !cells[0] || !cells[1]) continue;
    const englishParts = cells[0].split(/<br\s*\/?\s*>/i);
    const english = (englishParts[0] ?? "").trim();
    const pronunciation = (englishParts.slice(1).join(" ").match(/中文谐音[：:]\s*(.+)/)?.[1] ?? "").trim();
    if (!english) continue;
    // Existing two-column files retain their positional keys. A third column
    // lets later additions keep the IDs already used by learning history.
    const key = cells.length >= 3 ? cells[2]! : `sentence-${String(items.length + 1).padStart(4, "0")}`;
    if (!/^sentence-[0-9]{4,}$/.test(key) || /^sentence-0+$/.test(key)) {
      throw new Error(`Invalid sentence item key: ${key}`);
    }
    if (itemKeys.has(key)) throw new Error(`Duplicate sentence item key: ${key}`);
    itemKeys.add(key);
    items.push({
      key,
      categorySlug: current.slug,
      kind: "sentence",
      english,
      meaning: cells[1].trim(),
      pronunciation,
      sortOrder: items.filter((item) => item.categorySlug === current!.slug).length + 1
    });
  }
  return { categories, items };
}
