// Styles the source of the text blocks like their rendering: headers are
// large, notes and quotes look like notes and quotes, markup characters are
// dimmed (and hidden by inlinePreview.ts except where the cursor is).

import type { EditorState, Range, Text } from "@codemirror/state";
import { Decoration, type DecorationSet, type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { Block, BlockKind } from "../blocks";
import type { ListItem, ListLevel } from "../list";
import { LIST_ITEM, QUOTE_LINE, quoteDepth } from "../syntax";
import { wideRanges } from "../table";
import type { InlineKind, InlineToken } from "../inline";
import { blockTokens } from "./inlineTokens";
import { lineItems, previewField, rendersBeforeNested, type SourceItem } from "./livePreview";
import { type BlockLine, blockLines, quotedBlocks, quoteLineClasses, type TextBlock } from "./lines";

// Monospaced and highlighted text use Phorge's own element and classes,
// so its CSS styles them like in the rendered text (the editor content has
// the "phabricator-remarkup" class those rules need).
const MONO = Decoration.mark({ tagName: "tt", class: "remarkup-monospaced" });
/** How the inline markup of the source looks, by its kind (inline.ts). */
const STYLES: Partial<Record<InlineKind, Decoration>> = {
  monospace: MONO,
  bold: Decoration.mark({ class: "rme-bold" }),
  italic: Decoration.mark({ class: "rme-italic" }),
  del: Decoration.mark({ class: "rme-del" }),
  highlight: Decoration.mark({ class: "remarkup-highlight" }),
  underline: Decoration.mark({ class: "rme-underline" }),
  link: Decoration.mark({ class: "rme-link" }),
  url: Decoration.mark({ class: "rme-link" }),
  embed: Decoration.mark({ class: "rme-embed" }),
  object: Decoration.mark({ class: "rme-ref" }),
  mention: Decoration.mark({ class: "rme-ref" }),
  project: Decoration.mark({ class: "rme-ref" }),
  handle: Decoration.mark({ class: "rme-ref" }),
};

/** Styles the inline markup of a text (see inlineTokens.ts), also of a table cell's editor (inlinePreview.ts). */
export function styleTokens(tokens: InlineToken[], ranges: Range<Decoration>[]): void {
  for (const token of tokens) {
    const style = STYLES[token.kind];
    if (style && token.to > token.from) {
      ranges.push(style.range(token.from, token.to));
    }
    if (token.children) {
      styleTokens(token.children, ranges);
    }
  }
}

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
    decorateList(view.state, blockLines(doc, block), ranges);
    styleTokens(blockTokens(doc, block), ranges);
    return;
  }

  for (let n = first.number; n <= last.number; n++) {
    const line = doc.line(n);
    if (block.kind === "note" && n > first.number) {
      ranges.push(JOINED.range(line.from));
    }
    if (lineClass) {
      // Nested quotes are drawn inside the quote, as Phorge renders them (style.css).
      const edges =
        block.kind === "quote"
          ? quoteLineClasses(doc, block, n)
          : [...(n === first.number ? ["rme-first"] : []), ...(n === last.number ? ["rme-last"] : [])];
      ranges.push(Decoration.line({ class: [lineClass, ...edges].join(" ") }).range(line.from));
      // CodeMirror takes the default line height from a short plain line in
      // view. Marked lines are not plain, so it never uses a header, code or
      // note line with its own font or padding, which would skew its height
      // estimates and the cursor movement.
      mark(ranges, line.from, line.to, "rme-line");
    }
    decorateLine(block, line.from, line.text, n === first.number, ranges);
  }
  if (block.kind === "quote") {
    quotedBlocks(doc, block).forEach((inner) => decorateQuoted(view.state, inner, ranges));
  }
  styleTokens(blockTokens(doc, block), ranges);
}

/**
 * The blocks inside a quote that look like themselves there, as Phorge
 * renders them in quotes: headers, lists, tables and rules; code blocks and
 * notes as a box in the quote (style.css).
 */
function decorateQuoted(state: EditorState, block: TextBlock, ranges: Range<Decoration>[]): void {
  const { doc } = state;
  if (block.kind === "list") {
    decorateList(state, block.lines, ranges, endsItsQuote(doc, block));
    return;
  }
  let lineClass = "";
  if (block.kind === "header") {
    const [first, second] = block.lines;
    lineClass = `rme-src-h rme-src-h${second ? (/^=/.test(second.text) ? 1 : 2) : headerLevel(first.text)}`;
  } else if (MONOSPACED.has(block.kind)) {
    lineClass = "rme-quoted-box rme-quoted-code";
  } else if (block.kind === "note") {
    const word = /(NOTE|IMPORTANT|WARNING)/.exec(block.lines[0].text)?.[1].toLowerCase() ?? "note";
    lineClass = `rme-quoted-box rme-quoted-${word}`;
  } else if (block.kind === "table") {
    lineClass = "rme-src-table";
  } else if (block.kind === "rule") {
    lineClass = "rme-quoted-rule";
  }
  if (!lineClass) {
    return;
  }
  const box = lineClass.includes("rme-quoted-box");
  block.lines.forEach((line, i) => {
    const start = doc.line(line.number).from;
    let edge = "";
    if (box) {
      edge = (i === 0 ? " rme-box-first" : "") + (i === block.lines.length - 1 ? " rme-box-last" : "");
    }
    ranges.push(Decoration.line({ class: lineClass + edge }).range(start));
    if (block.kind === "note" && i > 0) {
      ranges.push(JOINED.range(start));
    }
    // A code block's "```" lines, which the rendered block does not show.
    if (block.kind === "code" && (i === 0 ? /^\s*```[^`]*$/ : /^\s*```\s*$/).test(line.text)) {
      mark(ranges, line.from, line.to, "rme-markup");
    }
    decorateLine(block, line.from, line.text, i === 0, ranges);
  });
}

/**
 * List lines are indented like the rendered list: the text starts where the
 * rendered item text starts, nested lists 24px further in, checklist items
 * 6px further and lists in checklist items 2px further (style.css). Lines
 * are as far apart as the rendered items: a nested list has the margins of
 * the rendered one where Phorge keeps them (nestedStartsLower(); at its end
 * unless the end of the list takes it, as outside quotes and before more of
 * the quote). In a quote, inside the quote. Items in a checked item are grey
 * like it.
 */
function decorateList(state: EditorState, lines: BlockLine[], ranges: Range<Decoration>[], endsQuote = false): void {
  const { doc } = state;
  const units = lineItems(lines);
  const items = units.map((unit) => unit.item);
  const classes = lines.map(() => ["rme-src-list", "rme-list-depth-0"]);
  const joined = new Set<number>();
  const checkParents = new Map<number, number>();
  // The last line with text of an item.
  const lastLine = (item: ListItem) => {
    let end = item.last;
    while (end > item.first && !lines[end].text.trim()) {
      end--;
    }
    return end;
  };
  items.forEach((item, k) => {
    const depth = Math.min(item.path.length - 1, 4);
    const around = item.path.slice(0, -1);
    // The checklist items the item is nested in: each one indents its lists further.
    const parents = around.filter((level) => level.mark !== null).length;
    const checked = item.mark === true || around.some((level) => level.mark === true);
    for (let i = item.first; i <= item.last; i++) {
      if (i > item.first) {
        joined.add(i);
      }
      classes[i] = ["rme-src-list", `rme-list-depth-${depth}`];
      if (parents) {
        checkParents.set(i, parents);
      }
      if (item.mark !== null) {
        classes[i].push("rme-list-check");
      }
      if (checked) {
        classes[i].push("rme-list-checked");
      }
    }
    // The line the browser's bullet or number is on, which may make it higher (pageStyle()).
    if (item.mark === null) {
      classes[item.first].push(`rme-list-${item.path.at(-1)!.tag}-item`);
    }
    if (nestedStartsLower(state, units, k)) {
      classes[item.first].push("rme-list-nest-start");
    }
    const next = items[k + 1];
    if (next ? next.path.length < item.path.length : endsQuote && item.path.length > 1) {
      classes[lastLine(item)].push("rme-list-nest-end");
    }
  });
  const list = { kind: "list" as const };
  lines.forEach((line, i) => {
    const start = doc.line(line.number).from;
    if (line.text.trim()) {
      const parents = checkParents.get(i);
      const attributes = parents ? { style: `--rme-check-parents: ${parents}` } : undefined;
      ranges.push(Decoration.line({ class: classes[i].join(" "), attributes }).range(start));
      if (joined.has(i)) {
        ranges.push(JOINED.range(start));
      }
    }
    decorateLine(list, line.from, line.text, i === 0, ranges);
  });
}

/**
 * Whether an item starts a list nested in another item that keeps the list's
 * top margin (rendersBeforeNested(); assumed until that item is rendered).
 * Through phantom items, which Phorge renders for levels skipped
 * ("- a\n    - b"): a phantom has nothing before its list.
 */
function nestedStartsLower(state: EditorState, units: SourceItem[], k: number): boolean {
  const { path } = units[k].item;
  const samePlace = (a: ListLevel, b: ListLevel) => a.tag === b.tag && a.index === b.index;
  for (let level = path.length - 1; level > 0 && path[level].index === 0; level--) {
    // The item the list is nested in, if it is no phantom: the last one before at that place.
    const parent = units
      .slice(0, k)
      .findLast(({ item }) => item.path.length === level && item.path.every((place, i) => samePlace(place, path[i])));
    if (parent) {
      return rendersBeforeNested(state, parent) ?? true;
    }
  }
  return false;
}

/**
 * Whether nothing follows a block in its quote: the next line with text is
 * of a quote around it, or no quote. Phorge takes the bottom margin of the
 * quote's last element away.
 */
function endsItsQuote(doc: Text, block: TextBlock): boolean {
  const last = block.lines.at(-1)!.number;
  const depth = quoteDepth(QUOTE_LINE.exec(doc.line(last).text)?.[1] ?? "");
  for (let n = last + 1; n <= doc.lines; n++) {
    const quote = QUOTE_LINE.exec(doc.line(n).text);
    if (!quote?.[1]) {
      return true;
    }
    if (quote[2].trim()) {
      return quoteDepth(quote[1]) < depth;
    }
  }
  return true;
}

function mark(ranges: Range<Decoration>[], from: number, to: number, cls: string): void {
  if (to > from) {
    ranges.push(Decoration.mark({ class: cls }).range(from, to));
  }
}

/** The styling of the block markup of a line of a block's source; also of a table cell's editor (inlinePreview.ts). */
export function decorateLine(
  block: { kind: BlockKind },
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
      if ((match = QUOTE_LINE.exec(text)) && match[1]) {
        // A reply's header ("In T1, @alice wrote:") with its marker.
        mark(ranges, from, from + (match[1].includes(">>!") ? text.length : match[1].length), "rme-markup");
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
