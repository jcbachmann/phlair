// The snoozes: which item sleeps until which day. Kept in the browser
// (localStorage of the Phorge site), read each time, so a snooze in another
// tab counts too.

import { type Day, dayOf, isDay } from "./days";

/** The day each item wakes up, by its key (see itemKey()). */
export type Snoozes = Record<string, Day>;

const KEY = "phuture-snoozes";

/** The format of exported snoozes. */
const EXPORT_FORMAT = "phuture-snoozes";

/**
 * The key of an item: the path of its link on this site, e.g. "T123",
 * "D45" or "w/notes". Null for links to other sites and to the home page.
 */
export function itemKey(href: string): string | null {
  const url = new URL(href, location.href);
  const path = url.pathname.replace(/^\/+|\/+$/g, "");
  return url.origin === location.origin && path ? path : null;
}

/** The snoozes, without those that are no longer valid. */
export function loadSnoozes(): Snoozes {
  try {
    return validSnoozes(JSON.parse(localStorage.getItem(KEY) ?? "{}"));
  } catch {
    return {};
  }
}

export function saveSnoozes(snoozes: Snoozes): void {
  try {
    if (Object.keys(snoozes).length) {
      localStorage.setItem(KEY, JSON.stringify(snoozes));
    } else {
      localStorage.removeItem(KEY);
    }
  } catch (error) {
    // Blocked storage, or full.
    console.warn("Phuture: the snoozes could not be saved", error);
  }
}

/** Whether a stored change is one of the snoozes (for the "storage" event of other tabs). */
export function isSnoozesKey(key: string | null): boolean {
  return key === null || key === KEY;
}

/** Snoozes an item until a day, or wakes it up (null). */
export function setSnooze(key: string, day: Day | null): void {
  const snoozes = loadSnoozes();
  if (day) {
    snoozes[key] = day;
  } else {
    delete snoozes[key];
  }
  saveSnoozes(snoozes);
}

/** Forgets the snoozes that ended (on or before today); true if there were any. */
export function forgetEnded(snoozes: Snoozes, today: Day): boolean {
  let ended = false;
  for (const [key, day] of Object.entries(snoozes)) {
    if (day <= today) {
      delete snoozes[key];
      ended = true;
    }
  }
  return ended;
}

function validSnoozes(value: unknown): Snoozes {
  const snoozes: Snoozes = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, day] of Object.entries(value)) {
      if (isDay(day)) {
        snoozes[key] = day;
      }
    }
  }
  return snoozes;
}

// The snooze plugin before Phlair ("JCB Phabricator Snooze", a userscript and
// browser extension) kept one key per item, the path of its link: tasks,
// revisions and the commits of audits ("T12", "D34", "rXYZ0123abcd"). The
// value is the moment the item woke up as ISO string: the local midnight of
// the day as UTC, or, as picked in its date picker, the UTC midnight of the day.
const OLD_KEY = /^(?:[A-Z]+\d+|r[A-Z]+[0-9a-f]+)$/;
const OLD_MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const OLD_SHOW_KEY = "snooze override show";
/** Set once the old plugin's snoozes were taken over. */
const TAKEN_OVER_KEY = "phuture-took-over-old-snoozes";

/** Whether a stored entry is one of the old plugin's snoozes. */
function isOldSnooze(key: string, value: unknown): value is string {
  return OLD_KEY.test(key) && typeof value === "string" && OLD_MOMENT.test(value);
}

/** The day of a moment the old plugin stored. */
function oldDay(moment: string): Day {
  return moment.endsWith("T00:00:00.000Z") ? moment.slice(0, 10) : dayOf(new Date(moment));
}

/**
 * Takes over the snoozes of the old plugin, which used the same storage, and
 * removes them there; once, so entries of other scripts that only look like
 * them are never touched again. Returns whether it showed snoozed items (its
 * clock button), or null if there was nothing to take over.
 */
export function takeOverOldSnoozes(): boolean | null {
  const snoozes = loadSnoozes();
  const old: string[] = [];
  let show: boolean | null = null;
  try {
    if (localStorage.getItem(TAKEN_OVER_KEY)) {
      return null;
    }
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)!;
      const value = localStorage.getItem(key);
      if (key === OLD_SHOW_KEY) {
        show = value === "true";
        old.push(key);
      } else if (isOldSnooze(key, value)) {
        // A snooze set here since wins.
        snoozes[key] ??= oldDay(value);
        old.push(key);
      }
    }
    localStorage.setItem(TAKEN_OVER_KEY, "1");
  } catch {
    return null;
  }
  if (old.length) {
    saveSnoozes(snoozes);
    old.forEach((key) => localStorage.removeItem(key));
  }
  return show;
}

/** The snoozes as a file, to take them to another browser. */
export function exportSnoozes(snoozes: Snoozes): string {
  return `${JSON.stringify({ format: EXPORT_FORMAT, snoozes }, null, 2)}\n`;
}

/**
 * The snoozes of an exported file: of this format, or of the old plugin's
 * export (all of its storage). Throws for anything else.
 */
export function parseExport(text: string): Snoozes {
  const data: unknown = JSON.parse(text);
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Not an export of snoozes");
  }
  const record = data as Record<string, unknown>;
  if (record.format === EXPORT_FORMAT) {
    return validSnoozes(record.snoozes);
  }
  const snoozes: Snoozes = {};
  for (const [key, value] of Object.entries(record)) {
    if (isOldSnooze(key, value)) {
      snoozes[key] = oldDay(value);
    }
  }
  if (!Object.keys(snoozes).length && Object.keys(record).some((key) => key !== OLD_SHOW_KEY)) {
    throw new Error("Not an export of snoozes");
  }
  return snoozes;
}
