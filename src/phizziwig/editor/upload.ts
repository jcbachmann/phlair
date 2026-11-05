// File upload by pasting or dropping, like Phorge's own textarea.

import { EditorView } from "@codemirror/view";
import { parseHtml } from "../html";
import { addAttachedFile, notifyChange, type UploadedFile, uploadFile } from "../phorge";
import { hostTextarea } from "./host";

let uploads = 0;

/**
 * Replaces the placeholder of an upload. When the editor was turned off
 * meanwhile, the placeholder is in the textarea (or in a new editor that
 * follows the textarea).
 */
function replacePlaceholder(view: EditorView, textarea: HTMLTextAreaElement, placeholder: string, text: string) {
  if (view.dom.isConnected) {
    const at = view.state.doc.toString().indexOf(placeholder);
    if (at >= 0) {
      view.dispatch({ changes: { from: at, to: at + placeholder.length, insert: text }, userEvent: "input.upload" });
    }
    return at;
  }
  const at = textarea.value.indexOf(placeholder);
  if (at >= 0) {
    textarea.value = textarea.value.slice(0, at) + text + textarea.value.slice(at + placeholder.length);
    notifyChange(textarea);
  }
  return -1;
}

/** A placeholder that keeps the place of a file while it uploads. */
export function uploadPlaceholder(name: string): string {
  return `{Uploading ${name || "file"} ${++uploads}…}`;
}

/**
 * Uploads a file for a placeholder in the text and puts the file's reference
 * in its place, or `fallback` when the file can not be had or uploaded.
 */
export async function uploadInPlace(
  view: EditorView,
  placeholder: string,
  file: () => Promise<Blob | UploadedFile>,
  name: string,
  fallback: string,
  /** Options of the embed, e.g. ", size=full". */
  options = "",
): Promise<void> {
  const textarea = view.state.facet(hostTextarea);
  let replacement = fallback;
  try {
    const blob = await file();
    // A file the server stored already, or the image to upload.
    const uploaded =
      blob instanceof Blob
        ? await uploadFile(
            blob instanceof File
              ? blob
              : new File([blob], `${name}.${blob.type.split("/")[1]?.replace(/\W.*$/, "") || "png"}`, {
                  type: blob.type,
                }),
          )
        : blob;
    if (textarea && !uploaded.existing) {
      addAttachedFile(textarea, uploaded.phid);
    }
    replacement = `{F${uploaded.id}${options}}`;
  } catch (error) {
    console.warn("Phizziwig: an image could not be uploaded", error);
  }
  if (textarea) {
    replacePlaceholder(view, textarea, placeholder, replacement);
  }
}

/**
 * Uploads files one after the other. Each first gets a placeholder, which
 * `insert` puts in the text (with where the reference of the file before it
 * ended up, if it is in the text), then its reference replaces it.
 */
export async function uploadFiles(
  view: EditorView,
  files: File[],
  insert: (placeholder: string, after: number | null) => void,
): Promise<void> {
  const textarea = view.state.facet(hostTextarea);
  let after: number | null = null;
  for (const file of files) {
    // The placeholder keeps the place while the upload runs.
    const placeholder = uploadPlaceholder(file.name);
    if (view.dom.isConnected) {
      insert(placeholder, after);
    } else {
      // Turned off during an earlier upload: add the file at the end.
      textarea!.value += `\n\n${placeholder}`;
      notifyChange(textarea!);
    }
    let replacement = "";
    try {
      const uploaded = await uploadFile(file);
      if (textarea) {
        addAttachedFile(textarea, uploaded.phid);
      }
      replacement = `{F${uploaded.id}}`;
    } catch (error) {
      console.warn("Phizziwig: upload failed", error);
      window.alert(`Uploading ${file.name} failed. Try the upload button in the toolbar.`);
    }
    const at = textarea ? replacePlaceholder(view, textarea, placeholder, replacement) : -1;
    after = at >= 0 ? at + replacement.length : null;
  }
}

/** Uploads files into the text at a position, like Phorge's textarea. */
function upload(view: EditorView, files: File[], pos: number): Promise<void> {
  return uploadFiles(view, files, (placeholder, after) => {
    pos = after ?? pos;
    const before = view.state.doc.sliceString(Math.max(0, pos - 1), pos);
    // After another file, on a line of its own.
    const text = (before === "}" ? "\n\n" : "") + placeholder;
    view.dispatch({ changes: { from: pos, insert: text }, userEvent: "input.upload" });
  });
}

/** Whether pasted data has text besides its files, in its HTML. */
export function hasText(data: DataTransfer): boolean {
  const html = data.getData("text/html");
  return !!html && /\S/.test(parseHtml(html).textContent ?? "");
}

export const fileUpload = EditorView.domEventHandlers({
  paste(event, view) {
    const files = Array.from(event.clipboardData?.files ?? []);
    if (!files.length || !view.state.facet(hostTextarea) || hasText(event.clipboardData!)) {
      // Text with images (an email): see pasting.ts.
      return false;
    }
    event.preventDefault();
    void upload(view, files, view.state.selection.main.head);
    return true;
  },
  drop(event, view) {
    const files = Array.from(event.dataTransfer?.files ?? []);
    if (!files.length || !view.state.facet(hostTextarea)) {
      return false;
    }
    event.preventDefault();
    const pos = view.posAtCoords({ x: event.clientX, y: event.clientY }) ?? view.state.selection.main.head;
    void upload(view, files, pos);
    return true;
  },
});
