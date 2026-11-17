import { EditorSelection, Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { splitBlocks } from "../src/phizziwig/blocks";
import { quotedBlocks, quoteLineClasses, rangeLines } from "../src/phizziwig/editor/lines";

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

describe("quoteLineClasses", () => {
  const classes = (text: string) => {
    const doc = Text.of(text.split("\n"));
    const [quote] = splitBlocks(text);
    return text.split("\n").map((_, i) => quoteLineClasses(doc, quote, i + 1).join(" "));
  };

  it("mark the ends of a quote and where nested quotes start and end", () => {
    expect(classes("> one\n>\n>> two\n>> three\n>\n> four")).toEqual([
      "rme-first",
      "",
      "rme-quote-depth-2 rme-quote-open",
      "rme-quote-depth-2 rme-quote-close",
      "",
      "rme-last",
    ]);
  });

  it("mark Phorge's margin on the side of a nested quote that has text right next to it", () => {
    // Text above, a blank line below: the margin only above.
    expect(classes("> one\n>> two\n>\n> four")[1]).toBe(
      "rme-quote-depth-2 rme-quote-open rme-quote-apart-above rme-quote-close",
    );
    expect(classes("> one\n>\n>> two\n> four")[2]).toBe(
      "rme-quote-depth-2 rme-quote-open rme-quote-close rme-quote-apart-below",
    );
    expect(classes(">>> deep\n> out")).toEqual([
      "rme-first rme-quote-depth-3 rme-quote-open rme-quote-close rme-quote-apart-below",
      "rme-last",
    ]);
  });
});
