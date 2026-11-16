// SharePoint and OneDrive links to files and folders: what a link's URL tells
// about the file (its kind, and its name, site and folder where the URL has
// them), the name a pasted link gets, and the link to open a document in its
// desktop app. Links to other pages of SharePoint are none of these.
//
// Sharing links ("Copy link": https://x.sharepoint.com/:x:/s/Site/EaB3…?e=…)
// name only the kind of file and the site; the file itself is a token that
// only SharePoint resolves, for users who may see it. Links copied from the
// browser's address bar have the file's path or name in them.

import { EMOJI } from "./emoji";

/** The start of a sharing link, up to its kind of file ("/:x:/"). */
export const SHARE_LINK = /https?:\/\/[A-Za-z0-9-]+\.sharepoint\.com\/:[A-Za-z]:\//;

export type SharePointKind =
  "word" | "excel" | "powerpoint" | "onenote" | "pdf" | "folder" | "video" | "image" | "text" | "file";

export interface SharePointLink {
  kind: SharePointKind;
  /** The name of the file, folder or page, if the URL has it. */
  name?: string;
  /** The name of the site in its URL, or "OneDrive". */
  site?: string;
  /** The folder of the file in the site ("Shared Documents/Plans"), if the URL has its path. */
  folder?: string;
  /** The file's own URL (its path on the site), if the URL tells it. */
  fileUrl?: string;
  /** The URL of a file's folder, which SharePoint shows, if the URL has the file's path. */
  folderUrl?: string;
  /** Opens a Word, Excel or PowerPoint file in the desktop app ("ms-excel:ofe|u|…"). */
  desktop?: { app: string; uri: string };
}

/** The kind of file of a sharing link, by its letter ("/:x:/"). */
const SHARE_KINDS: Record<string, SharePointKind> = {
  w: "word",
  x: "excel",
  p: "powerpoint",
  o: "onenote",
  b: "pdf",
  f: "folder",
  v: "video",
  i: "image",
  t: "text",
};

const EXTENSION_KINDS: Record<string, SharePointKind> = {};
for (const [kind, extensions] of Object.entries({
  word: "doc docx docm dot dotx dotm odt rtf",
  excel: "xls xlsx xlsm xlsb xlt xltx xltm csv ods",
  powerpoint: "ppt pptx pptm pps ppsx pot potx odp",
  onenote: "one onetoc2",
  pdf: "pdf",
  video: "mp4 m4v mov avi wmv mkv webm",
  image: "png jpg jpeg gif bmp svg webp heic tif tiff",
  text: "txt md log",
})) {
  for (const extension of extensions.split(" ")) {
    EXTENSION_KINDS[extension] = kind as SharePointKind;
  }
}

/** The desktop apps of Office and their URI schemes. */
const DESKTOP: Partial<Record<SharePointKind, { app: string; scheme: string }>> = {
  word: { app: "Word", scheme: "ms-word" },
  excel: { app: "Excel", scheme: "ms-excel" },
  powerpoint: { app: "PowerPoint", scheme: "ms-powerpoint" },
};

const KIND_NAMES: Record<SharePointKind, string> = {
  word: "Word document",
  excel: "Excel workbook",
  powerpoint: "PowerPoint presentation",
  onenote: "OneNote notebook",
  pdf: "PDF",
  folder: "Folder",
  video: "Video",
  image: "Image",
  text: "Text file",
  file: "File",
};

/** Font Awesome 4 icons (Phorge's) of the kinds. */
const KIND_ICONS: Record<SharePointKind, string> = {
  word: "fa-file-word-o",
  excel: "fa-file-excel-o",
  powerpoint: "fa-file-powerpoint-o",
  onenote: "fa-book",
  pdf: "fa-file-pdf-o",
  folder: "fa-folder-o",
  video: "fa-file-video-o",
  image: "fa-file-image-o",
  text: "fa-file-text-o",
  file: "fa-file-o",
};

const HOST = /^[a-z0-9-]+\.sharepoint\.com$/i;

/** What a URL tells about a SharePoint or OneDrive file, or null if it is no SharePoint link. */
export function sharePointLink(href: string): SharePointLink | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || !HOST.test(url.hostname)) {
    return null;
  }
  const segments = url.pathname.split("/").slice(1).map(decode);
  if (segments[segments.length - 1] === "") {
    segments.pop();
  }
  const share = /^:([a-z]):$/i.exec(segments[0] ?? "");
  if (!share) {
    return pathLink(url, segments, false);
  }
  const kind = SHARE_KINDS[share[1].toLowerCase()] ?? "file";
  // "/:x:/r/<path>" has the file's path; "/:x:/s/<site>/<token>" (also t,
  // g, u) only the site.
  if (segments[1] === "r") {
    const link = pathLink(url, segments.slice(2), kind === "folder");
    return link?.name ? link : { kind, site: siteOf(segments.slice(2)) };
  }
  return { kind, site: siteOf(segments.slice(1)), desktop: desktopOf(kind, href) };
}

/**
 * A link to a file by its path (the segments, decoded), or to a page that
 * shows a file or folder ("Doc.aspx?…&file=Budget.xlsx", "AllItems.aspx?id=/sites/X/Shared Documents/a.pdf");
 * null for other pages (a person, a site's page, a list). A path without an
 * extension is a folder only where the URL says so ("folder").
 */
function pathLink(url: URL, segments: string[], folder: boolean): SharePointLink | null {
  const last = segments[segments.length - 1] ?? "";
  if (/\.aspx$/i.test(last)) {
    const id = url.searchParams.get("id");
    if (id?.startsWith("/")) {
      return fileLink(url, id.split("/").slice(1), !kindOfName(id));
    }
    // Office's viewers, of a document the URL has the name of, or only an ID ("sourcedoc").
    if (/^(doc|wopiframe2?|xlviewer|wordviewer)\.aspx$/i.test(last)) {
      const file = url.searchParams.get("file") || undefined;
      return { kind: (file && kindOfName(file)) || "file", name: file, site: siteOf(segments) };
    }
    return null;
  }
  if (kindOfName(last) || (folder && last)) {
    return fileLink(url, segments, !kindOfName(last));
  }
  return null;
}

/** A file or folder by its path (the segments, decoded). */
function fileLink(url: URL, segments: string[], folder: boolean): SharePointLink {
  const name = segments[segments.length - 1];
  const kind = folder ? "folder" : (kindOfName(name) ?? "file");
  const urlOf = (path: string[]) => url.origin + "/" + path.map(encodeURIComponent).join("/");
  const fileUrl = urlOf(segments);
  // The path within the site: after "sites/<site>/" (also "teams", and "personal/<user>/" of OneDrive).
  const inSite = /^(sites|teams|personal)$/.test(segments[0] ?? "") ? 2 : 0;
  const path = segments.slice(inSite, -1).join("/") || undefined;
  // A file's folder, if it is in one of the site (not the site itself).
  const folderUrl = !folder && path ? urlOf(segments.slice(0, -1)) + "/" : undefined;
  return { kind, name, site: siteOf(segments), folder: path, fileUrl, folderUrl, desktop: desktopOf(kind, fileUrl) };
}

/** The site of a path: "sites/<name>/…" or "teams/<name>/…", or "OneDrive" for "personal/<user>/…". */
function siteOf(segments: string[]): string | undefined {
  if (segments[0] === "personal" || (segments[0] === "g" && segments[1] === "personal")) {
    return "OneDrive";
  }
  // Of sharing links: "s/<site>", "t/<site>", "g/<site>"; of paths: "sites/<site>", "teams/<site>".
  if (/^(sites|teams|s|t|g)$/.test(segments[0] ?? "") && segments[1]) {
    return segments[1];
  }
  return undefined;
}

function kindOfName(name: string): SharePointKind | undefined {
  const extension = /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1].toLowerCase();
  return extension === undefined ? undefined : (EXTENSION_KINDS[extension] ?? "file");
}

function desktopOf(kind: SharePointKind, fileUrl: string): SharePointLink["desktop"] {
  const desktop = DESKTOP[kind];
  return desktop && { app: desktop.app, uri: `${desktop.scheme}:ofe|u|${fileUrl}` };
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** The name a pasted link gets: the file's name, else its kind and site ("Excel workbook in Projects"). */
export function sharePointLabel(link: SharePointLink): string {
  if (link.name) {
    return link.name;
  }
  return link.site ? `${KIND_NAMES[link.kind]} in ${link.site}` : KIND_NAMES[link.kind];
}

/**
 * What a link tells about its file, for its tooltip: the kind and name, and
 * where it is ("Excel workbook: Budget.xlsx", "in Projects › Shared Documents").
 */
export function sharePointDescription(link: SharePointLink): string {
  const what = link.name ? `${KIND_NAMES[link.kind]}: ${link.name}` : KIND_NAMES[link.kind];
  const where = [link.site, ...(link.folder?.split("/") ?? [])].filter(Boolean).join(" › ");
  return where ? `${what}\nin ${where}` : what;
}

/** The Font Awesome icon of a link's kind of file. */
export function sharePointIcon(link: SharePointLink): string {
  return KIND_ICONS[link.kind];
}

/** The emoji Phorge turns a sharing link's ":x:" into, by the letter (see PhizziwigSharePointRemarkupRule). */
const LETTER_EMOJI = Object.entries(EMOJI)
  .filter(([name]) => name.length === 1)
  .map(([letter, emoji]) => [letter, emoji.replace(/\uFE0F/g, "")] as const);

/**
 * A sharing link as written, from the link a Phorge without the Phlair
 * library rendered: its ":x:" had become "❌" (also "%E2%9D%8C"). Other URLs
 * are returned as they are.
 */
export function repairShareLink(href: string): string {
  const match = /^(https?:\/\/[A-Za-z0-9-]+\.sharepoint\.com\/)([^/]+)(\/)/.exec(href);
  if (!match) {
    return href;
  }
  const segment = decode(match[2]).replace(/\uFE0F/g, "");
  const letter = LETTER_EMOJI.find(([, emoji]) => emoji === segment)?.[0];
  return letter ? `${match[1]}:${letter}:${href.slice(match[0].length - 1)}` : href;
}
