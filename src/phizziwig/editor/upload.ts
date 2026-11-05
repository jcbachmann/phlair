// File upload by pasting or dropping, like Phorge's own textarea. A panel
// below the text shows the uploads running and the ones that failed; the
// form is sent only when they are done.

import { EditorView, type Panel, showPanel } from "@codemirror/view";
import { parseHtml } from "../html";
import { addAttachedFile, notifyChange, submitForm, type UploadedFile, uploadFile } from "../phorge";
import { hostTextarea } from "./host";

/** An upload running, with the share done of a chunked one. */
interface Running {
  name: string;
  done: number | null;
}

/** The uploads of a textarea: they go on when its editor is turned off. */
class Uploads {
  readonly running = new Set<Running>();
  readonly failed: string[] = [];
  /** A submit of the form waits for the uploads. */
  waiting = false;
  /** The panels of the editors showing them. */
  readonly panels = new Set<() => void>();
  private idle: (() => void)[] = [];

  changed(): void {
    if (!this.running.size) {
      this.idle.splice(0).forEach((resolve) => resolve());
    }
    this.panels.forEach((show) => show());
  }

  /** Until no upload runs. */
  done(): Promise<void> {
    return this.running.size ? new Promise((resolve) => this.idle.push(resolve)) : Promise.resolve();
  }
}

const uploadsOf = new WeakMap<HTMLTextAreaElement, Uploads>();

function uploads(textarea: HTMLTextAreaElement): Uploads {
  let found = uploadsOf.get(textarea);
  if (!found) {
    uploadsOf.set(textarea, (found = new Uploads()));
    // Before Phorge's own handlers (Javelin listens on the document).
    window.addEventListener("submit", holdSubmit, true);
  }
  return found;
}

/**
 * Runs an upload of a textarea: shown in its panel, and its form waits for
 * it. A failure is shown with `failure` (or not, without), then thrown.
 */
async function track<T>(
  textarea: HTMLTextAreaElement | null,
  name: string,
  run: (progress: (done: number) => void) => Promise<T>,
  failure?: (error: unknown) => string,
): Promise<T> {
  if (!textarea) {
    return run(() => {});
  }
  const state = uploads(textarea);
  const upload: Running = { name, done: null };
  state.running.add(upload);
  state.changed();
  try {
    return await run((done) => {
      upload.done = done;
      state.changed();
    });
  } catch (error) {
    if (failure) {
      state.failed.push(failure(error));
    }
    throw error;
  } finally {
    state.running.delete(upload);
    state.changed();
  }
}

/** Sends the forms of textareas once their uploads are done, unless one fails or it is cancelled. */
async function sendWhenUploaded(textareas: HTMLTextAreaElement[], send: () => void): Promise<void> {
  const states = textareas.map(uploads);
  const failures = states.map((state) => state.failed.length);
  states.forEach((state) => {
    state.waiting = true;
    state.changed();
  });
  await Promise.all(states.map((state) => state.done()));
  const sendNow = states.every((state, i) => state.waiting && state.failed.length === failures[i]);
  states.forEach((state) => {
    state.waiting = false;
    state.changed();
  });
  if (sendNow) {
    send();
  }
}

/** A form submitted while its uploads run is sent when they are done; the text would have their placeholders. */
function holdSubmit(event: Event): void {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) {
    return;
  }
  const busy = Array.from(form.querySelectorAll("textarea")).filter((t) => uploadsOf.get(t)?.running.size);
  if (!busy.length) {
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  const submitter = (event as SubmitEvent).submitter;
  void sendWhenUploaded(busy, () => {
    try {
      form.requestSubmit(submitter);
    } catch {
      // Not a submit button of the form.
      form.requestSubmit();
    }
  });
}

/** Ctrl/Cmd+Enter in the editor: submits the form, once its uploads are done. */
export function submitWhenUploaded(textarea: HTMLTextAreaElement): boolean {
  if (uploadsOf.get(textarea)?.running.size) {
    void sendWhenUploaded([textarea], () => submitForm(textarea));
  } else {
    submitForm(textarea);
  }
  return true;
}

/** The panel below the text: the uploads running, and the failed ones. */
export const uploadPanel = showPanel.of((view): Panel => {
  const dom = document.createElement("div");
  dom.className = "rme-upload-status";
  dom.setAttribute("role", "status");
  const textarea = view.state.facet(hostTextarea);
  const state = textarea ? uploads(textarea) : null;
  const link = (text: string, run: () => void) => {
    const a = document.createElement("a");
    a.href = "#";
    a.textContent = text;
    a.addEventListener("mousedown", (event) => event.preventDefault());
    a.addEventListener("click", (event) => {
      event.preventDefault();
      run();
      state!.changed();
    });
    return a;
  };
  const show = () => {
    dom.replaceChildren();
    if (!state) {
      dom.hidden = true;
      return;
    }
    if (state.running.size) {
      const line = document.createElement("div");
      const names = [...state.running].map((u) =>
        u.done === null ? u.name : `${u.name} (${Math.round(u.done * 100)}%)`,
      );
      line.append(`Uploading ${names.join(", ")}…`);
      if (state.waiting) {
        line.append(
          " The form is sent when done. ",
          link("Don't send", () => (state.waiting = false)),
        );
      }
      dom.append(line);
    }
    for (const [i, failure] of state.failed.entries()) {
      const line = document.createElement("div");
      line.className = "rme-status-error";
      line.append(
        `${failure} `,
        link("Dismiss", () => state.failed.splice(i, 1)),
      );
      dom.append(line);
    }
    dom.hidden = !dom.firstChild;
  };
  show();
  return {
    dom,
    mount: () => state?.panels.add(show),
    destroy: () => state?.panels.delete(show),
  };
});

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

/** Numbers the placeholders. */
let placeholders = 0;

/**
 * A placeholder that keeps the place of a file while it uploads: not one the
 * text has already (e.g. left over from an upload a page before), on one
 * line and without "|" (it may go in a table cell).
 */
export function uploadPlaceholder(view: EditorView, name: string): string {
  const text = view.state.doc.toString();
  const shown = name.replace(/[\s|]+/g, " ").trim() || "file";
  let placeholder: string;
  do {
    placeholder = `{Uploading ${shown} ${++placeholders}…}`;
  } while (text.includes(placeholder));
  return placeholder;
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
    // Images of other sites that can not be had keep their link: no failure to show.
    const uploaded = await track(textarea, name, async (progress) => {
      const blob = await file();
      // A file the server stored already, or the image to upload.
      return blob instanceof Blob
        ? uploadFile(
            blob instanceof File
              ? blob
              : new File([blob], `${name}.${blob.type.split("/")[1]?.replace(/\W.*$/, "") || "png"}`, {
                  type: blob.type,
                }),
            progress,
          )
        : blob;
    });
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
    const placeholder = uploadPlaceholder(view, file.name);
    if (view.dom.isConnected) {
      insert(placeholder, after);
    } else {
      // Turned off during an earlier upload: add the file at the end.
      textarea!.value += `\n\n${placeholder}`;
      notifyChange(textarea!);
    }
    let replacement = "";
    try {
      const uploaded = await track(
        textarea,
        file.name,
        (progress) => uploadFile(file, progress),
        (error) => `Uploading ${file.name} failed (${error instanceof Error ? error.message : error}).`,
      );
      if (textarea) {
        addAttachedFile(textarea, uploaded.phid);
      }
      replacement = `{F${uploaded.id}}`;
    } catch (error) {
      console.warn("Phizziwig: upload failed", error);
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
