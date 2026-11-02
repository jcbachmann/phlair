// A context menu for embedded images: size, layout, text flow and alt text,
// without knowing the "{F123, size=full, layout=right}" syntax. It uses the
// markup of Phorge's dropdown menus, so it looks like them.

import { type EditorView, ViewPlugin } from "@codemirror/view";
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
  // Rendered blocks sit at the start of their block, image previews at its end.
  const pos = view.posAtDOM(widget);
  const { blocks } = view.state.field(previewField);
  const block = blocks.find((b) => b.from === pos) ?? blocks.find((b) => !b.empty && b.contentTo === pos);
  if (!block) {
    return null;
  }
  // The n-th image of the file in the block is its n-th embed in the text.
  const index = Array.from(widget.querySelectorAll(`[data-rme-file="${monogram}"]`)).indexOf(image);
  const text = view.state.doc.sliceString(block.from, block.contentTo);
  const embed = findEmbeds(text).filter((e) => e.monogram === monogram)[index];
  return embed ? { embed, offset: block.from } : null;
}

function items(view: EditorView, image: HTMLAnchorElement, embed: Embed, offset: number): DropdownItem[] {
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
    { label: "Open image", icon: "fa-external-link", run: () => window.open(image.href, "_blank", "noopener") },
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

/** Opens the image menu on right click on an image in the editor, or a long press on touch screens. */
export const imageMenu = ViewPlugin.define((view) => {
  const open = (target: EventTarget | null, x: number, y: number): boolean => {
    const image = (target as Element | null)?.closest<HTMLAnchorElement>("a[data-rme-file]");
    const found = image && embedOf(view, image);
    if (!image || !found) {
      return false;
    }
    showDropdown(x, y, items(view, image, found.embed, found.offset), "rme-image-menu");
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
  view.dom.addEventListener("contextmenu", onContextMenu);
  view.dom.addEventListener("touchstart", onTouchStart, { passive: true });
  view.dom.addEventListener("touchmove", cancel, { passive: true });
  view.dom.addEventListener("touchend", cancel);
  return {
    update(update) {
      // The menu acts on the text it was opened for.
      if (update.docChanged) {
        closeDropdown();
      }
    },
    destroy() {
      cancel();
      view.dom.removeEventListener("contextmenu", onContextMenu);
      view.dom.removeEventListener("touchstart", onTouchStart);
      view.dom.removeEventListener("touchmove", cancel);
      view.dom.removeEventListener("touchend", cancel);
      closeDropdown();
    },
  };
});
