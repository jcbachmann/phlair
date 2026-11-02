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
  const frame = item.querySelector(":scope > .phui-oi-frame > .phui-oi-frame-content");
  if (!frame) {
    return false;
  }
  let actions = frame.querySelector(":scope > .phui-oi-actions");
  if (!actions) {
    actions = document.createElement("ul");
    actions.className = "phui-oi-actions";
    frame.prepend(actions);
  }
  const count = actions.children.length;
  item.classList.remove(`phui-oi-with-${count}-actions`);
  item.classList.add("phui-oi-with-actions", `phui-oi-with-${count + 1}-actions`);

  const action = document.createElement("li");
  action.className = "phui-list-item-view phui-list-item-type-link phui-list-item-has-icon phuture-action";
  const link = document.createElement("a");
  link.className = "phui-list-item-href";
  link.href = "#";
  link.setAttribute("role", "button");
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
    link.setAttribute("aria-label", link.title);
  }
  const count = menuButton.querySelector(".phabricator-main-menu-alert-count")!;
  count.textContent = String(snoozed);
  menuButton.classList.toggle("alert-unread", snoozed > 0 && !show);
  menuButton.setAttribute(
    "aria-label",
    `${snoozed} snoozed item${snoozed === 1 ? "" : "s"} on this page, ${show ? "shown" : "hidden"}`,
  );
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
    run: () => snooze(key, target),
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
    entries.push(DIVIDER, { label: "Wake up now", icon: "fa-bell-o", run: () => snooze(key, null) });
  }
  const rect = button.getBoundingClientRect();
  showDropdown(rect.right, rect.bottom, entries, "phuture-menu", true, button);
}

function snooze(key: string, day: Day | null): void {
  setSnooze(key, day);
  update();
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
      snooze(key, input.value);
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
