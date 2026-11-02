import { describe, expect, it } from "vitest";
import { minimalChange } from "../src/phizziwig/diff";

const apply = (old: string, change: { from: number; to: number; insert: string }) =>
  old.slice(0, change.from) + change.insert + old.slice(change.to);

describe("minimalChange", () => {
  it.each([
    ["abc", "abXc", { from: 2, to: 2, insert: "X" }],
    ["abc", "ac", { from: 1, to: 2, insert: "" }],
    ["aaa", "aaaa", { from: 3, to: 3, insert: "a" }],
    ["same", "same", { from: 4, to: 4, insert: "" }],
    ["", "new", { from: 0, to: 0, insert: "new" }],
    ["old text", "", { from: 0, to: 8, insert: "" }],
  ])("%j → %j", (old, next, change) => {
    expect(minimalChange(old, next)).toEqual(change);
    expect(apply(old, minimalChange(old, next))).toBe(next);
  });
});
