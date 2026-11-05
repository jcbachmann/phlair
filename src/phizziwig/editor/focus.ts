// The focus of the editor, as the live preview sees it: the editor counts
// as focused also while a search, dialog, panel or menu opened from it has
// the focus, so what is being edited keeps showing its source.

import { StateEffect, StateField } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";

export const setFocused = StateEffect.define<boolean>();

/** Whether the editor counts as focused; see above. */
export const focusField = StateField.define<boolean>({
  create: () => false,
  update(focused, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setFocused)) {
        focused = effect.value;
      }
    }
    return focused;
  },
});

/**
 * Notes the focus of the editor now, instead of after CodeMirror's delay
 * (focusChangeEffect): e.g. before measuring the text, which may still show
 * a block rendered that shows its source with the focus. Only the focus
 * coming: without it, the focus may be in a table cell, whose table must
 * stay as it is.
 */
export function syncFocus(view: EditorView): void {
  if (view.hasFocus && view.state.field(focusField, false) === false) {
    view.dispatch({ effects: setFocused.of(true) });
  }
}

/**
 * Searches and dialogs opened from the editor: the pickers (link, reference,
 * image macro, …), Phorge's dialogs (upload, meme), the editor's panels
 * (Ctrl+F) and menus (images, shortcuts). While they have the focus, the editor counts as focused, so what
 * is being edited keeps showing its source, e.g. a table edited as text or
 * the text found.
 */
const KEEPS_FOCUS = ".rme-picker, .jx-client-dialog, .rme-panels, .rme-dropdown";

export function keepsFocus(): boolean {
  return !!document.activeElement?.closest(KEEPS_FOCUS);
}

/** Whether the editor has the focus now, or a search or dialog opened from it has. */
export function editing(view: EditorView): boolean {
  return view.hasFocus || (!!view.state.field(focusField, false) && keepsFocus());
}

/** Notices when the focus a search or dialog kept for the editor goes elsewhere. */
const focusKeeper = ViewPlugin.fromClass(
  class {
    private watching = false;

    constructor(private readonly view: EditorView) {}

    update(update: ViewUpdate) {
      if (update.focusChanged && !update.view.hasFocus && update.state.field(focusField)) {
        this.watch();
      }
    }

    private readonly check = () =>
      // After the event, when the focus has moved (or its element is gone).
      setTimeout(() => {
        if (!this.watching || this.view.hasFocus || keepsFocus()) {
          this.stop(this.view.hasFocus);
          return;
        }
        this.stop(true);
        if (this.view.state.field(focusField)) {
          this.view.dispatch({ effects: setFocused.of(false) });
        }
      });

    private watch() {
      if (!this.watching) {
        this.watching = true;
        for (const type of ["focusin", "focusout", "mousedown", "keydown"]) {
          document.addEventListener(type, this.check, true);
        }
      }
    }

    /** Stops watching; unless done, only when the focus is back in the editor. */
    private stop(done: boolean) {
      if (this.watching && done) {
        this.watching = false;
        for (const type of ["focusin", "focusout", "mousedown", "keydown"]) {
          document.removeEventListener(type, this.check, true);
        }
      }
    }

    destroy() {
      this.stop(true);
    }
  },
);

/** The editor's focus for the live preview; before the fields that read it. */
export const focusTracking = [
  focusField,
  // With the focus in a search or dialog opened from the editor, it stays as it is (focusKeeper).
  EditorView.focusChangeEffect.of((_state, focusing) => (focusing || !keepsFocus() ? setFocused.of(focusing) : null)),
  focusKeeper,
];
