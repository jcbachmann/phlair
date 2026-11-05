// Tables shown and edited as tables, with Phorge's table markup and CSS.
//
// A table that the text cursor is not in is a TableWidget. Its cells show
// their rendered content; the cell being edited has an editor of its own
// (editCell()) with the cell's remarkup, like a line of the text. Typing in a
// cell changes only that cell's text in the source; structural changes
// (rows, columns, header) rewrite the table aligned.

import { isolateHistory, redo, undo } from "@codemirror/commands";
import { EditorSelection, EditorState, Prec } from "@codemirror/state";
import { standardKeymap } from "@codemirror/commands";
import { EditorView, keymap, WidgetType } from "@codemirror/view";
import { minimalChange } from "../diff";
import { submitForm } from "../phorge";
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
import { hasText, uploadFiles } from "./upload";
import { cellSupport, openLinkOnModClick, type TableMode, tableModeField } from "./livePreview";
import { parseHtml, setHtml } from "../html";

interface TableDom extends HTMLElement {
  /** The source text of the table, as of the last update. */
  rmeText?: string;
  rmeHtml?: string;
  rmeMode?: TableMode;
}

/**
 * The editors of the cells being edited, by cell: a CodeMirror editor of the
 * cell's source, with the live preview of the text (only what the cursor is
 * on shows its source). Its text is written into the table like typing in
 * the text (onInput()).
 */
const cellEditors = new WeakMap<HTMLElement, EditorView>();

/** The cell being edited, if any. */
let editedCell: { dom: TableDom; cell: HTMLElement } | null = null;

/**
 * Whether an event happened in a cell's editor. By the path of the event when
 * it happened: the editor's handlers may have removed its target meanwhile
 * (e.g. a rendered link, which then shows its source).
 */
function inCellEditor(event: Event): boolean {
  return event.composedPath().some((node) => node instanceof Element && node.classList.contains("rme-cell-editor"));
}

/** While the text of a cell's editor is set from the source: not written back. */
let settingCell = false;

/** A cell's text: of its editor, or of the cell. */
function cellText(cell: HTMLElement): string {
  return cellEditors.get(cell)?.state.doc.toString() ?? cell.textContent ?? "";
}

/** The selection in a cell being edited, as offsets in its text. */
function cellSelection(cell: HTMLElement): [number, number] | null {
  const editor = cellEditors.get(cell);
  if (!editor) {
    return null;
  }
  const { from, to } = editor.state.selection.main;
  return [from, to];
}

/** Replaces text of a cell being edited like typing. */
function replaceInCell(cell: HTMLElement, from: number, to: number, insert: string): void {
  const editor = cellEditors.get(cell);
  editor?.focus();
  editor?.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
    userEvent: "input",
  });
}

/**
 * "[[" typed in a cell is closed right away: a "|" outside of a link would
 * split the cell, so the one of "[[ target | name ]]" can only be typed in a
 * closed link. Typed as two changes, so the completion of pages ("[[")
 * starts like in the text and does not take the "]]" in.
 */
const closeLinks = EditorView.inputHandler.of((view, from, to, text) => {
  const { state } = view;
  if (text !== "[" || state.sliceDoc(from - 1, from) !== "[" || state.sliceDoc(to, to + 2) === "]]") {
    return false;
  }
  view.dispatch({ changes: { from, to, insert: "[" }, selection: { anchor: from + 1 }, userEvent: "input.type" });
  view.dispatch({
    changes: { from: from + 1, insert: "]]" },
    selection: EditorSelection.cursor(from + 1),
    userEvent: "input.close",
  });
  return true;
});

/** Starts the editor of a cell, and puts its cursor at a place or where the mouse is. */
function editCell(
  view: EditorView,
  dom: TableDom,
  cell: HTMLElement,
  where: "start" | "end" | "all" | { x: number; y: number },
): void {
  // One cell at a time: the one edited before ends now, not when it notices losing the focus.
  if (editedCell && editedCell.cell !== cell) {
    stopEditing(editedCell.dom, editedCell.cell);
  }
  let editor = cellEditors.get(cell);
  if (!editor) {
    const { row, col } = positionOf(cell);
    const source = parseTable(dom.rmeText ?? "").rows[row]?.cells[col] ?? "";
    cell.dataset.editing = "1";
    delete cell.dataset.written;
    cell.replaceChildren();
    const support = view.state.facet(cellSupport);
    editor = new EditorView({
      parent: cell,
      state: EditorState.create({
        doc: source,
        extensions: [
          EditorView.lineWrapping,
          EditorView.editorAttributes.of({ class: "rme-cell-editor" }),
          EditorView.contentAttributes.of({ class: "phabricator-remarkup", "aria-label": "Table cell" }),
          support ? support.extensions(view) : [],
          closeLinks,
          // Keys of the table (Tab, Enter, arrows at the ends, Escape, undo, …) go to it (onKeyDown()).
          Prec.low(
            keymap.of(
              standardKeymap.filter(
                (binding) =>
                  !["ArrowUp", "ArrowDown", "Enter", "Mod-Enter", "PageUp", "PageDown"].includes(binding.key!),
              ),
            ),
          ),
          // One line, and "|" only in "[[ link | name ]]": else it would split the cell.
          EditorState.transactionFilter.of((tr) => {
            if (!tr.docChanged || settingCell) {
              return tr;
            }
            const text = tr.newDoc.toString();
            if (!/[\r\n]/.test(text) && !/\|/.test(text.replace(/\[\[[^\]]*\]\]/g, ""))) {
              return tr;
            }
            return [];
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !settingCell) {
              onInput(view, dom, cell, update.state.doc.toString());
            }
          }),
          EditorView.domEventHandlers({
            paste(event, editor) {
              const data = event.clipboardData;
              if (data?.files.length && !hasText(data)) {
                event.preventDefault();
                void uploadToCell(view, cell, Array.from(data.files));
                return true;
              }
              // Plain text on one line, "|" not splitting the cell; a URL over selected text links it.
              event.preventDefault();
              const text = (data?.getData("text/plain") ?? "").replace(/[\r\n]+/g, " ").replace(/\|/g, "¦");
              if (!support?.linkSelection(editor, text.trim())) {
                editor.dispatch(editor.state.replaceSelection(text), { userEvent: "input.paste" });
              }
              return true;
            },
            blur() {
              // Unless the focus stays in the cell, or goes to a search for it
              // (link, reference, image macro) or one of Phorge's dialogs (upload, meme).
              setTimeout(() => {
                const focus = document.activeElement;
                if (!cell.contains(focus) && !focus?.closest(".rme-picker, .jx-client-dialog")) {
                  stopEditing(dom, cell);
                }
              });
              return false;
            },
          }),
        ],
      }),
    });
    cellEditors.set(cell, editor);
    editedCell = { dom, cell };
  }
  editor.focus();
  const length = editor.state.doc.length;
  const anchor =
    typeof where === "object"
      ? (editor.posAtCoords(where) ?? length)
      : where === "start"
        ? 0
        : where === "all"
          ? 0
          : length;
  editor.dispatch({ selection: { anchor, head: where === "all" ? length : anchor } });
}

/** Updates the live preview of the cell being edited, e.g. when renderings arrive. */
export function refreshCellEditor(): void {
  cellEditors.get(editedCell?.cell as HTMLElement)?.dispatch({});
}

/** Ends the editor of a cell: it shows rendered again. */
function stopEditing(dom: TableDom, cell: HTMLElement): void {
  const editor = cellEditors.get(cell);
  if (!editor) {
    return;
  }
  if (editedCell?.cell === cell) {
    editedCell = null;
  }
  cellEditors.delete(cell);
  editor.destroy();
  delete cell.dataset.editing;
  delete cell.dataset.source;
  cell.textContent = "";
  sync(dom, dom.rmeText ?? "", dom.rmeHtml);
}

/** The cell the user is typing in; updates must not overwrite its text. */
let typingCell: HTMLElement | null = null;

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
          // Edited in an editor of their own (editCell()).
          cell.contentEditable = "false";
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
      const editor = cellEditors.get(cell);
      if (editor) {
        // Only text changed elsewhere (e.g. undo) replaces what is typed (spaces
        // being typed at the end are not in the source yet); the live preview
        // updates (renderings).
        settingCell = true;
        try {
          const text = editor.state.doc.toString();
          if (text.trim() !== source) {
            // What the cell wrote is gone, so is the length it wrote.
            delete cell.dataset.written;
          }
          editor.dispatch(
            text.trim() === source
              ? {}
              : { changes: { from: 0, to: text.length, insert: source }, selection: { anchor: source.length } },
          );
        } finally {
          settingCell = false;
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

/** The keys a cell's editor leaves to the table: see onKeyDown(). */
const TABLE_KEYS = /^(Tab|Enter|Escape|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|z|Z|y|Y)$/;

/** Offset of the caret in a cell's text, or null if the selection is not a caret in it. */
function cellCaret(cell: HTMLElement): number | null {
  const range = cellEditors.get(cell)?.state.selection.main;
  return range?.empty ? range.head : null;
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
  if (dom && cell instanceof HTMLElement) {
    editCell(view, dom, cell, where);
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
function onInput(view: EditorView, dom: TableDom, cell: HTMLElement, typed: string): void {
  // Firefox may type a space as a no-break space; the source gets a space.
  const value = typed.replace(/\u00a0/g, " ");
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

/** The keys of the table in a cell (TABLE_KEYS): moving between cells, rows, undo, … */
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
  } else if (event.key === "ArrowLeft" && !mod && !event.shiftKey && cellCaret(cell) === 0) {
    if (col > 0 || shown > 0) {
      handled();
      const target = col > 0 ? { row, col: col - 1 } : { row: rows[shown - 1], col: columnCount(table) - 1 };
      focusCell(view, view.posAtDOM(dom), target.row, target.col, "end");
    }
  } else if (event.key === "ArrowRight" && !mod && !event.shiftKey && cellCaret(cell) === cellText(cell).length) {
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
  }
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
    readonly mode: TableMode = "table",
  ) {
    super();
  }

  override eq(other: TableWidget): boolean {
    return other.text === this.text && other.html === this.html && other.mode === this.mode;
  }

  override updateDOM(dom: HTMLElement): boolean {
    if ((dom as TableDom).rmeMode !== this.mode) {
      return false;
    }
    sync(dom as TableDom, this.text, this.html);
    return true;
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement("div") as TableDom;
    dom.rmeMode = this.mode;
    dom.className = "rme-block rme-block-table rme-table-editor phabricator-remarkup";
    const wrap = document.createElement("div");
    wrap.className = "remarkup-table-wrap";
    const table = document.createElement("table");
    table.className = "remarkup-table";
    table.append(document.createElement("tbody"));
    wrap.append(table);
    dom.append(wrap);

    // By the path of the event when it happened (see inCellEditor()).
    const cellOf = (event: Event) =>
      (event.composedPath().find((node) => node instanceof HTMLElement && /^T[DH]$/.test(node.tagName)) as
        HTMLElement | undefined) ?? null;
    dom.addEventListener("focusin", (event) => {
      const cell = cellOf(event);
      // The cell itself, e.g. by the keyboard: its editor.
      if (cell && !inCellEditor(event)) {
        editCell(view, dom, cell, "end");
      }
    });
    dom.addEventListener("keydown", (event) => {
      const cell = cellOf(event);
      // The keys of the table that the cell's editor leaves.
      if (cell && inCellEditor(event) && !event.defaultPrevented && TABLE_KEYS.test(event.key)) {
        onKeyDown(view, dom, cell, event);
      }
    });
    // Files dropped on the table go in the cell they are dropped on, or the nearest.
    dom.addEventListener("dragover", (event) => {
      if (event.dataTransfer?.types.includes("Files")) {
        event.preventDefault();
      }
    });
    dom.addEventListener("drop", (event) => {
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (!files.length) {
        return;
      }
      event.preventDefault();
      const cell = cellOf(event) ?? nearestCell(dom, event);
      if (cell) {
        focusCell(view, view.posAtDOM(dom), positionOf(cell).row, positionOf(cell).col, "end");
        void uploadToCell(view, cell, files);
      }
    });
    dom.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || (event.target as Element).closest(".rme-table-insert") || inCellEditor(event)) {
        return;
      }
      const clicked = cellOf(event);
      if (clicked) {
        // The cell's editor, with the cursor where the click is (Ctrl+click opens links).
        if (!(event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          editCell(view, dom, clicked, { x: event.clientX, y: event.clientY });
        }
        return;
      }
      // A click beside the table edits the nearest cell of the row at that height.
      event.preventDefault();
      const target = nearestCell(dom, event);
      if (target) {
        focusCell(view, view.posAtDOM(dom), positionOf(target).row, positionOf(target).col, "end");
      }
    });
    dom.addEventListener("click", openLinkOnModClick);
    insertHandles(view, dom);

    sync(dom, this.text, this.html);
    return dom;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** The cell of a table nearest to the mouse: of the row at its height, the column at its place. */
function nearestCell(dom: HTMLElement, event: MouseEvent): HTMLElement | null {
  const rows = Array.from(dom.querySelectorAll<HTMLElement>("tr"));
  const row = rows.find((tr) => event.clientY < tr.getBoundingClientRect().bottom) ?? rows[rows.length - 1];
  const cells = Array.from(row?.children ?? []) as HTMLElement[];
  return cells.find((td) => event.clientX < td.getBoundingClientRect().right) ?? cells[cells.length - 1] ?? null;
}

/**
 * Uploads files into a cell, at the caret: placeholders typed into the cell
 * (so they are in its text like typing), then replaced by the references
 * of the files, separated by spaces.
 */
function uploadToCell(view: EditorView, cell: HTMLElement, files: File[]): Promise<void> {
  return uploadFiles(view, files, (placeholder, after) => {
    if (after !== null) {
      view.dispatch({ changes: { from: after, insert: ` ${placeholder}` }, userEvent: "input.upload" });
    } else if (cell.isConnected) {
      const [from, to] = cellSelection(cell) ?? [cellText(cell).length, cellText(cell).length];
      replaceInCell(cell, from, to, placeholder);
    } else {
      // The cell is gone (e.g. its row was deleted meanwhile): the file goes at the end.
      const end = view.state.doc.length;
      view.dispatch({ changes: { from: end, insert: `\n\n${placeholder}` }, userEvent: "input.upload" });
    }
  });
}

/**
 * Phorge's upload button puts the references of its files where the
 * textarea's selection is: in a cell, there the selection in the cell is
 * (in the source, which shows in the cell being edited).
 */
function selectCellInTextarea(view: EditorView, cell: HTMLElement): void {
  const dom = cell.closest<TableDom>(".rme-table-editor");
  const textarea = view.state.facet(hostTextarea);
  if (!dom || !textarea) {
    return;
  }
  const [from, to] = cellSelection(cell) ?? [cellText(cell).length, cellText(cell).length];
  let location = cellLocation(view, dom, cell);
  if (!location.range) {
    // A cell the row does not have yet: written first.
    onInput(view, dom, cell, cellText(cell));
    location = cellLocation(view, dom, cell);
  }
  const { lineFrom, range } = location;
  if (range) {
    const at = (offset: number) => lineFrom + Math.min(range.from + offset, range.to);
    textarea.setSelectionRange(at(from), at(to));
  }
}

/** The focused table cell of the editor, if any. */
export function focusedCell(view: EditorView): HTMLElement | null {
  // The editor in the cell.
  const cell = document.activeElement?.closest<HTMLElement>("th, td");
  return cell?.closest(".rme-table-editor") && view.contentDOM.contains(cell) ? cell : null;
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

/**
 * Applies a toolbar button to the selection in the focused cell, like it acts
 * on the selection in the text. Returns false if the button does not insert
 * text or no cell is focused, so the button does its usual work.
 */
export function formatFocusedCell(view: EditorView, icon: string): boolean {
  const cell = focusedCell(view);
  const editor = cell && cellEditors.get(cell);
  if (!cell || !editor || !INSERTING.has(icon)) {
    return false;
  }
  if (icon === "fa-cloud-upload" || icon === "fa-meh-o") {
    // Phorge's upload or meme dialog does the rest.
    selectCellInTextarea(view, cell);
    return false;
  }
  // Like in the text; lists and blocks have no place in a cell.
  const command = view.state.facet(cellSupport)?.format(icon);
  if (command) {
    editor.focus();
    command(editor);
  }
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
