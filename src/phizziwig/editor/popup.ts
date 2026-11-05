// The popup of Phorge's autocomplete (PHUIXAutocomplete): a head with a
// prompt and a list of results. Its markup lets Phorge's CSS style it.
// Used by the autocomplete, the insert menu and the pickers.

import type { EditorView } from "@codemirror/view";

export interface PopupItem {
  label: string;
  /** Font Awesome classes, e.g. "fa-user bluegrey". */
  icon?: string;
  /** The icon's color, which the menu's own style would override. */
  iconColor?: string;
  /** Color of a user's availability dot, e.g. "red". */
  dot?: string;
  /** Shown dimmed, like closed tasks. */
  closed?: boolean;
  /** Shown after the label, dimmed: a shortcut or a hint. */
  detail?: string;
  href?: string;
  /** A picture shown with the label, e.g. of an image macro. */
  image?: string;
  /** Its group: a heading above the first item of each group. */
  group?: string;
}

function icon(classes: string): HTMLElement {
  const node = document.createElement("span");
  node.className = `phui-icon-view phui-font-fa ${classes}`;
  return node;
}

let popups = 0;

export class Popup {
  readonly node: HTMLElement;
  /** The text after the prompt; replaced by an input in pickers. */
  readonly echo: HTMLElement;
  private readonly list: HTMLElement;
  /** The ID of the list of results, for aria-controls. */
  readonly listId = `rme-popup-${++popups}`;

  constructor(headIcon: string, headText: string, echo?: HTMLElement) {
    this.node = document.createElement("div");
    this.node.className = "phuix-autocomplete rme-autocomplete";
    const head = document.createElement("div");
    head.className = "phuix-autocomplete-head";
    const prompt = document.createElement("span");
    prompt.className = "phuix-autocomplete-prompt";
    prompt.append(icon(headIcon), headText);
    this.echo = echo ?? document.createElement("span");
    this.echo.classList.add("phuix-autocomplete-echo");
    head.append(prompt, this.echo);
    this.list = document.createElement("div");
    this.list.className = "phuix-autocomplete-list";
    this.list.id = this.listId;
    this.list.setAttribute("role", "listbox");
    this.node.append(head, this.list);
    // Keep the focus where it is (the editor, or the picker's input).
    this.node.addEventListener("mousedown", (event) => {
      if (!this.echo.contains(event.target as Node)) {
        event.preventDefault();
      }
    });
    document.body.append(this.node);
  }

  setItems(items: PopupItem[], focus: number | null, pick: (index: number) => void): void {
    // A long list (of icons, of pictures) is shorter and scrolls; pictures load when scrolled to.
    this.node.classList.toggle("rme-popup-long", items.length > 12 || items.some((item) => item.image));
    this.list.replaceChildren(
      ...items.flatMap((item, i) => {
        const node = document.createElement("a");
        node.className = "jx-result" + (i === focus ? " focused" : "");
        node.id = this.optionId(i);
        node.setAttribute("role", "option");
        node.setAttribute("aria-selected", String(i === focus));
        node.href = item.href || "#";
        const display = document.createElement("span");
        if (item.image) {
          const image = document.createElement("img");
          image.className = "rme-popup-image";
          image.src = item.image;
          image.alt = "";
          image.loading = "lazy";
          display.classList.add("rme-popup-with-image");
          display.append(image);
        } else if (item.icon) {
          const glyph = icon(item.icon);
          if (item.iconColor) {
            glyph.style.color = item.iconColor;
          }
          display.append(glyph);
        }
        if (item.dot) {
          const dot = document.createElement("span");
          dot.className = `phui-tag-dot phui-tag-color-${item.dot}`;
          display.append(dot);
        }
        display.append(item.label);
        display.classList.toggle("tokenizer-result-closed", !!item.closed);
        if (item.detail) {
          const detail = document.createElement("span");
          detail.className = "rme-popup-detail";
          detail.textContent = item.detail;
          display.append(detail);
        }
        node.append(display);
        if (i === focus) {
          // Keep the focused item in view in a scrolling list.
          requestAnimationFrame(() => node.scrollIntoView({ block: "nearest" }));
        }
        node.addEventListener("click", (event) => {
          event.preventDefault();
          pick(i);
        });
        if (!item.group || item.group === items[i - 1]?.group) {
          return [node];
        }
        const heading = document.createElement("div");
        heading.className = "rme-popup-group";
        heading.setAttribute("role", "presentation");
        heading.textContent = item.group;
        return [heading, node];
      }),
    );
  }

  /** Page Up or Down from an item: the item a page of the shown list away, or the first or last. */
  pageFrom(index: number, direction: 1 | -1, count: number): number {
    const item = this.list.querySelector<HTMLElement>(".jx-result");
    const page = item ? Math.max(1, Math.floor(this.list.clientHeight / item.offsetHeight) - 1) : 1;
    return Math.min(count - 1, Math.max(0, index + direction * page));
  }

  optionId(index: number): string {
    return `${this.listId}-${index}`;
  }

  /** A note below the items, e.g. that a search runs or found nothing; null removes it. */
  setNote(text: string | null): void {
    let note = this.node.querySelector<HTMLElement>(".rme-popup-note");
    if (text === null) {
      note?.remove();
      return;
    }
    if (!note) {
      note = document.createElement("div");
      note.className = "rme-popup-note";
      note.setAttribute("role", "status");
      this.node.append(note);
    }
    note.textContent = text;
  }

  /**
   * Tells assistive technology that the text being typed in (the editor's
   * content) has this menu, with its focused item; like CodeMirror's own
   * autocomplete does.
   */
  describe(content: HTMLElement, focus: number | null): void {
    content.setAttribute("aria-autocomplete", "list");
    content.setAttribute("aria-haspopup", "listbox");
    content.setAttribute("aria-controls", this.listId);
    if (focus === null) {
      content.removeAttribute("aria-activedescendant");
    } else {
      content.setAttribute("aria-activedescendant", this.optionId(focus));
    }
  }

  /** The menu is gone: see describe(). */
  static undescribe(content: HTMLElement): void {
    for (const name of ["aria-autocomplete", "aria-haspopup", "aria-controls", "aria-activedescendant"]) {
      content.removeAttribute(name);
    }
  }

  /** Where the popup is placed, while it is: placed again when something scrolls. */
  private placed: { view: EditorView; at: number } | null = null;
  private readonly onScroll = (event: Event) => {
    // Not its own list scrolling.
    if (this.placed && !this.node.contains(event.target as Node)) {
      this.measure(this.placed.view, this.placed.at);
    }
  };

  /**
   * Places the popup below a position of the text, and keeps it there when
   * the page or a box around the editor scrolls (e.g. the editor in a
   * dialog); hidden while the position is scrolled out of the editor's view.
   */
  placeAt(view: EditorView, at: number): void {
    if (!this.placed) {
      document.addEventListener("scroll", this.onScroll, true);
    }
    this.placed = { view, at };
    this.measure(view, at);
  }

  /** Layout is read in CodeMirror's measure phase. */
  private measure(view: EditorView, at: number): void {
    view.requestMeasure({
      key: this,
      read: () => ({ coords: view.coordsAtPos(at), box: view.scrollDOM.getBoundingClientRect() }),
      write: ({ coords, box }) => {
        const outside = !coords || coords.bottom < box.top || coords.top > box.bottom;
        this.node.style.visibility = outside ? "hidden" : "";
        if (!coords || outside) {
          return;
        }
        // Below the text, or above it where there is more room; a list that
        // fits on neither side scrolls (and keeps where it is scrolled to).
        const scrolled = this.list.scrollTop;
        this.list.style.maxHeight = "";
        const height = this.node.offsetHeight;
        const below = window.innerHeight - coords.bottom - 8;
        const above = coords.top - 8;
        const onBelow = height <= below || below >= above;
        const room = onBelow ? below : above;
        if (height > room) {
          this.list.style.maxHeight = `${Math.max(90, room - (height - this.list.offsetHeight))}px`;
        }
        const shown = this.node.offsetHeight;
        const y = onBelow ? coords.bottom + 4 : coords.top - shown - 4;
        const left = Math.min(coords.left, window.innerWidth - this.node.offsetWidth - 8);
        this.node.style.left = `${Math.max(0, left) + window.scrollX}px`;
        this.node.style.top = `${y + window.scrollY}px`;
        this.list.scrollTop = scrolled;
      },
    });
  }

  remove(): void {
    document.removeEventListener("scroll", this.onScroll, true);
    this.placed = null;
    this.node.remove();
  }
}
