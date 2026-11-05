// The screenshots of the README (docs/screenshots). Each shows one feature
// in the local Phorge's demo content.

import { type Page, test } from "@playwright/test";
import { addPhlair, conduit, editor, openNewWikiPage, openWithEditor } from "../e2e/helpers";

const DIR = new URL("../docs/screenshots/", import.meta.url).pathname;

/** The remarkup control and anything open over it (menus, popups), with a margin. */
async function shoot(page: Page, name: string, extra: string[] = [], height = 420): Promise<void> {
  await page.waitForTimeout(300);
  const boxes = await Promise.all(
    ['[data-sigil~="remarkup-assist-control"]', ...extra].map((selector) =>
      page.locator(selector).first().boundingBox(),
    ),
  );
  const shown = boxes.filter((box) => box !== null);
  const left = Math.min(...shown.map((b) => b.x)) - 12;
  const top = Math.min(...shown.map((b) => b.y)) - 12;
  const right = Math.max(...shown.map((b) => b.x + b.width)) + 12;
  const bottom = Math.max(top + height, ...shown.slice(1).map((b) => b.y + b.height + 12));
  await page.screenshot({
    path: `${DIR}${name}.png`,
    clip: { x: Math.max(0, left), y: Math.max(0, top), width: right - left, height: bottom - top },
  });
}

const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement).blur());

test("rendered while editing", async ({ page }) => {
  await openWithEditor(page, "/phriction/edit/2/");
  // Headers show their styled source.
  await page.locator(".rme-editor .cm-line.rme-src-h").first().waitFor();
  await shoot(page, "editor", [], 560);
});

test("the block being edited shows its source", async ({ page }) => {
  await openWithEditor(page, "/phriction/edit/2/");
  await editor(page).getByText("This page uses").click();
  await shoot(page, "editing", [], 560);
});

test("tables", async ({ page }) => {
  await openNewWikiPage(page, "Measurements");
  await editor(page).click();
  await page.keyboard.insertText(
    "Results of the calibration run:\n\n| Element | Line | Energy (keV)\n| --- | --- | ---\n| Fe | Ka | 6.40\n| Cu | Ka | 8.05\n| Zn | Ka | 8.64\n\nAll within tolerance.",
  );
  await blur(page);
  await page.locator(".rme-table-editor td", { hasText: "8.05" }).click();
  const cu = (await page.locator(".rme-table-editor td", { hasText: "Cu" }).boundingBox())!;
  await page.mouse.move(cu.x + 4, cu.y + cu.height - 1);
  await shoot(page, "tables", [".rme-table-bar"], 300);
});

test("insert menu", async ({ page }) => {
  await openNewWikiPage(page, "Insert menu");
  await editor(page).click();
  await page.keyboard.insertText("Notes from the review.\n\n");
  await page.keyboard.type("/");
  await shoot(page, "insert-menu", [".rme-autocomplete"]);
});

test("link and task search", async ({ page }) => {
  await openNewWikiPage(page, "Search");
  await editor(page).click();
  await page.keyboard.type("The detector is tracked in ");
  await page.keyboard.press("Control+k");
  await page.locator(".rme-picker .rme-picker-search").fill("calib");
  await page.locator(".rme-picker .jx-result").first().waitFor();
  await shoot(page, "search", [".rme-picker"], 260);
});

test("image menu", async ({ page }) => {
  await openNewWikiPage(page, "Images");
  await editor(page).click();
  await page.keyboard.insertText(
    "{F1, float, layout=left} The spectrum of the reference sample, taken after the calibration.",
  );
  await blur(page);
  await page.locator(".rme-block img").click({ button: "right" });
  await shoot(page, "image-menu", [".rme-image-menu"], 260);
});

test("keyboard shortcuts", async ({ page }) => {
  await openNewWikiPage(page, "Shortcuts");
  await editor(page).click();
  await page.keyboard.press("F1");
  await page.locator(".rme-shortcuts").screenshot({ path: `${DIR}shortcuts.png` });
});

test("Phuture: snoozed items and the snooze menu", async ({ page }) => {
  await page.goto("/maniphest/");
  // Not "Calibrate the detector" (T1 of the seed), which the E2E tests search for.
  const titles = ["Replace the tube filter", "Order new filters", "Review the measurement report", "Update the manual"];
  const ids: number[] = [];
  for (const title of titles) {
    const task = await conduit(page, "maniphest.edit", { transactions: [{ type: "title", value: title }] });
    ids.push(task.object.id);
  }
  // Room for the menu below the list.
  await page.setViewportSize({ width: 1280, height: 2000 });
  await page.goto(`/maniphest/?ids=${ids.join(",")}`);
  await addPhlair(page);
  const snooze = async (id: number, choice: string) => {
    const item = page.locator("li.phui-oi").filter({ has: page.locator(`a.phui-oi-link[href="/T${id}"]`) });
    await item.locator(".phuture-action a").click();
    await page.locator(".phuture-menu [role^='menuitem']", { hasText: new RegExp(`^${choice}`) }).click();
  };
  await snooze(ids[1], "Tomorrow");
  await snooze(ids[3], "In a week");
  await page.locator(".phuture-menu-button").click();
  await page.locator(".phuture-menu [role^='menuitem']", { hasText: "Show snoozed items" }).click();
  await page
    .locator(`li.phui-oi a.phui-oi-link[href="/T${ids[0]}"]`)
    .locator("xpath=ancestor::li[1]")
    .locator(".phuture-action a")
    .click();
  await page.waitForTimeout(300);
  const list = (await page.locator(".phui-oi-list-view").first().boundingBox())!;
  const menu = (await page.locator(".phuture-menu").boundingBox())!;
  await page.screenshot({
    path: `${DIR}phuture.png`,
    clip: {
      x: list.x - 12,
      y: list.y - 12,
      width: list.width + 24,
      height: Math.max(list.y + list.height, menu.y + menu.height) - list.y + 24,
    },
  });
});
