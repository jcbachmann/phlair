// Tables shown and edited as tables, with Phorge's table markup and CSS.
//
// A table that the text cursor is not in is a TableWidget. Its cells are
// editable: the focused cell shows its remarkup, the others their rendered
// content. Typing in a cell changes only that cell's text in the source;
// structural changes (rows, columns, header) rewrite the table aligned.

import { isolateHistory, redo, undo } from "@codemirror/commands";
import { type EditorView, WidgetType } from "@codemirror/view";
import { minimalChange } from "../diff";
import { submitForm } from "../phorge";
import { matchesKey } from "../keys";
import { INLINE_FORMATS } from "../syntax";
import {
  type CellPos,
  cellRange,
  columnCount,
  type Edit,
  formatTable,
  insertColumn,
  insertRow,
  isEmptyRow,
  moveRow,
  nextCell,
  parseTable,
  previousCell,
  type Table,
} from "../table";
import { hostTextarea } from "./host";
import { addLink, changeLink, findLinks, linkBubble, unlinked } from "./links";
import { openLinkOnModClick } from "./livePreview";
import { parseHtml, setHtml } from "../html";

interface TableDom extends HTMLElement {
  /** The source text of the table, as of the last update. */
  rmeText?: string;
  rmeHtml?: string;
}

/** The cell the user is typing in; updates must not overwrite its text. */
let typingCell: HTMLElement | null = null;

const editable = (() => {
  const probe = document.createElement("td");
  probe.contentEditable = "plaintext-only";
  return probe.contentEditable === "plaintext-only" ? "plaintext-only" : "true";
})();

/** The rendered HTML of each cell, by row and column, or null. */
function renderedCells(html: string | undefined): string[][] | null {
  if (!html) {
    return null;
  }
  // A table followed by more text ends with an empty row in Phorge's HTML.
  return Array.from(parseHtml(html).querySelectorAll("table.remarkup-table tr"))
    .filter((tr) => tr.children.length)
    .map((tr) => Array.from(tr.children).map((cell) => cell.innerHTML));
}

/** The table rows that are shown: all but the "| --- |" header separators. */
function shownRows(table: Table): number[] {
  return table.rows.flatMap((row, i) => (row.separator ? [] : [i]));
}

function sync(dom: TableDom, text: string, html: string | undefined): void {
  dom.rmeText = text;
  dom.rmeHtml = html;
  const table = parseTable(text);
  const columns = columnCount(table);
  const rows = shownRows(table);
  const isHeader = (row: number) => table.rows[row + 1]?.separator === true;
  const tbody = dom.querySelector("tbody")!;

  const shape = `${rows.map((row) => (isHeader(row) ? "h" : "d") + row).join(",")}/${columns}`;
  if (dom.dataset.shape !== shape) {
    dom.dataset.shape = shape;
    tbody.replaceChildren(
      ...rows.map((row) => {
        const tr = document.createElement("tr");
        tr.dataset.row = String(row);
        for (let col = 0; col < columns; col++) {
          const cell = document.createElement(isHeader(row) ? "th" : "td");
          cell.dataset.col = String(col);
          cell.contentEditable = editable;
          cell.spellcheck = true;
          // Tab moves between cells; the page's tab order skips them.
          cell.tabIndex = -1;
          tr.append(cell);
        }
        return tr;
      }),
    );
  }

  const rendered = renderedCells(html);
  const useRendered = rendered !== null && rendered.length === rows.length;
  rows.forEach((row, k) => {
    const tr = tbody.children[k];
    for (let col = 0; col < columns; col++) {
      const cell = tr.children[col] as HTMLElement;
      const source = table.rows[row].cells[col] ?? "";
      if (cell === typingCell) {
        continue;
      }
      if (cell.dataset.editing) {
        // Only text changed elsewhere (e.g. undo) replaces what is typed;
        // spaces being typed at the end are not in the source yet.
        if ((cell.textContent ?? "").trim() !== source) {
          cell.textContent = source;
          // What the cell wrote is gone, so is the length it wrote.
          delete cell.dataset.written;
          placeCaret(cell, "end");
        }
        continue;
      }
      const cellHtml = useRendered ? rendered[k][col] : undefined;
      if (cellHtml !== undefined) {
        if (cell.innerHTML !== cellHtml) {
          setHtml(cell, cellHtml);
        }
      } else if (cell.dataset.source !== source) {
        // Until the changed table is rendered, unchanged cells keep their
        // rendered content, so the table does not change on every key.
        cell.textContent = source;
      }
      cell.dataset.source = source;
    }
  });
}

function positionOf(cell: HTMLElement): { row: number; col: number } {
  return { row: Number((cell.parentElement as HTMLElement).dataset.row), col: Number(cell.dataset.col) };
}

/** Offset of the caret in a cell's text, or null if the selection is not a caret in it. */
function caretOffset(cell: HTMLElement): number | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed) {
    return null;
  }
  const range = selection.getRangeAt(0);
  if (!cell.contains(range.startContainer)) {
    return null;
  }
  const before = document.createRange();
  before.selectNodeContents(cell);
  before.setEnd(range.startContainer, range.startOffset);
  return before.toString().length;
}

function placeCaret(cell: HTMLElement, where: "start" | "end" | "all"): void {
  const range = document.createRange();
  range.selectNodeContents(cell);
  if (where !== "all") {
    range.collapse(where === "start");
  }
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/** The table widgets of the editor whose table starts at a position. */
function tableDomAt(view: EditorView, from: number): TableDom | null {
  for (const dom of Array.from(view.contentDOM.querySelectorAll<TableDom>(".rme-table-editor"))) {
    if (view.posAtDOM(dom) === from) {
      return dom;
    }
  }
  return null;
}

export function focusCell(
  view: EditorView,
  from: number,
  row: number,
  col: number,
  where: "start" | "end" | "all",
): void {
  const dom = tableDomAt(view, from);
  const tr = dom?.querySelector<HTMLElement>(`tr[data-row="${row}"]`);
  const cell = tr?.querySelector<HTMLElement>(`[data-col="${col}"]`) ?? tr?.lastElementChild;
  if (cell instanceof HTMLElement) {
    cell.focus();
    placeCaret(cell, where);
  }
}

/** Moves into a table from the line above (first row) or below (last row). */
export function enterTable(view: EditorView, from: number, fromAbove: boolean): void {
  const dom = tableDomAt(view, from);
  const rows = dom ? shownRows(parseTable(dom.rmeText ?? "")) : [];
  if (rows.length) {
    focusCell(view, from, fromAbove ? rows[0] : rows[rows.length - 1], 0, "start");
  }
}

/** Puts the text cursor before or after the table. */
function leave(view: EditorView, dom: TableDom, down: boolean): void {
  const from = view.posAtDOM(dom);
  const to = from + (dom.rmeText ?? "").length;
  const { doc } = view.state;
  // The editor would take the selection in the cell as its cursor on focus.
  window.getSelection()?.removeAllRanges();
  view.focus();
  if (!down) {
    view.dispatch({ selection: { anchor: Math.max(0, from - 1) }, scrollIntoView: true });
  } else if (to < doc.length) {
    view.dispatch({ selection: { anchor: to + 1 }, scrollIntoView: true });
  } else {
    // The table ends the text: continue in a new paragraph after it.
    view.dispatch({ changes: { from: to, insert: "\n\n" }, selection: { anchor: to + 2 }, scrollIntoView: true });
  }
}

/** Applies a table operation and focuses the cell the cursor of the edit is in. */
function apply(view: EditorView, dom: TableDom, edit: Edit | null, original: Table): void {
  if (!edit) {
    return;
  }
  const from = view.posAtDOM(dom);
  if (edit.table !== original) {
    view.dispatch({
      changes: { from, to: from + (dom.rmeText ?? "").length, insert: formatTable(edit.table).text },
      userEvent: "input.table",
    });
  }
  focusCell(view, from, edit.cursor.row, edit.cursor.col, edit.selectCell ? "all" : "end");
}

/** Runs a table operation on the focused cell; false if no cell of the editor is focused. */
export function runOnFocusedCell(view: EditorView, operation: (table: Table, at: CellPos) => Edit | null): boolean {
  const cell = focusedCell(view);
  const dom = cell?.closest<TableDom>(".rme-table-editor");
  if (!cell || !dom) {
    return false;
  }
  const table = parseTable(dom.rmeText ?? "");
  const { row, col } = positionOf(cell);
  apply(view, dom, operation(table, { row, col, offset: 0 }), table);
  return true;
}

/** Where a cell's row starts in the document, with the row's text and the cell's range in it. */
function cellLocation(view: EditorView, dom: TableDom, cell: HTMLElement) {
  const { row, col } = positionOf(cell);
  const lines = (dom.rmeText ?? "").split("\n");
  const tableFrom = view.posAtDOM(dom);
  const lineFrom = tableFrom + lines.slice(0, row).reduce((n, line) => n + line.length + 1, 0);
  return { row, col, tableFrom, lineFrom, line: lines[row], range: cellRange(lines[row], col) };
}

/** Writes the text of a cell into the source, changing only that cell. */
function onInput(view: EditorView, dom: TableDom, cell: HTMLElement): void {
  let value = cell.textContent ?? "";
  if (/[\r\n]/.test(value)) {
    value = value.replace(/[\r\n]+/g, " ");
    cell.textContent = value;
    placeCaret(cell, "end");
  }
  const text = dom.rmeText ?? "";
  const { row, col, tableFrom: from, lineFrom, line, range } = cellLocation(view, dom, cell);
  typingCell = cell;
  try {
    if (range) {
      // Replace what this cell wrote before, including spaces at its end, which
      // the source does not count as cell text, but never the next "|".
      const pipe = line.indexOf("|", range.to);
      const end = pipe < 0 ? line.length : pipe;
      const written = Math.min(Number(cell.dataset.written ?? 0), end - range.from);
      const start = lineFrom + range.from;
      const old = view.state.doc.sliceString(start, Math.max(start + written, lineFrom + range.to));
      // Only the difference, like typing in the text, so undo groups it the same way.
      const change = minimalChange(old, value);
      view.dispatch({
        changes: { from: start + change.from, to: start + change.to, insert: change.insert },
        userEvent: "input.type",
        // Typing that starts in a cell is an undo step of its own.
        annotations: cell.dataset.written === undefined ? isolateHistory.of("before") : [],
      });
      cell.dataset.written = String(value.length);
    } else {
      // A cell the row does not have yet.
      const table = parseTable(text);
      const cells = table.rows[row].cells;
      while (cells.length <= col) {
        cells.push("");
      }
      cells[col] = value;
      view.dispatch({
        changes: { from, to: from + text.length, insert: formatTable(table).text },
        userEvent: "input.table",
      });
    }
  } finally {
    typingCell = null;
  }
}

/** A "|" outside of "[[ link | name ]]" would split the cell, so it is not typed. */
/** Whether the caret is inside "[[ ... ]]": only there a "|" does not split the cell (see splitRow()). */
function insideLink(cell: HTMLElement): boolean {
  const text = cell.textContent ?? "";
  const offset = caretOffset(cell) ?? 0;
  const before = text.slice(0, offset);
  const after = text.slice(offset);
  const close = after.indexOf("]]");
  return before.lastIndexOf("[[") > before.lastIndexOf("]]") && close >= 0 && !after.slice(0, close).includes("[[");
}

function onKeyDown(view: EditorView, dom: TableDom, cell: HTMLElement, event: KeyboardEvent): void {
  const table = parseTable(dom.rmeText ?? "");
  const { row, col } = positionOf(cell);
  const at = { row, col, offset: 0 };
  const rows = shownRows(table);
  const shown = rows.indexOf(row);
  const mod = event.ctrlKey || event.metaKey;
  const handled = () => {
    event.preventDefault();
    event.stopPropagation();
  };

  if (event.key === "Tab" && !mod && !event.altKey) {
    handled();
    apply(view, dom, event.shiftKey ? previousCell(table, at) : nextCell(table, at), table);
  } else if (event.key === "Enter" && mod) {
    handled();
    const textarea = view.state.facet(hostTextarea);
    if (textarea) {
      submitForm(textarea);
    }
  } else if (event.key === "Enter") {
    handled();
    if (event.shiftKey) {
      return;
    }
    if (shown === rows.length - 1 && isEmptyRow(table.rows[row]) && rows.length > 1) {
      // Enter in an empty last row removes it and leaves the table.
      const rest = { ...table, rows: table.rows.filter((_, i) => i !== row) };
      const from = view.posAtDOM(dom);
      const textAfter = formatTable(rest).text;
      view.dispatch({ changes: { from, to: from + (dom.rmeText ?? "").length, insert: textAfter } });
      leave(view, dom, true);
      return;
    }
    apply(view, dom, insertRow(table, at, true), table);
  } else if ((event.key === "ArrowUp" || event.key === "ArrowDown") && event.altKey && !mod) {
    handled();
    apply(view, dom, moveRow(table, at, event.key === "ArrowUp" ? -1 : 1), table);
  } else if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !mod && !event.shiftKey) {
    handled();
    const target = rows[shown + (event.key === "ArrowUp" ? -1 : 1)];
    if (target === undefined) {
      leave(view, dom, event.key === "ArrowDown");
    } else {
      focusCell(view, view.posAtDOM(dom), target, col, "end");
    }
  } else if (event.key === "ArrowLeft" && !mod && !event.shiftKey && caretOffset(cell) === 0) {
    if (col > 0 || shown > 0) {
      handled();
      const target = col > 0 ? { row, col: col - 1 } : { row: rows[shown - 1], col: columnCount(table) - 1 };
      focusCell(view, view.posAtDOM(dom), target.row, target.col, "end");
    }
  } else if (
    event.key === "ArrowRight" &&
    !mod &&
    !event.shiftKey &&
    caretOffset(cell) === (cell.textContent ?? "").length
  ) {
    const last = col === columnCount(table) - 1;
    if (!last || shown < rows.length - 1) {
      handled();
      const target = last ? { row: rows[shown + 1], col: 0 } : { row, col: col + 1 };
      focusCell(view, view.posAtDOM(dom), target.row, target.col, "start");
    }
  } else if (event.key === "Escape") {
    handled();
    leave(view, dom, true);
  } else if (mod && !event.altKey && /^[zy]$/i.test(event.key)) {
    // The editor's undo history, not the cell's.
    handled();
    (event.key.toLowerCase() === "y" || event.shiftKey ? redo : undo)(view);
  } else if (matchesKey(event, "Mod-a")) {
    // The text of the cell, not the whole page.
    handled();
    placeCaret(cell, "all");
  } else if (INLINE_FORMATS.some((f) => matchesKey(event, f.key)) || matchesKey(event, "Mod-k")) {
    // The formatting shortcuts write remarkup, like the toolbar buttons.
    handled();
    const format = INLINE_FORMATS.find((f) => matchesKey(event, f.key));
    formatFocusedCell(view, format ? format.icon : "fa-link");
  } else if (mod && /^[biu]$/i.test(event.key)) {
    // No rich text in cells; their text is remarkup.
    handled();
  } else if (event.key === "|" && !insideLink(cell)) {
    handled();
  } else if (event.key === "[" && !mod && (cell.textContent ?? "").charAt((caretOffset(cell) ?? 0) - 1) === "[") {
    // "[[" opens a link: closed right away, so its "|" can be typed.
    handled();
    document.execCommand("insertText", false, "[]]");
    const end = caretOffset(cell) ?? 0;
    selectText(cell, end - 2, end - 2);
  }
}

/** The selection in a cell, as offsets in its text. */
function selectionIn(cell: HTMLElement): [number, number] | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !cell.contains(selection.getRangeAt(0).startContainer)) {
    return null;
  }
  const range = selection.getRangeAt(0);
  const offset = (node: Node, at: number) => {
    const before = document.createRange();
    before.selectNodeContents(cell);
    before.setEnd(node, at);
    return before.toString().length;
  };
  return [offset(range.startContainer, range.startOffset), offset(range.endContainer, range.endOffset)];
}

/** The link button in a cell: changes the link the selection is in, or links the selection, like in the text. */
function linkInCell(view: EditorView, cell: HTMLElement): void {
  const [from, to] = selectionIn(cell) ?? [0, 0];
  const text = cell.textContent ?? "";
  const replace = (start: number, end: number) => (insert: string) => {
    cell.focus();
    selectText(cell, start, end);
    document.execCommand("insertText", false, insert);
  };
  const link = findLinks(text).find((l) => from >= l.from && to <= l.to);
  if (link) {
    changeLink(view, link, cell, replace(link.from, link.to));
  } else {
    addLink(view, text.slice(from, to), cell, replace(from, to));
  }
}

/** The bubble of the link the caret is in, in a cell: like the one in the text (links.ts). */
let cellBubble: HTMLElement | null = null;

function hideCellBubble(): void {
  cellBubble?.remove();
  cellBubble = null;
}

function showCellBubble(view: EditorView, cell: HTMLElement): void {
  hideCellBubble();
  const offset = caretOffset(cell);
  const link = offset === null ? null : findLinks(cell.textContent ?? "").find((l) => offset > l.from && offset < l.to);
  if (!link) {
    return;
  }
  // Typed into the cell, so the source changes like when typing.
  const replace = (text: string) => {
    cell.focus();
    selectText(cell, link.from, link.to);
    document.execCommand("insertText", false, text);
  };
  const bubble = linkBubble(
    link,
    () => changeLink(view, link, cell, replace),
    () => replace(unlinked(link)),
  );
  bubble.classList.add("cm-tooltip", "rme-cell-bubble");
  const box = cell.getBoundingClientRect();
  const base = view.dom.getBoundingClientRect();
  bubble.style.left = `${box.left - base.left}px`;
  bubble.style.top = `${box.bottom - base.top + 2}px`;
  view.dom.append(bubble);
  cellBubble = bubble;
}

/**
 * "+" buttons on the borders of a table, shown when the mouse is near a
 * border: on the left border between rows, on the top border between
 * columns. A click inserts a row or column there.
 */
function insertHandles(view: EditorView, dom: TableDom): void {
  const handle = (kind: "row" | "column") => {
    const button = document.createElement("a");
    button.href = "#";
    button.className = `rme-table-insert rme-table-insert-${kind}`;
    button.hidden = true;
    button.title = kind === "row" ? "Insert a row here" : "Insert a column here";
    button.setAttribute("aria-label", button.title);
    // Keep the focus where it is.
    button.addEventListener("mousedown", (event) => event.preventDefault());
    dom.append(button);
    return button;
  };
  const rowHandle = handle("row");
  const columnHandle = handle("column");
  // Where a click inserts: below a row (or above the first), right of a column (or left of the first).
  let rowAt: { row: number; below: boolean } | null = null;
  let columnAt: { col: number; right: boolean } | null = null;
  const NEAR = 8;

  dom.addEventListener("mousemove", (event) => {
    if ((event.target as Element).closest(".rme-table-insert")) {
      return;
    }
    const table = dom.querySelector("table")!.getBoundingClientRect();
    const base = dom.getBoundingClientRect();
    const rows = Array.from(dom.querySelectorAll<HTMLElement>("tr"));
    rowAt = null;
    columnAt = null;
    if (event.clientX - table.left < 24 && rows.length) {
      const edges = [rows[0].getBoundingClientRect().top, ...rows.map((tr) => tr.getBoundingClientRect().bottom)];
      const k = edges.findIndex((y) => Math.abs(event.clientY - y) < NEAR);
      if (k >= 0) {
        rowAt =
          k === 0
            ? { row: Number(rows[0].dataset.row), below: false }
            : { row: Number(rows[k - 1].dataset.row), below: true };
        rowHandle.style.left = `${table.left - base.left - 9}px`;
        rowHandle.style.top = `${edges[k] - base.top - 9}px`;
      }
    }
    const cells = Array.from(rows[0]?.children ?? []) as HTMLElement[];
    if (event.clientY - table.top < 20 && cells.length) {
      const edges = [cells[0].getBoundingClientRect().left, ...cells.map((c) => c.getBoundingClientRect().right)];
      const k = edges.findIndex((x) => Math.abs(event.clientX - x) < NEAR);
      if (k >= 0) {
        columnAt = k === 0 ? { col: 0, right: false } : { col: k - 1, right: true };
        columnHandle.style.left = `${edges[k] - base.left - 9}px`;
        columnHandle.style.top = `${table.top - base.top - 9}px`;
      }
    }
    rowHandle.hidden = !rowAt;
    columnHandle.hidden = !columnAt;
  });
  dom.addEventListener("mouseleave", () => {
    rowHandle.hidden = true;
    columnHandle.hidden = true;
  });
  rowHandle.addEventListener("click", (event) => {
    event.preventDefault();
    if (rowAt) {
      const table = parseTable(dom.rmeText ?? "");
      apply(view, dom, insertRow(table, { row: rowAt.row, col: 0, offset: 0 }, rowAt.below), table);
    }
  });
  columnHandle.addEventListener("click", (event) => {
    event.preventDefault();
    if (columnAt) {
      const table = parseTable(dom.rmeText ?? "");
      const first = shownRows(table)[0] ?? 0;
      apply(view, dom, insertColumn(table, { row: first, col: columnAt.col, offset: 0 }, columnAt.right), table);
    }
  });
}

export class TableWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly html: string | undefined,
  ) {
    super();
  }

  override eq(other: TableWidget): boolean {
    return other.text === this.text && other.html === this.html;
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement("div") as TableDom;
    dom.className = "rme-block rme-block-table rme-table-editor phabricator-remarkup";
    const wrap = document.createElement("div");
    wrap.className = "remarkup-table-wrap";
    const table = document.createElement("table");
    table.className = "remarkup-table";
    table.append(document.createElement("tbody"));
    wrap.append(table);
    dom.append(wrap);

    const cellOf = (event: Event) => (event.target as Element).closest<HTMLElement>("th, td");
    dom.addEventListener("focusin", (event) => {
      const cell = cellOf(event);
      if (cell) {
        cell.dataset.editing = "1";
        delete cell.dataset.written;
        const { row, col } = positionOf(cell);
        const source = parseTable(dom.rmeText ?? "").rows[row]?.cells[col] ?? "";
        if (cell.textContent !== source || cell.children.length) {
          cell.textContent = source;
          placeCaret(cell, "end");
        }
      }
    });
    dom.addEventListener("focusout", (event) => {
      const cell = cellOf(event);
      if (cell) {
        hideCellBubble();
        delete cell.dataset.editing;
        sync(dom, dom.rmeText ?? "", dom.rmeHtml);
      }
    });
    dom.addEventListener("input", (event) => {
      const cell = cellOf(event);
      if (cell) {
        onInput(view, dom, cell);
        showCellBubble(view, cell);
      }
    });
    // The caret moved: in a link, its bubble shows.
    for (const type of ["keyup", "mouseup"]) {
      dom.addEventListener(type, (event) => {
        const cell = cellOf(event);
        if (cell) {
          setTimeout(() => document.activeElement === cell && showCellBubble(view, cell));
        }
      });
    }
    dom.addEventListener("keydown", (event) => {
      const cell = cellOf(event);
      if (cell) {
        onKeyDown(view, dom, cell, event);
      }
    });
    dom.addEventListener("paste", (event) => {
      // Plain text on one line.
      event.preventDefault();
      const text = (event.clipboardData?.getData("text/plain") ?? "").replace(/[\r\n]+/g, " ");
      document.execCommand("insertText", false, text);
    });
    dom.addEventListener("mousedown", (event) => {
      // A click beside the table edits the nearest cell of the row at that height.
      if (event.button !== 0 || cellOf(event) || (event.target as Element).closest(".rme-table-insert")) {
        return;
      }
      event.preventDefault();
      const rows = Array.from(dom.querySelectorAll<HTMLElement>("tr"));
      const row = rows.find((tr) => event.clientY < tr.getBoundingClientRect().bottom) ?? rows[rows.length - 1];
      const cells = Array.from(row?.children ?? []) as HTMLElement[];
      const target = cells.find((td) => event.clientX < td.getBoundingClientRect().right) ?? cells[cells.length - 1];
      if (target) {
        target.focus();
        placeCaret(target, "end");
      }
    });
    dom.addEventListener("click", openLinkOnModClick);
    insertHandles(view, dom);

    sync(dom, this.text, this.html);
    return dom;
  }

  override updateDOM(dom: HTMLElement): boolean {
    sync(dom as TableDom, this.text, this.html);
    return true;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** The focused table cell of the editor, if any. */
export function focusedCell(view: EditorView): HTMLElement | null {
  const cell = document.activeElement;
  return cell instanceof HTMLElement && cell.closest(".rme-table-editor") && view.contentDOM.contains(cell)
    ? cell
    : null;
}

/** Buttons that insert text; in a cell only the formatting ones apply. */
const INSERTING = new Set([
  ...INLINE_FORMATS.map((f) => f.icon),
  "fa-link",
  "fa-list-ul",
  "fa-list-ol",
  "fa-code",
  "fa-quote-right",
  "fa-table",
  "fa-cloud-upload",
  "fa-meh-o",
  "fa-header",
  "fa-check-square-o",
  "fa-sticky-note-o",
  "fa-minus",
]);

function selectText(cell: HTMLElement, from: number, to: number): void {
  const node = cell.firstChild;
  if (node?.nodeType !== Node.TEXT_NODE) {
    return;
  }
  const range = document.createRange();
  range.setStart(node, from);
  range.setEnd(node, to);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/**
 * Applies a toolbar button to the selection in the focused cell, like it acts
 * on the selection in the text. Returns false if the button does not insert
 * text or no cell is focused, so the button does its usual work.
 */
export function formatFocusedCell(view: EditorView, icon: string): boolean {
  const cell = focusedCell(view);
  if (!cell || !INSERTING.has(icon)) {
    return false;
  }
  if (icon === "fa-link") {
    linkInCell(view, cell);
    return true;
  }
  const selected = window.getSelection()?.toString() ?? "";
  const format = INLINE_FORMATS.find((f) => f.icon === icon);
  let before: string;
  let inner: string;
  let after: string;
  if (format) {
    [before, inner, after] = [format.marker, selected || format.placeholder, format.marker];
  } else {
    // Lists, blocks and uploads have no place in a cell.
    return true;
  }
  document.execCommand("insertText", false, before + inner + after);
  const end = caretOffset(cell) ?? (cell.textContent ?? "").length;
  selectText(cell, end - after.length - inner.length, end - after.length);
  return true;
}

/**
 * The position in the source of the focused cell's text, with the start of
 * its table; null if no cell is focused.
 */
export function focusedCellSource(view: EditorView): { pos: number; tableFrom: number } | null {
  const cell = focusedCell(view);
  const dom = cell?.closest<TableDom>(".rme-table-editor");
  if (!cell || !dom) {
    return null;
  }
  const { tableFrom, lineFrom, line, range } = cellLocation(view, dom, cell);
  return { pos: lineFrom + (range ? range.to : line.length), tableFrom };
}
