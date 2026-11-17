// Local paths of SharePoint libraries, pasted alone, as links to SharePoint:
// "C:\Users\me\OneDrive - Contoso\Projects - Documents\Plans", as Explorer
// copies it, becomes a link to the folder "Plans" of the library, which
// everyone can open (and with OneDriphe, in Explorer). Which local folder is
// which library is the administrator's list (Config → Phlair,
// phlair.sharepoint-folders): the names the libraries' folders have on users'
// computers, the same for everyone. Paths of no listed library stay as pasted.

import { decode, kindOfName } from "./sharepoint";

/** Libraries' URLs, each with the names of its local folders ("JCB Team - Syncthing", "OneDrive - Contoso/Syncthing"). */
export type SharePointFolders = Record<string, string[]>;

let folders: SharePointFolders = {};

/** Sets the libraries (from the Phorge library's configuration); anything but such a map gives none. */
export function chooseSharePointFolders(chosen: unknown): void {
  // In one Unicode form, as pasted paths (macOS writes "ä" as "a" and "¨").
  folders = isFolders(chosen)
    ? Object.fromEntries(
        Object.entries(chosen).map(([url, names]) => [url, names.map((name) => name.normalize("NFC"))]),
      )
    : {};
}

function isFolders(value: unknown): value is SharePointFolders {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((names) => Array.isArray(names) && names.every((name) => typeof name === "string"))
  );
}

/** The link of a local path pasted alone, in a listed library: its SharePoint URL and the name of its folder or file. */
export function sharePointOfPath(text: string): { url: string; name: string } | null {
  const path = localPath(text);
  if (path === null) {
    return null;
  }
  const segments = split(path);
  // The first folder from the left that is a library's; of names there, the longest ("OneDrive - X/Syncthing"),
  // else the first listed.
  for (let start = 0; start < segments.length; start++) {
    let best: { url: string; length: number } | null = null;
    for (const [url, names] of Object.entries(folders)) {
      for (const parts of names.map(split)) {
        const matches = parts.every((part, i) => part.toLowerCase() === segments[start + i]?.toLowerCase());
        if (parts.length > (best?.length ?? 0) && matches) {
          best = { url, length: parts.length };
        }
      }
    }
    if (best) {
      const end = start + best.length;
      return libraryLink(best.url, segments.slice(end), segments[end - 1]);
    }
  }
  return null;
}

/**
 * The path of a text that is one absolute local path: of Windows ("C:\…",
 * also in the quotes of Explorer's "Copy as path"), of Linux, macOS and WSL
 * ("/…", "~/…"), or a file URL ("file:///C:/…").
 */
function localPath(text: string): string | null {
  let path = text
    .trim()
    .normalize("NFC")
    .replace(/^"([^"]*)"$/, "$1");
  if (/^file:\/\//i.test(path)) {
    try {
      const url = new URL(path);
      // Of this computer, and all of it in the path ("#" would start a fragment).
      if (url.host || url.search || url.hash) {
        return null;
      }
      // "/C:/Users/…" of Windows is absolute too.
      path = decodeURIComponent(url.pathname);
    } catch {
      return null;
    }
  }
  return /^([A-Za-z]:[\\/]|\/|~\/)/.test(path) && !/[\x00-\x1f]/.test(path) ? path : null;
}

function split(path: string): string[] {
  return path.split(/[\\/]+/).filter(Boolean);
}

/**
 * The link to a folder or file in a library, by the names below its local
 * folder, named after the last of them (else after the local folder): a file
 * by its path (shown in the browser: "?web=1"), a folder as SharePoint links
 * one (":f:/r/<path>"), which tells that it is one.
 */
function libraryLink(library: string, names: string[], folder: string): { url: string; name: string } | null {
  let url: URL;
  try {
    url = new URL(library);
  } catch {
    return null;
  }
  if (names.some((name) => name === "." || name === "..")) {
    return null;
  }
  const segments = [...url.pathname.split("/").filter(Boolean).map(decode), ...names];
  if (segments.length === 0) {
    return null;
  }
  const name = names[names.length - 1] ?? folder;
  const path = segments.map(encodeURIComponent).join("/");
  return { url: kindOfName(name) ? `${url.origin}/${path}?web=1` : `${url.origin}/:f:/r/${path}`, name };
}
