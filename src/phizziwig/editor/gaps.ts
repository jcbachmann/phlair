// The space between blocks on consecutive lines (e.g. a paragraph right
// above a list), as on the page: Phorge's CSS gives each element its margins
// (28px above a heading, 24px around a rule, ...), and the margins of
// neighbors collapse. Rendered blocks have no margins in the editor
// (CodeMirror measures lines without them), so a spacer takes their place: as
// high as the gap between the two elements when the page lays them out. That
// gap is measured with the page's CSS, per pair of elements, so it also holds
// for Phorge and other styles. A blank line between blocks is a line like any
// other, as high as a line of text. Blocks in a quote (lines.ts) have the
// gaps of their elements in a quote.

import { type EditorState, StateEffect, StateField } from "@codemirror/state";
import { type EditorView, ViewPlugin } from "@codemirror/view";
import type { Block, BlockKind } from "../blocks";
import { LruCache } from "../../cache";
import { parseHtml } from "../html";
import { wikiSlug } from "../phorge";
import { NOTE_PREFIX } from "../syntax";
import { hostTextarea } from "./host";

/** Adds measured gaps, by pair key (see gapKey()). */
export const setGaps = StateEffect.define<Map<string, number>>();

/** Forgets the gaps, e.g. when the page's styles changed. */
export const clearGaps = StateEffect.define<null>();

export const gapsField = StateField.define<Map<string, number>>({
  create: () => new Map(),
  update(gaps, tr) {
    for (const effect of tr.effects) {
      if (effect.is(clearGaps)) {
        gaps = new Map();
      } else if (effect.is(setGaps)) {
        gaps = new Map([...gaps, ...effect.value]);
      }
    }
    return gaps;
  },
});

/** An element by tag and classes, e.g. "H2.remarkup-header". */
type Signature = string;

/** Markup of an element of each signature, to measure it with; images left out. */
const samples = new Map<Signature, string>();
const MIN_EDGES = 2000;
/** The edges of rendered blocks by their HTML; see fitEdgesCache(). */
const edgesCache = new LruCache<string, [Signature, Signature]>(MIN_EDGES);

/** Keeps the edges of at least twice as many blocks as a text has, like the renderer its HTML. */
export function fitEdgesCache(blockCount: number): void {
  edgesCache.capacity = Math.max(edgesCache.capacity, MIN_EDGES, blockCount * 2);
}

function signature(element: Element): Signature {
  return [element.tagName, ...Array.from(element.classList).sort()].join(".");
}

/** The first and last element of rendered HTML. */
function htmlEdges(html: string): [Signature, Signature] | null {
  let edges = edgesCache.get(html);
  if (!edges) {
    const content = parseHtml(html);
    const root = content.querySelector(":scope > .phabricator-remarkup") ?? content;
    const first = root.firstElementChild;
    const last = root.lastElementChild;
    if (!first || !last) {
      return null;
    }
    for (const element of [first, last]) {
      const sig = signature(element);
      if (!samples.has(sig)) {
        const clone = element.cloneNode(true) as Element;
        clone.querySelectorAll("img").forEach((img) => img.remove());
        samples.set(sig, clone.outerHTML);
      }
    }
    edges = [signature(first), signature(last)];
    edgesCache.set(html, edges);
  }
  return edges;
}

/** The element a block renders as, from its text: for blocks being edited before they are rendered. */
function kindSignature(kind: BlockKind, text: string): Signature {
  switch (kind) {
    case "header": {
      const lines = text.split("\n");
      const level = lines.length > 1 ? (/^=/.test(lines[1]) ? 1 : 2) : (/^(=+|#+)/.exec(text)?.[1].length ?? 1);
      return `H${Math.min(level, 5) + 1}.remarkup-header`;
    }
    case "list":
      return /^\s*(#|\d)/.test(text) ? "OL.remarkup-list" : "UL.remarkup-list";
    case "quote":
      return "BLOCKQUOTE";
    case "note": {
      const match = NOTE_PREFIX.exec(text);
      return `DIV.remarkup-${(match?.[1] ?? match?.[2] ?? "NOTE").toLowerCase()}`;
    }
    case "code":
    case "literal":
    case "interpreter":
      return "DIV.remarkup-code-block";
    case "table":
    case "html-table":
      return "DIV.remarkup-table-wrap";
    case "rule":
      return "HR.remarkup-hr";
    default:
      return "P";
  }
}

/** The first and last element of a block, from its HTML if there is any. */
export function blockEdges(state: EditorState, block: Block, html: string | undefined): [Signature, Signature] {
  return textEdges(block.kind, state.doc.sliceString(block.from, block.contentTo), html);
}

/** The first and last element of a block by its kind and text (in a quote, without the quote's markers). */
export function textEdges(kind: BlockKind, text: string, html: string | undefined): [Signature, Signature] {
  const edges = html ? htmlEdges(html) : null;
  if (edges) {
    return edges;
  }
  const sig = kindSignature(kind, text);
  return [sig, sig];
}

/** The key of the gap between two elements; `quoted` in a quote. */
export function gapKey(above: Signature, below: Signature, quoted = false): string {
  return `${quoted ? QUOTED : ""}${above}|${below}`;
}

const QUOTED = "quote:";

function sampleOf(sig: Signature): string {
  const sample = samples.get(sig);
  if (sample) {
    return sample;
  }
  const [tag, ...classes] = sig.split(".");
  return `<${tag} class="${classes.join(" ")}">${tag === "HR" ? "" : "x"}</${tag}>`;
}

/**
 * Measures the gaps of the pairs: both elements laid out after each other in
 * the editor (for its fonts), with the page's CSS. An element first in its
 * parent loses its top margin there, so a paragraph goes first.
 */
function measure(view: EditorView, keys: string[]): Map<string, number> {
  const container = document.createElement("div");
  container.style.cssText = "position: absolute; left: 0; right: 0; top: 0; visibility: hidden; pointer-events: none;";
  // Wiki pages have styles of their own, e.g. more space around code blocks.
  const textarea = view.state.facet(hostTextarea);
  if (textarea && wikiSlug(textarea) !== null) {
    container.className = "phui-document-content";
  }
  const probe = document.createElement("div");
  probe.className = "phabricator-remarkup";
  container.append(probe);
  const pairs = keys.map((key) => {
    const quoted = key.startsWith(QUOTED);
    const [above, below] = key.slice(quoted ? QUOTED.length : 0).split("|");
    const pair = document.createElement(quoted ? "blockquote" : "div");
    pair.style.display = "flow-root";
    pair.append(parseHtml(`<p>x</p>${sampleOf(above)}${sampleOf(below)}<p>x</p>`));
    probe.append(pair);
    return pair;
  });
  view.dom.append(container);
  const gaps = new Map<string, number>();
  pairs.forEach((pair, i) => {
    const [, a, b] = Array.from(pair.children);
    // At least a sliver, so the spacer can still be clicked.
    gaps.set(keys[i], Math.max(2, b.getBoundingClientRect().top - a.getBoundingClientRect().bottom));
  });
  container.remove();
  return gaps;
}

/** Measures the gaps the decorations ask for, outside of CodeMirror's update cycle. */
export function gapMeasurer(missing: (state: EditorState) => Set<string>) {
  return ViewPlugin.define((view) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      // A hidden editor measures nothing; it is measured again when it shows (attach.ts).
      if (timer === undefined && missing(view.state).size && view.dom.getClientRects().length) {
        timer = setTimeout(() => {
          timer = undefined;
          const keys = Array.from(missing(view.state));
          if (keys.length) {
            view.dispatch({ effects: setGaps.of(measure(view, keys)) });
          }
        });
      }
    };
    schedule();
    return {
      update: schedule,
      destroy: () => clearTimeout(timer),
    };
  });
}
