// What the editor can do, with keyboard shortcuts: one list for the
// shortcuts, the "/" insert menu, the shortcut overview and the tooltips.

import { Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { keyLabel, matchesKey } from "../keys";
import { nativeButton } from "../phorge";
import { INLINE_FORMATS } from "../syntax";
import { buttonIcon } from "../toolbar";
import { addTooltip } from "../tooltip";
import { insertTable } from "./commands";
import { DIVIDER, type DropdownItem, showDropdown } from "../../dropdown";
import {
  cycleHeader,
  cycleNote,
  insertAnchor,
  inlineFormat,
  insertCodeBlock,
  insertRule,
  setHeading,
  setNote,
  toggleChecklist,
  toggleList,
  toggleQuote,
} from "./formatting";
import { hostTextarea } from "./host";
import { editLink, insertReference } from "./links";
import {
  insertAsciiArt,
  insertCard,
  insertIcon,
  insertKeys,
  insertLiteral,
  insertMacro,
  insertNavigation,
} from "./inserts";

/** The groups of the insert menu, in their order. */
export const GROUPS = ["Headings", "Lists", "Blocks", "Links", "Text", "Images", "ASCII art"];

export interface Action {
  label: string;
  icon: string;
  run: (view: EditorView) => boolean;
  /** Keyboard shortcut, see matchesKey(). */
  key?: string;
  /** In the "/" insert menu, with these extra words to find it by. */
  insert?: string;
  /** Its group in the insert menu, see GROUPS. */
  group?: string;
  /** Fits in a table cell: in its insert menu and shortcuts. */
  inline?: boolean;
}

/** Clicks one of Phorge's toolbar buttons, e.g. its upload button. */
function clickNative(icon: string) {
  return (view: EditorView): boolean => {
    const textarea = view.state.facet(hostTextarea);
    const button = textarea && nativeButton(textarea, icon);
    button?.click();
    return !!button;
  };
}

export const ACTIONS: Action[] = [
  ...INLINE_FORMATS.map((f) => ({ label: f.name, icon: f.icon, key: f.key, run: inlineFormat(f.icon), inline: true })),
  { label: "Link", group: "Links", icon: "fa-link", key: "Mod-k", run: editLink, insert: "url", inline: true },
  {
    label: "Reference a task, page, person…",
    group: "Links",
    icon: "fa-anchor",
    key: "Mod-Shift-k",
    run: insertReference,
    insert: "object wiki project user revision",
    inline: true,
  },
  {
    label: "Task or revision card",
    group: "Links",
    icon: "fa-id-card-o",
    run: insertCard,
    insert: "embed",
    inline: true,
  },
  { label: "Heading", group: "Headings", icon: "fa-header", run: cycleHeader, insert: "title section" },
  ...[1, 2, 3, 4, 5].map((level) => ({
    label: `Heading ${level}`,
    group: "Headings",
    icon: "fa-header",
    key: `Mod-Shift-${level}`,
    run: setHeading(level),
    // The first levels in the insert menu, as "/h1".
    ...(level <= 3 ? { insert: `h${level}` } : {}),
  })),
  {
    label: "Bulleted list",
    group: "Lists",
    icon: "fa-list-ul",
    key: "Mod-Shift-8",
    run: toggleList("-"),
    insert: "bullet",
  },
  {
    label: "Numbered list",
    group: "Lists",
    icon: "fa-list-ol",
    key: "Mod-Shift-7",
    run: toggleList("#"),
    insert: "ordered",
  },
  {
    label: "Checklist",
    group: "Lists",
    icon: "fa-check-square-o",
    key: "Mod-Shift-9",
    run: toggleChecklist,
    insert: "todo task",
  },
  { label: "Quote", group: "Blocks", icon: "fa-quote-right", run: toggleQuote, insert: "" },
  { label: "Note box", group: "Blocks", icon: "fa-sticky-note-o", run: cycleNote, insert: "callout" },
  {
    label: "Important box",
    group: "Blocks",
    icon: "fa-exclamation-circle",
    run: setNote("IMPORTANT"),
    insert: "note callout",
  },
  {
    label: "Warning box",
    group: "Blocks",
    icon: "fa-exclamation-triangle",
    run: setNote("WARNING"),
    insert: "note callout",
  },
  { label: "Code block", group: "Blocks", icon: "fa-code", run: insertCodeBlock, insert: "" },
  { label: "Table", group: "Blocks", icon: "fa-table", run: (view) => insertTable(view, 3, 2), insert: "" },
  { label: "Horizontal line", group: "Blocks", icon: "fa-minus", run: insertRule, insert: "rule divider" },
  { label: "Anchor", group: "Links", icon: "fa-hashtag", run: insertAnchor, insert: "link target jump", inline: true },
  { label: "Icon", group: "Text", icon: "fa-flag", run: insertIcon, insert: "symbol color", inline: true },
  {
    label: "Keyboard keys",
    group: "Text",
    icon: "fa-keyboard-o",
    run: insertKeys,
    insert: "shortcut kbd",
    inline: true,
  },
  {
    label: "Navigation path",
    group: "Text",
    icon: "fa-chevron-right",
    run: insertNavigation,
    insert: "nav menu breadcrumb",
    inline: true,
  },
  {
    label: "Literal text",
    group: "Text",
    icon: "fa-i-cursor",
    run: insertLiteral,
    insert: "verbatim raw %%%",
    inline: true,
  },
  {
    label: "Image or file",
    group: "Images",
    icon: "fa-cloud-upload",
    run: clickNative("fa-cloud-upload"),
    insert: "upload picture",
    inline: true,
  },
  {
    label: "Image macro",
    group: "Images",
    icon: "fa-picture-o",
    run: insertMacro,
    insert: "gif animation fun",
    inline: true,
  },
  {
    label: "Cow says… (ASCII art)",
    group: "ASCII art",
    icon: "fa-comment-o",
    run: insertAsciiArt("cowsay"),
    insert: "cowsay ascii art fun",
  },
  {
    label: "Big letters (ASCII art)",
    group: "ASCII art",
    icon: "fa-font",
    run: insertAsciiArt("figlet"),
    insert: "figlet ascii art banner fun",
  },
  {
    label: "Meme",
    group: "Images",
    icon: "fa-meh-o",
    run: clickNative("fa-meh-o"),
    insert: "caption joke",
    inline: true,
  },
  {
    label: "Mention someone",
    group: "Links",
    icon: "fa-user",
    run: (view) => {
      view.dispatch(view.state.replaceSelection("@"), { userEvent: "input.type" });
      return true;
    },
    insert: "user person",
    inline: true,
  },
  {
    label: "Emoji",
    group: "Text",
    icon: "fa-smile-o",
    run: (view) => {
      view.dispatch(view.state.replaceSelection(":"), { userEvent: "input.type" });
      return true;
    },
    insert: "smiley",
    inline: true,
  },
];

/** Other keys of the editor, for the overview. */
const OTHER_KEYS: [string, string][] = [
  ["Tab / Shift+Tab", "Indent a list item, next or previous table cell"],
  ["Alt+↑ / Alt+↓", "Move a table row"],
  ["Alt+Shift+← / →", "Move a table column"],
  ["/", "At the start of a line or after a space: insert menu"],
  ["@  #  [[  :", "Find people, projects, pages, emoji"],
  [keyLabel("Mod-Enter"), "Submit"],
  ["Ctrl+click", "Open a link"],
  ["Right click", "Change an image"],
];

export function showShortcuts(view: EditorView, right?: number, top?: number): boolean {
  const items: DropdownItem[] = [{ label: "Keyboard shortcuts", heading: true }];
  for (const action of ACTIONS) {
    if (action.key) {
      items.push({ label: action.label, icon: action.icon, detail: keyLabel(action.key), run: () => action.run(view) });
    }
  }
  items.push(DIVIDER);
  for (const [key, label] of OTHER_KEYS) {
    items.push({ label, icon: "fa-keyboard-o", detail: key, disabled: true });
  }
  const rect = view.dom.getBoundingClientRect();
  // Right-aligned to the point.
  showDropdown(right ?? rect.right, top ?? rect.top + 8, items, "rme-shortcuts", true);
  return true;
}

/**
 * Keys of the shortcut overview: F1 on every keyboard; Ctrl+/ where "/" needs
 * no Shift (on German keyboards Ctrl+Shift+7 is the numbered list).
 */
export const OVERVIEW_KEYS = ["F1", "Mod-/"];

/** The shortcuts of actions. Digits by their key, so they work in every layout. */
function shortcutsOf(actions: Action[], overview: boolean) {
  return Prec.highest(
    EditorView.domEventHandlers({
      keydown(event, view) {
        for (const action of actions) {
          if (action.key && matchesKey(event, action.key) && action.run(view)) {
            event.preventDefault();
            return true;
          }
        }
        if (overview && OVERVIEW_KEYS.some((key) => matchesKey(event, key))) {
          event.preventDefault();
          return showShortcuts(view);
        }
        return false;
      },
    }),
  );
}

export const shortcuts = shortcutsOf(ACTIONS, true);

/** In a table cell's editor: the shortcuts of what fits in a cell (formatting, links, references). */
export const cellShortcuts = shortcutsOf(
  ACTIONS.filter((a) => a.inline),
  false,
);

/** Shortcuts by the icon of their toolbar button. */
export const SHORTCUTS_BY_ICON: Record<string, string> = {};
for (const action of ACTIONS) {
  if (action.key) {
    // Several keys for one button, like the heading levels: "Ctrl+Shift+1–5".
    const known = SHORTCUTS_BY_ICON[action.icon];
    SHORTCUTS_BY_ICON[action.icon] = known
      ? `${known.split("–")[0]}–${action.key.split("-").pop()}`
      : keyLabel(action.key);
  }
}

/**
 * Names the shortcuts in the tooltips of Phorge's own buttons while the
 * editor is on. Returns a function that restores them.
 */
export function nativeTooltips(bar: Element): () => void {
  const restore: (() => void)[] = [];
  bar.querySelectorAll<HTMLElement>(".remarkup-assist-button:not(.rme-own):not(.rme-format)").forEach((button) => {
    const icon = buttonIcon(button);
    const shortcut = icon && SHORTCUTS_BY_ICON[icon];
    // Phorge's buttons name themselves in hidden text.
    const label = button.querySelector(".aural-only")?.textContent?.trim();
    const sigil = button.getAttribute("data-sigil");
    if (!shortcut || !label) {
      return;
    }
    // Phorge's tooltip comes from the "has-tooltip" sigil; show ours instead.
    button.setAttribute("data-sigil", (sigil ?? "").replace(/\bhas-tooltip\b/, "").trim());
    const remove = addTooltip(button, `${label} (${shortcut})`);
    restore.push(() => {
      remove();
      button.removeAttribute("aria-label");
      if (sigil !== null) {
        button.setAttribute("data-sigil", sigil);
      }
    });
  });
  return () => restore.forEach((r) => r());
}
