import "../../cet4-writing.js";
import "../../cet4-writing.css";
import writingDataUrl from "../../cet4-writing.json?url";
import type { ContentCategory, ContentItem } from "./types";
import { mustElement } from "./ui";

interface WritingItem {
  key: string;
  english: string;
  meaning: string;
  kind: string;
  categorySlug: string;
}
interface WritingPreview {
  setData(data: unknown): void;
  render(item: WritingItem | null, items: WritingItem[], showEnglish: boolean): void;
  destroy(): void;
}
declare global {
  interface Window { Cet4Writing?: { create(container: HTMLElement): WritingPreview }; }
}

export function createWritingPreview(options: { isActive(): boolean; onDataReady(): void }) {
  const renderer = window.Cet4Writing?.create(mustElement<HTMLElement>("#cet4Writing"));
  const abort = new AbortController();
  let disposed = false;
  if (renderer) {
    void fetch(writingDataUrl, { signal: abort.signal }).then(response => {
      if (!response.ok) throw new Error("CET-4 preview unavailable");
      return response.json() as Promise<unknown>;
    }).then(data => {
      if (disposed || !options.isActive()) return;
      renderer.setData(data);
      options.onDataReady();
    }).catch(() => { /* API practice items remain usable when the preview asset fails. */ });
  }
  return {
    render(item: ContentItem | null, items: ContentItem[], categories: ContentCategory[], showEnglish: boolean) {
      if (disposed || !options.isActive()) return;
      const slugs = new Map(categories.map(category => [category.id, category.slug ?? ""]));
      const normalize = (entry: ContentItem): WritingItem => ({ ...entry, categorySlug: slugs.get(entry.categoryId) ?? "" });
      renderer?.render(item ? normalize(item) : null, items.map(normalize), showEnglish);
    },
    destroy() { disposed = true; abort.abort(); renderer?.destroy(); }
  };
}
