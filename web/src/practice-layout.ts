import "../../practice-layout.js";
import "../../practice-layout.css";
import { mustElement } from "./ui";

declare global {
  interface Window {
    PracticeLayout?: {
      create(elements: {
        shell: HTMLElement;
        grid: HTMLElement;
        main: HTMLElement;
        side: HTMLElement;
        toolbarHost: HTMLElement;
      }): { destroy(): void };
    };
  }
}

export function createPracticeLayout() {
  return window.PracticeLayout?.create({
    shell: mustElement<HTMLElement>(".app-shell"),
    grid: mustElement<HTMLElement>(".practice-grid"),
    main: mustElement<HTMLElement>(".practice-main"),
    side: mustElement<HTMLElement>(".practice-side"),
    toolbarHost: mustElement<HTMLElement>("#layoutControls")
  });
}
