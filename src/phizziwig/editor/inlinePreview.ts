// The text being edited shows rendered, except for what the cursor or the
// selection is on, which shows its source for editing:
// - references, people, projects, links and URLs show as Phorge renders
//   them, each rendered by the server on its own and cached by its text;
// - the markers of bold, italic, monospaced, struck through, highlighted and
//   underlined text are hidden (sourceStyle.ts styles the text);
// - headers and quotes hide their markers, list items show their bullet,
//   number or checkbox (which can be clicked).
// A marker before text (a header's "= ", a list item's "- [ ] ") shows when
// the cursor is in it or before it, not at the start of the text after it.
// A click on a rendered reference or link puts the cursor at its end, where
// it shows its source again; Ctrl+click opens it.

import type { EditorState, Line, Range } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import type { Block } from "../blocks";
import { escapeText, parseHtml, setHtml } from "../html";
import type { ListItem } from "../list";
import type { RenderItem } from "../renderer";
import { LIST_ITEM, LITERAL_BLOCKS } from "../syntax";
import { listItems, openLinkOnModClick, previewField, rendererOf } from "./livePreview";

// Rendered by the server: links, URLs, then references to objects ("T12",
// "D3#7"), people ("@alice"), projects ("#docs") and task and revision cards
// ("{T12}"), like Phorge finds them.
const LINKS = [
  /\[\[[^\]\n]+?\]\]/g,
  /\[[^[\]\n]+\]\([^()\s]*[/@][^()\s]*\)/g,
  /\bhttps?:\/\/[^\s\]<>`]+[^\s\]<>`.,;:!?)'"]/g,
];
const REFERENCE =
  /(?<![\w/#@&{])(?:[A-Z]\d+(?:#\d+)?|@[\w.-]*\w)(?![\w@])|\{[TD]\d+\}|(?<![\w&#/@])#[\w.-]*[A-Za-z][\w-]*(?![\w#])/g;
// Formatting, by its marker; monospaced text first, nothing inside it is formatted.
const MONOSPACED = [/`[^`\n]+`/g, /##(?=\S)[^\n#]+?##/g];
const FORMATS = [
  /\*\*(?=\S)[^\n]+?\*\*/g,
  /(?<![:\w])\/\/(?=\S)[^\n]+?\/\//g,
  /~~[^\n]+?~~/g,
  /!![^\n]+?!!/g,
  /(?<!\w)__[^\n]+?__(?!\w)/g,
];
// Literal text: nothing in it is rendered.
const LITERAL = /%%%.*?%%%/g;

const inlineCache = new Map<string, string | null>();

/** What a token renders as, from the server's HTML of it alone; null if it renders as plain text. */
function inlineHtml(html: string): string | null {
  let inline = inlineCache.get(html);
  if (inline === undefined) {
    const content = parseHtml(html);
    const root = content.querySelector("p") ?? content.querySelector(".phabricator-remarkup") ?? content;
    const element = root.firstElementChild;
    // Only what renders as something else than its text: a tag, a link or a card.
    const alone = element && (root.textContent ?? "").trim() === (element.textContent ?? "").trim();
    inline = alone
      ? Array.from(root.childNodes, (node) =>
          node instanceof Element ? node.outerHTML : escapeText(node.textContent ?? ""),
        ).join("")
      : null;
    inlineCache.set(html, inline);
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

const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function roman(n: number): string {
  const digits: [number, string][] = [
    [1000, "m"],
    [900, "cm"],
    [500, "d"],
    [400, "cd"],
    [100, "c"],
    [90, "xc"],
    [50, "l"],
    [40, "xl"],
    [10, "x"],
    [9, "ix"],
    [5, "v"],
    [4, "iv"],
    [1, "i"],
  ];
  let out = "";
  for (const [value, digit] of digits) {
    for (; n >= value; n -= value) {
      out += digit;
    }
  }
  return out;
}

/** The marker of an item as the page shows it: a bullet, or its number in the style of its list's nesting. */
function itemMarker(item: ListItem): string {
  const own = item.path[item.path.length - 1];
  if (own.tag === "ul") {
    return "•";
  }
  const n = own.start + own.index;
  // Phorge's styles: ordered lists in ordered lists count with letters, then numerals.
  const nesting = item.path.filter((level) => level.tag === "ol").length;
  const letter = (alphabet: string) => (n >= 1 && n <= 26 ? alphabet[n - 1] : String(n));
  const label = [String(n), letter(ALPHA), letter(ALPHA.toLowerCase()), roman(n)][Math.min(nesting, 4) - 1];
  return `${label}.`;
}

/** The bullet, number or checkbox of a list item. A checkbox can be clicked. */
class ItemMarker extends WidgetType {
  constructor(
    readonly marker: string,
    readonly mark: boolean | null,
    /** Where the checkbox's "X" or " " is in the text. */
    readonly box: number,
  ) {
    super();
  }

  override eq(other: ItemMarker): boolean {
    return other.marker === this.marker && other.mark === this.mark && other.box === this.box;
  }

  toDOM(view: EditorView): HTMLElement {
    const dom = document.createElement("span");
    if (this.mark === null) {
      dom.className = "rme-item-marker";
      dom.textContent = this.marker;
      return dom;
    }
    // Phorge's checkbox, drawn by its styles for checklist items.
    dom.className = "rme-item-check remarkup-list-with-checkmarks";
    const box = document.createElement("span");
    box.className = `remarkup-list-item ${this.mark ? "remarkup-checked-item" : "remarkup-unchecked-item"}`;
    dom.append(box);
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

function overlaps(ranges: [number, number][], from: number, to: number): boolean {
  return ranges.some(([a, b]) => from < b && to > a);
}

/** The pieces of a line of a block being edited. */
function linePieces(
  block: Block,
  line: Line,
  items: Map<number, ListItem>,
  render: (text: string, from: number, to: number) => Range<Decoration> | null,
): Piece[] {
  const pieces: Piece[] = [];
  const text = line.text;
  const at = (i: number) => line.from + i;
  const taken: [number, number][] = Array.from(text.matchAll(LITERAL), (m) => [m.index, m.index + m[0].length]);
  const literal = [...taken];

  // Line markers.
  let match: RegExpExecArray | null;
  if (block.kind === "header" && (match = /^(=+|#+)\s*/.exec(text)) && match[0].length < text.length) {
    pieces.push({
      from: line.from,
      to: at(match[0].length),
      side: "before",
      decorations: [HIDE.range(line.from, at(match[0].length))],
    });
    const end = /\s*=+\s*$/.exec(text);
    if (end && end.index > match[0].length) {
      pieces.push({
        from: at(end.index),
        to: line.to,
        side: "after",
        decorations: [HIDE.range(at(end.index), line.to)],
      });
    }
  } else if (block.kind === "quote" && (match = /^>+ ?/.exec(text)) && !/^>+!/.test(text)) {
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
    const widget = new ItemMarker(itemMarker(item), item.mark, box);
    pieces.push({
      from: line.from,
      to: textFrom,
      side: "before",
      decorations: [Decoration.replace({ widget }).range(markerFrom, textFrom)],
    });
  }

  // Links and URLs, then references, rendered by the server.
  for (const pattern of [...LINKS, REFERENCE]) {
    for (const m of text.matchAll(pattern)) {
      const from = m.index;
      const to = from + m[0].length;
      if (overlaps(taken, from, to) || overlaps(monospacedIn(text), from, to)) {
        continue;
      }
      taken.push([from, to]);
      const decoration = render(m[0], at(from), at(to));
      if (decoration) {
        pieces.push({ from: at(from), to: at(to), side: "token", decorations: [decoration] });
      }
    }
  }

  // Formatting: its markers hide.
  const monospaced: [number, number][] = [];
  for (const [i, pattern] of MONOSPACED.entries()) {
    for (const m of text.matchAll(pattern)) {
      const from = m.index;
      const to = from + m[0].length;
      if (overlaps(literal, from, to) || overlaps(monospaced, from, to)) {
        continue;
      }
      monospaced.push([from, to]);
      const n = i === 0 ? 1 : 2;
      pieces.push({
        from: at(from),
        to: at(to),
        side: "token",
        decorations: [HIDE.range(at(from), at(from + n)), HIDE.range(at(to - n), at(to))],
      });
    }
  }
  for (const pattern of FORMATS) {
    for (const m of text.matchAll(pattern)) {
      const from = m.index;
      const to = from + m[0].length;
      // Not in monospaced text, literal text or a rendered link, and not across one.
      if (overlaps([...literal, ...monospaced, ...taken.filter(([a, b]) => !(a >= from && b <= to))], from, to)) {
        continue;
      }
      pieces.push({
        from: at(from),
        to: at(to),
        side: "token",
        decorations: [HIDE.range(at(from), at(from + 2)), HIDE.range(at(to - 2), at(to))],
      });
    }
  }
  return pieces;
}

/** Monospaced text of a line: nothing in it is a link or reference. */
function monospacedIn(text: string): [number, number][] {
  return MONOSPACED.flatMap((pattern) =>
    Array.from(text.matchAll(pattern), (m) => [m.index, m.index + m[0].length] as [number, number]),
  );
}

function build(view: EditorView): DecorationSet {
  const { state } = view;
  const { blocks, active, focused, decorations } = state.field(previewField);
  const renderer = rendererOf(state);
  if (!focused || !renderer) {
    return Decoration.none;
  }
  const ranges: Range<Decoration>[] = [];
  const missing: RenderItem[] = [];
  const render = (text: string, from: number, to: number) => {
    const item = { text, last: false };
    const html = renderer.get(item);
    if (html === undefined) {
      missing.push(item);
      return null;
    }
    const inline = inlineHtml(html);
    return inline ? Decoration.replace({ widget: new Rendered(inline, to - from) }).range(from, to) : null;
  };
  for (const i of active) {
    const block = blocks[i];
    if (LITERAL_BLOCKS.has(block.kind) || block.kind === "html-table" || block.kind === "table") {
      continue;
    }
    // The list items by their first line, for their markers.
    const items = new Map<number, ListItem>();
    if (block.kind === "list") {
      for (const unit of listItems(state, block)) {
        items.set(unit.from, unit.item);
      }
    }
    for (const visible of view.visibleRanges) {
      const from = Math.max(block.from, visible.from);
      const to = Math.min(block.contentTo, visible.to);
      for (let pos = from; pos <= to;) {
        const line = state.doc.lineAt(pos);
        pos = line.to + 1;
        // The rendered items of a list being edited hide their lines: nothing to render there.
        let rendered = false;
        decorations.between(line.from, line.to, (a, b, deco) => {
          rendered ||= !!deco.spec.block && b > a;
        });
        if (rendered) {
          continue;
        }
        for (const piece of linePieces(block, line, items, render)) {
          if (!revealed(state, piece)) {
            ranges.push(...piece.decorations);
          }
        }
      }
    }
  }
  if (missing.length) {
    renderer.request(missing);
  }
  return Decoration.set(ranges, true);
}

export const inlinePreview = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = build(view);
    }

    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.selectionSet ||
        update.viewportChanged ||
        update.startState.field(previewField) !== update.state.field(previewField)
      ) {
        this.decorations = build(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);
