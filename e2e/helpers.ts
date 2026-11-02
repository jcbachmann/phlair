import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { expect, type Locator, type Page } from "@playwright/test";

const SCRIPT = readFileSync(new URL("../dist/phlair.user.js", import.meta.url), "utf8");

const managed = new WeakSet<Page>();

/**
 * Adds Phlair (the userscript, which runs all tools) to the page like a
 * userscript manager: past the page's CSP, which forbids inline scripts, and
 * with GM.xmlHttpRequest, which fetches from any site (here: from Node).
 */
export async function addPhlair(page: Page): Promise<void> {
  if (!managed.has(page)) {
    managed.add(page);
    await page.exposeFunction("__gmFetch", async (url: string) => {
      const response = await fetch(url);
      const body = Buffer.from(await response.arrayBuffer()).toString("base64");
      return { status: response.status, type: response.headers.get("content-type") ?? "", body };
    });
  }
  await page.evaluate(() => {
    type Fetched = { status: number; type: string; body: string };
    const gmFetch = (window as unknown as { __gmFetch(url: string): Promise<Fetched> }).__gmFetch;
    (window as unknown as { GM: object }).GM = {
      xmlHttpRequest(request: { url: string; onload(r: object): void; onerror(): void }) {
        gmFetch(request.url).then(({ status, type, body }) => {
          const bytes = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
          request.onload({ status, response: new Blob([bytes], { type }), responseHeaders: "" });
        }, request.onerror);
      },
    };
  });
  // A string, not a function: evaluated as a script by the browser's debugger, which CSP does not cover.
  await page.evaluate(SCRIPT);
}

/** Opens a page and adds the editor to it, as the userscript would. */
export async function openWithEditor(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await addPhlair(page);
  await expect(editor(page)).toBeVisible();
}

export function editor(page: Page): Locator {
  return page.locator(".rme-editor .cm-content").first();
}

export function textarea(page: Page): Locator {
  return page.locator("textarea.remarkup-assist-textarea").first();
}

/**
 * Opens the form for a new wiki page with a unique slug. Top level: a page
 * can only be created where its parent page exists.
 */
export async function openNewWikiPage(page: Page, title: string): Promise<string> {
  const slug = `e2e-${title.toLowerCase().replace(/\W+/g, "-")}-${Date.now()}-${Math.floor(Math.random() * 1e6)}/`;
  await openWithEditor(page, `/phriction/edit/?slug=${encodeURIComponent(slug)}`);
  await page.locator('input[name="title"]').fill(title);
  return slug;
}

/**
 * Calls a Conduit method with the browser's session (the page must be one of
 * Phorge's). Tests running in parallel can deadlock in the database (which
 * MariaDB may report as a lost savepoint, as it rolled the transaction back);
 * such calls are tried again.
 */
export async function conduit(page: Page, method: string, params: object): Promise<any> {
  return page.evaluate(
    async ({ method, params }) => {
      const csrf = document.querySelector<HTMLInputElement>('input[name="__csrf__"]')!.value;
      for (let attempt = 1; ; attempt++) {
        const body = new URLSearchParams({ params: JSON.stringify(params), output: "json", __csrf__: csrf });
        const response = await (await fetch(`/api/${method}`, { method: "POST", body })).json();
        if (!response.error_code) {
          return response.result;
        }
        if (attempt === 3 || !/Deadlock|SAVEPOINT \S+ does not exist/.test(response.error_info)) {
          throw new Error(response.error_info);
        }
      }
    },
    { method, params },
  );
}

/** Creates a task and opens it, so its comment form has no draft of another test. */
export async function createTask(page: Page, title: string): Promise<void> {
  await page.goto("/maniphest/");
  const task = await conduit(page, "maniphest.edit", { transactions: [{ type: "title", value: title }] });
  await page.goto(`/T${task.object.id}`);
}

/** Creates a revision with a small diff and opens it. */
export async function createRevision(page: Page, title: string): Promise<void> {
  await page.goto("/differential/");
  const diff = await conduit(page, "differential.createrawdiff", {
    diff: [
      "diff --git a/calibration.txt b/calibration.txt",
      "--- a/calibration.txt",
      "+++ b/calibration.txt",
      "@@ -1,3 +1,3 @@",
      " Fe Ka 6.40",
      "-Cu Ka 8.04",
      "+Cu Ka 8.05",
      " Zn Ka 8.64",
      "",
    ].join("\n"),
  });
  const revision = await conduit(page, "differential.revision.edit", {
    transactions: [
      { type: "update", value: diff.phid },
      { type: "title", value: title },
      { type: "testPlan", value: "None." },
    ],
  });
  await page.goto(`/D${revision.object.id}`);
}

/** A 1×1 PNG. */
export const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

/**
 * Another site with an image at "<url>/image.png", allowing others to read it
 * (CORS) or not. On "host", e.g. the address the Phorge container reaches
 * the host at, where the browser reaches it too.
 */
export async function imageSite(cors: boolean, host = "127.0.0.1"): Promise<{ url: string; close: () => void }> {
  const server = createServer((request, response) => {
    const headers: Record<string, string> = { "Content-Type": "image/png" };
    if (cors) {
      headers["Access-Control-Allow-Origin"] = "*";
    }
    response.writeHead(request.url === "/image.png" ? 200 : 404, headers).end(PNG_BYTES);
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  const { port } = server.address() as { port: number };
  return { url: `http://${host}:${port}`, close: () => server.close() };
}
