import { createHash } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, expect, test } from "@playwright/test";
import { AUTH_FILE } from "./env";
import { imageSite } from "./helpers";

/** The ID Chromium gives an unpacked extension: from the hash of its path, in the letters a to p. */
function extensionId(path: string): string {
  const hash = createHash("sha256").update(path).digest("hex").slice(0, 32);
  return [...hash].map((digit) => String.fromCharCode(97 + parseInt(digit, 16))).join("");
}

// Playwright can load extensions into Chromium only; firefox-extension.mjs
// tests the extension in Firefox.
test("the browser extension adds the editor in Chromium", async ({ browserName, baseURL }) => {
  test.skip(browserName !== "chromium", "Playwright loads extensions into Chromium only");
  const extension = new URL("../dist/extension", import.meta.url).pathname;
  const profile = join(tmpdir(), `rme-chromium-${Date.now()}`);
  const site = await imageSite(true);
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chromium",
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  try {
    const state = JSON.parse(readFileSync(AUTH_FILE, "utf8"));
    await context.addCookies(state.cookies);
    const page = await context.newPage();
    await page.goto(`${baseURL}/phriction/edit/2/`);
    await expect(page.locator(".rme-block .remarkup-note").first()).toBeVisible();

    await page.locator(".rme-block .remarkup-note").first().click();
    await page.keyboard.press("Home");
    await page.keyboard.type("Hi ");
    await expect(page.locator("textarea.remarkup-assist-textarea")).toHaveValue(/Hi NOTE: This is a note\./);

    // Images of other sites that allow it, which the page's CSP keeps from the page itself.
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.locator(".rme-editor .cm-content").evaluate((node, src) => {
      const data = new DataTransfer();
      data.setData("text/html", `<p>Pasted <img src="${src}" alt="Logo"></p>`);
      data.setData("text/plain", "Pasted");
      node.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
    }, `${site.url}/image.png`);
    await expect(page.locator("textarea.remarkup-assist-textarea")).toHaveValue(/\n\nPasted \{F\d+\}$/);

    // Both tools run until they are turned off on the options page.
    await page.goto(`${baseURL}/maniphest/`);
    await expect(page.locator("html")).toHaveAttribute("data-phizziwig", "extension");
    await expect(page.locator("html")).toHaveAttribute("data-phuture", "extension");
    await expect(page.locator(".phuture-menu-button")).toBeVisible();
    const options = await context.newPage();
    await options.goto(`chrome-extension://${extensionId(extension)}/options.html`);
    await expect(options.getByRole("checkbox", { name: /^Phizziwig/ })).toBeChecked();
    await options.getByRole("checkbox", { name: /^Phuture/ }).uncheck();
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-phizziwig", "extension");
    await expect(page.locator("html")).not.toHaveAttribute("data-phuture");
    await expect(page.locator(".phuture-menu-button")).toHaveCount(0);
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
    site.close();
  }
});
