// Formatting buttons for remarkup that Phorge's toolbar lacks, so people
// do not need to know the syntax: headers, strikethrough, underline,
// highlight, checklists, note boxes and horizontal rules.

import { EditorSelection, type EditorState, type Line } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { INLINE_FORMATS, LIST_ITEM, NOTE_PREFIX, NOTE_WORDS } from "../syntax";
import { toolbarButton } from "../toolbar";
import { insertReference } from "./links";
import { blockAtCursor } from "./livePreview";

type Command = (view: EditorView) => boolean;

/** Wraps the selection in a marker like "~~", or removes it again. */
function toggleInline(marker: string, placeholder: string): Command {
  return (view) => {
    const { state } = view;
    view.dispatch(
      state.changeByRange((range) => {
        const n = marker.length;
        const before = state.sliceDoc(range.from - n, range.from);
        const after = state.sliceDoc(range.to, range.to + n);
        if (before === marker && after === marker) {
          return {
            changes: [
              { from: range.from - n, to: range.from },
              { from: range.to, to: range.to + n },
            ],
            range: EditorSelection.range(range.from - n, range.to - n),
          };
        }
        const text = range.empty ? placeholder : state.sliceDoc(range.from, range.to);
        return {
          changes: { from: range.from, to: range.to, insert: marker + text + marker },
          range: EditorSelection.range(range.from + n, range.from + n + text.length),
        };
      }),
      { userEvent: "input.format", scrollIntoView: true },
    );
    return true;
  };
}

/** The numbers of the lines of the selection. */
function selectedLines(state: EditorState): number[] {
  const numbers = [];
  for (const range of state.selection.ranges) {
    for (let n = state.doc.lineAt(range.from).number; n <= state.doc.lineAt(range.to).number; n++) {
      numbers.push(n);
    }
  }
  return numbers;
}

/** Applies a change to each line of the selection, or to the lines given by number. */
function changeLines(
  view: EditorView,
  change: (text: string, number: number) => string,
  numbers = selectedLines(view.state),
): void {
  const { state } = view;
  const changes = [];
  for (const n of new Set(numbers)) {
    const line = state.doc.line(n);
    const text = change(line.text, n);
    if (text !== line.text) {
      changes.push({ from: line.from, to: line.to, insert: text });
    }
  }
  const changeSet = state.changes(changes);
  view.dispatch({
    changes: changeSet,
    // Keep the cursor at the end of a line that only had markup added.
    selection: state.selection.map(changeSet, 1),
    userEvent: "input.format",
    scrollIntoView: true,
  });
}

/** "Heading" → "= Heading" → "== Heading" → "=== Heading" → "Heading". */
export const cycleHeader: Command = (view) => {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  if (!line.text.trim()) {
    const text = "= Heading";
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: text },
      selection: EditorSelection.range(line.from + 2, line.from + text.length),
      userEvent: "input.format",
    });
    return true;
  }
  changeLines(view, (text) => {
    const match = /^(=+)\s*(.*?)(?:\s+=+)?\s*$/.exec(text);
    const level = match ? match[1].length : 0;
    const content = match ? match[2] : text;
    return level >= 3 ? content : `${"=".repeat(level + 1)} ${content}`;
  });
  return true;
};

/** Makes the lines headings of a level (1 to 5), or text again if they are headings of that level. */
export function setHeading(level: number): Command {
  return (view) => {
    const line = view.state.doc.lineAt(view.state.selection.main.head);
    const current = /^(=+)\s/.exec(line.text)?.[1].length ?? 0;
    changeLines(view, (text) => {
      if (!text.trim()) {
        return text;
      }
      const content = /^(=+|#+)\s*(.*?)(?:\s+=+)?\s*$/.exec(text)?.[2] ?? text;
      return current === level ? content : `${"=".repeat(level)} ${content}`;
    });
    return true;
  };
}

/** Text → "NOTE: Text" → "IMPORTANT: Text" → "WARNING: Text" → "Text". */
export const cycleNote: Command = (view) => {
  const { state } = view;
  const line = state.doc.lineAt(blockAtCursor(state)?.from ?? state.selection.main.head);
  if (!line.text.trim() && state.selection.main.empty) {
    const text = "NOTE: Note text";
    view.dispatch({
      changes: { from: line.from, to: line.to, insert: text },
      selection: EditorSelection.range(line.from + 6, line.from + text.length),
      userEvent: "input.format",
    });
    return true;
  }
  const match = NOTE_PREFIX.exec(line.text);
  const word = match ? ((match[1] ?? match[2]) as (typeof NOTE_WORDS)[number]) : null;
  const next = word ? NOTE_WORDS[NOTE_WORDS.indexOf(word) + 1] : "NOTE";
  const insert = next ? `${next}: ` : "";
  const changes = state.changes({ from: line.from, to: line.from + (match ? match[0].length : 0), insert });
  view.dispatch({
    changes,
    selection: state.selection.map(changes, 1),
    userEvent: "input.format",
    scrollIntoView: true,
  });
  return true;
};

/** Inserts "---" as a block of its own after the current line. */
export const insertRule: Command = (view) => {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const empty = !line.text.trim();
  const from = empty ? line.from : line.to;
  const before = empty ? "" : "\n\n";
  const next = line.number < state.doc.lines ? state.doc.line(line.number + 1) : null;
  const after = next && !next.text.trim() ? "\n" : "\n\n";
  const insert = `${before}---${after}`;
  view.dispatch({
    changes: { from, to: empty ? line.to : from, insert },
    selection: { anchor: from + insert.length },
    userEvent: "input.format",
    scrollIntoView: true,
  });
  return true;
};

/** Inserts text on an empty line, or after the current line as a block of its own. */
function insertBlock(view: EditorView, text: string, select: [number, number]): boolean {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const empty = !line.text.trim();
  const before = empty ? "" : "\n\n";
  const from = empty ? line.from : line.to;
  view.dispatch({
    changes: { from, to: empty ? line.to : from, insert: before + text },
    selection: EditorSelection.range(from + before.length + select[0], from + before.length + select[1]),
    userEvent: "input.format",
    scrollIntoView: true,
  });
  return true;
}

/** The kinds of lists, by the marker of their items. */
type ListKind = "-" | "#" | "[ ]";

function listKind(text: string): ListKind | null {
  const item = LIST_ITEM.exec(text);
  return item ? (item[4] ? "[ ]" : /^[#\d]/.test(item[2]) ? "#" : "-") : null;
}

/** How often an item repeats its marker for nesting ("**", "##"). */
function markerRepeat(item: RegExpExecArray): number {
  return /^[-*#]+$/.test(item[2]) ? item[2].length : 1;
}

function itemMarker(kind: ListKind, repeat: number): string {
  const marker = kind === "#" ? "#" : repeat > 1 ? "*" : "-";
  return marker.repeat(repeat) + (kind === "[ ]" ? " [ ] " : " ");
}

/**
 * The lines of the items on the level of the cursor's item in its list (not
 * those of nested lists, up to blank lines), or the cursor's line if it is no
 * list item.
 */
function listLevel(state: EditorState, line: Line): number[] {
  const block = blockAtCursor(state, "list");
  const item = LIST_ITEM.exec(line.text);
  if (!block || !item) {
    return [line.number];
  }
  const depth = (other: RegExpExecArray) => other[1].length + 2 * (markerRepeat(other) - 1);
  const own = depth(item);
  const first = state.doc.lineAt(block.from).number;
  const last = state.doc.lineAt(block.contentTo).number;
  const numbers = [line.number];
  for (const step of [-1, 1]) {
    for (let n = line.number + step; n >= first && n <= last; n += step) {
      const text = state.doc.line(n).text;
      const other = LIST_ITEM.exec(text);
      // Continued paragraphs of items belong to the list. Phorge also
      // continues a list after a blank line, but it looks like another one.
      if (!text.trim() || (other && depth(other) < own)) {
        break;
      }
      if (other && depth(other) === own) {
        numbers.push(n);
      }
    }
  }
  return numbers;
}

/**
 * The indentation of the list items the editor writes, as Phorge's own
 * buttons do: "# item" at the start of a line is a header, not a list.
 */
const LIST_INDENT = "  ";

/**
 * Makes the selected lines, or the items of the cursor's list level, items of
 * a kind of list ("- ", "# ", "- [ ] "), switching from other kinds. On items
 * of that kind it makes them text again. A list with items at the start of a
 * line moves in by LIST_INDENT, all of it, so its nesting stays.
 */
export function toggleList(kind: ListKind): Command {
  return (view) => {
    const { state } = view;
    const line = state.doc.lineAt(state.selection.main.head);
    if (state.selection.main.empty && !line.text.trim()) {
      const marker = LIST_INDENT + itemMarker(kind, 1);
      return insertBlock(view, marker, [marker.length, marker.length]);
    }
    const list = blockAtCursor(state, "list");
    const remove = !!list && listKind(line.text) === kind;
    const targets = new Set(state.selection.main.empty ? listLevel(state, line) : selectedLines(state));
    const convert = (text: string): string => {
      const item = LIST_ITEM.exec(text);
      if (!text.trim() || (!remove && listKind(text) === kind)) {
        return text;
      }
      if (remove) {
        // Indented text would be a code block.
        return item ? item[5] : text;
      }
      return item
        ? item[1] + itemMarker(kind, markerRepeat(item)) + item[5]
        : text.replace(/^(\s*)/, `$1${itemMarker(kind, 1)}`);
    };
    const region = new Set(targets);
    if (list) {
      for (let n = state.doc.lineAt(list.from).number; n <= state.doc.lineAt(list.contentTo).number; n++) {
        region.add(n);
      }
    }
    const converted = new Map([...region].map((n) => [n, (targets.has(n) ? convert : String)(state.doc.line(n).text)]));
    const shift = !remove && [...converted.values()].some((text) => /^\S/.test(text) && LIST_ITEM.test(text));
    changeLines(view, (_, n) => (shift && converted.get(n)!.trim() ? LIST_INDENT : "") + converted.get(n)!, [
      ...region,
    ]);
    return true;
  };
}

/** Turns lines into checklist items, or checklist items back into text. */
export const toggleChecklist = toggleList("[ ]");

/** Quotes the lines, or unquotes them. */
export const toggleQuote: Command = (view) => {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  if (state.selection.main.empty && !line.text.trim()) {
    return insertBlock(view, "> ", [2, 2]);
  }
  const remove = /^>/.test(line.text);
  changeLines(view, (text) => (remove ? text.replace(/^>+ ?/, "") : text.trim() ? `> ${text}` : text));
  return true;
};

/** Puts the selected lines into a code block, or inserts an empty one. */
export const insertCodeBlock: Command = (view) => {
  const { state } = view;
  const range = state.selection.main;
  if (range.empty) {
    return insertBlock(view, "```\n\n```", [4, 4]);
  }
  const from = state.doc.lineAt(range.from).from;
  const to = state.doc.lineAt(range.to).to;
  const insert = `\`\`\`\n${state.sliceDoc(from, to)}\n\`\`\``;
  view.dispatch({
    changes: { from, to, insert },
    selection: { anchor: from + insert.length },
    userEvent: "input.format",
    scrollIntoView: true,
  });
  return true;
};

/** An inline format as a command, by the icon of its button. */
export function inlineFormat(icon: string): Command {
  const format = INLINE_FORMATS.find((f) => f.icon === icon)!;
  return toggleInline(format.marker, format.placeholder);
}

interface Button {
  icon: string;
  title: string;
  run: Command;
  /** The Font Awesome icon of Phorge's button to place it next to. */
  place: ["before" | "after", string];
}

const BUTTONS: Button[] = [
  {
    icon: "fa-header",
    title: "Heading (click again for a smaller one)",
    run: cycleHeader,
    place: ["before", "fa-bold"],
  },
  {
    icon: "fa-strikethrough",
    title: "Strikethrough",
    run: inlineFormat("fa-strikethrough"),
    place: ["after", "fa-text-width"],
  },
  { icon: "fa-underline", title: "Underline", run: inlineFormat("fa-underline"), place: ["after", "fa-strikethrough"] },
  { icon: "fa-paint-brush", title: "Highlight", run: inlineFormat("fa-paint-brush"), place: ["after", "fa-underline"] },
  {
    icon: "fa-anchor",
    title: "Reference a task, page, person or anything else, found by its name",
    run: insertReference,
    place: ["after", "fa-link"],
  },
  { icon: "fa-check-square-o", title: "Checklist", run: toggleChecklist, place: ["after", "fa-list-ol"] },
  {
    icon: "fa-sticky-note-o",
    title: "Note box (click again for Important, Warning)",
    run: cycleNote,
    place: ["after", "fa-quote-right"],
  },
  { icon: "fa-minus", title: "Horizontal line", run: insertRule, place: ["after", "fa-table"] },
];

/**
 * Adds the formatting buttons to Phorge's toolbar, next to its own
 * buttons. Returns a function that removes them again. The titles may name
 * keyboard shortcuts, by the button's icon.
 */
export function addFormattingButtons(
  bar: Element,
  view: EditorView,
  shortcuts: Record<string, string> = {},
): () => void {
  const added: HTMLElement[] = [];
  for (const { icon, title, run, place } of BUTTONS) {
    const shortcut = shortcuts[icon];
    const button = toolbarButton({
      title: shortcut ? `${title} (${shortcut})` : title,
      icon,
      className: "rme-format",
      run: () => {
        // First: some commands move the focus on, e.g. into a search field.
        view.focus();
        run(view);
      },
    });
    const [where, reference] = place;
    const anchor = bar.querySelector(`.${reference}`)?.closest(".remarkup-assist-button");
    if (anchor) {
      anchor.insertAdjacentElement(where === "before" ? "beforebegin" : "afterend", button);
    } else {
      bar.append(button);
    }
    added.push(button);
  }
  return () => added.forEach((button) => button.remove());
}
