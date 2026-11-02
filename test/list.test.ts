import { describe, expect, it } from "vitest";
import { parseList } from "../src/phizziwig/list";

/** Each item as "lines: tag/index > tag/index … text". */
function shape(text: string): string[] {
  return parseList(text.split("\n")).map(
    (item) =>
      `${item.first}-${item.last}: ${item.path.map((l) => `${l.tag}${l.index}${l.start > 1 ? `@${l.start}` : ""}`).join(" > ")} ${item.text}`,
  );
}

describe("parseList", () => {
  it("nests by relative indentation, also of a list indented as a whole", () => {
    expect(shape("  - a\n    - b\n  - c")).toEqual(["0-0: ul0 - a", "1-1: ul0 > ul0 - b", "2-2: ul1 - c"]);
  });

  it("nests by repeated markers, and takes the tag of each list from its first item", () => {
    expect(shape("# a\n## b\n-- c\n# d")).toEqual([
      "0-0: ol0 - a",
      "1-1: ol0 > ol0 - b",
      "2-2: ol0 > ol1 - c",
      "3-3: ol1 - d",
    ]);
  });

  it("maps different indentations of one level to that level", () => {
    expect(shape("- a\n  - b\n- c\n    - d")).toEqual([
      "0-0: ul0 - a",
      "1-1: ul0 > ul0 - b",
      "2-2: ul1 - c",
      "3-3: ul1 > ul0 - d",
    ]);
  });

  it("puts phantom items above a list that starts deeper (a staircase)", () => {
    expect(shape("    - a\n  - b\n# c")).toEqual(["0-0: ol0 > ul0 > ul0 - a", "1-1: ol0 > ul1 - b", "2-2: ol1 - c"]);
  });

  it("starts an ordered list at its first number", () => {
    expect(shape("3. a\n4. b\n  - c")).toEqual(["0-0: ol0@3 - a", "1-1: ol1@3 - b", "2-2: ol1@3 > ul0 - c"]);
  });

  it("keeps the continued lines of an item with it, and an item of only a marker", () => {
    const items = parseList(["  - a", "    more", "  - ", "  - [X] done", "", "    again"]);
    expect(items.map((i) => [i.first, i.last, i.text, i.mark])).toEqual([
      [0, 1, "- a\nmore", null],
      [2, 2, "- ", null],
      [3, 5, "- [X] done\n\nagain", true],
    ]);
    expect(items.every((i) => i.hasMarks)).toBe(true);
  });
});
