// Phuture: snoozes items of Phorge's lists (dashboards, searches,
// workboards, ...) until a day. A snoozed item is hidden on every list until
// that day begins; the clock in the main menu shows them again.

import { closeDropdown, DIVIDER, type DropdownItem, showDropdown, showDropdownContent } from "../dropdown";
import { storedChoice } from "../storage";
import { addStyle } from "../style";
import { addDays, addMonth, type Day, daysBetween, dayOf, formatDay, isDay, nextWeekday, untilTomorrow } from "./days";
import {
  exportSnoozes,
  forgetEnded,
  isSnoozesKey,
  itemKey,
  loadSnoozes,
  parseExport,
  saveSnoozes,
  setSnooze,
  type Snoozes,
  takeOverOldSnoozes,
} from "./snoozes";
import css from "./style.css";

/** An item of Phorge's object lists (PHUIObjectItemView). */
const ITEM = "li.phui-oi";
const LINK = ".phui-oi-link";

const showChoice = storedChoice("phuture-show-snoozed", "0", ["1", "0"]);

/** The items of the page with a snooze button, by their key. */
const items = new Map<HTMLElement, string>();

let menuButton: HTMLElement;

export function startPhuture(): void {
  const alerts = document.querySelector(".phabricator-main-menu-alerts");
  if (!alerts) {
    // Logged out: nothing to snooze for.
    return;
  }
  addStyle(css);
  const oldShow = takeOverOldSnoozes();
  if (oldShow !== null) {
    showChoice.set(oldShow ? "1" : "0");
  }
  menuButton = addMenuButton(alerts);
  addButtons(document);
  update();

  new MutationObserver((mutations) => {
    let added = false;
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node instanceof Element && !node.closest(".phuture-action")) {
          added = addButtons(node) || added;
        }
      });
    }
    if (added) {
      update();
    }
  }).observe(document.body, { childList: true, subtree: true });

  // Snoozes of other tabs; the day changing while the page was in the background.
  window.addEventListener("storage", (event) => {
    if (isSnoozesKey(event.key)) {
      update();
    }
  });
  // After Phorge's handlers, e.g. Maniphest's "Select All", which stop the click.
  window.addEventListener("click", () => setTimeout(deselectHidden), true);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
      update();
    }
  });
  wakeUpEachDay();
}

/** Updates the page when the next day begins, which wakes up the items snoozed until then. */
function wakeUpEachDay(): void {
  // A second late, so it is surely the next day.
  setTimeout(
    () => {
      update();
      wakeUpEachDay();
    },
    untilTomorrow(new Date()) + 1000,
  );
}

function today(): Day {
  return dayOf(new Date());
}

/** Adds snooze buttons to the items in or at a node; true if there were new ones. */
function addButtons(root: Element | Document): boolean {
  const found = [...root.querySelectorAll<HTMLElement>(ITEM)];
  // The node itself, or a part of an item that Phorge rendered anew.
  const around = root instanceof Element ? root.closest<HTMLElement>(ITEM) : null;
  if (around) {
    found.push(around);
  }
  let added = false;
  for (const item of found) {
    // Clickable items are choices (e.g. "Choose Subtype" of a new task), not objects; so are items in dialogs.
    if (item.matches(".phui-oi-linked-container") || item.closest(".aphront-dialog-view")) {
      continue;
    }
    const href = item.querySelector<HTMLAnchorElement>(LINK)?.href;
    const key = href ? itemKey(href) : null;
    if (key && !items.has(item) && addButton(item, key)) {
      items.set(item, key);
      added = true;
    }
  }
  return added;
}

/**
 * Adds the snooze button to the item's actions, like PHUIObjectItemView
 * renders them (and the class that makes room for them). False for items
 * without the usual structure.
 */
function addButton(item: HTMLElement, key: string): boolean {
  // Items with a menu (e.g. commits, with their audit) have their content in a grid beside the menu.
  const frame = [...item.querySelectorAll(".phui-oi-frame .phui-oi-frame-content")].find(
    (content) => content.closest(ITEM) === item,
  );
  if (!frame) {
    return false;
  }
  let actions = frame.querySelector(":scope > .phui-oi-actions");
  if (!actions) {
    actions = document.createElement("ul");
    actions.className = "phui-oi-actions";
    frame.prepend(actions);
  }
  // Phorge places actions at the right of the item's frame, which in a grid also holds the menu.
  frame.classList.toggle("phuture-frame", !!frame.closest(".fuel-grid-cell"));
  const count = actions.children.length;
  item.classList.remove(`phui-oi-with-${count}-actions`);
  item.classList.add("phui-oi-with-actions", `phui-oi-with-${count + 1}-actions`);

  const action = document.createElement("li");
  action.className = "phui-list-item-view phui-list-item-type-link phui-list-item-has-icon phuture-action";
  const link = document.createElement("a");
  link.className = "phui-list-item-href";
  link.href = "#";
  link.setAttribute("role", "button");
  link.setAttribute("aria-haspopup", "menu");
  link.setAttribute("aria-expanded", "false");
  pressableWithSpace(link);
  // Workboards do not start dragging the card here.
  link.dataset.sigil = "ungrabbable";
  const icon = document.createElement("span");
  icon.className = "visual-only phui-icon-view phui-font-fa fa-clock-o phui-list-item-icon";
  icon.setAttribute("aria-hidden", "true");
  const days = document.createElement("span");
  days.className = "phuture-days";
  link.append(icon, days);
  link.addEventListener("click", (event) => {
    event.preventDefault();
    // Some lists open the item on a click anywhere on it.
    event.stopPropagation();
    if (!closeDropdown(link)) {
      showItemMenu(link, key);
    }
  });
  action.append(link);
  actions.append(action);
  return true;
}

/** A link that is a button: Space presses it too, like Enter. */
function pressableWithSpace(link: HTMLElement): void {
  link.addEventListener("keydown", (event) => {
    if (event.key === " ") {
      event.preventDefault();
      link.click();
    }
  });
}

/** Shows or hides the items by their snoozes, and counts them in the main menu. */
function update(): void {
  const now = today();
  const snoozes = loadSnoozes();
  if (forgetEnded(snoozes, now)) {
    saveSnoozes(snoozes);
  }
  const show = showChoice.get() === "1";
  document.documentElement.classList.toggle("phuture-show", show);
  let snoozed = 0;
  for (const [item, key] of items) {
    if (!item.isConnected) {
      items.delete(item);
      continue;
    }
    const link = item.querySelector<HTMLElement>(".phuture-action > a");
    const days = link?.querySelector<HTMLElement>(".phuture-days");
    if (!link || !days) {
      // Phorge rendered the item's actions anew: the next change of the page adds the button again.
      items.delete(item);
      continue;
    }
    const day = snoozes[key];
    item.classList.toggle("phuture-snoozed", !!day);
    if (day) {
      snoozed++;
      const left = daysBetween(now, day);
      days.textContent = `+${left}`;
      // From red (wakes up tomorrow) to blue (in two weeks or later).
      link.style.setProperty("--phuture-hue", String(Math.min(200, ((left - 1) * 200) / 13)));
      link.title = `Snoozed until ${formatDay(day, now)}`;
    } else {
      days.textContent = "";
      link.title = "Snooze";
    }
    // Which item, for screen readers: the page has a button on each.
    const name = item.querySelector(LINK)?.textContent?.trim();
    link.setAttribute("aria-label", name ? `${link.title}: ${name}` : link.title);
  }
  updateListNotes(show);
  deselectHidden();
  const count = menuButton.querySelector(".phabricator-main-menu-alert-count")!;
  count.textContent = String(snoozed);
  // Not in the style of unread notifications: nothing new to see.
  menuButton.classList.toggle("phuture-has-hidden", snoozed > 0 && !show);
  menuButton.setAttribute(
    "aria-label",
    `${snoozed} snoozed item${snoozed === 1 ? "" : "s"} on this page, ${show ? "shown" : "hidden"}`,
  );
}

/** Below each list with snoozed items: how many, with a link that shows or hides them. */
function updateListNotes(show: boolean): void {
  const lists = new Map<Element, number>();
  for (const item of items.keys()) {
    if (item.classList.contains("phuture-snoozed") && item.parentElement) {
      lists.set(item.parentElement, (lists.get(item.parentElement) ?? 0) + 1);
    }
  }
  for (const note of Array.from(document.querySelectorAll(".phuture-list-note"))) {
    if (!note.previousElementSibling || !lists.has(note.previousElementSibling)) {
      note.remove();
    }
  }
  for (const [list, snoozed] of lists) {
    const text = `${snoozed} snoozed item${snoozed === 1 ? "" : "s"} ${show ? "shown" : "hidden"} · `;
    let note = list.nextElementSibling;
    if (!note?.classList.contains("phuture-list-note")) {
      note = document.createElement("div");
      note.className = "phuture-list-note";
      list.after(note);
    } else if (note.firstChild?.textContent === text) {
      continue;
    }
    const toggle = document.createElement("a");
    toggle.href = "#";
    toggle.textContent = show ? "Hide" : "Show";
    toggle.addEventListener("click", (event) => {
      event.preventDefault();
      showChoice.set(show ? "0" : "1");
      update();
    });
    note.replaceChildren(text, toggle);
  }
}

/**
 * Hidden snoozed items are not part of a bulk edit: Maniphest's "Select All"
 * selects them too. Its batch selector unselects a task on Shift+click.
 */
function deselectHidden(): void {
  if (showChoice.get() === "1") {
    return;
  }
  for (const item of Array.from(document.querySelectorAll<HTMLElement>("li.phuture-snoozed.phui-oi-selected"))) {
    item.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey: true }));
  }
}

/** The menu of an item's snooze button: until when, or wake it up. */
function showItemMenu(button: HTMLElement, key: string): void {
  const now = today();
  const day = loadSnoozes()[key];
  const until = (label: string, target: Day): DropdownItem => ({
    label,
    icon: "fa-clock-o",
    detail: formatDay(target, now),
    selected: target === day,
    run: () => snooze(key, target, true),
  });
  const tomorrow = addDays(now, 1);
  const week = addDays(now, 7);
  const monday = nextWeekday(now, 1);
  const entries: DropdownItem[] = [
    { label: day ? `Snoozed until ${formatDay(day, now)}` : "Snooze until", heading: true },
    until("Tomorrow", tomorrow),
    // Not on Sundays and Mondays, when it is tomorrow or in a week.
    ...(monday === tomorrow || monday === week ? [] : [until("Monday", monday)]),
    until("In a week", week),
    until("In a month", addMonth(now)),
    { label: "Pick a day…", icon: "fa-calendar", run: () => pickDay(button, key, day ?? tomorrow) },
  ];
  if (day) {
    entries.push(DIVIDER, { label: "Wake up now", icon: "fa-bell-o", run: () => snooze(key, null, true) });
  }
  const rect = button.getBoundingClientRect();
  showDropdown(rect.right, rect.bottom, entries, "phuture-menu", true, button);
}

/** Snoozes an item until a day, or wakes it up (null); with a note that can undo it. */
function snooze(key: string, day: Day | null, undoable = false): void {
  const before = loadSnoozes()[key] ?? null;
  setSnooze(key, day);
  update();
  if (undoable) {
    showNote(day ? `Snoozed until ${formatDay(day, today())}.` : "Woken up.", () => snooze(key, before));
  }
}

let note: HTMLElement | null = null;

/** A note at the bottom of the window for a while, like Phorge's notifications, with an Undo link. */
function showNote(text: string, undo: () => void): void {
  note?.remove();
  const shown = document.createElement("div");
  shown.className = "phuture-toast";
  shown.setAttribute("role", "status");
  const link = document.createElement("a");
  link.href = "#";
  link.textContent = "Undo";
  link.addEventListener("click", (event) => {
    event.preventDefault();
    shown.remove();
    undo();
  });
  shown.append(`${text} `, link);
  document.body.append(shown);
  note = shown;
  setTimeout(() => shown.remove(), 10_000);
}

/** Opens the browser's date picker at the button. */
function pickDay(button: HTMLElement, key: string, initial: Day): void {
  const input = document.createElement("input");
  input.type = "date";
  input.className = "phuture-date";
  input.min = addDays(today(), 1);
  input.value = initial;
  const rect = button.getBoundingClientRect();
  input.style.left = `${rect.left + window.scrollX}px`;
  input.style.top = `${rect.bottom + window.scrollY}px`;
  document.body.append(input);
  const done = () => input.remove();
  input.addEventListener("change", () => {
    if (isDay(input.value) && input.value >= input.min) {
      snooze(key, input.value, true);
    }
    done();
  });
  input.addEventListener("cancel", done);
  input.addEventListener("blur", done);
  input.focus();
  input.showPicker();
}

/** The clock in the main menu, next to the notifications: counts the snoozed items of the page and has their menu. */
function addMenuButton(alerts: Element): HTMLElement {
  const button = document.createElement("a");
  button.className = "alert-notifications phuture-menu-button";
  button.href = "#";
  button.setAttribute("role", "button");
  button.setAttribute("aria-haspopup", "menu");
  button.setAttribute("aria-expanded", "false");
  pressableWithSpace(button);
  const icon = document.createElement("span");
  icon.className = "phabricator-main-menu-alert-icon phui-icon-view phui-font-fa fa-clock-o";
  const count = document.createElement("span");
  count.className = "phabricator-main-menu-alert-count";
  button.append(icon, count);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    if (closeDropdown(button)) {
      return;
    }
    const show = showChoice.get() === "1";
    const rect = button.getBoundingClientRect();
    showDropdown(
      rect.right,
      rect.bottom,
      [
        { label: "Phuture", heading: true },
        {
          label: "Show snoozed items",
          icon: show ? "fa-check-square-o" : "fa-square-o",
          run: () => {
            showChoice.set(show ? "0" : "1");
            update();
          },
        },
        ...snoozeList(),
        DIVIDER,
        { label: "Export snoozes", icon: "fa-download", run: download },
        { label: "Import snoozes…", icon: "fa-upload", run: upload },
      ],
      "phuture-menu",
      true,
      button,
    );
  });
  alerts.append(button);
  return button;
}

/** All snoozes, the next to wake up first: names of items on the page, else their paths. */
function snoozeList(): DropdownItem[] {
  const now = today();
  const snoozes = Object.entries(loadSnoozes()).sort(([, a], [, b]) => a.localeCompare(b));
  if (!snoozes.length) {
    return [];
  }
  const names = new Map<string, string>();
  for (const [item, key] of items) {
    const name = item.querySelector(LINK)?.textContent?.trim();
    if (name) {
      names.set(key, name);
    }
  }
  const SHOWN = 15;
  const entries: DropdownItem[] = [DIVIDER, { label: `Snoozed (${snoozes.length})`, heading: true }];
  for (const [key, day] of snoozes.slice(0, SHOWN)) {
    const name = names.get(key);
    const label = name && !name.startsWith(key) && /^[A-Z]\d+$/.test(key) ? `${key} ${name}` : (name ?? key);
    entries.push({
      label: label.length > 50 ? `${label.slice(0, 49)}…` : label,
      icon: "fa-clock-o",
      detail: formatDay(day, now),
      run: () => location.assign(`/${key}`),
    });
  }
  if (snoozes.length > SHOWN) {
    entries.push({ label: `${snoozes.length - SHOWN} more`, icon: "fa-ellipsis-h", disabled: true });
  }
  return entries;
}

function download(): void {
  const link = document.createElement("a");
  link.download = "phuture-snoozes.json";
  link.href = URL.createObjectURL(new Blob([exportSnoozes(loadSnoozes())], { type: "application/json" }));
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}

function upload(): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json,application/json";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) {
      return;
    }
    let message: string;
    try {
      const imported: Snoozes = parseExport(await file.text());
      const snoozes = { ...loadSnoozes(), ...imported };
      forgetEnded(snoozes, today());
      saveSnoozes(snoozes);
      const count = Object.keys(imported).filter((key) => key in snoozes).length;
      message = `Imported ${count} snooze${count === 1 ? "" : "s"}.`;
    } catch {
      message = `${file.name} is no export of snoozes.`;
    }
    update();
    const note = document.createElement("div");
    note.className = "phuture-note";
    note.setAttribute("role", "status");
    note.textContent = message;
    const rect = menuButton.getBoundingClientRect();
    showDropdownContent(rect.right, rect.bottom, note, "phuture-menu", true, menuButton);
  });
  input.click();
}
