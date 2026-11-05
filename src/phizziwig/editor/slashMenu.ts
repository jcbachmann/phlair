// "/" at the start of a line or after a space opens a menu of what can be
// inserted: headings, lists, tables, notes, images, ... Typing filters it,
// Enter inserts. A "/" in a word or path ("and/or", "/home") stays text.

import { Prec } from "@codemirror/state";
import { type EditorView, keymap, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { keyLabel } from "../keys";
import { type Action, ACTIONS, GROUPS } from "./actions";
import { inMonospace, LITERAL_BLOCKS } from "../syntax";
import { blockAtCursor } from "./livePreview";
import { Popup } from "./popup";

/** The insert menu of the text, or of a table cell's editor (only what fits in a cell), by its items. */
function insertMenu(items: Action[]) {
  class SlashMenu {
    /** Position of the "/". */
    private slash: number | null = null;
    private matches: Action[] = [];
    private focus = 0;
    private popup: Popup | null = null;

    constructor(private readonly view: EditorView) {}

    get active(): boolean {
      return this.slash !== null;
    }

    update(update: ViewUpdate): void {
      if (this.slash !== null && update.docChanged) {
        this.slash = update.changes.mapPos(this.slash, 1);
      }
      for (const tr of update.transactions) {
        if (!tr.isUserEvent("input.type")) {
          continue;
        }
        tr.changes.iterChanges((_fromA, _toA, fromB, toB, inserted) => {
          const line = update.state.doc.lineAt(fromB);
          const block = blockAtCursor(update.state);
          const before = update.state.sliceDoc(line.from, fromB);
          if (
            inserted.toString() === "/" &&
            toB === update.state.selection.main.head &&
            (before === "" || /\s$/.test(before)) &&
            !inMonospace(before) &&
            !(block && LITERAL_BLOCKS.has(block.kind))
          ) {
            this.slash = fromB;
            this.focus = 0;
          }
        });
      }
      if (this.slash !== null && (update.docChanged || update.selectionSet)) {
        this.refresh();
      }
    }

    private refresh(): void {
      const { state } = this.view;
      const slash = this.slash!;
      const head = state.selection.main.head;
      const line = state.doc.lineAt(slash);
      const query = state.sliceDoc(slash + 1, Math.max(slash + 1, head));
      // Closed by leaving the line, deleting the "/", "//" (italic) or a space.
      if (
        state.sliceDoc(slash, slash + 1) !== "/" ||
        !state.selection.main.empty ||
        head <= slash ||
        head > line.to ||
        /[\s/]/.test(query)
      ) {
        this.close();
        return;
      }
      const q = query.toLowerCase();
      this.matches = items.filter((a) =>
        `${a.label} ${a.insert}`
          .toLowerCase()
          .split(/\s+/)
          .some((w) => w.startsWith(q)),
      );
      if (!this.matches.length) {
        // E.g. a path like "/home": not for the menu.
        this.close();
        return;
      }
      this.focus = Math.min(this.focus, this.matches.length - 1);
      this.popup ??= new Popup("fa-plus", "Insert:");
      this.popup.echo.textContent = query || "Type to filter…";
      this.popup.setItems(
        this.matches.map((a) => ({
          label: a.label,
          icon: a.icon,
          detail: a.key ? keyLabel(a.key) : undefined,
          group: a.group,
        })),
        this.focus,
        (i) => this.pick(i),
      );
      this.popup.placeAt(this.view, slash);
      this.popup.describe(this.view.contentDOM, this.focus);
    }

    page(direction: 1 | -1): boolean {
      this.focus = this.popup!.pageFrom(this.focus, direction, this.matches.length);
      this.refresh();
      return true;
    }

    move(delta: number): boolean {
      this.focus = (this.focus + delta + this.matches.length) % this.matches.length;
      this.refresh();
      return true;
    }

    /** Enter or Tab: inserts the focused item, also the first one right after "/" (Escape keeps the "/"). */
    accept(): boolean {
      return this.pick();
    }

    pick(index = this.focus): boolean {
      const action = this.matches[index];
      const slash = this.slash!;
      const head = this.view.state.selection.main.head;
      this.close();
      // Remove "/query", then insert there (blocks on the now empty line, or
      // after the line). Focus first: some items move the focus on, into a
      // search field or a table cell.
      this.view.focus();
      this.view.dispatch({ changes: { from: slash, to: head }, selection: { anchor: slash } });
      action.run(this.view);
      return true;
    }

    close(): boolean {
      this.slash = null;
      if (this.popup) {
        Popup.undescribe(this.view.contentDOM);
      }
      this.popup?.remove();
      this.popup = null;
      return true;
    }

    destroy(): void {
      this.close();
    }
  }

  const plugin = ViewPlugin.fromClass(SlashMenu);

  function withMenu(run: (menu: SlashMenu) => boolean) {
    return (view: EditorView): boolean => {
      const menu = view.plugin(plugin);
      return menu?.active ? run(menu) : false;
    };
  }

  return [
    plugin,
    Prec.highest(
      keymap.of([
        { key: "ArrowDown", run: withMenu((m) => m.move(1)) },
        { key: "ArrowUp", run: withMenu((m) => m.move(-1)) },
        { key: "PageDown", run: withMenu((m) => m.page(1)) },
        { key: "PageUp", run: withMenu((m) => m.page(-1)) },
        { key: "Enter", run: withMenu((m) => m.accept()) },
        { key: "Tab", run: withMenu((m) => m.accept()) },
        { key: "Escape", run: withMenu((m) => m.close()) },
      ]),
    ),
  ];
}

/** By group (GROUPS), in their order within it. */
const ITEMS = ACTIONS.filter((a) => a.insert !== undefined).sort(
  (a, b) => GROUPS.indexOf(a.group ?? "") - GROUPS.indexOf(b.group ?? ""),
);

export const slashMenu = insertMenu(ITEMS);

/** In a table cell's editor: what fits in a cell (links, references, images, …). */
export const cellSlashMenu = insertMenu(ITEMS.filter((a) => a.inline));
