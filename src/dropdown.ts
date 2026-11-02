// Phorge's dropdown menus (PHUIXDropdownMenu with an action list), with
// their markup so Phorge's CSS styles them. One is open at a time; it
// closes on a click elsewhere, Escape and scrolling.

import css from "./dropdown.css";
import { addStyle } from "./style";

export interface DropdownItem {
  label: string;
  icon?: string;
  selected?: boolean;
  disabled?: boolean;
  run?: () => void;
  /** A heading for the items below it. */
  heading?: boolean;
  /** Shown at the right, dimmed: e.g. a shortcut. */
  detail?: string;
}

export const DIVIDER: DropdownItem = { label: "" };

let styled = false;

let open: HTMLElement | null = null;
let openOwner: Element | null = null;

/** Closes the open menu, or only the one an element opened; false if none was open. */
export function closeDropdown(owner?: Element): boolean {
  if (!open || (owner && owner !== openOwner)) {
    return false;
  }
  open.remove();
  open = null;
  openOwner = null;
  return true;
}

/**
 * Shows a menu of items at a point of the window: its top left, or with
 * alignRight its top right. The owner is the button that opened it, if any
 * (see showDropdownContent).
 */
export function showDropdown(
  x: number,
  y: number,
  entries: DropdownItem[],
  className = "",
  alignRight = false,
  owner?: Element,
): HTMLElement {
  const list = document.createElement("ul");
  list.className = "phabricator-action-list-view";
  for (const item of entries) {
    const li = document.createElement("li");
    li.className = "phabricator-action-view";
    if (item === DIVIDER) {
      li.classList.add("phabricator-action-view-type-divider");
    } else if (item.heading) {
      li.classList.add("phabricator-action-view-label", "phabricator-action-view-type-label");
      const label = document.createElement("span");
      label.className = "phabricator-action-view-item";
      label.textContent = item.label;
      li.append(label);
    } else {
      li.classList.add("action-has-icon", "phabricator-action-view-href");
      li.classList.toggle("phabricator-action-view-selected", !!item.selected);
      li.classList.toggle("phabricator-action-view-disabled", !!item.disabled);
      const icon = document.createElement("span");
      icon.className = `phui-icon-view phabricator-action-view-icon phui-font-fa ${item.icon}${item.disabled ? " grey" : ""}`;
      const link = document.createElement("a");
      link.className = "phabricator-action-view-item";
      link.href = "#";
      link.textContent = item.label;
      if (item.detail) {
        const detail = document.createElement("span");
        detail.className = "rme-dropdown-detail";
        detail.textContent = item.detail;
        link.append(detail);
      }
      link.addEventListener("click", (event) => {
        event.preventDefault();
        if (!item.disabled) {
          closeDropdown();
          item.run?.();
        }
      });
      li.append(icon, link);
    }
    list.append(li);
  }
  return showDropdownContent(x, y, list, className, alignRight, owner);
}

/**
 * Shows a dropdown menu with any content at a point of the window. With an
 * owner, the button that opened it, a press on it does not close the menu
 * (its button closes it, see closeDropdown), and it stays open while the
 * page scrolls, which moves both; else any scrolling closes it.
 */
export function showDropdownContent(
  x: number,
  y: number,
  content: HTMLElement,
  className = "",
  alignRight = false,
  owner?: Element,
): HTMLElement {
  closeDropdown();
  if (!styled) {
    addStyle(css);
    styled = true;
  }
  const menu = document.createElement("div");
  menu.className = `phuix-dropdown-menu rme-dropdown ${className}`.trim();
  menu.append(content);
  // Keep the focus where it is.
  menu.addEventListener("mousedown", (event) => event.preventDefault());
  menu.style.position = "absolute";
  menu.style.left = `${x + window.scrollX}px`;
  menu.style.top = `${y + window.scrollY}px`;
  document.body.append(menu);
  if (alignRight) {
    x = Math.max(0, x - menu.getBoundingClientRect().width);
    menu.style.left = `${x + window.scrollX}px`;
  }
  // Keep it on the screen.
  const rect = menu.getBoundingClientRect();
  if (rect.bottom > window.innerHeight) {
    menu.style.top = `${Math.max(0, y - rect.height) + window.scrollY}px`;
  }
  if (rect.right > window.innerWidth) {
    menu.style.left = `${Math.max(0, x - rect.width) + window.scrollX}px`;
  }
  open = menu;
  openOwner = owner ?? null;
  return menu;
}

document.addEventListener(
  "mousedown",
  (event) => {
    const target = event.target as Node;
    if (open && !open.contains(target) && !openOwner?.contains(target)) {
      closeDropdown();
    }
  },
  true,
);
window.addEventListener(
  "scroll",
  (event) => {
    if (!openOwner || (event.target instanceof Element && event.target.contains(openOwner))) {
      closeDropdown();
    }
  },
  true,
);
// Before Phorge, which takes Escape to leave its fullscreen editor.
window.addEventListener(
  "keydown",
  (event) => {
    if (event.key === "Escape" && closeDropdown()) {
      event.preventDefault();
      event.stopPropagation();
    }
  },
  true,
);
