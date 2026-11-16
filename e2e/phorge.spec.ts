// Phlair installed in Phorge (phorge/, loaded by the instance through
// "load-libraries"): no userscript injected here. Phizziwig is off in the
// instance's Global Default Settings and on for alice, Phuture is off for
// both (dev/phorge/seed.php).

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { authFile, phabricatorExec } from "./env";
import { conduit, editor, imageSite, textarea } from "./helpers";

// The tests change alice's setting and the instance's configuration: one at a time, in one browser.
test.describe.configure({ mode: "serial" });
test.skip(
  ({ browserName }) => browserName !== "chromium",
  "Changes shared settings; the script is the same in every browser",
);
test.use({ storageState: authFile("alice") });

async function newWikiPage(page: Page): Promise<void> {
  const slug = `e2e-installed-${Date.now()}-${Math.floor(Math.random() * 1e6)}/`;
  await page.goto(`/phriction/edit/?slug=${encodeURIComponent(slug)}`);
}

const PHIZZIWIG = "Phizziwig: Remarkup Editor";
const PHUTURE = "Phuture: Snooze";
const ONEDRIPHE = "OneDriphe: SharePoint Links";

/** Chooses a tool's setting in the user's settings, or in Global Default Settings. */
async function chooseSetting(page: Page, setting: string, label: string, global = false): Promise<void> {
  await page.goto(global ? "/settings/builtin/global/page/phlair/" : "/settings/panel/phlair/");
  await page.getByRole("combobox", { name: setting }).selectOption({ label });
  await page.getByRole("button", { name: "Save Changes" }).click();
  await expect(page.getByText("Changes saved.")).toBeVisible();
}

test("Phorge loads the editor for a user who turned it on", async ({ page }) => {
  await newWikiPage(page);
  await expect(editor(page)).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-phizziwig", "phorge");
  await expect(page.locator("html")).not.toHaveAttribute("data-phuture");
  await expect(page.locator(".phuture-menu-button")).toHaveCount(0);
  await expect(page.locator('script[src*="/phlair/"][src$="/phlair.js"]')).toHaveCount(1);

  await editor(page).click();
  await page.keyboard.type("Typed **here**");
  await expect(textarea(page)).toHaveValue("Typed **here**");
});

test("the wand button turns it off for the page only; the setting is what lasts", async ({ page }) => {
  await newWikiPage(page);
  await page.getByRole("button", { name: /^Phizziwig/ }).click();
  await expect(page.locator(".rme-editor")).toHaveCount(0);
  await page.reload();
  await expect(editor(page)).toBeVisible();
});

test("users follow the default of the administrator or choose themselves", async ({ page, browser }) => {
  const admin = await browser.newPage({ storageState: authFile("admin") });
  const expectEditor = async (shown: boolean) => {
    await newWikiPage(page);
    await expect(page.locator(".remarkup-assist-textarea")).toBeAttached();
    await expect(page.locator(".rme-editor")).toHaveCount(shown ? 1 : 0);
  };
  try {
    await chooseSetting(page, PHIZZIWIG, "Default (Off)");
    await expectEditor(false);
    await chooseSetting(admin, PHIZZIWIG, "On", true);
    await chooseSetting(page, PHIZZIWIG, "Default (On)");
    await expectEditor(true);
    await chooseSetting(page, PHIZZIWIG, "Off");
    await expectEditor(false);
  } finally {
    await chooseSetting(admin, PHIZZIWIG, "Off", true);
    await chooseSetting(page, PHIZZIWIG, "On");
    await admin.close();
  }
});

test("users turn on Phuture for themselves; it runs without Phizziwig too", async ({ page }) => {
  try {
    await chooseSetting(page, PHUTURE, "On");
    await chooseSetting(page, PHIZZIWIG, "Off");
    await page.goto("/maniphest/query/all/");
    await expect(page.locator("html")).toHaveAttribute("data-phuture", "phorge");
    await expect(page.locator("html")).not.toHaveAttribute("data-phizziwig");
    await expect(page.locator(".phuture-menu-button")).toBeVisible();
    await expect(page.locator("li.phui-oi .phuture-action").first()).toBeAttached();

    await chooseSetting(page, PHUTURE, "Default (Off)");
    await page.goto("/maniphest/query/all/");
    await expect(page.locator("li.phui-oi").first()).toBeVisible();
    await expect(page.locator(".phuture-action")).toHaveCount(0);
    await expect(page.locator('script[src$="/phlair.js"]')).toHaveCount(0);
  } finally {
    await chooseSetting(page, PHUTURE, "Default (Off)");
    await chooseSetting(page, PHIZZIWIG, "On");
  }
});

test("users who have OneDriphe turn on its way to open SharePoint folders in Explorer", async ({ browser }) => {
  // Windows, which OneDriphe is for (and Linux, below).
  const page = await browser.newPage({
    storageState: authFile("alice"),
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0",
  });
  const linux = await browser.newPage({
    storageState: authFile("alice"),
    userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0",
  });
  const folder =
    "https://contoso.sharepoint.com/sites/Projects/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2FProjects%2FShared%20Documents%2FPlans";
  try {
    await page.goto("/maniphest/");
    const task = await conduit(page, "maniphest.edit", {
      transactions: [
        { type: "title", value: "SharePoint folder" },
        { type: "description", value: `The plans (${Date.now()}): [[ ${folder} | Plans ]]` },
      ],
    });
    const link = page.locator(".phabricator-remarkup a.phizziwig-sharepoint", { hasText: "Plans" });
    // As by default (alice may have it on from trying it out).
    await chooseSetting(page, ONEDRIPHE, "Default (Off)");
    await page.goto(`/T${task.object.id}`);
    await expect(link).toBeVisible();
    // A folder opens in the browser only: a plain link.
    await expect(link).not.toHaveAttribute("aria-haspopup");

    await chooseSetting(page, ONEDRIPHE, "On");
    await page.goto(`/T${task.object.id}`);
    await link.click();
    await expect(page.locator(".phizziwig-sharepoint-menu .phabricator-action-view-item")).toHaveText([
      "Open folder",
      "In the browser",
      "In Explorer",
    ]);
    await linux.goto(`/T${task.object.id}`);
    await linux.locator(".phabricator-remarkup a.phizziwig-sharepoint", { hasText: "Plans" }).click();
    await expect(linux.locator(".phizziwig-sharepoint-menu .phabricator-action-view-item")).toHaveText([
      "Open folder",
      "In the browser",
      "In the file manager",
    ]);
  } finally {
    await chooseSetting(page, ONEDRIPHE, "Default (Off)");
    await page.close();
    await linux.close();
  }
});

test("the setting tells how to install and remove OneDriphe, with its scripts to download", async ({ page }) => {
  /** A script of OneDriphe. */
  const script = (file: string) => readFileSync(new URL(`../phorge/onedriphe/${file}`, import.meta.url), "utf8");
  /** A script of OneDriphe for Windows, with its line breaks. */
  const windows = (file: string) => script(file).replace(/\r?\n/g, "\r\n");
  const download = async (link: string, file: string) => {
    const [started] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("link", { name: link }).click(),
    ]);
    expect(started.suggestedFilename()).toBe(file);
    const path = await started.path();
    const content = readFileSync(path, "utf8");
    // Windows PowerShell 5.1 takes ASCII only; Linux's scripts have Linux' line breaks.
    expect(content).not.toMatch(file.endsWith(".ps1") ? /(?<!\r)\n|[^\x00-\x7f]/ : /\r/);
    return { content, path };
  };

  await page.goto("/settings/panel/phlair/");
  await expect(page.getByText("OneDriphe", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("no administrator rights")).toBeVisible();
  await expect(page.getByText("-ExecutionPolicy Bypass").first()).toBeVisible();
  await expect(page.getByText("Windows Settings → Apps → OneDriphe")).toBeVisible();
  await expect(page.getByText("~/.local/bin/onedriphe --uninstall")).toBeVisible();

  // One file: the installer with the helper and the uninstaller in it, in place of copies of the files next to it.
  let installer = (await download("installer for Windows", "install-onedriphe.ps1")).content;
  for (const [variable, file] of [
    ["helper", "onedriphe.ps1"],
    ["uninstaller", "uninstall.ps1"],
  ]) {
    const embedded = `\r\n$${variable} = @'\r\n${windows(file).trimEnd()}\r\n'@\r\n`;
    expect(installer).toContain(embedded);
    installer = installer.replace(embedded, `\r\n$${variable} = $null # ONEDRIPHE-${variable.toUpperCase()}\r\n`);
  }
  expect(installer).toBe(windows("install.ps1"));

  expect((await download("uninstaller", "uninstall-onedriphe.ps1")).content).toBe(windows("uninstall.ps1"));

  // For Linux, the installer with the helper in it, which it installs.
  const linux = await download("installer for Linux", "install-onedriphe.sh");
  const embedded = `write_helper() {\n  cat >"$1" <<'ONEDRIPHE-HELPER'\n${script("onedriphe.py").trimEnd()}\nONEDRIPHE-HELPER\n}`;
  expect(
    linux.content.replace(embedded, 'write_helper() { cp "$(dirname "$0")/onedriphe.py" "$1"; } # ONEDRIPHE-HELPER'),
  ).toBe(script("install.sh"));
  const home = mkdtempSync(join(tmpdir(), "onedriphe-"));
  try {
    execFileSync("sh", [linux.path], { env: { HOME: home, PATH: process.env.PATH }, stdio: "pipe" });
    expect(readFileSync(join(home, ".local/bin/onedriphe"), "utf8")).toBe(script("onedriphe.py"));
  } finally {
    rmSync(home, { recursive: true });
  }
});

test("images of pasted text from other sites are downloaded by the server, for the user only", async ({
  page,
  browser,
}) => {
  // An address of the host that the container and the browser both reach.
  const host = phabricatorExec(["getent", "hosts", "host.docker.internal"]).split(/\s+/)[0];
  // Without CORS: the browser could not read it, past the page's CSP or not.
  const site = await imageSite(false, host);
  try {
    await newWikiPage(page);
    await editor(page).click();
    await editor(page).evaluate((node, src) => {
      const data = new DataTransfer();
      data.setData("text/html", `<p>Pasted <img src="${src}" alt="Logo"></p>`);
      data.setData("text/plain", "Pasted");
      node.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
    }, `${site.url}/image.png`);
    await expect(textarea(page)).toHaveValue(/^Pasted \{F\d+\}$/);
    // Like a file dropped on the text: only its uploader sees it, until it is attached to what is saved.
    const id = Number(/\{F(\d+)\}/.exec(await textarea(page).inputValue())![1]);
    const search = (on: Page) => conduit(on, "file.search", { constraints: { ids: [id] } });
    expect((await search(page)).data).toHaveLength(1);
    const other = await browser.newPage({ storageState: authFile("admin") });
    try {
      await other.goto("/");
      expect((await search(other)).data).toHaveLength(0);
    } finally {
      await other.close();
    }
  } finally {
    site.close();
  }
});
