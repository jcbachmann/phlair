// Days as "YYYY-MM-DD" in the browser's time zone. A snooze lasts until its
// day begins there. Comparing these strings compares the days: no times, so
// no time zone or daylight saving time can shift a snooze to another day.

/** A day, "YYYY-MM-DD". */
export type Day = string;

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether the text is a day that exists. */
export function isDay(text: unknown): text is Day {
  const match = typeof text === "string" ? DAY.exec(text) : null;
  if (!match) {
    return false;
  }
  const [year, month, day] = match.slice(1).map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** The day of a moment in the browser's time zone. */
export function dayOf(date: Date): Day {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** The start of a day in the browser's time zone. */
function start(day: Day): Date {
  const [year, month, date] = day.split("-").map(Number);
  return new Date(year, month - 1, date);
}

export function addDays(day: Day, days: number): Day {
  const date = start(day);
  date.setDate(date.getDate() + days);
  return dayOf(date);
}

/** The same day of the next month, or its last day if it has fewer (31 January → 28 or 29 February). */
export function addMonth(day: Day): Day {
  const date = start(day);
  const target = new Date(date.getFullYear(), date.getMonth() + 1, 1);
  const last = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(date.getDate(), last));
  return dayOf(target);
}

/** The next day after this one that is the weekday (0 Sunday … 6 Saturday). */
export function nextWeekday(day: Day, weekday: number): Day {
  return addDays(day, ((weekday - start(day).getDay() + 6) % 7) + 1);
}

/** The days from one day to another, negative if it is before. */
export function daysBetween(from: Day, to: Day): number {
  const utc = (day: Day) => {
    const [year, month, date] = day.split("-").map(Number);
    return Date.UTC(year, month - 1, date);
  };
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

/** The milliseconds from a moment until the next day begins. */
export function untilTomorrow(now: Date): number {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() - now.getTime();
}

/** A day for people: "Mon, Nov 9", with the year if it is not this year's. */
export function formatDay(day: Day, today: Day): string {
  return start(day).toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: day.slice(0, 4) === today.slice(0, 4) ? undefined : "numeric",
  });
}
