// Typing habits from other editors: "*italic*" means nothing in remarkup, so
// it becomes "//italic//" as it is typed (Markdown's "[text](url)" needs
// nothing: Phorge renders it as a link, and "# Title" alone is a heading
// too). "*" or "`" typed over selected text makes it bold or monospaced, "{"
// and "[" put it in braces or brackets.

import { isolateHistory } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { inMonospace, LITERAL_BLOCKS } from "../syntax";
import { blockAtCursor } from "./livePreview";

const ITALIC = /(^|[^*\w])\*([^*\s](?:[^*\n]*[^*\s])?)$/;

/** Whether text ends inside monospaced text or a URL. */
function inCodeOrUrl(before: string): boolean {
  return inMonospace(before) || /:\/\/|^www\./.test(/\S*$/.exec(before)![0]);
}

/** Characters that wrap selected text when typed over it: what goes before and after it. */
const WRAP: Record<string, [string, string]> = {
  "*": ["**", "**"],
  "`": ["`", "`"],
  "{": ["{", "}"],
  "[": ["[", "]"],
};

export const markdownHabits = EditorView.inputHandler.of((view, from, to, text) => {
  const { state } = view;
  const block = blockAtCursor(state);
  if (!(text in WRAP) || (block && LITERAL_BLOCKS.has(block.kind))) {
    return false;
  }
  if (from < to && !state.sliceDoc(from, to).includes("\n")) {
    const [open, close] = WRAP[text];
    view.dispatch({
      changes: [
        { from, insert: open },
        { from: to, insert: close },
      ],
      selection: { anchor: from + open.length, head: to + open.length },
      // Not "input.type": no autocomplete for the "[" or menus for the "{".
      userEvent: "input.wrap",
    });
    return true;
  }
  if (text !== "*") {
    return false;
  }
  const line = state.doc.lineAt(from);
  const before = state.sliceDoc(line.from, from);
  const match = ITALIC.exec(before);
  const start = match ? match.index + match[1].length : 0;
  if (!match || inCodeOrUrl(before.slice(0, start))) {
    return false;
  }
  // The "*" as typed, then the conversion as an undo step of its own, so undo
  // gives back "*italic*".
  view.dispatch({ changes: { from, to, insert: "*" }, selection: { anchor: from + 1 }, userEvent: "input.type" });
  const at = line.from + start;
  view.dispatch({
    changes: { from: at, to: from + 1, insert: `//${match[2]}//` },
    selection: { anchor: at + match[2].length + 4 },
    userEvent: "input.type",
    annotations: isolateHistory.of("before"),
  });
  return true;
});
