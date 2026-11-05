// Phorge's comment form while it is pinned to the bottom of the window ("Pin
// Form on Screen"): a handle at its top sets its height (remembered per
// browser). Its text scrolls inside it, below the actions and the toolbar,
// which stay in view (style.css); the submit button sits in the row of "Add
// Action...", which stays at its top (on phones as an icon). (The X that
// removes an action, which Phorge hides on phones, shows again by style.css.)

const FORM = ".phui-comment-form-view";
const PINNED = "remarkup-assist-pinned";
const HEIGHT_KEY = "phizziwig-pinned-form-height";
const MIN_HEIGHT = 120;

const watched = new WeakSet<HTMLElement>();
/** The resize handle of each pinned form, on its top border (outside of it: the form clips what is outside). */
const handles = new WeakMap<HTMLElement, { handle: HTMLElement; stop: () => void }>();
/** Where each moved submit button belongs when the form is not pinned. */
const homes = new WeakMap<HTMLElement, Comment>();

/** Watches the comment forms in or at a node for being pinned. */
export function watchCommentForms(root: ParentNode): void {
  const forms = Array.from(root.querySelectorAll<HTMLElement>(FORM));
  if (root instanceof HTMLElement && root.matches(FORM)) {
    forms.push(root);
  }
  for (const form of forms) {
    if (watched.has(form)) {
      continue;
    }
    watched.add(form);
    // Phorge pins it by its class (behavior-phabricator-remarkup-assist.js).
    new MutationObserver(() => update(form)).observe(form, { attributes: true, attributeFilter: ["class"] });
    update(form);
  }
}

function update(form: HTMLElement): void {
  const pinned = form.classList.contains(PINNED);
  const shown = handles.get(form);
  if (pinned && !shown) {
    const handle = resizeHandle(form);
    // The editor's colors, which the page has (attach.ts), outside of it.
    const editor = form.querySelector(".rme-editor");
    for (const name of ["--rme-background", "--rme-border-color"]) {
      const value = editor ? getComputedStyle(editor).getPropertyValue(name) : "";
      if (value) {
        handle.style.setProperty(name, value);
      }
    }
    document.body.append(handle);
    // On the top border, wherever it is.
    const place = () => {
      handle.style.bottom = `${form.offsetHeight - handle.offsetHeight / 2}px`;
      handle.style.zIndex = String((Number(getComputedStyle(form).zIndex) || 0) + 1);
    };
    const resizes = new ResizeObserver(place);
    resizes.observe(form);
    window.addEventListener("resize", place);
    handles.set(form, {
      handle,
      stop: () => {
        resizes.disconnect();
        window.removeEventListener("resize", place);
        handle.remove();
      },
    });
    setHeight(form, storedHeight());
    place();
  } else if (!pinned && shown) {
    shown.stop();
    handles.delete(form);
    form.style.height = "";
    form.style.maxHeight = "";
  }
  placeSubmit(form, pinned);
}

/** The submit button in the row of "Add Action..." while pinned, back below the text otherwise. */
function placeSubmit(form: HTMLElement, pinned: boolean): void {
  const bar = form.querySelector<HTMLElement>(".phui-comment-action-bar");
  const submit = form.querySelector<HTMLElement>(".phui-comment-submit-control");
  if (!bar || !submit) {
    return;
  }
  if (pinned && submit.parentElement !== bar) {
    const home = document.createComment("submit");
    submit.before(home);
    homes.set(submit, home);
    bar.append(submit);
    bar.classList.add("rme-submit-in-bar");
    // Its label, also where it shows only an icon (phones).
    const button = submit.querySelector("button");
    if (button && !button.title) {
      button.title = button.textContent?.trim() ?? "";
    }
  } else if (!pinned && submit.parentElement === bar) {
    homes.get(submit)?.replaceWith(submit);
    bar.classList.remove("rme-submit-in-bar");
  }
}

function storedHeight(): number | null {
  try {
    const height = Number(localStorage.getItem(HEIGHT_KEY));
    return height > 0 ? height : null;
  } catch {
    return null;
  }
}

/** Sets the height of the pinned form, and of Phorge's spacer that keeps the page's end above it. */
function setHeight(form: HTMLElement, height: number | null): void {
  if (height === null) {
    return;
  }
  const shown = Math.round(Math.min(Math.max(height, MIN_HEIGHT), window.innerHeight * 0.9));
  // With its border (style.css): the height it shows (offsetHeight) is the one remembered.
  form.style.height = `${shown}px`;
  form.style.maxHeight = `${shown}px`;
  const spacer = document.querySelector<HTMLElement>(".remarkup-assist-pinned-spacer");
  if (spacer) {
    spacer.style.height = `${shown}px`;
  }
}

function resizeHandle(form: HTMLElement): HTMLElement {
  const handle = document.createElement("div");
  handle.className = "rme-pinned-resize";
  handle.title = "Drag to resize the comment form";
  handle.tabIndex = 0;
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "horizontal");
  handle.setAttribute("aria-label", "Resize the comment form (Up and Down keys)");
  const save = () => {
    try {
      localStorage.setItem(HEIGHT_KEY, String(form.offsetHeight));
    } catch {
      // Blocked storage: the height lasts as long as the page.
    }
  };
  // Mouse, pen and touch alike (style.css keeps touch from scrolling the page instead).
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = form.offsetHeight;
    // On the window: the pointer leaves the handle while it drags.
    const move = (moved: PointerEvent) => {
      if (moved.pointerId === event.pointerId) {
        setHeight(form, startHeight + startY - moved.clientY);
      }
    };
    const end = (ended: PointerEvent) => {
      if (ended.pointerId !== event.pointerId) {
        return;
      }
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      save();
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
  });
  handle.addEventListener("keydown", (event) => {
    const step = { ArrowUp: 40, ArrowDown: -40 }[event.key];
    if (step) {
      event.preventDefault();
      setHeight(form, form.offsetHeight + step);
      save();
    }
  });
  return handle;
}
