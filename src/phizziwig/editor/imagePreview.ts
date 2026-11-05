// The images of blocks being edited, shown with their source as they are
// in the rendered text: below or above it, or floating beside it.

import { type EditorState, StateEffect, StateField } from "@codemirror/state";
import { ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";
import type { Block } from "../blocks";
import { parseHtml, setHtml } from "../html";
import { knownHeight, rememberHeight } from "./heights";

const embedCache = new Map<string, string | null>();

/** The embedded images of rendered HTML, or null if it has none. */
export function imagesOf(html: string): string | null {
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

/** The images of a block being edited, shown below its source. */
export class ImagePreview extends WidgetType {
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

  /** Floating images have no height of their own; others had theirs when they showed before. */
  override get estimatedHeight(): number {
    return this.placement === "float" ? 0 : knownHeight(this.html, -1);
  }

  toDOM(): HTMLElement {
    const dom = document.createElement("div");
    dom.className = `rme-block rme-image-preview rme-preview-${this.placement} phabricator-remarkup`;
    // Server-rendered images of the block.
    setHtml(dom, this.html);
    if (this.placement !== "float") {
      rememberHeight(this.html, dom);
    }
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
 * How far the floating images of a block being edited reach below its last
 * line, by block start: that line gets as much padding, so the image stays
 * within the block like in the rendered text.
 */
export const setFloatPads = StateEffect.define<Map<number, number>>();

export const floatPadsField = StateField.define<Map<number, number>>({
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

/**
 * Measures floatPadsField after the layout changed (e.g. an image arrived),
 * or what the live preview shows changed (`preview`, with the blocks of the text).
 */
export const floatPadMeasure = (preview: (state: EditorState) => { blocks: Block[] }) =>
  ViewPlugin.define((view) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = () =>
      view.requestMeasure({
        key: floatPadsField,
        read: () => {
          const pads = new Map<number, number>();
          const { blocks } = preview(view.state);
          view.contentDOM.querySelectorAll<HTMLElement>(".rme-preview-float").forEach((preview) => {
            const from = view.posAtDOM(preview);
            const block = blocks.find((b) => b.from === from);
            const line = block && (view.domAtPos(block.contentTo).node as Node);
            const lineDom =
              line instanceof Element ? line.closest(".cm-line") : line?.parentElement?.closest(".cm-line");
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
        if (update.docChanged || update.geometryChanged || preview(update.startState) !== preview(update.state)) {
          measure();
        }
      },
      destroy: () => clearTimeout(timer),
    };
  });
