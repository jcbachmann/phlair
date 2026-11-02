// Shows every remarkup block as the server renders it, except the blocks the
// cursor is in: those show their source for editing. In a list, only the items
// the cursor is in show their source; the others show rendered on their own.

import {
  EditorSelection,
  EditorState,
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
import { enterTable, focusedCellSource, TableWidget } from "./tableEditor";
import { parseHtml, setHtml } from "../html";
import { type ListItem, parseList } from "../list";
import { LIST_ITEM } from "../syntax";

/** The renderer the editor uses for its blocks. */
const blockRenderer = Facet.define<BlockRenderer, BlockRenderer | null>({
  combine: (values) => values[0] ?? null,
});

/** The renderer of the editor, for other extensions that show rendered remarkup. */
export function rendererOf(state: EditorState): BlockRenderer | null {
  return state.facet(blockRenderer);
}

/** Dispatched when rendered HTML arrived for some blocks. */
export const renderedEffect = StateEffect.define<null>();

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
  /** The blank lines with the cursor the decorations were made for; see blankCursorLines(). */
  cursorLines: string;
  /** The list items shown as source the decorations were made for; see activeItems(). */
  activeItems: string;
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
  return state
    .field(previewField)
    .blocks.find((b) => (!kind || b.kind === kind) && !b.empty && head >= b.from && head <= b.contentTo);
}

/** What the renderer needs to render a block: its text and whether it ends the text. */
function renderItem(state: EditorState, block: Block, lastBlock: Block | undefined): RenderItem {
  return { text: blockText(state, block), last: block === lastBlock };
}

function sameSet<T>(a: Set<T>, b: Set<T>): boolean {
  return a.size === b.size && [...a].every((x) => b.has(x));
}

/** The blank lines the cursor is on, which show at their full height (see buildDecorations). */
function blankCursorLines(state: EditorState): string {
  return state.selection.ranges
    .map((r) => state.doc.lineAt(r.head))
    .filter((line) => !line.text.trim())
    .map((line) => line.number)
    .join(",");
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

/** The starts of the items of the lists being edited that show their source. */
function activeItems(state: EditorState, blocks: Block[], active: Set<number>): string {
  return [...active]
    .filter((i) => blocks[i].kind === "list")
    .flatMap((i) => listItems(state, blocks[i]).filter((unit) => selects(state, unit.from, unit.to)))
    .map((unit) => unit.from)
    .join(",");
}

/**
 * What a rendered element in the text shows: a block, or an item of a list
 * being edited (item: true), by its start. Its source text, and what it
 * renders as.
 */
function renderedSource(
  state: EditorState,
  from: number,
  item: boolean,
): { from: number; to: number; text: string; render: RenderItem } | null {
  const { blocks } = state.field(previewField);
  if (item) {
    const block = blocks.find((b) => b.kind === "list" && b.from <= from && from <= b.contentTo);
    const unit = block && listItems(state, block).find((u) => u.from === from);
    return unit ? { ...unit, text: state.doc.sliceString(unit.from, unit.to) } : null;
  }
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
  if (!html.includes("data-rme-file") || !html.includes("<img")) {
    return null;
  }
  let images = embedCache.get(html);
  if (images === undefined) {
    const layouts = Array.from(parseHtml(html).querySelectorAll('[class*="phabricator-remarkup-embed-layout"]'));
    images =
      layouts
        .filter((el) => el.querySelector("img[src]"))
        .map((el) => {
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

function buildDecorations(
  state: EditorState,
  blocks: Block[],
  active: Set<number>,
  oldPreviews: Map<number, string>,
): {
  decorations: DecorationSet;
  previews: Map<number, string>;
  missingGaps: Set<string>;
  cursorLines: string;
  activeItems: string;
} {
  const renderer = state.facet(blockRenderer);
  const ranges: Range<Decoration>[] = [];
  const previews = new Map<number, string>();
  const lastBlock = blocks.findLast((b) => !b.empty);
  const blankLines = blankCursorLines(state);
  const cursorLines = new Set(blankLines.split(",").map(Number));
  const gaps = state.field(gapsField, false) ?? new Map<string, number>();
  const missingGaps = new Set<string>();
  // What each block renders, its HTML, its first and last element, and the next block with text.
  const items = blocks.map((b) => (b.empty ? null : renderItem(state, b, lastBlock)));
  const htmls = items.map((item) => (item ? renderer?.getOrSimilar(item) : undefined));
  const edges = blocks.map((b, i) => (b.empty ? null : blockEdges(state, b, htmls[i])));
  const nextBlock: (number | null)[] = [];
  for (let i = blocks.length - 1, next: number | null = null; i >= 0; i--) {
    nextBlock[i] = next;
    if (!blocks[i].empty) {
      next = i;
    }
  }
  let previous: number | null = null;
  let gapPlaced = false;

  blocks.forEach((block, i) => {
    if (!block.empty) {
      // A block right on the next line of the previous one: no blank line
      // takes the gap, a spacer does.
      if (
        previous !== null &&
        state.doc.lineAt(blocks[previous].contentTo).number + 1 === state.doc.lineAt(block.from).number
      ) {
        const key = gapKey(edges[previous]![1], edges[i]![0]);
        const height = gaps.get(key);
        if (height === undefined) {
          missingGaps.add(key);
        }
        ranges.push(Decoration.widget({ widget: new Spacer(height ?? 0), block: true, side: -1 }).range(block.from));
      }
      previous = i;
      gapPlaced = false;
    }
    let gapFrom = block.contentTo;
    if (block.empty) {
      gapFrom = block.from;
    } else if (active.has(i) && block.kind === "list") {
      listItemDecorations(state, block, ranges, previews, oldPreviews);
    } else if (active.has(i)) {
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
    } else if (block.kind === "table" && state.field(tableModeField, false) !== "text") {
      // Tables are tables, editable cell by cell, also before they are rendered.
      ranges.push(
        Decoration.replace({ widget: new TableWidget(items[i]!.text, htmls[i]), block: true }).range(
          block.from,
          block.contentTo,
        ),
      );
    } else {
      const html = htmls[i];
      if (html) {
        ranges.push(
          Decoration.replace({ widget: new RenderedBlock(html, block.kind), block: true }).range(
            block.from,
            block.contentTo,
          ),
        );
      }
    }
    // The first blank line between two blocks is the gap between them on the
    // page (see gaps.ts), unless the cursor is on it. Phorge ignores
    // more blank lines; here they are lines like any other, so pressing Enter
    // makes room while writing.
    if (gapFrom < block.to) {
      for (let line = state.doc.lineAt(gapFrom).number + (block.empty ? 0 : 1); line <= state.doc.lines; line++) {
        const l = state.doc.line(line);
        if (l.from >= block.to) {
          break;
        }
        const next = nextBlock[i];
        if (l.text.trim() !== "" || gapPlaced || previous === null || next === null) {
          continue;
        }
        gapPlaced = true;
        if (cursorLines.has(line)) {
          continue;
        }
        const key = gapKey(edges[previous]![1], edges[next]![0]);
        const height = gaps.get(key);
        if (height === undefined) {
          missingGaps.add(key);
        }
        ranges.push(
          Decoration.line({
            class: "rme-gap",
            attributes: height === undefined ? undefined : { style: `--rme-gap: ${height}px` },
          }).range(l.from),
        );
      }
    }
  });
  return {
    decorations: Decoration.set(ranges, true),
    previews,
    missingGaps,
    cursorLines: blankLines,
    activeItems: activeItems(state, blocks, active),
  };
}

/**
 * A list being edited: the items the cursor is in show their source, the
 * others show rendered on their own (ListItemWidget), as soon as they are.
 * Images of the items being edited show below them.
 */
function listItemDecorations(
  state: EditorState,
  block: Block,
  ranges: Range<Decoration>[],
  previews: Map<number, string>,
  oldPreviews: Map<number, string>,
): void {
  const renderer = state.facet(blockRenderer);
  const units = listItems(state, block);
  units.forEach((unit, k) => {
    const html = renderer?.get(unit.render);
    if (selects(state, unit.from, unit.to)) {
      const images = (html !== undefined ? imagesOf(html) : undefined) ?? oldPreviews.get(unit.from);
      if (images) {
        previews.set(unit.from, images);
        ranges.push(
          Decoration.widget({ widget: new ImagePreview(images, "below"), block: true, side: 1 }).range(unit.to),
        );
      }
    } else if (html) {
      const nestEnd = k < units.length - 1 && units[k + 1].item.path.length < unit.item.path.length;
      ranges.push(
        Decoration.replace({ widget: new ListItemWidget(html, unit.item, nestEnd), block: true }).range(
          unit.from,
          unit.to,
        ),
      );
    }
  });
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
  if (view.hasFocus && !view.state.field(previewField).focused) {
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
    if (
      !tr.docChanged &&
      !rendered &&
      sameSet(active, value.active) &&
      blankCursorLines(tr.state) === value.cursorLines &&
      activeItems(tr.state, blocks, active) === value.activeItems
    ) {
      return { ...value, focused, frozen };
    }
    const previews = new Map<number, string>();
    value.previews.forEach((images, from) => previews.set(tr.changes.mapPos(from, -1), images));
    return { blocks, active, focused, frozen, ...buildDecorations(tr.state, blocks, active, previews) };
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
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
          if (block.kind === "list") {
            // The items of a list show on their own while it is edited: those
            // of a list being edited at once, the others ahead of time.
            for (const unit of listItems(view.state, block)) {
              (active.has(i) && !selects(view.state, unit.from, unit.to) ? shown : items).push(unit.render);
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

class RenderedBlock extends WidgetType {
  constructor(
    readonly html: string,
    readonly kind: BlockKind,
  ) {
    super();
  }

  override eq(other: RenderedBlock): boolean {
    return other.html === this.html && other.kind === this.kind;
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement("div");
    dom.className = `rme-block rme-block-${this.kind} phabricator-remarkup`;
    // Server-rendered remarkup, the same HTML the page's preview shows.
    setHtml(dom, this.html);
    dom.title = "Click to edit, Ctrl+click to open a link";
    dom.addEventListener("mousedown", (event) => {
      const box = event.button === 0 ? checkboxAt(event) : null;
      if (box) {
        event.preventDefault();
        toggleCheckbox(view, dom, this.html, box);
      } else {
        selectWithMouse(view, event);
      }
    });
    dom.addEventListener("click", openLinkOnModClick);
    return dom;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/**
 * An item of a list being edited, rendered on its own (the server's HTML of
 * the item alone), in lists like those around it in the whole list, so the
 * page's styles indent and number it the same. Lists have no vertical
 * margins here; nestEnd takes the bottom margin of a nested list (its top
 * margin does not show on the page).
 */
class ListItemWidget extends WidgetType {
  constructor(
    readonly html: string,
    readonly item: ListItem,
    readonly nestEnd: boolean,
  ) {
    super();
  }

  override eq(other: ListItemWidget): boolean {
    return (
      other.html === this.html &&
      JSON.stringify(other.item.path) === JSON.stringify(this.item.path) &&
      other.item.hasMarks === this.item.hasMarks &&
      other.nestEnd === this.nestEnd
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement("div");
    dom.className = "rme-block rme-block-list rme-list-item phabricator-remarkup";
    dom.classList.toggle("rme-nest-end", this.nestEnd);
    // Server-rendered remarkup: the item, without lists of its own (there are none).
    const rendered = parseHtml(this.html).querySelector("li") ?? document.createElement("li");
    let parent: HTMLElement = dom;
    this.item.path.forEach((level, i) => {
      const list = document.createElement(level.tag);
      list.className = `remarkup-list${this.item.hasMarks ? " remarkup-list-with-checkmarks" : ""}`;
      const own = i === this.item.path.length - 1;
      // The items around this one: their classes place the lists in them, their markers do not show.
      const entry = own ? rendered : document.createElement("li");
      if (!own) {
        const mark = level.mark === null ? "" : level.mark ? " remarkup-checked-item" : " remarkup-unchecked-item";
        entry.className = `remarkup-list-item rme-list-around${mark}`;
      }
      if (level.tag === "ol") {
        (entry as HTMLLIElement).value = level.start + level.index;
      }
      list.append(entry);
      parent.append(list);
      parent = entry;
    });
    dom.title = "Click to edit, Ctrl+click to open a link";
    dom.addEventListener("mousedown", (event) => {
      const box = event.button === 0 ? checkboxAt(event) : null;
      if (box) {
        event.preventDefault();
        toggleCheckbox(view, dom, this.html, box);
      } else {
        selectWithMouse(view, event);
      }
    });
    dom.addEventListener("click", openLinkOnModClick);
    return dom;
  }

  override ignoreEvent(): boolean {
    return true;
  }
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
    // A click here is a click on the start of the line below, like in the textarea.
    dom.addEventListener("mousedown", (event) => {
      if (event.button === 0) {
        event.preventDefault();
        // Focus first: focusing places the browser's caret, which the editor would take over.
        view.focus();
        // The line below shows its source at once (CodeMirror tells of the focus a moment later).
        view.dispatch({
          selection: { anchor: view.posAtDOM(dom) },
          effects: setFocused.of(true),
          scrollIntoView: true,
        });
      }
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

/**
 * The checkbox of a checklist item clicked on. Phorge hides the input
 * and draws the box as the item's ::before, in the item's left padding.
 */
function checkboxAt(event: MouseEvent): HTMLInputElement | null {
  const item = (event.target as Element).closest(".remarkup-list-with-checkmarks > li");
  const box = item?.querySelector<HTMLInputElement>(':scope > input[type="checkbox"]');
  if (!item || !box) {
    return null;
  }
  const rect = item.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const y = event.clientY - rect.top;
  const style = getComputedStyle(item);
  // The box is on the first line, in the padding.
  return x >= 0 && x < parseFloat(style.paddingLeft) && y >= 0 && y < (parseFloat(style.lineHeight) || 22) ? box : null;
}

const CHECKBOX_ITEM = /^(\s*(?:[-*#]+|\d+[.)])\s*)\[([ xX]?)\]/;

/**
 * Checks or unchecks the n-th checkbox of a rendered checklist (or list item)
 * in the text. It shows the change right away: its HTML with the box toggled
 * stands in for the server's until it is rendered again.
 */
function toggleCheckbox(view: EditorView, dom: HTMLElement, html: string, box: HTMLInputElement): void {
  const isItem = dom.classList.contains("rme-list-item");
  const source = renderedSource(view.state, view.posAtDOM(dom), isItem);
  const index = Array.from(dom.querySelectorAll('input[type="checkbox"]')).indexOf(box);
  if (!source || index < 0) {
    return;
  }
  let pos = source.from;
  let seen = 0;
  for (const line of source.text.split("\n")) {
    const match = CHECKBOX_ITEM.exec(line);
    if (match && seen++ === index) {
      const at = pos + match[1].length + 1;
      const checked = match[2].trim() !== "";
      const container = document.createElement("div");
      container.append(parseHtml(html));
      const rendered = container.querySelectorAll('input[type="checkbox"]')[isItem ? 0 : index];
      rendered?.toggleAttribute("checked", !checked);
      rendered?.parentElement?.classList.toggle("remarkup-checked-item", !checked);
      rendered?.parentElement?.classList.toggle("remarkup-unchecked-item", checked);
      const changes = { from: at, to: at + match[2].length, insert: checked ? " " : "X" };
      const next = renderedSource(view.state.update({ changes }).state, source.from, isItem);
      if (next) {
        view.state.facet(blockRenderer)?.prime(next.render, container.innerHTML);
      }
      view.dispatch({ changes, userEvent: "input.check" });
      return;
    }
    pos += line.length + 1;
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

/** The position in the source of the text under the mouse in a rendered block or list item. */
function renderedPos(view: EditorView, dom: Element, event: MouseEvent): number | null {
  const source = renderedSource(view.state, view.posAtDOM(dom), dom.classList.contains("rme-list-item"));
  return source ? source.from + sourceOffset(source.text, event, dom) : null;
}

/** The rendered block or list item an element is in: its range in the source. */
function renderedUnit(view: EditorView, el: Element | null): { from: number; to: number } | null {
  const dom = el?.closest(".rme-block:not(.rme-image-preview)");
  if (!dom || !view.contentDOM.contains(dom)) {
    return null;
  }
  return renderedSource(view.state, view.posAtDOM(dom), dom.classList.contains("rme-list-item"));
}

/**
 * Where a selection made with the mouse from `anchor` ends: in the source
 * under the mouse, or over a rendered block or list item, at its far end.
 * Rendered text shows as selected only as a whole, so it is selected as a
 * whole: what shows while dragging is what is selected after.
 */
function dragHead(view: EditorView, event: MouseEvent, anchor: number): number | null {
  const unit = renderedUnit(view, document.elementFromPoint(event.clientX, event.clientY));
  if (unit) {
    return unit.from >= anchor ? unit.to : unit.from;
  }
  return view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
}

/**
 * Click and drag in a rendered block or list item. A click puts the cursor at
 * the clicked text. Dragging selects all of it and what the mouse reaches
 * (see dragHead()); Shift+click extends the selection to it. Blocks only
 * switch to their source when the mouse button is released, so nothing moves
 * under the mouse while selecting.
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
  const pos = renderedPos(view, dom, event);
  if (!unit || pos === null) {
    return;
  }
  const extend = (head: number | null, from: number) =>
    head === null
      ? null
      : EditorSelection.range(head >= unit.to ? unit.from : head <= unit.from ? unit.to : from, head);
  const selection = event.shiftKey
    ? EditorSelection.range(view.state.selection.main.anchor, dragHead(view, event, view.state.selection.main.anchor)!)
    : EditorSelection.cursor(pos);
  view.dispatch({ selection, effects: freezeBlocks.of(true) });
  view.focus();
  const start = { x: event.clientX, y: event.clientY };
  let dragging = false;
  const move = (moved: MouseEvent) => {
    dragging ||= Math.hypot(moved.clientX - start.x, moved.clientY - start.y) > 4;
    if (!dragging) {
      return;
    }
    const over = renderedUnit(view, document.elementFromPoint(moved.clientX, moved.clientY));
    const range =
      over?.from === unit.from
        ? EditorSelection.range(unit.from, unit.to)
        : extend(dragHead(view, moved, unit.from), unit.from);
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
    let anchor = event.shiftKey
      ? view.state.selection.main.anchor
      : view.posAtCoords({ x: event.clientX, y: event.clientY }, false);
    return {
      get: (current) => EditorSelection.single(anchor, dragHead(view, current, anchor) ?? anchor),
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
  // Rendered blocks within the selection look selected.
  ViewPlugin.define(() => ({
    update(update: ViewUpdate) {
      const { frozen } = update.state.field(previewField);
      if (!frozen && !update.startState.field(previewField).frozen) {
        return;
      }
      const { from, to } = update.state.selection.main;
      update.view.contentDOM.querySelectorAll(".rme-block").forEach((dom) => {
        const source = renderedSource(update.state, update.view.posAtDOM(dom), dom.classList.contains("rme-list-item"));
        dom.classList.toggle("rme-selected", frozen && !!source && from <= source.from && to >= source.to);
      });
    },
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
 * Finds the clicked text in the block source; the end of the block if not
 * found. Text that occurs more than once is found at the same occurrence.
 */
function sourceOffset(source: string, event: MouseEvent, container: Element): number {
  const caret = caretAt(event.clientX, event.clientY);
  if (!caret || caret.node.nodeType !== Node.TEXT_NODE) {
    return source.length;
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
  return source.length;
}

/** Whether a position is in a list block. */
export function inListBlock(state: EditorState, pos: number): boolean {
  return state.field(previewField).blocks.some((b) => b.kind === "list" && b.from <= pos && pos <= b.contentTo);
}

/**
 * Up and Down move by one visual row within a wrapped line, and otherwise to
 * exactly the previous or next line. Lines differ in height here (rendered
 * blocks, blank lines between blocks, headers), and CodeMirror's own motion
 * aims half a line height away, which can skip lines or stay on them.
 * A rendered block is entered at its end going up and at its start going
 * down, and then shows its source. On a list item, the cursor lands in its
 * text, not before its marker. With Shift, the selection extends by one line
 * of the source, also into a rendered block, instead of over all of it.
 */
function moveLine(view: EditorView, forward: boolean, extend = false): boolean {
  const { state } = view;
  const range = state.selection.main;
  if (!range.empty && !extend) {
    return false;
  }
  const line = state.doc.lineAt(range.head);
  const moved = view.moveVertically(range, forward);
  const movedLine = state.doc.lineAt(moved.head).number;
  // Within a wrapped line, CodeMirror's motion is right.
  if (movedLine === line.number) {
    return false;
  }
  const number = line.number + (forward ? 1 : -1);
  if (number < 1 || number > state.doc.lines) {
    return false;
  }
  const target = state.doc.line(number);
  let anchor: number | null = null;
  let table: number | null = null;
  state.field(previewField).decorations.between(target.from, target.from, (from, to, deco) => {
    // Rendered blocks, not points like spacers and image previews.
    if (deco.spec.block && to > from && from <= target.from && target.from <= to) {
      anchor = forward ? from : to;
      if (deco.spec.widget instanceof TableWidget) {
        table = from;
      }
    }
  });
  if (extend) {
    anchor = null;
  } else if (table !== null) {
    // Into the cells of a table.
    enterTable(view, table, forward);
    return true;
  }
  if (anchor === null) {
    // Keep the column, like CodeMirror does when it lands on the right line.
    anchor = movedLine === number ? moved.head : Math.min(target.from + (range.head - line.from), target.to);
  }
  // On a list item, not before its marker: in its text.
  const item = !extend && inListBlock(state, target.from) ? LIST_ITEM.exec(target.text) : null;
  if (item) {
    anchor = Math.max(anchor, target.to - item[5].length);
  }
  view.dispatch({
    selection: extend ? EditorSelection.range(range.anchor, anchor) : { anchor },
    scrollIntoView: true,
    userEvent: "select",
  });
  return true;
}

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
    gapMeasurer((state) => state.field(previewField).missingGaps),
    mouseSelection,
    Prec.high(
      keymap.of([
        { key: "ArrowDown", run: (view) => moveLine(view, true), shift: (view) => moveLine(view, true, true) },
        { key: "ArrowUp", run: (view) => moveLine(view, false), shift: (view) => moveLine(view, false, true) },
      ]),
    ),
    EditorView.focusChangeEffect.of((_state, focusing) => setFocused.of(focusing)),
  ];
}
