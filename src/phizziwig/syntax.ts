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

/**
 * A line of a quote: its markers and its text. Each level of a nested quote
 * has a ">", with a space or not ("> > text", ">> text"), as Phorge takes one
 * ">" and its space off per level; the ">>!" of a reply's header ("In T1,
 * @alice wrote:") is one level.
 */
export const QUOTE_LINE = /^((?:>(?!>!) ?)*(?:>>! ?)?)(.*)$/;

/** The markers of a quote line alone (QUOTE_LINE). */
export const QUOTE_MARKERS = /^(?:>(?!>!) ?)*(?:>>! ?)?/;

/** How deeply a line is quoted, by its markers (QUOTE_LINE). */
export function quoteDepth(markers: string): number {
  return (markers.match(/>/g)?.length ?? 0) - (markers.includes(">>!") ? 1 : 0);
}

/** The markers of a line with text at a depth, as Phorge quotes: ">> text". */
export function quoteMarkers(depth: number): string {
  return `${">".repeat(depth)} `;
}

/**
 * The markers of a quote line written as Phorge quotes: the ">" of all levels
 * together and a space before the text (">> text", not "> >text"), only ">"
 * on a blank line. Only the space after each ">" counts as a marker, so
 * deliberate indentation of the text stays. A blank line keeps its space at
 * the end if `keepSpace` (the cursor's: "> " is where the text will be typed).
 */
export function tidyQuoteMarkers(markers: string, text: string, keepSpace: boolean): string {
  const depth = quoteDepth(markers);
  const levels = markers.includes(">>!") ? `${">".repeat(depth - 1)}>>!` : ">".repeat(depth);
  return levels + (text || (keepSpace && markers.endsWith(" ")) ? " " : "");
}

/** The markers of a quote line one level less deep: without the innermost level, with the space before the text. */
export function outerQuote(markers: string): string {
  const outer = markers.replace(/(?:>>!|>) ?$/, "");
  return outer && markers.endsWith(" ") ? outer.replace(/ ?$/, " ") : outer;
}

export const NOTE_WORDS = ["NOTE", "IMPORTANT", "WARNING"] as const;

/** The start of a note: "NOTE: " or "(NOTE) ". */
export const NOTE_PREFIX = /^(?:\((NOTE|IMPORTANT|WARNING)\)|(NOTE|IMPORTANT|WARNING):)\s*/;

export interface InlineFormat {
  name: string;
  marker: string;
  placeholder: string;
  /** The Font Awesome icon of the toolbar button. */
  icon: string;
  /** Keyboard shortcut, as CodeMirror names keys ("Mod-Shift-x"). */
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
