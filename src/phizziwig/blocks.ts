// Splits remarkup into the top-level blocks Phorge's engine sees.
//
// This is a port of PhutilRemarkupEngine::splitTextIntoBlocks() and the
// getMatchingLineCount() of each block rule (phorge/src/infrastructure/
// markup). Matching the server exactly matters: every block is rendered on its
// own, so a block cut in the wrong place renders differently than in the real
// preview. test/blocks.test.ts compares the result with the PHP engine.
//
// Lines keep their "\n" like phutil_split_lines(). PHP's "$" also matches
// before a final "\n", which the patterns below spell out as "\n?$".
//
// Derived from Phabricator (Copyright Phacility, Inc., Apache License 2.0;
// see licenses/Phabricator-LICENSE.txt and Phabricator-NOTICE.txt), changed.

export type BlockKind =
  | "quote"
  | "literal"
  | "header"
  | "rule"
  | "list"
  | "code"
  | "note"
  | "html-table"
  | "table"
  | "interpreter"
  | "paragraph";

export interface Block {
  kind: BlockKind;
  /** Offset of the first character in the text. */
  from: number;
  /** Offset after the last character, including trailing blank lines. */
  to: number;
  /** Offset after the last non-blank line (without its "\n"). */
  contentTo: number;
  /** True if the block consists of blank lines only. */
  empty: boolean;
}

// PHP's \s without the "u" flag; JavaScript's \s also matches Unicode spaces.
const S = "[ \\t\\n\\x0B\\f\\r]";

function phpTrim(s: string): string {
  return s.replace(/^[ \t\n\r\0\x0B]+|[ \t\n\r\0\x0B]+$/g, "");
}

function isBlank(line: string): boolean {
  return phpTrim(line) === "";
}

export function splitLines(text: string): string[] {
  if (text === "") {
    return [""];
  }
  const lines = text.split(/(?<=\n)/);
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

type Rule = (lines: string[], cursor: number) => number;

const quotesRule: Rule = (lines, cursor) => {
  let pos = cursor;
  if (lines[pos].startsWith(">")) {
    do {
      pos++;
    } while (pos < lines.length && lines[pos].startsWith(">"));
  }
  return pos - cursor;
};

// A reply (">>! In T1, @alice wrote:") is rendered as a quote.
const replyRule: Rule = (lines, cursor) => (lines[cursor].startsWith(">>!") ? quotesRule(lines, cursor) : 0);

const literalRule: Rule = (lines, cursor) => {
  const start = new RegExp(`^${S}*%%%`);
  const end = new RegExp(`%%%${S}*$`);
  const trivial = new RegExp(`^${S}*%%%${S}*$`);
  if (!start.test(lines[cursor])) {
    return 0;
  }
  const startCursor = cursor;
  let foundEmpty = false;
  let blockStart: number | null = null;
  while (cursor < lines.length) {
    const line = lines[cursor];
    if (blockStart === null) {
      if (foundEmpty) {
        break;
      }
      if (start.test(line)) {
        blockStart = cursor;
      }
    }
    if (blockStart !== null) {
      let isEnd = end.test(line);
      if (isEnd && cursor === blockStart && trivial.test(line)) {
        isEnd = false;
      }
      if (isEnd) {
        blockStart = null;
        cursor++;
        continue;
      }
    }
    if (blockStart === null) {
      if (!isBlank(line)) {
        break;
      }
      foundEmpty = true;
    }
    cursor++;
  }
  return cursor - startCursor;
};

function withTrailingBlankLines(lines: string[], cursor: number, numLines: number): number {
  cursor += numLines;
  while (cursor < lines.length && isBlank(lines[cursor])) {
    numLines++;
    cursor++;
  }
  return numLines;
}

const headerRule: Rule = (lines, cursor) => {
  let numLines = 0;
  if (/^(={1,5}|#{2,5}|# ).*\n?$/.test(lines[cursor])) {
    numLines = 1;
  } else if (cursor + 1 < lines.length) {
    if (/^[^\n]+\n$/.test(lines[cursor]) && new RegExp(`^[-=]{2,}${S}*$`).test(lines[cursor + 1])) {
      numLines = 2;
    }
  }
  return numLines ? withTrailingBlankLines(lines, cursor, numLines) : 0;
};

const ruleRule: Rule = (lines, cursor) => {
  const pattern = new RegExp(`^${S}*(?:_{3,}|\\*${S}?\\*${S}?\\*(${S}|\\*)*|-${S}?-${S}?-(${S}|-)*)$`);
  if (!pattern.test(lines[cursor].replace(/[\n\r]+$/, ""))) {
    return 0;
  }
  return withTrailingBlankLines(lines, cursor, 1);
};

const LIST_START = new RegExp(`^${S}*(?:[-*#]+|([1-9][0-9]*)[.)]|\\[\\D?\\])${S}+`);
const LIST_CONT = new RegExp(`^${S}*(?:[-*#]+|[0-9]+[.)]|\\[\\D?\\])${S}+`);

const listRule: Rule = (lines, cursor) => {
  let numLines = 0;
  const firstLine = cursor;
  let isOneLine = false;
  while (cursor < lines.length) {
    if (!numLines) {
      if (LIST_START.test(lines[cursor])) {
        numLines++;
        cursor++;
        isOneLine = true;
        continue;
      }
    } else {
      if (LIST_CONT.test(lines[cursor])) {
        numLines++;
        cursor++;
        isOneLine = false;
        continue;
      }
      // Lists continue across paragraphs while lines are indented or a single
      // empty line separates indented lines.
      const thisEmpty = isBlank(lines[cursor]);
      const thisIndented = lines[cursor].startsWith(" ");
      let nextEmpty = true;
      let nextIndented = false;
      if (cursor + 1 < lines.length) {
        nextEmpty = isBlank(lines[cursor + 1]);
        nextIndented = lines[cursor + 1].startsWith(" ");
      }
      if (thisEmpty || thisIndented) {
        if ((thisIndented && !thisEmpty) || (nextIndented && !nextEmpty)) {
          numLines++;
          cursor++;
          continue;
        }
      }
      if (thisEmpty) {
        numLines++;
      }
    }
    break;
  }
  // A single "#" item that is not the last line is a header, not a list.
  if (isOneLine && firstLine + numLines < lines.length && lines[firstLine].startsWith("#")) {
    return 0;
  }
  return numLines;
};

const codeRule: Rule = (lines, cursor) => {
  let matchTicks: boolean;
  if (new RegExp(`^(${S}{2,}).+`).test(lines[cursor])) {
    matchTicks = false;
  } else if (new RegExp(`^${S}*(\`\`\`)`).test(lines[cursor])) {
    matchTicks = true;
  } else {
    return 0;
  }
  let numLines = 1;
  if (matchTicks && new RegExp(`^${S}*(\`\`\`)(.*)(\`\`\`)${S}*$`).test(lines[cursor])) {
    return numLines;
  }
  cursor++;
  while (cursor < lines.length) {
    if (matchTicks) {
      numLines++;
      if (new RegExp(`\`\`\`${S}*$`).test(lines[cursor])) {
        break;
      }
    } else {
      if (!isBlank(lines[cursor]) && !new RegExp(`^${S}{2,}`).test(lines[cursor])) {
        break;
      }
      numLines++;
    }
    cursor++;
  }
  return numLines;
};

const NOTE_START = new RegExp(`^(?:(?:\\((?:NOTE|IMPORTANT|WARNING)\\))|(?:(?:NOTE|IMPORTANT|WARNING):))`);

const noteRule: Rule = (lines, cursor) => {
  if (!NOTE_START.test(lines[cursor])) {
    return 0;
  }
  let numLines = 1;
  cursor++;
  while (cursor < lines.length) {
    // PHP's truthiness: a line of just "0" also ends the note.
    const trimmed = phpTrim(lines[cursor]);
    if (trimmed === "" || trimmed === "0") {
      break;
    }
    numLines++;
    cursor++;
  }
  return numLines;
};

const htmlTableRule: Rule = (lines, cursor) => {
  if (!new RegExp(`^${S}*<table>`, "i").test(lines[cursor])) {
    return 0;
  }
  let numLines = 1;
  cursor++;
  while (cursor < lines.length) {
    numLines++;
    if (new RegExp(`</table>${S}*$`, "i").test(lines[cursor])) {
      break;
    }
    cursor++;
  }
  return numLines;
};

const TABLE_LINE = new RegExp(`^${S}*\\|`);

const tableRule: Rule = (lines, cursor) => {
  let numLines = 0;
  while (cursor < lines.length && TABLE_LINE.test(lines[cursor])) {
    numLines++;
    cursor++;
  }
  return numLines;
};

const INTERPRETER_START = new RegExp(`^(\\w+)${S}*(?:\\(([^)]+)\\)${S}*)?\\{\\{\\{`);
const INTERPRETER_END = new RegExp(`\\}\\}\\}${S}*$`);

const interpreterRule: Rule = (lines, cursor) => {
  if (!INTERPRETER_START.test(lines[cursor])) {
    return 0;
  }
  // Mirrors the PHP loop, which counts the first line twice unless it also
  // ends the block. The count may run past the end of the text.
  let numLines = 1;
  while (cursor < lines.length) {
    if (INTERPRETER_END.test(lines[cursor])) {
      break;
    }
    numLines++;
    cursor++;
  }
  return numLines;
};

const paragraphRule: Rule = () => 1;

// Same order as PhutilRemarkupEngine::setBlockRules(): by priority, then by
// class name.
const RULES: [BlockKind, Rule][] = [
  ["rule", ruleRule], // 300
  ["list", listRule], // 400
  ["quote", replyRule],
  ["literal", literalRule], // 450
  ["code", codeRule], // 500
  ["header", headerRule],
  ["interpreter", interpreterRule],
  ["note", noteRule],
  ["quote", quotesRule],
  ["table", tableRule], // PhutilRemarkupSimpleTableBlockRule
  ["html-table", htmlTableRule], // PhutilRemarkupTableBlockRule
  ["paragraph", paragraphRule], // 750
];

interface LineBlock {
  kind: BlockKind;
  start: number;
  numLines: number;
  empty: boolean;
}

/** Splits text into blocks by line index, exactly like the PHP engine. */
export function splitLineBlocks(lines: string[]): LineBlock[] {
  const blocks: LineBlock[] = [];
  let cursor = 0;
  while (cursor < lines.length) {
    for (const [kind, rule] of RULES) {
      const numLines = rule(lines, cursor);
      if (!numLines) {
        continue;
      }
      const end = Math.min(cursor + numLines, lines.length);
      let empty = true;
      for (let i = cursor; i < end; i++) {
        if (!isBlank(lines[i])) {
          empty = false;
          break;
        }
      }
      const current: LineBlock = { kind, start: cursor, numLines, empty };
      const last = blocks[blocks.length - 1];
      if (last && shouldMergeParagraphs(lines, last, current)) {
        last.numLines += numLines;
        last.empty = last.empty && empty;
      } else {
        blocks.push(current);
      }
      cursor += numLines;
      break;
    }
  }
  return blocks;
}

function shouldMergeParagraphs(lines: string[], last: LineBlock, current: LineBlock): boolean {
  if (last.kind !== "paragraph" || current.kind !== "paragraph") {
    return false;
  }
  if (last.empty || current.empty) {
    return true;
  }
  return !isBlank(lines[current.start - 1]) && !isBlank(lines[current.start]);
}

/** Splits text into blocks with character offsets. */
export function splitBlocks(text: string): Block[] {
  const lines = splitLines(text);
  const lineStart: number[] = [];
  let offset = 0;
  for (const line of lines) {
    lineStart.push(offset);
    offset += line.length;
  }
  lineStart.push(offset);

  return splitLineBlocks(lines).map((block) => {
    const end = Math.min(block.start + block.numLines, lines.length);
    let last = end - 1;
    while (last > block.start && isBlank(lines[last])) {
      last--;
    }
    const contentTo = lineStart[last] + lines[last].replace(/\n$/, "").length;
    return {
      kind: block.kind,
      from: lineStart[block.start],
      to: lineStart[end],
      contentTo: block.empty ? lineStart[block.start] : contentTo,
      empty: block.empty,
    };
  });
}
