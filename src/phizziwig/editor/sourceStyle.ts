// Styles the source of the blocks being edited so their structure stays
// visible: headers are large, notes and quotes look like notes and quotes,
// markup characters are dimmed.

import type { Line, Range } from "@codemirror/state";
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { Block } from "../blocks";
import { parseList } from "../list";
import { LIST_ITEM } from "../syntax";
import { wideRanges } from "../table";
import { previewField } from "./livePreview";

// Monospaced and highlighted text use Phorge's own element and classes,
// so its CSS styles them like in the rendered text (the editor content has
// the "phabricator-remarkup" class those rules need).
const MONO = Decoration.mark({ tagName: "tt", class: "remarkup-monospaced" });
// Monospaced text first: other markup inside it is not styled.
const INLINE: [RegExp, Decoration][] = [
  [/`[^`\n]+`/g, MONO],
  [/##(?=\S)[^\n#]+?##/g, MONO],
  [/\*\*(?=\S)[^\n]+?\*\*/g, Decoration.mark({ class: "rme-bold" })],
  [/(?<![:\w])\/\/(?=\S)[^\n]+?\/\//g, Decoration.mark({ class: "rme-italic" })],
  [/~~[^\n]+?~~/g, Decoration.mark({ class: "rme-del" })],
  [/!![^\n]+?!!/g, Decoration.mark({ class: "remarkup-highlight" })],
  [/(?<!\w)__[^\n]+?__(?!\w)/g, Decoration.mark({ class: "rme-underline" })],
  [/\[\[[^\n]+?\]\]/g, Decoration.mark({ class: "rme-link" })],
  [/\bhttps?:\/\/[^\s\]<>`]+/g, Decoration.mark({ class: "rme-link" })],
  [/\{[A-Z]\d+[^}\n]*\}/g, Decoration.mark({ class: "rme-embed" })],
  [/(?<![\w/#@&{])[A-Z]\d+(?:#\d+)?\b/g, Decoration.mark({ class: "rme-ref" })],
  [/(?<![\w@])@[\w.-]*\w/g, Decoration.mark({ class: "rme-ref" })],
];

const LIST_MARKER = Decoration.mark({ class: "rme-list-marker", inclusive: true });

/**
 * A line that Phorge shows on the same line as the one before (joined with a
 * space): the lines of a note, and the lines continuing a list item. Remarkup
 * has no line breaks in those; a blank line ends them.
 */
const JOINED = Decoration.line({
  class: "rme-joined",
  attributes: { title: "Phorge shows this line on the line before it. A blank line ends the note or list item." },
});

const MONOSPACED = new Set(["code", "literal", "interpreter", "html-table"]);

function headerLevel(text: string): number {
  const atx = /^(=+|#+)/.exec(text);
  if (atx) {
    return Math.min(5, atx[1].length);
  }
  return 1;
}

function decorateBlock(view: EditorView, block: Block, ranges: Range<Decoration>[]): void {
  const doc = view.state.doc;
  const first = doc.lineAt(block.from);
  const last = doc.lineAt(block.contentTo);
  let lineClass = "";
  if (block.kind === "header") {
    const setext = last.number > first.number;
    lineClass = `rme-src-h rme-src-h${setext ? (/^=/.test(last.text) ? 1 : 2) : headerLevel(first.text)}`;
  } else if (block.kind === "note") {
    // Phorge's own classes, so notes have its colors in every theme.
    const word = /(NOTE|IMPORTANT|WARNING)/.exec(first.text)?.[1].toLowerCase() ?? "note";
    lineClass = `rme-src-note remarkup-${word}`;
  } else if (block.kind === "quote") {
    lineClass = "rme-src-quote";
  } else if (block.kind === "table") {
    lineClass = "rme-src-table";
  } else if (MONOSPACED.has(block.kind)) {
    lineClass = "rme-src-code";
  } else if (block.kind === "rule") {
    lineClass = "rme-src-rule";
  } else if (block.kind === "list") {
    return decorateList(view, block, ranges);
  }

  for (let n = first.number; n <= last.number; n++) {
    const line = doc.line(n);
    if (block.kind === "note" && n > first.number) {
      ranges.push(JOINED.range(line.from));
    }
    if (lineClass) {
      const edge = (n === first.number ? " rme-first" : "") + (n === last.number ? " rme-last" : "");
      ranges.push(Decoration.line({ class: lineClass + edge }).range(line.from));
      // CodeMirror takes the default line height from a short plain line in
      // view. Marked lines are not plain, so it never uses a header, code or
      // note line with its own font or padding, which would skew its height
      // estimates and the cursor movement.
      mark(ranges, line.from, line.to, "rme-line");
    }
    decorateLine(block, line.from, line.text, n === first.number, ranges);
  }
}

/**
 * List lines are indented like the rendered list: the text starts where the
 * rendered item text starts, nested lists 24px further in, and checklist items
 * 6px further. A nested list ends with the 4px margin of the rendered one.
 */
function decorateList(view: EditorView, block: Block, ranges: Range<Decoration>[]): void {
  const doc = view.state.doc;
  const first = doc.lineAt(block.from).number;
  const last = doc.lineAt(block.contentTo).number;
  const lines: Line[] = [];
  for (let n = first; n <= last; n++) {
    lines.push(doc.line(n));
  }
  // The level of each line: that of its item, as Phorge nests the list.
  const items = parseList(lines.map((line) => line.text));
  const classes = lines.map(() => ["rme-src-list", "rme-list-depth-0"]);
  const joined = new Set<number>();
  items.forEach((item, k) => {
    const depth = Math.min(item.path.length - 1, 4);
    for (let i = item.first; i <= item.last; i++) {
      if (i > item.first) {
        joined.add(i);
      }
      classes[i] = ["rme-src-list", `rme-list-depth-${depth}`];
      if (item.mark !== null) {
        classes[i].push("rme-list-check");
      }
      if (item.mark) {
        classes[i].push("rme-list-checked");
      }
    }
    const next = items[k + 1];
    if (next && next.path.length < item.path.length) {
      // The last line with text of the item.
      let end = item.last;
      while (end > item.first && !lines[end].text.trim()) {
        end--;
      }
      classes[end].push("rme-list-nest-end");
    }
  });
  lines.forEach((line, i) => {
    if (line.text.trim()) {
      ranges.push(Decoration.line({ class: classes[i].join(" ") }).range(line.from));
      if (joined.has(i)) {
        ranges.push(JOINED.range(line.from));
      }
    }
    decorateLine(block, line.from, line.text, i === 0, ranges);
  });
}

function mark(ranges: Range<Decoration>[], from: number, to: number, cls: string): void {
  if (to > from) {
    ranges.push(Decoration.mark({ class: cls }).range(from, to));
  }
}

/** The styling of a line of a block's source; also of a table cell's editor (inlinePreview.ts). */
export function decorateLine(
  block: Block,
  from: number,
  text: string,
  isFirst: boolean,
  ranges: Range<Decoration>[],
): void {
  let match: RegExpExecArray | null;
  switch (block.kind) {
    case "code":
    case "literal":
    case "interpreter":
    case "html-table":
    case "rule":
      return;
    case "table":
      for (let i = text.indexOf("|"); i >= 0; i = text.indexOf("|", i + 1)) {
        mark(ranges, from + i, from + i + 1, "rme-markup");
      }
      // Emoji take exactly two columns, as the aligned source counts them.
      for (const [start, end] of wideRanges(text)) {
        mark(ranges, from + start, from + end, "rme-wide");
      }
      break;
    case "header":
      if ((match = /^(=+|#+)\s*/.exec(text))) {
        mark(ranges, from, from + match[0].length, "rme-markup");
      }
      if ((match = /\s*=+\s*$/.exec(text)) && match.index > 0) {
        mark(ranges, from + match.index, from + text.length, "rme-markup");
      }
      if (!isFirst) {
        mark(ranges, from, from + text.length, "rme-markup");
        return;
      }
      break;
    case "quote":
      if ((match = /^>+(!.*$)?\s?/.exec(text))) {
        mark(ranges, from, from + match[0].length, "rme-markup");
      }
      break;
    case "note":
      if (isFirst && (match = /^(\(\w+\)|\w+:)/.exec(text))) {
        mark(ranges, from, from + match[0].length, "remarkup-note-word");
      }
      break;
    case "list":
      // The marker and the indentation hang into the indent of the line, also
      // the rendered marker that takes their place (inlinePreview.ts).
      if ((match = LIST_ITEM.exec(text))) {
        ranges.push(LIST_MARKER.range(from, from + match[0].length - match[5].length));
      } else if ((match = /^\s+/.exec(text))) {
        mark(ranges, from, from + match[0].length, "rme-list-marker");
      }
      break;
  }
  // Monospaced text is literal: nothing inside it is styled, like in Phorge.
  const literal: [number, number][] = [];
  for (const [pattern, decoration] of INLINE) {
    pattern.lastIndex = 0;
    while ((match = pattern.exec(text))) {
      const start = match.index;
      const end = start + match[0].length;
      if (literal.some(([a, b]) => start < b && end > a)) {
        continue;
      }
      if (decoration === MONO) {
        literal.push([start, end]);
      }
      ranges.push(decoration.range(from + start, from + end));
    }
  }
}

function build(view: EditorView): DecorationSet {
  const { blocks } = view.state.field(previewField);
  const ranges: Range<Decoration>[] = [];
  blocks.forEach((block) => {
    // Blocks being edited and blocks without rendered HTML show their source.
    if (block.empty) {
      return;
    }
    for (const { from, to } of view.visibleRanges) {
      if (block.contentTo >= from && block.from <= to) {
        if (!isReplaced(view, block)) {
          decorateBlock(view, block, ranges);
        }
        break;
      }
    }
  });
  return Decoration.set(ranges, true);
}

function isReplaced(view: EditorView, block: Block): boolean {
  let replaced = false;
  view.state.field(previewField).decorations.between(block.from, block.from, (from, to, deco) => {
    // A rendered block replaces the text; a spacer before it (a point) does
    // not, and neither does a rendered item of a list being edited.
    if (from === block.from && to >= block.contentTo && to > from && deco.spec.block) {
      replaced = true;
    }
  });
  return replaced;
}

export const sourceStyle = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = build(view);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.viewportChanged ||
        update.startState.field(previewField) !== update.state.field(previewField)
      ) {
        this.decorations = build(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
