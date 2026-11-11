// The snoozes: which item sleeps until which day. Kept in the browser
// (localStorage of the Phorge site), read each time, so a snooze in another
// tab counts too.

import { type Day, isDay } from "./days";

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
      // Keys as itemKey() makes them: an imported file could name another site ("/evil.example").
      if (isDay(day) && itemKey(`/${key}`) === key) {
        snoozes[key] = day;
      }
    }
  }
  return snoozes;
}

/** The snoozes as a file, to take them to another browser. */
export function exportSnoozes(snoozes: Snoozes): string {
  return `${JSON.stringify({ format: EXPORT_FORMAT, snoozes }, null, 2)}\n`;
}

/** The snoozes of an exported file. Throws for anything else. */
export function parseExport(text: string): Snoozes {
  const data: unknown = JSON.parse(text);
  if ((data as { format?: unknown } | null)?.format !== EXPORT_FORMAT) {
    throw new Error("Not an export of snoozes");
  }
  return validSnoozes((data as { snoozes: unknown }).snoozes);
}
