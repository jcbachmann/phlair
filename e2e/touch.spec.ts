// Taps on touch screens, in both browsers: Firefox has touch events on
// desktop only with a preference, which needs a browser of its own.

import { expect, type Page, test } from "@playwright/test";
import { editor, openNewWikiPage, settled, textarea } from "./helpers";

test.use({
  viewport: { width: 390, height: 800 },
  hasTouch: true,
  launchOptions: async ({ browserName }, use) =>
    use(browserName === "firefox" ? { firefoxUserPrefs: { "dom.w3c_touch_events.enabled": 1 } } : {}),
});

const source = (page: Page) => textarea(page).inputValue();

test("a tap right of the checkbox of an empty item puts the cursor where its text goes", async ({ page }) => {
  await openNewWikiPage(page, "Taps");
  await editor(page).click();
  await page.keyboard.insertText("Intro\n\n  - [ ] one\n  - [ ] ");
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await settled(page);
  const line = page.locator(".cm-line.rme-src-list").last();
  const check = (await line.locator(".rme-item-check").boundingBox())!;
  const box = (await line.boundingBox())!;
  await page.touchscreen.tap(check.x + check.width + 40, box.y + box.height / 2);
  await page.keyboard.type("two");
  await expect.poll(() => source(page)).toBe("Intro\n\n  - [ ] one\n  - [ ] two");
  // A tap on the checkbox still checks it.
  await page.touchscreen.tap(check.x + check.width / 2, check.y + check.height / 2);
  await expect.poll(() => source(page)).toBe("Intro\n\n  - [ ] one\n  - [X] two");
});
