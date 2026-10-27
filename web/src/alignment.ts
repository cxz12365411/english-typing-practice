import "../../alignment.js";
import "../../alignment.css";
import alignmentDataUrl from "../../sentence-alignments.json?url";
import type { ContentItem } from "./types";
import { mustElement } from "./ui";

interface AlignmentItem {
  word: string;
  meaning: string;
  kind: ContentItem["kind"];
}

interface AlignmentRenderer {
  bindInput(input: HTMLInputElement): void;
  syncInput(): void;
  setData(data: unknown): void;
  render(item: AlignmentItem | null, options: { enabled: boolean; showEnglish: boolean }): void;
  destroy(): void;
}

declare global {
  interface Window {
    WordAlignment?: {
      create(elements: {
        scroll: HTMLElement;
        stage: HTMLElement;
        english: HTMLElement;
        meaning: HTMLElement;
        svg: SVGSVGElement;
        note: HTMLElement;
      }): AlignmentRenderer;
    };
  }
}

export interface PracticeAlignmentController {
  render(item: ContentItem | null, options: { showEnglish: boolean }): void;
  syncInput(): void;
  destroy(): void;
}

const preferenceKey = "basicTypingAlignmentEnabled";

/** Reuse the static site's renderer and exact text alignments without touching answers or item IDs. */
export function createPracticeAlignment(options: {
  isActive(): boolean;
  onDataReady(): void;
}): PracticeAlignmentController {
  const checkbox = mustElement<HTMLInputElement>("#showAlignment");
  const english = mustElement<HTMLElement>("#targetWord");
  const meaning = mustElement<HTMLElement>("#meaningText");
  const renderer = window.WordAlignment?.create({
    scroll: mustElement<HTMLElement>("#alignmentScroll"),
    stage: mustElement<HTMLElement>("#alignmentStage"),
    english,
    meaning,
    svg: mustElement<SVGSVGElement>("#alignmentArrows"),
    note: mustElement<HTMLElement>("#alignmentNote")
  });
  const abort = new AbortController();
  renderer?.bindInput(mustElement<HTMLInputElement>("#answerInput"));
  let disposed = false;
  const active = () => !disposed && options.isActive();

  try {
    checkbox.checked = localStorage.getItem(preferenceKey) !== "false";
  } catch {
    checkbox.checked = true;
  }
  checkbox.disabled = !renderer;

  const onChange = () => {
    if (!active()) return;
    try {
      localStorage.setItem(preferenceKey, String(checkbox.checked));
    } catch {
      // The setting still works for this visit if browser storage is unavailable.
    }
    options.onDataReady();
  };
  checkbox.addEventListener("change", onChange);

  if (renderer) {
    void fetch(alignmentDataUrl, { signal: abort.signal })
      .then((response) => {
        if (!response.ok) throw new Error("Alignment data unavailable");
        return response.json() as Promise<unknown>;
      })
      .then((data) => {
        if (!active()) return;
        renderer.setData(data);
        // Only the prompt is repainted; a delayed response must preserve the answer.
        options.onDataReady();
      })
      .catch(() => {
        // Plain text remains usable when the asset is unavailable or this page has closed.
      });
  }

  return {
    syncInput() {
      if (active()) renderer?.syncInput();
    },
    render(item, { showEnglish }) {
      if (!active()) return;
      if (renderer) {
        renderer.render(item ? { word: item.english, meaning: item.meaning, kind: item.kind } : null, {
          enabled: checkbox.checked,
          showEnglish
        });
      } else {
        english.textContent = item ? (showEnglish ? item.english : "•".repeat(item.english.length)) : "暂无词条";
        meaning.textContent = item?.meaning || "当前筛选没有可练习的内容。";
      }
    },
    destroy() {
      if (disposed) return;
      disposed = true;
      abort.abort();
      checkbox.removeEventListener("change", onChange);
      renderer?.destroy();
    }
  };
}
