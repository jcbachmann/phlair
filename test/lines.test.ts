import { EditorSelection, Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { splitBlocks } from "../src/phizziwig/blocks";
import { quotedBlocks, rangeLines } from "../src/phizziwig/editor/lines";

describe("rangeLines", () => {
  const doc = Text.of(["one", "two", "three"]);
  it("leaves out the line a selection ends at the start of (a triple click)", () => {
    expect(rangeLines(doc, EditorSelection.range(0, 4))).toEqual([1, 1]);
    expect(rangeLines(doc, EditorSelection.range(0, 5))).toEqual([1, 2]);
    expect(rangeLines(doc, EditorSelection.cursor(4))).toEqual([2, 2]);
  });
});

describe("quotedBlocks", () => {
  it("are the blocks of each level of a quote's text, with lines after the markers", () => {
    const text = "> Intro:\n>\n>   - [ ] box\n>   - item\n>> = Deeper\n> after";
    const doc = Text.of(text.split("\n"));
    const [quote] = splitBlocks(text);
    const blocks = quotedBlocks(doc, quote).map((block) => ({
      kind: block.kind,
      lines: block.lines.map((line) => [line.number, doc.sliceString(line.from, line.to)]),
    }));
    expect(blocks).toEqual([
      { kind: "paragraph", lines: [[1, "Intro:"]] },
      {
        kind: "list",
        lines: [
          [3, "  - [ ] box"],
          [4, "  - item"],
        ],
      },
      { kind: "header", lines: [[5, "= Deeper"]] },
      { kind: "paragraph", lines: [[6, "after"]] },
    ]);
  });
});
