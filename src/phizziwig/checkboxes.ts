// Checkboxes in rendered text can be clicked: in task descriptions, revision
// summaries and test plans, wiki pages and comments. A click checks or
// unchecks the box at once; 5 seconds after the last click, the boxes
// clicked are saved in the text's source, one edit per text, the way the page
// does it (Conduit, or the comment's "Edit Comment"): only their marks change.
// The source is read fresh before saving, and nothing is saved unless its
// checkboxes are those shown (checkmarks.ts finds them as Phorge does), e.g.
// when someone else changed the text meanwhile. Leaving the page saves
// what waits (with the source read at the first click), the tab going to
// the background too.

import { setCheckmark, checkmarks } from "./checkmarks";
import { conduit, editComment } from "./phorge";

/** A text of the page whose checkboxes can be saved. */
interface Entry {
  /** The rendered text. */
  root: Element;
  /** What it is, for messages: "the description", "the comment", … */
  name: string;
  load(): Promise<string>;
  /** Saves the text; with keepalive, also when the page is being left. */
  save(text: string, keepalive: boolean): Promise<void>;
}

/** The monogram of the object the page shows ("T12" of "/T12"), if it is one. */
function pageObject(): { type: string; id: number } | null {
  const match = /^\/([A-Z])(\d+)\/?$/.exec(location.pathname);
  return match ? { type: match[1], id: Number(match[2]) } : null;
}

/** The text an editable field of an object: its source and how to save it, by Conduit. */
function fieldEntry(root: Element, name: string, search: string, edit: string, field: string, monogram: string): Entry {
  const id = Number(monogram.slice(1));
  return {
    root,
    name,
    load: async () => {
      const result = (await conduit(search, { constraints: { ids: [id] } })) as {
        data: { fields: Record<string, { raw: string } | string> }[];
      };
      const value = result.data[0]?.fields[field];
      if (value === undefined) {
        throw new Error(`${monogram} has no ${field}`);
      }
      return typeof value === "string" ? value : value.raw;
    },
    save: async (text, keepalive) => {
      await conduit(
        edit,
        { objectIdentifier: monogram, transactions: [{ type: field, value: text }] },
        15_000,
        keepalive,
      );
    },
  };
}

interface Transaction {
  id: number;
  phid: string;
  type: string | null;
  comments: { content: { raw: string } }[];
}

/**
 * The comment of a timeline entry: the first comment transaction from the
 * entry's anchor on (the anchor is the ID of the first transaction of the
 * entry's group, which has one comment at most).
 */
async function commentAt(monogram: string, anchor: number): Promise<Transaction> {
  let comment: Transaction | null = null;
  let after: string | null = null;
  // Newest first, page by page, until before the anchor.
  for (let page = 0; page < 50; page++) {
    const result = (await conduit("transaction.search", {
      objectIdentifier: monogram,
      limit: 100,
      ...(after ? { after } : {}),
    })) as { data: Transaction[]; cursor: { after: string | null } };
    for (const transaction of result.data) {
      if (transaction.id >= anchor && transaction.type === "comment" && (!comment || transaction.id < comment.id)) {
        comment = transaction;
      }
    }
    after = result.cursor.after;
    if (!after || result.data.some((transaction) => transaction.id < anchor)) {
      break;
    }
  }
  if (!comment) {
    throw new Error(`No comment at ${anchor} of ${monogram}`);
  }
  return comment;
}

/** The text a checkbox is in, if it can be saved. */
function entryOf(box: Element): Entry | null {
  const object = pageObject();
  const comment = box.closest(".transaction-comment");
  if (comment) {
    const anchor = Number(comment.closest(".phui-timeline-shell")?.querySelector("a[name]")?.getAttribute("name"));
    if (!object || !anchor) {
      return null;
    }
    const monogram = `${object.type}${object.id}`;
    let phid: string | null = null;
    return {
      root: comment,
      name: "the comment",
      load: async () => {
        const transaction = await commentAt(monogram, anchor);
        phid = transaction.phid;
        return transaction.comments[0]?.content.raw ?? "";
      },
      save: (text, keepalive) => editComment(phid!, text, keepalive),
    };
  }
  const section = box.closest(".phui-property-list-text-content");
  if (section && object) {
    // The heading of the text, right before it (several texts share a section).
    const heading = section.previousElementSibling?.matches(".phui-property-list-section-header")
      ? section.previousElementSibling.textContent?.trim()
      : null;
    const monogram = `${object.type}${object.id}`;
    if (object.type === "T" && (!heading || heading === "Description")) {
      return fieldEntry(section, "the description", "maniphest.search", "maniphest.edit", "description", monogram);
    }
    if (object.type === "D" && heading === "Summary") {
      return fieldEntry(
        section,
        "the summary",
        "differential.revision.search",
        "differential.revision.edit",
        "summary",
        monogram,
      );
    }
    if (object.type === "D" && heading === "Test Plan") {
      return fieldEntry(
        section,
        "the test plan",
        "differential.revision.search",
        "differential.revision.edit",
        "testPlan",
        monogram,
      );
    }
    return null;
  }
  const page = box.closest(".phui-document-content-view");
  if (page && location.pathname.startsWith("/w/")) {
    const slug = decodeURIComponent(location.pathname.slice(3)) || "/";
    return {
      root: page,
      name: "the page",
      load: async () => {
        const result = (await conduit("phriction.document.search", {
          constraints: { paths: [slug] },
          attachments: { content: true },
        })) as { data: { attachments: { content: { content: { raw: string } } } }[] };
        const document = result.data[0];
        if (!document) {
          throw new Error(`No wiki page ${slug}`);
        }
        return document.attachments.content.content.raw;
      },
      save: async (text, keepalive) => {
        await conduit("phriction.edit", { slug, content: text }, 15_000, keepalive);
      },
    };
  }
  return null;
}

const CHECKBOX = "ul.remarkup-list-with-checkmarks input[type=checkbox]";
const enabled = new WeakSet<HTMLInputElement>();

/** Makes the checkboxes in or at a node clickable, where their text can be saved. */
export function enableCheckboxes(root: ParentNode): void {
  for (const box of Array.from(root.querySelectorAll<HTMLInputElement>(CHECKBOX))) {
    // Not in editors and previews of what is being written.
    if (enabled.has(box) || box.closest(".rme-editor, .phui-remarkup-preview, form") || !entryOf(box)) {
      continue;
    }
    enabled.add(box);
    box.disabled = false;
    box.classList.add("rme-checkable");
    box.title = "Check or uncheck: saves the text";
    box.addEventListener("click", (event) => {
      // The browser has toggled it already, and puts it back for preventDefault():
      // toggle() shows its new state.
      const checked = !box.checked;
      event.preventDefault();
      // After the browser put it back.
      setTimeout(() => toggle(box, checked));
    });
  }
}

/** How long after the last click the boxes clicked are saved. */
const SAVE_DELAY = 5_000;

/** The boxes clicked of a text, not saved yet. */
interface Pending {
  entry: Entry;
  /** How each box clicked was, by its index in the text. */
  changes: Map<number, boolean>;
  /** The source, read at the first click: for saving on leaving the page. */
  loaded: string | null;
  /** Until the source is read (null if it could not be). */
  loading: Promise<string | null>;
}

/** The texts with boxes clicked, by their rendered text. */
const pending = new Map<Element, Pending>();
let timer: ReturnType<typeof setTimeout> | undefined;
let watchingLeave = false;

function boxesOf(entry: Entry): HTMLInputElement[] {
  return Array.from(entry.root.querySelectorAll<HTMLInputElement>(CHECKBOX));
}

/** Shows a box checked or not. */
function show(box: HTMLInputElement, checked: boolean): void {
  box.checked = checked;
  const item = box.closest("li");
  item?.classList.toggle("remarkup-checked-item", checked);
  item?.classList.toggle("remarkup-unchecked-item", !checked);
}

/** A click: the box shows its new state, which is saved with the others clicked, once clicking pauses. */
function toggle(box: HTMLInputElement, checked: boolean): void {
  const entry = entryOf(box);
  if (!entry || box.classList.contains("rme-saving")) {
    return;
  }
  let waiting = pending.get(entry.root);
  if (!waiting) {
    const created: Pending = {
      entry,
      changes: new Map(),
      loaded: null,
      loading: entry.load().then(
        (source) => (created.loaded = source),
        () => null,
      ),
    };
    waiting = created;
    pending.set(entry.root, created);
  }
  const index = boxesOf(waiting.entry).indexOf(box);
  // Clicked back: nothing to save for it.
  if (waiting.changes.has(index)) {
    waiting.changes.delete(index);
  } else {
    waiting.changes.set(index, checked);
  }
  show(box, !checked);
  box.classList.toggle("rme-pending", waiting.changes.has(index));
  if (!waiting.changes.size) {
    pending.delete(entry.root);
  }
  clearTimeout(timer);
  timer = setTimeout(() => void saveAll(), SAVE_DELAY);
  watchLeave();
}

/** Saves what waits, now. */
async function saveAll(leaving = false): Promise<void> {
  clearTimeout(timer);
  const all = Array.from(pending.values());
  pending.clear();
  await Promise.all(all.map((waiting) => save(waiting, leaving)));
}

/**
 * Saves the boxes clicked of a text as they show now, if its source still has
 * the boxes shown (else they show as they were again); boxes that are so
 * already need nothing (e.g. saved by a page left before this one loaded).
 * Then all boxes show as the source has them. Leaving the page, with the
 * source read at the first click (there is no time to read it again), in one
 * request that the browser finishes after the page is gone (keepalive).
 */
async function save({ entry, changes, loaded, loading }: Pending, leaving: boolean): Promise<void> {
  const boxes = boxesOf(entry);
  const clicked = Array.from(changes, ([index, checked]) => ({ box: boxes[index], index, checked }));
  const undo = () => clicked.forEach(({ box, checked }) => box && show(box, checked));
  clicked.forEach(({ box }) => box?.classList.add("rme-saving"));
  try {
    const source = leaving ? (loaded ?? (await loading)) : await entry.load();
    if (source === null) {
      return;
    }
    // The boxes as the page shows them: else a click would change another box.
    if (checkmarks(source).length !== boxes.length) {
      undo();
      note(clicked[0].box, `${capitalized(entry.name)} changed meanwhile: reload the page to check its boxes.`);
      return;
    }
    const text = clicked.reduce((text, { index, checked }) => setCheckmark(text, index, !checked)!, source);
    if (text !== source) {
      await entry.save(text, leaving);
    }
    // As saved, also the boxes the page showed differently (but not those clicked since).
    checkmarks(text).forEach((mark, index) => {
      const box = boxes[index];
      if (box && (!box.classList.contains("rme-pending") || clicked.some((c) => c.box === box))) {
        show(box, mark.checked);
      }
    });
  } catch (error) {
    console.warn("Phizziwig: the checkboxes could not be saved", error);
    undo();
    note(clicked[0].box, `The checkboxes could not be saved: you may not be allowed to edit ${entry.name}.`);
  } finally {
    clicked.forEach(({ box }) => box?.classList.remove("rme-saving", "rme-pending"));
  }
}

/**
 * Saves what waits as soon as the page may go: when it is hidden (another
 * tab or app, the tab or window closing, the screen locking), which browsers
 * tell most reliably, also on phones; when it is left or reloaded.
 */
function watchLeave(): void {
  if (watchingLeave) {
    return;
  }
  watchingLeave = true;
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && pending.size) {
      void saveAll(true);
    }
  });
  window.addEventListener("pagehide", () => {
    if (pending.size) {
      void saveAll(true);
    }
  });
  // A link followed (e.g. to this page again): saved first, so the next page shows it.
  document.addEventListener(
    "click",
    (event) => {
      const link = (event.target as Element).closest?.<HTMLAnchorElement>("a[href]");
      const plain = event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey;
      if (!pending.size || !link || !plain || event.defaultPrevented || (link.target && link.target !== "_self")) {
        return;
      }
      const url = new URL(link.href, location.href);
      // Not Phorge's links with a behavior of their own (dialogs, menus): they have a sigil.
      if (
        url.origin !== location.origin ||
        link.getAttribute("href")!.startsWith("#") ||
        link.hasAttribute("data-sigil") ||
        link.closest(".rme-editor")
      ) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      void saveAll().finally(() => location.assign(url));
    },
    true,
  );
  // Reloading, closing, another address: the browser asks, which gives the time to save.
  window.addEventListener("beforeunload", (event) => {
    if (pending.size) {
      event.preventDefault();
      void saveAll(true);
    }
  });
}

const capitalized = (text: string) => text[0].toUpperCase() + text.slice(1);

/** A note next to a checkbox for a while, e.g. why it was not saved. */
function note(box: HTMLInputElement, text: string): void {
  const shown = document.createElement("span");
  shown.className = "rme-check-note";
  shown.setAttribute("role", "alert");
  shown.textContent = text;
  box.closest("li")?.append(shown);
  setTimeout(() => shown.remove(), 8000);
}
