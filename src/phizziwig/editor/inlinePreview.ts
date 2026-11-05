// The text blocks show rendered, except for what the cursor or the selection
// is on, which shows its source for editing. What is markup is what Phorge's
// inline rules find in the block (inlineTokens.ts):
// - references, people, projects, links, URLs, icons, keys and navigation
//   paths show as Phorge renders them, each rendered by the server on its own
//   and cached by its text; emoji names (":smile:") show their emoji;
// - the markers of bold, italic, monospaced, struck through, highlighted and
//   underlined text are hidden (sourceStyle.ts styles the text);
// - headers hide their markers, unless the cursor is on their line; quotes
//   hide theirs, list items show their bullet, number or checkbox (which can
//   be clicked);
// - file embeds ("{F12}"), memes and image macros hide while their images
//   show (livePreview.ts).
// Without the focus, nothing shows its source.
// A marker before text (a quote's "> ", a list item's "- [ ] ") shows when
// the cursor is in it or before it, not at the start of the text after it.
// A click on a rendered reference or link puts the cursor at its end, where
// it shows its source again; Ctrl+click opens it.

import type { EditorState, Line, Range, Text } from "@codemirror/state";
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import type { Block } from "../blocks";
import { escapeText, parseHtml, setHtml } from "../html";
import type { ListItem } from "../list";
import type { BlockRenderer, RenderItem } from "../renderer";
import { emojiOf, type InlineToken } from "../inline";
import { blockTokens, textTokens } from "./inlineTokens";
import { decorateLine, styleTokens } from "./sourceStyle";
import { LIST_ITEM } from "../syntax";
import {
  appendInLists,
  clicked,
  clickPosition,
  listItems,
  previewField,
  rendererOf,
  STYLED_BLOCKS,
} from "./livePreview";
import { editing } from "./focus";
import { openLinkOnModClick } from "./openLink";

const inlineCache = new Map<string, string | null>();

/** What a token renders as, from the server's HTML of it alone; null if it renders as plain text. */
function inlineHtml(html: string, whole = false): string | null {
  const key = whole ? `whole:${html}` : html;
  let inline = inlineCache.get(key);
  if (inline === undefined) {
    const content = parseHtml(html);
    const root = content.querySelector("p") ?? content.querySelector(".phabricator-remarkup") ?? content;
    const element = root.firstElementChild;
    // Only what renders as something else than its text: a tag, a link or a
    // card; for markup that is never text (an icon, keys), all of it.
    const alone = element && (whole || (root.textContent ?? "").trim() === (element.textContent ?? "").trim());
    inline = alone
      ? Array.from(root.childNodes, (node) =>
          node instanceof Element ? node.outerHTML : escapeText(node.textContent ?? ""),
        ).join("")
      : null;
    inlineCache.set(key, inline);
    if (inlineCache.size > 2000) {
      inlineCache.delete(inlineCache.keys().next().value!);
    }
  }
  return inline;
}

/** A reference, link or URL as the server renders it. */
class Rendered extends WidgetType {
  constructor(
    readonly html: string,
    readonly length: number,
  ) {
    super();
  }

  override eq(other: Rendered): boolean {
    return other.html === this.html && other.length === this.length;
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement("span");
    dom.className = "rme-inline-ref";
    // Server-rendered remarkup of the token alone.
    setHtml(dom, this.html);
    dom.addEventListener("mousedown", (event) => {
      if (event.button !== 0 || ((event.ctrlKey || event.metaKey) && (event.target as Element).closest("a[href]"))) {
        return;
      }
      event.preventDefault();
      view.focus();
      view.dispatch({ selection: { anchor: view.posAtDOM(dom) + this.length } });
    });
    dom.addEventListener("click", openLinkOnModClick);
    return dom;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** The bullet, number or checkbox of a list item. A checkbox can be clicked. */
class ItemMarker extends WidgetType {
  constructor(
    readonly item: ListItem,
    /** Where the checkbox's "X" or " " is in the text. */
    readonly box: number,
  ) {
    super();
  }

  get mark(): boolean | null {
    return this.item.mark;
  }

  override eq(other: ItemMarker): boolean {
    return (
      JSON.stringify(other.item.path) === JSON.stringify(this.item.path) &&
      other.item.hasMarks === this.item.hasMarks &&
      other.mark === this.mark &&
      other.box === this.box
    );
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement("span");
    if (this.mark === null) {
      // The browser's own marker of an item in lists like those of the
      // rendered list, at the start of the text: the same bullet or number
      // in the same place, whatever the font (style.css).
      dom.className = "rme-item-marker";
      const own = document.createElement("li");
      own.className = "remarkup-list-item";
      // A line of text, whose baseline the marker sits on.
      own.textContent = "\u200b";
      appendInLists(dom, this.item, own);
      // A click on the bullet or number (CodeMirror leaves events in widgets to them): see markerClick.
      dom.addEventListener("mousedown", (event) => {
        if (event.button === 0 && !event.shiftKey) {
          event.preventDefault();
          editMarker(view, view.state.doc.lineAt(view.posAtDOM(dom)));
        }
      });
      return dom;
    }
    // Phorge's checkbox: a checklist item as it renders it (with its hidden
    // input and the space after it), whose end is where the text starts, so
    // its styles draw the box in the same place (style.css).
    dom.className = "rme-item-check";
    const list = document.createElement("ul");
    list.className = "remarkup-list remarkup-list-with-checkmarks";
    const box = document.createElement("li");
    box.className = `remarkup-list-item ${this.mark ? "remarkup-checked-item" : "remarkup-unchecked-item"}`;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.disabled = true;
    input.tabIndex = -1;
    box.append(input, " ");
    list.append(box);
    dom.append(list);
    dom.addEventListener("mousedown", (event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      const at = view.posAtDOM(dom);
      const line = view.state.doc.lineAt(at);
      const match = /\[([ xX]?)\]/.exec(line.text.slice(at - line.from));
      if (match) {
        const from = at + match.index + 1;
        view.dispatch({
          changes: { from, to: from + match[1].length, insert: this.mark ? " " : "X" },
          userEvent: "input.check",
        });
      }
    });
    return dom;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** Something that shows rendered unless the selection is on it. */
interface Piece {
  /** What the selection must not touch: the token, or a marker and the side it may be on. */
  from: number;
  to: number;
  /** "text": a token, shown as source when touched. "before"/"after": a marker before or after text. */
  side: "token" | "before" | "after";
  decorations: Range<Decoration>[];
}

const HIDE = Decoration.replace({});
// The markers of formatting, before and after its text: a click next to one
// puts the cursor outside of it (outsideMarkers()).
const HIDE_OPEN = Decoration.replace({ marker: "open" });
const HIDE_CLOSE = Decoration.replace({ marker: "close" });

function revealed(state: EditorState, piece: Piece): boolean {
  return state.selection.ranges.some((r) => {
    if (piece.side === "before") {
      return r.from < piece.to && r.to >= piece.from;
    }
    if (piece.side === "after") {
      return r.from <= piece.to && r.to > piece.from;
    }
    return r.from <= piece.to && r.to >= piece.from;
  });
}

/** The pieces of the block markup of a line of a block being edited. */
function linePieces(block: Block, line: Line, items: Map<number, ListItem>): Piece[] {
  const pieces: Piece[] = [];
  const text = line.text;
  const at = (i: number) => line.from + i;

  // Line markers.
  let match: RegExpExecArray | null;
  if (block.kind === "header" && (match = /^(=+|#+)\s*/.exec(text)) && match[0].length < text.length) {
    // Its markers show while the cursor is anywhere on the line, like in Obsidian.
    const decorations = [HIDE.range(line.from, at(match[0].length))];
    const end = /\s*=+\s*$/.exec(text);
    if (end && end.index > match[0].length) {
      decorations.push(HIDE.range(at(end.index), line.to));
    }
    pieces.push({ from: line.from, to: line.to, side: "token", decorations });
  } else if (block.kind === "rule") {
    // The rule is drawn across the line (style.css).
    pieces.push({ from: line.from, to: line.to, side: "token", decorations: [HIDE.range(line.from, line.to)] });
    return pieces;
  } else if (
    block.kind === "note" &&
    line.from === block.from &&
    (match = /^\((?:NOTE|IMPORTANT|WARNING)\)\s*/.exec(text))
  ) {
    // "(NOTE) text": a note without the word, like Phorge shows it.
    pieces.push({
      from: line.from,
      to: at(match[0].length),
      side: "before",
      decorations: [HIDE.range(line.from, at(match[0].length))],
    });
  } else if (block.kind === "quote" && (match = /^>+(?:! ?)?\s?/.exec(text))) {
    // Also the ">>!" of a reply's header ("In T1, @alice wrote:").
    pieces.push({
      from: line.from,
      to: at(match[0].length),
      side: "before",
      decorations: [HIDE.range(line.from, at(match[0].length))],
    });
  } else if (block.kind === "list" && (match = LIST_ITEM.exec(text)) && items.has(line.from)) {
    const item = items.get(line.from)!;
    const markerFrom = at(match[1].length);
    const textFrom = line.to - match[5].length;
    const box = match[4] ? markerFrom + match[2].length + match[3].length : -1;
    const widget = new ItemMarker(item, box);
    pieces.push({
      from: line.from,
      to: textFrom,
      side: "before",
      decorations: [Decoration.replace({ widget }).range(markerFrom, textFrom)],
    });
  }

  return pieces;
}

type Render = (text: string, from: number, to: number, whole?: boolean) => Range<Decoration> | null;

/**
 * The pieces of the inline markup of a block being edited (inlineTokens.ts):
 * the markers of formatting hide, links, references, icons and the like show
 * as the server renders them, images their reference hides while they show.
 */
function tokenPieces(
  doc: Text,
  tokens: InlineToken[],
  render: Render,
  /** The rendered images of the block, which show beside its text (livePreview.ts). */
  images: string[],
  paragraph: boolean,
  /** Whether a token shows its source now (the cursor on it): it is not rendered, e.g. while typed. */
  asSource: (from: number, to: number) => boolean,
): Piece[] {
  const pieces: Piece[] = [];
  const shown = (part: string) => images.some((html) => html.includes(part));
  const piece = (token: InlineToken, decorations: Range<Decoration>[]) =>
    pieces.push({ from: token.from, to: token.to, side: "token", decorations });
  for (const token of tokens) {
    const { from, to } = token;
    const text = doc.sliceString(from, to);
    switch (token.kind) {
      case "monospace":
      case "bold":
      case "italic":
      case "del":
      case "underline":
      case "highlight": {
        // A piece of formatting that the browser splits may lack a marker.
        const markers: Range<Decoration>[] = [];
        if (token.contentFrom !== undefined && token.contentFrom > from) {
          markers.push(HIDE_OPEN.range(from, token.contentFrom));
        }
        if (token.contentTo !== undefined && to > token.contentTo) {
          markers.push(HIDE_CLOSE.range(token.contentTo, to));
        }
        if (markers.length) {
          piece(token, markers);
        }
        pieces.push(...tokenPieces(doc, token.children ?? [], render, images, paragraph, asSource));
        break;
      }
      case "embed":
      case "meme":
      case "macro": {
        // Images hide their reference while they show; other embeds ("{T12}") are cards.
        const image =
          token.kind === "meme"
            ? 'alt="Macro '
            : token.kind === "macro"
              ? `alt="${text.trim()}"`
              : /^\{(F\d+)/.exec(text)
                ? `data-rme-file="${/^\{(F\d+)/.exec(text)![1]}"`
                : null;
        if (image) {
          if ((token.kind !== "macro" || paragraph) && shown(image)) {
            piece(token, [HIDE.range(from, to)]);
          }
          break;
        }
        const decoration = !asSource(from, to) && render(text, from, to);
        if (decoration) {
          piece(token, [decoration]);
        }
        break;
      }
      case "anchor": {
        // Phorge shows nothing; the editor an anchor with its name.
        const name = /#([^\s}]+)/.exec(text)?.[1] ?? "";
        const html = `<span class="rme-anchor" title="An anchor to link to: #${escapeText(name)}"><span class="phui-icon-view phui-font-fa fa-hashtag" aria-hidden="true"></span>${escapeText(name)}</span>`;
        piece(token, [Decoration.replace({ widget: new Rendered(html, to - from) }).range(from, to)]);
        break;
      }
      case "emoji": {
        const emoji = emojiOf(text.slice(1, -1));
        if (emoji) {
          piece(token, [Decoration.replace({ widget: new Rendered(escapeText(emoji), to - from) }).range(from, to)]);
        }
        break;
      }
      case "icon":
      case "key":
      case "nav": {
        // Never text: all of what the server renders.
        const decoration = !asSource(from, to) && render(text, from, to, true);
        if (decoration) {
          piece(token, [decoration]);
        }
        break;
      }
      case "link":
      case "url":
      case "object":
      case "mention":
      case "project":
      case "handle":
      case "config":
      case "source":
      case "symbol": {
        const decoration = !asSource(from, to) && render(text, from, to);
        if (decoration) {
          piece(token, [decoration]);
        }
        break;
      }
    }
  }
  return pieces;
}

/** Renders references, links and other markup of the text with the server's HTML, asking for what is missing. */
function tokenRenderer(renderer: BlockRenderer, missing: RenderItem[]) {
  return (text: string, from: number, to: number, whole = false) => {
    const item = { text, last: false };
    const html = renderer.get(item);
    if (html === undefined) {
      missing.push(item);
      return null;
    }
    const inline = inlineHtml(html, whole);
    return inline ? Decoration.replace({ widget: new Rendered(inline, to - from) }).range(from, to) : null;
  };
}

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const { blocks, previews } = state.field(previewField);
  // The focus as it is now, not as last noted (a focus event may be missed,
  // e.g. when the window comes back).
  const focused = editing(view);
  const renderer = rendererOf(state);
  if (!renderer) {
    return Decoration.none;
  }
  const ranges: Range<Decoration>[] = [];
  const missing: RenderItem[] = [];
  const render = tokenRenderer(renderer, missing);
  for (const block of blocks) {
    if (!STYLED_BLOCKS.has(block.kind)) {
      continue;
    }
    // The images shown of the block (of its list items), by their files.
    const images = [...previews]
      .filter(([from]) => from >= block.from && from <= block.contentTo)
      .map(([, html]) => html);
    // The list items by their first line, for their markers.
    const items = new Map<number, ListItem>();
    if (block.kind === "list") {
      for (const unit of listItems(state, block)) {
        items.set(unit.from, unit.item);
      }
    }
    const visible = (from: number, to: number) => view.visibleRanges.some((r) => from <= r.to && to >= r.from);
    const asSource = (from: number, to: number) =>
      focused && revealed(state, { from, to, side: "token", decorations: [] });
    const pieces = tokenPieces(
      state.doc,
      blockTokens(state.doc, block),
      render,
      images,
      block.kind === "paragraph",
      asSource,
    );
    for (const range of view.visibleRanges) {
      const from = Math.max(block.from, range.from);
      const to = Math.min(block.contentTo, range.to);
      for (let pos = from; pos <= to;) {
        const line = state.doc.lineAt(pos);
        pos = line.to + 1;
        pieces.push(...linePieces(block, line, items));
      }
    }
    for (const piece of pieces) {
      // Without the focus, all of it shows rendered.
      if (visible(piece.from, piece.to) && (!focused || !revealed(state, piece))) {
        ranges.push(...piece.decorations);
      }
    }
  }
  if (missing.length) {
    renderer.request(missing);
  }
  return Decoration.set(ranges, true);
}

/** The list item line of a click left of its text, on its first row: its line and marker; null elsewhere. */
function markerArea(view: EditorView, event: MouseEvent): { line: Line; match: RegExpExecArray; pos: number } | null {
  if (
    event.button !== 0 ||
    event.shiftKey ||
    event.detail > 1 ||
    (event.target as Element).closest(".rme-item-check")
  ) {
    // Double clicks select as usual.
    return null;
  }
  const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
  if (pos === null) {
    return null;
  }
  const line = view.state.doc.lineAt(pos);
  const block = view.state
    .field(previewField)
    .blocks.find((b) => b.kind === "list" && b.from <= pos && pos <= b.contentTo);
  const match = block ? LIST_ITEM.exec(line.text) : null;
  const textAt = match ? view.coordsAtPos(line.to - match[5].length, 1) : null;
  if (!match || !textAt || event.clientX >= textAt.left || event.clientY >= textAt.bottom) {
    return null;
  }
  return { line, match, pos };
}

/**
 * A click on the bullet or number of a list item (left of its text, on its
 * first row) puts the cursor after it, where it shows its source for editing;
 * left of it, at the start of the line. A checkbox toggles instead
 * (ItemMarker).
 */
const markerClick = EditorView.domEventHandlers({
  mousedown(event, view) {
    const area = markerArea(view, event);
    if (!area) {
      return false;
    }
    const { line, match, pos } = area;
    // Where the marker starts: drawn, or its source while the cursor is on it.
    const left = markerLeft(view, line) ?? view.coordsAtPos(line.from + match[1].length, 1)?.left;
    if (left === undefined) {
      return false;
    }
    event.preventDefault();
    if (event.clientX < left) {
      // Left of the marker: the start of the line, before it and the indentation.
      view.focus();
      view.dispatch({ selection: { anchor: line.from }, userEvent: "select.pointer" });
    } else if (markerLeft(view, line) !== null) {
      editMarker(view, line);
    } else {
      // On the source of the marker: where the click is in it.
      view.focus();
      view.dispatch({ selection: { anchor: clicked(view, pos) }, userEvent: "select.pointer" });
    }
    return true;
  },
});

/**
 * Where the bullet, number or checkbox of a list item starts on the screen;
 * null where it shows its source. The browser draws a bullet or number
 * outside of its item: it is as wide as when drawn inside of it.
 */
function markerLeft(view: EditorView, line: Line): number | null {
  const { node } = view.domAtPos(line.from);
  const lineDom = (node instanceof Element ? node : node.parentElement)?.closest(".cm-line");
  const check = lineDom?.querySelector(".rme-item-check li");
  if (check) {
    // Phorge draws the box at the start of its item.
    return check.getBoundingClientRect().left;
  }
  const own = lineDom?.querySelector<HTMLElement>(".rme-item-marker li:not(.rme-list-around)");
  const text = own?.firstChild;
  if (!own || !text) {
    return null;
  }
  const range = document.createRange();
  range.selectNodeContents(text);
  const outside = range.getBoundingClientRect().left;
  own.style.listStylePosition = "inside";
  const inside = range.getBoundingClientRect().left;
  own.style.listStylePosition = "";
  return outside - (inside - outside);
}

/**
 * Where a click puts the cursor: next to a hidden formatting marker, outside
 * of it, so "**bold**" clicked after "bold" puts it after the "**", as the
 * text looks (the markers show once the cursor is there).
 */
function outsideMarkers(view: EditorView, pos: number): number {
  let result = pos;
  view.plugin(inlinePlugin)?.decorations.between(pos, pos, (from, to, deco) => {
    if (deco.spec.marker === "open" && to === pos) {
      result = from;
    } else if (deco.spec.marker === "close" && from === pos) {
      result = to;
    }
  });
  return result;
}

/** Puts the cursor after the bullet or number of a list item, which then shows its source. */
function editMarker(view: EditorView, line: Line): void {
  const match = LIST_ITEM.exec(line.text);
  if (match) {
    view.focus();
    view.dispatch({
      selection: { anchor: line.from + match[1].length + match[2].length },
      userEvent: "select.pointer",
    });
  }
}

const inlinePlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    /** The focus the decorations were made for. */
    private focused: boolean;
    private readonly refocus: () => void;

    constructor(readonly view: EditorView) {
      this.focused = editing(view);
      this.decorations = build(view);
      // Back in the window: an update, in case the editor did not note its focus coming back.
      this.refocus = () => setTimeout(() => view.dom.isConnected && view.dispatch({}));
      window.addEventListener("focus", this.refocus);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.focusChanged ||
        update.viewportChanged ||
        editing(update.view) !== this.focused ||
        update.startState.field(previewField) !== update.state.field(previewField)
      ) {
        this.focused = editing(update.view);
        this.decorations = build(update.view);
      }
    }

    destroy() {
      window.removeEventListener("focus", this.refocus);
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

export const inlinePreview = [inlinePlugin, markerClick, clickPosition.of(outsideMarkers)];

/**
 * The live preview of a table cell's editor (tableEditor.ts): the cell's
 * line styled and rendered like a line of a paragraph,
 * except where the cursor is, with the renderings of the editor of the text.
 */
export function cellPreview(main: EditorView) {
  const build = (view: EditorView): DecorationSet => {
    const renderer = rendererOf(main.state);
    if (!renderer) {
      return Decoration.none;
    }
    const line = view.state.doc.line(1);
    const length = view.state.doc.length;
    const block: Block = { kind: "paragraph", from: 0, to: length, contentTo: length, empty: false };
    const ranges: Range<Decoration>[] = [];
    decorateLine(block, line.from, line.text, true, ranges);
    const tokens = textTokens(line.text, line.from);
    styleTokens(tokens, ranges);
    const missing: RenderItem[] = [];
    const asSource = (from: number, to: number) =>
      view.hasFocus && revealed(view.state, { from, to, side: "token", decorations: [] });
    for (const piece of tokenPieces(view.state.doc, tokens, tokenRenderer(renderer, missing), [], false, asSource)) {
      if (!view.hasFocus || !revealed(view.state, piece)) {
        ranges.push(...piece.decorations);
      }
    }
    if (missing.length) {
      renderer.request(missing);
    }
    return Decoration.set(ranges, true);
  };
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;

      constructor(view: EditorView) {
        this.decorations = build(view);
      }

      // On every update: renderings arriving come as an empty one (tableEditor.ts).
      update(update: ViewUpdate) {
        this.decorations = build(update.view);
      }
    },
    { decorations: (plugin) => plugin.decorations },
  );
}
