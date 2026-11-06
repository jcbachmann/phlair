// Text blocks (paragraphs, headers, lists, quotes, notes, rules) always show their
// source, styled like the rendered text (sourceStyle.ts), with their markup
// hidden except where the cursor is (inlinePreview.ts), so nothing moves when
// the cursor moves. Other blocks (code, literal, ...) show as the server renders
// them, except while the cursor is in them; tables are edited as tables
// (tableEditor.ts).

import { EditorState, Facet, type Line, type Range, StateEffect, StateField } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import { type Block, type BlockKind, splitBlocks } from "../blocks";
import type { BlockRenderer, RenderItem } from "../renderer";
import { blockEdges, clearGaps, gapKey, gapMeasurer, gapsField, setGaps } from "./gaps";
import { focusField, focusTracking, setFocused } from "./focus";
import {
  floatPadMeasure,
  floatPadsField,
  ImagePreview,
  type ImageSource,
  imagePositions,
  imagesOf,
  setFloatPads,
  splitImages,
} from "./imagePreview";
import { blockTokens } from "./inlineTokens";
import type { InlineToken } from "../inline";
import { findEmbeds } from "../embed";
import { focusedCellSource, refreshCellEditor, setTableMode, TableWidget, tableModeField } from "./tableEditor";
import { setHtml } from "../html";
import { knownHeight, LINE_HEIGHT, rememberHeight } from "./heights";
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

export interface PreviewState {
  blocks: Block[];
  /** Indexes of the blocks shown as source. */
  active: Set<number>;
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
export function renderedSource(
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
      // A block with images keeps showing them by its source, so it does not
      // collapse; until the edited text is rendered, the last images stay.
      const html = htmls[i];
      const images = (html !== undefined ? imagesOf(html) : undefined) ?? oldPreviews.get(block.from);
      if (images) {
        previews.set(block.from, images);
        if (lineImages(state, block, block.from, block.contentTo, images, ranges, true)) {
          // Floating images reach below the block like in the rendered text.
          const pad = state.field(floatPadsField, false)?.get(block.from);
          if (pad) {
            const last = state.doc.lineAt(block.contentTo);
            ranges.push(Decoration.line({ attributes: { style: `padding-bottom: ${pad}px` } }).range(last.from));
          }
        }
      }
    } else if (block.kind === "table" && tableMode !== "text") {
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
          Decoration.replace({
            widget: new RenderedBlock(
              html,
              block.kind,
              fences(state, block),
              state.doc.lineAt(block.contentTo).number - state.doc.lineAt(block.from).number + 1,
            ),
            block: true,
          }).range(block.from, block.contentTo),
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

/** The images of the items of a list, each item rendered on its own, by the lines of their embeds. */
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
      lineImages(state, block, unit.from, unit.to, images, ranges, false);
    }
  }
}

/** The text of a quote line without its markers (">", ">>! In T1, @alice wrote:" too). */
function quoteContent(text: string): string {
  return text.replace(/^\s*(?:>+!?\s?)+/, "");
}

/** The images, macros and memes of a block from `from` to `to`, in their order. */
function imageSources(state: EditorState, block: Block, from: number, to: number): ImageSource[] {
  const sources: ImageSource[] = [];
  const visit = (tokens: InlineToken[]) => {
    for (const token of tokens) {
      if (token.from >= from && token.to <= to) {
        const text = state.doc.sliceString(token.from, token.to);
        const file = token.kind === "embed" ? /^\{(F\d+)/.exec(text)?.[1] : undefined;
        if (file) {
          sources.push({ pos: token.from, file });
        } else if (token.kind === "macro") {
          sources.push({ pos: token.from, macro: text.trim() });
        } else if (token.kind === "meme") {
          sources.push({ pos: token.from, meme: true });
        }
      }
      visit(token.children ?? []);
    }
  };
  visit(blockTokens(state.doc, block));
  return sources;
}

/**
 * Shows the images of a block from `from` to `to` (a list item's) by the lines
 * of their embeds, like in the rendered text: above the line, or below it
 * when text comes before them on the line (a list item's marker too; in the
 * rendered text, they are in or after that text). Floating images (if
 * `float`) float beside the lines from theirs on. In a quote, on its border.
 * Returns whether some float.
 */
function lineImages(
  state: EditorState,
  block: Block,
  from: number,
  to: number,
  images: string,
  ranges: Range<Decoration>[],
  float: boolean,
): boolean {
  const { doc } = state;
  const parts = splitImages(images);
  const positions = imagePositions(parts, imageSources(state, block, from, to), from);
  // The images of each line, from the position of the first.
  const lines = new Map<number, { line: Line; at: number; html: string }>();
  parts.forEach((part, k) => {
    const line = doc.lineAt(positions[k]!);
    const group = lines.get(line.number);
    if (group) {
      group.html += part.html;
    } else {
      lines.set(line.number, { line, at: positions[k]!, html: part.html });
    }
  });
  const first = doc.lineAt(block.from).number;
  const last = doc.lineAt(block.contentTo).number;
  let floats = false;
  for (const { line, at, html } of lines.values()) {
    // See ImagePreview.firstEmbed.
    const embedsBefore = findEmbeds(doc.sliceString(block.from, line.from)).length;
    if (float && /phabricator-remarkup-embed-float/.test(html)) {
      floats = true;
      ranges.push(
        Decoration.widget({ widget: new ImagePreview(html, "float", "", embedsBefore), block: true, side: -1 }).range(
          line.from,
        ),
      );
      continue;
    }
    const before = doc.sliceString(line.from, at);
    const above = !(block.kind === "quote" ? quoteContent(before) : before).trim();
    let classes = "";
    if (block.kind === "quote") {
      // At an end of the quote, the preview has the quote's padding there instead of the line.
      const edge = above
        ? line.number === first
          ? "rme-quote-first"
          : ""
        : line.number === last
          ? "rme-quote-last"
          : "";
      classes = `rme-preview-quote ${edge}`.trim();
      if (edge) {
        ranges.push(Decoration.line({ class: above ? "rme-image-above" : "rme-image-below" }).range(line.from));
      }
    }
    const widget = new ImagePreview(html, above ? "above" : "below", classes, embedsBefore);
    ranges.push(
      above
        ? Decoration.widget({ widget, block: true, side: -1 }).range(line.from)
        : Decoration.widget({ widget, block: true, side: 1 }).range(line.to),
    );
  }
  return floats;
}

/** Starts and ends a selection with the mouse; see PreviewState.frozen. */
export const freezeBlocks = StateEffect.define<boolean>();

export const previewField = StateField.define<PreviewState>({
  create(state) {
    const blocks = splitBlocks(state.doc.toString());
    const active = activeBlocks(state, blocks, false);
    return { blocks, active, frozen: false, ...buildDecorations(state, blocks, active, new Map()) };
  },
  update(value, tr) {
    let { frozen } = value;
    const focused = tr.state.field(focusField);
    const focusChanged = focused !== tr.startState.field(focusField);
    let rendered = false;
    for (const effect of tr.effects) {
      if (effect.is(freezeBlocks)) {
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
    if (!tr.docChanged && !tr.selection && !focusChanged && frozen === value.frozen && !rendered) {
      return value;
    }
    if (frozen && !tr.docChanged && !rendered) {
      return { ...value, frozen };
    }
    const blocks = tr.docChanged ? splitBlocks(tr.state.doc.toString()) : value.blocks;
    const active = frozen && !tr.docChanged ? value.active : activeBlocks(tr.state, blocks, focused);
    // The cursor moved within what shows as source: the decorations stay.
    if (!tr.docChanged && !rendered && sameSet(active, value.active)) {
      return { ...value, frozen };
    }
    const previews = new Map<number, string>();
    value.previews.forEach((images, from) => previews.set(tr.changes.mapPos(from, -1), images));
    return { blocks, active, frozen, ...buildDecorations(tr.state, blocks, active, previews) };
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
    /** Lines of its source, for the estimate of its height. */
    readonly lines: number,
  ) {
    super();
  }

  override get estimatedHeight(): number {
    return knownHeight(this.html, this.lines * LINE_HEIGHT + 16);
  }

  override eq(other: RenderedBlock): boolean {
    return (
      other.html === this.html &&
      other.kind === this.kind &&
      other.fences[0] === this.fences[0] &&
      other.fences[1] === this.fences[1]
    );
  }

  toDOM(): HTMLElement {
    const dom = document.createElement("div");
    // Clicks and selecting with the mouse: see mouseSelection.ts.
    dom.className = `rme-block rme-rendered rme-block-${this.kind} phabricator-remarkup`;
    dom.classList.toggle("rme-fence-before", this.fences[0]);
    dom.classList.toggle("rme-fence-after", this.fences[1]);
    // Server-rendered remarkup, the same HTML the page's preview shows.
    setHtml(dom, this.html);
    rememberHeight(this.html, dom);
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

/** Whether a position is in a list block. */
export function inListBlock(state: EditorState, pos: number): boolean {
  return state.field(previewField).blocks.some((b) => b.kind === "list" && b.from <= pos && pos <= b.contentTo);
}

/** The live preview; see above. With mouseSelection.ts and verticalMotion.ts for moving in it. */
export function livePreview(renderer: BlockRenderer) {
  return [
    blockRenderer.of(renderer),
    // Before previewField, which reads them.
    focusTracking,
    tableModeField,
    gapsField,
    floatPadsField,
    previewField,
    floatPadMeasure((state) => state.field(previewField)),
    renderRequests,
    // Renderings arriving: also for the cell being edited live, whose table does not change.
    EditorView.updateListener.of((update) => {
      if (update.transactions.some((tr) => tr.effects.some((effect) => effect.is(renderedEffect)))) {
        refreshCellEditor();
      }
    }),
    gapMeasurer((state) => state.field(previewField).missingGaps),
    // Images change the height of blocks when they arrive.
    ViewPlugin.define((view) => {
      const onLoad = (event: Event) => event.target instanceof HTMLImageElement && view.requestMeasure();
      view.contentDOM.addEventListener("load", onLoad, true);
      return { destroy: () => view.contentDOM.removeEventListener("load", onLoad, true) };
    }),
  ];
}
