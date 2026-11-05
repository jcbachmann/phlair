// Phorge's dropdown menus (PHUIXDropdownMenu with an action list), with
// their markup so Phorge's CSS styles them. One is open at a time; it
// closes on a click elsewhere, Escape and scrolling. The focus goes into the
// menu, where the arrow keys move it (like the WAI-ARIA menu pattern), and
// back to where it was when the menu closes.

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
/** Where the focus was when the menu opened. */
let returnFocus: HTMLElement | null = null;

/** Closes the open menu, or only the one an element opened; false if none was open. */
export function closeDropdown(owner?: Element): boolean {
  if (!open || (owner && owner !== openOwner)) {
    return false;
  }
  const hadFocus = open.contains(document.activeElement);
  open.remove();
  openOwner?.setAttribute("aria-expanded", "false");
  open = null;
  openOwner = null;
  if (hadFocus) {
    returnFocus?.focus({ preventScroll: true });
  }
  returnFocus = null;
  return true;
}

/** The items the arrow keys go through. */
function focusable(menu: HTMLElement): HTMLElement[] {
  return Array.from(menu.querySelectorAll<HTMLElement>("a[href]:not([aria-disabled='true'])"));
}

/** The arrow keys, Home and End move the focus through the items; Space runs one, Tab leaves. */
function onMenuKeyDown(event: KeyboardEvent): void {
  const menu = event.currentTarget as HTMLElement;
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) {
    return;
  }
  const items = focusable(menu);
  const at = items.indexOf(document.activeElement as HTMLElement);
  const next = {
    ArrowDown: at + 1,
    ArrowUp: at - 1,
    Home: 0,
    End: items.length - 1,
  }[event.key];
  if (next !== undefined) {
    event.preventDefault();
    items[(next + items.length) % items.length]?.focus({ preventScroll: true });
  } else if (event.key === " " && at >= 0) {
    event.preventDefault();
    items[at].click();
  } else if (event.key === "Tab") {
    // Back where the focus was, and on from there.
    closeDropdown();
  }
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
  list.setAttribute("role", "menu");
  for (const item of entries) {
    const li = document.createElement("li");
    li.className = "phabricator-action-view";
    li.setAttribute("role", "none");
    if (item === DIVIDER) {
      li.classList.add("phabricator-action-view-type-divider");
      li.setAttribute("role", "separator");
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
      // A choice among others (e.g. sizes): checked or not.
      link.setAttribute("role", item.selected === undefined ? "menuitem" : "menuitemradio");
      if (item.selected !== undefined) {
        link.setAttribute("aria-checked", String(item.selected));
      }
      if (item.disabled) {
        link.setAttribute("aria-disabled", "true");
      }
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
  const menu = showDropdownContent(x, y, list, className, alignRight, owner);
  // On the chosen item, if one is.
  menu.querySelector<HTMLElement>("[aria-checked='true']:not([aria-disabled='true'])")?.focus({ preventScroll: true });
  return menu;
}

/** Space kept between a menu and the edges of the window. */
const MARGIN = 8;

/**
 * Places a menu at a point of the window, all of it in the window: below the
 * point, or above it where there is more room, scrolling if it fits on
 * neither side. On phones, in the middle of the window, which it may fill.
 */
function place(menu: HTMLElement, x: number, y: number, alignRight: boolean): void {
  menu.style.overflowY = "auto";
  if (document.body.classList.contains("device-phone")) {
    menu.classList.add("rme-dropdown-centered");
    menu.style.position = "fixed";
    menu.style.maxHeight = `${window.innerHeight - 4 * MARGIN}px`;
    menu.style.maxWidth = `${window.innerWidth - 4 * MARGIN}px`;
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${(window.innerWidth - rect.width) / 2}px`;
    menu.style.top = `${(window.innerHeight - rect.height) / 2}px`;
    return;
  }
  menu.style.position = "absolute";
  menu.style.maxWidth = `${window.innerWidth - 2 * MARGIN}px`;
  const { width, height } = menu.getBoundingClientRect();
  const below = window.innerHeight - y - MARGIN;
  const above = y - MARGIN;
  const onBelow = height <= below || below >= above;
  const room = onBelow ? below : above;
  menu.style.maxHeight = `${room}px`;
  const shown = Math.min(height, room);
  const top = onBelow ? y : y - shown;
  const left = Math.min(Math.max(MARGIN, alignRight ? x - width : x), window.innerWidth - width - MARGIN);
  menu.style.left = `${Math.max(MARGIN, left) + window.scrollX}px`;
  menu.style.top = `${top + window.scrollY}px`;
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
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  if (!styled) {
    addStyle(css);
    styled = true;
  }
  const menu = document.createElement("div");
  menu.className = `phuix-dropdown-menu rme-dropdown ${className}`.trim();
  menu.append(content);
  // Keep the focus where it is.
  menu.addEventListener("mousedown", (event) => event.preventDefault());
  document.body.append(menu);
  place(menu, x, y, alignRight);
  open = menu;
  openOwner = owner ?? null;
  openOwner?.setAttribute("aria-expanded", "true");
  menu.addEventListener("keydown", onMenuKeyDown);
  focusable(menu)[0]?.focus({ preventScroll: true });
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
    // Not the menu scrolling its own items.
    if (event.target instanceof Node && open?.contains(event.target)) {
      return;
    }
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
