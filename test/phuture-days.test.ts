import { afterEach, describe, expect, it, vi } from "vitest";
import {
  addDays,
  addMonth,
  dayOf,
  daysBetween,
  formatDay,
  isDay,
  nextWeekday,
  untilTomorrow,
} from "../src/phuture/days";

// Days are of the browser's time zone: these run in zones east and west of
// UTC, where the old plugin (UTC and local midnight mixed) got them wrong.
const ZONES = ["Europe/Berlin", "America/New_York", "Pacific/Auckland", "UTC"];

const originalZone = process.env.TZ;
afterEach(() => {
  process.env.TZ = originalZone;
});

describe.each(ZONES)("in %s", (zone) => {
  const inZone = () => {
    process.env.TZ = zone;
  };

  it("takes the day of a moment from the local clock, right after and before midnight", () => {
    inZone();
    expect(dayOf(new Date(2026, 10, 5, 0, 0, 1))).toBe("2026-11-05");
    expect(dayOf(new Date(2026, 10, 5, 0, 30))).toBe("2026-11-05");
    expect(dayOf(new Date(2026, 10, 4, 23, 59, 59))).toBe("2026-11-04");
  });

  it("counts days across the changes of daylight saving time", () => {
    inZone();
    // Europe and the US leave DST in the night to 25 Oct / 1 Nov; New Zealand starts it on 27 Sep.
    expect(addDays("2026-10-24", 1)).toBe("2026-10-25");
    expect(addDays("2026-10-25", 1)).toBe("2026-10-26");
    expect(addDays("2026-10-31", 2)).toBe("2026-11-02");
    expect(addDays("2026-09-26", 2)).toBe("2026-09-28");
    expect(addDays("2026-03-28", 7)).toBe("2026-04-04");
    expect(daysBetween("2026-10-24", "2026-10-26")).toBe(2);
    expect(daysBetween("2026-03-28", "2026-04-04")).toBe(7);
  });

  it("knows when the next day begins, also on a day with 25 hours", () => {
    inZone();
    expect(untilTomorrow(new Date(2026, 10, 4, 23, 30))).toBe(30 * 60_000);
    const start = new Date(2026, 9, 25, 0, 0);
    expect(dayOf(new Date(start.getTime() + untilTomorrow(start)))).toBe("2026-10-26");
  });
});

describe("days", () => {
  it("tells days that exist from other text", () => {
    expect(isDay("2026-11-05")).toBe(true);
    expect(isDay("2028-02-29")).toBe(true);
    expect(isDay("2026-02-29")).toBe(false);
    expect(isDay("2026-13-01")).toBe(false);
    expect(isDay("2026-11-5")).toBe(false);
    expect(isDay("2026-11-05T00:00:00.000Z")).toBe(false);
    expect(isDay(20261105)).toBe(false);
  });

  it("adds a month, keeping the day if the month has it", () => {
    expect(addMonth("2026-11-05")).toBe("2026-12-05");
    expect(addMonth("2026-12-15")).toBe("2027-01-15");
    expect(addMonth("2027-01-31")).toBe("2027-02-28");
    expect(addMonth("2028-01-31")).toBe("2028-02-29");
    expect(addMonth("2026-08-31")).toBe("2026-09-30");
  });

  it("finds the next weekday after a day, never the day itself", () => {
    // 2 November 2026 is a Monday.
    expect(nextWeekday("2026-11-01", 1)).toBe("2026-11-02");
    expect(nextWeekday("2026-11-02", 1)).toBe("2026-11-09");
    expect(nextWeekday("2026-11-08", 1)).toBe("2026-11-09");
    expect(nextWeekday("2026-11-06", 5)).toBe("2026-11-13");
    expect(nextWeekday("2026-11-06", 6)).toBe("2026-11-07");
  });

  it("counts days backwards too", () => {
    expect(daysBetween("2026-11-05", "2026-11-04")).toBe(-1);
    expect(daysBetween("2026-12-31", "2027-01-01")).toBe(1);
  });

  it("formats days with the year only when it is another one", () => {
    vi.spyOn(Date.prototype, "toLocaleDateString").mockImplementation(function (this: Date, _locale, options) {
      return `${this.getFullYear()}-${this.getMonth() + 1}-${this.getDate()}${options?.year ? " with year" : ""}`;
    });
    try {
      expect(formatDay("2026-11-09", "2026-11-02")).toBe("2026-11-9");
      expect(formatDay("2027-01-04", "2026-12-30")).toBe("2027-1-4 with year");
    } finally {
      vi.restoreAllMocks();
    }
  });
});
