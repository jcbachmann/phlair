// SharePoint and OneDrive links to files in rendered text keep their text,
// and get an icon of the kind of file and a tooltip with what the URL tells
// about the file. Where there is more than one way to open one (the file in
// the browser or in Word, Excel or PowerPoint; its location in the browser or,
// with the option "onedriphe" on Windows, in Explorer), a click shows them in a
// menu; with one way, the link is a link as any. While an app starts, a note
// under the link tells so, and what to do if nothing happens. Links Phorge
// broke (":x:" became "❌", without the Phlair library's rule) are repaired.

import { type DropdownItem, showDropdown } from "../dropdown";
import { option } from "../tools";
import {
  repairShareLink,
  sharePointDescription,
  sharePointIcon,
  sharePointLink,
  type SharePointLink,
} from "./sharepoint";

/** The link scheme of OneDriphe, Phlair's helper for Windows (phorge/onedriphe/README.md). */
export const ONEDRIPHE = "onedriphe:";

/** Phlair's settings in Phorge, where OneDriphe's installer is. */
const SETTINGS = "/settings/panel/phlair/";

/** A way to open a link. */
export interface OpenWay {
  /** What it opens, the heading of its group in the menu: "Open file", "Open folder" or "Open file location". */
  group: string;
  /** Where it opens it: "In the browser", "In Excel", "In Explorer". */
  label: string;
  icon: string;
  href: string;
  /** The app it starts ("Excel", "Explorer"); without one, the browser opens the page. */
  app?: string;
}

const enhanced = new WeakSet<HTMLAnchorElement>();
const waysOf = new WeakMap<HTMLAnchorElement, OpenWay[]>();

/** The links of rendered text, not of the editor (which does its own, see enhanceSharePointLink()). */
export function enhanceSharePointLinks(root: ParentNode): void {
  for (const anchor of Array.from(root.querySelectorAll<HTMLAnchorElement>(".phabricator-remarkup a[href]"))) {
    if (!anchor.closest(".rme-editor")) {
      enhanceSharePointLink(anchor);
    }
  }
}

/** Shows a link as a SharePoint link, if it is one: in rendered text, and in the editor's rendering of a link. */
export function enhanceSharePointLink(anchor: HTMLAnchorElement): void {
  if (enhanced.has(anchor)) {
    return;
  }
  enhanced.add(anchor);
  const written = anchor.getAttribute("href")!;
  const href = repairShareLink(written);
  const link = sharePointLink(href);
  if (!link) {
    return;
  }
  if (href !== written) {
    anchor.setAttribute("href", href);
    // Phorge shows a link without a name with its URI.
    if (anchor.textContent === written) {
      anchor.dataset.phizziwigText = written;
      anchor.textContent = href;
    }
  }
  anchor.classList.add("phizziwig-sharepoint");
  anchor.prepend(icon(`${sharePointIcon(link)} phizziwig-sharepoint-icon`));
  const ways = openWays(link, href);
  anchor.title = sharePointDescription(link) + (ways.length > 1 ? "\nClick to choose how to open it" : "");
  if (ways.length > 1) {
    waysOf.set(anchor, ways);
    anchor.setAttribute("aria-haspopup", "menu");
    anchor.setAttribute("aria-expanded", "false");
    anchor.addEventListener("click", (event) => {
      // In the editor a click edits, and Ctrl+click shows the menu (see openLink.ts).
      if (
        event.defaultPrevented ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey ||
        anchor.closest(".rme-editor")
      ) {
        return;
      }
      event.preventDefault();
      showOpenWays(anchor);
    });
  }
}

/**
 * The ways to open a SharePoint link, in two groups, as Explorer names them:
 * the file or folder itself ("Open file": in the browser, the link itself
 * first; in Word, Excel or PowerPoint where they may be installed), and
 * where a file is ("Open file location": its folder in SharePoint, where the
 * URL has its path; in Explorer, the file selected). A folder opens in
 * Explorer itself ("Open folder"). Explorer needs OneDriphe, and the path,
 * which sharing links do not have.
 */
export function openWays(link: SharePointLink, href: string): OpenWay[] {
  const folder = link.kind === "folder";
  const itself = folder ? "Open folder" : "Open file";
  const location = "Open file location";
  const ways: OpenWay[] = [{ group: itself, label: "In the browser", icon: "fa-globe", href }];
  if (link.desktop && hasDesktopOffice()) {
    const app = link.desktop.app;
    ways.push({ group: itself, label: `In ${app}`, icon: sharePointIcon(link), href: link.desktop.uri, app });
  }
  if (link.folderUrl) {
    ways.push({ group: location, label: "In the browser", icon: "fa-globe", href: link.folderUrl });
  }
  if (link.fileUrl && option("onedriphe") && isWindows()) {
    ways.push({
      group: folder ? itself : location,
      label: "In Explorer",
      icon: "fa-folder-open-o",
      href: ONEDRIPHE + link.fileUrl,
      app: "Explorer",
    });
  }
  return ways;
}

/** Shows the menu of the ways to open a link; false if it has none (one way: it is a plain link). */
export function showOpenWays(anchor: HTMLAnchorElement): boolean {
  const ways = waysOf.get(anchor);
  if (!ways) {
    return false;
  }
  const items: DropdownItem[] = [];
  for (const [index, way] of ways.entries()) {
    if (way.group !== ways[index - 1]?.group) {
      items.push({ label: way.group, heading: true });
    }
    items.push({ label: way.label, icon: way.icon, run: () => follow(anchor, way) });
  }
  const rect = anchor.getClientRects()[0] ?? anchor.getBoundingClientRect();
  showDropdown(rect.left, rect.bottom, items, "phizziwig-sharepoint-menu", false, anchor);
  return true;
}

/** Opens a way: a page as the link opens it (Phorge's open in a new tab), an app with a note while it starts. */
function follow(anchor: HTMLAnchorElement, way: OpenWay): void {
  const go = document.createElement("a");
  go.href = way.href;
  if (!way.app && anchor.target) {
    go.target = anchor.target;
    go.rel = "noopener noreferrer";
  }
  document.body.append(go);
  go.click();
  go.remove();
  if (way.app) {
    showOpening(anchor, way);
  }
}

let note: { element: HTMLElement; close: () => void } | null = null;

/** Closes the note of an app that starts, if one is open. */
export function closeOpeningNote(): void {
  note?.close();
}

/**
 * A note under the link while an app starts, which takes some seconds: it
 * goes when the app takes the focus from the browser. If that has not
 * happened after a few seconds, it tells what to do.
 */
function showOpening(anchor: HTMLAnchorElement, way: OpenWay): void {
  closeOpeningNote();
  const element = document.createElement("div");
  element.className = "phizziwig-sharepoint-note";
  element.setAttribute("role", "status");
  const text = document.createElement("span");
  text.textContent = `Opening in ${way.app}…`;
  element.append(icon("fa-spinner ph-spin"), text);
  document.body.append(element);
  const rect = anchor.getClientRects()[0] ?? anchor.getBoundingClientRect();
  element.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - element.offsetWidth - 8)) + window.scrollX}px`;
  element.style.top = `${rect.bottom + 4 + window.scrollY}px`;

  const help = window.setTimeout(() => showHelp(element, anchor, way), HELP_AFTER);
  const end = window.setTimeout(close, CLOSE_AFTER);
  // The app took the focus, or the page is hidden (OneDriphe opened a tab of the browser): it opened.
  window.addEventListener("blur", close);
  document.addEventListener("visibilitychange", close);
  document.addEventListener("mousedown", outside, true);
  function outside(event: MouseEvent): void {
    if (!element.contains(event.target as Node)) {
      close();
    }
  }
  function close(): void {
    window.clearTimeout(help);
    window.clearTimeout(end);
    window.removeEventListener("blur", close);
    document.removeEventListener("visibilitychange", close);
    document.removeEventListener("mousedown", outside, true);
    element.remove();
    if (note?.element === element) {
      note = null;
    }
  }
  note = { element, close };
}

/** How long the note waits for the app before it tells what to do, and how long it stays. */
export const HELP_AFTER = 5_000;
const CLOSE_AFTER = 60_000;

function showHelp(element: HTMLElement, anchor: HTMLAnchorElement, way: OpenWay): void {
  element.classList.add("phizziwig-sharepoint-note-help");
  const explorer = way.app === "Explorer";
  const text = document.createElement("span");
  text.append(
    "Nothing happening? If the browser asks, allow it to open ",
    explorer ? "OneDriphe" : way.app!,
    `. Without ${explorer ? "OneDriphe" : way.app} on this computer: `,
  );
  const next = document.createElement("a");
  if (explorer) {
    next.href = SETTINGS;
    next.textContent = "install it";
  } else {
    next.href = anchor.href;
    next.target = anchor.target;
    next.rel = "noopener noreferrer";
    next.textContent = "open it in the browser";
  }
  text.append(next, ".");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "phizziwig-sharepoint-note-close";
  close.setAttribute("aria-label", "Close");
  close.append(icon("fa-times"));
  close.addEventListener("click", closeOpeningNote);
  next.addEventListener("click", closeOpeningNote);
  element.replaceChildren(icon("fa-question-circle"), text, close);
}

/**
 * Undoes the changes in a copy of rendered text, so its text is Phorge's
 * (checkboxes.ts compares an item's text with Phorge's rendering): the icons
 * go, and repaired links show what Phorge showed.
 */
export function asRendered(copy: Element): void {
  copy.querySelectorAll(".phizziwig-sharepoint-icon").forEach((added) => added.remove());
  copy.querySelectorAll<HTMLElement>("[data-phizziwig-text]").forEach((link) => {
    link.textContent = link.dataset.phizziwigText!;
  });
}

function icon(classes: string): HTMLElement {
  const span = document.createElement("span");
  span.className = `phui-icon-view phui-font-fa ${classes}`;
  span.setAttribute("aria-hidden", "true");
  return span;
}

/** Whether Office's apps may be installed: there are none for Linux (Android has them). */
function hasDesktopOffice(): boolean {
  const agent = navigator.userAgent;
  return !/Linux|CrOS/.test(agent) || /Android/.test(agent);
}

/** Whether OneDriphe may be installed: it is for Windows. */
function isWindows(): boolean {
  return /Windows NT/.test(navigator.userAgent);
}
