// Remarkup syntax used for styling and editing the source. The block
// structure itself comes from src/blocks.ts, which follows the server exactly.

/** Blocks whose text is literal: no markup, conversions or menus in them. */
export const LITERAL_BLOCKS = new Set(["code", "literal", "interpreter"]);

/** Whether text ends inside monospaced text: after an open "`" or "##". */
export function inMonospace(before: string): boolean {
  return (before.match(/`/g)?.length ?? 0) % 2 === 1 || (before.match(/##/g)?.length ?? 0) % 2 === 1;
}

/**
 * A list item: indentation, marker, space, an optional checkbox and the text.
 * A checkbox alone is a list item too ("[ ] item", like Phorge): its marker
 * and space are empty.
 */
export const LIST_ITEM = /^(\s*)((?:[-*]+|#+|\d+[.)])(?=\s)|(?=\[[ xX]?\]\s))(\s*)(\[[ xX]?\]\s+)?(.*)$/;

/** A checklist item marker, e.g. "- [ ] " or "  * [X] ". */
export const CHECKBOX = /^(\s*)[-*] \[[ xX]?\]\s?/;

/** A line of a quote. */
export const QUOTE_LINE = /^(>+ ?)(.*)$/;

export const NOTE_WORDS = ["NOTE", "IMPORTANT", "WARNING"] as const;

/** The start of a note: "NOTE: " or "(NOTE) ". */
export const NOTE_PREFIX = /^(?:\((NOTE|IMPORTANT|WARNING)\)|(NOTE|IMPORTANT|WARNING):)\s*/;

export interface InlineFormat {
  name: string;
  marker: string;
  placeholder: string;
  /** The Font Awesome icon of the toolbar button. */
  icon: string;
  /** Keyboard shortcut, see matchesKey(). */
  key: string;
}

/** Formatting that wraps text in a marker, like "**bold**". */
export const INLINE_FORMATS: InlineFormat[] = [
  { name: "Bold", marker: "**", placeholder: "bold text", icon: "fa-bold", key: "Mod-b" },
  { name: "Italic", marker: "//", placeholder: "italic text", icon: "fa-italic", key: "Mod-i" },
  { name: "Monospaced", marker: "`", placeholder: "monospaced text", icon: "fa-text-width", key: "Mod-e" },
  { name: "Strikethrough", marker: "~~", placeholder: "deleted text", icon: "fa-strikethrough", key: "Mod-Shift-x" },
  { name: "Underline", marker: "__", placeholder: "underlined text", icon: "fa-underline", key: "Mod-u" },
  { name: "Highlight", marker: "!!", placeholder: "highlighted text", icon: "fa-paint-brush", key: "Mod-Shift-h" },
];
