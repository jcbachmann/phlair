// Pasted Markdown (e.g. from a README or a chat answer) as remarkup. Most
// Markdown is remarkup already (bold, code, lists, quotes, tables, simple
// links, "===" and "---" underlined headings), so the text stays as it is,
// except what remarkup writes differently. The text is parsed with
// @lezer/markdown (CommonMark and GitHub's extensions), so code, escapes and
// nesting are what Markdown makes of them.

import type { SyntaxNode } from "@lezer/common";
import { GFM, parser } from "@lezer/markdown";

const markdown = parser.configure(GFM);

/** Node types that show a text is Markdown; see markdownToRemarkup(). */
const SIGNALS: Record<string, string> = {
  ATXHeading1: "heading",
  ATXHeading2: "heading",
  ATXHeading3: "heading",
  ATXHeading4: "heading",
  ATXHeading5: "heading",
  ATXHeading6: "heading",
  BulletList: "list",
  OrderedList: "list",
  FencedCode: "code",
  Emphasis: "emphasis",
  StrongEmphasis: "emphasis",
  Link: "link",
  Image: "link",
  Table: "table",
  Blockquote: "quote",
};

interface Edit {
  from: number;
  to: number;
  insert: string;
}

/**
 * The text as remarkup, or null when it does not look like Markdown: at
 * least two kinds of headings, lists, code fences, emphasis, links, tables
 * and quotes. A shell snippet with one "# comment" stays as it is.
 */
export function markdownToRemarkup(input: string): string | null {
  const text = input.replace(/\r\n?/g, "\n");
  const tree = markdown.parse(text);
  const kinds = new Set<string>();
  tree.iterate({
    enter: (node) => {
      if (SIGNALS[node.name]) {
        kinds.add(SIGNALS[node.name]);
      }
    },
  });
  if (kinds.size < 2) {
    return null;
  }
  const references = linkReferences(tree.topNode, text);
  const edits: Edit[] = [];
  convert(tree.topNode, text, references, edits);
  edits.sort((a, b) => b.from - a.from);
  let out = text;
  for (const edit of edits) {
    out = out.slice(0, edit.from) + edit.insert + out.slice(edit.to);
  }
  // Without the blank lines the reference definitions at the end leave.
  return out.replace(/\n+$/, text.endsWith("\n") ? "\n" : "");
}

/** The targets of reference links ("[label]: url"), by their label. */
function linkReferences(top: SyntaxNode, text: string): Map<string, string> {
  const found = new Map<string, string>();
  for (let node = top.firstChild; node; node = node.nextSibling) {
    if (node.name === "LinkReference") {
      const label = node.getChild("LinkLabel");
      const url = node.getChild("URL");
      if (label && url) {
        found.set(normalizeLabel(text.slice(label.from, label.to)), text.slice(url.from, url.to));
      }
    }
  }
  return found;
}

function normalizeLabel(label: string): string {
  return label
    .replace(/^\[|\]$/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

const slice = (text: string, node: SyntaxNode | null) => (node ? text.slice(node.from, node.to) : "");

/** Collects the edits of a node and the nodes in it. */
function convert(node: SyntaxNode, text: string, references: Map<string, string>, edits: Edit[]): void {
  const replace = (from: number, to: number, insert: string) => edits.push({ from, to, insert });
  const heading = /^ATXHeading(\d)$/.exec(node.name);
  if (heading) {
    // "## A ##" → "== A": remarkup's "=" headers, without closing markers.
    const marks = node.getChildren("HeaderMark");
    const open = marks[0];
    const level = Math.min(Number(heading[1]), 5);
    const contentFrom = text.slice(open.to).match(/^[ \t]*/)![0].length + open.to;
    replace(open.from, contentFrom, `${"=".repeat(level)} `);
    const close = marks[1];
    if (close) {
      replace(text.slice(0, close.from).trimEnd().length, close.to, "");
    }
  }
  switch (node.name) {
    case "FencedCode": {
      // "```py" → "```lang=py"; "~~~" fences are "```" in remarkup.
      for (const mark of node.getChildren("CodeMark")) {
        if (text.startsWith("~", mark.from)) {
          replace(mark.from, mark.to, "```");
        }
      }
      const info = node.getChild("CodeInfo");
      if (info) {
        replace(info.from, info.to, `lang=${slice(text, info)}`);
      }
      // Code is literal: nothing in it is converted.
      return;
    }
    case "CodeBlock":
    case "HTMLBlock":
    case "CommentBlock":
    case "LinkReference":
      if (node.name === "LinkReference") {
        // Used by the links, which get their targets: the definition goes, with its line.
        replace(node.from, text[node.to] === "\n" ? node.to + 1 : node.to, "");
      }
      return;
    case "HorizontalRule":
      replace(node.from, node.to, "---");
      return;
    case "InlineCode": {
      // A code span with backticks in it, or of several backticks, is "##…##" in remarkup.
      const marks = node.getChildren("CodeMark");
      const code = text.slice(marks[0].to, marks[1]?.from ?? node.to);
      if (slice(text, marks[0]).length > 1 || code.includes("`")) {
        const trimmed = /^ .*[^ ].* $/.test(code) ? code.slice(1, -1) : code;
        replace(node.from, node.to, `##${trimmed}##`);
      }
      return;
    }
    case "Emphasis": {
      // "*a*" and "_a_" → "//a//"; not inside a word ("2*3*4"), which is
      // more likely arithmetic than emphasis.
      const marks = node.getChildren("EmphasisMark");
      const inWord = /\w/.test(text[node.from - 1] ?? "") && /\w/.test(text[node.to] ?? "");
      if (!inWord) {
        for (const mark of marks) {
          replace(mark.from, mark.to, "//");
        }
      }
      break;
    }
    case "StrongEmphasis": {
      // "__a__" → "**a**".
      for (const mark of node.getChildren("EmphasisMark")) {
        if (text.startsWith("_", mark.from)) {
          replace(mark.from, mark.to, "**");
        }
      }
      break;
    }
    case "Image": {
      // As a link: an image of another site can not be embedded.
      const alt = linkText(node, text);
      const url = linkTarget(node, text, references);
      if (url) {
        replace(node.from, node.to, alt ? `[[ ${url} | ${alt} ]]` : url);
      }
      return;
    }
    case "Link": {
      // Phorge renders "[a](url)" itself; with a title, or by reference, as "[[ url | a ]]".
      const url = linkTarget(node, text, references);
      const simple = node.getChild("URL") && !node.getChild("LinkTitle");
      if (url && !simple) {
        const label = node.getChildren("LinkMark")[0];
        const close = node.getChildren("LinkMark")[1];
        replace(node.from, label.to, `[[ ${url} | `);
        replace(close?.from ?? node.to, node.to, " ]]");
        // The link text keeps its own markup (converted below).
        for (let child = node.firstChild; child; child = child.nextSibling) {
          if (child.from >= label.to && child.to <= (close?.from ?? node.to) && child.name !== "LinkMark") {
            convert(child, text, references, edits);
          }
        }
        return;
      }
      break;
    }
    case "Autolink": {
      // "<https://example.com>" → the URL.
      const url = node.getChild("URL");
      if (url) {
        replace(node.from, node.to, slice(text, url));
      }
      return;
    }
    case "Escape": {
      // "\*" → "*", unless it would then start a line with markup.
      const char = text.slice(node.from + 1, node.to);
      const lineStart = node.from === 0 || text[node.from - 1] === "\n";
      if (!(lineStart && /[#>*=|-]/.test(char))) {
        replace(node.from, node.to, char);
      }
      return;
    }
    case "ListMark":
      // "+" bullets are "-" in remarkup.
      if (slice(text, node) === "+") {
        replace(node.from, node.to, "-");
      }
      return;
    case "TableDelimiter":
      // The row below the header: alignment colons, which remarkup has not.
      if (slice(text, node).includes("-")) {
        replace(node.from, node.to, slice(text, node).replace(/:/g, "-"));
      }
      return;
  }
  for (let child = node.firstChild; child; child = child.nextSibling) {
    convert(child, text, references, edits);
  }
}

/** The text of a link or image, between its brackets. */
function linkText(node: SyntaxNode, text: string): string {
  const marks = node.getChildren("LinkMark");
  return marks.length >= 2 ? text.slice(marks[0].to, marks[1].from).trim() : "";
}

/** The target of a link or image: its URL, or that of its reference. */
function linkTarget(node: SyntaxNode, text: string, references: Map<string, string>): string | null {
  const url = node.getChild("URL");
  if (url) {
    return slice(text, url);
  }
  const label = node.getChild("LinkLabel");
  return references.get(normalizeLabel(label ? slice(text, label) : linkText(node, text))) ?? null;
}
