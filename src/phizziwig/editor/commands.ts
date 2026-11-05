// Keyboard commands and the table toolbar.

import { EditorSelection, type EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { insertNewlineAndIndent } from "@codemirror/commands";
import type { Block } from "../blocks";
import {
  type CellPos,
  deleteColumn,
  deleteRow,
  type Edit,
  formatTable,
  insertColumn,
  insertRow,
  isEmptyRow,
  locate,
  moveColumn,
  moveRow,
  nextCell,
  offsetOf,
  parseTable,
  previousCell,
  type Table,
  toggleHeader,
} from "../table";
import { CONTROL, TOOLBAR } from "../phorge";
import { LIST_ITEM, QUOTE_LINE } from "../syntax";
import { toolbarButton } from "../toolbar";
import { hostTextarea } from "./host";
import { blockAtCursor, clicked, inListBlock, previewField, switchTableMode, tableModeField } from "./livePreview";
import { focusCell, focusedCell, focusedCellSource, runOnFocusedCell } from "./tableEditor";

interface TableContext {
  block: Block;
  table: Table;
  at: CellPos;
}

function tableAt(state: EditorState): TableContext | null {
  const block = blockAtCursor(state, "table");
  if (!block) {
    return null;
  }
  const text = state.doc.sliceString(block.from, block.contentTo);
  return { block, table: parseTable(text), at: locate(text, state.selection.main.head - block.from) };
}

function applyTableEdit(view: EditorView, block: Block, edit: Edit | null): boolean {
  if (!edit) {
    return true;
  }
  const { text } = formatTable(edit.table);
  const anchor = block.from + offsetOf(edit.table, edit.cursor);
  const row = edit.table.rows[edit.cursor.row];
  const cell = edit.selectCell && !row.separator ? (row.cells[edit.cursor.col] ?? "") : "";
  view.dispatch({
    changes: { from: block.from, to: block.contentTo, insert: text },
    selection: EditorSelection.single(anchor, anchor + cell.length),
    scrollIntoView: true,
    userEvent: "input.table",
  });
  return true;
}

/** Wraps a table operation as a command for the focused cell or the table source. */
function tableCommand(operation: (table: Table, at: CellPos) => Edit | null) {
  return (view: EditorView): boolean => {
    if (runOnFocusedCell(view, operation)) {
      return true;
    }
    const context = tableAt(view.state);
    if (!context) {
      return false;
    }
    return applyTableEdit(view, context.block, operation(context.table, context.at));
  };
}

const tableCommands = {
  nextCell: tableCommand(nextCell),
  previousCell: tableCommand(previousCell),
  rowAbove: tableCommand((t, at) => insertRow(t, at, false)),
  rowBelow: tableCommand((t, at) => insertRow(t, at, true)),
  columnLeft: tableCommand((t, at) => insertColumn(t, at, false)),
  columnRight: tableCommand((t, at) => insertColumn(t, at, true)),
  deleteRow: tableCommand(deleteRow),
  deleteColumn: tableCommand(deleteColumn),
  moveRowUp: tableCommand((t, at) => moveRow(t, at, -1)),
  moveRowDown: tableCommand((t, at) => moveRow(t, at, 1)),
  moveColumnLeft: tableCommand((t, at) => moveColumn(t, at, -1)),
  moveColumnRight: tableCommand((t, at) => moveColumn(t, at, 1)),
  toggleHeader: tableCommand(toggleHeader),
  format: tableCommand((table, at) => ({ table, cursor: at })),
};

/**
 * Inserts a table with a header row and empty rows, as a block of its own.
 * In table mode it opens as a table with its first header cell selected.
 */
export function insertTable(view: EditorView, columns: number, rows: number): boolean {
  const table: Table = {
    indent: "",
    trailingPipe: true,
    rows: [
      { cells: Array.from({ length: columns }, (_, i) => `Column ${i + 1}`), separator: false },
      { cells: new Array(columns).fill("---"), separator: true },
      ...Array.from({ length: rows }, () => ({ cells: new Array(columns).fill(""), separator: false })),
    ],
  };
  const text = formatTable(table).text;
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const empty = !line.text.trim();
  const from = empty ? line.from : line.to;
  const before = empty ? "" : "\n\n";
  const next = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null;
  // A blank line after the table, where the cursor goes.
  const after = next && !next.text.trim() ? "\n" : "\n\n";
  const start = from + before.length;
  const asTable = state.field(tableModeField) === "table";
  view.dispatch({
    changes: { from, to: empty ? line.to : from, insert: before + text + after },
    selection: asTable
      ? { anchor: start + text.length + 1 }
      : EditorSelection.range(start + 2, start + 2 + "Column 1".length),
    userEvent: "input.table",
    scrollIntoView: true,
  });
  if (asTable) {
    focusCell(view, start, 0, 0, "all");
  }
  return true;
}

/** Enter in a table adds a row; Enter in an empty last row leaves the table. */
function tableEnter(view: EditorView): boolean {
  const context = tableAt(view.state);
  if (!context) {
    return false;
  }
  const { block, table, at } = context;
  if (at.row === table.rows.length - 1 && isEmptyRow(table.rows[at.row]) && table.rows.length > 1) {
    const rows = table.rows.slice(0, -1);
    const text = formatTable({ ...table, rows }).text + "\n\n";
    view.dispatch({
      changes: { from: block.from, to: block.contentTo, insert: text },
      selection: { anchor: block.from + text.length },
      scrollIntoView: true,
      userEvent: "input.table",
    });
    return true;
  }
  return applyTableEdit(view, block, insertRow(table, at, true));
}

/**
 * Enter continues lists and quotes; on an empty item it ends them. At the
 * start of the text of a block's first line (a list, quote or header, whose
 * marker shows rendered), it makes room above the block, without a marker.
 */
function continueMarkup(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty) {
    return false;
  }
  const line = state.doc.lineAt(range.head);
  const block = blockAtCursor(state);
  const inList = block?.kind === "list";
  const item = inList ? LIST_ITEM.exec(line.text) : null;
  const quote = !item && block?.kind === "quote" ? QUOTE_LINE.exec(line.text) : null;
  const header = block?.kind === "header" ? /^(=+|#+)\s*/.exec(line.text) : null;
  const marker = item ? line.text.length - item[5].length : quote ? quote[1].length : header ? header[0].length : null;
  if (
    marker !== null &&
    block &&
    line.from === block.from &&
    range.head <= line.from + marker &&
    marker < line.length
  ) {
    view.dispatch({
      changes: { from: line.from, insert: "\n" },
      selection: { anchor: range.head + 1 },
      scrollIntoView: true,
      userEvent: "input",
    });
    return true;
  }
  if (!item && !quote) {
    return false;
  }
  const content = item ? item[5] : quote![2];
  if (content.trim() === "" && range.head === line.to) {
    // An empty item ends the list or quote: its line stays, empty, with the
    // cursor on it. At the end of the text, the cursor goes to a new line
    // after it, so what is typed next is not part of the last item.
    const insert = line.number === state.doc.lines ? "\n" : "";
    view.dispatch({
      changes: { from: line.from, to: line.to, insert },
      selection: { anchor: line.from + insert.length },
      userEvent: "delete",
    });
    return true;
  }
  let prefix: string;
  if (item) {
    const number = /^(\d+)([.)])$/.exec(item[2]);
    const marker = number ? `${Number(number[1]) + 1}${number[2]}` : item[2];
    prefix = item[1] + marker + item[3] + (item[4] ? "[ ] " : "");
  } else {
    prefix = quote![1];
  }
  view.dispatch(state.replaceSelection("\n" + prefix), { scrollIntoView: true, userEvent: "input" });
  return true;
}

/**
 * Backspace at the start of the text of a quote line, whose marker does not
 * show: removes the marker ("> ") instead of its space, which would seem to
 * do nothing, like Enter on an empty quote line does.
 */
function removeQuoteMarker(view: EditorView): boolean {
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty) {
    return false;
  }
  const line = state.doc.lineAt(range.head);
  const quote = blockAtCursor(state)?.kind === "quote" ? QUOTE_LINE.exec(line.text) : null;
  const marker = quote ? quote[1].length : 0;
  if (!marker || range.head !== line.from + marker) {
    return false;
  }
  view.dispatch({
    changes: { from: line.from, to: range.head },
    selection: { anchor: line.from },
    userEvent: "delete.backward",
  });
  return true;
}

/** A marker repeated for nesting, like "--" in "-- item", by its list item match. */
const repeatedMarker = (item: RegExpExecArray): boolean => /^(-{2,}|\*{2,}|#{2,})$/.test(item[2]);

/**
 * Tab and Shift+Tab indent and outdent list items: by two spaces, or in a
 * list nested by repeating markers ("- item", "-- nested"), by one marker.
 */
function indentListItem(view: EditorView, outdent: boolean): boolean {
  const { doc } = view.state;
  const list = blockAtCursor(view.state, "list");
  if (!list) {
    return false;
  }
  let repeated = false;
  for (let n = doc.lineAt(list.from).number; n <= doc.lineAt(list.contentTo).number; n++) {
    const item = LIST_ITEM.exec(doc.line(n).text);
    repeated ||= !!item && repeatedMarker(item);
  }
  const changes = [];
  for (const range of view.state.selection.ranges) {
    for (let n = doc.lineAt(range.from).number; n <= doc.lineAt(range.to).number; n++) {
      const line = doc.line(n);
      const item = LIST_ITEM.exec(line.text);
      if (!item) {
        continue;
      }
      if (repeated && /^([-*]+|#+)$/.test(item[2])) {
        const at = line.from + item[1].length;
        if (!outdent) {
          changes.push({ from: at, insert: item[2][0] });
        } else if (item[2].length > 1) {
          changes.push({ from: at, to: at + 1 });
        }
      } else if (!outdent) {
        changes.push({ from: line.from, insert: "  " });
      } else {
        // Not further out than the list's first item: "# item" at the start of a line is a header.
        const least = /^ */.exec(view.state.doc.lineAt(list.from).text)![0].length;
        const spaces = Math.min(2, /^ */.exec(line.text)![0].length - least);
        if (spaces > 0) {
          changes.push({ from: line.from, to: line.from + spaces });
        }
      }
    }
  }
  view.dispatch({ changes, userEvent: outdent ? "delete.dedent" : "input.indent" });
  return true;
}

/**
 * Home and End go to the start or end of the visual row of a wrapped line,
 * and when pressed there again, to the start or end of the whole line. In a
 * list item, Home goes to the start of its text first, after the marker and
 * checkbox, and from there to the start of the line.
 */
function lineBoundary(forward: boolean, extend: boolean) {
  return (view: EditorView): boolean => {
    const { state } = view;
    const selection = EditorSelection.create(
      state.selection.ranges.map((range) => {
        const line = state.doc.lineAt(range.head);
        const item = !forward && inListBlock(state, range.head) ? LIST_ITEM.exec(line.text) : null;
        const text = item ? line.from + line.text.length - item[5].length : null;
        // At the end of a wrapped row, the cursor keeps belonging to that row (its assoc).
        let target = view.moveToLineBoundary(range, forward, true);
        // Outside of hidden markers, like a click.
        const outside = clicked(view, target.head);
        if (outside !== target.head) {
          target = EditorSelection.cursor(outside, target.assoc);
        }
        if (text !== null && target.head < text) {
          // The first row of the item: its text starts after the marker.
          target = EditorSelection.cursor(text);
        }
        if (target.head === range.head) {
          target = EditorSelection.cursor(forward ? line.to : text !== null && target.head !== text ? text : line.from);
        }
        return extend ? EditorSelection.range(range.anchor, target.head) : target;
      }),
      view.state.selection.mainIndex,
    );
    view.dispatch({ selection, scrollIntoView: true, userEvent: "select" });
    return true;
  };
}

export const markupKeymap = Prec.high(
  keymap.of([
    { key: "Tab", run: tableCommands.nextCell },
    { key: "Shift-Tab", run: tableCommands.previousCell },
    { key: "Tab", run: (view) => indentListItem(view, false) },
    { key: "Backspace", run: removeQuoteMarker },
    { key: "Shift-Tab", run: (view) => indentListItem(view, true) },
    { key: "Enter", run: tableEnter },
    { key: "Enter", run: continueMarkup },
    { key: "Shift-Enter", run: insertNewlineAndIndent },
    { key: "Home", run: lineBoundary(false, false), shift: lineBoundary(false, true) },
    { key: "End", run: lineBoundary(true, false), shift: lineBoundary(true, true) },
    { key: "Alt-ArrowUp", run: tableCommands.moveRowUp },
    { key: "Alt-ArrowDown", run: tableCommands.moveRowDown },
    { key: "Alt-Shift-ArrowLeft", run: tableCommands.moveColumnLeft },
    { key: "Alt-Shift-ArrowRight", run: tableCommands.moveColumnRight },
  ]),
);

// 16×16 icons: a bar is a row or column of the table, "+" inserts, "×" deletes.
const ICONS = {
  rowAbove: '<rect x="2" y="10" width="12" height="4" rx="1"/><path d="M8 2v6M5 5h6"/>',
  rowBelow: '<rect x="2" y="2" width="12" height="4" rx="1"/><path d="M8 8v6M5 11h6"/>',
  columnLeft: '<rect x="10" y="2" width="4" height="12" rx="1"/><path d="M5 5v6M2 8h6"/>',
  columnRight: '<rect x="2" y="2" width="4" height="12" rx="1"/><path d="M11 5v6M8 8h6"/>',
  deleteRow: '<rect x="1.5" y="6" width="8" height="4" rx="1"/><path d="M11.5 6l3 4M14.5 6l-3 4"/>',
  deleteColumn: '<rect x="6" y="1.5" width="4" height="8" rx="1"/><path d="M6 11.5l4 3M10 11.5l-4 3"/>',
  header:
    '<rect x="2" y="2" width="12" height="12" rx="1"/><path d="M2 4h12" stroke-width="4"/><path d="M2 10h12M8 6v8"/>',
  align: '<path d="M2 2v12M8 2v12M14 2v12M3.5 5.5h3M9.5 5.5h3M3.5 10.5h2M9.5 10.5h3"/>',
};

/**
 * Switches between editing tables as tables and as text, keeping the place:
 * the focused cell becomes the cursor in the text, and the other way round.
 */
function toggleTableMode(view: EditorView): boolean {
  const mode = view.state.field(tableModeField);
  if (mode !== "text") {
    const cell = focusedCellSource(view);
    // The editor would take the selection in the cell as its cursor on focus.
    window.getSelection()?.removeAllRanges();
    view.focus();
    view.dispatch({
      effects: switchTableMode("text"),
      selection: cell ? { anchor: cell.pos } : undefined,
      scrollIntoView: true,
    });
    return true;
  }
  const context = tableAt(view.state);
  if (!context) {
    view.dispatch({ effects: switchTableMode("table") });
    return true;
  }
  const { block, table, at } = context;
  // With the cursor outside of it, the table shows as a table.
  const { doc } = view.state;
  const outside = block.from > 0 ? block.from - 1 : Math.min(doc.length, block.contentTo + 1);
  view.dispatch({ effects: switchTableMode("table"), selection: { anchor: outside } });
  const row = table.rows[at.row]?.separator ? Math.max(0, at.row - 1) : at.row;
  focusCell(view, block.from, row, at.col, "end");
  return true;
}

const TABLE_BUTTONS: [keyof typeof ICONS, string, (view: EditorView) => boolean][] = [
  ["rowAbove", "Insert a row above", tableCommands.rowAbove],
  ["rowBelow", "Insert a row below (Enter)", tableCommands.rowBelow],
  ["columnLeft", "Insert a column on the left", tableCommands.columnLeft],
  ["columnRight", "Insert a column on the right", tableCommands.columnRight],
  ["deleteRow", "Delete this row", tableCommands.deleteRow],
  ["deleteColumn", "Delete this column", tableCommands.deleteColumn],
  ["header", "Make the first row a header, or a normal row", tableCommands.toggleHeader],
  ["align", "Align the columns (also on Tab). Alt+↑/↓ moves rows, Alt+Shift+←/→ columns", tableCommands.format],
];

/**
 * The table buttons, in a bar above the table while the cursor is in it (in a
 * cell or in its source). On a tall table the bar stays in view, below
 * Phorge's toolbar.
 */
export const tableBar = ViewPlugin.fromClass(
  class {
    readonly bar: HTMLElement;
    readonly modeButton: HTMLAnchorElement;
    private readonly onScroll = () => this.place();

    constructor(readonly view: EditorView) {
      this.bar = document.createElement("div");
      this.bar.className = "rme-table-bar";
      this.bar.hidden = true;
      this.bar.setAttribute("role", "toolbar");
      this.bar.setAttribute("aria-label", "Table");
      // "rme-own": these buttons handle table cells themselves.
      this.modeButton = toolbarButton({
        title: "Edit the table as text",
        // Not "fa-code": that is Phorge's code block button.
        icon: "fa-file-text-o",
        className: "rme-own",
        run: () => toggleTableMode(view),
      });
      const separator = document.createElement("span");
      separator.className = "remarkup-assist-separator";
      this.bar.append(this.modeButton, separator);
      for (const [icon, title, run] of TABLE_BUTTONS) {
        const svg = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">${ICONS[icon]}</svg>`;
        this.bar.append(toolbarButton({ title, icon: svg, className: "rme-own", run: () => run(view) }));
      }
      view.dom.append(this.bar);
      // Focus moving into or out of table cells does not update the editor.
      view.dom.addEventListener("focusin", this.onScroll);
      view.dom.addEventListener("focusout", this.onScroll);
      window.addEventListener("scroll", this.onScroll, true);
      window.addEventListener("resize", this.onScroll);
    }

    update() {
      this.place();
    }

    /** The table the cursor is in: its box on the screen, or null. */
    private tableBox(): { top: number; bottom: number; left: number; right: number } | null {
      const view = this.view;
      const cell = focusedCell(view);
      if (cell) {
        return cell.closest(".rme-table-editor")!.querySelector("table")!.getBoundingClientRect();
      }
      const { active, blocks, focused } = view.state.field(previewField);
      const block = focused ? blocks.find((b, i) => active.has(i) && b.kind === "table") : undefined;
      if (!block) {
        return null;
      }
      // The source lines: as wide as their longest line.
      let right = 0;
      const { doc } = view.state;
      for (let n = doc.lineAt(block.from).number; n <= doc.lineAt(block.contentTo).number; n++) {
        const line = doc.line(n);
        // A wrapped line takes the whole width.
        const wrapped = view.lineBlockAt(line.from).height > view.defaultLineHeight * 1.5;
        right = wrapped
          ? view.contentDOM.getBoundingClientRect().right
          : Math.max(right, view.coordsAtPos(line.to)?.right ?? 0);
        if (wrapped) {
          break;
        }
      }
      const top = view.coordsAtPos(block.from);
      const bottom = view.coordsAtPos(block.contentTo);
      return top && bottom ? { top: top.top, bottom: bottom.bottom, left: top.left, right } : null;
    }

    place() {
      const mode = this.view.state.field(tableModeField);
      const asTable = mode !== "text";
      this.modeButton.firstElementChild!.classList.toggle("fa-file-text-o", asTable);
      this.modeButton.firstElementChild!.classList.toggle("fa-table", !asTable);
      this.modeButton.setAttribute("aria-label", asTable ? "Edit the table as text" : "Edit the table as a table");
      this.view.requestMeasure({
        key: this,
        read: () => {
          const table = this.tableBox();
          if (!table) {
            return null;
          }
          const height = this.bar.offsetHeight || 30;
          const width = this.bar.offsetWidth || 300;
          // Below Phorge's toolbar, which sticks to the top of the window.
          const textarea = this.view.state.facet(hostTextarea);
          const toolbar = textarea?.closest(CONTROL)?.querySelector(TOOLBAR)?.getBoundingClientRect();
          const base = this.view.dom.getBoundingClientRect();
          const content = this.view.contentDOM.getBoundingClientRect();
          // Beside the table where there is room, else above it, else below it;
          // a table taller than the window has it below Phorge's toolbar.
          const minTop = Math.max(toolbar?.bottom ?? 0, content.top) + 4;
          const beside = table.right + 8 + width <= content.right;
          let top: number;
          if (beside) {
            top = Math.min(Math.max(table.top, minTop), table.bottom - height);
          } else if (table.top - height - 4 >= minTop) {
            top = table.top - height - 4;
          } else if (table.bottom + 4 + height <= window.innerHeight) {
            top = table.bottom + 4;
          } else {
            top = Math.min(minTop, table.bottom - height);
          }
          const left = beside ? table.right + 8 : table.left;
          // Out of view: the table is not on the screen.
          const visible = table.bottom > 0 && table.top < window.innerHeight;
          return visible ? { top: top - base.top, left: left - base.left } : null;
        },
        write: (place) => {
          this.bar.hidden = !place;
          if (place) {
            this.bar.style.top = `${place.top}px`;
            this.bar.style.left = `${place.left}px`;
          }
        },
      });
    }

    destroy() {
      this.bar.remove();
      window.removeEventListener("scroll", this.onScroll, true);
      window.removeEventListener("resize", this.onScroll);
    }
  },
);
