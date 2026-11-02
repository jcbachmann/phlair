// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  exportSnoozes,
  forgetEnded,
  itemKey,
  loadSnoozes,
  parseExport,
  setSnooze,
  takeOverOldSnoozes,
} from "../src/phuture/snoozes";

const originalZone = process.env.TZ;

beforeEach(() => localStorage.clear());
afterEach(() => {
  process.env.TZ = originalZone;
});

describe("item keys", () => {
  it("are the path of the item's link on this site", () => {
    expect(itemKey(`${location.origin}/T123`)).toBe("T123");
    expect(itemKey("/D45")).toBe("D45");
    expect(itemKey("/w/notes/")).toBe("w/notes");
    expect(itemKey("/T123#comment-4")).toBe("T123");
  });

  it("are none for other sites and the home page", () => {
    expect(itemKey("https://example.com/T123")).toBeNull();
    expect(itemKey("/")).toBeNull();
  });
});

describe("snoozes", () => {
  it("are kept and woken up", () => {
    setSnooze("T1", "2026-11-05");
    setSnooze("T2", "2026-11-06");
    setSnooze("T1", null);
    expect(loadSnoozes()).toEqual({ T2: "2026-11-06" });
    setSnooze("T2", null);
    expect(localStorage.getItem("phuture-snoozes")).toBeNull();
  });

  it("end on their day", () => {
    const snoozes = { T1: "2026-11-04", T2: "2026-11-05", T3: "2026-11-06" };
    expect(forgetEnded(snoozes, "2026-11-05")).toBe(true);
    expect(snoozes).toEqual({ T3: "2026-11-06" });
    expect(forgetEnded(snoozes, "2026-11-05")).toBe(false);
  });

  it("ignore stored values that are no days", () => {
    localStorage.setItem("phuture-snoozes", JSON.stringify({ T1: "2026-11-05", T2: "soon", T3: 5 }));
    expect(loadSnoozes()).toEqual({ T1: "2026-11-05" });
    localStorage.setItem("phuture-snoozes", "{broken");
    expect(loadSnoozes()).toEqual({});
  });

  it("go to another browser through an export", () => {
    const snoozes = { T1: "2026-11-05", "w/notes": "2027-01-04" };
    expect(parseExport(exportSnoozes(snoozes))).toEqual(snoozes);
    expect(() => parseExport('{"anything": 1}')).toThrow();
    expect(() => parseExport("[1]")).toThrow();
    expect(() => parseExport("not json")).toThrow();
  });
});

// The old plugin stored the moment its day began as UTC: the local midnight,
// or the UTC midnight its date picker gave. In Berlin (UTC+1 in November),
// local midnight of 5 November is 23:00 UTC on 4 November.
describe("the old plugin's snoozes", () => {
  it("are taken over with their day, in either form, and removed", () => {
    process.env.TZ = "Europe/Berlin";
    localStorage.setItem("T1", "2026-11-04T23:00:00.000Z");
    localStorage.setItem("T2", "2026-11-06T00:00:00.000Z");
    localStorage.setItem("rXYZ0123abcd", "2026-12-01T23:00:00.000Z");
    localStorage.setItem("snooze override show", "true");
    localStorage.setItem("phizziwig-enabled", "1");

    expect(takeOverOldSnoozes()).toBe(true);
    expect(loadSnoozes()).toEqual({ T1: "2026-11-05", T2: "2026-11-06", rXYZ0123abcd: "2026-12-02" });
    expect(Object.keys(localStorage).sort()).toEqual([
      "phizziwig-enabled",
      "phuture-snoozes",
      "phuture-took-over-old-snoozes",
    ]);
  });

  it("are taken over once, and only entries in the old plugin's form", () => {
    process.env.TZ = "Europe/Berlin";
    // Another script's entries that look alike.
    localStorage.setItem("lastSync", "2026-11-02T10:00:00.000Z");
    localStorage.setItem("w/notes/", "2026-12-01T23:00:00.000Z");
    takeOverOldSnoozes();
    // The old plugin, still installed, snoozes another item afterwards.
    localStorage.setItem("T7", "2026-11-04T23:00:00.000Z");
    expect(takeOverOldSnoozes()).toBeNull();
    expect(loadSnoozes()).toEqual({});
    expect(localStorage.getItem("lastSync")).toBe("2026-11-02T10:00:00.000Z");
    expect(localStorage.getItem("w/notes/")).toBe("2026-12-01T23:00:00.000Z");
    expect(localStorage.getItem("T7")).toBe("2026-11-04T23:00:00.000Z");
  });

  it("keep their day west of UTC, where the UTC midnight of a day is the evening before", () => {
    process.env.TZ = "America/New_York";
    localStorage.setItem("T1", "2026-11-06T00:00:00.000Z");
    takeOverOldSnoozes();
    expect(loadSnoozes()).toEqual({ T1: "2026-11-06" });
  });

  it("do not replace snoozes made since", () => {
    process.env.TZ = "Europe/Berlin";
    setSnooze("T1", "2026-12-24");
    localStorage.setItem("T1", "2026-11-04T23:00:00.000Z");
    takeOverOldSnoozes();
    expect(loadSnoozes()).toEqual({ T1: "2026-12-24" });
  });

  it("are read from its exports, which held all of the site's storage", () => {
    process.env.TZ = "Europe/Berlin";
    const old = {
      T1: "2026-11-04T23:00:00.000Z",
      "snooze override show": "false",
      other: "value",
      lastSync: "2026-11-02T10:00:00.000Z",
    };
    expect(parseExport(JSON.stringify(old))).toEqual({ T1: "2026-11-05" });
    expect(parseExport(JSON.stringify({ "snooze override show": "false" }))).toEqual({});
  });
});
