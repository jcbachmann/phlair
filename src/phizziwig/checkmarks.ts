// The checkboxes of remarkup text ("- [ ] open", "- [x] done"), in the order
// Phorge renders them, with where their mark is in the text: so a click on a
// rendered checkbox can change just that mark in the source. Only checklist
// items of lists count (blocks.ts and list.ts are ports of Phorge's rules),
// also of lists in quotes; nothing in code blocks.

import { splitBlocks } from "./blocks";
import { parseList } from "./list";

export interface Checkmark {
  /** Where the text between the brackets is ("[ ]": the space; "[]": nothing). */
  from: number;
  to: number;
  checked: boolean;
}

/** The checkboxes of a text, in their order. */
export function checkmarks(text: string): Checkmark[] {
  const found: Checkmark[] = [];
  for (const block of splitBlocks(text)) {
    const source = text.slice(block.from, block.contentTo);
    if (block.kind === "list") {
      found.push(...listMarks(source, block.from));
    } else if (block.kind === "quote") {
      found.push(...quoteMarks(source, block.from));
    }
  }
  return found;
}

function listMarks(source: string, offset: number): Checkmark[] {
  const lines = source.split("\n");
  const starts: number[] = [];
  let at = offset;
  for (const line of lines) {
    starts.push(at);
    at += line.length + 1;
  }
  return parseList(lines).flatMap((item) => {
    if (item.mark === null) {
      return [];
    }
    // The checkbox after the marker, as Phorge reads it ("[" any one non-digit "]").
    const match = /^(\s*(?:[-*#]+|[0-9]+[.)])?\s*\[)(\D?)\]/.exec(lines[item.first]);
    if (!match) {
      return [];
    }
    const from = starts[item.first] + match[1].length;
    return [{ from, to: from + match[2].length, checked: item.mark }];
  });
}

/** The checkboxes of a quote: of its text without the ">" of its lines, which Phorge renders as blocks again. */
function quoteMarks(source: string, offset: number): Checkmark[] {
  const parts: { from: number; text: string }[] = [];
  let at = offset;
  for (const line of source.split("\n")) {
    const prefix = /^>+\s?/.exec(line)?.[0].length ?? 0;
    parts.push({ from: at + prefix, text: line.slice(prefix) });
    at += line.length + 1;
  }
  const inner = parts.map((part) => part.text).join("\n");
  // Back to positions in the text: by the line of the quote each is on.
  const position = (i: number) => {
    let k = 0;
    let start = 0;
    while (k < parts.length - 1 && start + parts[k].text.length < i) {
      start += parts[k].text.length + 1;
      k++;
    }
    return parts[k].from + (i - start);
  };
  return checkmarks(inner).map((mark) => ({ ...mark, from: position(mark.from), to: position(mark.to) }));
}

/** The text with a checkbox (by its index) checked or unchecked; null if there is no such checkbox. */
export function setCheckmark(text: string, index: number, checked: boolean): string | null {
  const mark = checkmarks(text)[index];
  if (!mark) {
    return null;
  }
  return text.slice(0, mark.from) + (checked ? "x" : " ") + text.slice(mark.to);
}
