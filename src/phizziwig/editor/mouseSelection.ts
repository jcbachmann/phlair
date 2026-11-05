// Selecting with the mouse across the source and the rendered blocks: a
// click in rendered text puts the cursor at that text in the source, and
// blocks keep showing as they are until the button is released.

import { EditorSelection } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { clicked, freezeBlocks, previewField, renderedSource } from "./livePreview";
import { openLinkOnModClick } from "./openLink";

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
function selectWithMouse(view: EditorView, event: MouseEvent, dom: Element): void {
  if (event.button !== 0) {
    return;
  }
  event.preventDefault();
  if ((event.ctrlKey || event.metaKey) && (event.target as Element).closest("a[href]")) {
    // Opens the link on click, see openLinkOnModClick().
    return;
  }
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
export const mouseSelection = [
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
  // Clicks in rendered blocks, which CodeMirror leaves alone (their widgets ignore events).
  ViewPlugin.define((view) => {
    const onMouseDown = (event: MouseEvent) => {
      const block = (event.target as Element).closest?.(".rme-rendered");
      if (block && view.contentDOM.contains(block)) {
        selectWithMouse(view, event, block);
      }
    };
    const onClick = (event: MouseEvent) => {
      if ((event.target as Element).closest?.(".rme-rendered")) {
        openLinkOnModClick(event);
      }
    };
    view.contentDOM.addEventListener("mousedown", onMouseDown);
    view.contentDOM.addEventListener("click", onClick);
    return {
      destroy() {
        view.contentDOM.removeEventListener("mousedown", onMouseDown);
        view.contentDOM.removeEventListener("click", onClick);
      },
    };
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
