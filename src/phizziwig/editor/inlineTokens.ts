// The inline markup of the blocks of the text, as Phorge's inline rules find
// it (inline.ts), with positions in the document. Phorge applies the rules to
// the text of a block without its block markup: a paragraph whole, a header
// without its "=", a note without "NOTE:", a quote without its ">", each
// list item without its marker, each table cell. That text is put together
// from the parts of the source, so the tokens can be mapped back.

import type { Text } from "@codemirror/state";
import type { Block } from "../blocks";
import { type InlineToken, tokenizeInline } from "../inline";
import { parseList } from "../list";
import { LIST_ITEM, NOTE_PREFIX, QUOTE_MARKERS } from "../syntax";

/** Ranges of the document whose texts, joined with newlines, are one text for the inline rules. */
type Parts = { from: number; to: number }[];

/** Blocks whose text has no inline markup. */
const LITERAL = new Set(["code", "literal", "interpreter", "html-table", "rule"]);

const cache = new Map<string, InlineToken[]>();

/** The tokens of a text, cached: the blocks of the text are tokenized again on each change. */
function tokensOf(text: string): InlineToken[] {
  let tokens = cache.get(text);
  if (!tokens) {
    tokens = tokenizeInline(text);
    cache.set(text, tokens);
    if (cache.size > 1000) {
      cache.delete(cache.keys().next().value!);
    }
  }
  return tokens;
}

/** The tokens of a text in the document that is one text for the inline rules (e.g. a table cell's). */
export function textTokens(text: string, from: number): InlineToken[] {
  return tokensOf(text).map((token) => moved(token, (i) => from + i));
}

/** The tokens of a block, with positions in the document. */
export function blockTokens(doc: Text, block: Block): InlineToken[] {
  if (block.empty || LITERAL.has(block.kind)) {
    return [];
  }
  return inlineParts(doc, block).flatMap((parts) => {
    const texts = parts.map((part) => doc.sliceString(part.from, part.to));
    // Where each part starts in the joined text.
    const starts: number[] = [];
    let at = 0;
    for (const text of texts) {
      starts.push(at);
      at += text.length + 1;
    }
    const position = (i: number) => {
      let k = starts.length - 1;
      while (k > 0 && starts[k] > i) {
        k--;
      }
      // The newline after a part is its end.
      return Math.min(parts[k].from + (i - starts[k]), parts[k].to);
    };
    return tokensOf(texts.join("\n")).map((token) => moved(token, position));
  });
}

function moved(token: InlineToken, position: (i: number) => number): InlineToken {
  return {
    ...token,
    from: position(token.from),
    to: position(token.to),
    contentFrom: token.contentFrom === undefined ? undefined : position(token.contentFrom),
    contentTo: token.contentTo === undefined ? undefined : position(token.contentTo),
    children: token.children?.map((child) => moved(child, position)),
  };
}

/** The texts of a block for the inline rules: see above. */
function inlineParts(doc: Text, block: Block): Parts[] {
  const first = doc.lineAt(block.from);
  const last = doc.lineAt(block.contentTo);
  const lines = Array.from({ length: last.number - first.number + 1 }, (_, i) => doc.line(first.number + i));
  const strip = (pattern: RegExp) =>
    lines.map((line) => ({ from: line.from + (pattern.exec(line.text)?.[0].length ?? 0), to: line.to }));
  switch (block.kind) {
    case "header": {
      // "== A ==" or "A" underlined: its text.
      const open = /^(=+|#+)\s*/.exec(first.text)?.[0].length ?? 0;
      const close = lines.length > 1 ? 0 : (/\s*=+\s*$/.exec(first.text.slice(open))?.[0].length ?? 0);
      return [[{ from: first.from + open, to: first.to - close }]];
    }
    case "note":
      return [
        [{ from: first.from + (NOTE_PREFIX.exec(first.text)?.[0].length ?? 0), to: first.to }, ...strip(/^/).slice(1)],
      ];
    case "quote":
      // Also the text of a reply's header (">>! In T1, @alice wrote:").
      return [strip(QUOTE_MARKERS)];
    case "list":
      return parseList(lines.map((line) => line.text)).map((item) =>
        lines.slice(item.first, item.last + 1).map((line, i) => {
          const match = i === 0 ? LIST_ITEM.exec(line.text) : null;
          const indent = match ? line.text.length - match[5].length : (/^\s*/.exec(line.text)?.[0].length ?? 0);
          return { from: line.from + indent, to: line.to };
        }),
      );
    case "table":
      return lines.flatMap((line) =>
        tableCells(line.text).map(([from, to]) => [{ from: line.from + from, to: line.from + to }]),
      );
    default:
      return [[{ from: block.from, to: block.contentTo }]];
  }
}

/** The cells of a table row: between its "|", which a "[[ link | name ]]" does not split; trimmed. */
function tableCells(text: string): [number, number][] {
  const cells: [number, number][] = [];
  let start = 0;
  let link = false;
  for (let i = 0; i <= text.length; i++) {
    if (text.startsWith("[[", i)) {
      link = true;
    } else if (text.startsWith("]]", i)) {
      link = false;
    }
    if (i === text.length || (text[i] === "|" && !link)) {
      const cell = text.slice(start, i);
      const from = start + (cell.length - cell.trimStart().length);
      const to = start + cell.trimEnd().length;
      if (to > from) {
        cells.push([from, to]);
      }
      start = i + 1;
    }
  }
  return cells;
}
