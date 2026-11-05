// A search popup for links and references: type to find tasks by their
// title, wiki pages, people and other objects, or paste a URL. It looks like
// Phorge's autocomplete, with an input in its head.

import type { EditorView } from "@codemirror/view";
import { conduit, typeahead } from "../phorge";
import { syncFocus } from "./livePreview";
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

const TASKS = 8;

/**
 * Tasks by number, or by words: those with the words in their title first,
 * then those with them anywhere (description, comments), each open ones first.
 */
async function findTasks(query: string): Promise<Target[]> {
  const id = /^T?(\d+)$/i.exec(query)?.[1];
  const words = query.split(/\s+/).filter((w) => w.length > 1);
  if (!id && !words.length) {
    return [];
  }
  let tasks: Task[];
  // The open ones, when the search tells them apart.
  let open: Set<number> | null = null;
  if (id) {
    tasks = ((await conduit("maniphest.search", { constraints: { ids: [Number(id)] } })) as { data: Task[] }).data;
  } else {
    // "~word" finds the word also as part of longer words; "title:" only in titles.
    const find = async (query: string, statuses?: string[]) =>
      (
        (await conduit("maniphest.search", {
          constraints: { query, ...(statuses ? { statuses } : {}) },
          limit: TASKS,
        })) as { data: Task[] }
      ).data;
    const inTitle = words.map((w) => `title:~${w}`).join(" ");
    const anywhere = words.map((w) => `~${w}`).join(" ");
    const [titleOpen, title, textOpen, text] = await Promise.all([
      find(inTitle, ["open"]),
      find(inTitle),
      find(anywhere, ["open"]),
      find(anywhere),
    ]);
    open = new Set([...titleOpen, ...textOpen].map((task) => task.id));
    const seen = new Set<number>();
    tasks = [
      ...titleOpen,
      ...title.filter((task) => !open!.has(task.id)),
      ...textOpen,
      ...text.filter((task) => !open!.has(task.id)),
    ].filter((task) => !seen.has(task.id) && seen.add(task.id));
    tasks = tasks.slice(0, TASKS);
  }
  return tasks.map((task) => ({
    label: `T${task.id}: ${task.fields.name}`,
    icon: "fa-anchor",
    detail: task.fields.status.name,
    closed: open !== null && !open.has(task.id),
    reference: `T${task.id}`,
    target: `/T${task.id}`,
  }));
}

/** Other objects by name: people, projects, wiki pages, ... */
async function findObjects(query: string): Promise<Target[]> {
  const results = await typeahead("PhabricatorSearchDatasource", query, undefined, true);
  return results
    .filter((r) => r.uri && !/^\/T\d+$/.test(r.uri))
    .map((r) => {
      const monogram = /^\/([A-Z]\d+)$/.exec(r.uri)?.[1];
      const wiki = /^\[\[ (.+) \]\]$/.exec(r.autocomplete)?.[1];
      return {
        label: r.displayName,
        icon: r.icon || "fa-file-o",
        closed: r.closed,
        reference: r.autocomplete || monogram || `[[ ${r.uri} | ${r.displayName} ]]`,
        target: wiki ?? r.uri,
      };
    });
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
  const [tasks, objects] = await Promise.all([findTasks(query).catch(() => []), findObjects(query).catch(() => [])]);
  return [...tasks, ...objects];
}

export interface PickerOptions {
  headIcon: string;
  headText: string;
  placeholder: string;
  /** The text the input starts with, e.g. the target of the link being changed. */
  initial?: string;
  /** Where the popup is placed: below a position of the text, or below an element (a table cell). */
  at: number | HTMLElement;
  pick: (target: Target) => void;
  /** What to search, also with nothing typed yet; tasks, pages, people, … by default (search()). */
  search?: (query: string) => Promise<Target[]>;
}

let current: Picker | null = null;

class Picker {
  private readonly popup: Popup;
  private readonly input: HTMLInputElement;
  private results: Target[] = [];
  private focus: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The query searched for; null before the first search, which runs also with nothing typed. */
  private query: string | null = null;
  /** The query the shown results are for. */
  private shownQuery: string | null = null;

  constructor(
    private readonly view: EditorView,
    private readonly options: PickerOptions,
  ) {
    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.className = "rme-picker-input";
    this.input.placeholder = options.placeholder;
    this.input.value = options.initial ?? "";
    this.input.setAttribute("aria-label", options.placeholder);
    this.input.setAttribute("role", "combobox");
    this.input.setAttribute("aria-autocomplete", "list");
    this.popup = new Popup(options.headIcon, options.headText, this.input);
    this.input.setAttribute("aria-controls", this.popup.listId);
    this.popup.node.classList.add("rme-picker");
    this.input.addEventListener("input", () => this.changed());
    this.input.addEventListener("keydown", (event) => this.onKeyDown(event));
    this.input.addEventListener("blur", () => setTimeout(() => this.close(false), 0));
    // Measured with the block being edited showing its source, which it
    // keeps while the picker has the focus (livePreview.ts).
    syncFocus(view);
    const at = typeof options.at === "number" ? view.coordsAtPos(options.at) : null;
    this.popup.placeAt(view, at ?? options.at);
    // It is placed in the next measure; until then it is at the end of the page.
    this.input.focus({ preventScroll: true });
    this.input.select();
    this.changed();
  }

  private changed(): void {
    const query = this.input.value;
    if (query === this.query) {
      return;
    }
    this.query = query;
    clearTimeout(this.timer);
    this.timer = setTimeout(async () => {
      const results = await (this.options.search ?? search)(query);
      if (this.query === query && current === this) {
        this.results = results;
        this.shownQuery = query;
        this.focus = results.length ? 0 : null;
        this.render();
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
    } else if (key === "Enter" || (key === "Tab" && this.input.value.trim())) {
      event.preventDefault();
      if (this.shownQuery === this.input.value && this.focus !== null) {
        this.accept(this.focus);
      } else {
        // Typed faster than the search: take the first result for what is typed.
        const query = this.input.value;
        void search(query).then(([first]) => {
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

  private choose(target: Target): void {
    this.close(true);
    this.options.pick(target);
  }

  close(refocus: boolean): void {
    if (current !== this) {
      return;
    }
    current = null;
    clearTimeout(this.timer);
    this.popup.remove();
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

/** Opens the picker; the editor gets the focus back when it closes. */
export function openPicker(view: EditorView, options: PickerOptions): void {
  current?.close(false);
  current = new Picker(view, options);
}
