// Talks to the Phorge server the page came from, with the user's session,
// the same way the page's own Javascript does, and knows its page structure.

/** The remarkup control: toolbar, textarea and the metadata input. */
export const CONTROL = '[data-sigil~="remarkup-assist-control"]';
export const TOOLBAR = ".remarkup-assist-bar";
export const TEXTAREA = "textarea.remarkup-assist-textarea";

/**
 * The address of an image Phorge makes on request, like a meme that is
 * not made yet: what its "remarkup-load-image" behavior does.
 */
export async function loadImage(uri: string): Promise<string> {
  const { payload } = await post(uri, {});
  return (payload as { imageURI: string }).imageURI;
}

/**
 * An image of pasted HTML, for uploading it: inline ("data:"), from this
 * site, or from another one if it can be read from there (see
 * crossOriginImage()). Installed in Phorge, the server stores images of
 * other sites itself and this returns the file. Throws if it can not be had.
 */
export async function fetchImage(src: string, name: string): Promise<Blob | UploadedFile> {
  const url = new URL(src, location.href);
  let blob: Blob | null;
  if (url.protocol !== "data:" && url.origin !== location.origin && __TARGET__ === "phorge") {
    // Not past the page's CSP, and not limited to sites that allow it (CORS).
    // The server follows redirects and may wait for slow sites.
    const file = (await conduit("phizziwig.download", { uri: url.href, name }, 120_000)) as UploadedFile;
    return { id: file.id, phid: file.phid };
  }
  if (url.protocol === "data:") {
    blob = dataBlob(src);
  } else if (url.origin === location.origin) {
    const response = await pageFetch(url.href, { credentials: "same-origin", signal: AbortSignal.timeout(30_000) });
    blob = response.ok ? await response.blob() : null;
  } else {
    blob = await crossOriginImage(url.href);
  }
  if (!blob?.type.startsWith("image/")) {
    throw new Error(`Not an image: ${src.slice(0, 80)}`);
  }
  return blob;
}

/** The content of a "data:" URL; not fetched, as the page's CSP ("connect-src") may forbid that. */
function dataBlob(src: string): Blob | null {
  const match = /^data:([^;,]*)((?:;[^;,]*)*?)(;base64)?,(.*)$/is.exec(src);
  if (!match) {
    return null;
  }
  const text = match[3] ? atob(match[4].replace(/\s+/g, "")) : decodeURIComponent(match[4]);
  const bytes = match[3] ? Uint8Array.from(text, (c) => c.charCodeAt(0)) : new TextEncoder().encode(text);
  return new Blob([bytes], { type: match[1] });
}

/**
 * An image from another site. Phorge's CSP ("connect-src 'self'") forbids
 * the page to fetch it. The userscript asks its manager instead, which is not
 * bound by CSP or CORS ("@grant GM.xmlHttpRequest"). The extension fetches it
 * in its content script, which the page's CSP does not cover; the site must
 * allow that by CORS (Wikipedia does).
 */
async function crossOriginImage(url: string): Promise<Blob | null> {
  const request =
    (typeof GM !== "undefined" && GM?.xmlHttpRequest) ||
    (typeof GM_xmlhttpRequest !== "undefined" && GM_xmlhttpRequest) ||
    null;
  if (!request) {
    const response = await fetch(url, { credentials: "omit", signal: AbortSignal.timeout(30_000) });
    return response.ok ? response.blob() : null;
  }
  const response = await new Promise<GmResponse>((resolve, reject) => {
    request({
      method: "GET",
      url,
      responseType: "blob",
      anonymous: true,
      timeout: 30_000,
      onload: resolve,
      onerror: () => reject(new Error(`Could not load ${url.slice(0, 80)}`)),
      ontimeout: () => reject(new Error(`Timeout loading ${url.slice(0, 80)}`)),
    });
  });
  if (response.status < 200 || response.status >= 300) {
    return null;
  }
  // Some managers leave the type of the blob empty.
  const type = response.response.type || /^content-type:\s*([^;\r\n]+)/im.exec(response.responseHeaders)?.[1] || "";
  return response.response.type ? response.response : new Blob([response.response], { type: type.trim() });
}

/** A file of this Phorge shown by an image of pasted HTML, with the options of its embed ("{F12, size=full}"). */
export interface EmbeddedFile {
  id: number | null;
  phid: string | null;
  options: string;
}

/**
 * The file of this Phorge that an image of pasted HTML shows, e.g. of a
 * task's description copied: by its monogram (on the editor's rendered
 * blocks), or by the PHID in the address its link leads to (the original;
 * the image itself may be a thumbnail, another file) or in its own. Null for
 * images of other sites.
 */
export function embeddedFile(img: Element): EmbeddedFile | null {
  const here = (url: string | null | undefined) => {
    try {
      const parsed = url ? new URL(url, location.href) : null;
      return parsed?.origin === location.origin ? parsed.pathname : null;
    } catch {
      return null;
    }
  };
  const phidIn = (url: string | null | undefined) => /\/(PHID-FILE-[a-z0-9]+)\//.exec(here(url) ?? "")?.[1] ?? null;
  const link = img.closest("a[href]");
  const href = link?.getAttribute("href");
  const monogram = link?.getAttribute("data-rme-file") ?? /^\/(F\d+)$/.exec(here(href) ?? "")?.[1];
  const phid = phidIn(href) ?? phidIn(img.getAttribute("src"));
  if (!monogram && !phid) {
    return null;
  }
  const size = /phabricator-remarkup-embed-image-(full|wide)/.exec(link?.className ?? "")?.[1];
  const wrapper = img.closest('[class*="phabricator-remarkup-embed-layout-"]')?.className ?? "";
  const layout = /phabricator-remarkup-embed-layout-(\w+)/.exec(wrapper)?.[1];
  const options = [
    size && `size=${size}`,
    layout && layout !== "left" && `layout=${layout}`,
    /phabricator-remarkup-embed-float/.test(wrapper) && "float",
  ].filter(Boolean);
  return {
    id: monogram ? Number(monogram.slice(1)) : null,
    phid,
    options: options.map((option) => `, ${option}`).join(""),
  };
}

/** A file by its PHID. */
export async function fileByPhid(phid: string): Promise<UploadedFile> {
  const result = (await conduit("file.search", { constraints: { phids: [phid] } })) as {
    data: { id: number; phid: string }[];
  };
  if (!result.data[0]) {
    throw new Error(`No file ${phid}`);
  }
  return { id: result.data[0].id, phid: result.data[0].phid, existing: true };
}

/** Phorge's toolbar button with a Font Awesome icon, e.g. "fa-cloud-upload". */
export function nativeButton(textarea: HTMLTextAreaElement, icon: string): HTMLElement | null {
  const bar = textarea.closest(CONTROL)?.querySelector(TOOLBAR);
  return bar?.querySelector(`.remarkup-assist.${icon}`)?.closest<HTMLElement>(".remarkup-assist-button") ?? null;
}

/** Notifies Phorge's listeners (drafts, previews) of a change of the textarea. */
export function notifyChange(textarea: HTMLTextAreaElement): void {
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
  textarea.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true }));
}

// In a Firefox content script, content.fetch() sends requests as the page.
const pageFetch: typeof fetch = (globalThis as { content?: { fetch: typeof fetch } }).content?.fetch ?? fetch;

function csrfToken(): string {
  // The page refreshes all "__csrf__" inputs every 55 minutes.
  return document.querySelector<HTMLInputElement>('input[name="__csrf__"]')?.value ?? "";
}

interface AjaxResponse {
  payload: unknown;
  /** Javelin metadata of the response; data-meta="0_<index>" refers to it. */
  metadata: unknown[];
  /** Javelin behaviors to start, with their configurations, by name. */
  behaviors: Record<string, unknown[]>;
}

/** Parses a Javelin response ("for (;;);{...}"). */
function parseAjaxResponse(text: string): AjaxResponse {
  const json = JSON.parse(text.replace(/^for \(;;\);/, ""));
  if (json.error) {
    throw new Error(`Phorge: ${JSON.stringify(json.error)}`);
  }
  return { payload: json.payload, metadata: json.javelin_metadata ?? [], behaviors: json.javelin_behaviors ?? {} };
}

async function requestWithMetadata(
  path: string,
  init: RequestInit,
  query: Record<string, string> = {},
): Promise<AjaxResponse> {
  const url = new URL(path, location.origin);
  // Paths may come from the server's responses (loadImage): the session and
  // the CSRF token go to this Phorge only.
  if (url.origin !== location.origin) {
    throw new Error(`Not a path of this Phorge: ${path}`);
  }
  url.searchParams.set("__ajax__", "true");
  for (const [key, value] of Object.entries(query)) {
    url.searchParams.set(key, value);
  }
  const response = await pageFetch(url.toString(), {
    credentials: "same-origin",
    // A hanging request would keep its blocks waiting forever.
    signal: AbortSignal.timeout(init.method === "POST" && init.body instanceof Blob ? 300_000 : 15_000),
    ...init,
    headers: { "X-Phabricator-Csrf": csrfToken(), ...init.headers },
  });
  if (!response.ok) {
    throw new Error(`Phorge: ${response.status} for ${path}`);
  }
  return parseAjaxResponse(await response.text());
}

async function request(path: string, init: RequestInit, query: Record<string, string> = {}): Promise<unknown> {
  return (await requestWithMetadata(path, init, query)).payload;
}

async function post(
  path: string,
  params: Record<string, string>,
  query: Record<string, string> = {},
): Promise<AjaxResponse> {
  return requestWithMetadata(
    path,
    { method: "POST", body: new URLSearchParams({ __csrf__: csrfToken(), ...params }) },
    query,
  );
}

export interface Rendered {
  html: string;
  metadata: unknown[];
  behaviors: Record<string, unknown[]>;
}

/** Renders remarkup to HTML like the preview of the given textarea. */
export type RenderFunction = (text: string) => Promise<Rendered>;

/** The slug of the wiki page a textarea edits, or null. */
export function wikiSlug(textarea: HTMLTextAreaElement): string | null {
  const slug = textarea.form?.querySelector<HTMLInputElement>('input[name="slug"]')?.value;
  return slug !== undefined && /\/phriction\//.test(textarea.form?.action ?? "") ? slug : null;
}

export function rendererFor(textarea: HTMLTextAreaElement): RenderFunction {
  // Wiki pages render relative links like "[[ ./child ]]" relative to the page.
  const slug = wikiSlug(textarea);
  if (slug !== null) {
    return async (text) => {
      const { payload, metadata, behaviors } = await post("/phriction/preview/", { text, slug });
      return { html: payload as string, metadata, behaviors };
    };
  }
  return async (text) => {
    const { payload, metadata, behaviors } = await post("/transactions/remarkuppreview/", { text });
    return { html: (payload as { content: string }).content, metadata, behaviors };
  };
}

/**
 * Submits the form like Ctrl/Cmd+Enter in the textarea does. Phorge only
 * reacts to that key in a textarea, so send it there.
 */
export function submitForm(textarea: HTMLTextAreaElement): boolean {
  // Phorge submits it as a workflow, without a submit event (see addAttachedFile()).
  const phids = attached.get(textarea);
  if (phids) {
    writeAttached(textarea, phids);
  }
  textarea.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, ctrlKey: true, bubbles: true, cancelable: true }),
  );
  return true;
}

export interface TypeaheadResult {
  displayName: string;
  uri: string;
  /** Font Awesome classes, e.g. "fa-user bluegrey". */
  icon: string;
  /** Color of the availability dot of users, e.g. "red". */
  availabilityColor: string;
  /** The text to insert, e.g. "@alice" or "[[ wiki/page/ ]]". */
  autocomplete: string;
  closed: boolean;
}

/**
 * Queries a typeahead datasource, e.g. "PhabricatorPeopleDatasource". Results
 * without autocomplete text (like "jump" results) only come with "all".
 */
export async function typeahead(
  datasource: string,
  query: string,
  parameters?: Record<string, unknown>,
  all = false,
): Promise<TypeaheadResult[]> {
  const params: Record<string, string> = { q: query, raw: query };
  if (parameters) {
    params.parameters = JSON.stringify(parameters);
  }
  const payload = (await request(`/typeahead/class/${datasource}/`, { method: "GET" }, params)) as unknown[][];
  // See PhabricatorTypeaheadResult::getWireFormat().
  const text = (value: unknown) => (value == null ? "" : String(value));
  return payload
    .map((r) => ({
      displayName: text(r[4] ?? r[0]),
      uri: text(r[1]),
      icon: text(r[8]),
      availabilityColor: text(r[16]),
      autocomplete: text(r[14]),
      closed: Boolean(r[9]),
    }))
    .filter((r) => all || r.autocomplete !== "");
}

/**
 * Calls a Conduit method with the user's web session, like Phorge's
 * Conduit console does.
 */
export async function conduit(method: string, params: Record<string, unknown>, timeout = 15_000): Promise<unknown> {
  const response = await pageFetch(new URL(`/api/${method}`, location.origin).toString(), {
    method: "POST",
    credentials: "same-origin",
    signal: AbortSignal.timeout(timeout),
    body: new URLSearchParams({ params: JSON.stringify(params), output: "json", __csrf__: csrfToken() }),
  });
  if (!response.ok) {
    throw new Error(`Phorge: ${response.status} for ${method}`);
  }
  const json = (await response.json()) as { result: unknown; error_code: string | null; error_info: string | null };
  if (json.error_code) {
    throw new Error(`Phorge: ${json.error_code} ${json.error_info ?? ""}`);
  }
  return json.result;
}

export interface UploadedFile {
  id: number;
  phid: string;
  /**
   * A file that was on the server before (e.g. of a pasted image of this
   * Phorge): it is only referenced. Attaching it would let everyone who can
   * see the object see the file.
   */
  existing?: true;
}

/** Phorge stores larger files in chunks of this size (PhabricatorChunkedFileStorageEngine). */
const CHUNK = 4 * 1024 * 1024;

/**
 * Uploads a file like dropping it on a remarkup textarea does: a file larger
 * than a chunk in chunks, which servers take whatever their limit of a
 * request's size (see JX.PhabricatorDragAndDropFileUpload). Tells the share
 * uploaded so far, of chunked files.
 */
export async function uploadFile(file: File, progress?: (done: number) => void): Promise<UploadedFile> {
  const name = file.name || "pasted-file";
  const query = { name, length: String(file.size) };
  if (file.size > CHUNK) {
    // Without a storage engine for chunks the server answers without a PHID: then in one piece.
    const allocated = (await post("/file/dropupload/", {}, { ...query, allocate: "1" })).payload as {
      upload: boolean;
      id?: number;
      phid?: string;
    };
    if (allocated.phid) {
      const phid = allocated.phid;
      if (!allocated.upload) {
        return { id: allocated.id!, phid };
      }
      const chunks = (await post("/file/dropupload/", {}, { ...query, phid, querychunks: "1" })).payload as {
        byteStart: string | number;
        byteEnd: string | number;
        complete: boolean;
      }[];
      let done = chunks.filter((chunk) => chunk.complete).length;
      for (const chunk of chunks.filter((chunk) => !chunk.complete)) {
        const start = Number(chunk.byteStart);
        const result = (await request(
          "/file/dropupload/",
          { method: "POST", body: file.slice(start, Number(chunk.byteEnd)) },
          { ...query, phid, uploadchunk: "1", __upload__: "1", byteStart: String(start) },
        )) as { complete?: boolean; id?: number };
        progress?.(++done / chunks.length);
        if (result.complete) {
          return { id: result.id!, phid };
        }
      }
      throw new Error(`Phorge: the upload of ${name} did not complete`);
    }
  }
  const payload = (await request(
    "/file/dropupload/",
    { method: "POST", body: file },
    { ...query, __upload__: "1" },
  )) as UploadedFile;
  return { id: payload.id, phid: payload.phid };
}

/**
 * Records a file uploaded from this text so it is attached to the object on
 * save, like Phorge does for files dropped on the textarea. Not for existing
 * files (UploadedFile.existing).
 */
export function addAttachedFile(textarea: HTMLTextAreaElement, phid: string): void {
  let phids = attached.get(textarea);
  if (!phids) {
    attached.set(textarea, (phids = new Set()));
    // First on submitting, before Phorge's own handlers (Javelin listens on the document).
    window.addEventListener("submit", reattach, true);
  }
  phids.add(phid);
  writeAttached(textarea, phids);
}

/**
 * The files Phizziwig attached, by textarea. Phorge's own upload button
 * rewrites the metadata input from what it knows, without them; they are
 * written in again when the form is submitted.
 */
const attached = new WeakMap<HTMLTextAreaElement, Set<string>>();

function reattach(event: Event): void {
  if (event.target instanceof HTMLFormElement) {
    for (const textarea of Array.from(event.target.querySelectorAll("textarea"))) {
      const phids = attached.get(textarea);
      if (phids) {
        writeAttached(textarea, phids);
      }
    }
  }
}

function writeAttached(textarea: HTMLTextAreaElement, phids: Set<string>): void {
  // The control renders the metadata input next to its textarea.
  const input = textarea.parentElement?.querySelector<HTMLInputElement>(
    `input[name="${CSS.escape(textarea.name)}_metadata"]`,
  );
  if (!input) {
    return;
  }
  try {
    const metadata = JSON.parse(input.value || "{}");
    metadata.attachedFilePHIDs = [...new Set([...(metadata.attachedFilePHIDs ?? []), ...phids])];
    input.value = JSON.stringify(metadata);
  } catch (error) {
    // The file is referenced in the text all the same, only not attached.
    console.warn("Phizziwig: the form's metadata is not JSON", error);
  }
}
