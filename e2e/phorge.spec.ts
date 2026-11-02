// Phlair installed in Phorge (phorge/, loaded by the instance through
// "load-libraries"): no userscript injected here. Phizziwig is off in the
// instance's Global Default Settings and on for alice, Phuture is off for
// both (dev/phorge/seed.php).

import { expect, type Page, test } from "@playwright/test";
import { authFile, phabricatorExec } from "./env";
import { editor, imageSite, textarea } from "./helpers";

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

test("images of pasted text from other sites are downloaded by the server", async ({ page }) => {
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
  } finally {
    site.close();
  }
});
