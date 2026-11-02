// Editing model for remarkup simple tables ("| a | b |" lines).
//
// Phorge ignores trailing "|" and splits cells on "|" outside of
// "[[ link | name ]]". A row of only "--" cells turns the row above into a
// header row. Formatting only changes whitespace, pads short rows with empty
// cells and aligns the columns (up to a maximum width).

export interface TableRow {
  cells: string[];
  separator: boolean;
}

export interface Table {
  indent: string;
  rows: TableRow[];
  trailingPipe: boolean;
}

/** A cursor position: row and column, and the offset in the trimmed cell. */
export interface CellPos {
  row: number;
  col: number;
  offset: number;
}

interface RawCell {
  /** Offset of the trimmed content in the line. */
  start: number;
  text: string;
}

function splitRow(line: string): { cells: RawCell[]; trailingPipe: boolean } {
  const cells: RawCell[] = [];
  const first = line.indexOf("|");
  if (first < 0) {
    return { cells, trailingPipe: false };
  }
  let start = first + 1;
  let depth = 0;
  for (let i = start; i <= line.length; i++) {
    // Only a closed "[[ link | name ]]" keeps its "|" in the cell.
    if (line.startsWith("[[", i) && line.indexOf("]]", i + 2) >= 0) {
      depth++;
      i++;
    } else if (depth && line.startsWith("]]", i)) {
      depth--;
      i++;
    } else if (i === line.length || (line[i] === "|" && !depth)) {
      const raw = line.slice(start, i);
      // Text typed into an empty cell goes after the space following its "|".
      const lead = raw.trim() ? raw.length - raw.trimStart().length : Math.min(1, raw.length);
      cells.push({ start: start + lead, text: raw.trim() });
      start = i + 1;
    }
  }
  // Like Phorge, only a "|" at the very end is a trailing pipe: "| a | "
  // has an empty second cell.
  const trailingPipe = line.endsWith("|");
  if (trailingPipe) {
    cells.pop();
  }
  return { cells, trailingPipe };
}

/** The offsets of a cell's text (without padding) in a table line, or null. */
export function cellRange(line: string, col: number): { from: number; to: number } | null {
  const cell = splitRow(line).cells[col];
  return cell ? { from: cell.start, to: cell.start + cell.text.length } : null;
}

function isSeparator(cells: string[]): boolean {
  return cells.some((c) => /^--+$/.test(c)) && cells.every((c) => c === "" || /^--+$/.test(c));
}

export function parseTable(text: string): Table {
  const lines = text.split("\n");
  let pipes = 0;
  const rows = lines.map((line) => {
    const { cells, trailingPipe } = splitRow(line);
    if (trailingPipe) {
      pipes++;
    }
    const texts = cells.map((c) => c.text);
    return { cells: texts, separator: isSeparator(texts) };
  });
  return {
    indent: /^\s*/.exec(lines[0])![0],
    rows,
    trailingPipe: pipes * 2 >= lines.length,
  };
}

export function columnCount(table: Table): number {
  return Math.max(1, ...table.rows.map((r) => r.cells.length));
}

/** Finds the cell at a character offset of the table text. */
export function locate(text: string, pos: number): CellPos {
  const lines = text.split("\n");
  let row = 0;
  let lineStart = 0;
  while (row < lines.length - 1 && pos > lineStart + lines[row].length) {
    lineStart += lines[row].length + 1;
    row++;
  }
  const ch = pos - lineStart;
  const { cells } = splitRow(lines[row]);
  let col = 0;
  for (let i = 0; i < cells.length; i++) {
    // A cell starts right after the "|" before its content.
    const pipe = lines[row].lastIndexOf("|", cells[i].start - 1);
    if (ch > pipe) {
      col = i;
    }
  }
  const cell = cells[col];
  if (!cell) {
    return { row, col: 0, offset: 0 };
  }
  const offset = Math.max(0, Math.min(cell.text.length, ch - cell.start));
  return { row, col, offset };
}

/**
 * The widest a column is padded to: a longer cell sticks out of its column
 * instead of widening it, so one long text does not push all other rows apart.
 */
export const MAX_COLUMN_WIDTH = 30;

function widths(table: Table): number[] {
  const count = columnCount(table);
  const result: number[] = new Array(count).fill(3);
  for (const row of table.rows) {
    if (row.separator) {
      continue;
    }
    row.cells.forEach((cell, i) => {
      result[i] = Math.min(MAX_COLUMN_WIDTH, Math.max(result[i], displayWidth(cell)));
    });
  }
  return result;
}

/** Formats the table and returns the text and the offset of each cell. */
export function formatTable(table: Table): { text: string; cellStarts: number[][] } {
  const w = widths(table);
  const lines: string[] = [];
  const cellStarts: number[][] = [];
  let offset = 0;
  for (const row of table.rows) {
    let line = table.indent + "|";
    const starts: number[] = [];
    w.forEach((width, i) => {
      const last = i === w.length - 1;
      line += " ";
      starts.push(offset + line.length);
      if (row.separator) {
        line += "-".repeat(width);
      } else {
        const cell = row.cells[i] ?? "";
        line += last && !table.trailingPipe ? cell : cell + " ".repeat(Math.max(0, width - displayWidth(cell)));
      }
      line += last ? (table.trailingPipe ? " |" : "") : " |";
    });
    lines.push(line);
    cellStarts.push(starts);
    offset += line.length + 1;
  }
  return { text: lines.join("\n"), cellStarts };
}

/** Converts a cell position into an offset of the formatted text. */
export function offsetOf(table: Table, pos: CellPos): number {
  const { cellStarts } = formatTable(table);
  const row = Math.max(0, Math.min(pos.row, table.rows.length - 1));
  const col = Math.max(0, Math.min(pos.col, cellStarts[row].length - 1));
  const cell = table.rows[row].separator ? "" : (table.rows[row].cells[col] ?? "");
  return cellStarts[row][col] + Math.min(pos.offset, cell.length);
}

function emptyRow(table: Table): TableRow {
  return { cells: new Array(columnCount(table)).fill(""), separator: false };
}

function clone(table: Table): Table {
  return { ...table, rows: table.rows.map((r) => ({ ...r, cells: [...r.cells] })) };
}

export interface Edit {
  table: Table;
  cursor: CellPos;
  /** Select the whole cell content instead of placing the cursor. */
  selectCell?: boolean;
}

export function insertRow(table: Table, at: CellPos, below: boolean): Edit {
  const t = clone(table);
  let index = below ? at.row + 1 : at.row;
  // A new row below a header goes below its separator.
  if (below && t.rows[index]?.separator) {
    index++;
  }
  t.rows.splice(index, 0, emptyRow(t));
  return { table: t, cursor: { row: index, col: 0, offset: 0 } };
}

export function deleteRow(table: Table, at: CellPos): Edit | null {
  if (table.rows.length <= 1) {
    return null;
  }
  const t = clone(table);
  t.rows.splice(at.row, 1);
  const row = Math.min(at.row, t.rows.length - 1);
  return { table: t, cursor: { row, col: at.col, offset: 0 } };
}

export function insertColumn(table: Table, at: CellPos, right: boolean): Edit {
  const t = clone(table);
  const index = right ? at.col + 1 : at.col;
  const count = columnCount(t);
  for (const row of t.rows) {
    while (row.cells.length < count) {
      row.cells.push(row.separator ? "---" : "");
    }
    row.cells.splice(index, 0, row.separator ? "---" : "");
  }
  return { table: t, cursor: { row: at.row, col: index, offset: 0 } };
}

export function deleteColumn(table: Table, at: CellPos): Edit | null {
  if (columnCount(table) <= 1) {
    return null;
  }
  const t = clone(table);
  for (const row of t.rows) {
    row.cells.splice(at.col, 1);
  }
  return { table: t, cursor: { row: at.row, col: Math.min(at.col, columnCount(t) - 1), offset: 0 } };
}

export function moveRow(table: Table, at: CellPos, delta: number): Edit | null {
  const target = at.row + delta;
  if (target < 0 || target >= table.rows.length) {
    return null;
  }
  const t = clone(table);
  const [row] = t.rows.splice(at.row, 1);
  t.rows.splice(target, 0, row);
  return { table: t, cursor: { ...at, row: target } };
}

export function moveColumn(table: Table, at: CellPos, delta: number): Edit | null {
  const count = columnCount(table);
  const target = at.col + delta;
  if (target < 0 || target >= count) {
    return null;
  }
  const t = clone(table);
  for (const row of t.rows) {
    while (row.cells.length < count) {
      row.cells.push(row.separator ? "---" : "");
    }
    const [cell] = row.cells.splice(at.col, 1);
    row.cells.splice(target, 0, cell);
  }
  return { table: t, cursor: { ...at, col: target } };
}

/** Adds or removes the separator that makes the first row a header. */
export function toggleHeader(table: Table, at: CellPos): Edit {
  const t = clone(table);
  if (t.rows[1]?.separator) {
    t.rows.splice(1, 1);
    const row = at.row > 1 ? at.row - 1 : at.row === 1 ? 0 : at.row;
    return { table: t, cursor: { ...at, row } };
  }
  t.rows.splice(1, 0, { cells: new Array(columnCount(t)).fill("---"), separator: true });
  return { table: t, cursor: { ...at, row: at.row >= 1 ? at.row + 1 : at.row } };
}

/** Moves to the next cell, adding a row at the end of the table. */
export function nextCell(table: Table, at: CellPos): Edit {
  const count = columnCount(table);
  let { row, col } = at;
  do {
    col++;
    if (col >= count) {
      col = 0;
      row++;
    }
  } while (row < table.rows.length && table.rows[row].separator);
  if (row >= table.rows.length) {
    const t = clone(table);
    t.rows.push(emptyRow(t));
    return { table: t, cursor: { row, col: 0, offset: 0 } };
  }
  return { table, cursor: { row, col, offset: 0 }, selectCell: true };
}

export function previousCell(table: Table, at: CellPos): Edit {
  const count = columnCount(table);
  let { row, col } = at;
  do {
    col--;
    if (col < 0) {
      col = count - 1;
      row--;
    }
  } while (row >= 0 && table.rows[row].separator);
  if (row < 0) {
    return { table, cursor: { row: 0, col: 0, offset: 0 }, selectCell: true };
  }
  return { table, cursor: { row, col, offset: 0 }, selectCell: true };
}

export function isEmptyRow(row: TableRow): boolean {
  return !row.separator && row.cells.every((c) => c === "");
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** An emoji shown as a picture, which takes two columns of monospaced text. */
const WIDE_GRAPHEME = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F/u;

/** The ranges of emoji in a text, which take two columns of monospaced text. */
export function wideRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  // Most text is plain.
  if (/^[\x20-\x7e]*$/.test(text)) {
    return ranges;
  }
  let offset = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (WIDE_GRAPHEME.test(segment)) {
      ranges.push([offset, offset + segment.length]);
    }
    offset += segment.length;
  }
  return ranges;
}

/**
 * The columns a text takes in monospaced text: one per character as seen,
 * two for emoji (the table source shows them two columns wide).
 */
function displayWidth(text: string): number {
  if (/^[\x20-\x7e]*$/.test(text)) {
    return text.length;
  }
  return Array.from(graphemes.segment(text)).length + wideRanges(text).length;
}
