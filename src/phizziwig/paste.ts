// Converts pasted rich content (clipboard HTML from web pages, Word,
// LibreOffice, Google Docs, Confluence, spreadsheets, and spreadsheet TSV)
// into remarkup, so headings, lists, tables and formatting survive a paste.
//
// Decisions:
// - Headings keep the level Phorge renders: "=" renders <h2>, "==" <h3>
//   and so on, so h2–h6 map to "=" … "=====". h1 also maps to "=" because the
//   page title is the only <h1> in Phorge.
// - List items are indented by two spaces, like Phorge's buttons write
//   them: "# item" at the start of a line is a header.
// - Remarkup has no escape character, so text that looks like remarkup (a line
//   starting with "- ", "T123", "**") is not escaped: in pasted text it is
//   almost always meant that way (typed bullets, task references). Only "|" in
//   table cells is replaced by "¦", because it would split the cell.
// - Whitespace collapses like in a browser except in <pre>; nbsp is a space.
// - Only inline elements highlight with a background colour, and only with a
//   light, saturated one: browsers copy page and table backgrounds into the
//   HTML, and those are not highlights.

import { formatTable, type TableRow } from "./table";
import { parseHtml } from "./html";

interface Style {
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  highlight: boolean;
  code: boolean;
}

type Mark = keyof Style;

/** In nesting order: code is innermost because monospace text is literal. */
const MARKS: [Mark, string][] = [
  ["bold", "**"],
  ["italic", "//"],
  ["underline", "__"],
  ["strike", "~~"],
  ["highlight", "!!"],
  ["code", "`"],
];

const PLAIN: Style = { bold: false, italic: false, underline: false, strike: false, highlight: false, code: false };
const BOLD: Style = { ...PLAIN, bold: true };

/** Text with a style; `raw` text is remarkup markup (a link) emitted as is. */
interface TextRun {
  text: string;
  style: Style;
  raw?: boolean;
}

type Run = TextRun | { lineBreak: true };

const LINE_BREAK: Run = { lineBreak: true };

const TAG_MARKS: Record<string, Mark> = {
  b: "bold",
  strong: "bold",
  i: "italic",
  em: "italic",
  u: "underline",
  ins: "underline",
  s: "strike",
  del: "strike",
  strike: "strike",
  mark: "highlight",
  code: "code",
  kbd: "code",
  tt: "code",
  samp: "code",
};

/** Elements without visible text (head content, scripts, Word's <xml> data). */
const SKIP = new Set([
  "head",
  "iframe",
  "link",
  "meta",
  "noscript",
  "object",
  "script",
  "select",
  "style",
  "svg",
  "template",
  "textarea",
  "title",
  "xml",
]);

const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "center",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "ul",
]);

const BLOCK_SELECTOR = [...BLOCK].join(",");

/** "=" renders <h2>; h1 is the page title, so it gets the largest one too. */
const HEADING_LEVEL: Record<string, number> = { h1: 1, h2: 1, h3: 2, h4: 3, h5: 4, h6: 5 };

/**
 * What an image becomes: remarkup for it (e.g. a placeholder for its upload),
 * or null for its description only.
 */
export type ImageMarkup = (src: string, alt: string, img: Element) => string | null;

let imageMarkup: ImageMarkup = () => null;

/** Converts clipboard HTML into remarkup; images become their description, or what `images` makes of them. */
export function htmlToRemarkup(html: string, images: ImageMarkup = () => null): string {
  const out: string[] = [];
  imageMarkup = images;
  try {
    convertBlocks(parseHtml(html), PLAIN, out);
  } finally {
    imageMarkup = () => null;
  }
  return out.join("\n\n");
}

/**
 * Whether pasting the HTML gives something better than pasting the plain text.
 * It does not when the conversion equals the text (a plain run of text), or
 * when the HTML is code from a code editor or a <pre>: there the plain text is
 * exact and may be pasted into a code block.
 */
export function shouldConvertHtml(html: string, text: string): boolean {
  if (!html.trim()) {
    return false;
  }
  const root = parseHtml(html);
  if (root.querySelector(".cm-content, .cm-line, .CodeMirror-code, .monaco-editor") || onlyCode(root, PLAIN, false)) {
    return false;
  }
  const converted = htmlToRemarkup(html);
  return converted !== "" && normalize(converted) !== normalize(text);
}

/**
 * Converts spreadsheet cells copied as text (tab-separated, as Excel, Calc and
 * Google Sheets put them on the clipboard) into a remarkup table with the first
 * row as header, or returns null if the text does not look like cells.
 */
export function tsvToRemarkup(text: string): string | null {
  const rows = parseTsv(text.replace(/\r\n?/g, "\n").replace(/\n$/, ""));
  // The number of columns up to the last non-empty cell of any row.
  const width = Math.max(...rows.map((row) => row.map((cell) => cell.trim() !== "").lastIndexOf(true) + 1));
  // Spreadsheets write every cell of a row, so a shorter row (a line of
  // prose, an empty line) means this is not a range of cells. A leading tab on
  // every line is indented text.
  if (width < 2 || rows.some((row) => row.length < width) || rows.every((row) => row[0].trim() === "")) {
    return null;
  }
  const result: TableRow[] = rows.map((row) => ({
    cells: row.slice(0, width).map((cell) => cell.replace(/\s+/g, " ").trim().replaceAll("|", "¦")),
    separator: false,
  }));
  // A table of only a header row looks odd; one row stays a plain row.
  if (result.length > 1) {
    result.splice(1, 0, { cells: new Array(width).fill("---"), separator: true });
  }
  return formatTable({ indent: "", rows: result, trailingPipe: true }).text;
}

function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .trim();
}

function isElement(node: Node): node is Element {
  return node.nodeType === Node.ELEMENT_NODE;
}

function isText(node: Node): node is Text {
  return node.nodeType === Node.TEXT_NODE;
}

/** The declarations of the style attribute, lower case, the last one winning. */
function cssOf(el: Element): Map<string, string> {
  // Parsed by hand instead of el.style: the CSSOM drops Word's mso-* properties.
  const css = new Map<string, string>();
  for (const declaration of (el.getAttribute("style") ?? "").split(";")) {
    const colon = declaration.indexOf(":");
    const key = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration
      .slice(colon + 1)
      .replace(/!important/i, "")
      .trim()
      .toLowerCase();
    if (colon > 0 && value) {
      css.set(key, value);
    }
  }
  return css;
}

function isSkipped(el: Element): boolean {
  if (SKIP.has(el.localName) || el.hasAttribute("hidden")) {
    return true;
  }
  const css = cssOf(el);
  return (
    css.get("display") === "none" ||
    css.get("visibility") === "hidden" ||
    css.get("mso-hide") === "all" ||
    // The bullet or number Word writes before a list paragraph.
    css.get("mso-list") === "ignore"
  );
}

/** The style of an element's content: tags first, then its inline style. */
function styleOf(el: Element, parent: Style): Style {
  const style = { ...parent };
  const tag = el.localName;
  const mark = TAG_MARKS[tag];
  if (mark) {
    style[mark] = true;
  }
  if (tag === "th" || tag in HEADING_LEVEL) {
    style.bold = true;
  }
  const css = cssOf(el);
  // Google Docs wraps everything in <b style="font-weight:normal">, so the
  // inline style must be able to turn bold off again.
  const weight = css.get("font-weight");
  if (weight === "bold" || weight === "bolder") {
    style.bold = true;
  } else if (weight === "normal" || weight === "lighter") {
    style.bold = false;
  } else if (weight && /^\d+$/.test(weight)) {
    style.bold = Number(weight) >= 600;
  }
  const fontStyle = css.get("font-style");
  if (fontStyle) {
    style.italic = fontStyle.startsWith("italic") || fontStyle.startsWith("oblique");
  }
  // Text decorations cannot be removed by descendants, so they only add. A
  // link's underline is how links look, not formatting.
  const decoration = `${css.get("text-decoration") ?? ""} ${css.get("text-decoration-line") ?? ""}`;
  if (decoration.includes("underline") && tag !== "a") {
    style.underline = true;
  }
  if (decoration.includes("line-through")) {
    style.strike = true;
  }
  const family = css.get("font-family") ?? (tag === "font" ? el.getAttribute("face") : null);
  if (family) {
    style.code = isMonospace(family);
  }
  const msoHighlight = css.get("mso-highlight");
  const background = css.get("background-color") ?? css.get("background");
  if (msoHighlight) {
    style.highlight = msoHighlight !== "none";
  } else if (background && !BLOCK.has(tag) && !/^(td|th|tr|tbody|thead|tfoot)$/.test(tag)) {
    const color = parseColor(background);
    // A transparent background shows the one of the parent.
    if (color && color[3] > 0) {
      style.highlight = isHighlighter(color);
    }
  }
  return style;
}

function isMonospace(family: string): boolean {
  // The first family is the one that is used; "monospace" as a fallback at
  // the end of a font stack does not make text monospace.
  const first = family
    .split(",")[0]
    .trim()
    .replace(/^["']|["']$/g, "");
  return /mono|courier|consol|menlo|monaco/i.test(first);
}

const NAMED_COLORS: Record<string, [number, number, number]> = {
  aqua: [0, 255, 255],
  black: [0, 0, 0],
  cyan: [0, 255, 255],
  fuchsia: [255, 0, 255],
  lime: [0, 255, 0],
  magenta: [255, 0, 255],
  orange: [255, 165, 0],
  red: [255, 0, 0],
  white: [255, 255, 255],
  yellow: [255, 255, 0],
};

/** Parses "#rgb", "#rrggbb", "rgb()", "rgba()" and a few names into [r, g, b, a]. */
function parseColor(value: string): [number, number, number, number] | null {
  if (value === "transparent") {
    return [0, 0, 0, 0];
  }
  if (NAMED_COLORS[value]) {
    return [...NAMED_COLORS[value], 1];
  }
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((d) => d + d) : hex[1].match(/../g)!;
    const [r, g, b] = digits.map((d) => parseInt(d, 16));
    return [r, g, b, 1];
  }
  const rgb = /^rgba?\(([^)]*)\)$/.exec(value);
  if (rgb) {
    const [r, g, b, a = "1"] = rgb[1].split(/[\s,/]+/).filter(Boolean);
    const alpha = a.endsWith("%") ? parseFloat(a) / 100 : parseFloat(a);
    return [parseFloat(r), parseFloat(g), parseFloat(b), alpha];
  }
  return null;
}

/** A light, saturated colour, as highlighter pens have; not white, grey or a dark theme. */
function isHighlighter([r, g, b, a]: [number, number, number, number]): boolean {
  // Blend over white so translucent backgrounds count as what they show.
  const shown = [r, g, b].map((c) => c * a + 255 * (1 - a));
  const max = Math.max(...shown);
  return max >= 128 && max - Math.min(...shown) >= 48;
}

function convertBlocks(parent: Node, style: Style, out: string[]): void {
  let runs: Run[] = [];
  let wordList: ListItem[] = [];
  const flushParagraph = () => {
    const text = renderParagraph(runs);
    if (text) {
      out.push(text);
    }
    runs = [];
  };
  const flushWordList = () => {
    if (wordList.length) {
      out.push(renderList(wordList));
    }
    wordList = [];
  };
  for (const child of parent.childNodes) {
    if (isText(child) && !child.data.trim()) {
      runs.push({ text: " ", style });
      continue;
    }
    if (!isText(child) && !isElement(child)) {
      continue; // comments, including Word's conditional comments
    }
    if (isElement(child)) {
      if (isSkipped(child)) {
        continue;
      }
      // Word writes lists as paragraphs with a level in "mso-list".
      const level = wordListLevel(child);
      if (level) {
        flushParagraph();
        wordList.push(wordListItem(child, level - 1, style));
        continue;
      }
    }
    flushWordList();
    if (isElement(child) && (BLOCK.has(child.localName) || child.querySelector(BLOCK_SELECTOR))) {
      flushParagraph();
      convertBlock(child, style, out);
    } else {
      inlineRuns(child, style, runs);
    }
  }
  flushParagraph();
  flushWordList();
}

function convertBlock(el: Element, parentStyle: Style, out: string[]): void {
  const style = styleOf(el, parentStyle);
  const tag = el.localName;
  const push = (text: string) => {
    if (text) {
      out.push(text);
    }
  };
  if (tag in HEADING_LEVEL) {
    const text = renderInline(childRuns(el, style), BOLD);
    const marker = "=".repeat(HEADING_LEVEL[tag]);
    // Without closing "=": easier to edit, and the same heading.
    push(text && `${marker} ${text}`);
  } else if (tag === "ul" || tag === "ol" || tag === "li") {
    const items: ListItem[] = [];
    if (tag === "li") {
      collectItem(el, 0, false, parentStyle, items);
    } else {
      collectList(el, 0, tag === "ol", style, items);
    }
    push(renderList(items));
  } else if (tag === "pre") {
    const text = preText(el)
      .replace(/ /g, " ")
      .replace(/^\n+|\n+$/g, "");
    push(text.trim() && "```\n" + text + "\n```");
  } else if (tag === "blockquote") {
    const inner: string[] = [];
    convertBlocks(el, style, inner);
    const lines = inner.join("\n\n").split("\n");
    push(inner.length ? lines.map((line) => (line ? `> ${line}` : ">")).join("\n") : "");
  } else if (tag === "table") {
    convertTable(el as HTMLTableElement, style, out);
  } else if (tag === "hr") {
    out.push("---");
  } else {
    // Paragraphs, divs, and inline elements that wrap blocks (Google Docs' <b>).
    convertBlocks(el, style, out);
  }
}

/** Collects the runs of inline content; blocks inside it become spaces. */
function inlineRuns(node: Node, style: Style, runs: Run[]): void {
  if (isText(node)) {
    runs.push({ text: node.data.replace(/\s+/g, " "), style });
    return;
  }
  if (!isElement(node) || isSkipped(node)) {
    return;
  }
  const own = styleOf(node, style);
  const tag = node.localName;
  if (tag === "br") {
    runs.push(LINE_BREAK);
    return;
  }
  if (tag === "img") {
    // Hidden images are decoration, like the checkboxes of Google Docs.
    if (node.getAttribute("aria-hidden") === "true") {
      return;
    }
    const alt = node.getAttribute("alt")?.trim() ?? "";
    const markup = imageMarkup(node.getAttribute("src") ?? "", alt, node);
    if (markup) {
      runs.push({ text: markup, style: own, raw: true });
    } else if (alt) {
      runs.push({ text: alt, style: own });
    }
    return;
  }
  if (tag === "a" && (imageLink(node, own, runs) || linkRun(node, own, runs))) {
    return;
  }
  const block = BLOCK.has(tag);
  if (block) {
    runs.push({ text: " ", style });
  }
  for (const child of node.childNodes) {
    inlineRuns(child, own, runs);
  }
  if (block) {
    runs.push({ text: " ", style });
  }
}

function childRuns(el: Element, style: Style): Run[] {
  const runs: Run[] = [];
  for (const child of el.childNodes) {
    inlineRuns(child, style, runs);
  }
  return runs;
}

/**
 * Adds the images of a link that only shows images (Wikipedia links each image
 * to its description page), if they become images. Returns false otherwise,
 * also for images that do not: then the link takes their description.
 */
function imageLink(a: Element, style: Style, runs: Run[]): boolean {
  if (a.textContent?.trim() || !a.querySelector("img")) {
    return false;
  }
  const own: Run[] = [];
  for (const child of a.childNodes) {
    inlineRuns(child, style, own);
  }
  if (!own.some((run) => "raw" in run && run.raw)) {
    return false;
  }
  runs.push(...own);
  return true;
}

/** Adds a link as markup; returns false for links that should stay text. */
function linkRun(a: Element, style: Style, runs: Run[]): boolean {
  const href = (a.getAttribute("href") ?? "").trim();
  // Anchors within the source page (Word's table of contents) lead nowhere here.
  if (!href || href.startsWith("#") || /^(javascript|vbscript|data):/i.test(href)) {
    return false;
  }
  const target = href.replace(/ /g, "%20");
  const text = plainText(a).replace(/\s+/g, " ").trim();
  let markup: string;
  if (text && text !== href) {
    markup = `[[ ${target} | ${text} ]]`;
  } else {
    // Phorge links bare URLs, but formatting markers right next to one
    // could be taken as part of it.
    const marked = MARKS.some(([mark]) => mark !== "code" && style[mark]);
    markup = /^https?:\/\//i.test(target) && !marked ? target : `[[ ${target} ]]`;
  }
  runs.push({ text: markup, style, raw: true });
  return true;
}

function plainText(node: Node): string {
  if (isText(node)) {
    return node.data;
  }
  if (!isElement(node) || isSkipped(node)) {
    return "";
  }
  if (node.localName === "img") {
    return node.getAttribute("alt") ?? "";
  }
  return [...node.childNodes].map(plainText).join(BLOCK.has(node.localName) ? " " : "");
}

function preText(node: Node): string {
  if (isText(node)) {
    return node.data;
  }
  if (!isElement(node) || isSkipped(node)) {
    return "";
  }
  if (node.localName === "br") {
    return "\n";
  }
  return [...node.childNodes].map(preText).join("");
}

/**
 * Renders runs with formatting markers. Markers are only placed around text,
 * never around the spaces at its ends: "~~ x~~" is not strikethrough.
 * `base` holds the formatting the context already shows (headings are bold).
 * `inline` turns line breaks into spaces (list items, cells, headings).
 */
function renderRuns(runs: Run[], base: Style, inline: boolean): string {
  let out = "";
  let open: [Mark, string][] = [];
  let pending = "";
  const close = (keep: number) => {
    out += open
      .slice(keep)
      .reverse()
      .map(([, token]) => token)
      .join("");
    open = open.slice(0, keep);
  };
  for (const run of runs) {
    if ("lineBreak" in run) {
      if (inline) {
        pending += " ";
      } else {
        close(0);
        out += "\n";
        pending = "";
      }
      continue;
    }
    const start = run.text.length - run.text.trimStart().length;
    const end = run.text.trimEnd().length;
    if (start >= end) {
      pending += run.text;
      continue;
    }
    // Monospace would make a link's markup literal.
    const want = MARKS.filter(([mark]) => run.style[mark] && !base[mark] && !(run.raw && mark === "code"));
    // Keep the open markers that are still wanted, as long as nesting allows.
    let keep = 0;
    while (keep < open.length && want.includes(open[keep])) {
      keep++;
    }
    close(keep);
    const opening = want.filter((mark) => !open.includes(mark));
    out += pending + run.text.slice(0, start) + opening.map(([, token]) => token).join("");
    open.push(...opening);
    out += run.text.slice(start, end);
    pending = run.text.slice(end);
  }
  close(0);
  return out + pending;
}

function renderInline(runs: Run[], base: Style): string {
  return renderRuns(runs, base, true).replace(/ {2,}/g, " ").trim();
}

function renderParagraph(runs: Run[]): string {
  const lines: string[] = [];
  for (const raw of renderRuns(runs, PLAIN, false).split("\n")) {
    const line = raw.replace(/ {2,}/g, " ").trim();
    // At most one empty line, as between blocks, and none at the ends.
    if (line || (lines.length && lines[lines.length - 1])) {
      lines.push(line);
    }
  }
  while (lines.length && !lines[lines.length - 1]) {
    lines.pop();
  }
  return lines.join("\n");
}

interface ListItem {
  depth: number;
  ordered: boolean;
  /** The state of a checklist item, or null. */
  checked: boolean | null;
  text: string;
}

function collectList(list: Element, depth: number, ordered: boolean, style: Style, items: ListItem[]): void {
  for (const child of list.children) {
    if (isSkipped(child)) {
      continue;
    }
    const tag = child.localName;
    if (tag === "li") {
      collectItem(child, depth, ordered, style, items);
    } else if (tag === "ul" || tag === "ol") {
      // Google Docs nests lists directly in lists instead of in an item.
      collectList(child, depth + 1, tag === "ol", styleOf(child, style), items);
    } else {
      collectList(child, depth, ordered, styleOf(child, style), items);
    }
  }
}

function collectItem(li: Element, depth: number, ordered: boolean, parentStyle: Style, items: ListItem[]): void {
  const style = styleOf(li, parentStyle);
  const runs: Run[] = [];
  const nested: Element[] = [];
  for (const child of li.childNodes) {
    if (isElement(child) && (child.localName === "ul" || child.localName === "ol")) {
      nested.push(child);
    } else {
      inlineRuns(child, style, runs);
    }
  }
  const text = renderInline(runs, PLAIN);
  if (text) {
    items.push({ depth, ordered, checked: checkboxState(li), text });
  }
  for (const list of nested) {
    collectList(list, text ? depth + 1 : depth, list.localName === "ol", style, items);
  }
}

function checkboxState(li: Element): boolean | null {
  // Google Docs marks checklist items with ARIA, GitHub and others with an input.
  const aria = li.getAttribute("aria-checked");
  if (aria === "true" || aria === "false") {
    return aria === "true";
  }
  const box = li.querySelector("input[type=checkbox]");
  return box && box.closest("li") === li ? box.hasAttribute("checked") : null;
}

function renderList(items: ListItem[]): string {
  return items
    .map((item) => {
      const marker = item.ordered ? "#" : "-";
      const box = item.checked === null ? "" : item.checked ? "[X] " : "[ ] ";
      return `${"  ".repeat(item.depth + 1)}${marker} ${box}${item.text}`;
    })
    .join("\n");
}

/** The level of a Word list paragraph ("mso-list:l0 level2 lfo1"), or 0. */
function wordListLevel(el: Element): number {
  const level = /level(\d+)/.exec(cssOf(el).get("mso-list") ?? "");
  return level ? Number(level[1]) : 0;
}

function wordListItem(p: Element, depth: number, parentStyle: Style): ListItem {
  // Word writes the bullet or number as text in a span that is skipped for the
  // item text; a number like "1.", "a)" or "iv." makes the list ordered.
  const bullet = [...p.querySelectorAll("span")].find((span) => cssOf(span).get("mso-list") === "ignore");
  const label = (bullet?.textContent ?? "").replace(/\s+/g, "");
  const ordered = /^\(?[0-9a-z]+[.)]$/i.test(label);
  const text = renderInline(childRuns(p, styleOf(p, parentStyle)), PLAIN);
  return { depth, ordered, checked: null, text };
}

function convertTable(table: HTMLTableElement, style: Style, out: string[]): void {
  const rows = [...table.rows];
  // Tables of a single column lay out a page (mails, wikis); their content
  // is no table.
  if (rows.every((row) => row.cells.length <= 1)) {
    for (const row of rows) {
      for (const cell of row.cells) {
        convertBlocks(cell, styleOf(cell, style), out);
      }
    }
    return;
  }
  const result: TableRow[] = [];
  for (const row of rows) {
    const cells = [...row.cells].filter((cell) => !isSkipped(cell));
    if (!cells.length) {
      continue;
    }
    const header = row.parentElement?.localName === "thead" || cells.every((cell) => cell.localName === "th");
    const texts: string[] = [];
    for (const cell of cells) {
      texts.push(cellText(cell, style, header));
      // Remarkup has no merged cells; empty ones keep the columns in place.
      for (let i = 1; i < Math.min(cell.colSpan, 100); i++) {
        texts.push("");
      }
    }
    result.push({ cells: texts, separator: false });
    if (header) {
      result.push({ cells: texts.map(() => "---"), separator: true });
    }
  }
  if (result.some((row) => !row.separator && row.cells.some(Boolean))) {
    out.push(formatTable({ indent: "", rows: result, trailingPipe: true }).text);
  }
}

function cellText(cell: HTMLTableCellElement, style: Style, header: boolean): string {
  const runs = childRuns(cell, styleOf(cell, style)).map((run) =>
    // A "|" would end the cell; the one in "[[ link | name ]]" does not.
    "text" in run && !run.raw ? { ...run, text: run.text.replaceAll("|", "¦") } : run,
  );
  return renderInline(runs, header ? BOLD : PLAIN);
}

/** Whether all text is in a <pre> or in monospace (code, code editors). */
function onlyCode(node: Node, style: Style, inPre: boolean): boolean {
  for (const child of node.childNodes) {
    if (isText(child)) {
      if (child.data.trim() && !style.code && !inPre) {
        return false;
      }
    } else if (isElement(child) && !isSkipped(child)) {
      if (!onlyCode(child, styleOf(child, style), inPre || child.localName === "pre")) {
        return false;
      }
    }
  }
  return true;
}

/** Splits tab-separated rows; a cell in double quotes may hold tabs and newlines. */
function parseTsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let i = 0;
  for (;;) {
    const quote = text[i] === '"' ? closingQuote(text, i) : -1;
    let end = quote;
    if (quote >= 0) {
      row.push(text.slice(i + 1, quote).replaceAll('""', '"'));
      end = quote + 1;
    } else {
      end = i;
      while (end < text.length && text[end] !== "\t" && text[end] !== "\n") {
        end++;
      }
      row.push(text.slice(i, end));
    }
    if (end >= text.length) {
      rows.push(row);
      return rows;
    }
    if (text[end] === "\n") {
      rows.push(row);
      row = [];
    }
    i = end + 1;
  }
}

/** The quote ending a quoted cell that starts at `start`, or -1 if the cell is not quoted. */
function closingQuote(text: string, start: number): number {
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] !== '"') {
      continue;
    }
    if (text[i + 1] === '"') {
      i++;
      continue;
    }
    const next = text[i + 1];
    return next === undefined || next === "\t" || next === "\n" ? i : -1;
  }
  return -1;
}

/**
 * Pasted Markdown (e.g. from a README or a chat answer) as remarkup, or null
 * when the text does not look like Markdown: at least two of headings, lists,
 * code fences, emphasis, links, tables and quotes. A shell snippet with one
 * "# comment" stays as it is.
 *
 * Most Markdown is remarkup already (bold, code, lists, quotes, tables,
 * links); converted are headings ("## A" → "== A"), italics ("*a*", "_a_" →
 * "//a//"), "__bold__", fences with a language ("```py" → "```lang=py"),
 * images (as links), "***" rules and table alignment colons. Code is left
 * as it is.
 */
export function markdownToRemarkup(text: string): string | null {
  const signals = [
    /^#{1,6} \S/m,
    /^\s*([-*+]|\d+\.) \S/m,
    /^```/m,
    /(\*\*|__)\S(.*?\S)?\1|(^|[^\w*])\*[^*\s]([^*\n]*[^*\s])?\*(?![*\w])/,
    /\[[^\]\n]+\]\([^)\s]+\)/,
    /^\|?\s*:?-{3,}:?\s*\|/m,
    /^> \S/m,
  ].filter((signal) => signal.test(text)).length;
  if (signals < 2) {
    return null;
  }
  let fenced = false;
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => {
      const fence = /^(\s*)```\s*([\w+-]+)?\s*$/.exec(line);
      if (fence) {
        fenced = !fenced;
        return fenced && fence[2] ? `${fence[1]}\`\`\`lang=${fence[2]}` : line;
      }
      if (fenced) {
        return line;
      }
      const heading = /^(#{1,6})\s+(.*?)(\s+#+)?\s*$/.exec(line);
      if (heading) {
        return `${"=".repeat(Math.min(heading[1].length, 5))} ${inline(heading[2])}`;
      }
      if (/^\s*([*_])(\s*\1){2,}\s*$/.test(line)) {
        return "---";
      }
      if (/^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line)) {
        // Alignment colons: remarkup has no column alignment.
        return line.replace(/:/g, "-");
      }
      return inline(line);
    })
    .join("\n");
}

/** Markdown's inline markup of a line as remarkup; code spans stay as they are. */
function inline(line: string): string {
  return line
    .split(/(`[^`]*`)/)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, url) => (alt ? `[[ ${url} | ${alt} ]]` : url))
            .replace(/(^|[^\w_])__(?=\S)(.+?\S)__(?![\w_])/g, "$1**$2**")
            .replace(/(^|[^\w*])\*(?=[^*\s])([^*\n]*?[^*\s])\*(?![*\w])/g, "$1//$2//")
            .replace(/(^|[^\w_])_(?=[^_\s])([^_\n]*?[^_\s])_(?![\w_])/g, "$1//$2//"),
    )
    .join("");
}
