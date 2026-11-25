// Pasting: rich text (web pages, Word, Google Docs, spreadsheets) and
// Markdown arrive as remarkup, see src/paste.ts (Ctrl+Z after the paste gives
// the plain text), and its images are uploaded; a URL pasted over selected text links it; lines
// pasted into a quote stay in the quote. Ctrl+Shift+V pastes the plain text,
// and code blocks (also in quotes) always get it.

import { isolateHistory } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { matchesKey } from "../keys";
import {
  genericLinkName,
  htmlToRemarkup,
  type ImageMarkup,
  markdownToRemarkup,
  pastedLink,
  shouldConvertHtml,
  tsvToRemarkup,
} from "../paste";
import { linkMarkup } from "../linkMarkup";
import { embeddedFile, fetchImage, fileByPhid } from "../phorge";
import { inMonospace, LITERAL_BLOCKS, QUOTE_LINE, quoteDepth, quoteMarkers } from "../syntax";
import { locate, parseTable } from "../table";
import { TABLE_LINE } from "../blocks";
import { blockAt, blockAtCursor, innerBlockAtCursor } from "./livePreview";
import { editCellAt, tableModeField } from "./tableEditor";
import { hasText, uploadInPlace, uploadPlaceholder } from "./upload";

/** Until when a paste is a plain one: Ctrl+Shift+V was pressed just before. */
let plainUntil = 0;

/** A single URL pasted over selected text on one line, as a link with that text. */
export function linkSelection(view: EditorView, text: string): boolean {
  const { state } = view;
  const range = state.selection.main;
  const selected = state.sliceDoc(range.from, range.to);
  const line = state.doc.lineAt(range.from);
  if (
    range.empty ||
    !/^https?:\/\/\S+$/.test(text) ||
    selected.includes("\n") ||
    /^https?:\/\//.test(selected) ||
    inMonospace(state.sliceDoc(line.from, range.from))
  ) {
    return false;
  }
  const insert = linkMarkup(text, selected);
  view.dispatch({
    changes: { from: range.from, to: range.to, insert },
    selection: { anchor: range.from + insert.length },
    userEvent: "input.paste",
  });
  return true;
}

/**
 * Images of pasted HTML (e.g. an email) become uploads: the clipboard's image
 * files in their order, else the images the browser can read (inline ones,
 * this site's, sites that allow it). A placeholder keeps their place while
 * they upload. Images it can not read keep their link or description. Files
 * of this Phorge (copied from a task or wiki page) are not uploaded
 * again: they are referenced, with the size and layout they had.
 */
function imagesToUpload(
  view: EditorView,
  data: DataTransfer,
  uploads: Parameters<typeof uploadInPlace>[],
): ImageMarkup {
  const files = Array.from(data.files).filter((file) => file.type.startsWith("image/"));
  return (src, alt, img) => {
    // Protocol-relative, as in Wikipedia's HTML.
    src = src.replace(/^\/\//, "https://");
    const file = files.shift();
    const existing = embeddedFile(img);
    if (existing?.id) {
      return `{F${existing.id}${existing.options}}`;
    }
    if (!existing && !file && !/^(data:image\/|blob:|https?:)/i.test(src)) {
      return null;
    }
    const name =
      alt
        // One space at most between words: the conversion collapses spaces, also in the placeholder.
        .replace(/[^\w.-]+/g, " ")
        .trim()
        .slice(0, 40) || "pasted image";
    const placeholder = uploadPlaceholder(view, name);
    const linked = /^https?:/i.test(src);
    const fallback = linked ? (alt ? linkMarkup(src, alt) : src) : alt;
    if (existing?.phid) {
      const phid = existing.phid;
      // A PHID this Phorge does not have: an image of another Phorge, uploaded.
      const found = () => fileByPhid(phid).catch(() => fetchImage(src, name));
      uploads.push([view, placeholder, found, name, fallback, existing.options, !linked]);
    } else {
      uploads.push([
        view,
        placeholder,
        file ? async () => file : () => fetchImage(src, name),
        name,
        fallback,
        "",
        !linked,
      ]);
    }
    return placeholder;
  };
}

export const pasting = EditorView.domEventHandlers({
  keydown(event) {
    if (matchesKey(event, "Mod-Shift-v")) {
      plainUntil = Date.now() + 1000;
    }
    return false;
  },
  paste(event, view) {
    const data = event.clipboardData;
    // Files alone are uploads (upload.ts); text with images is handled here.
    if (!data || (data.files.length && !hasText(data))) {
      return false;
    }
    const block = blockAtCursor(view.state);
    // Code blocks get the plain text; in a quote, with the quote's markers.
    const inner = innerBlockAtCursor(view.state);
    const literal = !!inner && LITERAL_BLOCKS.has(inner.kind);
    if (literal && !inner.quoted) {
      return false;
    }
    const plain = literal || Date.now() < plainUntil;
    plainUntil = 0;
    const html = data.getData("text/html");
    const text = data.getData("text/plain");
    if (!plain && linkSelection(view, text.trim())) {
      event.preventDefault();
      return true;
    }
    let insert: string | null = null;
    const uploads: Parameters<typeof uploadInPlace>[] = [];
    if (!plain && html && (shouldConvertHtml(html, text) || /<img\s/i.test(html))) {
      insert = htmlToRemarkup(html, imagesToUpload(view, data, uploads));
    }
    const { state } = view;
    const range = state.selection.main;
    if (!plain && text && insert === null) {
      const line = state.doc.lineAt(range.from);
      insert =
        pastedLink(state.sliceDoc(line.from, range.from), text) ?? tsvToRemarkup(text) ?? markdownToRemarkup(text);
    }
    // A link's name that is only its kind of file, to be typed over.
    const name = insert === null ? null : genericLinkName(insert);
    const markers = block?.kind === "quote" ? QUOTE_LINE.exec(state.doc.lineAt(range.from).text)?.[1] : undefined;
    const quote = markers && quoteMarkers(quoteDepth(markers));
    if (quote) {
      const lines = (insert ?? text).replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
      if (lines.length === 1 && insert === null) {
        return false;
      }
      insert = lines.map((line, i) => (i === 0 ? line : line ? quote + line : quote.trimEnd())).join("\n");
    } else if (insert === null && (plain || inner?.kind === "table" || !TABLE_LINE.test(text))) {
      // As typed; also rows pasted into a table.
      return false;
    } else if (insert === null) {
      // A table, as a block of its own (below), edited as a table (editPastedTable()).
      insert = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
    }
    if (!quote && insert.includes("\n")) {
      // Blocks (tables, lists, ...) are blocks of their own.
      const before = state.sliceDoc(state.doc.lineAt(range.from).from, range.from);
      const after = state.sliceDoc(range.to, state.doc.lineAt(range.to).to);
      insert = (before.trim() ? "\n\n" : "") + insert + (after.trim() ? "\n\n" : "");
    }
    event.preventDefault();
    // The text as copied, then what it became as an undo step of its own:
    // Ctrl+Z after a paste gives the plain text.
    const raw = text.replace(/\r\n?/g, "\n");
    let start = range.from;
    if (raw && raw !== insert) {
      const pasted = state.update(state.replaceSelection(raw), { userEvent: "input.paste" });
      view.dispatch(pasted);
      // Where the text went: the quote markers it is in may have been tidied (tidyQuotes).
      const from = pasted.changes.mapPos(range.from, -1);
      start = from;
      view.dispatch({
        changes: { from, to: pasted.changes.mapPos(range.to, 1), insert },
        selection: name ? { anchor: from + name[0], head: from + name[1] } : { anchor: from + insert.length },
        annotations: isolateHistory.of("before"),
        userEvent: "input.paste",
        scrollIntoView: true,
      });
    } else {
      view.dispatch(state.replaceSelection(insert), { userEvent: "input.paste", scrollIntoView: true });
    }
    // Where what was pasted ends, before the blank lines that separate it from the text after it.
    editPastedTable(view, start, start + insert.trimEnd().length);
    void uploadAll(uploads);
    return true;
  },
});

/**
 * A table that a paste made and ends with is edited as a table, in the cell
 * the paste ends in, as a table inserted with the button is (unless tables are
 * edited as text, or it is in a quote, whose tables are edited in the quote).
 */
function editPastedTable(view: EditorView, from: number, end: number): void {
  const { state } = view;
  const block = blockAt(state, end);
  if (block?.kind !== "table" || block.from < from || state.field(tableModeField, false) !== "table") {
    return;
  }
  const text = state.sliceDoc(block.from, block.contentTo);
  const { row, col } = locate(text, end - block.from);
  // The separator row below the header has no cells: the header's.
  editCellAt(view, block.from, parseTable(text).rows[row]?.separator ? row - 1 : row, col);
}

/** Uploads the images of a paste, a few at a time: a long article must not start dozens of downloads at once. */
async function uploadAll(uploads: Parameters<typeof uploadInPlace>[], parallel = 3): Promise<void> {
  const next = async (): Promise<void> => {
    for (let upload = uploads.shift(); upload; upload = uploads.shift()) {
      await uploadInPlace(...upload);
    }
  };
  await Promise.all(Array.from({ length: parallel }, next));
}
