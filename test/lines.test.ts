import { EditorSelection, Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { splitBlocks } from "../src/phizziwig/blocks";
import {
  lineMarkers,
  markersOf,
  offsetInBlock,
  offsetWithMarkers,
  quotedBlocks,
  quoteLineClasses,
  rangeLines,
  withMarkers,
} from "../src/phizziwig/editor/lines";

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

describe("a block's text with the markers of its lines", () => {
  const text = "> Asked:\n> | a | b |\n>| 1 | 2 |";
  const doc = Text.of(text.split("\n"));
  const table = quotedBlocks(doc, splitBlocks(text)[0])[1];

  it("has each line's markers, also where they differ, and the last line's for lines added below", () => {
    const markers = lineMarkers(doc, table);
    expect(markers).toEqual(["> ", ">"]);
    expect(withMarkers("| a |\n| 1 |\n| new |", markers)).toBe("> | a |\n>| 1 |\n>| new |");
    expect(markersOf(markers, Infinity)).toBe(">");
    expect(withMarkers("x", [])).toBe("x");
  });

  it("maps offsets of the text without markers to the text with them, and positions of the document to the text", () => {
    const markers = ["> ", ">"];
    // "| a |\n| 1 |": "1" is at 8, after "> | a |\n>| " at 11.
    expect(offsetWithMarkers("| a |\n| 1 |", markers, 8)).toBe(11);
    expect(offsetWithMarkers("| a |\n| 1 |", markers, 0)).toBe(2);
    const [first, second] = table.lines;
    expect(offsetInBlock(doc, table, text.indexOf("1"))).toBe(first.text.length + 1 + second.text.indexOf("1"));
    // In the markers: the start of the line's text; on another line: none.
    expect(offsetInBlock(doc, table, doc.line(3).from)).toBe(first.text.length + 1);
    expect(offsetInBlock(doc, table, 0)).toBe(-1);
  });
});
