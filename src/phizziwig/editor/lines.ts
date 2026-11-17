// The lines of blocks, also of the blocks inside quotes: Phorge renders the
// text of a quote (its lines without their ">") as blocks again, so a quote
// has headers, lists, notes and the like of its own. Their lines start after
// the quote's markers; what works on the lines of a block (styling, list
// markers, Enter, the list buttons) works on these lines the same way.

import type { SelectionRange, Text } from "@codemirror/state";
import { type Block, type BlockKind, splitLineBlocks } from "../blocks";
import { QUOTE_LINE, QUOTE_MARKERS, quoteDepth } from "../syntax";

/** The deepest nested quote that style.css draws; deeper ones look like it. */
export const MAX_QUOTE_DEPTH = 4;

/** A line of a block: in a quote, the part after the quote's markers. */
export interface BlockLine {
  /** The number of the line in the text. */
  number: number;
  /** Where the part starts in the text: after the quote's markers. */
  from: number;
  to: number;
  text: string;
}

/** A block by its lines: one of the text, or one inside a quote. */
export interface TextBlock {
  kind: BlockKind;
  /** Its lines up to its last one with text. */
  lines: BlockLine[];
  /** Whether it is inside a quote. */
  quoted: boolean;
}

/**
 * The first and last line of a selection. One that ends at the start of a
 * line (a triple click selects a line with its line break) does not take
 * that line in.
 */
export function rangeLines(doc: Text, range: SelectionRange): [number, number] {
  const first = doc.lineAt(range.from).number;
  const end = doc.lineAt(range.to);
  return [first, end.number > first && range.to === end.from ? end.number - 1 : end.number];
}

/** The lines of a block of the text. */
export function blockLines(doc: Text, block: Block): BlockLine[] {
  const lines: BlockLine[] = [];
  for (let n = doc.lineAt(block.from).number; n <= doc.lineAt(block.contentTo).number; n++) {
    const { from, to, text } = doc.line(n);
    lines.push({ number: n, from, to, text });
  }
  return lines;
}

/**
 * The blocks inside a quote, by the lines of each of its levels: lines
 * quoted equally deep follow each other in the quote's text (a nested quote
 * is a block of that text whose lines are all deeper).
 */
export function quotedBlocks(doc: Text, quote: Block): TextBlock[] {
  let known = cache.get(doc);
  if (!known) {
    cache.set(doc, (known = new Map()));
  }
  let blocks = known.get(quote.from);
  if (!blocks) {
    known.set(quote.from, (blocks = splitQuote(doc, quote)));
  }
  return blocks;
}

/** The blocks of the quotes of a text, by where they start: each text (a version of it) is split once. */
const cache = new WeakMap<Text, Map<number, TextBlock[]>>();

function splitQuote(doc: Text, quote: Block): TextBlock[] {
  const blocks: TextBlock[] = [];
  let group: BlockLine[] = [];
  let depth = -1;
  const flush = () => {
    const texts = group.map((line) => `${line.text}\n`);
    for (const block of splitLineBlocks(texts)) {
      if (!block.empty) {
        const lines = group.slice(block.start, block.start + block.numLines);
        // Up to its last line with text, like Block.contentTo.
        while (lines.length > 1 && !lines[lines.length - 1].text.trim()) {
          lines.pop();
        }
        blocks.push({ kind: block.kind, lines, quoted: true });
      }
    }
    group = [];
  };
  for (const line of blockLines(doc, quote)) {
    const markers = QUOTE_MARKERS.exec(line.text)![0];
    // A reply's header ("In T1, @alice wrote:") is a block of its own.
    const reply = markers.includes(">>!");
    const level = quoteDepth(markers);
    if (level !== depth || reply) {
      flush();
      depth = reply ? -1 : level;
    }
    group.push({
      number: line.number,
      from: line.from + markers.length,
      to: line.to,
      text: line.text.slice(markers.length),
    });
  }
  flush();
  return blocks;
}

/** The block a line is in, also inside a quote. */
export function blockOfLine(doc: Text, blocks: readonly Block[], number: number): TextBlock | undefined {
  const line = doc.line(number);
  const block = blocks.find((b) => !b.empty && b.from <= line.from && line.from <= b.contentTo);
  if (!block) {
    return undefined;
  }
  if (block.kind === "quote") {
    return quotedBlocks(doc, block).find((inner) => inner.lines.some((l) => l.number === number));
  }
  return { kind: block.kind, lines: blockLines(doc, block), quoted: false };
}

/**
 * The classes of a line of a quote that style.css draws the quote with: its
 * ends, and nested quotes inside it, each level 12px further in, with their
 * paddings where they start and end, and Phorge's margin from text right
 * before or after them (without a blank line between).
 */
export function quoteLineClasses(doc: Text, quote: Block, number: number): string[] {
  const first = doc.lineAt(quote.from).number;
  const last = doc.lineAt(quote.contentTo).number;
  const quoteLine = (n: number) => (n >= first && n <= last ? QUOTE_LINE.exec(doc.line(n).text) : null);
  const depth = (n: number) => {
    const match = quoteLine(n);
    return match ? quoteDepth(match[1]) : 0;
  };
  const text = (n: number) => !!quoteLine(n)?.[2].trim();
  const classes: string[] = [];
  if (number === first) {
    classes.push("rme-first");
  }
  if (number === last) {
    classes.push("rme-last");
  }
  const level = depth(number);
  if (level > 1) {
    classes.push(`rme-quote-depth-${Math.min(level, MAX_QUOTE_DEPTH)}`);
    if (level > depth(number - 1)) {
      classes.push("rme-quote-open", ...(text(number - 1) ? ["rme-quote-apart-above"] : []));
    }
    if (level > depth(number + 1)) {
      classes.push("rme-quote-close", ...(text(number + 1) ? ["rme-quote-apart-below"] : []));
    }
  }
  return classes;
}

/** A line of a block by its number. */
export function lineOf(block: TextBlock, number: number): BlockLine | undefined {
  return block.lines.find((line) => line.number === number);
}
