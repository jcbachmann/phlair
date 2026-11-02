// Phorge's autocomplete for users, projects, wiki pages, emoji and short
// URLs, ported from PHUIXAutocomplete. That one is bound to a textarea, so
// this reimplements it for the editor: the same triggers and rules, and the
// same menu markup, so Phorge's CSS makes it look the same.
//
// Derived from Phabricator (Copyright Phacility, Inc., Apache License 2.0;
// see licenses/Phabricator-LICENSE.txt and Phabricator-NOTICE.txt), changed.

import { Prec } from "@codemirror/state";
import { type EditorView, keymap, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { typeahead, type TypeaheadResult } from "../phorge";
import { Popup } from "./popup";

interface Spec {
  datasource: string;
  parameters?: Record<string, unknown>;
  headerIcon: string;
  headerText: string;
  hintText: string;
  /** Characters that end the completion; see _getCancelCharacters(). */
  cancel?: string[];
  /** Text the query must start with, like the second "[" of "[[". */
  prefix?: RegExp;
  /** Queries that are not completed, like the emoticon ":)". */
  ignore?: string[];
}

// The autocompleteMap of PhabricatorRemarkupControl.
const SPECS: Record<string, Spec> = {
  "@": {
    datasource: "PhabricatorPeopleDatasource",
    headerIcon: "fa-user",
    headerText: "Find User:",
    hintText: "Type a username...",
  },
  "#": {
    datasource: "PhabricatorProjectDatasource",
    parameters: { autocomplete: 1 },
    headerIcon: "fa-briefcase",
    headerText: "Find Project:",
    hintText: "Type a project name...",
  },
  ":": {
    datasource: "PhabricatorEmojiDatasource",
    headerIcon: "fa-smile-o",
    headerText: "Find Emoji:",
    hintText: "Type an emoji name...",
    ignore: ["3", ")", "(", "-", "/"],
  },
  "[": {
    datasource: "PhrictionDocumentDatasource",
    headerIcon: "fa-book",
    headerText: "Find Document:",
    hintText: "Type a document name...",
    cancel: [":", "|", "]"],
    prefix: /^\[/,
  },
  "(": {
    datasource: "PhabricatorPhurlURLDatasource",
    headerIcon: "fa-compress",
    headerText: "Find Phurl:",
    hintText: "Select a phurl...",
    cancel: [")"],
    prefix: /^\(/,
  },
};

// Characters after which a trigger starts a completion: "alice@" is an email
// address, " @alice" is a user.
const PRIOR = new Set(["", " ", "\n", "\t", "(", "-", ".", "|", ">", "!"]);
const DEFAULT_CANCEL = ["#", "@", ",", "!", "?", "{", "}"];
const SUFFIXES = [" ", ":", ",", ")"];
const TERMINATORS = [" ", ":", ",", ".", "!", "?"];
const MAX_RESULTS = 5;

function trimSuffixes(text: string): string {
  for (const suffix of SUFFIXES) {
    if (text.endsWith(suffix)) {
      text = text.slice(0, -suffix.length);
    }
  }
  return text;
}

class Autocomplete {
  private trigger: string | null = null;
  /** Position after the trigger character. */
  private head = 0;
  /** End of the text typed after the trigger. */
  private tail = 0;
  private text = "";
  private query = "";
  private results: TypeaheadResult[] = [];
  private focus: number | null = null;
  private loading = false;
  /** Autocomplete texts of earlier queries, by trigger and query. */
  private readonly known = new Map<string, string[]>();
  private readonly cache = new Map<string, TypeaheadResult[]>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private popup: Popup | null = null;

  constructor(private readonly view: EditorView) {}

  get active(): boolean {
    return this.trigger !== null;
  }

  get visible(): boolean {
    return this.active && this.query.length > 0;
  }

  update(update: ViewUpdate): void {
    if (this.active && (update.docChanged || update.selectionSet)) {
      if (update.docChanged) {
        this.head = update.changes.mapPos(this.head, -1);
        this.tail = update.changes.mapPos(this.tail, 1);
      }
      this.refresh();
    }
    // A typed trigger character starts a completion.
    for (const tr of update.transactions) {
      if (!tr.isUserEvent("input.type")) {
        continue;
      }
      tr.changes.iterChanges((_fromA, _toA, _fromB, toB, inserted) => {
        const char = inserted.toString();
        if (char.length === 1 && SPECS[char]) {
          this.activate(char, toB);
        }
      });
    }
    if (this.visible && (update.geometryChanged || update.viewportChanged)) {
      this.position();
    }
  }

  private activate(char: string, head: number): void {
    const doc = this.view.state.doc;
    const prior = head >= 2 ? doc.sliceString(head - 2, head - 1) : "";
    // A repeated trigger like "[[" or "((" continues the active completion.
    if (prior === char || !PRIOR.has(prior)) {
      return;
    }
    // On a line indented by whitespace only, the user is probably typing code.
    const line = doc.lineAt(head);
    if (/^\s+$/.test(doc.sliceString(line.from, head - 1))) {
      return;
    }
    this.trigger = char;
    this.head = head;
    this.tail = head;
    this.focus = null;
    this.results = [];
    this.refresh();
  }

  deactivate(): void {
    this.trigger = null;
    this.query = "";
    clearTimeout(this.timer);
    this.popup?.remove();
    this.popup = null;
  }

  private refresh(): void {
    const spec = SPECS[this.trigger!];
    const { state } = this.view;
    const range = state.selection.main;
    if (state.doc.sliceString(this.head - 1, this.head) !== this.trigger) {
      return this.deactivate();
    }
    // The cursor left the typed text.
    if (range.from < this.head || range.to > this.tail) {
      return this.deactivate();
    }
    const text = state.doc.sliceString(this.head, this.tail);
    this.text = text;
    // "# " is a numbered list, not a project.
    if (text.startsWith(" ")) {
      return this.deactivate();
    }
    if ((spec.cancel ?? DEFAULT_CANCEL).some((c) => text.includes(c))) {
      return this.deactivate();
    }
    let query = trimSuffixes(text);
    if (spec.prefix) {
      if (!spec.prefix.test(query)) {
        // Waiting for the second "[" of "[[".
        if (query.length) {
          return this.deactivate();
        }
        this.query = "";
        return this.render();
      }
      query = query.replace(spec.prefix, "").trim();
    }
    if ((spec.ignore ?? []).some((ignored) => text.startsWith(ignored))) {
      return this.deactivate();
    }
    // After a word ends, stop if more words can not refine the results.
    if (TERMINATORS.some((t) => text.endsWith(t)) && this.unrefinable(text)) {
      return this.deactivate();
    }
    if (query !== this.query) {
      this.query = query;
      this.search(spec);
    }
    this.render();
  }

  /** See PHUIXAutocomplete._hasUnrefinableResults(). */
  private unrefinable(query: string): boolean {
    for (let i = 1; i < query.length; i++) {
      const results = this.known.get(this.trigger + query.slice(0, i));
      if (!results) {
        continue;
      }
      if (!results.length) {
        return true;
      }
      if (results.length === 1) {
        const result = results[0].slice(1);
        if (query.length >= result.length && query.startsWith(result)) {
          return true;
        }
      }
    }
    return false;
  }

  private search(spec: Spec): void {
    clearTimeout(this.timer);
    const query = this.query;
    if (!query) {
      return;
    }
    const key = `${spec.datasource}:${query}`;
    const cached = this.cache.get(key);
    if (cached) {
      this.showResults(cached);
      return;
    }
    this.loading = true;
    const trigger = this.trigger!;
    this.timer = setTimeout(async () => {
      try {
        const results = await typeahead(spec.datasource, query, spec.parameters);
        this.cache.set(key, results);
        this.known.set(
          trigger + query,
          results.map((r) => r.autocomplete),
        );
        if (this.trigger === trigger && this.query === query) {
          this.showResults(results);
        }
      } catch (error) {
        console.warn("Phizziwig: autocomplete failed", error);
      } finally {
        if (this.query === query) {
          this.loading = false;
        }
      }
    }, 50);
  }

  private showResults(results: TypeaheadResult[]): void {
    this.loading = false;
    // Open results first, like Phorge's typeahead.
    this.results = [...results.filter((r) => !r.closed), ...results.filter((r) => r.closed)].slice(0, MAX_RESULTS);
    this.focus = this.results.length ? 0 : null;
    this.render();
  }

  /** Arrow keys move the focus; past either end the menu closes. */
  moveFocus(delta: number): void {
    const next = (this.focus ?? -1) + delta;
    if (this.focus === null || next < 0 || next >= this.results.length) {
      this.deactivate();
    } else {
      this.focus = next;
      this.render();
    }
  }

  /** Enter or Tab: inserts the focused result. Returns false to let the key through. */
  accept(): boolean {
    if (this.view.state.selection.main.head === this.head) {
      // Nothing typed after the trigger yet, e.g. a line ending in "#".
      this.deactivate();
      return false;
    }
    if (this.focus === null) {
      if (this.loading) {
        // Results are on their way; like Phorge, eat the key.
        return true;
      }
      this.deactivate();
      return false;
    }
    this.insert(this.results[this.focus]);
    return true;
  }

  private insert(result: TypeaheadResult): void {
    // Keep a suffix the user typed, like the ":" of "@alice:".
    const suffix = SUFFIXES.find((s) => this.text.endsWith(s)) ?? " ";
    const insert = result.autocomplete + suffix;
    const from = this.head - 1;
    this.view.dispatch({
      changes: { from, to: this.tail, insert },
      selection: { anchor: from + insert.length },
      userEvent: "input.complete",
    });
    this.deactivate();
  }

  private render(): void {
    if (!this.visible) {
      this.popup?.remove();
      this.popup = null;
      return;
    }
    const spec = SPECS[this.trigger!];
    this.popup ??= new Popup(spec.headerIcon, spec.headerText);
    this.popup.echo.textContent = this.query || spec.hintText;
    this.popup.setItems(
      this.results.map((result) => ({
        label: result.displayName,
        icon: result.icon,
        dot: result.availabilityColor,
        closed: result.closed,
        href: result.uri,
      })),
      this.focus,
      (i) => this.insert(this.results[i]),
    );
    this.position();
  }

  private position(): void {
    this.popup?.placeAt(this.view, this.head - 1);
  }

  destroy(): void {
    this.deactivate();
  }
}

const autocompletePlugin = ViewPlugin.fromClass(Autocomplete);

function withMenu(run: (menu: Autocomplete) => boolean) {
  return (view: EditorView): boolean => {
    const menu = view.plugin(autocompletePlugin);
    return menu?.active ? run(menu) : false;
  };
}

export const phabricatorAutocomplete = [
  autocompletePlugin,
  Prec.highest(
    keymap.of([
      { key: "ArrowDown", run: withMenu((m) => m.visible && (m.moveFocus(1), true)) },
      { key: "ArrowUp", run: withMenu((m) => m.visible && (m.moveFocus(-1), true)) },
      { key: "Enter", run: withMenu((m) => m.accept()) },
      { key: "Tab", run: withMenu((m) => m.accept()) },
      { key: "Escape", run: withMenu((m) => (m.deactivate(), true)) },
    ]),
  ),
];
