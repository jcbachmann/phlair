// Regression tests of fixed bugs and tests of the editing aids: shortcuts,
// insert menu, pickers, pasting, checklists, themes and narrow windows.

import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import {
  addPhlair,
  conduit,
  createRevision,
  createTask,
  editor,
  imageSite,
  openNewWikiPage,
  openWithEditor,
  textarea,
} from "./helpers";

const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement).blur());
const source = (page: Page) => textarea(page).inputValue();
const selected = (page: Page) =>
  textarea(page).evaluate((t: HTMLTextAreaElement) => t.value.slice(t.selectionStart, t.selectionEnd));

/** Starts a new wiki page with a text, all blocks rendered. */
async function startWith(page: Page, text: string): Promise<void> {
  await openNewWikiPage(page, "Features");
  await editor(page).click();
  await page.keyboard.insertText(text);
  await blur(page);
  // No line with text shows its source (blank lines are lines like any other).
  await expect(page.locator(".rme-editor .cm-line").filter({ hasText: /\S/ })).toHaveCount(0);
}

/** The screen box of a text in a rendered block. */
function textBox(page: Page, text: string) {
  return page.evaluate((text) => {
    const walker = document.createTreeWalker(document.querySelector(".rme-editor")!, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const index = node.textContent!.indexOf(text);
      if (index >= 0) {
        const range = document.createRange();
        range.setStart(node, index);
        range.setEnd(node, index + text.length);
        const { left, right, top, bottom } = range.getBoundingClientRect();
        return { left, right, y: (top + bottom) / 2 };
      }
    }
    throw new Error(`${text} not found`);
  }, text);
}

/**
 * Pastes HTML (copied from an element) or text into the editor with Ctrl+V,
 * or as plain text with Ctrl+Shift+V. Firefox pastes through its clipboard;
 * Chromium's is the system's, shared by parallel test runs, so it gets a
 * paste event with the data (which Chromium, unlike Firefox, lets through).
 */
async function paste(page: Page, content: { html?: string; text?: string }, plain = false): Promise<void> {
  if (page.context().browser()?.browserType().name() === "chromium") {
    await editor(page).evaluate(
      (node, { html, text, plain }) => {
        const data = new DataTransfer();
        if (html !== undefined && !plain) {
          data.setData("text/html", html);
          const div = document.createElement("div");
          div.innerHTML = html;
          data.setData("text/plain", div.textContent ?? "");
        } else {
          data.setData("text/plain", text ?? "");
        }
        if (plain) {
          node.dispatchEvent(
            new KeyboardEvent("keydown", { key: "V", code: "KeyV", ctrlKey: true, shiftKey: true, bubbles: true }),
          );
        }
        node.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
      },
      { ...content, plain },
    );
    return;
  }
  await page.evaluate(({ html, text }) => {
    let source: HTMLElement;
    if (html !== undefined) {
      source = document.createElement("div");
      source.contentEditable = "true";
      source.innerHTML = html;
    } else {
      const area = document.createElement("textarea");
      area.value = text!;
      source = area;
    }
    source.id = "rme-copy-source";
    source.addEventListener("copy", () => source.setAttribute("data-copied", ""));
    document.body.append(source);
    source.focus();
    if (source instanceof HTMLTextAreaElement) {
      source.select();
    } else {
      window.getSelection()!.selectAllChildren(source);
    }
  }, content);
  await page.keyboard.press("Control+c");
  await expect(page.locator("#rme-copy-source[data-copied]")).toHaveCount(1);
  await page.evaluate(() => document.getElementById("rme-copy-source")!.remove());
  // The editor keeps its selection while it is not focused.
  await editor(page).focus();
  await page.keyboard.press(plain ? "Control+Shift+v" : "Control+v");
}

test.describe("fixed bugs", () => {
  test("blocks render like in the whole text, also the last one", async ({ page }) => {
    // "## Section" followed by text is a header, "# item" at the end a list.
    await startWith(page, "## Section\n\nText.\n\n# item");
    const preview = page.locator(".phui-remarkup-preview .phui-preview-body");
    await expect(preview).toContainText("item");
    for (const selector of [".remarkup-header", "ol", "p"]) {
      await expect(page.locator(`.rme-block ${selector}`)).toHaveCount(await preview.locator(selector).count());
    }
    await expect(page.locator(".rme-block .remarkup-header")).toHaveText("Section");
  });

  test("typing in a table cell after undo changes only that cell", async ({ page }) => {
    await startWith(page, "| abc | def |\n| 1 | 2 |");
    await page.locator(".rme-table-editor td", { hasText: "abc" }).click();
    await page.keyboard.press("End");
    await page.keyboard.type("x");
    await expect.poll(() => source(page)).toBe("| abcx | def |\n| 1 | 2 |");
    await page.keyboard.press("Control+z");
    await expect.poll(() => source(page)).toBe("| abc | def |\n| 1 | 2 |");
    await page.keyboard.type("y");
    await expect.poll(() => source(page)).toBe("| abcy | def |\n| 1 | 2 |");
  });

  test("the mouse selects rendered blocks whole, as the selection shows while selecting", async ({ page }) => {
    await startWith(page, "First paragraph here.\n\nSecond paragraph here.\n\nThird.");
    const from = await textBox(page, "paragraph here.");
    const second = await textBox(page, "Second");
    await page.mouse.move(from.left + 1, from.y);
    await page.mouse.down();
    await page.mouse.move(second.left + 30, second.y, { steps: 5 });
    // Nothing switches to its source while the mouse selects.
    await expect(page.locator(".rme-editor .cm-line").filter({ hasText: /\S/ })).toHaveCount(0);
    await expect(page.locator(".rme-block.rme-selected")).toHaveText([
      "First paragraph here.",
      "Second paragraph here.",
    ]);
    await page.mouse.up();
    expect(await selected(page)).toBe("First paragraph here.\n\nSecond paragraph here.");
    await expect(page.locator(".rme-block.rme-selected")).toHaveCount(0);
    // Bold acts on that selection.
    await page.keyboard.press("Control+b");
    await expect.poll(() => source(page)).toBe("**First paragraph here.\n\nSecond paragraph here.**\n\nThird.");
  });

  test("blocks that fail to render say so and can be retried", async ({ page }) => {
    let fail = true;
    await page.route("**/phriction/preview/**", (route) =>
      fail ? route.fulfill({ status: 500, body: "Server error" }) : route.fallback(),
    );
    await openNewWikiPage(page, "Failing");
    await editor(page).click();
    await page.keyboard.insertText("Some **text**.");
    await blur(page);
    const status = page.locator(".rme-status");
    await expect(status).toContainText("Preview unavailable for 1 block, shown as text.");
    await expect(page.locator(".cm-line", { hasText: "Some **text**." })).toBeVisible();
    fail = false;
    await status.getByRole("link", { name: "Retry" }).click();
    // Right away, not with the automatic retry 2 s after the failure.
    await expect(page.locator(".rme-block strong")).toHaveText("text", { timeout: 1000 });
    await expect(status).toBeHidden();
  });

  test("Tab in a paragraph does not jump into a table", async ({ page }) => {
    await startWith(page, "Text.\n\n| a | b |\n| 1 | 2 |");
    await page.locator(".rme-block p", { hasText: "Text." }).click();
    await page.keyboard.press("Tab");
    expect(await page.evaluate(() => !!document.activeElement?.closest(".rme-table-editor"))).toBe(false);
  });

  test("typing in a cell renders the table once typing pauses", async ({ page }) => {
    await startWith(page, "| a | b |\n| 1 | 2 |");
    let requests = 0;
    page.on("request", (request) => request.url().includes("/phriction/preview/") && requests++);
    await page.locator(".rme-table-editor td", { hasText: "1" }).click();
    await page.keyboard.type("234567890", { delay: 30 });
    await page.waitForTimeout(1000);
    // The editor's requests; Phorge's own preview adds some.
    expect(requests).toBeLessThanOrEqual(4);
  });

  test("the image menu closes when the text changes", async ({ page }) => {
    await startWith(page, "Before.\n\n{F1}");
    await page.locator(".rme-block img").click({ button: "right" });
    await expect(page.locator(".rme-image-menu")).toBeVisible();
    // Like Phorge's "Quote" action, which changes the textarea.
    await textarea(page).evaluate((t: HTMLTextAreaElement) => {
      t.value = `> Quoted.\n\n${t.value}`;
    });
    await expect(page.locator(".rme-image-menu")).toHaveCount(0);
    await expect.poll(() => source(page)).toBe("> Quoted.\n\nBefore.\n\n{F1}");
  });

  test("an upload finishes in the textarea when the editor was switched off", async ({ page }) => {
    let release = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/file/dropupload/**", async (route) => {
      await held;
      await route.fallback();
    });
    await openNewWikiPage(page, "Upload off");
    await editor(page).click();
    await page.keyboard.type("File:\n\n");
    await editor(page).evaluate((node) => {
      const data = new DataTransfer();
      data.items.add(new File(["hello"], "note.txt", { type: "text/plain" }));
      const box = node.getBoundingClientRect();
      node.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          clientX: box.left + 20,
          clientY: box.bottom - 5,
          dataTransfer: data,
        }),
      );
    });
    await expect.poll(() => source(page)).toMatch(/\{Uploading note\.txt \d+…\}/);
    await page.locator(".rme-toggle").click();
    await expect(page.locator(".rme-editor")).toHaveCount(0);
    release();
    await expect.poll(() => source(page)).toMatch(/^File:\n\n\{F\d+\}$/);
  });

  test("changes Phorge makes to the textarea while typing are kept", async ({ page }) => {
    await openNewWikiPage(page, "Merge");
    await editor(page).click();
    await page.keyboard.type("Typed.");
    await editor(page).evaluate(() => {
      const t = document.querySelector<HTMLTextAreaElement>("textarea.remarkup-assist-textarea")!;
      // E.g. Phorge's upload dialog adds a file, in the same moment as a key.
      t.value += "\n\n{F1}";
      document.execCommand("insertText", false, "!");
    });
    await expect.poll(() => source(page)).toBe("Typed.!\n\n{F1}");
  });
});

test.describe("editing aids", () => {
  test("keyboard shortcuts format, make lists and show an overview", async ({ page }) => {
    await openNewWikiPage(page, "Shortcuts");
    await editor(page).click();
    await page.keyboard.type("make it bold");
    await page.keyboard.press("Shift+Control+ArrowLeft");
    await page.keyboard.press("Control+b");
    await expect.poll(() => source(page)).toBe("make it **bold**");
    await page.keyboard.press("Control+i");
    await expect.poll(() => source(page)).toBe("make it **//bold//**");
    await page.keyboard.press("End");
    await page.keyboard.type("\n\nitem");
    await page.keyboard.press("Control+Shift+8");
    await expect.poll(() => source(page)).toBe("make it **//bold//**\n\n  - item");
    await page.keyboard.press("Control+Shift+7");
    await expect.poll(() => source(page)).toBe("make it **//bold//**\n\n  # item");
    await page.keyboard.press("Control+Shift+9");
    await expect.poll(() => source(page)).toBe("make it **//bold//**\n\n  - [ ] item");

    await page.keyboard.press("Control+/");
    const overview = page.locator(".rme-shortcuts");
    await expect(overview).toBeVisible();
    await expect(overview.locator("li", { hasText: "Underline" })).toContainText("Ctrl+U");
    await page.keyboard.press("Escape");
    await expect(overview).toHaveCount(0);
    await page.locator(".rme-shortcuts-button").click();
    await expect(overview).toBeVisible();
  });

  test("shortcuts format the selection in a table cell", async ({ page }) => {
    await startWith(page, "| name | value |\n| a | b |");
    await page.locator(".rme-table-editor td", { hasText: "b" }).click();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+u");
    await expect.poll(() => source(page)).toBe("| name | value |\n| a | __b__ |");
  });

  test("checklist boxes can be checked in the rendered text", async ({ page }) => {
    await startWith(page, "- [ ] open\n- [X] done");
    // The block shows the change before the server renders it again.
    await page.route("**/phriction/preview/**", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      await route.fallback();
    });
    // Phorge draws the boxes at the start of the items.
    const items = page.locator(".rme-block .remarkup-list-with-checkmarks > li");
    await items.first().click({ position: { x: 8, y: 10 } });
    expect(await source(page)).toBe("- [X] open\n- [X] done");
    // Still rendered, now checked.
    expect(await page.locator(".rme-editor .cm-line").filter({ hasText: /\S/ }).count()).toBe(0);
    expect(await items.first().getAttribute("class")).toContain("remarkup-checked-item");
    await items.nth(1).click({ position: { x: 8, y: 10 } });
    await expect.poll(() => source(page)).toBe("- [X] open\n- [ ] done");
    await expect(items.nth(1)).toHaveClass(/remarkup-unchecked-item/);
    // A click on the text edits it; its box still shows as a box.
    await page.locator(".rme-block li", { hasText: "open" }).click({ position: { x: 40, y: 10 } });
    const line = page.locator(".cm-line.rme-src-list", { hasText: "open" });
    await expect(line.locator(".rme-item-check .remarkup-checked-item")).toBeVisible();
    await line.locator(".rme-item-check").click();
    await expect.poll(() => source(page)).toBe("- [ ] open\n- [ ] done");
  });

  test("the table button asks for the size and opens the table for editing", async ({ page }) => {
    await openNewWikiPage(page, "New table");
    await editor(page).click();
    await page.keyboard.type("Intro.");
    await page.locator(".remarkup-assist-button:has(.fa-table)").click();
    const picker = page.locator(".rme-table-picker");
    await picker.locator('[data-col="2"][data-row="2"]').hover();
    await expect(picker).toContainText("3 × 2");
    await picker.locator('[data-col="2"][data-row="2"]').click();
    await expect
      .poll(() => source(page))
      .toBe(
        "Intro.\n\n| Column 1 | Column 2 | Column 3 |\n| -------- | -------- | -------- |\n|          |          |          |\n|          |          |          |\n\n",
      );
    // The first header cell is selected: typing names the column.
    await page.keyboard.type("Element");
    await expect.poll(() => source(page)).toMatch(/^Intro\.\n\n\| Element \| Column 2 \|/);
  });

  test("/ on an empty line opens a menu of what can be inserted", async ({ page }) => {
    await openNewWikiPage(page, "Insert menu");
    await editor(page).click();
    await page.keyboard.type("/tab");
    const menu = page.locator(".rme-autocomplete");
    await expect(menu.locator(".jx-result.focused")).toHaveText("Table");
    await page.keyboard.press("Enter");
    await expect.poll(() => source(page)).toMatch(/^\| Column 1 \| Column 2 \| Column 3 \|/);
    await expect(menu).toHaveCount(0);

    // Paths and "//" are text.
    await openNewWikiPage(page, "Insert menu 2");
    await editor(page).click();
    await page.keyboard.type("/");
    await expect(menu).toBeVisible();
    await page.keyboard.type("home/x");
    await expect(menu).toHaveCount(0);
    await page.keyboard.press("Enter");
    await page.keyboard.type("//italic//");
    await expect(menu).toHaveCount(0);
    expect(await source(page)).toBe("/home/x\n//italic//");

    await page.keyboard.type("\n\n/");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    expect(await source(page)).toBe("/home/x\n//italic//\n\n/");
  });

  test("the link button searches pages; links have a bubble to change or remove them", async ({ page }) => {
    await openNewWikiPage(page, "Links");
    await editor(page).click();
    await page.keyboard.type("Read the demo");
    await page.keyboard.press("Shift+Control+ArrowLeft");
    await page.keyboard.press("Control+k");
    const picker = page.locator(".rme-picker");
    await picker.locator("input").fill("Remarkup");
    await expect(picker.locator(".jx-result.focused")).toContainText("Remarkup Demo");
    await page.keyboard.press("Enter");
    await expect.poll(() => source(page)).toBe("Read the [[ demo/ | demo ]]");
    await expect(page.locator(".rme-picker")).toHaveCount(0);

    await page.keyboard.press("ArrowLeft");
    const bubble = page.locator(".rme-link-bubble");
    await expect(bubble.getByRole("link", { name: "Open" })).toBeVisible();
    await bubble.getByRole("link", { name: "Remove link" }).click();
    await expect.poll(() => source(page)).toBe("Read the demo");

    // A URL typed into the picker.
    await page.keyboard.press("End");
    await page.keyboard.press("Shift+Control+ArrowLeft");
    await page.locator(".remarkup-assist-button:has(.fa-link)").click();
    await picker.locator("input").fill("https://example.com/");
    await expect(picker.locator(".jx-result.focused")).toContainText("Link to https://example.com/");
    await page.keyboard.press("Enter");
    await expect.poll(() => source(page)).toBe("Read the [[ https://example.com/ | demo ]]");
  });

  test("tasks can be referenced by searching their title", async ({ page }) => {
    await openNewWikiPage(page, "Reference");
    await editor(page).click();
    await page.keyboard.type("See ");
    await page.keyboard.press("Control+Shift+k");
    const picker = page.locator(".rme-picker");
    await picker.locator("input").fill("calib");
    await expect(picker.locator(".jx-result.focused")).toContainText("T1: Calibrate the detector");
    await page.keyboard.press("Enter");
    await expect.poll(() => source(page)).toBe("See T1");
    await page.keyboard.type(".");
    await expect.poll(() => source(page)).toBe("See T1.");
  });

  test("Markdown's *italic* turns into remarkup, but not in code and URLs", async ({ page }) => {
    await openNewWikiPage(page, "Markdown");
    await editor(page).click();
    await page.keyboard.type("An *idea*");
    await expect.poll(() => source(page)).toBe("An //idea//");
    // Undo gives back what was typed.
    await page.keyboard.press("Control+z");
    await expect.poll(() => source(page)).toBe("An *idea*");
    await page.keyboard.press("End");
    await page.keyboard.type(" and `*not*`, ##a *b* c## and https://x.com/a/*b* [a site](https://example.com)");
    await expect
      .poll(() => source(page))
      .toBe("An *idea* and `*not*`, ##a *b* c## and https://x.com/a/*b* [a site](https://example.com)");
    // Markdown links are Phorge's links: they render.
    await blur(page);
    await expect(page.locator(".rme-block a", { hasText: "a site" })).toHaveAttribute("href", "https://example.com");
  });

  test("pasting rich text and spreadsheet cells gives remarkup", async ({ page }) => {
    await openNewWikiPage(page, "Paste");
    await editor(page).click();
    await page.keyboard.type("Intro.");
    await paste(page, { html: "<h2>Results</h2><ul><li><b>Fe</b> found</li><li>Cu</li></ul>" });
    await expect.poll(() => source(page)).toBe("Intro.\n\n= Results\n\n  - **Fe** found\n  - Cu");

    await openNewWikiPage(page, "Paste 2");
    await editor(page).click();
    await paste(page, { text: "Element\tLine\nFe\tKa\n" });
    await expect.poll(() => source(page)).toMatch(/^\| Element \| Line \|\n\| -+ \| -+ \|\n\| Fe +\| Ka +\|/);
  });

  test("Ctrl+Shift+V and code blocks get the plain text", async ({ page }) => {
    await openNewWikiPage(page, "Paste plain");
    await editor(page).click();
    await paste(page, { text: "Element\tLine" }, true);
    await expect.poll(() => source(page)).toBe("Element\tLine");
    await page.keyboard.insertText("\n\n```\ncode: \n```");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("End");
    await paste(page, { html: "<b>bold</b> text" });
    await expect.poll(() => source(page)).toBe("Element\tLine\n\n```\ncode: bold text\n```");
  });

  test("a URL pasted over selected text links it, but not in code", async ({ page }) => {
    await openNewWikiPage(page, "Paste link");
    await editor(page).click();
    await page.keyboard.type("see docs");
    await page.keyboard.press("Shift+Control+ArrowLeft");
    await paste(page, { text: "https://example.com/docs" });
    await expect.poll(() => source(page)).toBe("see [[ https://example.com/docs | docs ]]");
    await page.keyboard.type(" and `curl HOST`");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Shift+Control+ArrowLeft");
    await paste(page, { text: "https://example.com" });
    await expect
      .poll(() => source(page))
      .toBe("see [[ https://example.com/docs | docs ]] and `curl https://example.com`");
  });

  test("Phorge's preview below the form is hidden while the editor is on", async ({ page }) => {
    await openWithEditor(page, "/phriction/edit/2/");
    await expect(page.locator(".phui-remarkup-preview")).toBeHidden();
    await page.locator(".rme-toggle").click();
    await expect(page.locator(".phui-remarkup-preview")).toBeVisible();
  });

  test("lists indent with Tab and numbered items continue", async ({ page }) => {
    await openNewWikiPage(page, "List keys");
    await editor(page).click();
    await page.keyboard.type("1. one\ntwo");
    await page.keyboard.press("Tab");
    await expect.poll(() => source(page)).toBe("1. one\n  2. two");
    await page.keyboard.press("Shift+Tab");
    await expect.poll(() => source(page)).toBe("1. one\n2. two");
  });

  test("Ctrl+click opens a link of a rendered block", async ({ page, context }) => {
    await startWith(page, "Go to [[ https://example.com/ | the site ]].");
    const opened = context.waitForEvent("page");
    await page.locator(".rme-block a", { hasText: "the site" }).click({ modifiers: ["Control"] });
    expect((await opened).url()).toBe("https://example.com/");
    // Still rendered: Ctrl+click does not edit.
    await expect(page.locator(".rme-editor .cm-line").filter({ hasText: /\S/ })).toHaveCount(0);
  });

  test("autocomplete results can be picked with the arrow keys and the mouse", async ({ page }) => {
    await createTask(page, "Autocomplete keys");
    await addPhlair(page);
    await editor(page).click();
    await page.keyboard.type("Hi @a");
    const menu = page.locator(".rme-autocomplete");
    await expect(menu.locator(".jx-result")).not.toHaveCount(0);
    const count = await menu.locator(".jx-result").count();
    test.skip(count < 2, "Needs two users starting with a");
    await page.keyboard.press("ArrowDown");
    await expect(menu.locator(".jx-result").nth(1)).toHaveClass(/focused/);
    // The clicked result, not the focused one: "alice (Alice Example)" gives "@alice".
    const name = (await menu.locator(".jx-result").first().textContent())!.trim().split(" ")[0];
    await menu.locator(".jx-result").first().click();
    await expect.poll(() => source(page)).toBe(`Hi @${name} `);
  });
});

test.describe("reported issues", () => {
  test("memes render, also before Phorge made their image", async ({ page }) => {
    // A new text makes a new image, which Phorge makes on request.
    const above = `Hello ${Date.now()}`;
    await startWith(page, `{meme, src=rmecat, above=${above}, below=there}`);
    const image = page.locator(".rme-block img.phabricator-remarkup-macro");
    await expect(image).toHaveAttribute("src", /\S/);
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
    expect(await image.getAttribute("id")).toBeNull();
  });

  test("fullscreen: menus on top, the toolbar above the text", async ({ page }) => {
    await openNewWikiPage(page, "Fullscreen");
    await editor(page).click();
    await page.keyboard.insertText("| a | b |\n| 1 | 2 |\n\nText");
    await page.locator(".remarkup-assist-button:has(.fa-arrows-alt)").click();
    await expect(page.locator(".remarkup-control-fullscreen-mode")).toBeVisible();
    // On top: what is at the center of a menu is the menu itself.
    const onTop = (menu: string) =>
      page.locator(menu).evaluate((node) => {
        const box = node.getBoundingClientRect();
        return node.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
      });
    await editor(page).click();
    await page.keyboard.press("Control+/");
    expect(await onTop(".rme-shortcuts")).toBe(true);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" @al");
    await expect(page.locator(".rme-autocomplete .jx-result")).not.toHaveCount(0);
    expect(await onTop(".rme-autocomplete")).toBe(true);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+k");
    expect(await onTop(".rme-picker")).toBe(true);
    await page.keyboard.press("Escape");
    // With the cursor in the table, the toolbar has its table buttons, maybe in a second row.
    await page.keyboard.press("Control+Home");
    await expect(page.locator(".rme-table-bar")).toBeVisible();
    const bar = (await page.locator(".remarkup-control-fullscreen-mode .remarkup-assist-bar").boundingBox())!;
    const text = (await page.locator(".remarkup-control-fullscreen-mode .rme-editor").boundingBox())!;
    expect(text.y).toBeGreaterThanOrEqual(bar.y + bar.height - 1);
  });

  test("the reference button and shortcut open the search without scrolling", async ({ page }) => {
    await openNewWikiPage(page, "Reference button");
    await editor(page).click();
    // A long page, edited at the top.
    await page.keyboard.insertText("\n\n" + Array.from({ length: 80 }, (_, i) => `Paragraph ${i}.`).join("\n\n"));
    await page.keyboard.press("Control+Home");
    await page.keyboard.type("See ");
    const scroll = () => page.evaluate(() => window.scrollY);
    const before = await scroll();
    await page.locator(".rme-format:has(.fa-anchor)").click();
    const picker = page.locator(".rme-picker");
    await expect(picker.locator("input")).toBeFocused();
    await page.waitForTimeout(300);
    await expect(picker).toBeVisible();
    expect(await scroll()).toBe(before);
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
    await page.keyboard.press("Control+Shift+k");
    await expect(picker.locator("input")).toBeFocused();
    expect(await scroll()).toBe(before);
  });

  test("lines pasted into a quote stay in the quote", async ({ page }) => {
    await openNewWikiPage(page, "Quote paste");
    await editor(page).click();
    await page.keyboard.type("> Said: ");
    await paste(page, { text: "first\nsecond\n\nthird\n" });
    await expect.poll(() => source(page)).toBe("> Said: first\n> second\n>\n> third");
  });

  test("empty table cells are a line high", async ({ page }) => {
    await openNewWikiPage(page, "Empty cells");
    await editor(page).click();
    await page.locator(".remarkup-assist-button:has(.fa-table)").click();
    await page.locator('.rme-table-picker [data-col="1"][data-row="1"]').click();
    const heights = await page
      .locator(".rme-table-editor tr")
      .evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().height));
    // Like the header row (whose border makes it a bit higher).
    expect(heights[1]).toBeGreaterThan(heights[0] - 4);
    await page.locator(".rme-table-editor td").first().click();
    await page.keyboard.type("x");
    await expect.poll(() => source(page)).toMatch(/\n\| x +\|/);
  });

  test("Phorge's preview button switches between the editor and its preview", async ({ page }) => {
    await startWith(page, "Some **text**.");
    const button = page.locator(".remarkup-assist-button:has(.fa-eye)");
    await button.click();
    const preview = page.locator(".remarkup-inline-preview");
    await expect(preview.locator("strong")).toHaveText("text");
    await expect(page.locator(".rme-editor")).toBeHidden();
    expect(await preview.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(40);
    await button.click();
    await expect(page.locator(".rme-editor")).toBeVisible();
    await expect(preview).toHaveCount(0);
  });

  test("a click anywhere in an empty editor enters it", async ({ page }) => {
    await openNewWikiPage(page, "Empty editor");
    const box = (await page.locator(".rme-editor").boundingBox())!;
    expect(box.height).toBeGreaterThan(80);
    await page.mouse.click(box.x + box.width / 2, box.y + box.height - 15);
    await expect(editor(page)).toBeFocused();
    await page.keyboard.type("Typed.");
    await expect.poll(() => source(page)).toBe("Typed.");
  });
});

test("a click between a heading and the line below it types on that line", async ({ page }) => {
  await startWith(page, "= Title\nText line.\n\nMore.");
  const between = async () => {
    const heading = (await page.locator(".rme-block h2").boundingBox())!;
    const text = (await page.locator(".rme-block p, .cm-line", { hasText: "Text line." }).first().boundingBox())!;
    await page.mouse.click(heading.x + 50, (heading.y + heading.height + text.y) / 2);
  };
  await between();
  await page.keyboard.type("abc ");
  await expect.poll(() => source(page)).toBe("= Title\nabc Text line.\n\nMore.");
  // Again, with the line below now being edited.
  await between();
  await page.keyboard.type("x");
  await expect.poll(() => source(page)).toBe("= Title\nxabc Text line.\n\nMore.");
});

test("blocks are as far apart as in Phorge's preview", async ({ page }) => {
  const text = [
    "Paragraph.",
    "= Heading",
    "== Heading right after",
    "Paragraph.",
    "---",
    "Paragraph.",
    "NOTE: A note.",
    "- A list",
    "> A quote.",
    "```\ncode\n```",
    "| a | b |\n| 1 | 2 |",
    "=== Heading",
    // Blocks on consecutive lines.
    "= Sprint Review\n== Changelog\nText right below.",
    "---\n---\n\n---",
    "Last.",
  ].join("\n\n");
  await startWith(page, text);
  await page.addStyleTag({ content: ".phui-remarkup-preview { display: block !important; }" });
  const preview = page.locator(".phui-remarkup-preview .phui-preview-body .phabricator-remarkup");
  await expect(preview).toContainText("Last.");
  // Gaps between the blocks: in the editor between the rendered blocks, in the
  // preview between its elements.
  const gaps = (selector: string) =>
    page
      .locator(selector)
      .evaluateAll((blocks) =>
        blocks
          .slice(1)
          .map((b, i) => Math.round(b.getBoundingClientRect().top - blocks[i].getBoundingClientRect().bottom)),
      );
  const expected = await gaps(".phui-remarkup-preview .phui-preview-body .phabricator-remarkup > *");
  // Within a pixel: positions are rounded.
  await expect
    .poll(async () => (await gaps(".rme-editor .rme-block")).map((gap, i) => Math.abs(gap - expected[i]) <= 1))
    .toEqual(expected.map(() => true));
  // Entering a block keeps the gaps and the text below in place.
  const before = await gaps(".rme-editor .rme-block");
  const last = () => page.locator(".rme-block", { hasText: "Last." }).evaluate((el) => el.getBoundingClientRect().top);
  const top = await last();
  await page.locator(".rme-block h3", { hasText: "Heading right after" }).click();
  await expect(page.locator(".cm-line.rme-src-h2")).toBeVisible();
  expect(await last()).toBeCloseTo(top, 0);
  await blur(page);
  await expect.poll(() => gaps(".rme-editor .rme-block")).toEqual(before);
  // Also a heading right below another one.
  await page.locator(".rme-block h3", { hasText: "Changelog" }).click();
  await expect(page.locator(".cm-line.rme-src-h2", { hasText: "Changelog" })).toBeVisible();
  expect(await last()).toBeCloseTo(top, 0);
});

test("table source columns line up with emoji in cells", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("phizziwig-table-mode", "text"));
  await openNewWikiPage(page, "Emoji");
  await editor(page).click();
  await page.keyboard.insertText("| 😀 ok | a |\n| abc | b |\n| 👍🏽 | c |");
  await page
    .locator(".rme-table-bar")
    .getByRole("button", { name: /^Align the columns/ })
    .click();
  await expect.poll(() => source(page)).toBe("| 😀 ok | a   |\n| abc   | b   |\n| 👍🏽    | c   |");
  const pipes = await page
    .locator(".cm-line.rme-src-table")
    .evaluateAll((lines) => lines.map((line) => line.querySelectorAll(".rme-markup")[1].getBoundingClientRect().left));
  expect(pipes).toHaveLength(3);
  for (const x of pipes) {
    expect(Math.abs(x - pipes[0])).toBeLessThan(1);
  }
});

test.describe("narrow windows", () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test("show all toolbar buttons, wrapped, without scrolling sideways", async ({ page }) => {
    await openNewWikiPage(page, "Phone");
    await editor(page).click();
    // Phorge hides these on phones.
    for (const icon of ["fa-bold", "fa-italic", "fa-link", "fa-table", "fa-header"]) {
      await expect(page.locator(`.remarkup-assist-bar .remarkup-assist-button:has(.${icon})`)).toBeVisible();
    }
    await page.keyboard.insertText("| a | b |\n| 1 | 2 |\n\n```\n" + "x".repeat(300) + "\n```\n\nEnd.");
    await page.keyboard.press("Control+Home");
    await expect(page.locator(".rme-table-bar")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    // The table buttons line up with the others in their row.
    const rows = await page.locator(".remarkup-assist-bar .remarkup-assist-button:visible").evaluateAll((buttons) =>
      buttons.map((b) => {
        const glyph = b.querySelector(".remarkup-assist")!.getBoundingClientRect();
        return {
          top: Math.round(b.getBoundingClientRect().top),
          glyph: glyph.top + glyph.height / 2 - b.getBoundingClientRect().top,
        };
      }),
    );
    for (const { top, glyph } of rows) {
      const native = rows.find((r) => r.top === top)!;
      expect(Math.abs(glyph - native.glyph), `row at ${top}`).toBeLessThan(1.5);
    }
    await blur(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test("toolbar buttons fill each row before the next one starts", async ({ page }) => {
    await openNewWikiPage(page, "Phone rows");
    await page.locator(".rme-block, .cm-content").first().click();
    await page.keyboard.insertText("| a | b |\n| 1 | 2 |");
    await page.keyboard.press("Control+Home");
    await expect(page.locator(".rme-table-bar")).toBeVisible();
    const free = await page.locator(".remarkup-assist-bar").evaluate((bar) => {
      const barBox = bar.getBoundingClientRect();
      const buttons = Array.from(bar.querySelectorAll<HTMLElement>(".remarkup-assist-button")).filter(
        (b) => b.offsetParent !== null,
      );
      const rows = new Map<number, { left: number; right: number }>();
      for (const b of buttons) {
        const box = b.getBoundingClientRect();
        const row = rows.get(Math.round(box.top)) ?? { left: Infinity, right: 0 };
        rows.set(Math.round(box.top), { left: Math.min(row.left, box.left), right: Math.max(row.right, box.right) });
      }
      const width = buttons[0].getBoundingClientRect().width;
      // Free space at the start of each row and at the end of each but the last, in buttons.
      return Array.from(rows.values()).map(({ left, right }, i) => ({
        start: (left - barBox.left) / width,
        end: i === rows.size - 1 ? 0 : (barBox.right - right) / width,
      }));
    });
    expect(free.length).toBeGreaterThan(1);
    for (const { start, end } of free) {
      expect(start).toBeLessThan(0.5);
      expect(end).toBeLessThan(1.5);
    }
  });
});

test.describe("touch screens", () => {
  test.use({ viewport: { width: 390, height: 800 }, hasTouch: true });

  test("a long press on an image opens the image menu", async ({ page, browserName }) => {
    test.skip(browserName === "firefox", "Firefox has no touch events on desktop");
    await startWith(page, "Before.\n\n{F1}");
    await page.locator(".rme-block img").evaluate((img) => {
      const box = img.getBoundingClientRect();
      const touch = new Touch({ identifier: 1, target: img, clientX: box.left + 5, clientY: box.top + 5 });
      img.dispatchEvent(new TouchEvent("touchstart", { touches: [touch], bubbles: true }));
    });
    await expect(page.locator(".rme-image-menu")).toBeVisible();
    await page.locator(".rme-image-menu a", { hasText: "Full width" }).click();
    await expect.poll(() => source(page)).toBe("Before.\n\n{F1, size=wide}");
  });
});

test.describe("Dark Reader", () => {
  // As in Firefox with the extension: Dark Reader changes the page's styles,
  // but not the editor's own.
  const DARK_READER = readFileSync(new URL("../node_modules/darkreader/darkreader.js", import.meta.url), "utf8");
  const TEXT = [
    "= Title",
    "Text with **bold**, `code`, !!highlight!! and [[ demo/ | a link ]], T1, @alice.",
    "NOTE: A note.",
    "WARNING: A warning.",
    "> A quote.",
    "```\ncode block\n```",
    "| a | b |\n| --- | --- |\n| 1 | 2 |",
    "- [ ] item",
  ].join("\n\n");

  /** The lowest contrast of text in the editor against what is behind it. */
  const lowestContrast = (page: Page) =>
    page.locator(".rme-editor").evaluate((root) => {
      const parse = (color: string): number[] => {
        const srgb = /color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.e-]+))?\)/.exec(color);
        if (srgb) {
          return [...srgb.slice(1, 4).map((v) => Number(v) * 255), srgb[4] === undefined ? 1 : Number(srgb[4])];
        }
        const rgb = /rgba?\(([\d.]+),? ([\d.]+),? ([\d.]+)(?:,? \/? ?([\d.]+))?\)/.exec(color);
        if (!rgb) {
          throw new Error(`Color ${color}`);
        }
        return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), rgb[4] === undefined ? 1 : Number(rgb[4])];
      };
      const over = (top: number[], bottom: number[]) =>
        [0, 1, 2].map((i) => top[i] * top[3] + bottom[i] * (1 - top[3]));
      const background = (el: Element | null): number[] => {
        const layers: number[][] = [];
        for (; el; el = el.parentElement) {
          const color = parse(getComputedStyle(el).backgroundColor);
          if (color[3] > 0) {
            layers.push(color);
            if (color[3] === 1) {
              break;
            }
          }
        }
        return layers.reverse().reduce((below, layer) => over(layer, below), [255, 255, 255]);
      };
      const luminance = (c: number[]) => {
        const [r, g, b] = c.map((v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      let lowest = { contrast: 21, text: "" };
      const walker = document.createTreeWalker(root.querySelector(".cm-content")!, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const el = node.parentElement!;
        if (!node.textContent!.trim() || el.closest(".cm-widgetBuffer")) {
          continue;
        }
        const back = background(el);
        const fore = over(parse(getComputedStyle(el).color), back);
        const [a, b] = [luminance(fore), luminance(back)].sort((x, y) => y - x);
        const contrast = (a + 0.05) / (b + 0.05);
        if (contrast < lowest.contrast) {
          lowest = { contrast, text: `${node.textContent} (${el.className || el.tagName})` };
        }
      }
      return lowest;
    });

  test("keeps all text readable, rendered and while editing", async ({ page }) => {
    await startWith(page, TEXT);
    await page
      .locator("style")
      .evaluateAll((styles) =>
        styles.filter((s) => s.textContent!.includes(".rme-editor")).forEach((s) => s.classList.add("darkreader")),
      );
    await page.evaluate(DARK_READER);
    await page.evaluate(() => {
      const reader = (
        window as unknown as { DarkReader: { setFetchMethod(f: typeof fetch): void; enable(theme: object): void } }
      ).DarkReader;
      reader.setFetchMethod(window.fetch);
      reader.enable({ brightness: 100, contrast: 90, sepia: 10 });
    });
    // The editor takes the dark background of the page.
    await expect
      .poll(() => page.locator(".rme-editor").evaluate((el) => getComputedStyle(el).backgroundColor))
      .toMatch(/^rgb\((\d|[1-5]\d), /);
    expect((await lowestContrast(page)).contrast).toBeGreaterThan(3);
    // All blocks as source.
    await editor(page).click();
    await page.keyboard.press("Control+a");
    await expect(page.locator(".cm-line.rme-src-note").first()).toBeVisible();
    const lowest = await lowestContrast(page);
    expect(lowest.contrast, lowest.text).toBeGreaterThan(3);
  });
});

test.describe("in Phorge's pages", () => {
  test("Differential inline comments", async ({ page }) => {
    await createRevision(page, "Inline comments");
    await addPhlair(page);
    await page.locator("td.new.n").first().click();
    const inline = page.locator(".differential-inline-comment-edit");
    await inline.locator(".rme-editor .cm-content").click();
    await page.keyboard.type("Check **this**.");
    await expect(inline.locator("textarea.remarkup-assist-textarea")).toHaveValue("Check **this**.");
    // Typed keys are not Differential's shortcuts ("h" hides the changeset).
    await expect(page.locator("td.new.n").first()).toBeVisible();
    await inline.getByRole("button", { name: /Save/ }).click();
    const saved = page.locator(".differential-inline-comment:not(.inline-comment-preview)", { hasText: "Check this." });
    await expect(saved.locator("strong", { hasText: "this" })).toBeVisible();
  });

  test("comments: drafts survive a reload, Quote and Edit Comment work", async ({ page }) => {
    await createTask(page, "Comment flows");
    await addPhlair(page);
    await editor(page).click();
    // Phorge saves drafts while typing: wait for the one with all of the text.
    const saved = page.waitForResponse(
      (r) =>
        r.request().method() === "POST" &&
        /\/comment\/$/.test(r.url()) &&
        new URLSearchParams(r.request().postData() ?? "").get("comment") === "Draft **one**.",
    );
    await page.keyboard.type("Draft **one**.");
    await saved;
    await page.reload();
    await addPhlair(page);
    await expect(page.locator(".rme-block strong")).toHaveText("one");

    // Posting the comment reloads the page; the userscript would run again.
    await editor(page).click();
    const reloaded = page.waitForEvent("load");
    await page.keyboard.press("Control+Enter");
    await reloaded;
    await addPhlair(page);
    await expect(page.locator(".phui-timeline-view strong", { hasText: "one" })).toBeVisible();
    await expect.poll(() => textarea(page).inputValue()).toBe("");

    // Quote: Phorge fills the textarea, the editor follows.
    const menu = page.locator(".phui-timeline-shell", { hasText: "Draft one." }).locator(".phui-timeline-menu");
    await menu.click();
    await page.getByRole("link", { name: "Quote Comment" }).click();
    await expect.poll(() => textarea(page).inputValue()).toMatch(/^> Draft \*\*one\*\*\./m);
    await expect(page.locator(".rme-editor :is(blockquote, .cm-line.rme-src-quote)").first()).toBeVisible();

    // Edit Comment opens a dialog with the editor in it.
    await menu.click();
    await page.getByRole("link", { name: "Edit Comment" }).click();
    const dialog = page.locator(".jx-client-dialog");
    await dialog.locator(".rme-editor .cm-content").click();
    await page.keyboard.press("Control+End");
    await page.keyboard.type(" Edited.");
    await expect(dialog.locator("textarea.remarkup-assist-textarea")).toHaveValue("Draft **one**. Edited.");
    await dialog.getByRole("button", { name: /Save/ }).click();
    await expect(page.locator(".phui-timeline-view", { hasText: "Draft one. Edited." }).first()).toBeVisible();
  });

  test("the pinned comment form", async ({ page }) => {
    await createTask(page, "Pinned form");
    await addPhlair(page);
    await page.locator("body").click({ position: { x: 5, y: 300 } });
    await page.keyboard.press("z");
    await expect(page.locator(".remarkup-assist-pinned .rme-editor")).toBeVisible();
    await editor(page).click();
    await page.keyboard.type("Pinned **text**");
    await expect(textarea(page)).toHaveValue("Pinned **text**");
  });

  test("Mac: Cmd instead of Ctrl", async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, "platform", { get: () => "MacIntel" }));
    await openNewWikiPage(page, "Mac");
    await editor(page).click();
    await page.keyboard.type("bold");
    await page.keyboard.press("Shift+Control+ArrowLeft");
    await page.keyboard.press("Meta+b");
    await expect.poll(() => source(page)).toBe("**bold**");
    await page.locator(".rme-format:has(.fa-strikethrough)").hover();
    await expect(page.locator(".jx-tooltip")).toHaveText("Strikethrough (⌘⇧X)");
  });

  test("← and → move the cursor on pages that use them as shortcuts", async ({ page }) => {
    await openNewWikiPage(page, "Arrows");
    // Like Pholio, where ← and → show other images.
    await page.evaluate(() => {
      const JX = (window as unknown as { JX: any }).JX;
      new JX.KeyboardShortcut(["left", "right"], "test")
        .setHandler(() => document.body.setAttribute("data-hit", "1"))
        .register();
    });
    await editor(page).click();
    await page.keyboard.type("abc");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.type("X");
    await expect.poll(() => source(page)).toBe("aXbc");
    expect(await page.locator("body").getAttribute("data-hit")).toBeNull();
  });
});

test.describe("review fixes", () => {
  test("the insert menu: Enter on a lone / is a new line, link and table items keep their focus", async ({ page }) => {
    await openNewWikiPage(page, "Slash");
    await editor(page).click();
    await page.keyboard.type("/");
    await page.keyboard.press("Enter");
    await page.keyboard.type("next");
    await expect.poll(() => source(page)).toBe("/\nnext");

    await page.keyboard.type("\n\n/link");
    await page.keyboard.press("Enter");
    await expect(page.locator(".rme-picker input")).toBeFocused();
    await page.keyboard.press("Escape");

    await page.keyboard.type("/table");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Element");
    await expect.poll(() => source(page)).toMatch(/\| Element \| Column 2 \|/);

    // Not in code.
    await openNewWikiPage(page, "Slash 2");
    await editor(page).click();
    await page.keyboard.insertText("```\nx\n```");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("End");
    await page.keyboard.type("\n/");
    await expect(page.locator(".rme-autocomplete")).toHaveCount(0);
  });

  test("F1 opens the shortcut overview", async ({ page }) => {
    await openNewWikiPage(page, "F1");
    await editor(page).click();
    await page.keyboard.press("F1");
    await expect(page.locator(".rme-shortcuts")).toBeVisible();
  });

  test("Enter in the search right after typing takes the first result for what is typed", async ({ page }) => {
    await openNewWikiPage(page, "Fast picker");
    await editor(page).click();
    await page.keyboard.press("Control+Shift+k");
    const input = page.locator(".rme-picker input");
    // Results of an earlier query are showing: Enter must not take those.
    await input.fill("Remarkup");
    await expect(page.locator(".rme-picker .jx-result.focused")).toContainText("Remarkup Demo");
    await input.fill("calib");
    await page.keyboard.press("Enter");
    await expect.poll(() => source(page)).toBe("T1");
  });

  test("a bare URL changed to a task becomes its reference; Open stays on the site", async ({ page, context }) => {
    await openNewWikiPage(page, "Bare URL");
    await editor(page).click();
    await page.keyboard.type("See https://example.com/x now");
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("ArrowLeft");
    }
    await page.keyboard.press("Control+k");
    await page.locator(".rme-picker input").fill("T1");
    await expect(page.locator(".rme-picker .jx-result.focused")).toContainText("T1:");
    await page.keyboard.press("Enter");
    await expect.poll(() => source(page)).toBe("See T1 now");

    await page.keyboard.press("End");
    await page.keyboard.type(" [[ //evil.example/x | there ]]");
    await page.keyboard.press("ArrowLeft");
    const opened = context.waitForEvent("page");
    await page.locator(".rme-link-bubble").getByRole("link", { name: "Open" }).click();
    expect(new URL((await opened).url()).host).toBe(new URL(page.url()).host);
  });

  test("a named link can be typed in a table cell", async ({ page }) => {
    await startWith(page, "| a | b |\n| 1 | 2 |");
    await page.locator(".rme-table-editor td", { hasText: "1" }).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" [[ https://example.com | name");
    await expect.poll(() => source(page)).toBe("| a | b |\n| 1 [[ https://example.com | name]] | 2 |");
  });

  test("a click on repeated text lands on the clicked occurrence", async ({ page }) => {
    await startWith(page, "- Yes\n- Yes");
    await page
      .locator(".rme-block li")
      .nth(1)
      .click({ position: { x: 20, y: 8 } });
    const line = await textarea(page).evaluate(
      (t: HTMLTextAreaElement) => t.value.slice(0, t.selectionStart).split("\n").length,
    );
    expect(line).toBe(2);
  });

  test("a block that failed is forgotten when its text is gone", async ({ page }) => {
    let failed = 0;
    await page.route("**/phriction/preview/**", (route) => {
      if (route.request().postData()?.includes("bad")) {
        failed++;
        return route.fulfill({ status: 500, body: "Server error" });
      }
      return route.fallback();
    });
    await openNewWikiPage(page, "Forget failures");
    await editor(page).click();
    await page.keyboard.insertText("bad");
    await blur(page);
    await expect(page.locator(".rme-status")).toBeVisible();
    await editor(page).click();
    await page.keyboard.press("Control+a");
    await page.keyboard.insertText("good");
    await blur(page);
    await expect(page.locator(".rme-status")).toBeHidden();
    // Requests made while the text was still "bad" may reach the route late on a busy machine.
    await page.waitForTimeout(500);
    const count = failed;
    // No retries of "bad" any more (the first retry would come after 2 s).
    await page.waitForTimeout(2500);
    expect(failed).toBe(count);
  });

  test("dragging selected text does not keep the blocks from switching", async ({ page }) => {
    await openNewWikiPage(page, "Drag");
    await editor(page).click();
    await page.keyboard.insertText("Alpha beta gamma.\n\nLast.");
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("Shift+Control+ArrowRight");
    const word = (await page.locator(".cm-line", { hasText: "Alpha" }).boundingBox())!;
    await page.mouse.move(word.x + 10, word.y + word.height / 2);
    await page.mouse.down();
    await page.mouse.move(word.x + 150, word.y + word.height / 2, { steps: 5 });
    await page.mouse.up();
    await page.keyboard.press("Control+End");
    await expect(page.locator(".cm-line", { hasText: "Last." })).toBeVisible();
    await page.keyboard.type("!");
    await expect.poll(() => source(page)).toMatch(/Last\.!$/);
  });
});

test.describe("second test round", () => {
  test("the insert menu: arrow keys and Enter pick an item, and it fits in a low window", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 520 });
    await page.goto("/maniphest/task/edit/form/default/");
    await addPhlair(page);
    await editor(page).click();
    await page.keyboard.type("/");
    const menu = page.locator(".rme-autocomplete");
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(520);
    // The second item: referencing.
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(page.locator(".rme-picker")).toContainText("Reference:");
  });

  test("the link commands change a selected link instead of linking it again", async ({ page }) => {
    await openNewWikiPage(page, "Selected link");
    await editor(page).click();
    const link = "[[ https://example.com | site ]]";
    await page.keyboard.type(`See ${link}`);
    // The whole link selected, from its end to its start.
    for (let i = 0; i < link.length; i++) {
      await page.keyboard.press("Shift+ArrowLeft");
    }
    await page.keyboard.press("Control+Shift+k");
    const picker = page.locator(".rme-picker");
    await expect(picker).toContainText("Change Link:");
    await picker.locator("input").fill("https://example.org/");
    await expect(picker.locator(".jx-result.focused")).toContainText("Link to https://example.org/");
    await page.keyboard.press("Enter");
    await expect.poll(() => source(page)).toBe("See [[ https://example.org/ | site ]]");
    // The cursor right after a link: the link button changes it too.
    await page.keyboard.press("End");
    await page.locator(".remarkup-assist-button:has(.fa-link)").click();
    await expect(picker).toContainText("Change Link:");
  });

  test("links in table cells have their bubble and the link command", async ({ page }) => {
    await startWith(page, "| Element | Source |\n| Fe | [[ https://example.com | site ]] |");
    await page.locator(".rme-table-editor td", { hasText: "site" }).click();
    await page.keyboard.press("Home");
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("ArrowRight");
    }
    const bubble = page.locator(".rme-cell-bubble");
    await expect(bubble.getByRole("link", { name: "Open" })).toBeVisible();
    await bubble.getByRole("link", { name: "Remove link" }).click();
    await expect.poll(() => source(page)).toBe("| Element | Source |\n| Fe | site |");

    await page.locator(".rme-table-editor td", { hasText: "Fe" }).click();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+k");
    await page.locator(".rme-picker input").fill("https://example.com/fe");
    await expect(page.locator(".rme-picker .jx-result.focused")).toContainText("Link to");
    await page.keyboard.press("Enter");
    await expect.poll(() => source(page)).toBe("| Element | Source |\n| [[ https://example.com/fe | Fe ]] | site |");
  });

  test("a click on the blank line between a paragraph and a heading opens it for typing", async ({ page }) => {
    await startWith(page, "Some text.\n\n= Heading");
    const text = (await page.locator(".rme-block p").boundingBox())!;
    const heading = (await page.locator(".rme-block h2").boundingBox())!;
    // Held like a person clicks: the editor gets the focus before the button is up.
    await page.mouse.move(text.x + 40, (text.y + text.height + heading.y) / 2);
    await page.mouse.down();
    await page.waitForTimeout(150);
    await page.mouse.up();
    // Right away, before typing anything (later renderings would redraw it
    // anyway): the blank line is a full line.
    await page.waitForTimeout(100);
    const blank = page.locator(".cm-line").filter({ hasText: /^$/ });
    expect(await blank.evaluate((line) => line.getBoundingClientRect().height)).toBeGreaterThan(18);
    await page.keyboard.type("New");
    await expect.poll(() => source(page)).toBe("Some text.\nNew\n= Heading");
  });

  test("text flows around a floating image while it is edited", async ({ page }) => {
    await startWith(page, `{F1, float, layout=left} ${"Text flowing around the image. ".repeat(4)}\n\nNext paragraph.`);
    const next = () =>
      page.locator(".rme-block", { hasText: "Next paragraph." }).evaluate((e) => e.getBoundingClientRect().top);
    const before = await next();
    const paragraph = (await page.locator(".rme-block p").first().boundingBox())!;
    await page.mouse.click(paragraph.x + paragraph.width - 20, paragraph.y + 30);
    const image = (await page.locator(".rme-preview-float img").boundingBox())!;
    const textLeft = await page.locator(".cm-line", { hasText: "Text flowing" }).evaluate((line) => {
      const range = document.createRange();
      range.selectNodeContents(line);
      return range.getClientRects()[0].left;
    });
    expect(textLeft).toBeGreaterThan(image.x + image.width);
    await expect.poll(next).toBeCloseTo(before, 0);
  });

  test("tables: a bar beside the table and + buttons on its borders", async ({ page }) => {
    await startWith(page, "Intro.\n\n| Element | Line |\n| --- | --- |\n| Fe | Ka |\n| Cu | Ka |\n\nAfter.");
    await page.locator(".rme-table-editor td", { hasText: "Fe" }).click();
    await expect(page.locator(".rme-table-bar")).toBeVisible();
    const bar = (await page.locator(".rme-table-bar").boundingBox())!;
    const table = (await page.locator(".rme-table-editor table").boundingBox())!;
    expect(bar.x).toBeGreaterThan(table.x + table.width);
    // A row between Fe and Cu.
    const fe = (await page.locator(".rme-table-editor td", { hasText: "Fe" }).boundingBox())!;
    await page.mouse.move(fe.x + 5, fe.y + fe.height - 1);
    await page.locator(".rme-table-insert-row").click();
    await expect.poll(() => source(page)).toMatch(/\| Fe +\| Ka +\|\n\| +\| +\|\n\| Cu/);
    // A column right of Element.
    const header = (await page.locator(".rme-table-editor th", { hasText: "Element" }).boundingBox())!;
    await page.mouse.move(header.x + header.width - 1, header.y + 3);
    await page.locator(".rme-table-insert-column").click();
    await expect.poll(() => source(page)).toMatch(/^Intro\.\n\n\| Element \| +\| Line \|/);
    // The buttons are not part of the table's text.
    await expect(page.locator(".rme-table-editor")).not.toContainText("+");
  });

  test("pasted Markdown becomes remarkup; Ctrl+Z gives it back as pasted", async ({ page }) => {
    await openNewWikiPage(page, "Markdown paste");
    await editor(page).click();
    const markdown = "## Steps\n\n- *First* step\n- __Second__ step";
    await paste(page, { text: markdown });
    await expect.poll(() => source(page)).toBe("== Steps\n\n- //First// step\n- **Second** step");
    await page.keyboard.press("Control+z");
    await expect.poll(() => source(page)).toBe(markdown);
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Delete");
    await paste(page, { text: markdown }, true);
    await expect.poll(() => source(page)).toBe(markdown);
  });

  test("* and ` typed over selected text make it bold or monospaced", async ({ page }) => {
    await openNewWikiPage(page, "Wrap");
    await editor(page).click();
    await page.keyboard.type("one two");
    await page.keyboard.press("Shift+Control+ArrowLeft");
    await page.keyboard.type("*");
    await expect.poll(() => source(page)).toBe("one **two**");
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+Control+ArrowRight");
    await page.keyboard.type("`");
    await expect.poll(() => source(page)).toBe("`one` **two**");
  });

  test("Ctrl+Shift+1–5 make headings of that level", async ({ page }) => {
    await openNewWikiPage(page, "Heading keys");
    await editor(page).click();
    await page.keyboard.type("Title");
    await page.keyboard.press("Control+Shift+2");
    await expect.poll(() => source(page)).toBe("== Title");
    await page.keyboard.press("Control+Shift+4");
    await expect.poll(() => source(page)).toBe("==== Title");
    await page.keyboard.press("Control+Shift+4");
    await expect.poll(() => source(page)).toBe("Title");
    await page.locator(".rme-format:has(.fa-header)").hover();
    await expect(page.locator(".jx-tooltip")).toContainText("Ctrl+Shift+1–5");
  });
});

test.describe("third test round", () => {
  const PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  test("images of pasted text (an email) are uploaded and embedded", async ({ page }) => {
    await openNewWikiPage(page, "Email paste");
    await editor(page).click();
    await paste(page, {
      html:
        `<p>Hello <b>team</b>,</p><p><img src="${PNG}" alt="Logo"></p>` +
        `<ul><li>see the chart:</li></ul><p><img src="https://example.invalid/chart.png" alt="Chart"></p>`,
    });
    // Uploaded: the inline image. Not readable: the other keeps its link.
    await expect
      .poll(() => source(page), { timeout: 15_000 })
      .toMatch(
        /^Hello \*\*team\*\*,\n\n\{F\d+\}\n\n  - see the chart:\n\n\[\[ https:\/\/example\.invalid\/chart\.png \| Chart \]\]$/,
      );
    const metadata = await page.locator('input[name="content_metadata"]').inputValue();
    expect(JSON.parse(metadata).attachedFilePHIDs).toHaveLength(1);
  });

  test("{ and [ typed over selected text put it in braces or brackets", async ({ page }) => {
    await openNewWikiPage(page, "Braces");
    await editor(page).click();
    await page.keyboard.type("F1 and T1");
    await page.keyboard.press("Shift+Control+ArrowLeft");
    await page.keyboard.type("[");
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+Control+ArrowRight");
    await page.keyboard.type("{");
    await expect.poll(() => source(page)).toBe("{F1} and [T1]");
    await expect(page.locator(".rme-autocomplete")).toHaveCount(0);
  });

  test("a block starting with an image shows it above its text while edited", async ({ page }) => {
    await startWith(page, "{F1}\nBelow the image.");
    const image = () =>
      page
        .locator(".rme-editor img")
        .first()
        .evaluate((img) => img.getBoundingClientRect().top);
    const before = await image();
    await page.locator(".rme-block", { hasText: "Below the image." }).click({ position: { x: 300, y: 5 } });
    const line = page.locator(".cm-line", { hasText: "{F1}" });
    await expect(line).toBeVisible();
    expect(await line.evaluate((l) => l.getBoundingClientRect().top)).toBeGreaterThan(
      await page.locator(".rme-image-preview img").evaluate((img) => img.getBoundingClientRect().bottom),
    );
    expect(Math.abs((await image()) - before)).toBeLessThan(2);
  });
});

test.describe("fourth test round", () => {
  test("images of a pasted Wikipedia article are uploaded, also from sites the page's CSP blocks", async ({ page }) => {
    const site = await imageSite(false);
    try {
      await openNewWikiPage(page, "Wikipedia paste");
      await editor(page).click();
      await paste(page, {
        html:
          `<figure typeof="mw:File/Thumb"><a href="https://en.wikipedia.org/wiki/File:Iron.png" class="mw-file-description">` +
          `<img src="${site.url}/image.png" alt=""></a><figcaption>Iron</figcaption></figure>` +
          `<p><b>Iron</b> is a <a href="https://en.wikipedia.org/wiki/Metal">metal</a>.</p>` +
          `<p><a href="https://en.wikipedia.org/wiki/File:Gone.png"><img src="//upload.example.invalid/gone.png" alt=""></a></p>`,
      });
      // The image the browser may not fetch itself (CSP) comes through the userscript manager.
      await expect
        .poll(() => source(page), { timeout: 15_000 })
        .toMatch(
          /^\{F\d+\}\n\nIron\n\n\*\*Iron\*\* is a \[\[ https:\/\/en\.wikipedia\.org\/wiki\/Metal \| metal \]\]\.\n\nhttps?:\/\/upload\.example\.invalid\/gone\.png$/,
        );
    } finally {
      site.close();
    }
  });

  test("the list buttons of Phorge's toolbar switch the kind of the list level, indented", async ({ page }) => {
    const toolbarButton = (icon: string) => page.locator(`.remarkup-assist-bar .remarkup-assist.${icon}`).first();
    await startWith(page, "- a\n  - b\n- c\n\nText");
    await page.locator(".rme-block li", { hasText: /^c$/ }).click();
    // "# a" at the start of a line would be a header: the whole list moves in.
    await toolbarButton("fa-list-ol").click();
    await expect.poll(() => source(page)).toBe("  # a\n    - b\n  # c\n\nText");
    await toolbarButton("fa-check-square-o").click();
    await expect.poll(() => source(page)).toBe("  - [ ] a\n    - b\n  - [ ] c\n\nText");
    await toolbarButton("fa-list-ul").click();
    await expect.poll(() => source(page)).toBe("  - a\n    - b\n  - c\n\nText");
    // Shift+Tab does not take an item out to the start of the line.
    await page.keyboard.press("Shift+Tab");
    await expect.poll(() => source(page)).toBe("  - a\n    - b\n  - c\n\nText");

    await page.keyboard.press("Control+End");
    await toolbarButton("fa-list-ol").click();
    await expect.poll(() => source(page)).toBe("  - a\n    - b\n  - c\n\n  # Text");
    // Without its indentation: indented text is a code block.
    await toolbarButton("fa-list-ol").click();
    await expect.poll(() => source(page)).toBe("  - a\n    - b\n  - c\n\nText");

    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await toolbarButton("fa-list-ol").click();
    await page.keyboard.type("one");
    await expect.poll(() => source(page)).toBe("  - a\n    - b\n  - c\n\nText\n\n  # one");
    await toolbarButton("fa-bold").click();
    await expect.poll(() => source(page)).toBe("  - a\n    - b\n  - c\n\nText\n\n  # one**bold text**");
    await toolbarButton("fa-bold").click();
    await expect.poll(() => source(page)).toBe("  - a\n    - b\n  - c\n\nText\n\n  # onebold text");
  });

  test("Shift+Up and Down select line by line, also into rendered blocks", async ({ page }) => {
    await startWith(page, "Intro\n\n  - one\n  - two\n  - three\n\nEnd");
    await page.locator(".rme-block", { hasText: "Intro" }).click();
    await page.keyboard.press("End");
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Shift+ArrowDown");
    }
    // Line by line (where in the next line depends on the rendered list markers).
    await expect.poll(() => selected(page)).toMatch(/^\n\n {2}- one\n?[ -]*$/);
    await page.keyboard.press("Shift+ArrowDown");
    await expect.poll(() => selected(page)).toMatch(/^\n\n {2}- one\n {2}- t?w?o?\n?[ -]*$/);

    await page.locator(".rme-block", { hasText: "End" }).click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+ArrowUp");
    await page.keyboard.press("Shift+ArrowUp");
    await expect.poll(() => selected(page)).toBe("  - three\n\n");
  });

  test("Ctrl+Shift+K on a reference opens its search near it, filled in, and changes it", async ({ page }) => {
    await startWith(page, "See T1 for the details of the calibration, which are many and long. ".repeat(4));
    await page.locator(".rme-block").first().click();
    await page.keyboard.press("Control+Home");
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("ArrowRight");
    }
    const picker = page.locator(".rme-picker");
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("Control+Shift+k");
      await expect(picker.locator("input")).toHaveValue("T1");
      await expect(picker.locator(".jx-result").first()).toContainText("T1: Calibrate the detector");
      const at = await textBox(page, "See");
      const box = (await picker.boundingBox())!;
      expect(box.y).toBeGreaterThan(at.y);
      expect(box.y).toBeLessThan(at.y + 40);
      expect(Math.abs(box.x - at.left)).toBeLessThan(60);
      await page.keyboard.press("Escape");
      await expect(picker).toHaveCount(0);
    }
    await page.keyboard.press("Control+Shift+k");
    await picker.locator("input").fill("T2");
    await expect(picker.locator(".jx-result").first()).toContainText("T2");
    await page.keyboard.press("Enter");
    await expect.poll(() => source(page)).toMatch(/^See T2 for the details/);
  });
});

test.describe("fifth test round", () => {
  const LIST = [
    "Intro",
    "",
    "  - one item",
    "  - two item",
    "    - nested item",
    "    - nested two",
    "  - [X] three item",
    "  - four with T1",
    "",
    "Middle",
    "",
    "  3. first",
    "  4. second",
    "    # sub a",
    "  5. third",
    "",
    "After",
  ];
  const TEXTS = [
    "one item",
    "two item",
    "nested item",
    "nested two",
    "three item",
    "four with",
    "Middle",
    "first",
    "second",
    "sub a",
    "third",
    "After",
  ];

  test("in a list, only the item with the cursor shows its source; the others stay where they are", async ({
    page,
  }) => {
    await startWith(page, LIST.join("\n"));
    const positions = async () => Promise.all(TEXTS.map((text) => textBox(page, text)));
    const rendered = await positions();
    for (const [line, items] of [
      [3, 6],
      [5, 6],
      [7, 6],
      [8, 6],
      [14, 4],
      [13, 4],
    ]) {
      await page.locator(".rme-block", { hasText: "Intro" }).click();
      await page.keyboard.press("Control+Home");
      for (let i = 1; i < line; i++) {
        await page.keyboard.press("ArrowDown");
      }
      const source = LIST[line - 1];
      // The other items of the list show rendered, each on its own.
      await expect(page.locator(".rme-list-item")).toHaveCount(items - 1);
      // Its text, after its marker, which shows rendered.
      const text = source.replace(/^\s*(?:[-*#]+|\d+[.)])\s+(?:\[.\]\s+)?/, "");
      await expect(page.locator(".cm-line.rme-src-list")).toHaveText(new RegExp(`${text}$`));
      const now = await positions();
      now.forEach((box, i) => {
        expect(Math.abs(box.y - rendered[i].y), `${TEXTS[i]} with line ${line} edited`).toBeLessThan(1.5);
        expect(Math.abs(box.left - rendered[i].left), `${TEXTS[i]} with line ${line} edited`).toBeLessThan(2);
      });
    }
    // Numbered like in the whole list: from 3, the nested list with letters.
    await expect(page.locator(".rme-list-item li:not(.rme-list-around)", { hasText: "first" })).toHaveJSProperty(
      "value",
      3,
    );
    await expect(page.locator(".rme-list-item li:not(.rme-list-around)", { hasText: "sub a" })).toHaveCSS(
      "list-style-type",
      "upper-alpha",
    );
  });

  test("the rendered items of a list being edited stay rendered while typing, and their boxes can be checked", async ({
    page,
  }) => {
    await startWith(page, LIST.join("\n"));
    await page.locator(".rme-block", { hasText: "Intro" }).click();
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("End");
    await expect(page.locator(".rme-list-item")).toHaveCount(5);
    await page.keyboard.type(" and more");
    await page.keyboard.press("Enter");
    await page.keyboard.type("new");
    await expect(page.locator(".rme-list-item")).toHaveCount(6);
    await expect.poll(() => source(page)).toContain("  - one item and more\n  - new\n  - two item");

    const item = page.locator(".rme-list-item li", { hasText: "three item" });
    const box = (await item.boundingBox())!;
    await page.mouse.click(box.x + 8, box.y + 10);
    await expect.poll(() => source(page)).toContain("  - [ ] three item");
    await expect(page.locator(".cm-line.rme-src-list", { hasText: "new" }).locator(".rme-item-marker")).toHaveText("•");
  });

  test("Home goes to the text of a list item first, then to the start of the line", async ({ page }) => {
    await startWith(page, "  - [ ] the item");
    await page.locator(".rme-block").click();
    await page.keyboard.press("End");
    const caret = () => textarea(page).evaluate((t: HTMLTextAreaElement) => t.selectionStart);
    await page.keyboard.press("Home");
    await expect.poll(caret).toBe(8);
    await page.keyboard.press("Home");
    await expect.poll(caret).toBe(0);
    await page.keyboard.press("Home");
    await expect.poll(caret).toBe(8);
    await page.keyboard.press("Shift+End");
    await expect.poll(() => selected(page)).toBe("the item");
  });
});

test.describe("references while editing", () => {
  const TEXT = "See T1, ask @alice, and {T1} but not `T1` or [[ /T1 | the task ]].";

  test("references in the line being edited show rendered, unless the cursor is on them", async ({ page }) => {
    await startWith(page, TEXT);
    await page.locator(".rme-block").click();
    await page.keyboard.press("End");
    const refs = page.locator(".rme-editor .cm-line .rme-inline-ref");
    await expect(refs).toHaveText(["T1", "@alice", "T1: Calibrate the detector", "the task"]);
    await expect(refs.first().locator("a")).toHaveAttribute("href", "/T1");
    // Monospaced text is no reference.
    await expect(page.locator(".cm-line tt.remarkup-monospaced")).toHaveText("T1");

    // The cursor on a reference shows its source, for editing it like any text.
    await page.keyboard.press("Home");
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("ArrowRight");
    }
    await expect(refs).toHaveText(["@alice", "T1: Calibrate the detector", "the task"]);
    await page.keyboard.press("Backspace");
    await page.keyboard.type("2");
    await expect.poll(() => source(page)).toBe(TEXT.replace("See T1", "See T2"));
    await page.keyboard.press("End");
    await expect(refs).toHaveText(["T2", "@alice", "T1: Calibrate the detector", "the task"]);
  });

  test("a click on a rendered reference puts the cursor at its end, showing its source", async ({ page }) => {
    await startWith(page, TEXT);
    await page.locator(".rme-block").click();
    await page.keyboard.press("End");
    await page.locator(".rme-inline-ref", { hasText: "@alice" }).click();
    await expect(page.locator(".rme-inline-ref")).toHaveText(["T1", "T1: Calibrate the detector", "the task"]);
    await page.keyboard.type("x");
    await expect.poll(() => source(page)).toBe(TEXT.replace("@alice", "@alicex"));
  });
});

test.describe("sixth test round", () => {
  test("Up and Down land in the text of list items, not before their markers", async ({ page }) => {
    const text = "Intro\n\n  - one\n  - [ ] two";
    await startWith(page, text);
    await page.locator(".rme-block", { hasText: "Intro" }).click();
    await page.keyboard.press("Home");
    const caret = () => textarea(page).evaluate((t: HTMLTextAreaElement) => t.selectionStart);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect.poll(caret).toBe(text.indexOf("one"));
    await page.keyboard.press("Home");
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowDown");
    await expect.poll(caret).toBe(text.indexOf("two"));
  });

  test("images of this Phorge pasted from its pages are referenced, not uploaded again", async ({ page }) => {
    await page.goto("/w/demo/");
    const embed = await page
      .locator(".phabricator-remarkup .phabricator-remarkup-embed-image")
      .first()
      .evaluate((a) => a.parentElement!.outerHTML);
    const full = embed
      .replace("phabricator-remarkup-embed-image", "phabricator-remarkup-embed-image-full")
      .replace("phabricator-remarkup-embed-layout-left", "phabricator-remarkup-embed-layout-center");
    await openNewWikiPage(page, "Copied images");
    const uploads: string[] = [];
    page.on("request", (request) => request.url().includes("/file/dropupload/") && uploads.push(request.url()));
    await editor(page).click();
    await paste(page, { html: `<p>Copied:</p>${embed}${full}` });
    await expect.poll(() => source(page)).toBe("Copied:\n\n{F1}\n\n{F1, size=full, layout=center}");
    expect(uploads).toEqual([]);
  });

  test("an existing file pasted by its address is referenced, not attached, which would widen who sees it", async ({
    page,
  }) => {
    await page.goto("/w/demo/");
    const file = await conduit(page, "file.search", { constraints: { ids: [1] } });
    const phid: string = file.data[0].phid;
    await openNewWikiPage(page, "Pasted file address");
    await editor(page).click();
    // E.g. an image copied from a page whose link leads to the file's data, without its monogram.
    await paste(page, {
      html: `<p>Copied:</p><a href="/file/data/key/${phid}/demo.png"><img src="/res/x.png" alt=""></a>`,
    });
    await expect.poll(() => source(page)).toBe("Copied:\n\n{F1}");
    const metadata = await page.locator('input[name="content_metadata"]').inputValue();
    expect(JSON.parse(metadata || "{}").attachedFilePHIDs ?? []).toEqual([]);
  });

  test("in a dialog, the editor scrolls like the textarea instead of growing the dialog", async ({ page }) => {
    await createTask(page, "Dialog height");
    await addPhlair(page);
    await editor(page).click();
    const reloaded = page.waitForEvent("load");
    await page.keyboard.type("A comment.");
    await page.keyboard.press("Control+Enter");
    await reloaded;
    await addPhlair(page);
    await page.locator(".phui-timeline-shell", { hasText: "A comment." }).locator(".phui-timeline-menu").click();
    await page.getByRole("link", { name: "Edit Comment" }).click();
    const dialog = page.locator(".jx-client-dialog .aphront-dialog-view");
    await dialog.locator(".rme-editor .cm-content").click();
    const height = (await dialog.boundingBox())!.height;
    await page.keyboard.press("Control+End");
    await page.keyboard.insertText("\n\nMore.".repeat(30));
    await expect(dialog.locator("textarea.remarkup-assist-textarea")).toHaveValue(/(More\.\n\n){29}More\.$/);
    expect(Math.abs((await dialog.boundingBox())!.height - height)).toBeLessThan(2);
    const scroller = dialog.locator(".cm-scroller");
    expect(await scroller.evaluate((el) => el.scrollHeight > el.clientHeight + 100)).toBe(true);
  });
});

test.describe("seventh test round", () => {
  const TEXT = "First paragraph here.\n\n| a | b |\n| c | d |\n\nMiddle paragraph here.\n\nLast paragraph.";

  test("dragging over rendered text selects it whole, as it shows, from rendered text or from the source", async ({
    page,
  }) => {
    await startWith(page, TEXT);
    const selectedBlocks = () =>
      page
        .locator(".rme-block.rme-selected")
        .evaluateAll((blocks) => blocks.map((b) => b.textContent!.trim().slice(0, 5)));
    // From a rendered paragraph down into the middle of the table.
    const first = (await textBox(page, "First"))!;
    const cell = (await page.locator(".rme-table-editor td", { hasText: "c" }).boundingBox())!;
    await page.mouse.move(first.left + 20, first.y);
    await page.mouse.down();
    await page.mouse.move(cell.x + 5, cell.y + 5, { steps: 6 });
    await expect.poll(selectedBlocks).toEqual(["First", "abcd"]);
    const shown = await selected(page);
    await page.mouse.up();
    expect(shown).toBe("First paragraph here.\n\n| a | b |\n| c | d |");
    await expect.poll(() => selected(page)).toBe(shown);

    // From the source of a paragraph being edited up into the table.
    await page.locator(".rme-block", { hasText: "Middle" }).click();
    const middle = (await page.locator(".cm-line", { hasText: "Middle" }).boundingBox())!;
    const table = (await page.locator(".rme-table-editor td", { hasText: "b" }).boundingBox())!;
    await page.mouse.move(middle.x + 60, middle.y + middle.height / 2);
    await page.mouse.down();
    await page.mouse.move(table.x + 5, table.y + 5, { steps: 6 });
    await expect.poll(selectedBlocks).toEqual(["abcd"]);
    const fromSource = await selected(page);
    await page.mouse.up();
    expect(fromSource).toMatch(/^\| a \| b \|\n\| c \| d \|\n\nMiddl?e?/);
    await expect.poll(() => selected(page)).toBe(fromSource);
  });

  test("more blank lines than one between blocks are lines like any other", async ({ page }) => {
    await startWith(page, "Above\n\nBelow");
    const below = async () => (await textBox(page, "Below")).y;
    const before = await below();
    await page.locator(".rme-block", { hasText: "Above" }).click();
    const line = (await page.locator(".cm-line", { hasText: "Above" }).boundingBox())!.height;
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    // Three lines more than before, each as high as a line of text.
    await expect.poll(async () => Math.round((await below()) - before - 3 * line)).toBe(0);
  });
});

test.describe("everything renders until the cursor is on it", () => {
  const line = (page: Page, text: string) => page.locator(".cm-line", { hasText: text });

  test("formatting hides its markers, except where the cursor is", async ({ page }) => {
    await startWith(page, "Some **bold** and //it// and `code` with #demo_project");
    await page.locator(".rme-block").click();
    await page.keyboard.press("Home");
    await expect(line(page, "Some")).toHaveText("Some bold and it and code with Demo Project");
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("ArrowRight");
    }
    await expect(line(page, "Some")).toHaveText("Some **bold** and it and code with Demo Project");
    await page.keyboard.press("End");
    await expect(line(page, "Some")).toHaveText("Some bold and it and code with #demo_project");
    // A selection shows the source of what it touches.
    await page.keyboard.press("Shift+Home");
    await expect(line(page, "Some")).toHaveText("Some **bold** and //it// and `code` with #demo_project");
  });

  test("headers and quotes hide their markers until the cursor is in or before them", async ({ page }) => {
    await startWith(page, "== Title ==\n\n> Quoted");
    await page.locator(".rme-block h3").click();
    await page.keyboard.press("End");
    await expect(page.locator(".cm-line.rme-src-h")).toHaveText("Title ==");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".cm-line.rme-src-h")).toHaveText("Title");
    // Home goes to the start of the text first, then before the marker.
    await page.keyboard.press("Home");
    await expect(page.locator(".cm-line.rme-src-h")).toHaveText("Title");
    await page.keyboard.press("Home");
    await expect(page.locator(".cm-line.rme-src-h")).toHaveText("== Title");

    await page.locator(".rme-block blockquote").click();
    await page.keyboard.press("End");
    await expect(page.locator(".cm-line.rme-src-quote")).toHaveText("Quoted");
    await page.keyboard.press("Home");
    await page.keyboard.press("Home");
    await expect(page.locator(".cm-line.rme-src-quote")).toHaveText("> Quoted");
  });
});

test.describe("the cursor", () => {
  test("shows where typing puts the text: in an empty field, after text and rendered references", async ({ page }) => {
    await openNewWikiPage(page, "Cursor");
    const field = (await page.locator(".rme-editor").boundingBox())!;
    await page.mouse.click(field.x + field.width / 2, field.y + field.height / 2);
    const cursor = page.locator(".cm-cursor-primary");
    const at = async () => (await cursor.boundingBox())!;
    const placeholder = (await page.locator(".cm-placeholder").boundingBox())!;
    expect(Math.abs((await at()).x - placeholder.x)).toBeLessThan(2);
    expect((await at()).y).toBeGreaterThanOrEqual(placeholder.y - 1);
    expect((await at()).y + (await at()).height).toBeLessThanOrEqual(placeholder.y + placeholder.height + 1);
    // The browser's own caret does not show besides it.
    await expect(page.locator(".cm-content")).toHaveCSS("caret-color", "rgba(0, 0, 0, 0)");

    await page.keyboard.type("See T1");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    // Before the reference, which shows rendered: right after "See".
    await expect(page.locator(".rme-inline-ref")).toHaveText("T1");
    const see = await textBox(page, "See");
    await expect.poll(async () => Math.round((await at()).x - see.right)).toBeLessThan(2);

    // In a table cell, the cell has the caret.
    await page.keyboard.press("End");
    await page.keyboard.insertText("\n\n| a | b |\n| 1 | 2 |");
    await blur(page);
    await page.locator(".rme-table-editor td", { hasText: "1" }).click();
    await expect(cursor).toBeHidden();
    await expect(page.locator(".rme-table-editor td:focus")).not.toHaveCSS("caret-color", "rgba(0, 0, 0, 0)");
  });
});
