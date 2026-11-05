import { loadImage, type Rendered, type RenderFunction } from "./phorge";
import { escapeText, parseHtml } from "./html";

const MIN_CACHE = 1000;
/** How many blocks are rendered at once when a batch failed. */
const SINGLE_REQUESTS = 4;
const MAX_BATCH_CHARS = 200_000;
/** Delays before retrying a block that failed to render, growing per failure. */
const RETRY_DELAYS = [2_000, 5_000, 15_000, 60_000];

/** A block to render. The last block of a text renders differently: see BlockRenderer. */
export interface RenderItem {
  text: string;
  last: boolean;
}

/**
 * Renders remarkup blocks with the server and caches the HTML by block text.
 *
 * Blocks are rendered in batches: the texts are joined with a separator
 * paragraph and the resulting HTML is split at the separators. Each text is a
 * complete top-level block, so the server renders it like in the full text.
 * Every block but the last one of the text is followed by a separator, since
 * Phorge renders some blocks differently at the end of a text ("## Title"
 * alone is a list item, followed by more text it is a header).
 *
 * A batch that fails is rendered again block by block, and blocks that still
 * fail are retried later.
 */
export class BlockRenderer {
  private readonly cache = new Map<string, string>();
  private readonly queued = new Map<string, RenderItem>();
  private readonly inFlight = new Set<string>();
  private readonly failed = new Map<string, { item: RenderItem; failures: number; retryAt: number }>();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private capacity = MIN_CACHE;
  private destroyed = false;
  private readonly separator = `RMESEP${Math.random().toString(36).slice(2, 10)}`;

  private wasBusy = false;

  constructor(
    private readonly render: RenderFunction,
    private readonly onRendered: () => void,
    /** Called when blocks start or stop waiting for the server. */
    private readonly onBusy: (busy: boolean) => void = () => {},
  ) {}

  /** Whether blocks wait for the server. */
  get busy(): boolean {
    return this.queued.size > 0 || this.inFlight.size > 0;
  }

  private noteBusy(): void {
    if (this.busy !== this.wasBusy) {
      this.wasBusy = this.busy;
      this.onBusy(this.wasBusy);
    }
  }

  private key({ text, last }: RenderItem): string {
    return last ? `\u0000${text}` : text;
  }

  /** Returns the cached HTML of a block, or undefined. */
  get(item: RenderItem): string | undefined {
    const key = this.key(item);
    const html = this.cache.get(key);
    if (html !== undefined) {
      // Keep recently used entries in the cache.
      this.cache.delete(key);
      this.cache.set(key, html);
    }
    return html;
  }

  /**
   * The HTML of a block, or while that is not rendered yet, the HTML of the
   * same text rendered as the last block or not (they differ in rare cases
   * only), so a block does not show as source while that arrives.
   */
  getOrSimilar(item: RenderItem): string | undefined {
    return this.get(item) ?? this.cache.get(this.key({ ...item, last: !item.last }));
  }

  /** Caches HTML for a block that the editor knows without the server, e.g. a checked box. */
  prime(item: RenderItem, html: string): void {
    this.store(item, html);
  }

  /** Keeps at least twice as many blocks as the text has in the cache. */
  setBlockCount(count: number): void {
    this.capacity = Math.max(MIN_CACHE, count * 2);
  }

  /** The number of blocks that could not be rendered. */
  get failures(): number {
    return this.failed.size;
  }

  /** Forgets failures of texts that are no longer blocks: they are not retried or counted. */
  keepFailures(items: RenderItem[]): void {
    const keys = new Set(items.map((item) => this.key(item)));
    for (const key of this.failed.keys()) {
      if (!keys.has(key)) {
        this.failed.delete(key);
      }
    }
  }

  /** Queues blocks for rendering; onRendered() is called when HTML arrives. */
  request(items: RenderItem[], delay = 0): void {
    const now = Date.now();
    for (const item of items) {
      const key = this.key(item);
      const failure = this.failed.get(key);
      if (!this.cache.has(key) && !this.inFlight.has(key) && (!failure || failure.retryAt <= now)) {
        this.queued.set(key, item);
      }
    }
    if (!this.queued.size) {
      return;
    }
    this.noteBusy();
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), delay);
  }

  /** Renders the blocks that failed again now. */
  retryNow(): void {
    const items = Array.from(this.failed.values(), (f) => f.item);
    this.failed.forEach((failure) => (failure.retryAt = 0));
    this.request(items);
  }

  private async flush(): Promise<void> {
    const batches: RenderItem[][] = [[]];
    let size = 0;
    for (const [key, item] of this.queued) {
      this.inFlight.add(key);
      if (item.last) {
        // Only the last item of a batch is rendered as the end of a text.
        batches.push([item]);
        continue;
      }
      if (size + item.text.length > MAX_BATCH_CHARS && batches[0].length) {
        batches.unshift([]);
        size = 0;
      }
      batches[0].push(item);
      size += item.text.length;
    }
    this.queued.clear();
    await Promise.all(batches.filter((batch) => batch.length).map((batch) => this.renderBatch(batch)));
    if (!this.destroyed) {
      this.scheduleRetry();
      this.onRendered();
      this.noteBusy();
    }
  }

  private async renderBatch(items: RenderItem[]): Promise<void> {
    let parts: string[] | null = null;
    try {
      parts = await this.renderJoined(items);
    } catch (error) {
      console.warn("Phizziwig: rendering failed", error);
    }
    if (parts) {
      items.forEach((item, i) => this.store(item, parts[i]));
    } else if (items.length === 1) {
      this.fail(items[0], new Error("Rendering failed."));
    } else {
      // A block the server fails on, or a separator that did not survive,
      // must not keep the other blocks from rendering: one by one, a few at a
      // time (all of them fail alike when the server is down).
      const rest = [...items];
      const worker = async () => {
        for (let item = rest.shift(); item; item = rest.shift()) {
          try {
            const [html] = (await this.renderJoined([item])) ?? [];
            if (html === undefined) {
              throw new Error("The rendered block did not split.");
            }
            this.store(item, html);
          } catch (error) {
            this.fail(item, error);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(SINGLE_REQUESTS, items.length) }, worker));
    }
    items.forEach((item) => this.inFlight.delete(this.key(item)));
  }

  private async renderJoined(items: RenderItem[]): Promise<string[] | null> {
    const last = items[items.length - 1].last;
    const texts = items.map((item) => item.text);
    const text = texts.join(`\n\n${this.separator}\n\n`) + (last ? "" : `\n\n${this.separator}`);
    const parts: string[] = [""];
    for (const node of Array.from((await this.parse(await this.render(text))).childNodes)) {
      if (node instanceof Element && node.tagName === "P" && node.textContent?.trim() === this.separator) {
        parts.push("");
      } else {
        parts[parts.length - 1] += node instanceof Element ? node.outerHTML : escapeText(node.textContent ?? "");
      }
    }
    if (!last) {
      // After the trailing separator.
      parts.pop();
    }
    return parts.length === items.length ? parts : null;
  }

  private fail(item: RenderItem, error: unknown): void {
    console.warn("Phizziwig: rendering a block failed", error);
    const key = this.key(item);
    const failures = (this.failed.get(key)?.failures ?? 0) + 1;
    const delay = RETRY_DELAYS[Math.min(failures, RETRY_DELAYS.length) - 1];
    this.failed.set(key, { item, failures, retryAt: Date.now() + delay });
  }

  private scheduleRetry(): void {
    clearTimeout(this.retryTimer);
    if (!this.failed.size) {
      return;
    }
    const next = Math.min(...Array.from(this.failed.values(), (f) => f.retryAt));
    this.retryTimer = setTimeout(
      () => this.request(Array.from(this.failed.values(), (f) => f.item)),
      Math.max(0, next - Date.now()),
    );
  }

  /** Parses server HTML without loading images or running anything. */
  private async parse({ html, metadata, behaviors }: Rendered): Promise<Element> {
    const content = parseHtml(html);
    // Images the page's Javascript would load, like memes not made yet; their
    // IDs are the response's and mean nothing on this page.
    const images = (behaviors["remarkup-load-image"] ?? []) as { uri: string; imageID: string }[];
    await Promise.all(
      images.map(async ({ uri, imageID }) => {
        const image = content.querySelector<HTMLImageElement>(`#${CSS.escape(imageID)}`);
        image?.removeAttribute("id");
        try {
          image?.setAttribute("src", await loadImage(uri));
        } catch (error) {
          console.warn("Phizziwig: loading an image failed", error);
        }
      }),
    );
    content.querySelectorAll("[data-sigil], [data-meta]").forEach((el) => {
      // Embedded files carry their monogram ("F123") in the metadata.
      const index = /^\d+_(\d+)$/.exec(el.getAttribute("data-meta") ?? "")?.[1];
      const data = index === undefined ? null : (metadata[Number(index)] as { monogram?: string } | null);
      if (data?.monogram) {
        el.setAttribute("data-rme-file", data.monogram);
      }
      // Javelin metadata references of the response mean nothing on this page.
      el.removeAttribute("data-sigil");
      el.removeAttribute("data-meta");
    });
    const root = content.querySelector(".phabricator-remarkup");
    if (root) {
      return root;
    }
    const div = document.createElement("div");
    div.append(content);
    return div;
  }

  private store(item: RenderItem, html: string): void {
    const key = this.key(item);
    this.failed.delete(key);
    this.cache.set(key, html.trim());
    while (this.cache.size > this.capacity) {
      this.cache.delete(this.cache.keys().next().value!);
    }
  }

  destroy(): void {
    this.destroyed = true;
    clearTimeout(this.timer);
    clearTimeout(this.retryTimer);
  }
}
