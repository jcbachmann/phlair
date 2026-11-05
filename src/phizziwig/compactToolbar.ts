// The toolbar on phones: the essential buttons in one row, the others in the
// menu of a "⋯" button (style.css hides them on phones; larger screens have
// all of them). Phorge's own toolbar on phones has few buttons, the editor's
// many, which take two rows.

import { closeDropdown, type DropdownItem, showDropdown } from "../dropdown";
import { buttonIcon, toolbarButton } from "./toolbar";

/** The buttons of the toolbar on phones, by their icons; the others are in the "⋯" menu. */
const ESSENTIAL = new Set([
  "fa-bold",
  "fa-italic",
  "fa-link",
  "fa-list-ul",
  "fa-check-square-o",
  "fa-cloud-upload",
  "fa-arrows-alt",
  "fa-thumb-tack",
]);

/** Whether a toolbar button stays in the toolbar on phones: the essential ones and the editor's switch. */
function essential(button: Element): boolean {
  return button.matches(".rme-toggle, .rme-more") || ESSENTIAL.has(buttonIcon(button) ?? "");
}

/** Marks the buttons of a toolbar that phones show in the "⋯" menu, and adds that button; returns its undoing. */
export function compactToolbar(bar: HTMLElement): () => void {
  const buttons = Array.from(bar.querySelectorAll(".remarkup-assist-button")).filter((button) => !essential(button));
  buttons.forEach((button) => button.classList.add("rme-overflow"));
  const more = toolbarButton({
    title: "More: formatting, tools",
    icon: "fa-ellipsis-h",
    className: "rme-more",
    run: () => {
      if (!closeDropdown(more)) {
        const rect = more.getBoundingClientRect();
        showDropdown(rect.left, rect.bottom + 2, moreItems(bar), "rme-more-menu", false, more);
      }
    },
  });
  more.setAttribute("aria-haspopup", "menu");
  // After the last essential button on the left.
  const left = Array.from(bar.querySelectorAll(".remarkup-assist-button:not(.remarkup-assist-right)"));
  (left.filter(essential).at(-1) ?? bar.firstElementChild)?.after(more);
  return () => {
    more.remove();
    buttons.forEach((button) => button.classList.remove("rme-overflow"));
  };
}

/** The buttons the toolbar does not show, as menu items that click them. */
function moreItems(bar: HTMLElement): DropdownItem[] {
  return Array.from(bar.querySelectorAll<HTMLElement>(".remarkup-assist-button.rme-overflow")).map((button) => ({
    label:
      button.getAttribute("aria-label") ??
      button.querySelector(".aural-only")?.textContent?.trim() ??
      buttonIcon(button) ??
      "",
    icon: buttonIcon(button),
    run: () => button.click(),
  }));
}
