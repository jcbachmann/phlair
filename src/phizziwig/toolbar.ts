// Buttons for Phorge's remarkup toolbar, with the markup of its own
// buttons so its CSS sizes, aligns and colors them the same, in all modes.

import { addTooltip } from "./tooltip";
import { setHtml } from "./html";

export interface ButtonOptions {
  title: string;
  /** A Font Awesome icon like "fa-bold", or SVG markup for a 16×16 icon. */
  icon: string;
  run: () => void;
  className?: string;
}

export function toolbarButton({ title, icon, run, className }: ButtonOptions): HTMLAnchorElement {
  const button = document.createElement("a");
  button.href = "#";
  button.tabIndex = -1;
  button.className = `remarkup-assist-button ${className ?? ""}`.trim();
  button.setAttribute("role", "button");
  addTooltip(button, title);
  const glyph = document.createElement("div");
  glyph.className = "remarkup-assist phui-icon-view phui-font-fa bluegrey";
  if (icon.startsWith("<svg")) {
    // Static markup from this extension's own icon definitions.
    setHtml(glyph, icon);
  } else {
    glyph.classList.add(icon);
  }
  button.append(glyph);
  // Keep the focus where it is: in the editor or in a table cell.
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", (event) => {
    event.preventDefault();
    run();
  });
  return button;
}

/** The Font Awesome icon of a toolbar button, e.g. "fa-bold". */
export function buttonIcon(button: Element): string | undefined {
  return Array.from(button.querySelector(".remarkup-assist")?.classList ?? []).find((c) => c.startsWith("fa-"));
}
