// @vitest-environment jsdom
// Edits made in two steps (the text as typed or pasted, then what it becomes)
// in quotes whose markers tidyQuotes rewrites in the first step: the second
// step must land where the text went, losing nothing of the user's text.
import { history } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import { tidyQuotes } from "../src/phizziwig/editor/commands";
import { livePreview } from "../src/phizziwig/editor/livePreview";
import { markdownHabits } from "../src/phizziwig/editor/markdown";
import type { BlockRenderer } from "../src/phizziwig/renderer";
import { pasting } from "../src/phizziwig/editor/pasting";

// jsdom does not lay out: CodeMirror measures text ranges.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect = () => new DOMRect();

/** A renderer that renders nothing. */
const renderer = new Proxy({}, { get: (_target, key) => (key === "failures" ? 0 : () => undefined) }) as BlockRenderer;

function editor(doc: string, at: number): EditorView {
  return new EditorView({
    state: EditorState.create({
      doc,
      selection: { anchor: at },
      extensions: [history(), livePreview(renderer), tidyQuotes, pasting, markdownHabits],
    }),
    parent: document.body,
  });
}

function paste(view: EditorView, data: Record<string, string>): void {
  const event = new Event("paste", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: (type: string) => data[type] ?? "", files: [] } });
  view.contentDOM.dispatchEvent(event);
}

describe("two-step edits in quotes being tidied", () => {
  it("a paste keeps the text after it", () => {
    const view = editor("> > earlier\n> my text\n> next line\n\nafter", "> > earlier\n> my text".length);
    paste(view, { "text/plain": "bold", "text/html": "<b>bold</b> text" });
    expect(view.state.doc.toString()).toBe(">> earlier\n> my text**bold** text\n> next line\n\nafter");
  });

  it("a paste of Markdown with nested quotes keeps the text after it", () => {
    const view = editor("KEEP THIS TEXT", 0);
    paste(view, { "text/plain": "> > quoted **x**\n> > more\n>\n> # Head\n\n- item\n- item2\n" });
    expect(view.state.doc.toString()).toMatch(/- item2\n+KEEP THIS TEXT$/);
  });

  it("Markdown italics keep the text around them", () => {
    const view = editor("> > see *word", "> > see *word".length);
    // Typed: CodeMirror calls its input handlers like this.
    const handled = view.state
      .facet(EditorView.inputHandler)
      .some((handler) =>
        handler(view, view.state.selection.main.from, view.state.selection.main.to, "*", () => view.state.update({})),
      );
    expect(handled).toBe(true);
    expect(view.state.doc.toString()).toBe(">> see //word//");
  });
});
