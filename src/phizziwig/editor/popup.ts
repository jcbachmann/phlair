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

/** A box on the screen, as from getBoundingClientRect(). */
export interface Box {
  left: number;
  top: number;
  bottom: number;
}

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
      if (event.target !== this.echo) {
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

  optionId(index: number): string {
    return `${this.listId}-${index}`;
  }

  /**
   * Places the popup below a position or an element of the text, or a box
   * measured before; layout is read in CodeMirror's measure phase.
   */
  placeAt(view: EditorView, at: number | HTMLElement | Box): void {
    view.requestMeasure({
      key: this,
      read: () =>
        typeof at === "number" ? view.coordsAtPos(at) : at instanceof HTMLElement ? at.getBoundingClientRect() : at,
      write: (coords) => {
        if (!coords) {
          return;
        }
        // Below the text, or above it where there is more room; a list that
        // fits on neither side scrolls.
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
      },
    });
  }

  remove(): void {
    this.node.remove();
  }
}
