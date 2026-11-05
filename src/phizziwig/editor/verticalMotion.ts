// Up and Down through the text, its rendered blocks, tables and lists.

import { EditorSelection, Prec } from "@codemirror/state";
import { type EditorView, keymap } from "@codemirror/view";
import { LIST_ITEM } from "../syntax";
import { inListBlock, previewField } from "./livePreview";
import { enterTable, TableWidget } from "./tableEditor";

/**
 * Up and Down move like CodeMirror moves them, by visual rows, to the same
 * place on the screen (also within and between wrapped lines), with these
 * corrections:
 * - its column is kept across moves (the selection does not keep it);
 * - where it would not move (e.g. stuck at the space between two blocks) or
 *   would skip a line, it goes to the next line;
 * - a rendered block (code, a table as text) is entered at the column of the
 *   source and shows its source; a table edited as a table, in its cells;
 * - on a list item, the cursor lands in its text, not in its marker: coming
 *   from before the marker of an item, before the marker; selecting (with
 *   Shift), from the start of the line, which selects lines whole.
 */
function moveLine(view: EditorView, forward: boolean, extend = false): boolean {
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty && !extend) {
    return false;
  }
  const line = state.doc.lineAt(range.head);
  // The column where the moves started, while the cursor moves on from there:
  // in the source, and on the screen; and at a soft wrap, on which row the
  // cursor is (the selection does not keep either).
  const goal = lineGoals.get(view);
  const going = goal?.head === range.head ? goal : null;
  const start = EditorSelection.cursor(range.head, going ? going.assoc : range.assoc, undefined, going?.x);
  const moved = view.moveVertically(start, forward);
  const movedLine = state.doc.lineAt(moved.head).number;
  const column = going ? going.column : range.head - line.from;
  let head = moved.head;
  let assoc = moved.assoc;
  if (movedLine !== line.number || moved.head === range.head) {
    const number = line.number + (forward ? 1 : -1);
    if (number < 1 || number > state.doc.lines) {
      // To the start or end of the text, like CodeMirror.
      return false;
    }
    const target = state.doc.line(number);
    let rendered = false;
    let table: number | null = null;
    state.field(previewField).decorations.between(target.from, target.from, (from, to, deco) => {
      // Rendered blocks, not points like spacers and image previews.
      if (deco.spec.block && to > from && from <= target.from && target.from <= to) {
        rendered = true;
        if (deco.spec.widget instanceof TableWidget) {
          table = from;
        }
      }
    });
    if (table !== null && !extend) {
      // Into the cells of a table.
      enterTable(view, table, forward);
      return true;
    }
    if (movedLine !== number || rendered) {
      // Not on the next line, or in a rendered block, which CodeMirror only
      // enters at its edges: at the column of the source.
      head = Math.min(target.from + column, target.to);
      assoc = forward ? -1 : 1;
    }
  }
  // On a list item, in its text, not in its marker (see above).
  const target = state.doc.lineAt(head);
  const item = inListBlock(state, target.from) ? LIST_ITEM.exec(target.text) : null;
  const text = item ? target.to - item[5].length : null;
  const beforeMarker = range.head === line.from && inListBlock(state, line.from) && LIST_ITEM.test(line.text);
  if (text !== null && head < text) {
    if (beforeMarker) {
      head = target.from;
    } else if (!extend || head > target.from) {
      head = text;
    }
  }
  const x = moved.goalColumn ?? going?.x;
  view.dispatch({
    selection: extend
      ? EditorSelection.range(range.anchor, head, x, undefined, assoc)
      : EditorSelection.cursor(head, assoc, undefined, x),
    scrollIntoView: true,
    userEvent: "select",
  });
  lineGoals.set(view, { head, column, x, assoc });
  return true;
}

/** Where moving up or down started (its column in the source and its x), and where the cursor is now; see moveLine(). */
const lineGoals = new WeakMap<EditorView, { head: number; column: number; x: number | undefined; assoc: number }>();

export const verticalMotion = Prec.high(
  keymap.of([
    { key: "ArrowDown", run: (view) => moveLine(view, true), shift: (view) => moveLine(view, true, true) },
    { key: "ArrowUp", run: (view) => moveLine(view, false), shift: (view) => moveLine(view, false, true) },
  ]),
);
