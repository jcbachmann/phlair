// Links and references in the text: the link button and Ctrl+K open a
// dialog with the text and the target, which searches pages, tasks and other
// objects (or takes a URL); with the cursor in a link, a bubble offers to
// open, change or remove it. (A URL pasted over selected
// text links it, see pasting.ts.)

import { type EditorState, StateField } from "@codemirror/state";
import { type EditorView, showTooltip, type Tooltip } from "@codemirror/view";
import { openPicker, type Range, type Target } from "./picker";
import { focusField } from "./focus";
import { textTokens } from "./inlineTokens";

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

/**
 * What the link dialog makes of a target and a text: a link with the text, or
 * without one the target alone (its reference, e.g. "T12", "@alice", a URL).
 * A Markdown link stays one. (Without a target, the text alone: unlink.)
 */
function linkResult(form: Link["form"], target: Target, text: string): string {
  if (!text) {
    return target.reference;
  }
  return form === "markdown" ? `[${text}](${target.target})` : `[[ ${target.target} | ${text} ]]`;
}

/** What a link points to now, for the dialog: picked again when its link field is not changed. */
function currentTarget(link: Link): Target {
  // Without its text: a URL bare, a page or path in brackets.
  const reference = /^[a-z]+:/i.test(link.target) ? link.target : `[[ ${link.target} ]]`;
  return { label: link.target, icon: "fa-link", reference, target: link.target };
}

/** Replaces a range of the text with a link or reference, the cursor after it. */
function insertLink(view: EditorView, range: Range, insert: string): void {
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: { anchor: range.from + insert.length },
    userEvent: "input.link",
    scrollIntoView: true,
  });
}

/** Opens the link dialog: the text and the target of a link, the target searched for. */
function openLinkDialog(
  view: EditorView,
  options: { headIcon: string; headText: string; placeholder: string; range: Range; text: string; form: Link["form"] },
  initial?: Target,
): void {
  openPicker(view, {
    ...options,
    // As written: the target of a link, the reference ("T12") of a reference.
    initial: initial?.label,
    initialTarget: initial,
    pick: (target, range, text) => insertLink(view, range, linkResult(options.form, target, text)),
    unlink: (range, text) => insertLink(view, range, text),
  });
}

/**
 * The link button, Ctrl+K (and Ctrl+Shift+K): changes the link or the
 * reference ("T12", "@alice") the cursor is in, its text and its target, or
 * links the selected text, or inserts a link or reference at the cursor.
 */
export function editLink(view: EditorView): boolean {
  const { state } = view;
  const options = {
    headIcon: "fa-link",
    headText: "Link to:",
    placeholder: "Search tasks, pages, people, projects… or paste a URL",
  };
  const existing = selectedLink(state);
  if (existing) {
    openLinkDialog(
      view,
      { ...options, range: existing, text: existing.text ?? "", form: existing.form },
      currentTarget(existing),
    );
    return true;
  }
  const reference = selectedReference(state);
  if (reference) {
    // Its search shows what it refers to.
    const mention = /^@(.+)$/.exec(reference.text);
    const target = mention ? `/p/${mention[1]}/` : `/${reference.text}`;
    openLinkDialog(
      view,
      { ...options, range: reference, text: "", form: "wiki" },
      { label: reference.text, icon: "fa-anchor", reference: reference.text, target },
    );
    return true;
  }
  const range = state.selection.main;
  openLinkDialog(view, { ...options, range, text: state.sliceDoc(range.from, range.to), form: "wiki" });
  return true;
}

/**
 * The reference around the cursor or the selection (within one), e.g. "T12",
 * "D3#7" or "@alice", as Phorge finds them in the line (inline.ts). Not
 * commit hashes, which the search for objects does not find.
 */
function selectedReference(state: EditorState): { from: number; to: number; text: string } | null {
  const range = state.selection.main;
  const line = state.doc.lineAt(range.head);
  for (const token of textTokens(line.text, line.from)) {
    const text = state.sliceDoc(token.from, token.to);
    const reference = token.kind === "mention" || (token.kind === "object" && /^[A-Z]\d/.test(text));
    if (reference && range.from >= token.from && range.to <= token.to) {
      return { from: token.from, to: token.to, text };
    }
  }
  return null;
}

function removeLink(view: EditorView, link: Link): void {
  view.dispatch({ changes: { from: link.from, to: link.to, insert: unlinked(link) }, userEvent: "delete.link" });
}

/** What is left of a link without it: its text. */
function unlinked(link: Link): string {
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
function linkBubble(link: Link, change: () => void, remove: () => void): HTMLElement {
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
const focused = (state: EditorState) => state.field(focusField, false) ?? true;

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
