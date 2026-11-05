// Text blocks (paragraphs, headers, lists, quotes, notes, rules) always show their
// source, styled like the rendered text (sourceStyle.ts), with their markup
// hidden except where the cursor is (inlinePreview.ts), so nothing moves when
// the cursor moves. Other blocks (code, rules, ...) show as the server renders
// them, except while the cursor is in them; tables are edited as tables
// (tableEditor.ts).

import {
  EditorSelection,
  EditorState,
  type Extension,
  Facet,
  type Line,
  Prec,
  type Range,
  StateEffect,
  StateField,
} from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  EditorView,
  keymap,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { type Block, type BlockKind, splitBlocks } from "../blocks";
import type { BlockRenderer, RenderItem } from "../renderer";
import { storedChoice } from "../../storage";
import { blockEdges, clearGaps, gapKey, gapMeasurer, gapsField, setGaps } from "./gaps";
import { enterTable, focusedCellSource, refreshCellEditor, TableWidget } from "./tableEditor";
import { parseHtml, setHtml } from "../html";
import { type ListItem, parseList } from "../list";
import { LIST_ITEM } from "../syntax";

/** Blocks that show their source, styled; see above. */
export const STYLED_BLOCKS = new Set<BlockKind>(["paragraph", "header", "list", "quote", "note", "rule"]);

/**
 * Whether a block shows its source while the cursor is not in it. A note of
 * more lines than one shows as Phorge renders it, on one line (remarkup has
 * no line breaks in notes); while edited, its lines are marked as joined
 * (sourceStyle.ts).
 */
function alwaysSource(state: EditorState, block: Block): boolean {
  return (
    STYLED_BLOCKS.has(block.kind) &&
    !(block.kind === "note" && state.doc.lineAt(block.from).number !== state.doc.lineAt(block.contentTo).number)
  );
}

/** The renderer the editor uses for its blocks. */
const blockRenderer = Facet.define<BlockRenderer, BlockRenderer | null>({
  combine: (values) => values[0] ?? null,
});

/** What the editor of a table cell needs of the editor, which the table editor can not import (see attach.ts). */
export interface CellSupport {
  /** The extensions of a cell's editor (live preview, autocomplete, insert menu, shortcuts), for the editor of the text. */
  extensions(main: EditorView): Extension;
  /** A toolbar button's command in a cell, by its icon (e.g. "fa-bold"); null if it is none. */
  format(icon: string): ((view: EditorView) => boolean) | null;
  /** Pastes a URL over the selected text as a link with that text; false if it is no URL or nothing is selected. */
  linkSelection(view: EditorView, text: string): boolean;
}

export const cellSupport = Facet.define<CellSupport, CellSupport | null>({
  combine: (values) => values[0] ?? null,
});

/**
 * Moves where a click, Home or End puts the cursor in the text, e.g. out of
 * hidden markers (inlinePreview.ts).
 */
export const clickPosition = Facet.define<(view: EditorView, pos: number) => number>();

export function clicked(view: EditorView, pos: number): number {
  return view.state.facet(clickPosition).reduce((at, move) => move(view, at), pos);
}

/** The renderer of the editor, for other extensions that show rendered remarkup. */
export function rendererOf(state: EditorState): BlockRenderer | null {
  return state.facet(blockRenderer);
}

/** Dispatched when rendered HTML arrived for some blocks. */
export const renderedEffect = StateEffect.define<null>();

/**
 * How tables are edited: as tables, cell by cell, the cell being edited with
 * the live preview of the text ("table"); or as their text.
 */
export type TableMode = "table" | "text";

const tableModeChoice = storedChoice<TableMode>("phizziwig-table-mode", "table", ["table", "text"]);

const setTableMode = StateEffect.define<TableMode>();

/** Switches between editing tables as tables and as text, and remembers the choice. */
export function switchTableMode(mode: TableMode): StateEffect<TableMode> {
  tableModeChoice.set(mode);
  return setTableMode.of(mode);
}

/** How tables are edited: as tables (TableWidget) or as their text. Remembered per browser. */
export const tableModeField = StateField.define<TableMode>({
  create: () => tableModeChoice.get(),
  update(mode, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setTableMode)) {
        return effect.value;
      }
    }
    return mode;
  },
});

export interface PreviewState {
  blocks: Block[];
  /** Indexes of the blocks shown as source. */
  active: Set<number>;
  focused: boolean;
  /** While the mouse selects text, the blocks keep showing as they were; see mouseSelection. */
  frozen: boolean;
  /** Gaps between blocks that are not measured yet; see gaps.ts. */
  missingGaps: Set<string>;
  /** Images of the blocks being edited, by block start; see ImagePreview. */
  previews: Map<number, string>;
  decorations: DecorationSet;
}

function blockText(state: EditorState, block: Block): string {
  return state.doc.sliceString(block.from, block.contentTo);
}

/** The block the cursor is in, optionally only of a kind. */
export function blockAtCursor(state: EditorState, kind?: BlockKind): Block | undefined {
  const head = state.selection.main.head;
  // None in the editor of a table cell (tableEditor.ts).
  return state
    .field(previewField, false)
    ?.blocks.find((b) => (!kind || b.kind === kind) && !b.empty && head >= b.from && head <= b.contentTo);
}

/** What the renderer needs to render a block: its text and whether it ends the text. */
function renderItem(state: EditorState, block: Block, lastBlock: Block | undefined): RenderItem {
  return { text: blockText(state, block), last: block === lastBlock };
}

function sameSet<T>(a: Set<T>, b: Set<T>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

/** Whether a selection range touches a range of the text. */
function selects(state: EditorState, from: number, to: number): boolean {
  return state.selection.ranges.some((range) => range.from <= to && range.to >= from);
}

/** An item of a list block: its source range and what it renders as on its own. */
interface SourceItem {
  from: number;
  to: number;
  item: ListItem;
  render: RenderItem;
}

/** The items of a list block. */
export function listItems(state: EditorState, block: Block): SourceItem[] {
  const lines: Line[] = [];
  for (let n = state.doc.lineAt(block.from).number; n <= state.doc.lineAt(block.contentTo).number; n++) {
    lines.push(state.doc.line(n));
  }
  return parseList(lines.map((line) => line.text)).map((item) => ({
    from: lines[item.first].from,
    to: lines[item.last].to,
    item,
    render: { text: item.text, last: false },
  }));
}

/** What a rendered block in the text shows, by its start: its source text, and what it renders as. */
function renderedSource(
  state: EditorState,
  from: number,
): { from: number; to: number; text: string; render: RenderItem } | null {
  const { blocks } = state.field(previewField);
  const block = blocks.find((b) => b.from === from && !b.empty);
  if (!block) {
    return null;
  }
  const lastBlock = blocks.findLast((b) => !b.empty);
  return { from, to: block.contentTo, text: blockText(state, block), render: renderItem(state, block, lastBlock) };
}

function activeBlocks(state: EditorState, blocks: Block[], focused: boolean): Set<number> {
  const active = new Set<number>();
  if (!focused) {
    return active;
  }
  for (const range of state.selection.ranges) {
    blocks.forEach((block, i) => {
      if (range.from <= block.contentTo && range.to >= block.from) {
        active.add(i);
      }
    });
  }
  return active;
}

const embedCache = new Map<string, string | null>();

/** The embedded images of rendered HTML, or null if it has none. */
function imagesOf(html: string): string | null {
  if (!html.includes("<img") || !(html.includes("data-rme-file") || html.includes("phabricator-remarkup-macro"))) {
    return null;
  }
  let images = embedCache.get(html);
  if (images === undefined) {
    // Embedded files, and image macros and memes, in their order.
    const found = Array.from(
      parseHtml(html).querySelectorAll('[class*="phabricator-remarkup-embed-layout"], img.phabricator-remarkup-macro'),
    );
    images =
      found
        .filter((el) => el.tagName === "IMG" || el.querySelector("img[src]"))
        .map((el) => {
          if (el.tagName === "IMG") {
            return `<p>${el.outerHTML}</p>`;
          }
          // An embed starting a paragraph ("<p><div>…") leaves an empty
          // paragraph before it, which moves it down: keep that, so it is in
          // the same place while editing (images below the source hide it).
          const before = el.previousElementSibling;
          const empty = before?.tagName === "P" && !before.textContent?.trim();
          return (empty ? "<p></p>" : "") + el.outerHTML;
        })
        .join("") || null;
    embedCache.set(html, images);
    if (embedCache.size > 200) {
      embedCache.delete(embedCache.keys().next().value!);
    }
  }
  return images;
}

/**
 * A table (edited as a table) that the selection covers whole, without the
 * cursor in its text: it stays a table, so nothing moves while selecting.
 */
function tableSelected(state: EditorState, block: Block): boolean {
  return (
    block.kind === "table" &&
    state.field(tableModeField, false) !== "text" &&
    state.selection.ranges.every((r) => r.from <= block.from && r.to >= block.contentTo)
  );
}

function buildDecorations(
  state: EditorState,
  blocks: Block[],
  active: Set<number>,
  oldPreviews: Map<number, string>,
): {
  decorations: DecorationSet;
  previews: Map<number, string>;
  missingGaps: Set<string>;
} {
  const renderer = state.facet(blockRenderer);
  const ranges: Range<Decoration>[] = [];
  const previews = new Map<number, string>();
  const lastBlock = blocks.findLast((b) => !b.empty);
  const gaps = state.field(gapsField, false) ?? new Map<string, number>();
  const missingGaps = new Set<string>();
  // What each block renders, its HTML, its first and last element, and the next block with text.
  const items = blocks.map((b) => (b.empty ? null : renderItem(state, b, lastBlock)));
  const htmls = items.map((item) => (item ? renderer?.getOrSimilar(item) : undefined));
  const edges = blocks.map((b, i) => (b.empty ? null : blockEdges(state, b, htmls[i])));
  let previous: number | null = null;
  const tableMode = state.field(tableModeField, false) ?? "table";

  blocks.forEach((block, i) => {
    if (!block.empty) {
      // A block right on the next line of the previous one: no blank line
      // takes the gap, a spacer does. (A block may start with blank lines,
      // e.g. after a note, which ends before them.)
      let first = state.doc.lineAt(block.from);
      while (!first.text.trim() && first.to < block.contentTo) {
        first = state.doc.line(first.number + 1);
      }
      if (previous !== null && state.doc.lineAt(blocks[previous].contentTo).number + 1 === first.number) {
        const key = gapKey(edges[previous]![1], edges[i]![0]);
        const height = gaps.get(key);
        if (height === undefined) {
          missingGaps.add(key);
        }
        ranges.push(Decoration.widget({ widget: new Spacer(height ?? 0), block: true, side: -1 }).range(block.from));
      }
      previous = i;
    }
    if (block.empty) {
      // Blank lines are lines like any other, also between blocks: as high as
      // a line of text, so nothing moves when the cursor comes to them.
      return;
    }
    if (block.kind === "list") {
      listImages(state, block, ranges, previews, oldPreviews);
    } else if ((active.has(i) && !tableSelected(state, block)) || alwaysSource(state, block)) {
      // A block with images keeps showing them below its source, so it does
      // not collapse; until the edited text is rendered, the last images stay.
      const html = htmls[i];
      const images = (html !== undefined ? imagesOf(html) : undefined) ?? oldPreviews.get(block.from);
      if (images) {
        previews.set(block.from, images);
        if (/phabricator-remarkup-embed-float/.test(images)) {
          // Floating images float beside the source too, like in the rendered text.
          ranges.push(
            Decoration.widget({ widget: new ImagePreview(images, "float"), block: true, side: -1 }).range(block.from),
          );
          const pad = state.field(floatPadsField, false)?.get(block.from);
          if (pad) {
            const last = state.doc.lineAt(block.contentTo);
            ranges.push(Decoration.line({ attributes: { style: `padding-bottom: ${pad}px` } }).range(last.from));
          }
        } else if (/^\s*\{F\d+/.test(items[i]!.text)) {
          // A block starting with an image: the image above its source, like in the rendered text.
          ranges.push(
            Decoration.widget({ widget: new ImagePreview(images, "above"), block: true, side: -1 }).range(block.from),
          );
        } else {
          ranges.push(
            Decoration.widget({ widget: new ImagePreview(images, "below"), block: true, side: 1 }).range(
              block.contentTo,
            ),
          );
        }
      }
    } else if (block.kind === "table" && tableMode !== "text") {
      // Tables are tables, editable cell by cell, also before they are rendered.
      ranges.push(
        Decoration.replace({ widget: new TableWidget(items[i]!.text, htmls[i], tableMode), block: true }).range(
          block.from,
          block.contentTo,
        ),
      );
    } else {
      const html = htmls[i];
      if (html) {
        ranges.push(
          Decoration.replace({ widget: new RenderedBlock(html, block.kind, fences(state, block)), block: true }).range(
            block.from,
            block.contentTo,
          ),
        );
      }
    }
  });
  return {
    decorations: Decoration.set(ranges, true),
    previews,
    missingGaps,
  };
}

/** The images of the items of a list, below each item, like in the rendered list. */
function listImages(
  state: EditorState,
  block: Block,
  ranges: Range<Decoration>[],
  previews: Map<number, string>,
  oldPreviews: Map<number, string>,
): void {
  const renderer = state.facet(blockRenderer);
  for (const unit of listItems(state, block)) {
    const html = renderer?.get(unit.render);
    const images = (html !== undefined ? imagesOf(html) : undefined) ?? oldPreviews.get(unit.from);
    if (images) {
      previews.set(unit.from, images);
      ranges.push(
        Decoration.widget({ widget: new ImagePreview(images, "below"), block: true, side: 1 }).range(unit.to),
      );
    }
  }
}

const setFocused = StateEffect.define<boolean>();

/**
 * Notes the focus of the editor now, instead of after CodeMirror's delay
 * (focusChangeEffect): e.g. before measuring the text, which may still show
 * a block rendered that shows its source with the focus. Only the focus
 * coming: without it, the focus may be in a table cell, whose table must
 * stay as it is.
 */
export function syncFocus(view: EditorView): void {
  const preview = view.state.field(previewField, false);
  if (view.hasFocus && preview && !preview.focused) {
    view.dispatch({ effects: setFocused.of(true) });
  }
}

/**
 * How far the floating images of a block being edited reach below its last
 * line, by block start: that line gets as much padding, so the image stays
 * within the block like in the rendered text.
 */
const setFloatPads = StateEffect.define<Map<number, number>>();

const floatPadsField = StateField.define<Map<number, number>>({
  create: () => new Map(),
  update(pads, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setFloatPads)) {
        return effect.value;
      }
    }
    if (!tr.docChanged || !pads.size) {
      return pads;
    }
    const mapped = new Map<number, number>();
    pads.forEach((pad, from) => mapped.set(tr.changes.mapPos(from, 1), pad));
    return mapped;
  },
});

/** Measures floatPadsField after the layout changed (e.g. an image arrived). */
const floatPadMeasure = ViewPlugin.define((view) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const measure = () =>
    view.requestMeasure({
      key: floatPadMeasure,
      read: () => {
        const pads = new Map<number, number>();
        const { blocks } = view.state.field(previewField);
        view.contentDOM.querySelectorAll<HTMLElement>(".rme-preview-float").forEach((preview) => {
          const from = view.posAtDOM(preview);
          const block = blocks.find((b) => b.from === from);
          const line = block && (view.domAtPos(block.contentTo).node as Node);
          const lineDom = line instanceof Element ? line.closest(".cm-line") : line?.parentElement?.closest(".cm-line");
          // Like the rendered block, which contains the images with their margins.
          const images = Array.from(preview.children).map(
            (child) => child.getBoundingClientRect().bottom + parseFloat(getComputedStyle(child).marginBottom),
          );
          if (!block || !lineDom || !images.length) {
            return;
          }
          const lineBottom =
            lineDom.getBoundingClientRect().bottom - parseFloat(getComputedStyle(lineDom).paddingBottom);
          const pad = Math.max(...images) - lineBottom;
          if (pad > 0.5) {
            pads.set(from, pad);
          }
        });
        return pads;
      },
      write: (pads) => {
        const old = view.state.field(floatPadsField);
        // Changed by more than rounding: else the padding would never settle.
        if (pads.size !== old.size || [...pads].some(([from, pad]) => Math.abs((old.get(from) ?? 0) - pad) > 0.5)) {
          // Not while CodeMirror measures.
          clearTimeout(timer);
          timer = setTimeout(() => view.dispatch({ effects: setFloatPads.of(pads) }));
        }
      },
    });
  return {
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.geometryChanged ||
        update.startState.field(previewField) !== update.state.field(previewField)
      ) {
        measure();
      }
    },
    destroy: () => clearTimeout(timer),
  };
});

/** Starts and ends a selection with the mouse; see PreviewState.frozen. */
const freezeBlocks = StateEffect.define<boolean>();

export const previewField = StateField.define<PreviewState>({
  create(state) {
    const blocks = splitBlocks(state.doc.toString());
    const active = activeBlocks(state, blocks, false);
    return { blocks, active, focused: false, frozen: false, ...buildDecorations(state, blocks, active, new Map()) };
  },
  update(value, tr) {
    let { focused, frozen } = value;
    let rendered = false;
    for (const effect of tr.effects) {
      if (effect.is(setFocused)) {
        focused = effect.value;
      } else if (effect.is(freezeBlocks)) {
        frozen = effect.value;
      } else if (
        effect.is(renderedEffect) ||
        effect.is(setTableMode) ||
        effect.is(setGaps) ||
        effect.is(clearGaps) ||
        effect.is(setFloatPads)
      ) {
        rendered = true;
      }
    }
    if (!tr.docChanged && !tr.selection && focused === value.focused && frozen === value.frozen && !rendered) {
      return value;
    }
    if (frozen && !tr.docChanged && !rendered) {
      return { ...value, focused, frozen };
    }
    const blocks = tr.docChanged ? splitBlocks(tr.state.doc.toString()) : value.blocks;
    const active = frozen && !tr.docChanged ? value.active : activeBlocks(tr.state, blocks, focused);
    // The cursor moved within what shows as source: the decorations stay.
    if (!tr.docChanged && !rendered && sameSet(active, value.active)) {
      return { ...value, focused, frozen };
    }
    const previews = new Map<number, string>();
    value.previews.forEach((images, from) => previews.set(tr.changes.mapPos(from, -1), images));
    return { blocks, active, focused, frozen, ...buildDecorations(tr.state, blocks, active, previews) };
  },
  provide: (field) => [
    EditorView.decorations.from(field, (value) => value.decorations),
    // While the mouse selects, see highlightRendered().
    EditorView.editorAttributes.from(field, (value): Record<string, string> =>
      value.frozen ? { class: "rme-mouse-selecting" } : {},
    ),
  ],
});

/** Asks the renderer for the HTML of blocks that need it. */
const renderRequests = ViewPlugin.fromClass(
  class {
    private prefetch: ReturnType<typeof setTimeout> | undefined;

    constructor(view: EditorView) {
      this.request(view);
    }

    update(update: ViewUpdate) {
      // Cursor moves only matter when they change which blocks are edited.
      const activeChanged = update.startState.field(previewField).active !== update.state.field(previewField).active;
      if (update.docChanged || update.focusChanged || activeChanged) {
        this.request(update.view);
      }
    }

    request(view: EditorView) {
      const renderer = view.state.facet(blockRenderer);
      if (!renderer) {
        return;
      }
      const { blocks, active } = view.state.field(previewField);
      renderer.setBlockCount(blocks.length);
      const lastBlock = blocks.findLast((b) => !b.empty);
      // A table edited in a cell is edited like a block in the text.
      const tableInEdit = focusedCellSource(view)?.tableFrom;
      const shown: RenderItem[] = [];
      const editing: RenderItem[] = [];
      const items: RenderItem[] = [];
      blocks.forEach((block, i) => {
        if (!block.empty) {
          const item = renderItem(view.state, block, lastBlock);
          (active.has(i) || block.from === tableInEdit ? editing : shown).push(item);
          if (block.kind === "list" && item.text.includes("{F")) {
            // Their images show below each item.
            for (const unit of listItems(view.state, block)) {
              items.push(unit.render);
            }
          }
        }
      });
      editing.push(...items);
      renderer.keepFailures([...shown, ...editing]);
      renderer.request(shown);
      // Render the blocks being edited once typing pauses, so they look right
      // as soon as the cursor leaves them; sooner with images, which show
      // below the source while editing.
      clearTimeout(this.prefetch);
      const delay = editing.some((item) => item.text.includes("{F")) ? 150 : 600;
      this.prefetch = setTimeout(() => renderer.request(editing), delay);
    }

    destroy() {
      clearTimeout(this.prefetch);
    }
  },
);

/**
 * The lines of a code block's source with its "```" fences alone, before and
 * after its code, which the rendered block does not show: it keeps room for
 * them (style.css), so its code is where the source shows it.
 */
function fences(state: EditorState, block: Block): [boolean, boolean] {
  if (block.kind !== "code") {
    return [false, false];
  }
  const first = state.doc.lineAt(block.from);
  const last = state.doc.lineAt(block.contentTo);
  return [/^\s*```[^`]*$/.test(first.text), last.number > first.number && last.text.trim() === "```"];
}

class RenderedBlock extends WidgetType {
  constructor(
    readonly html: string,
    readonly kind: BlockKind,
    readonly fences: [boolean, boolean],
  ) {
    super();
  }

  override eq(other: RenderedBlock): boolean {
    return (
      other.html === this.html &&
      other.kind === this.kind &&
      other.fences[0] === this.fences[0] &&
      other.fences[1] === this.fences[1]
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement("div");
    dom.className = `rme-block rme-block-${this.kind} phabricator-remarkup`;
    dom.classList.toggle("rme-fence-before", this.fences[0]);
    dom.classList.toggle("rme-fence-after", this.fences[1]);
    // Server-rendered remarkup, the same HTML the page's preview shows.
    setHtml(dom, this.html);
    dom.title = "Click to edit, Ctrl+click to open a link";
    dom.addEventListener("mousedown", (event) => selectWithMouse(view, event));
    dom.addEventListener("click", openLinkOnModClick);
    return dom;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Appends an item (its li) to an element in lists like those around it in its
 * whole list, so the page's styles indent, number and mark it the same.
 */
export function appendInLists(parent: HTMLElement, item: ListItem, own: HTMLLIElement): void {
  item.path.forEach((level, i) => {
    const list = document.createElement(level.tag);
    list.className = `remarkup-list${item.hasMarks ? " remarkup-list-with-checkmarks" : ""}`;
    const isOwn = i === item.path.length - 1;
    // The items around this one: their classes place the lists in them, their markers do not show.
    const entry = isOwn ? own : document.createElement("li");
    if (!isOwn) {
      const mark = level.mark === null ? "" : level.mark ? " remarkup-checked-item" : " remarkup-unchecked-item";
      entry.className = `remarkup-list-item rme-list-around${mark}`;
    }
    if (level.tag === "ol") {
      entry.value = level.start + level.index;
    }
    list.append(entry);
    parent.append(list);
    parent = entry;
  });
}

/** The gap between two blocks on consecutive lines; see gaps.ts. */
class Spacer extends WidgetType {
  constructor(readonly height: number) {
    super();
  }

  override eq(other: Spacer): boolean {
    return other.height === this.height;
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement("div");
    dom.className = "rme-spacer";
    dom.style.height = `${this.height}px`;
    // A click here is a click on the nearer line, above or below, where the mouse is.
    dom.addEventListener("mousedown", (event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      // Focus first: focusing places the browser's caret, which the editor would take over.
      view.focus();
      const { doc } = view.state;
      const box = dom.getBoundingClientRect();
      const above = event.clientY < (box.top + box.bottom) / 2;
      const below = view.posAtDOM(dom);
      const line = doc.lineAt(above ? Math.max(0, below - 1) : below);
      let pos = view.posAtCoords({ x: event.clientX, y: above ? box.top - 2 : box.bottom + 2 }, false);
      if (doc.lineAt(pos).number !== line.number) {
        pos = above ? line.to : line.from;
      }
      // On a list item, in its text.
      const item = inListBlock(view.state, line.from) ? LIST_ITEM.exec(line.text) : null;
      if (item) {
        pos = Math.max(pos, line.to - item[5].length);
      }
      view.dispatch({ selection: { anchor: pos }, effects: setFocused.of(true), userEvent: "select.pointer" });
    });
    return dom;
  }

  override updateDOM(dom: HTMLElement): boolean {
    dom.style.height = `${this.height}px`;
    return true;
  }

  override get estimatedHeight(): number {
    return this.height;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** The images of a block being edited, shown below its source. */
class ImagePreview extends WidgetType {
  constructor(
    readonly html: string,
    /**
     * Where the images are: below the source, above it (a block starting with
     * an image), or floating beside it (no height of their own, the source
     * lines flow around them).
     */
    readonly placement: "below" | "above" | "float",
  ) {
    super();
  }

  override eq(other: ImagePreview): boolean {
    return other.html === this.html && other.placement === this.placement;
  }

  toDOM(): HTMLElement {
    const dom = document.createElement("div");
    dom.className = `rme-block rme-image-preview rme-preview-${this.placement} phabricator-remarkup`;
    // Server-rendered images of the block.
    setHtml(dom, this.html);
    // Keep the cursor in the source; the images have a context menu.
    dom.addEventListener("mousedown", (event) => event.preventDefault());
    dom.addEventListener("click", (event) => event.preventDefault());
    return dom;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** Links in the editor open with Ctrl+click (Cmd+click); a plain click edits. */
export function openLinkOnModClick(event: MouseEvent): void {
  const link = (event.target as Element).closest<HTMLAnchorElement>("a[href]");
  if (link) {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      window.open(link.href, "_blank", "noopener");
    }
  }
}

/** A place in rendered text: the position in the source it shows, and where it is in the page. */
interface RenderedPoint {
  pos: number;
  node: Node;
  offset: number;
}

/**
 * The text under the mouse in a rendered block or list item: its position in
 * the source, or null where the text is not found there (e.g. a link's title).
 */
function renderedPoint(view: EditorView, dom: Element, event: MouseEvent): RenderedPoint | null {
  const source = renderedSource(view.state, view.posAtDOM(dom));
  const caret = caretAt(event.clientX, event.clientY);
  if (!source || !caret || !dom.contains(caret.node)) {
    return null;
  }
  const offset = sourceOffset(source.text, caret, dom);
  return offset === null ? null : { pos: source.from + offset, ...caret };
}

/** The rendered block or list item an element is in: its range in the source. */
function renderedUnit(view: EditorView, el: Element | null): { from: number; to: number; dom: Element } | null {
  const dom = el?.closest(".rme-block:not(.rme-image-preview)");
  if (!dom || !view.contentDOM.contains(dom)) {
    return null;
  }
  const source = renderedSource(view.state, view.posAtDOM(dom));
  return source && { from: source.from, to: source.to, dom };
}

/**
 * The ends of the selection being made with the mouse that are in rendered
 * text, where the page shows them; see highlightRendered().
 */
const dragPoints: { anchor: RenderedPoint | null; head: RenderedPoint | null } = { anchor: null, head: null };

/**
 * Where a selection made with the mouse from `anchor` ends: at the text
 * under the mouse, in the source or in a rendered block or list item, like
 * in a text field. Where rendered text is not found in the source, and in
 * tables, at the far end of the block.
 */
function dragHead(view: EditorView, event: MouseEvent, anchor: number): number | null {
  dragPoints.head = null;
  const unit = renderedUnit(view, document.elementFromPoint(event.clientX, event.clientY));
  if (!unit) {
    return view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
  }
  const point = unit.dom.classList.contains("rme-table-editor") ? null : renderedPoint(view, unit.dom, event);
  if (point) {
    dragPoints.head = point;
    return point.pos;
  }
  return unit.from >= anchor ? unit.to : unit.from;
}

/**
 * Click and drag in a rendered block or list item. A click puts the cursor at
 * the clicked text. Dragging selects from there to the text the mouse
 * reaches (see dragHead()); Shift+click extends the selection to it. Blocks
 * only switch to their source when the mouse button is released, so nothing
 * moves under the mouse while selecting; until then, the selected rendered
 * text is highlighted (highlightRendered()).
 */
function selectWithMouse(view: EditorView, event: MouseEvent): void {
  if (event.button !== 0) {
    return;
  }
  event.preventDefault();
  if ((event.ctrlKey || event.metaKey) && (event.target as Element).closest("a[href]")) {
    // Opens the link on click, see openLinkOnModClick().
    return;
  }
  const dom = event.currentTarget as Element;
  const unit = renderedUnit(view, dom);
  if (!unit) {
    return;
  }
  const point = renderedPoint(view, dom, event);
  dragPoints.anchor = event.shiftKey ? null : point;
  const anchor = event.shiftKey ? view.state.selection.main.anchor : (point?.pos ?? unit.to);
  const selection = event.shiftKey
    ? EditorSelection.range(anchor, dragHead(view, event, anchor) ?? anchor)
    : EditorSelection.cursor(anchor);
  view.dispatch({ selection, effects: freezeBlocks.of(true) });
  view.focus();
  const start = { x: event.clientX, y: event.clientY };
  let dragging = false;
  const move = (moved: MouseEvent) => {
    dragging ||= Math.hypot(moved.clientX - start.x, moved.clientY - start.y) > 4;
    if (!dragging) {
      return;
    }
    const head = dragHead(view, moved, anchor);
    const range = head === null ? null : EditorSelection.range(anchor, head);
    if (range && !range.eq(view.state.selection.main)) {
      view.dispatch({ selection: range });
    }
  };
  window.addEventListener("mousemove", move);
  untilMouseUp(() => {
    window.removeEventListener("mousemove", move);
    view.dispatch({ effects: freezeBlocks.of(false), scrollIntoView: true });
  });
}

const HIGHLIGHT = "rme-selection";

/**
 * Highlights the selected text of the rendered blocks while the mouse
 * selects: what is selected of each, from or to where the mouse is in it.
 * The browser's own selection would show all of a block whose source it
 * reaches into, so it does not show in them meanwhile (style.css).
 */
function highlightRendered(view: EditorView, show: boolean): void {
  if (typeof Highlight === "undefined" || !CSS.highlights) {
    return;
  }
  if (!show) {
    CSS.highlights.delete(HIGHLIGHT);
    return;
  }
  const { from, to } = view.state.selection.main;
  const ranges: AbstractRange[] = [];
  view.contentDOM.querySelectorAll(".rme-block:not(.rme-image-preview)").forEach((dom) => {
    const source = renderedSource(view.state, view.posAtDOM(dom));
    if (!source || Math.max(from, source.from) >= Math.min(to, source.to)) {
      return;
    }
    // All of its text, unless an end of the selection is in it.
    const range = document.createRange();
    range.selectNodeContents(dom);
    const at = (pos: number) =>
      [dragPoints.anchor, dragPoints.head].find((point) => point?.pos === pos && dom.contains(point.node));
    const start = from > source.from ? at(from) : undefined;
    if (start) {
      range.setStart(start.node, start.offset);
    }
    const end = to < source.to ? at(to) : undefined;
    if (end) {
      range.setEnd(end.node, end.offset);
    }
    ranges.push(range);
  });
  CSS.highlights.set(HIGHLIGHT, new Highlight(...ranges));
}

/**
 * Calls back once the mouse button is released, or the press turned into
 * dragging text (which ends without a mouseup), the window lost the focus or
 * a key is pressed (typing must reach the text, not a block still rendered).
 * With afterMouseUp, a release calls back after the other mouseup handlers,
 * unless a key comes first.
 */
function untilMouseUp(done: () => void, afterMouseUp = false): void {
  const events = ["mouseup", "dragstart", "blur", "keydown"] as const;
  let finished = false;
  const finish = () => {
    if (!finished) {
      finished = true;
      events.forEach((type) => window.removeEventListener(type, end, true));
      done();
    }
  };
  const end = (event: Event) => (event.type === "mouseup" && afterMouseUp ? setTimeout(finish) : finish());
  events.forEach((type) => window.addEventListener(type, end, true));
}

/**
 * Selecting with the mouse in the source keeps the blocks as they are until
 * the button is released, too: a selection reaching into a rendered block
 * would otherwise switch it to its source under the mouse.
 */
const mouseSelection = [
  // Selecting from the source: across rendered blocks like selectWithMouse().
  EditorView.mouseSelectionStyle.of((view, event) => {
    if (event.button !== 0 || event.detail > 1 || event.ctrlKey || event.metaKey || event.altKey) {
      return null;
    }
    dragPoints.anchor = null;
    let anchor = event.shiftKey
      ? view.state.selection.main.anchor
      : clicked(view, view.posAtCoords({ x: event.clientX, y: event.clientY }, false));
    return {
      get: (current) => {
        const head = dragHead(view, current, anchor);
        return EditorSelection.single(anchor, head === null ? anchor : clicked(view, head));
      },
      update: (update) => {
        anchor = update.changes.mapPos(anchor);
        return false;
      },
    };
  }),
  EditorView.domEventHandlers({
    mousedown(event, view) {
      if (event.button === 0) {
        view.dispatch({ effects: freezeBlocks.of(true) });
        // After CodeMirror handled the mouseup.
        untilMouseUp(() => view.dom.isConnected && view.dispatch({ effects: freezeBlocks.of(false) }), true);
      }
      return false;
    },
  }),
  // The selected text of rendered blocks shows selected.
  ViewPlugin.define((view) => ({
    update(update: ViewUpdate) {
      const { frozen } = update.state.field(previewField);
      if (frozen || update.startState.field(previewField).frozen) {
        highlightRendered(update.view, frozen);
      }
      if (!frozen) {
        dragPoints.anchor = dragPoints.head = null;
      }
    },
    destroy: () => view.state.field(previewField).frozen && highlightRendered(view, false),
  })),
  // Images change the height of blocks when they arrive.
  ViewPlugin.define((view) => {
    const onLoad = (event: Event) => event.target instanceof HTMLImageElement && view.requestMeasure();
    view.contentDOM.addEventListener("load", onLoad, true);
    return { destroy: () => view.contentDOM.removeEventListener("load", onLoad, true) };
  }),
];

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  };
  if (doc.caretPositionFromPoint) {
    const pos = doc.caretPositionFromPoint(x, y);
    return pos ? { node: pos.offsetNode, offset: pos.offset } : null;
  }
  const range = document.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

/** Positions of a text in another, from the start. */
function occurrences(text: string, part: string): number[] {
  const found: number[] = [];
  for (let i = text.indexOf(part); i >= 0; i = text.indexOf(part, i + 1)) {
    found.push(i);
  }
  return found;
}

/**
 * Finds a place in rendered text (e.g. the clicked one) in the block source;
 * null if not found. Text that occurs more than once is found at the same
 * occurrence.
 */
function sourceOffset(source: string, caret: { node: Node; offset: number }, container: Element): number | null {
  if (caret.node.nodeType !== Node.TEXT_NODE) {
    return null;
  }
  const text = caret.node.textContent ?? "";
  const k = caret.offset;
  for (const [a, b] of [
    [k - 20, k + 20],
    [k - 8, k + 8],
    [k, k + 5],
    [k - 5, k],
  ]) {
    const start = Math.max(0, a);
    const snippet = text.slice(start, Math.min(text.length, b));
    if (snippet.trim().length < 3) {
      continue;
    }
    const inSource = occurrences(source, snippet);
    if (inSource.length) {
      const before = document.createRange();
      before.selectNodeContents(container);
      before.setEnd(caret.node, start);
      const rendered = before.toString() + snippet;
      const nth = occurrences(rendered, snippet).length - 1;
      return (inSource[nth] ?? inSource[0]) + (k - start);
    }
  }
  return null;
}

/** Whether a position is in a list block. */
export function inListBlock(state: EditorState, pos: number): boolean {
  return state.field(previewField).blocks.some((b) => b.kind === "list" && b.from <= pos && pos <= b.contentTo);
}

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

export function livePreview(renderer: BlockRenderer) {
  return [
    blockRenderer.of(renderer),
    // Before previewField, which reads them.
    tableModeField,
    gapsField,
    floatPadsField,
    previewField,
    floatPadMeasure,
    renderRequests,
    // Renderings arriving: also for the cell being edited live, whose table does not change.
    EditorView.updateListener.of((update) => {
      if (update.transactions.some((tr) => tr.effects.some((effect) => effect.is(renderedEffect)))) {
        refreshCellEditor();
      }
    }),
    gapMeasurer((state) => state.field(previewField).missingGaps),
    mouseSelection,
    Prec.high(
      keymap.of([
        { key: "ArrowDown", run: (view) => moveLine(view, true), shift: (view) => moveLine(view, true, true) },
        { key: "ArrowUp", run: (view) => moveLine(view, false), shift: (view) => moveLine(view, false, true) },
      ]),
    ),
    // With the focus in a search or dialog opened from the editor, it stays as it is (focusKeeper).
    EditorView.focusChangeEffect.of((_state, focusing) => (focusing || !keepsFocus() ? setFocused.of(focusing) : null)),
    focusKeeper,
  ];
}

/**
 * Searches and dialogs opened from the editor: the pickers (link, reference,
 * image macro, …) and Phorge's dialogs (upload, meme). While they have the
 * focus, the editor counts as focused, so what is being edited keeps showing
 * its source, e.g. a table edited as text.
 */
const KEEPS_FOCUS = ".rme-picker, .jx-client-dialog";

function keepsFocus(): boolean {
  return !!document.activeElement?.closest(KEEPS_FOCUS);
}

/** Whether the editor has the focus now, or a search or dialog opened from it has. */
export function editing(view: EditorView): boolean {
  return view.hasFocus || (!!view.state.field(previewField, false)?.focused && keepsFocus());
}

/** Notices when the focus a search or dialog kept for the editor goes elsewhere. */
const focusKeeper = ViewPlugin.fromClass(
  class {
    private watching = false;

    constructor(private readonly view: EditorView) {}

    update(update: ViewUpdate) {
      if (update.focusChanged && !update.view.hasFocus && update.state.field(previewField).focused) {
        this.watch();
      }
    }

    private readonly check = () =>
      // After the event, when the focus has moved (or its element is gone).
      setTimeout(() => {
        if (!this.watching || this.view.hasFocus || keepsFocus()) {
          this.stop(this.view.hasFocus);
          return;
        }
        this.stop(true);
        if (this.view.state.field(previewField).focused) {
          this.view.dispatch({ effects: setFocused.of(false) });
        }
      });

    private watch() {
      if (!this.watching) {
        this.watching = true;
        for (const type of ["focusin", "focusout", "mousedown", "keydown"]) {
          document.addEventListener(type, this.check, true);
        }
      }
    }

    /** Stops watching; unless done, only when the focus is back in the editor. */
    private stop(done: boolean) {
      if (this.watching && done) {
        this.watching = false;
        for (const type of ["focusin", "focusout", "mousedown", "keydown"]) {
          document.removeEventListener(type, this.check, true);
        }
      }
    }

    destroy() {
      this.stop(true);
    }
  },
);
