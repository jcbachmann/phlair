// A search popup for links and references: type to find tasks by their
// title, wiki pages, people and other objects, or paste a URL. It looks like
// Phorge's autocomplete, with an input in its head; for links also one for
// their text. The text it replaces stays highlighted while it is open.

import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { conduit, typeahead } from "../phorge";
import { syncFocus } from "./focus";
import { Popup, type PopupItem } from "./popup";

export interface Target {
  label: string;
  icon: string;
  closed?: boolean;
  detail?: string;
  /** The text that references the object, e.g. "T12", "@alice", "[[ wiki/page/ ]]". */
  reference: string;
  /** Where a link with a text of its own points, e.g. "/T12" or "wiki/page/". */
  target: string;
  /** A picture of it, e.g. of an image macro. */
  image?: string;
  /** The color of its icon, e.g. of an icon to insert. */
  iconColor?: string;
}

interface Task {
  id: number;
  fields: { name: string; status: { value: string; name: string } };
}

const URL_LIKE = /^(https?:\/\/|www\.|mailto:)\S+$/i;

/** Results of each kind and group (title or text, open or closed). */
const PER_GROUP = 8;

/** Results found by words: in titles or in all text, each open and closed. */
interface Groups {
  titleOpen: Target[];
  titleClosed: Target[];
  textOpen: Target[];
  textClosed: Target[];
}

/**
 * Searches by words: those with the words in their title, then those with
 * them anywhere (description, comments, page text), each open and closed.
 * "~word" also finds the word as part of longer words; "title:" only in titles.
 */
async function byWords<T>(
  words: string[],
  find: (query: string) => Promise<T[]>,
  target: (item: T) => Target,
): Promise<Groups> {
  const [title, text] = await Promise.all([
    find(words.map((w) => `title:~${w}`).join(" ")),
    find(words.map((w) => `~${w}`).join(" ")),
  ]);
  const titles = title.map(target);
  const found = new Set(titles.map((t) => t.target));
  const texts = text.map(target).filter((t) => !found.has(t.target));
  return {
    titleOpen: titles.filter((t) => !t.closed),
    titleClosed: titles.filter((t) => t.closed),
    textOpen: texts.filter((t) => !t.closed),
    textClosed: texts.filter((t) => t.closed),
  };
}

function taskTarget(task: Task, closed: boolean): Target {
  return {
    label: `T${task.id}: ${task.fields.name}`,
    icon: "fa-anchor",
    detail: task.fields.status.name,
    closed,
    reference: `T${task.id}`,
    target: `/T${task.id}`,
  };
}

/** Tasks by words; open ones are those the search for open tasks finds. */
async function findTasks(words: string[]): Promise<Groups> {
  const search = async (query: string, statuses?: string[]) =>
    (
      (await conduit("maniphest.search", {
        constraints: { query, ...(statuses ? { statuses } : {}) },
        limit: PER_GROUP,
      })) as { data: Task[] }
    ).data;
  return byWords(
    words,
    async (query) => {
      const [open, all] = await Promise.all([search(query, ["open"]), search(query)]);
      const ids = new Set(open.map((task) => task.id));
      return [...open, ...all.filter((task) => !ids.has(task.id))].map((task) => ({ task, open: ids.has(task.id) }));
    },
    ({ task, open }) => taskTarget(task, !open),
  );
}

interface WikiPage {
  fields: { path: string; status: { value: string; name: string } };
  attachments: { content: { title: string } };
}

/** Wiki pages by words; deleted and moved pages count as closed. */
async function findWikiPages(words: string[]): Promise<Groups> {
  return byWords(
    words,
    async (query) =>
      (
        (await conduit("phriction.document.search", {
          constraints: { query },
          attachments: { content: true },
          limit: PER_GROUP,
        })) as { data: WikiPage[] }
      ).data,
    (page) => {
      const closed = page.fields.status.value !== "active";
      return {
        label: page.attachments.content.title || page.fields.path,
        icon: "fa-book",
        detail: closed ? page.fields.status.name : undefined,
        closed,
        reference: `[[ ${page.fields.path} ]]`,
        target: page.fields.path,
      };
    },
  );
}

/** A task by its number ("T12" or "12"). */
async function findTask(id: number): Promise<Target[]> {
  const tasks = ((await conduit("maniphest.search", { constraints: { ids: [id] } })) as { data: Task[] }).data;
  return tasks.map((task) => taskTarget(task, false));
}

/** Other objects by name: people, projects, repositories, … (not tasks and wiki pages, found above). */
async function findObjects(query: string): Promise<Target[]> {
  const results = await typeahead("PhabricatorSearchDatasource", query, undefined, true);
  return results
    .filter((r) => r.uri && !/^\/T\d+$/.test(r.uri) && !/^\[\[ /.test(r.autocomplete))
    .map((r) => {
      const monogram = /^\/([A-Z]\d+)$/.exec(r.uri)?.[1];
      return {
        label: r.displayName,
        icon: r.icon || "fa-file-o",
        closed: r.closed,
        reference: r.autocomplete || monogram || `[[ ${r.uri} | ${r.displayName} ]]`,
        target: r.uri,
      };
    });
}

/** The tasks and wiki pages found by words, in this order: by title, then by text; each open, then closed; wiki pages first. */
function ordered(wiki: Groups, tasks: Groups): Target[] {
  return (["titleOpen", "titleClosed", "textOpen", "textClosed"] as const).flatMap((group) => [
    ...wiki[group],
    ...tasks[group],
  ]);
}

export async function search(query: string): Promise<Target[]> {
  query = query.trim();
  if (!query) {
    return [];
  }
  if (URL_LIKE.test(query)) {
    const url = /^www\./i.test(query) ? `https://${query}` : query;
    return [{ label: `Link to ${url}`, icon: "fa-link", reference: url, target: url }];
  }
  const id = /^T?(\d+)$/i.exec(query)?.[1];
  const words = query.split(/\s+/).filter((w) => w.length > 1);
  const none: Groups = { titleOpen: [], titleClosed: [], textOpen: [], textClosed: [] };
  const [task, tasks, wiki, objects] = await Promise.all([
    id ? findTask(Number(id)).catch(() => []) : [],
    !id && words.length ? findTasks(words).catch(() => none) : none,
    words.length ? findWikiPages(words).catch(() => none) : none,
    findObjects(query).catch(() => []),
  ]);
  return [...task, ...ordered(wiki, tasks), ...objects];
}

/** A range of the text, from–to. */
export interface Range {
  from: number;
  to: number;
}

export interface PickerOptions {
  headIcon: string;
  headText: string;
  placeholder: string;
  /** The text the input starts with, e.g. the target of the link being changed. */
  initial?: string;
  /**
   * What `initial` is: picked when it is not changed and no result is chosen
   * (e.g. only the text of a link is changed), instead of the first result.
   */
  initialTarget?: Target;
  /** With a field for the text of a link, starting with this text. */
  text?: string;
  /** The text the pick replaces (empty: where it inserts); the popup shows below it. */
  range: Range;
  /**
   * Called with the target picked and the range, moved by the changes made
   * while the picker was open (e.g. uploads finishing before it); with a text
   * field, also with its text.
   */
  pick: (target: Target, range: Range, text: string) => void;
  /** With a text field: Enter with the link field empty, for the text alone (or nothing). */
  unlink?: (range: Range, text: string) => void;
  /** What to search, also with nothing typed yet; tasks, pages, people, … by default (search()). */
  search?: (query: string) => Promise<Target[]>;
}

let current: Picker | null = null;

class Picker {
  private readonly popup: Popup;
  private readonly input: HTMLInputElement;
  /** The field of the link's text, if it has one. */
  private readonly textInput: HTMLInputElement | null = null;
  private results: Target[] = [];
  private focus: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The query searched for; null before the first search, which runs also with nothing typed. */
  private query: string | null = null;
  /** The query the shown results are for. */
  private shownQuery: string | null = null;
  /** The range of the pick, as the text changes. */
  range: Range;

  constructor(
    readonly view: EditorView,
    private readonly options: PickerOptions,
  ) {
    this.range = { from: options.range.from, to: options.range.to };
    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.className = "rme-picker-input rme-picker-search";
    this.input.placeholder = options.placeholder;
    this.input.value = options.initial ?? "";
    this.input.setAttribute("aria-label", options.placeholder);
    this.input.setAttribute("role", "combobox");
    this.input.setAttribute("aria-autocomplete", "list");
    if (options.text === undefined) {
      this.popup = new Popup(options.headIcon, options.headText, this.input);
    } else {
      // Text above, link below, like word processors ask for links.
      this.textInput = document.createElement("input");
      this.textInput.type = "text";
      this.textInput.className = "rme-picker-input rme-picker-text";
      this.textInput.placeholder = "Optional";
      this.textInput.value = options.text;
      this.textInput.addEventListener("keydown", (event) => this.onKeyDown(event));
      this.textInput.addEventListener("blur", () => this.blurred());
      const fields = document.createElement("div");
      fields.className = "rme-picker-fields";
      const field = (label: string, input: HTMLInputElement) => {
        const row = document.createElement("label");
        const name = document.createElement("span");
        name.textContent = label;
        input.setAttribute("aria-label", label);
        row.append(name, input);
        return row;
      };
      fields.append(field("Text", this.textInput), field(options.headText.replace(/:$/, ""), this.input));
      this.popup = new Popup(options.headIcon, "", fields);
    }
    this.input.setAttribute("aria-controls", this.popup.listId);
    this.popup.node.classList.add("rme-picker");
    this.input.addEventListener("input", () => this.changed());
    this.input.addEventListener("keydown", (event) => this.onKeyDown(event));
    this.input.addEventListener("blur", () => this.blurred());
    // Placed with the block being edited showing its source, which it keeps
    // while the picker has the focus (livePreview.ts).
    syncFocus(view);
    if (this.range.to > this.range.from) {
      view.dispatch({ effects: setPicking.of(this.range) });
    }
    this.popup.placeAt(view, this.range.from);
    // It is placed in the next measure; until then it is at the end of the page.
    this.input.focus({ preventScroll: true });
    this.input.select();
    this.changed();
  }

  /** Closes it once the focus is elsewhere than in its fields. */
  private blurred(): void {
    setTimeout(() => {
      if (!this.popup.node.contains(document.activeElement)) {
        this.close(false);
      }
    }, 0);
  }

  /** Whether the link field still has what it started with, which is picked unless a result is chosen. */
  private get unchanged(): boolean {
    return !!this.options.initialTarget && this.input.value === (this.options.initial ?? "");
  }

  private changed(): void {
    const query = this.input.value;
    if (query === this.query) {
      return;
    }
    this.query = query;
    clearTimeout(this.timer);
    if (query.trim() && !this.results.length) {
      this.popup.setNote("Searching…");
    }
    this.timer = setTimeout(async () => {
      let results: Target[] = [];
      let failed = false;
      try {
        results = await (this.options.search ?? search)(query);
      } catch (error) {
        console.warn("Phizziwig: the search failed", error);
        failed = true;
      }
      if (this.query === query && current === this) {
        this.results = results;
        this.shownQuery = query;
        // Not while the link field has what it started with: Enter keeps that.
        this.focus = results.length && !this.unchanged ? 0 : null;
        this.render();
        this.popup.setNote(failed ? "The search failed." : !results.length && query.trim() ? "Nothing found." : null);
      }
    }, 150);
  }

  private render(): void {
    const items: PopupItem[] = this.results.map((r) => ({
      label: r.label,
      icon: r.icon,
      closed: r.closed,
      detail: r.detail,
      image: r.image,
      iconColor: r.iconColor,
    }));
    this.popup.setItems(items, this.focus, (i) => this.accept(i));
    this.input.setAttribute("aria-expanded", String(items.length > 0));
    this.input.setAttribute("aria-activedescendant", this.focus === null ? "" : this.popup.optionId(this.focus));
  }

  private onKeyDown(event: KeyboardEvent): void {
    const key = event.key;
    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      if (this.results.length) {
        const delta = key === "ArrowDown" ? 1 : -1;
        this.focus = ((this.focus ?? -1) + delta + this.results.length) % this.results.length;
        this.render();
      }
    } else if (key === "PageDown" || key === "PageUp") {
      event.preventDefault();
      if (this.results.length) {
        this.focus = this.popup.pageFrom(this.focus ?? 0, key === "PageDown" ? 1 : -1, this.results.length);
        this.render();
      }
    } else if (key === "Tab" && this.textInput) {
      // Between the text and the link.
      event.preventDefault();
      (event.target === this.input ? this.textInput : this.input).focus();
    } else if (
      key === "Enter" &&
      this.textInput &&
      (!this.input.value.trim() || (this.unchanged && this.focus === null))
    ) {
      // No link (text only, or nothing), or the link it had.
      event.preventDefault();
      this.choose(this.input.value.trim() ? this.options.initialTarget! : null);
    } else if (key === "Enter" || (key === "Tab" && this.input.value.trim())) {
      event.preventDefault();
      if (this.shownQuery === this.input.value && this.focus !== null) {
        this.accept(this.focus);
      } else {
        // Typed faster than the search: take the first result for what is typed.
        const query = this.input.value;
        void (this.options.search ?? search)(query).then(([first]) => {
          if (first && current === this && this.input.value === query) {
            this.choose(first);
          }
        });
      }
    } else if (key === "Tab") {
      event.preventDefault();
      this.close(true);
    } else if (key === "Escape") {
      event.preventDefault();
      this.close(true);
    }
    // The page's keyboard shortcuts must not see the typing.
    event.stopPropagation();
  }

  private accept(index: number): void {
    this.choose(this.results[index]);
  }

  private choose(target: Target | null): void {
    const text = this.textInput?.value.trim() ?? "";
    this.close(true);
    if (target) {
      this.options.pick(target, this.range, text);
    } else {
      this.options.unlink?.(this.range, text);
    }
  }

  close(refocus: boolean): void {
    if (current !== this) {
      return;
    }
    current = null;
    clearTimeout(this.timer);
    this.popup.remove();
    if (this.view.dom.isConnected) {
      this.view.dispatch({ effects: setPicking.of(null) });
    }
    if (refocus) {
      this.view.focus();
    }
  }
}

/** Closes the open picker; false if none was open. */
export function closePicker(): boolean {
  const picker = current;
  picker?.close(true);
  return picker !== null;
}

const setPicking = StateEffect.define<Range | null>();

/** The text the open picker replaces, highlighted like a selection while the focus is in the picker. */
const pickingField = StateField.define<Range | null>({
  create: () => null,
  update(range, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setPicking)) {
        return effect.value;
      }
    }
    return range && tr.docChanged
      ? { from: tr.changes.mapPos(range.from, 1), to: tr.changes.mapPos(range.to, -1) }
      : range;
  },
  provide: (field) =>
    EditorView.decorations.from(field, (range) =>
      range && range.to > range.from
        ? Decoration.set(Decoration.mark({ class: "rme-picking" }).range(range.from, range.to))
        : Decoration.none,
    ),
});

/**
 * Moves the range of the open picker with the changes of its editor's text,
 * and highlights it; in every editor that opens pickers (the text, table cells).
 */
export const pickerRanges = [
  pickingField,
  EditorView.updateListener.of((update) => {
    if (current?.view === update.view && update.docChanged) {
      const { from, to } = current.range;
      // A range being replaced keeps what is typed at its edges outside of it.
      const start = update.changes.mapPos(from, from === to ? -1 : 1);
      current.range = { from: start, to: Math.max(start, update.changes.mapPos(to, -1)) };
    }
  }),
];

/** Opens the picker; the editor gets the focus back when it closes. */
export function openPicker(view: EditorView, options: PickerOptions): void {
  current?.close(false);
  current = new Picker(view, options);
}
