// A context menu for embedded images: size, layout, text flow and alt text,
// without knowing the "{F123, size=full, layout=right}" syntax. It uses the
// markup of Phorge's dropdown menus, so it looks like them.

import { type EditorView, keymap, ViewPlugin } from "@codemirror/view";
import { type Embed, findEmbeds, formatEmbed, getOption, setOption } from "../embed";
import { closeDropdown, DIVIDER, type DropdownItem, showDropdown } from "../../dropdown";
import { previewField } from "./livePreview";

/** Finds the embed in the text that an image of a rendered block shows. */
function embedOf(view: EditorView, image: Element): { embed: Embed; offset: number } | null {
  const monogram = image.getAttribute("data-rme-file");
  const widget = image.closest<HTMLElement>(".rme-block");
  if (!monogram || !widget) {
    return null;
  }
  // Rendered blocks sit at the start of their block, image previews in it or at its ends.
  const pos = view.posAtDOM(widget);
  const { blocks } = view.state.field(previewField);
  const block = blocks.find((b) => !b.empty && pos >= b.from && pos <= b.contentTo);
  if (!block) {
    return null;
  }
  // The n-th image of the file in the widget is its n-th embed in the text
  // from the first embed the widget shows (see ImagePreview.firstEmbed).
  const index = Array.from(widget.querySelectorAll(`[data-rme-file="${monogram}"]`)).indexOf(image);
  const first = Number(widget.dataset.rmeFirstEmbed ?? 0);
  const text = view.state.doc.sliceString(block.from, block.contentTo);
  const embed = findEmbeds(text)
    .slice(first)
    .filter((e) => e.monogram === monogram)[index];
  return embed ? { embed, offset: block.from } : null;
}

/** The items of the menu; `href` is the image's. */
function items(view: EditorView, href: string, embed: Embed, offset: number): DropdownItem[] {
  const replace = (changed: Embed | null) => {
    view.dispatch({
      changes: { from: offset + embed.from, to: offset + embed.to, insert: changed ? formatEmbed(changed) : "" },
      userEvent: "input.image",
    });
  };
  const size = getOption(embed, "size");
  const layout = getOption(embed, "layout") ?? "left";
  const float = getOption(embed, "float") !== undefined;
  const choice = (label: string, selected: boolean, change: () => Embed): DropdownItem => ({
    label,
    icon: selected ? "fa-check-circle" : "fa-circle-thin",
    selected,
    run: () => replace(change()),
  });
  return [
    { label: "Size", heading: true },
    choice("Thumbnail", !size || size === "thumb", () => setOption(embed, "size", null)),
    choice("Full size", size === "full", () => setOption(embed, "size", "full")),
    choice("Full width", size === "wide", () => setOption(embed, "size", "wide")),
    { label: "Layout", heading: true },
    choice("Left", layout === "left", () => setOption(embed, "layout", null)),
    choice("Center", layout === "center", () => setOption(setOption(embed, "layout", "center"), "float", null)),
    choice("Right", layout === "right", () => setOption(embed, "layout", "right")),
    choice("In the text line", layout === "inline", () =>
      setOption(setOption(embed, "layout", "inline"), "float", null),
    ),
    choice("Link to the file", layout === "link", () => setOption(setOption(embed, "layout", "link"), "float", null)),
    DIVIDER,
    {
      label: "Text flows around the image",
      icon: float ? "fa-check-square-o" : "fa-square-o",
      selected: float,
      disabled: layout !== "left" && layout !== "right",
      run: () => replace(setOption(embed, "float", float ? null : true)),
    },
    {
      label: "Alternative text…",
      icon: "fa-font",
      run: () => {
        const alt = getOption(embed, "alt");
        const text = window.prompt("Text that describes the image:", typeof alt === "string" ? alt : "");
        if (text !== null) {
          replace(setOption(embed, "alt", text.trim() || null));
        }
      },
    },
    DIVIDER,
    { label: "Open image", icon: "fa-external-link", run: () => window.open(href, "_blank", "noopener") },
    {
      label: "Edit as text",
      icon: "fa-pencil",
      run: () => {
        view.dispatch({ selection: { anchor: offset + embed.to } });
        view.focus();
      },
    },
    { label: "Remove image", icon: "fa-trash-o", run: () => replace(null) },
  ];
}

/**
 * Opens the image menu on right click on an image in the editor, a long press
 * on touch screens, or the "⋯" button shown on the image under the mouse.
 */
export const imageMenu = ViewPlugin.define((view) => {
  const open = (target: EventTarget | null, x: number, y: number): boolean => {
    const image = (target as Element | null)?.closest<HTMLAnchorElement>("a[data-rme-file]");
    const found = image && embedOf(view, image);
    if (!image || !found) {
      return false;
    }
    showDropdown(x, y, items(view, image.href, found.embed, found.offset), "rme-image-menu");
    return true;
  };
  const onContextMenu = (event: MouseEvent) => {
    if (open(event.target, event.clientX, event.clientY)) {
      event.preventDefault();
    }
  };
  // Safari on iOS has no "contextmenu" for a long press.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onTouchStart = (event: TouchEvent) => {
    const touch = event.touches[0];
    clearTimeout(timer);
    if (event.touches.length === 1) {
      timer = setTimeout(() => open(event.target, touch.clientX, touch.clientY), 550);
    }
  };
  const cancel = () => clearTimeout(timer);
  // The button, in the scroller, which scrolls with the images.
  const more = document.createElement("button");
  more.type = "button";
  more.className = "rme-image-more";
  more.textContent = "⋯";
  more.title = "Image options (right click, or Shift+F10 on its reference)";
  more.setAttribute("aria-label", "Image options");
  // The keyboard has Shift+F10.
  more.tabIndex = -1;
  more.hidden = true;
  let shownFor: HTMLAnchorElement | null = null;
  more.addEventListener("mousedown", (event) => event.preventDefault());
  more.addEventListener("click", (event) => {
    event.preventDefault();
    const rect = more.getBoundingClientRect();
    if (shownFor) {
      open(shownFor, rect.left, rect.bottom);
    }
  });
  view.scrollDOM.append(more);
  const hideMore = () => {
    more.hidden = true;
    shownFor = null;
  };
  const onMouseOver = (event: MouseEvent) => {
    const image = (event.target as Element).closest?.<HTMLAnchorElement>("a[data-rme-file]");
    if (!image || image === shownFor) {
      return;
    }
    const box = image.getBoundingClientRect();
    const scroller = view.scrollDOM.getBoundingClientRect();
    more.hidden = false;
    more.style.left = `${box.right - scroller.left + view.scrollDOM.scrollLeft - more.offsetWidth - 4}px`;
    more.style.top = `${box.top - scroller.top + view.scrollDOM.scrollTop + 4}px`;
    shownFor = image;
  };
  const onMouseOut = (event: MouseEvent) => {
    const to = event.relatedTarget as Node | null;
    if (shownFor && !(to && (shownFor.contains(to) || more.contains(to)))) {
      hideMore();
    }
  };
  view.dom.addEventListener("contextmenu", onContextMenu);
  view.dom.addEventListener("touchstart", onTouchStart, { passive: true });
  view.dom.addEventListener("touchmove", cancel, { passive: true });
  view.dom.addEventListener("touchend", cancel);
  view.dom.addEventListener("mouseover", onMouseOver);
  view.dom.addEventListener("mouseout", onMouseOut);
  return {
    update(update) {
      // The menu acts on the text it was opened for.
      if (update.docChanged) {
        closeDropdown();
      }
      if (update.docChanged || update.viewportChanged || update.geometryChanged) {
        hideMore();
      }
    },
    destroy() {
      cancel();
      view.dom.removeEventListener("contextmenu", onContextMenu);
      view.dom.removeEventListener("touchstart", onTouchStart);
      view.dom.removeEventListener("touchmove", cancel);
      view.dom.removeEventListener("touchend", cancel);
      view.dom.removeEventListener("mouseover", onMouseOver);
      view.dom.removeEventListener("mouseout", onMouseOut);
      more.remove();
      closeDropdown();
    },
  };
});

/** Shift+F10 or the menu key with the cursor on an image's reference, e.g. in "{F12, size=full}": its menu. */
function openAtCursor(view: EditorView): boolean {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  const embed = findEmbeds(line.text).find((e) => e.from <= head - line.from && head - line.from <= e.to);
  const coords = embed && view.coordsAtPos(head);
  if (!embed || !coords) {
    return false;
  }
  // The file's page, from where its image opens.
  showDropdown(coords.left, coords.bottom, items(view, `/${embed.monogram}`, embed, line.from), "rme-image-menu");
  return true;
}

export const imageMenuKeys = keymap.of([
  { key: "Shift-F10", run: openAtCursor },
  { key: "ContextMenu", run: openAtCursor },
]);
