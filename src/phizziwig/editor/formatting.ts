// Formatting buttons for remarkup that Phorge's toolbar lacks, so people
// do not need to know the syntax: headers, strikethrough, underline,
// highlight, checklists, note boxes and horizontal rules.

import { EditorSelection, type EditorState, type SelectionRange } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { INLINE_FORMATS, LIST_ITEM, NOTE_PREFIX, NOTE_WORDS, quoteDepth, quoteMarkers } from "../syntax";
import { toolbarButton } from "../toolbar";
import { blockAtLine, quotePrefix } from "./livePreview";
import { type BlockLine, rangeLines } from "./lines";

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
    const [first, last] = rangeLines(state.doc, range);
    for (let n = first; n <= last; n++) {
      numbers.push(n);
    }
  }
  return numbers;
}

/** A line as blocks see it: in a quote, after the quote's markers (lines.ts). */
function bodyOf(state: EditorState, number: number): BlockLine {
  const line = state.doc.line(number);
  const prefix = quotePrefix(state, number).length;
  return { number, from: line.from + prefix, to: line.to, text: line.text.slice(prefix) };
}

/** The line of the cursor, as blocks see it. */
function cursorBody(state: EditorState): BlockLine {
  return bodyOf(state, state.doc.lineAt(state.selection.main.head).number);
}

/**
 * Applies a change to each line of the selection, or to the lines given by
 * number: to their text after the quote's markers in a quote, unless
 * `whole` (the quote button changes the markers).
 */
function changeLines(
  view: EditorView,
  change: (text: string, number: number) => string,
  numbers = selectedLines(view.state),
  whole = false,
): void {
  const { state } = view;
  const changes = [];
  for (const n of new Set(numbers)) {
    const line = whole ? state.doc.line(n) : bodyOf(state, n);
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
  const line = cursorBody(view.state);
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
    const current = /^(=+)\s/.exec(cursorBody(view.state).text)?.[1].length ?? 0;
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

/** The first line of the cursor's block (also of one inside a quote), or the cursor's line. */
function blockStart(state: EditorState): BlockLine {
  const line = cursorBody(state);
  return blockAtLine(state, line.number)?.lines[0] ?? line;
}

/** Text → "NOTE: Text" → "IMPORTANT: Text" → "WARNING: Text" → "Text". */
export const cycleNote: Command = (view) => {
  const { state } = view;
  const line = blockStart(state);
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

/** Makes the cursor's block a note of a kind ("IMPORTANT: Text"), or text again if it is one. */
export function setNote(word: (typeof NOTE_WORDS)[number]): Command {
  return (view) => {
    const { state } = view;
    const line = blockStart(state);
    if (!line.text.trim() && state.selection.main.empty) {
      const text = `${word}: Note text`;
      view.dispatch({
        changes: { from: line.from, to: line.to, insert: text },
        selection: EditorSelection.range(line.from + word.length + 2, line.from + text.length),
        userEvent: "input.format",
      });
      return true;
    }
    const match = NOTE_PREFIX.exec(line.text);
    const current = match ? (match[1] ?? match[2]) : null;
    const insert = current === word ? "" : `${word}: `;
    const changes = state.changes({ from: line.from, to: line.from + (match ? match[0].length : 0), insert });
    view.dispatch({
      changes,
      selection: state.selection.map(changes, 1),
      userEvent: "input.format",
      scrollIntoView: true,
    });
    return true;
  };
}

/**
 * Inserts an anchor to link to ("{anchor #name}") at the cursor, named after
 * the selected text (as Phorge normalizes anchor names), or with its name
 * selected for typing.
 */
export const insertAnchor: Command = (view) => {
  const range = view.state.selection.main;
  const selected = view.state.sliceDoc(range.from, range.to);
  const name =
    selected
      .toLowerCase()
      .replace(/[\x00-\x2F\x3A-\x60\x7B-\x7F]+/g, "-")
      .replace(/^-+|-+$/g, "") || "name";
  const text = `{anchor #${name}}`;
  view.dispatch({
    changes: { from: range.from, insert: text },
    selection: selected
      ? EditorSelection.cursor(range.to + text.length)
      : EditorSelection.range(range.from + 9, range.from + 9 + name.length),
    userEvent: "input.format",
    scrollIntoView: true,
  });
  return true;
};

/** Inserts "---" as a block of its own after the current line. */
export const insertRule: Command = (view) => {
  const { state } = view;
  const line = cursorBody(state);
  const next = line.number < state.doc.lines ? bodyOf(state, line.number + 1) : null;
  const after = next && !next.text.trim() ? "" : "\n";
  // After it, on a line of its own; the cursor is there.
  return insertBlock(view, `---\n${after}`, [4 + after.length, 4 + after.length]);
};

/**
 * Inserts a block on the line of the cursor, if empty, else after it, and
 * selects part of it. In a quote, in the quote: its lines get the quote's
 * markers, as Phorge quotes ("> ", never a reply's ">>!").
 */
export function insertBlock(view: EditorView, text: string, select: [number, number]): boolean {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  const raw = quotePrefix(state, line.number);
  const prefix = raw ? quoteMarkers(quoteDepth(raw)) : "";
  const empty = !line.text.slice(raw.length).trim();
  // On an empty line, in its place (with its markers written anew); else after it, a blank line between.
  const from = empty ? line.from : line.to;
  const head = empty ? prefix : `\n${prefix.trimEnd()}\n${prefix}`;
  const quoted = (part: string) => part.replace(/\n/g, `\n${prefix}`);
  const at = (offset: number) => from + head.length + quoted(text.slice(0, offset)).length;
  view.dispatch({
    changes: { from, to: empty ? line.to : from, insert: head + quoted(text) },
    selection: EditorSelection.range(at(select[0]), at(select[1])),
    userEvent: "input.format",
    scrollIntoView: true,
  });
  return true;
}

/** The kinds of lists, by the marker of their items. A checkbox is independent of them. */
type ListKind = "-" | "#";

function listKind(text: string): ListKind | null {
  const item = LIST_ITEM.exec(text);
  return item ? (/^[#\d]/.test(item[2]) ? "#" : "-") : null;
}

/** How often an item repeats its marker for nesting ("**", "##"). */
function markerRepeat(item: RegExpExecArray): number {
  return /^[-*#]+$/.test(item[2]) ? item[2].length : 1;
}

function itemMarker(kind: ListKind, repeat: number): string {
  const marker = kind === "#" ? "#" : repeat > 1 ? "*" : "-";
  return `${marker.repeat(repeat)} `;
}

/**
 * The lines of the items on the level of the cursor's item in its list (not
 * those of nested lists, up to blank lines), or the cursor's line if it is no
 * list item.
 */
function listLevel(state: EditorState, line: BlockLine): number[] {
  const block = blockAtLine(state, line.number);
  const item = LIST_ITEM.exec(line.text);
  if (block?.kind !== "list" || !item) {
    return [line.number];
  }
  const depth = (other: RegExpExecArray) => other[1].length + 2 * (markerRepeat(other) - 1);
  const own = depth(item);
  const at = block.lines.findIndex((other) => other.number === line.number);
  const numbers = [line.number];
  for (const step of [-1, 1]) {
    for (let i = at + step; i >= 0 && i < block.lines.length; i += step) {
      const text = block.lines[i].text;
      const other = LIST_ITEM.exec(text);
      // Continued paragraphs of items belong to the list. Phorge also
      // continues a list after a blank line, but it looks like another one.
      if (!text.trim() || (other && depth(other) < own)) {
        break;
      }
      if (other && depth(other) === own) {
        numbers.push(block.lines[i].number);
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
 * a kind of list ("- ", "# "), switching from the other kind; their checkboxes
 * stay. On items of that kind it makes them text again. A list with items at
 * the start of a line moves in by LIST_INDENT, all of it, so its nesting stays.
 */
export function toggleList(kind: ListKind): Command {
  return (view) => {
    const { state } = view;
    const line = cursorBody(state);
    if (state.selection.main.empty && !line.text.trim()) {
      const marker = LIST_INDENT + itemMarker(kind, 1);
      return insertBlock(view, marker, [marker.length, marker.length]);
    }
    const block = blockAtLine(state, line.number);
    const list = block?.kind === "list" ? block : null;
    const remove = !!list && listKind(line.text) === kind;
    const targets = new Set(state.selection.main.empty ? listLevel(state, line) : selectedLines(state));
    const convert = (text: string): string => {
      const item = LIST_ITEM.exec(text);
      // A checkbox alone ("[ ] item") is an item of a bulleted list.
      if (!text.trim() || (!remove && listKind(text) === kind && item![2])) {
        return text;
      }
      if (remove) {
        // Indented text would be a code block.
        return item ? item[5] : text;
      }
      return item
        ? item[1] + itemMarker(kind, markerRepeat(item)) + (item[4] ?? "") + item[5]
        : text.replace(/^(\s*)/, `$1${itemMarker(kind, 1)}`);
    };
    const region = new Set(targets);
    list?.lines.forEach((other) => region.add(other.number));
    const converted = new Map([...region].map((n) => [n, (targets.has(n) ? convert : String)(bodyOf(state, n).text)]));
    const shift = !remove && [...converted.values()].some((text) => /^\S/.test(text) && LIST_ITEM.test(text));
    changeLines(view, (_, n) => (shift && converted.get(n)!.trim() ? LIST_INDENT : "") + converted.get(n)!, [
      ...region,
    ]);
    return true;
  };
}

/**
 * Gives the selected lines, or the cursor's line, a checkbox, or takes it
 * away, whatever the other items of their list have: a checkbox is
 * independent of the kind of the list. A line that is no list item becomes
 * one, of a bulleted list.
 */
export const toggleChecklist: Command = (view) => {
  const { state } = view;
  const line = cursorBody(state);
  if (state.selection.main.empty && !line.text.trim()) {
    const marker = `${LIST_INDENT}- [ ] `;
    return insertBlock(view, marker, [marker.length, marker.length]);
  }
  const remove = !!LIST_ITEM.exec(line.text)?.[4];
  changeLines(view, (text) => {
    const item = LIST_ITEM.exec(text);
    if (!text.trim() || !!item?.[4] !== remove) {
      return text;
    }
    if (remove) {
      // A checkbox alone ("[ ] item") was the item: its text stays.
      return item![2] ? item![1] + item![2] + item![3] + item![5] : item![5];
    }
    return item
      ? item[1] + item[2] + item[3] + "[ ] " + item[5]
      : text.replace(/^(\s*)/, (indent) => `${indent || LIST_INDENT}- [ ] `);
  });
  return true;
};

/**
 * Quotes the lines, or unquotes them. Blank lines between quoted ones get a
 * ">" too, so paragraphs stay in one quote; those at the edges of a
 * selection stay blank. Whether to unquote follows the cursor's line, or the
 * first line with text of the selection if the cursor's is blank. Unquoting
 * takes off one level of nested quotes.
 */
export const toggleQuote: Command = (view) => {
  const { state } = view;
  const main = state.selection.main;
  const line = state.doc.lineAt(main.head);
  if (main.empty && !line.text.trim()) {
    return insertBlock(view, "> ", [2, 2]);
  }
  const filledLines = (range: SelectionRange): number[] => {
    const numbers = [];
    const [first, last] = rangeLines(state.doc, range);
    for (let n = first; n <= last; n++) {
      if (state.doc.line(n).text.trim()) {
        numbers.push(n);
      }
    }
    return numbers;
  };
  const decisive = line.text.trim() ? line : state.doc.line(filledLines(main)[0] ?? line.number);
  if (/^>/.test(decisive.text)) {
    // One level: a nested quote stays quoted; a reply's header loses its ">>!".
    changeLines(view, (text) => text.replace(/^(?:>>!|>) ?/, ""), undefined, true);
    return true;
  }
  const inside = new Set<number>();
  for (const range of state.selection.ranges) {
    const filled = filledLines(range);
    for (let n = filled[0]; n <= filled[filled.length - 1]; n++) {
      inside.add(n);
    }
  }
  changeLines(view, (text, n) => (text.trim() ? `> ${text}` : inside.has(n) ? ">" : text), undefined, true);
  return true;
};

/**
 * Puts the selected lines into a code block, or inserts an empty one. Lines
 * of one quote, quoted equally deep, go in a code block in the quote; others
 * whole, with their markers.
 */
export const insertCodeBlock: Command = (view) => {
  const { state } = view;
  const range = state.selection.main;
  if (range.empty) {
    return insertBlock(view, "```\n\n```", [4, 4]);
  }
  const [first, last] = rangeLines(state.doc, range);
  const raws: string[] = [];
  for (let n = first; n <= last; n++) {
    raws.push(quotePrefix(state, n));
  }
  const inQuote = raws.every((raw) => raw && !raw.includes(">>!") && quoteDepth(raw) === quoteDepth(raws[0]));
  const prefix = inQuote ? quoteMarkers(quoteDepth(raws[0])) : "";
  const lines = raws.map((raw, i) => state.doc.line(first + i).text.slice(inQuote ? raw.length : 0));
  const from = state.doc.line(first).from;
  const insert = ["```", ...lines, "```"].map((text) => prefix + text).join("\n");
  view.dispatch({
    changes: { from, to: state.doc.line(last).to, insert },
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
