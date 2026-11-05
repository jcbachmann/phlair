// Links in the text: the link button and Ctrl+K open a search for pages,
// tasks and other objects (or take a URL); with the cursor in a link, a
// bubble offers to open, change or remove it. (A URL pasted over selected
// text links it, see pasting.ts.)

import { type EditorState, StateField } from "@codemirror/state";
import { type EditorView, showTooltip, type Tooltip } from "@codemirror/view";
import { openPicker, type Target } from "./picker";
import { previewField } from "./livePreview";

export interface Link {
  from: number;
  to: number;
  /** Where it points: a URL, a path or a wiki page. */
  target: string;
  /** Its own text, if it has one. */
  text: string | null;
  /** "[[ target | text ]]", Markdown's "[text](target)" or a bare URL. */
  form: "wiki" | "markdown" | "bare";
}

const URL_PATTERN = /\bhttps?:\/\/[^\s\]<>`]+[^\s\]<>`.,;:!?)'"]/g;
const WIKI = /\[\[([^\]\n]+?)\]\]/g;
// Phorge renders these only with a "/" or "@" in the target.
const MARKDOWN = /\[([^[\]\n]+)\]\(([^()\s]*[/@][^()\s]*)\)/g;

/** The links of a line of text, with offsets in the line. */
export function findLinks(line: string): Link[] {
  const links: Link[] = [];
  const add = (match: RegExpMatchArray, target: string, text: string | null, form: Link["form"]) => {
    const from = match.index!;
    if (!links.some((l) => from < l.to && from + match[0].length > l.from)) {
      links.push({ from, to: from + match[0].length, target: target.trim(), text: text?.trim() ?? null, form });
    }
  };
  for (const match of line.matchAll(WIKI)) {
    const [target, ...text] = match[1].split("|");
    add(match, target, text.length ? text.join("|") : null, "wiki");
  }
  for (const match of line.matchAll(MARKDOWN)) {
    add(match, match[2], match[1], "markdown");
  }
  for (const match of line.matchAll(URL_PATTERN)) {
    add(match, match[0], null, "bare");
  }
  return links.sort((a, b) => a.from - b.from);
}

/** A link in its form. */
function formatLink(form: Link["form"], target: string, text: string | null): string {
  if (form === "markdown" && text) {
    return `[${text}](${target})`;
  }
  return text ? `[[ ${target} | ${text} ]]` : form === "bare" ? target : `[[ ${target} ]]`;
}

/** The link the cursor is in, in document positions. */
/** The link at the cursor (inside it), in document positions. */
function linkAt(state: EditorState, pos: number = state.selection.main.head): Link | null {
  const line = state.doc.lineAt(pos);
  const link = findLinks(line.text).find((l) => pos - line.from > l.from && pos - line.from < l.to);
  return link ? { ...link, from: link.from + line.from, to: link.to + line.from } : null;
}

/** The link the selection is in or selects, also with the cursor at its edge: what the link commands change. */
function selectedLink(state: EditorState): Link | null {
  const { from, to } = state.selection.main;
  const line = state.doc.lineAt(from);
  if (to > line.to) {
    return null;
  }
  const link = findLinks(line.text).find((l) => from - line.from >= l.from && to - line.from <= l.to);
  return link ? { ...link, from: link.from + line.from, to: link.to + line.from } : null;
}

/** The text that links to a target, with the selected text as its text. */
function linkText(target: Target, text: string): string {
  if (!text) {
    return target.reference;
  }
  return `[[ ${target.target} | ${text} ]]`;
}

/** The link with another target, keeping its form and text; a bare URL changed to a task or person becomes its reference ("T12"). */
function relinked(link: Link, target: Target): string {
  return link.form === "bare" && !/^[a-z]+:/i.test(target.target)
    ? target.reference
    : formatLink(link.form, target.target, link.text);
}

/** Asks for a new target of a link, then calls back with the changed link text. */
export function changeLink(
  view: EditorView,
  link: Link,
  at: number | HTMLElement,
  apply: (text: string) => void,
): void {
  openPicker(view, {
    headIcon: "fa-link",
    headText: "Change Link:",
    placeholder: "Search pages, tasks, people… or paste a URL",
    initial: link.target,
    at,
    pick: (target) => apply(relinked(link, target)),
  });
}

/**
 * The link button: changes the target of the link the cursor is in, links the
 * selected text, or inserts a reference.
 */
export function editLink(view: EditorView): boolean {
  const { state } = view;
  const existing = selectedLink(state);
  if (existing) {
    changeLink(view, existing, existing.from, (insert) =>
      view.dispatch({ changes: { from: existing.from, to: existing.to, insert }, userEvent: "input.link" }),
    );
    return true;
  }
  const range = state.selection.main;
  addLink(view, state.sliceDoc(range.from, range.to), range.from, (insert) =>
    view.dispatch({
      changes: { from: range.from, to: range.to, insert },
      selection: { anchor: range.from + insert.length },
      userEvent: "input.link",
      scrollIntoView: true,
    }),
  );
  return true;
}

/** Asks for a link target, then calls back with a link with the given text (or a reference without text). */
export function addLink(view: EditorView, text: string, at: number | HTMLElement, apply: (link: string) => void): void {
  openPicker(view, {
    headIcon: "fa-link",
    headText: "Link to:",
    placeholder: "Search pages, tasks, people… or paste a URL",
    at,
    pick: (target) => apply(linkText(target, text)),
  });
}

/** Inserts a reference to a task or other object, found by its title; in a link, changes the link. */
export function insertReference(view: EditorView): boolean {
  if (selectedLink(view.state)) {
    return editLink(view);
  }
  const reference = selectedReference(view.state);
  const range = reference ?? view.state.selection.main;
  openPicker(view, {
    headIcon: "fa-anchor",
    headText: "Reference:",
    placeholder: "Search tasks, pages, people, projects… by name",
    // A reference is changed: its search shows what it refers to.
    initial: reference?.text,
    at: range.from,
    pick: (target) => {
      const insert = reference ? target.reference : linkText(target, view.state.sliceDoc(range.from, range.to));
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

// Like the references Phorge links: "T12", "D3#7", "@alice".
const REFERENCE = /(?<![\w/#@&{])(?:[A-Z]\d+(?:#\d+)?|@[\w.-]*\w)\b/g;

/** The reference around the cursor or the selection (within one), e.g. "T12". */
function selectedReference(state: EditorState): { from: number; to: number; text: string } | null {
  const range = state.selection.main;
  const line = state.doc.lineAt(range.head);
  for (const match of line.text.matchAll(REFERENCE)) {
    const from = line.from + match.index;
    const to = from + match[0].length;
    if (range.from >= from && range.to <= to) {
      return { from, to, text: match[0] };
    }
  }
  return null;
}

function removeLink(view: EditorView, link: Link): void {
  view.dispatch({ changes: { from: link.from, to: link.to, insert: unlinked(link) }, userEvent: "delete.link" });
}

/** What is left of a link without it: its text. */
export function unlinked(link: Link): string {
  return link.text ?? link.target;
}

/** Where a link opens, like Phorge resolves it (wiki pages relative to /w/). */
function href(target: string): string | null {
  if (/^(https?:|mailto:)/i.test(target)) {
    return target;
  }
  if (target.startsWith("/")) {
    // Like Phorge, on this site: "//host" is not another host here.
    return location.origin + target;
  }
  if (/^[A-Z]\d+$/.test(target)) {
    return new URL(`/${target}`, location.origin).toString();
  }
  // Relative wiki links ("./child") depend on the page; leave them be.
  return /^\.\.?\//.test(target) ? null : new URL(`/w/${target.replace(/^\/+/, "")}`, location.origin).toString();
}

function bubbleButton(label: string, icon: string, run: () => void): HTMLElement {
  const button = document.createElement("a");
  button.href = "#";
  button.className = "rme-link-bubble-button";
  const glyph = document.createElement("span");
  glyph.className = `phui-icon-view phui-font-fa ${icon}`;
  button.append(glyph, label);
  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", (event) => {
    event.preventDefault();
    run();
  });
  return button;
}

/** The bubble of a link: open it, change it, or (unless it is a bare URL) remove it. */
export function linkBubble(link: Link, change: () => void, remove: () => void): HTMLElement {
  const dom = document.createElement("div");
  dom.className = "rme-link-bubble";
  const url = href(link.target);
  if (url) {
    dom.append(bubbleButton("Open", "fa-external-link", () => window.open(url, "_blank", "noopener")));
  }
  dom.append(bubbleButton("Change", "fa-pencil", change));
  if (link.form !== "bare") {
    dom.append(bubbleButton("Remove link", "fa-chain-broken", remove));
  }
  return dom;
}

/** Whether the editor has the focus; a table cell's editor (tableEditor.ts) has it while it exists. */
const focused = (state: EditorState) => state.field(previewField, false)?.focused ?? true;

function bubble(state: EditorState): Tooltip | null {
  const range = state.selection.main;
  const link = focused(state) && range.empty ? linkAt(state) : null;
  if (!link) {
    return null;
  }
  return {
    pos: link.from,
    above: false,
    create: (view) => ({
      dom: linkBubble(
        link,
        () => editLink(view),
        () => removeLink(view, linkAt(view.state) ?? link),
      ),
    }),
  };
}

const linkBubbleField = StateField.define<Tooltip | null>({
  create: bubble,
  update(value, tr) {
    if (!tr.docChanged && !tr.selection && focused(tr.startState) === focused(tr.state)) {
      return value;
    }
    const next = bubble(tr.state);
    // Keep the bubble while the cursor moves within the same link.
    return next && value && next.pos === value.pos && !tr.docChanged ? value : next;
  },
  provide: (field) => showTooltip.from(field),
});

export const links = linkBubbleField;
