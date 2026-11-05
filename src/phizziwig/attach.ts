// Puts Phizziwig, the live-preview editor, in place of a remarkup textarea.
//
// The textarea stays in the form, hidden, and always holds the text and the
// selection of the editor. Everything Phorge does with the textarea
// keeps working: submitting, drafts, its toolbar buttons and the "Quote"
// action. Changes Phorge makes to the textarea are copied back.

import { history, historyKeymap, defaultKeymap } from "@codemirror/commands";
import { ChangeSet, EditorSelection, EditorState, Prec } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { minimalChange } from "./diff";
import { phabricatorAutocomplete } from "./editor/autocomplete";
import { markupKeymap, tableBar } from "./editor/commands";
import {
  ACTIONS,
  cellShortcuts,
  nativeTooltips,
  OVERVIEW_KEYS,
  SHORTCUTS_BY_ICON,
  shortcuts,
  showShortcuts,
} from "./editor/actions";
import { addFormattingButtons, inlineFormat } from "./editor/formatting";
import { cursor } from "./editor/cursor";
import { clearGaps } from "./editor/gaps";
import { hostTextarea } from "./editor/host";
import { imageMenu } from "./editor/imageMenu";
import { editLink, links } from "./editor/links";
import { cellSupport, livePreview, renderedEffect } from "./editor/livePreview";
import { INLINE_FORMATS } from "./syntax";
import { markdownHabits } from "./editor/markdown";
import { linkSelection, pasting } from "./editor/pasting";
import { cellSlashMenu, slashMenu } from "./editor/slashMenu";
import { cellPreview, inlinePreview } from "./editor/inlinePreview";
import { sourceStyle } from "./editor/sourceStyle";
import { formatFocusedCell } from "./editor/tableEditor";
import { showTablePicker } from "./editor/tablePicker";
import { fileUpload } from "./editor/upload";
import { keyLabel } from "./keys";
import { CONTROL, notifyChange, rendererFor, submitForm, TOOLBAR } from "./phorge";
import { BlockRenderer } from "./renderer";
import { storedChoice } from "../storage";
import { buttonIcon, toolbarButton } from "./toolbar";

// Installed in Phorge, the user's setting turns the editor on or off for
// good, and the wand button only for the page.
const enabledChoice = storedChoice(__TARGET__ === "phorge" ? null : "phizziwig-enabled", "1", ["1", "0"]);

/**
 * Copies how the page renders headers and code blocks into CSS variables of
 * the editor, so a block being edited takes the same space and has the same
 * font as the rendered one. Both differ between Phorge versions and custom
 * styles, and code blocks use each user's "Monospaced Font" setting. The probe
 * goes into the editor element, so it has the font of the editor content like
 * the rendered blocks.
 *
 * The colors of the editor are the textarea's. Tools like Dark Reader change
 * the page's styles, but not the styles of an extension, so the editor takes
 * every color from the page.
 */
function pageStyle(editor: HTMLElement, context: HTMLElement, textarea: HTMLTextAreaElement): void {
  const probe = document.createElement("div");
  probe.className = "phabricator-remarkup";
  probe.style.cssText = "position: absolute; visibility: hidden; pointer-events: none;";
  const headers = [1, 2, 3, 4, 5].map((level) => {
    const header = document.createElement(`h${level + 1}`);
    header.className = "remarkup-header";
    header.textContent = "x";
    probe.append(header);
    return header;
  });
  const quote = document.createElement("blockquote");
  const link = document.createElement("a");
  link.href = "#";
  probe.append(quote, link);
  const codeBlock = document.createElement("div");
  codeBlock.className = "remarkup-code-block";
  const code = document.createElement("pre");
  code.className = "remarkup-code";
  code.textContent = "x";
  codeBlock.append(code);
  probe.append(codeBlock);
  const rule = document.createElement("hr");
  probe.append(rule);
  // A list item and a checked checklist item: how much further the text of the second starts, and its color.
  const lists = ["", " remarkup-list-with-checkmarks"].map((checks) => {
    const list = document.createElement("ul");
    list.className = `remarkup-list${checks}`;
    const item = document.createElement("li");
    item.className = `remarkup-list-item${checks && " remarkup-checked-item"}`;
    if (checks) {
      // As Phorge renders it: the hidden input, then a space.
      const input = document.createElement("input");
      input.type = "checkbox";
      item.append(input, " ");
    }
    item.append("x");
    list.append(item);
    probe.append(list);
    return item;
  });
  context.append(probe);
  const textStart = (item: HTMLElement) => {
    const range = document.createRange();
    const text = item.lastChild!;
    range.setStart(text, text.textContent!.length - 1);
    range.setEnd(text, text.textContent!.length);
    return range.getBoundingClientRect().left;
  };
  editor.style.setProperty("--rme-check-indent", `${textStart(lists[1]) - textStart(lists[0])}px`);
  editor.style.setProperty("--rme-checked-color", getComputedStyle(lists[1]).color);

  headers.forEach((header, i) => {
    const style = getComputedStyle(header);
    editor.style.setProperty(`--rme-h${i + 1}-font-size`, style.fontSize);
    editor.style.setProperty(`--rme-h${i + 1}-line-height`, style.lineHeight);
  });
  const style = getComputedStyle(code);
  // The setting sets "font", so the line height may be "normal": measure it.
  const lineHeight =
    code.getBoundingClientRect().height -
    parseFloat(style.paddingTop) -
    parseFloat(style.paddingBottom) -
    parseFloat(style.borderTopWidth) -
    parseFloat(style.borderBottomWidth);
  const set = (name: string, value: string) => editor.style.setProperty(`--rme-code-${name}`, value);
  const transparent = (color: string) => color === "transparent" || /^rgba\(.*,\s*0\)$/.test(color);
  const background = [style.backgroundColor, getComputedStyle(codeBlock).backgroundColor].find((c) => !transparent(c));
  set("background", background ?? "transparent");
  set("font-family", style.fontFamily);
  set("font-size", style.fontSize);
  set("line-height", `${lineHeight}px`);
  set("padding-x", style.paddingLeft);
  set("padding-y", style.paddingTop);
  set("radius", style.borderTopLeftRadius);
  const quoteStyle = getComputedStyle(quote);
  editor.style.setProperty("--rme-quote-color", quoteStyle.color);
  editor.style.setProperty("--rme-quote-background", quoteStyle.backgroundColor);
  editor.style.setProperty("--rme-quote-border-color", quoteStyle.borderLeftColor);
  editor.style.setProperty("--rme-link-color", getComputedStyle(link).color);
  // A rule is its border or its background, depending on the style.
  const ruleStyle = getComputedStyle(rule);
  editor.style.setProperty(
    "--rme-rule-color",
    parseFloat(ruleStyle.borderTopWidth) > 0 ? ruleStyle.borderTopColor : ruleStyle.backgroundColor,
  );
  probe.remove();

  // The textarea is hidden, but has its colors.
  const own = getComputedStyle(textarea);
  editor.style.setProperty("--rme-color", own.color);
  editor.style.setProperty("--rme-background", own.backgroundColor);
  editor.style.setProperty("--rme-border-color", own.borderLeftColor);
}

const editors = new Set<LiveEditor>();
let restyleTimer: ReturnType<typeof setTimeout> | undefined;

function restyleSoon(): void {
  clearTimeout(restyleTimer);
  restyleTimer = setTimeout(() => editors.forEach((editor) => editor.restyle()), 100);
}

// Dark Reader and similar tools add and remove styles and mark the root
// element while the page is open.
new MutationObserver(restyleSoon).observe(document.documentElement, {
  attributes: true,
  attributeFilter: ["class", "style", "data-darkreader-mode", "data-darkreader-scheme"],
});
// Fonts that arrive later change what pageStyle() measures (e.g. how far checklist items start).
document.fonts?.addEventListener("loadingdone", restyleSoon);

/**
 * Toolbar buttons the editor does itself instead of Phorge, by icon.
 * Returning false lets Phorge's own handler run.
 */
type ToolbarOverride = (view: EditorView, button: HTMLElement) => boolean;

/**
 * Phorge's formatting buttons that the editor's commands replace: those
 * toggle (a second click undoes the first), switch between kinds of lists, and
 * do not indent list items.
 */
const REPLACED = new Set([
  "fa-bold",
  "fa-italic",
  "fa-text-width",
  "fa-list-ul",
  "fa-list-ol",
  "fa-code",
  "fa-quote-right",
]);

const overrides: ToolbarOverride[] = [
  // In a focused table cell, formatting buttons act on the cell.
  (view, button) => formatFocusedCell(view, buttonIcon(button) ?? ""),
  // A new table: pick its size.
  (view, button) => buttonIcon(button) === "fa-table" && (showTablePicker(view, button), true),
  // Links: search pages and tasks, or change the link the cursor is in.
  (view, button) => buttonIcon(button) === "fa-link" && editLink(view),
  (view, button) => {
    const icon = buttonIcon(button);
    const action = icon && REPLACED.has(icon) && ACTIONS.find((a) => a.icon === icon);
    return !!action && action.run(view);
  },
];

class LiveEditor {
  readonly view: EditorView;
  private readonly renderer: BlockRenderer;
  private readonly bar: HTMLElement;
  private readonly wrapper: HTMLElement;
  private readonly status: HTMLElement;
  private readonly removeButtons: () => void;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly resizes: ResizeObserver;
  private lastValue: string;
  private destroyed = false;
  private readonly onBarMouseDown = (event: MouseEvent) => {
    // Clicking a toolbar button must not take the focus from the editor.
    if ((event.target as Element).closest(".remarkup-assist-button")) {
      event.preventDefault();
    }
  };
  private readonly onBarClick = () => setTimeout(() => this.pull(), 0);
  /** Runs before Phorge's own handlers, which work on the textarea. */
  private readonly onWindowClick = (event: MouseEvent) => {
    const button = (event.target as Element).closest?.<HTMLElement>(".remarkup-assist-button");
    if (!button || !this.bar.contains(button) || button.closest(".rme-own")) {
      return;
    }
    if (overrides.some((override) => override(this.view, button))) {
      event.preventDefault();
      event.stopPropagation();
    }
  };

  constructor(
    private readonly textarea: HTMLTextAreaElement,
    private readonly root: HTMLElement,
    private readonly onDestroy: (detached: boolean) => void,
  ) {
    this.lastValue = textarea.value;
    this.bar = root.querySelector<HTMLElement>(TOOLBAR)!;
    this.renderer = new BlockRenderer(
      rendererFor(textarea),
      () => {
        if (!this.destroyed) {
          this.view.dispatch({ effects: renderedEffect.of(null) });
          this.showStatus();
        }
      },
      // While parts of the text wait for the server, e.g. for tests and screen readers.
      (busy) => this.wrapper?.setAttribute("aria-busy", String(busy)),
    );

    this.wrapper = document.createElement("div");
    this.wrapper.className = "rme-editor";
    // As high as the textarea; Phorge's preview gets the same height (style.css).
    root.style.setProperty("--rme-height", `${Math.max(textarea.offsetHeight, 120)}px`);
    this.status = this.createStatus();
    textarea.after(this.wrapper);

    const length = textarea.value.length;
    this.view = new EditorView({
      parent: this.wrapper,
      state: EditorState.create({
        doc: textarea.value,
        selection: EditorSelection.single(
          Math.min(textarea.selectionStart, length),
          Math.min(textarea.selectionEnd, length),
        ),
        extensions: [
          hostTextarea.of(textarea),
          history(),
          // Not drawSelection(), only its cursor: the browser's own selection is
          // drawn over the backgrounds of notes and quotes, and in the same color in cells.
          cursor,
          EditorView.lineWrapping,
          EditorState.allowMultipleSelections.of(false),
          placeholder(textarea.placeholder || "Write here…"),
          livePreview(this.renderer),
          // The editors of table cells.
          cellSupport.of({
            extensions: (main) => [cellPreview(main), phabricatorAutocomplete, cellSlashMenu, cellShortcuts, links],
            format: (icon) =>
              icon === "fa-link"
                ? editLink
                : INLINE_FORMATS.some((format) => format.icon === icon)
                  ? inlineFormat(icon)
                  : null,
            linkSelection,
          }),
          // Before sourceStyle, whose marks then wrap its widgets: the rendered list markers hang like the source ones.
          inlinePreview,
          sourceStyle,
          imageMenu,
          markupKeymap,
          tableBar,
          phabricatorAutocomplete,
          fileUpload,
          links,
          pasting,
          shortcuts,
          slashMenu,
          markdownHabits,
          // Take over changes of the toolbar before handling the next key.
          EditorView.domEventHandlers({
            keydown: () => {
              this.pull();
              return false;
            },
          }),
          Prec.high(keymap.of([{ key: "Mod-Enter", run: () => submitForm(textarea) }])),
          // No search keymap: Ctrl+F stays the browser's find, which also
          // finds text in the rendered blocks.
          keymap.of([...defaultKeymap, ...historyKeymap]),
          // "phabricator-remarkup" lets Phorge's CSS style monospaced and
          // highlighted text in the source like in the rendered text.
          EditorView.contentAttributes.of({
            "aria-label": "Remarkup editor (Phizziwig)",
            spellcheck: "true",
            class: "phabricator-remarkup",
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) {
              this.push(update.changes, update.startState.doc.length, update.state.doc.toString());
            }
            if (update.docChanged || update.selectionSet) {
              const { main } = update.state.selection;
              textarea.setSelectionRange(main.from, main.to);
            }
          }),
        ],
      }),
    });

    root.classList.add("rme-active");
    this.restyle();
    editors.add(this);
    this.bar.addEventListener("mousedown", this.onBarMouseDown);
    this.bar.addEventListener("click", this.onBarClick);
    window.addEventListener("click", this.onWindowClick, true);
    const removeFormatting = addFormattingButtons(this.bar, this.view, SHORTCUTS_BY_ICON);
    const restoreTooltips = nativeTooltips(this.bar);
    const help = toolbarButton({
      title: `Keyboard shortcuts (${OVERVIEW_KEYS.map(keyLabel).join(", ")})`,
      icon: "fa-keyboard-o",
      className: "remarkup-assist-right rme-own rme-shortcuts-button",
      run: () => {
        const rect = help.getBoundingClientRect();
        showShortcuts(this.view, rect.right, rect.bottom + 2);
      },
    });
    this.bar.querySelector(".rme-toggle")?.after(help);
    this.removeButtons = () => {
      removeFormatting();
      restoreTooltips();
      help.remove();
    };
    // Uploads and quoting change the textarea later; poll for that.
    this.timer = setInterval(() => this.pull(), 300);
    // An editor in a hidden form measured nothing; measure when it shows.
    let hidden = this.wrapper.offsetWidth === 0;
    this.resizes = new ResizeObserver(() => {
      if (hidden && this.wrapper.offsetWidth > 0) {
        this.restyle();
      }
      hidden = this.wrapper.offsetWidth === 0;
    });
    this.resizes.observe(this.wrapper);
  }

  /** Takes the fonts, sizes and colors from the page again; see pageStyle(). */
  restyle(): void {
    pageStyle(this.wrapper, this.view.dom, this.textarea);
    // The gaps between blocks depend on the page's styles too.
    this.view.dispatch({ effects: clearGaps.of(null) });
  }

  /** Writes a change of the editor to the textarea. */
  private push(changes: ChangeSet, baseLength: number, text: string): void {
    const base = this.lastValue;
    const external = this.textarea.value !== base ? this.textarea.value : null;
    this.lastValue = text;
    this.textarea.value = text;
    notifyChange(this.textarea);
    if (external !== null && base.length === baseLength) {
      // Phorge changed the textarea since the last sync (e.g. its upload
      // dialog inserted a file): apply that change too instead of losing it.
      const theirs = ChangeSet.of(minimalChange(base, external), base.length).map(changes);
      queueMicrotask(() => {
        if (!this.destroyed) {
          this.view.dispatch({ changes: theirs, userEvent: "input.phabricator" });
        }
      });
    }
  }

  /** Copies changes Phorge made to the textarea into the editor. */
  pull(): void {
    if (!this.textarea.isConnected) {
      this.destroy(true);
      return;
    }
    const value = this.textarea.value;
    if (value === this.lastValue) {
      return;
    }
    const old = this.view.state.doc.toString();
    // Inserted text (a quote, an upload) is where the user continues; an
    // emptied form after posting a comment is not a reason to take the focus.
    const focus = this.view.hasFocus || value.length > old.length;
    this.lastValue = value;
    this.view.dispatch({
      changes: minimalChange(old, value),
      selection: EditorSelection.single(
        Math.min(this.textarea.selectionStart, value.length),
        Math.min(this.textarea.selectionEnd, value.length),
      ),
      scrollIntoView: focus,
      userEvent: "input.phabricator",
    });
    if (focus) {
      this.view.focus();
    }
  }

  /** A note shown while blocks cannot be rendered, with a retry link. */
  private createStatus(): HTMLElement {
    const status = document.createElement("div");
    status.className = "rme-status";
    status.hidden = true;
    status.setAttribute("role", "status");
    const text = document.createElement("span");
    const retry = document.createElement("a");
    retry.href = "#";
    retry.textContent = "Retry";
    retry.addEventListener("mousedown", (event) => event.preventDefault());
    retry.addEventListener("click", (event) => {
      event.preventDefault();
      this.renderer.retryNow();
    });
    status.append(text, " ", retry);
    this.wrapper.append(status);
    return status;
  }

  private showStatus(): void {
    const failures = this.renderer.failures;
    this.status.hidden = failures === 0;
    this.status.firstElementChild!.textContent = `Preview unavailable for ${failures} ${
      failures === 1 ? "block" : "blocks"
    }, shown as text.`;
  }

  destroy(detached = false): void {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    editors.delete(this);
    clearInterval(this.timer);
    this.resizes.disconnect();
    this.renderer.destroy();
    this.bar.removeEventListener("mousedown", this.onBarMouseDown);
    this.bar.removeEventListener("click", this.onBarClick);
    window.removeEventListener("click", this.onWindowClick, true);
    this.view.destroy();
    this.wrapper.remove();
    this.removeButtons();
    this.root.classList.remove("rme-active");
    this.onDestroy(detached);
  }
}

/** Adds the editor and its toggle button to a remarkup control. */
export function enhance(textarea: HTMLTextAreaElement): void {
  if (textarea.dataset.rmeEnhanced) {
    return;
  }
  const root = textarea.closest<HTMLElement>(CONTROL);
  const bar = root?.querySelector(TOOLBAR);
  if (!root || !bar || textarea.disabled || root.classList.contains("disabled-control")) {
    return;
  }
  textarea.dataset.rmeEnhanced = "1";

  let editor: LiveEditor | null = null;
  const toggle = toolbarButton({
    title:
      __TARGET__ === "phorge"
        ? `Phizziwig: edit the text while it looks like the preview; for good in Settings → Phlair (${__BUILD__})`
        : `Phizziwig: edit the text while it looks like the preview (${__BUILD__})`,
    icon: "fa-magic",
    className: "remarkup-assist-right rme-toggle rme-own",
    run: () => {
      const enabled = !editor;
      enabledChoice.set(enabled ? "1" : "0");
      update(enabled);
      if (editor) {
        editor.view.focus();
      } else {
        textarea.focus();
      }
    },
  });
  const update = (enabled: boolean) => {
    if (enabled && !editor) {
      editor = new LiveEditor(textarea, root, (detached) => {
        editor = null;
        toggle.classList.remove("preview-active");
        if (detached) {
          // Phorge removed the form; if it puts it back, start anew.
          toggle.remove();
          delete textarea.dataset.rmeEnhanced;
        }
      });
    } else if (!enabled && editor) {
      editor.destroy();
    }
    toggle.classList.toggle("preview-active", enabled);
  };
  bar.append(toggle);
  update(enabledChoice.get() === "1");
}
