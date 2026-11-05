// What the insert menu inserts besides formatting: image macros (found by
// name, with their pictures), task and revision cards, literal text, icons,
// keys, navigation paths, ASCII art.

import { EditorSelection } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { conduit } from "../phorge";
import { insertBlock } from "./formatting";
import { previewField } from "./livePreview";
import { openPicker, search, type Target } from "./picker";

/** The image macros of this Phorge, by name, loaded once. */
let macros: Promise<Target[]> | null = null;

function loadMacros(): Promise<Target[]> {
  macros ??= (conduit("macro.query", {}) as Promise<Record<string, { uri: string }>>).then(
    (found) =>
      Object.entries(found)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, macro]) => ({
          label: name,
          icon: "fa-picture-o",
          image: macro.uri,
          reference: name,
          target: name,
        })),
    (error) => {
      // Tried again the next time.
      macros = null;
      throw error;
    },
  );
  return macros;
}

/** The text of a table cell's editor (tableEditor.ts), not of the text: one line. */
function inCell(view: EditorView): boolean {
  return !view.state.field(previewField, false);
}

/**
 * An image macro, picked by its name with its picture: alone on a line,
 * where Phorge shows its picture (in a table cell, in the cell).
 */
export function insertMacro(view: EditorView): boolean {
  openPicker(view, {
    headIcon: "fa-picture-o",
    headText: "Image macro:",
    placeholder: "Search image macros by name",
    range: view.state.selection.main,
    search: async (query) => {
      const words = query.toLowerCase().split(/\s+/).filter(Boolean);
      // All of them, to browse: the list scrolls, and their pictures load when scrolled to (popup.ts).
      return (await loadMacros()).filter((macro) => words.every((word) => macro.label.includes(word)));
    },
    pick: (target, range) => {
      const { state } = view;
      const line = state.doc.lineAt(range.from);
      const alone = inCell(view) || (!line.text.trim() && range.from === range.to);
      // After the line of the cursor, on a line of its own.
      const from = alone ? range.from : line.to;
      const insert = alone ? target.reference : `\n${target.reference}`;
      view.dispatch({
        changes: { from, to: alone ? range.to : from, insert },
        selection: { anchor: from + insert.length },
        userEvent: "input.macro",
        scrollIntoView: true,
      });
    },
  });
  return true;
}

/** A task or revision card ("{T12}"), found by its title or number. */
export function insertCard(view: EditorView): boolean {
  openPicker(view, {
    headIcon: "fa-id-card-o",
    headText: "Card:",
    placeholder: "Search tasks and revisions by title or number",
    range: view.state.selection.main,
    search: async (query) => (await search(query)).filter((target) => /^[TD]\d+$/.test(target.reference)),
    pick: (target, range) => {
      const insert = `{${target.reference}}`;
      view.dispatch({
        changes: { from: range.from, to: range.to, insert },
        selection: { anchor: range.from + insert.length },
        userEvent: "input.link",
        scrollIntoView: true,
      });
    },
  });
  return true;
}

/**
 * Markup around the text selected on a line, or around a sample text,
 * selected to type over.
 */
function wrapSelection(open: string, close: string, sample = "") {
  return (view: EditorView): boolean => {
    const range = view.state.selection.main;
    const selected = view.state.sliceDoc(range.from, range.to);
    const text = selected && !selected.includes("\n") ? selected : sample;
    const to = text === selected ? range.to : range.from;
    view.dispatch({
      changes: { from: range.from, to, insert: open + text + close },
      selection: EditorSelection.range(range.from + open.length, range.from + open.length + text.length),
      userEvent: "input.format",
      scrollIntoView: true,
    });
    return true;
  };
}

/** Literal text ("%%%text%%%"), which Phorge shows as typed: the selection, or empty with the cursor in it. */
export const insertLiteral = wrapSelection("%%%", "%%%");

/** Keys to press ("{key Ctrl K}"), drawn as keys. */
export const insertKeys = wrapSelection("{key ", "}", "Ctrl C");

/** A path through menus or pages ("{nav Home > Settings}"), drawn as a sequence of tags. */
export const insertNavigation = wrapSelection("{nav ", "}", "Home > Settings");

/** The colors of icons, as Phorge knows them (PHUIIconView::getIconColors()). */
const ICON_COLORS = [
  "bluegrey",
  "white",
  "red",
  "orange",
  "yellow",
  "green",
  "blue",
  "sky",
  "indigo",
  "violet",
  "pink",
  "lightgreytext",
  "lightbluetext",
];

/** An icon color as the page draws it (e.g. "red" → "rgb(…)"), measured once. */
const colorValues = new Map<string, string>();

function colorValue(color: string): string {
  let value = colorValues.get(color);
  if (value === undefined) {
    const probe = document.createElement("span");
    probe.className = `phui-icon-view phui-font-fa fa-flag ${color}`;
    document.body.append(probe);
    value = getComputedStyle(probe).color;
    probe.remove();
    colorValues.set(color, value);
  }
  return value;
}

/** The names of the page's Font Awesome icons ("camera"), from its stylesheets; loaded once. */
let iconNames: string[] | null = null;

function loadIconNames(): string[] {
  if (iconNames?.length) {
    return iconNames;
  }
  const names = new Set<string>();
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      // A stylesheet of another site.
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSStyleRule && rule.selectorText.includes(":before")) {
        for (const match of rule.selectorText.matchAll(/\.fa-([a-z0-9-]+)::?before/g)) {
          names.add(match[1]);
        }
      }
    }
  }
  iconNames = [...names].sort();
  return iconNames;
}

/**
 * Icons found by name: a color word ("camera red") colors it, "spin" makes it
 * spin. The name typed is offered also when the page's icons are unknown.
 */
export function findIcons(query: string): Target[] {
  const words = query
    .toLowerCase()
    .split(/[\s,]+/)
    .filter(Boolean);
  const color = words.find((word) => ICON_COLORS.includes(word));
  const spin = words.includes("spin");
  const terms = words.filter((word) => word !== color && word !== "spin");
  const names = loadIconNames();
  const found = names
    .filter((name) => terms.every((term) => name.includes(term)))
    .sort((a, b) => Number(!a.startsWith(terms[0] ?? "")) - Number(!b.startsWith(terms[0] ?? "")));
  if (terms.length === 1 && !found.length) {
    found.push(terms[0]);
  }
  const options = [...(color ? [`color=${color}`] : []), ...(spin ? ["spin"] : [])];
  return found.map((name) => ({
    label: [name, ...(color ? [color] : []), ...(spin ? ["spinning"] : [])].join(", "),
    icon: `fa-${name} ${color ?? ""}`.trim(),
    iconColor: color && colorValue(color),
    reference: `{icon ${name}${options.length ? ` ${options.join(", ")}` : ""}}`,
    target: name,
  }));
}

/** An icon ("{icon camera color=red}"), found by its name, with its color. */
export function insertIcon(view: EditorView): boolean {
  openPicker(view, {
    headIcon: "fa-flag",
    headText: "Icon:",
    placeholder: "Search icons; add a color (red, blue, green, …) or spin",
    range: view.state.selection.main,
    search: async (query) => findIcons(query),
    pick: (target, range) => {
      view.dispatch({
        changes: { from: range.from, to: range.to, insert: target.reference },
        selection: { anchor: range.from + target.reference.length },
        userEvent: "input.icon",
        scrollIntoView: true,
      });
    },
  });
  return true;
}

/**
 * ASCII art, drawn by Phorge: a cow saying something ("cowsay{{{…}}}") or
 * big letters ("figlet{{{…}}}"), of the text selected on a line or of a
 * sample text, selected to type over. Options go in parentheses, e.g.
 * "cowsay(cow=dragon){{{…}}}" or "figlet(font=slant){{{…}}}".
 */
export function insertAsciiArt(kind: "cowsay" | "figlet") {
  return (view: EditorView): boolean => {
    const range = view.state.selection.main;
    const line = view.state.doc.lineAt(range.from);
    const selected = range.to <= line.to ? view.state.sliceDoc(range.from, range.to).trim() : "";
    const text = selected || (kind === "cowsay" ? "Hello!" : "Hello");
    // Without the selected text, which goes into the block.
    if (selected) {
      view.dispatch({ changes: { from: range.from, to: range.to }, selection: { anchor: range.from } });
    }
    const open = `${kind}{{{`;
    const [before, after] = kind === "cowsay" ? [`${open}\n`, "\n}}}"] : [open, "}}}"];
    return insertBlock(view, before + text + after, [before.length, before.length + text.length]);
  };
}
