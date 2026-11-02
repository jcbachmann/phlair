// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { keyLabel, matchesKey } from "../src/phizziwig/keys";

const key = (init: KeyboardEventInit) => new KeyboardEvent("keydown", init);

describe("matchesKey", () => {
  it("matches letters with their modifiers only", () => {
    expect(matchesKey(key({ key: "b", code: "KeyB", ctrlKey: true }), "Mod-b")).toBe(true);
    expect(matchesKey(key({ key: "B", code: "KeyB", ctrlKey: true, shiftKey: true }), "Mod-b")).toBe(false);
    expect(matchesKey(key({ key: "X", code: "KeyX", ctrlKey: true, shiftKey: true }), "Mod-Shift-x")).toBe(true);
    expect(matchesKey(key({ key: "b", code: "KeyB" }), "Mod-b")).toBe(false);
    expect(matchesKey(key({ key: "b", code: "KeyB", ctrlKey: true, altKey: true }), "Mod-b")).toBe(false);
  });

  it("matches letters by their key on layouts without Latin letters", () => {
    // Russian: the key B types "и".
    expect(matchesKey(key({ key: "и", code: "KeyB", ctrlKey: true }), "Mod-b")).toBe(true);
    // German: the key Y types "z"; the letter counts, not the key.
    expect(matchesKey(key({ key: "z", code: "KeyY", ctrlKey: true }), "Mod-z")).toBe(true);
    expect(matchesKey(key({ key: "z", code: "KeyY", ctrlKey: true }), "Mod-y")).toBe(false);
  });

  it("matches digits by their key, whatever Shift types on them", () => {
    // German: Shift+7 types "/".
    expect(matchesKey(key({ key: "/", code: "Digit7", ctrlKey: true, shiftKey: true }), "Mod-Shift-7")).toBe(true);
    expect(matchesKey(key({ key: "/", code: "Digit7", ctrlKey: true, shiftKey: true }), "Mod-/")).toBe(false);
    // US: Ctrl+/ without Shift.
    expect(matchesKey(key({ key: "/", code: "Slash", ctrlKey: true }), "Mod-/")).toBe(true);
    expect(matchesKey(key({ key: "F1", code: "F1" }), "F1")).toBe(true);
  });

  it("shows keys with Ctrl outside of Macs", () => {
    expect(keyLabel("Mod-Shift-x")).toBe("Ctrl+Shift+X");
    expect(keyLabel("F1")).toBe("F1");
  });
});
