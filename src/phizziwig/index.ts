// Phizziwig, the live-preview remarkup editor: puts itself in place of every
// remarkup textarea of the page, also of those added later.

import { EditorView, runScopeHandlers } from "@codemirror/view";
import { addStyle } from "../style";
import { enhance } from "./attach";
import { enableCheckboxes } from "./checkboxes";
import { watchCommentForms } from "./commentForm";
import { closePicker } from "./editor/picker";
import { TEXTAREA } from "./phorge";
import css from "./style.css";

function enhanceAll(root: ParentNode): void {
  root.querySelectorAll<HTMLTextAreaElement>(TEXTAREA).forEach(enhance);
  watchCommentForms(root);
  enableCheckboxes(root);
}

export function startPhizziwig(): void {
  addStyle(css);

  // Phorge's keyboard shortcuts ("?" for help, "z" to pin the comment
  // form, ...) ignore keys typed in textareas, but not in the editor. They
  // listen to "keypress" in the capture phase on the root element, so stop the
  // event before it gets there. The editor itself does not use "keypress", and
  // the browser still inserts the character.
  window.addEventListener(
    "keypress",
    (event) => {
      if (event.target instanceof Element && event.target.closest(".rme-editor")) {
        event.stopPropagation();
      }
    },
    true,
  );

  // ← and → are shortcuts on some pages (Pholio flips images), which take them
  // on "keydown" before the editor. Keep them from the page and let the
  // editor's keymap move the cursor; without a binding, the browser does.
  window.addEventListener(
    "keydown",
    (event) => {
      const target = event.target instanceof Element ? event.target : null;
      const content = target?.closest<HTMLElement>(".rme-editor .cm-content");
      if (
        !content ||
        (event.key !== "ArrowLeft" && event.key !== "ArrowRight") ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        target!.closest(".rme-table-editor")
      ) {
        return;
      }
      event.stopPropagation();
      const view = EditorView.findFromDOM(content);
      if (view && runScopeHandlers(view, event, "editor")) {
        event.preventDefault();
      }
    },
    true,
  );

  // Escape closes the editor's menus. Phorge takes Escape before them
  // (it leaves fullscreen mode), so close them here and keep it from the page.
  // Dropdown menus close by themselves (see dropdown.ts).
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape" || !(event.target instanceof Element)) {
        return;
      }
      const content = event.target.closest<HTMLElement>(".rme-editor .cm-content");
      const view = content && EditorView.findFromDOM(content);
      // The menus in the editor (autocomplete, insert menu) close by its keymap.
      const menu = view && document.querySelector(".rme-autocomplete") && runScopeHandlers(view, event, "editor");
      if (closePicker() || menu) {
        event.preventDefault();
        event.stopPropagation();
      }
    },
    true,
  );

  enhanceAll(document);
  // Comment forms in dialogs and inline comments are added later.
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        // Not the lines and widgets the editor adds as it is used.
        if (node instanceof Element && !node.closest(".rme-editor")) {
          enhanceAll(node);
        }
      });
    }
  }).observe(document.body, { childList: true, subtree: true });
}
