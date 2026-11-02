// The editor draws its cursor itself, where its text goes: the browser's own
// caret is often elsewhere next to elements that are not text, like the
// placeholder of an empty field, hidden markup and rendered references. The
// selection stays the browser's (drawSelection() would draw it behind the
// backgrounds of notes and quotes), and so does the caret in a table cell.

import { EditorView, layer, RectangleMarker } from "@codemirror/view";

const cursorLayer = layer({
  above: true,
  markers(view) {
    const range = view.state.selection.main;
    return range.empty ? RectangleMarker.forRange(view, "cm-cursor cm-cursor-primary", range) : [];
  },
  update(update, dom) {
    // Visible right away after it moved: restart the blinking.
    if (update.selectionSet) {
      dom.style.animationName = dom.style.animationName === "cm-blink" ? "cm-blink2" : "cm-blink";
    }
    return update.docChanged || update.selectionSet;
  },
  class: "cm-cursorLayer",
});

// Important, like drawSelection(): CodeMirror's base theme sets the caret color more specifically.
const hideNativeCaret = EditorView.theme({
  ".cm-content": { caretColor: "transparent !important" },
  // A table cell being edited has the browser's caret (the editor is not
  // focused then, so its cursor does not show).
  ".cm-content :focus": { caretColor: "initial !important" },
  ".cm-cursor": { borderLeftColor: "var(--rme-color, currentColor)" },
});

export const cursor = [cursorLayer, hideNativeCaret];
