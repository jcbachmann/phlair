// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportSnoozes, forgetEnded, itemKey, loadSnoozes, parseExport, setSnooze } from "../src/phuture/snoozes";

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

  it("are imported only for paths of this site", () => {
    const day = "2026-11-05";
    const file = { format: "phuture-snoozes", snoozes: { T1: day, "/evil.example": day, "\\evil.example": day } };
    expect(parseExport(JSON.stringify(file))).toEqual({ T1: day });
  });
});
