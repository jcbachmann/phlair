import { describe, expect, it } from "vitest";
import {
  cellRange,
  columnCount,
  deleteColumn,
  formatTable,
  MAX_COLUMN_WIDTH,
  insertColumn,
  insertRow,
  locate,
  moveColumn,
  nextCell,
  offsetOf,
  parseTable,
  previousCell,
  toggleHeader,
} from "../src/phizziwig/table";

const format = (text: string) => formatTable(parseTable(text)).text;

describe("formatTable", () => {
  it("aligns columns and keeps the header separator", () => {
    expect(format("| Element | Line\n|---|---\n| Fe | Ka\n| Cu | Ka-beta")).toBe(
      ["| Element | Line", "| ------- | -------", "| Fe      | Ka", "| Cu      | Ka-beta"].join("\n"),
    );
  });

  it("keeps trailing pipes when the table uses them and pads short rows", () => {
    expect(format("| a | b |\n| ccc |")).toBe("| a   | b   |\n| ccc |     |");
  });

  it("pads columns to at most MAX_COLUMN_WIDTH, a longer cell sticks out", () => {
    const long = "x".repeat(MAX_COLUMN_WIDTH + 10);
    const pad = " ".repeat(MAX_COLUMN_WIDTH - 1);
    expect(format(`| a | b |\n| ${long} | c |`)).toBe(`| a${pad} | b   |\n| ${long} | c   |`);
  });

  it("does not split cells on the pipe inside a link", () => {
    expect(parseTable("| [[ /w/ | wiki ]] | x |").rows[0].cells).toEqual(["[[ /w/ | wiki ]]", "x"]);
  });

  it("splits cells after a link that is not closed yet", () => {
    expect(parseTable("| [[ /w/ | x |").rows[0].cells).toEqual(["[[ /w/", "x"]);
  });

  it("only changes whitespace in cell content", () => {
    const text = "|a|  b  c |d\n|  `x | y`|";
    const table = parseTable(text);
    const padded = table.rows.map((r) => [...r.cells, ...new Array(columnCount(table) - r.cells.length).fill("")]);
    expect(parseTable(format(text)).rows.map((r) => r.cells)).toEqual(padded);
  });
});

describe("cursor positions", () => {
  it("locates the cell and offset of a cursor and finds it again after formatting", () => {
    const text = "| a | bcd |\n|x|yz|";
    const pos = locate(text, text.indexOf("yz") + 1);
    expect(pos).toEqual({ row: 1, col: 1, offset: 1 });
    const table = parseTable(text);
    const formatted = formatTable(table).text;
    expect(formatted.slice(offsetOf(table, pos) - 1, offsetOf(table, pos) + 1)).toBe("yz");
  });

  it("puts a cursor in the padding before a cell into that cell", () => {
    expect(locate("| a |    b |", 6)).toEqual({ row: 0, col: 1, offset: 0 });
  });
});

describe("table edits", () => {
  const header = parseTable("| h1 | h2 |\n|----|----|\n| a | b |");

  it("moves to the next cell, skipping the separator, and adds a row at the end", () => {
    expect(nextCell(header, { row: 0, col: 1, offset: 0 }).cursor).toEqual({ row: 2, col: 0, offset: 0 });
    const added = nextCell(header, { row: 2, col: 1, offset: 0 });
    expect(added.table.rows).toHaveLength(4);
    expect(added.cursor).toEqual({ row: 3, col: 0, offset: 0 });
  });

  it("moves to the previous cell, skipping the separator", () => {
    expect(previousCell(header, { row: 2, col: 0, offset: 0 }).cursor).toMatchObject({ row: 0, col: 1 });
  });

  it("inserts a row below a header after its separator", () => {
    const edit = insertRow(header, { row: 0, col: 0, offset: 0 }, true);
    expect(formatTable(edit.table).text.split("\n")[2]).toBe("|     |     |");
    expect(edit.cursor.row).toBe(2);
  });

  it("inserts and deletes columns including the separator", () => {
    const inserted = insertColumn(header, { row: 2, col: 0, offset: 0 }, true);
    expect(formatTable(inserted.table).text).toBe("| h1  |     | h2  |\n| --- | --- | --- |\n| a   |     | b   |");
    const deleted = deleteColumn(inserted.table, { row: 0, col: 1, offset: 0 })!;
    expect(formatTable(deleted.table).text).toBe(formatTable(header).text);
  });

  it("moves a column with its cells", () => {
    const moved = moveColumn(header, { row: 2, col: 0, offset: 0 }, 1)!;
    expect(moved.table.rows[2].cells).toEqual(["b", "a"]);
    expect(moved.cursor.col).toBe(1);
  });

  it("toggles the header separator", () => {
    const plain = toggleHeader(header, { row: 2, col: 0, offset: 0 });
    expect(plain.table.rows.some((r) => r.separator)).toBe(false);
    expect(plain.cursor.row).toBe(1);
    expect(toggleHeader(plain.table, plain.cursor).table.rows[1].separator).toBe(true);
  });
});

describe("cellRange", () => {
  it("finds the text of a cell without its padding", () => {
    const line = "|  a  | [[ /w/ | wiki ]] |    |";
    const text = (col: number) => {
      const range = cellRange(line, col);
      return range && line.slice(range.from, range.to);
    };
    expect([text(0), text(1), text(2), text(3)]).toEqual(["a", "[[ /w/ | wiki ]]", "", null]);
    // Text typed into the empty cell goes after the space after its "|".
    expect(cellRange(line, 2)?.from).toBe(line.lastIndexOf("|    |") + 2);
  });
});
