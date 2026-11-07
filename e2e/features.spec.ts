// Regression tests of fixed bugs and tests of the editing aids: shortcuts,
// insert menu, pickers, pasting, checklists, themes and narrow windows.

import { readFileSync, writeFileSync } from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";
import {
  addPhlair,
  conduit,
  createRevision,
  createTask,
  editor,
  imageSite,
  openNewWikiPage,
  openWithEditor,
  PNG_BYTES,
  settled,
  textarea,
} from "./helpers";
import { FILES_URL } from "./env";

const blur = (page: Page) => page.evaluate(() => (document.activeElement as HTMLElement).blur());
const source = (page: Page) => textarea(page).inputValue();
const selected = (page: Page) =>
  textarea(page).evaluate((t: HTMLTextAreaElement) => t.value.slice(t.selectionStart, t.selectionEnd));

/** Starts a new wiki page with a text, without the focus, with all that the server renders. */
async function startWith(page: Page, text: string): Promise<void> {
  await openNewWikiPage(page, "Features");
  await editor(page).click();
  await page.keyboard.insertText(text);
  await blur(page);
  await settled(page);
}

/** Where the bullet or number of a list item starts on the screen: drawn outside its item, as wide as inside it. */
function markerLeft(page: Page, item: string) {
  return page.locator(".cm-line", { hasText: item }).evaluate((line) => {
    const own = line.querySelector<HTMLElement>(".rme-item-marker li:not(.rme-list-around)")!;
    const range = document.createRange();
    range.selectNodeContents(own.firstChild!);
    const outside = range.getBoundingClientRect().left;
    own.style.listStylePosition = "inside";
    const inside = range.getBoundingClientRect().left;
    own.style.listStylePosition = "";
    return outside - (inside - outside);
  });
}

/** The rendered text highlighted as selected while the mouse selects, by block. */
const highlighted = (page: Page) =>
  page.evaluate(() => [...(CSS.highlights.get("rme-selection") ?? [])].map((range) => range.toString().trim()));

/** The screen box of a text in a rendered block (of its nth occurrence). */
function textBox(page: Page, text: string, nth = 0) {
  return page.evaluate(
    ([text, nth]) => {
      const walker = document.createTreeWalker(document.querySelector(".rme-editor")!, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const index = node.textContent!.indexOf(text);
        if (index >= 0 && nth-- === 0) {
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + text.length);
          const { left, right, top, bottom } = range.getBoundingClientRect();
          return { left, right, y: (top + bottom) / 2 };
        }
      }
      throw new Error(`${text} not found`);
    },
    [text, nth] as const,
  );
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
  test("blocks are what they are in the whole text, also the last one", async ({ page }) => {
    // "## Section" followed by text is a header, "# item" at the end a list.
    await startWith(page, "## Section\n\nText.\n\n# item");
    const preview = page.locator(".phui-remarkup-preview .phui-preview-body");
    await expect(preview).toContainText("item");
    await expect(preview.locator(".remarkup-header")).toHaveText("Section");
    await expect(preview.locator("ol li")).toHaveText("item");
    await expect(page.locator(".cm-line.rme-src-h")).toHaveText("Section");
    await expect(page.locator(".cm-line.rme-src-list")).toHaveText(/^\u200bitem$/);
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

  test("a click in rendered text puts the cursor at the clicked text; a drag from there selects", async ({ page }) => {
    await startWith(page, "Intro.\n\n```\nalpha beta gamma\n```\n\nThe end.");
    const beta = await textBox(page, "beta");
    await page.mouse.click(beta.left + 1, beta.y);
    await page.keyboard.type("X");
    await expect.poll(() => source(page)).toBe("Intro.\n\n```\nalpha Xbeta gamma\n```\n\nThe end.");
    await blur(page);
    await settled(page);
    const gamma = await textBox(page, "gamma");
    const end = await textBox(page, "end.");
    await page.mouse.move(gamma.left + 1, gamma.y);
    await page.mouse.down();
    await page.mouse.move(end.left + 1, end.y, { steps: 5 });
    await page.mouse.up();
    expect(await selected(page)).toBe("gamma\n```\n\nThe ");
  });

  test("the mouse selects rendered text exactly, as the selection shows while selecting", async ({ page }) => {
    await startWith(page, "First paragraph here.\n\n```\nsome code here\n```\n\nThird.");
    const from = await textBox(page, "paragraph here.");
    const code = await textBox(page, "code here");
    await page.mouse.move(from.left + 1, from.y);
    await page.mouse.down();
    await page.mouse.move(code.left + 1, code.y, { steps: 5 });
    // The code block keeps showing rendered while the mouse selects.
    await expect(page.locator(".rme-block-code")).toHaveCount(1);
    // Only its selected text shows selected, not all of it, also not by the browser's selection.
    await expect.poll(() => highlighted(page)).toEqual(["some"]);
    await expect(page.locator(".cm-editor")).toHaveClass(/rme-mouse-selecting/);
    await page.mouse.up();
    expect(await selected(page)).toBe("paragraph here.\n\n```\nsome ");
    await expect.poll(() => highlighted(page)).toEqual([]);
    await expect(page.locator(".cm-editor")).not.toHaveClass(/rme-mouse-selecting/);
    // Bold acts on that selection.
    await page.keyboard.press("Control+b");
    await expect.poll(() => source(page)).toBe("First **paragraph here.\n\n```\nsome **code here\n```\n\nThird.");
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
    // The text shows all the same, formatted.
    await expect(page.locator(".cm-line .rme-bold")).toHaveText("text");
    fail = false;
    await status.getByRole("link", { name: "Retry" }).click();
    // Right away, not with the automatic retry 2 s after the failure.
    await expect(status).toBeHidden({ timeout: 1000 });
  });

  test("Tab in a paragraph does not jump into a table", async ({ page }) => {
    await startWith(page, "Text.\n\n| a | b |\n| 1 | 2 |");
    await page.locator(".cm-line", { hasText: "Text." }).click();
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
    await page.locator(".rme-image-preview img").click({ button: "right" });
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
    // The checkbox comes to the item, which stays numbered.
    await page.keyboard.press("Control+Shift+9");
    await expect.poll(() => source(page)).toBe("make it **//bold//**\n\n  # [ ] item");

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

  test("checklist boxes can be checked with a click, also without the focus", async ({ page }) => {
    await startWith(page, "- [ ] open\n- [X] done");
    const box = (text: string) => page.locator(".cm-line.rme-src-list", { hasText: text }).locator(".rme-item-check");
    await box("open").click();
    await expect.poll(() => source(page)).toBe("- [X] open\n- [X] done");
    await expect(box("open").locator("li")).toHaveClass(/remarkup-checked-item/);
    await box("done").click();
    await expect.poll(() => source(page)).toBe("- [X] open\n- [ ] done");
    await expect(box("done").locator("li")).toHaveClass(/remarkup-unchecked-item/);
    // The boxes stay boxes: the clicks did not show the source.
    await expect(page.locator(".cm-line.rme-src-list", { hasText: "open" })).toHaveText(/^ open$/);
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
    await picker.locator(".rme-picker-search").fill("Remarkup");
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
    await picker.locator(".rme-picker-search").fill("https://example.com/");
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
    await picker.locator(".rme-picker-search").fill("calib");
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
    await expect(page.locator(".rme-editor a", { hasText: "a site" })).toHaveAttribute("href", "https://example.com");
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

  test("Ctrl+click opens a link", async ({ page, context }) => {
    await startWith(page, "Go to [[ https://example.com/ | the site ]].");
    const opened = context.waitForEvent("page");
    await page.locator(".rme-editor a", { hasText: "the site" }).click({ modifiers: ["Control"] });
    expect((await opened).url()).toBe("https://example.com/");
    // Still rendered: Ctrl+click does not edit.
    await expect(page.locator(".cm-line")).toHaveText("Go to the site.");
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
    const image = page.locator(".rme-editor img.phabricator-remarkup-macro");
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

  test("Escape right after Ctrl+K: the editor still counts as focused, the block at the cursor shows its source", async ({
    page,
  }) => {
    // Found on CI: closed before CodeMirror noticed the focus leaving, the
    // editor counted as unfocused with the focus back in it.
    await openNewWikiPage(page, "Picker closed at once");
    await editor(page).click();
    await page.keyboard.insertText("| a | b |\n| 1 | 2 |\n\nText");
    // Both keys in one task, so CodeMirror's check 10 ms after the blur can not come between.
    await page.evaluate(() => {
      const press = (key: string, ctrlKey = false) =>
        document.activeElement!.dispatchEvent(
          new KeyboardEvent("keydown", { key, ctrlKey, bubbles: true, cancelable: true }),
        );
      press("k", true);
      if (!document.activeElement?.closest(".rme-picker")) {
        throw new Error("Ctrl+K opened no picker");
      }
      press("Escape");
    });
    await page.keyboard.press("Control+Home");
    await expect(page.locator(".rme-table-bar")).toBeVisible();
  });

  test("the link button and shortcuts open the search without scrolling", async ({ page }) => {
    await openNewWikiPage(page, "Link button");
    await editor(page).click();
    // A long page, edited at the top.
    await page.keyboard.insertText("\n\n" + Array.from({ length: 80 }, (_, i) => `Paragraph ${i}.`).join("\n\n"));
    await page.keyboard.press("Control+Home");
    await page.keyboard.type("See ");
    const scroll = () => page.evaluate(() => window.scrollY);
    const before = await scroll();
    await page.locator(".remarkup-assist-button:has(.fa-link)").click();
    const picker = page.locator(".rme-picker");
    await expect(picker.locator(".rme-picker-search")).toBeFocused();
    await page.waitForTimeout(300);
    await expect(picker).toBeVisible();
    expect(await scroll()).toBe(before);
    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
    // Ctrl+Shift+K, the key of the former reference command, does the same.
    for (const key of ["Control+k", "Control+Shift+k"]) {
      await page.keyboard.press(key);
      await expect(picker.locator(".rme-picker-search")).toBeFocused();
      expect(await scroll()).toBe(before);
      await page.keyboard.press("Escape");
    }
    // One button for links and references.
    await expect(page.locator(".remarkup-assist-bar .fa-anchor")).toHaveCount(0);
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

test("a click between a heading and the line below it, nearer that line, types on that line", async ({ page }) => {
  await startWith(page, "= Title\nText line.\n\nMore.");
  const between = async () => {
    const heading = (await page.locator(".cm-line.rme-src-h").boundingBox())!;
    const text = (await page.locator(".cm-line", { hasText: "Text line." }).boundingBox())!;
    // At the left edge, so at the start of the line.
    await page.mouse.click(heading.x + 1, text.y - 2);
  };
  await between();
  await page.keyboard.type("abc ");
  await expect.poll(() => source(page)).toBe("= Title\nabc Text line.\n\nMore.");
  // Again, with the line below now being edited.
  await between();
  await page.keyboard.type("x");
  await expect.poll(() => source(page)).toBe("= Title\nxabc Text line.\n\nMore.");
});

test("blocks on consecutive lines are as far apart as in Phorge's preview, a blank line is a line", async ({
  page,
}) => {
  const text = ["= Sprint Review\n== Changelog\nText right below.", "---\n---", "Last."].join("\n\n");
  await startWith(page, text);
  await page.addStyleTag({ content: ".phui-remarkup-preview { display: block !important; }" });
  const preview = page.locator(".phui-remarkup-preview .phui-preview-body .phabricator-remarkup");
  await expect(preview).toContainText("Last.");
  // Gaps between the blocks: in the editor between the lines that are not
  // blank (a rule's "---" hides), in the preview between its elements.
  const gaps = (selector: string) =>
    page.locator(selector).evaluateAll((elements) => {
      const blocks = elements.filter(
        (el) => !el.classList.contains("cm-line") || el.textContent!.trim() || el.classList.contains("rme-src-rule"),
      );
      return blocks
        .slice(1)
        .map((b, i) => Math.round(b.getBoundingClientRect().top - blocks[i].getBoundingClientRect().bottom));
    });
  const lines = ".rme-editor .cm-content > .cm-line";
  const inPreview = await gaps(".phui-remarkup-preview .phui-preview-body .phabricator-remarkup > *");
  const line = await editor(page).evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
  // Heading, heading, paragraph, rule, rule, paragraph: blank lines after the paragraph and the second rule.
  const expected = inPreview.map((gap, i) => (i === 2 || i === 4 ? Math.round(line) : gap));
  // Within a pixel: positions are rounded.
  await expect
    .poll(async () => (await gaps(lines)).map((gap, i) => Math.abs(gap - expected[i]) <= 1))
    .toEqual(expected.map(() => true));
  // Entering a block, or the blank line, keeps the gaps and the text below in place.
  const before = await gaps(lines);
  const last = () => page.locator(".cm-line", { hasText: "Last." }).evaluate((el) => el.getBoundingClientRect().top);
  const top = await last();
  await page.locator(".cm-line.rme-src-h2", { hasText: "Changelog" }).click();
  expect(await last()).toBeCloseTo(top, 0);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect
    .poll(() => textarea(page).evaluate((t: HTMLTextAreaElement) => t.selectionStart))
    .toBe(text.indexOf("\n\n---") + 1);
  expect(await last()).toBeCloseTo(top, 0);
  await blur(page);
  await expect.poll(() => gaps(lines)).toEqual(before);
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

  test("show the essential toolbar buttons, the others in ⋯, without scrolling sideways", async ({ page }) => {
    await openNewWikiPage(page, "Phone");
    await editor(page).click();
    // Phorge hides these on phones.
    for (const icon of ["fa-bold", "fa-italic", "fa-link"]) {
      await expect(page.locator(`.remarkup-assist-bar .remarkup-assist-button:has(.${icon})`)).toBeVisible();
    }
    for (const icon of ["fa-table", "fa-header"]) {
      await expect(page.locator(`.remarkup-assist-bar .remarkup-assist-button:has(.${icon})`)).toBeHidden();
    }
    await page.locator(".remarkup-assist-bar .rme-more").click();
    await expect(page.locator(".rme-more-menu").getByRole("menuitem", { name: /Table/ })).toBeAttached();
    await page.keyboard.press("Escape");
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
    await page.locator(".rme-image-preview img").evaluate((img) => {
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
    await page.evaluate((files) => {
      type Request = { url: string; responseType: "text" | "data-url" };
      const reader = (
        window as unknown as {
          DarkReader: {
            setFetchMethod(f: typeof fetch): void;
            enable(theme: object): void;
            Plugins?: { fetch(request: Request): Promise<string> };
          };
        }
      ).DarkReader;
      reader.setFetchMethod(window.fetch);
      // The extension fetches the stylesheets of the file domain itself (this
      // copy skips them over http with a port); the page may only fetch from
      // its own domain, which has them too.
      reader.Plugins = {
        async fetch({ url, responseType }) {
          const response = await window.fetch(url.replace(files, location.origin));
          if (responseType === "text") {
            return response.text();
          }
          const blob = await response.blob();
          return new Promise((resolve) => {
            const file = new FileReader();
            file.onload = () => resolve(file.result as string);
            file.readAsDataURL(blob);
          });
        },
      };
      reader.enable({ brightness: 100, contrast: 90, sepia: 10 });
    }, FILES_URL);
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
    await expect(page.locator(".cm-line .rme-bold")).toHaveText("one");

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
  test("the insert menu: Enter right after / inserts the focused item, link and table items keep their focus", async ({
    page,
  }) => {
    await openNewWikiPage(page, "Slash");
    await editor(page).click();
    await page.keyboard.type("/");
    const first = await page.locator(".rme-autocomplete .jx-result.focused").textContent();
    expect(first).toMatch(/^Heading/);
    await page.keyboard.press("Enter");
    await expect(page.locator(".rme-autocomplete")).toHaveCount(0);
    await expect.poll(() => source(page)).toMatch(/^=+ /);
    // Escape closes the menu and keeps the "/".
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Delete");
    await page.keyboard.type("/");
    await page.keyboard.press("Escape");
    await page.keyboard.press("Enter");
    await page.keyboard.type("next");
    await expect.poll(() => source(page)).toBe("/\nnext");

    await page.keyboard.type("\n\n/link");
    await page.keyboard.press("Enter");
    await expect(page.locator(".rme-picker .rme-picker-search")).toBeFocused();
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

  test("the insert menu hides while nothing matches and comes back when Backspace fixes the typo", async ({ page }) => {
    await openNewWikiPage(page, "Slash typo");
    await editor(page).click();
    const menu = page.locator(".rme-autocomplete");
    await page.keyboard.type("/tabx");
    await expect(menu).toHaveCount(0);
    await page.keyboard.press("Backspace");
    await expect(menu.locator(".jx-result.focused")).toContainText("Table");
    // Down to no match again and back.
    await page.keyboard.type("yz");
    await expect(menu).toHaveCount(0);
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await expect(menu).toHaveCount(1);
    // Backspace to the "/" keeps it, deleting the "/" closes it.
    for (let i = 0; i < 3; i++) await page.keyboard.press("Backspace");
    await expect(menu.locator(".jx-result.focused")).toContainText("Heading");
    await page.keyboard.press("Backspace");
    await expect(menu).toHaveCount(0);
    await expect.poll(() => source(page)).toBe("");
    // A space ends it: Backspace does not bring it back.
    await page.keyboard.type("/tabx ");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await expect(menu).toHaveCount(0);
    // While hidden, Enter is a line break, not an insert.
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Delete");
    await page.keyboard.type("/tabx");
    await page.keyboard.press("Enter");
    await expect.poll(() => source(page)).toBe("/tabx\n");
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
    const input = page.locator(".rme-picker .rme-picker-search");
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
    await page.locator(".rme-picker .rme-picker-search").fill("T1");
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
      .locator(".cm-line.rme-src-list")
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
    // The second of the items with "link": the anchor.
    await page.keyboard.type("link");
    await expect(page.locator(".rme-autocomplete .jx-result")).toHaveText([/^Link/, /^Anchor/]);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect.poll(() => source(page)).toBe("{anchor #name}");
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
    // The link's text and target, to change.
    await expect(picker.locator(".rme-picker-text")).toHaveValue("site");
    await expect(picker.locator(".rme-picker-search")).toHaveValue("https://example.com");
    await picker.locator(".rme-picker-search").fill("https://example.org/");
    await expect(picker.locator(".jx-result.focused")).toContainText("Link to https://example.org/");
    await page.keyboard.press("Enter");
    await expect.poll(() => source(page)).toBe("See [[ https://example.org/ | site ]]");
    // The cursor right after a link: the link button changes it too.
    await page.keyboard.press("End");
    await page.locator(".remarkup-assist-button:has(.fa-link)").click();
    await expect(picker.locator(".rme-picker-search")).toHaveValue("https://example.org/");
  });

  test("links in table cells have their bubble and the link command", async ({ page }) => {
    await startWith(page, "| Element | Source |\n| Fe | [[ https://example.com | site ]] |");
    await page.locator(".rme-table-editor td", { hasText: "site" }).click();
    await page.keyboard.press("Home");
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("ArrowRight");
    }
    const bubble = page.locator(".rme-table-editor .rme-link-bubble");
    await expect(bubble.getByRole("link", { name: "Open" })).toBeVisible();
    await bubble.getByRole("link", { name: "Remove link" }).click();
    await expect.poll(() => source(page)).toBe("| Element | Source |\n| Fe | site |");

    await page.locator(".rme-table-editor td", { hasText: "Fe" }).click();
    await page.keyboard.press("Control+a");
    await page.keyboard.press("Control+k");
    await page.locator(".rme-picker .rme-picker-search").fill("https://example.com/fe");
    await expect(page.locator(".rme-picker .jx-result.focused")).toContainText("Link to");
    await page.keyboard.press("Enter");
    await expect.poll(() => source(page)).toBe("| Element | Source |\n| [[ https://example.com/fe | Fe ]] | site |");
  });

  test("a click on the blank line between a paragraph and a heading opens it for typing", async ({ page }) => {
    await startWith(page, "Some text.\n\n= Heading");
    const text = (await page.locator(".cm-line", { hasText: "Some text." }).boundingBox())!;
    const heading = (await page.locator(".cm-line.rme-src-h").boundingBox())!;
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
      page.locator(".cm-line", { hasText: "Next paragraph." }).evaluate((e) => e.getBoundingClientRect().top);
    const before = await next();
    const paragraph = (await page.locator(".cm-line").first().boundingBox())!;
    await page.mouse.click(paragraph.x + paragraph.width - 20, paragraph.y + 10);
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

  test("a block starting with an image shows it above its text, also while edited", async ({ page }) => {
    await startWith(page, "{F1}\nBelow the image.");
    const image = () =>
      page
        .locator(".rme-image-preview img")
        .first()
        .evaluate((img) => img.getBoundingClientRect().top);
    const before = await image();
    await page.locator(".cm-line", { hasText: "Below the image." }).click({ position: { x: 300, y: 5 } });
    // Its reference shows on its line when the cursor is there.
    await page.keyboard.press("ArrowUp");
    const line = page.locator(".cm-line", { hasText: "{F1}" });
    await expect(line).toBeVisible();
    expect(await line.evaluate((l) => l.getBoundingClientRect().top)).toBeGreaterThan(
      await page.locator(".rme-image-preview img").evaluate((img) => img.getBoundingClientRect().bottom),
    );
    expect(Math.abs((await image()) - before)).toBeLessThan(2);
  });

  test("images in a quote show in the quote, by the paragraph that embeds them", async ({ page }) => {
    // Like a reply quoting a comment with a screenshot (T30643).
    await startWith(page, "> Quoted text.\n>\n> {F1}\n>\n> More text.\n\nAfter.");
    const top = (text: string) =>
      page.locator(".cm-line", { hasText: text }).evaluate((line) => line.getBoundingClientRect().top);
    const preview = page.locator(".rme-image-preview");
    await expect(preview).toHaveCount(1);
    await expect(preview).toHaveClass(/rme-preview-quote/);
    const box = (await preview.boundingBox())!;
    // Between the paragraphs of the quote, on its border.
    expect(box.y).toBeGreaterThan(await top("Quoted text."));
    expect(box.y + box.height).toBeLessThanOrEqual((await top("More text.")) + 1);
    const quoteLeft = await page
      .locator(".cm-line", { hasText: "Quoted text." })
      .evaluate((line) => line.getBoundingClientRect().left);
    expect(Math.abs(box.x - quoteLeft)).toBeLessThan(1);
    // Its reference hides while the image shows.
    await expect(page.locator(".cm-line", { hasText: "{F1}" })).toHaveCount(0);
  });

  test("the image menu changes the embed of the image in a quote", async ({ page }) => {
    await startWith(page, "> {F1}\n>\n> Between.\n>\n> {F1}");
    const images = page.locator(".rme-image-preview img");
    await expect(images).toHaveCount(2);
    await images.nth(1).click({ button: "right" });
    await page.locator(".rme-image-menu a", { hasText: "Full width" }).click();
    await expect.poll(() => source(page)).toBe("> {F1}\n>\n> Between.\n>\n> {F1, size=wide}");
  });

  test("an image that goes to a block of its own shows only there, not also in the block it left", async ({ page }) => {
    const images = page.locator(".rme-image-preview img");
    const below = async (text: string) =>
      (await images.boundingBox())!.y >= (await page.locator(".cm-line", { hasText: text }).boundingBox())!.y;
    // A blank line splits a paragraph.
    await startWith(page, "Paragraph\n{F1}");
    await expect(images).toHaveCount(1);
    await page.locator(".cm-line", { hasText: "Paragraph" }).click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await expect.poll(() => source(page)).toBe("Paragraph\n\n{F1}");
    await settled(page);
    await expect(images).toHaveCount(1);
    expect(await below("Paragraph")).toBe(true);

    // The image's line leaves a quote.
    await editor(page).press("Control+a");
    await page.keyboard.insertText("> Quoted\n>> {F1}");
    await expect(images).toHaveCount(1);
    await page.locator(".cm-line", { hasText: "Quoted" }).click();
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Home");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    await expect.poll(() => source(page)).toBe("> Quoted\n{F1}");
    await settled(page);
    await expect(images).toHaveCount(1);
    expect(await below("Quoted")).toBe(true);
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
    await page.locator(".cm-line.rme-src-list", { hasText: /^\u200bc$/ }).click();
    // "# a" at the start of a line would be a header: the whole list moves in.
    await toolbarButton("fa-list-ol").click();
    await expect.poll(() => source(page)).toBe("  # a\n    - b\n  # c\n\nText");
    // A checkbox for the item only.
    await toolbarButton("fa-check-square-o").click();
    await expect.poll(() => source(page)).toBe("  # a\n    - b\n  # [ ] c\n\nText");
    await toolbarButton("fa-list-ul").click();
    await expect.poll(() => source(page)).toBe("  - a\n    - b\n  - [ ] c\n\nText");
    // Shift+Tab does not take an item out to the start of the line.
    await page.keyboard.press("Shift+Tab");
    await expect.poll(() => source(page)).toBe("  - a\n    - b\n  - [ ] c\n\nText");

    await page.keyboard.press("Control+End");
    await toolbarButton("fa-list-ol").click();
    await expect.poll(() => source(page)).toBe("  - a\n    - b\n  - [ ] c\n\n  # Text");
    // Without its indentation: indented text is a code block.
    await toolbarButton("fa-list-ol").click();
    await expect.poll(() => source(page)).toBe("  - a\n    - b\n  - [ ] c\n\nText");

    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await toolbarButton("fa-list-ol").click();
    await page.keyboard.type("one");
    await expect.poll(() => source(page)).toBe("  - a\n    - b\n  - [ ] c\n\nText\n\n  # one");
    await toolbarButton("fa-bold").click();
    await expect.poll(() => source(page)).toBe("  - a\n    - b\n  - [ ] c\n\nText\n\n  # one**bold text**");
    await toolbarButton("fa-bold").click();
    await expect.poll(() => source(page)).toBe("  - a\n    - b\n  - [ ] c\n\nText\n\n  # onebold text");
  });

  test("the quote button quotes paragraphs as one quote, and unquotes them", async ({ page }) => {
    const text = "Intro\n\nHello Michael,\n\nYou can ignore this.\n\nBest regards\n\nEnd";
    await startWith(page, text);
    // From the blank line after "Intro" to the one before "End".
    await page.locator(".cm-line", { hasText: "Intro" }).click();
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowDown");
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Shift+ArrowDown");
    }
    const quoteButton = page.locator(".remarkup-assist-bar .remarkup-assist.fa-quote-right").first();
    await quoteButton.click();
    await expect
      .poll(() => source(page))
      .toBe("Intro\n\n> Hello Michael,\n>\n> You can ignore this.\n>\n> Best regards\n\nEnd");
    // The cursor is on the blank line after the quote.
    await quoteButton.click();
    await expect.poll(() => source(page)).toBe(text);
  });

  test("Shift+Up and Down select line by line, also into rendered blocks", async ({ page }) => {
    await startWith(page, "Intro\n\n  - one\n  - two\n  - three\n\nEnd");
    await page.locator(".cm-line", { hasText: "Intro" }).click();
    await page.keyboard.press("End");
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Shift+ArrowDown");
    }
    // Line by line, near the column of the end of "Intro" (in the text of the items, after their markers).
    await expect.poll(() => selected(page)).toMatch(/^\n\n {2}- one\n {2}- t?w?o?$/);
    await page.keyboard.press("Shift+ArrowDown");
    await expect.poll(() => selected(page)).toMatch(/^\n\n {2}- one\n {2}- two\n {2}- t?h?r?$/);

    await page.locator(".cm-line", { hasText: "End" }).click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Shift+ArrowUp");
    await page.keyboard.press("Shift+ArrowUp");
    await expect.poll(() => selected(page)).toBe("  - three\n\n");
  });

  test("Ctrl+Shift+K on a reference opens its search near it, filled in, and changes it", async ({ page }) => {
    await startWith(page, "See T1 for the details of the calibration, which are many and long. ".repeat(4));
    await page.locator(".cm-line").first().click();
    await page.keyboard.press("Control+Home");
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("ArrowRight");
    }
    const picker = page.locator(".rme-picker");
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("Control+Shift+k");
      await expect(picker.locator(".rme-picker-search")).toHaveValue("T1");
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
    await picker.locator(".rme-picker-search").fill("T2");
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

  test("moving through a list moves no text, and items are numbered like in the whole list", async ({ page }) => {
    await startWith(page, LIST.join("\n"));
    const positions = async () => Promise.all(TEXTS.map((text) => textBox(page, text)));
    const unfocused = await positions();
    for (const line of [3, 5, 7, 8, 14, 13]) {
      await page.locator(".cm-line", { hasText: "Intro" }).click();
      await page.keyboard.press("Control+Home");
      for (let i = 1; i < line; i++) {
        await page.keyboard.press("ArrowDown");
      }
      const now = await positions();
      now.forEach((box, i) => {
        expect(Math.abs(box.y - unfocused[i].y), `${TEXTS[i]} with the cursor on line ${line}`).toBeLessThan(1.5);
        expect(Math.abs(box.left - unfocused[i].left), `${TEXTS[i]} with the cursor on line ${line}`).toBeLessThan(2);
      });
    }
    // Numbered like in the whole list: from 3, the nested list with letters.
    const marker = (text: string) =>
      page.locator(".cm-line.rme-src-list", { hasText: text }).locator(".rme-item-marker li:not(.rme-list-around)");
    await expect(marker("first")).toHaveJSProperty("value", 3);
    await expect(marker("sub a")).toHaveCSS("list-style-type", "upper-alpha");
  });

  test("list items can be typed and their boxes checked", async ({ page }) => {
    await startWith(page, LIST.join("\n"));
    await page.locator(".cm-line", { hasText: "Intro" }).click();
    await page.keyboard.press("Control+Home");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("End");
    await page.keyboard.type(" and more");
    await page.keyboard.press("Enter");
    await page.keyboard.type("new");
    await expect.poll(() => source(page)).toContain("  - one item and more\n  - new\n  - two item");

    await page.locator(".cm-line.rme-src-list", { hasText: "three item" }).locator(".rme-item-check").click();
    await expect.poll(() => source(page)).toContain("  - [ ] three item");
    // The browser's own bullet, like on the page.
    await expect(page.locator(".cm-line.rme-src-list", { hasText: "new" }).locator(".rme-item-marker li")).toHaveCSS(
      "list-style-type",
      "disc",
    );
  });

  test("Home goes to the text of a list item first, then to the start of the line", async ({ page }) => {
    await startWith(page, "  - [ ] the item");
    await page.locator(".cm-line").first().click();
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
    await page.locator(".cm-line").first().click();
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
    await page.locator(".cm-line").first().click();
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
    await page.locator(".cm-line", { hasText: "Intro" }).click();
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

  test("dragging over rendered text selects it as it shows, from rendered text or from the source", async ({
    page,
  }) => {
    await startWith(page, TEXT);
    // From a paragraph down into the middle of the table, which is selected whole.
    const first = (await textBox(page, "paragraph"))!;
    const cell = (await page.locator(".rme-table-editor td", { hasText: "c" }).boundingBox())!;
    await page.mouse.move(first.left + 1, first.y);
    await page.mouse.down();
    await page.mouse.move(cell.x + 5, cell.y + 5, { steps: 6 });
    await expect.poll(() => highlighted(page)).toEqual(["abcd"]);
    const shown = await selected(page);
    await page.mouse.up();
    expect(shown).toBe("paragraph here.\n\n| a | b |\n| c | d |");
    await expect.poll(() => selected(page)).toBe(shown);
    // Selected whole, the table stays a table: nothing moves.
    await expect(page.locator(".rme-table-editor")).toHaveCount(1);

    // From the source of a paragraph being edited up into the table.
    await page.locator(".cm-line", { hasText: "Middle" }).click();
    const middle = (await page.locator(".cm-line", { hasText: "Middle" }).boundingBox())!;
    const table = (await page.locator(".rme-table-editor td", { hasText: "b" }).boundingBox())!;
    await page.mouse.move(middle.x + 60, middle.y + middle.height / 2);
    await page.mouse.down();
    await page.mouse.move(table.x + 5, table.y + 5, { steps: 6 });
    await expect.poll(async () => (await highlighted(page)).length).toBe(1);
    const fromSource = await selected(page);
    await page.mouse.up();
    expect(fromSource).toMatch(/^\| a \| b \|\n\| c \| d \|\n\nMiddl?e?/);
    await expect.poll(() => selected(page)).toBe(fromSource);
  });

  test("more blank lines than one between blocks are lines like any other", async ({ page }) => {
    await startWith(page, "Above\n\nBelow");
    const below = async () => (await textBox(page, "Below")).y;
    const before = await below();
    await page.locator(".cm-line", { hasText: "Above" }).click();
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
    await page.locator(".cm-line").first().click();
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

  test("headers show their markers while the cursor is on their line, quotes while it is in or before them", async ({
    page,
  }) => {
    await startWith(page, "== Title ==\n\n> Quoted");
    await expect(page.locator(".cm-line.rme-src-h")).toHaveText("Title");
    await page.locator(".cm-line.rme-src-h").click();
    await expect(page.locator(".cm-line.rme-src-h")).toHaveText("== Title ==");
    await page.keyboard.press("End");
    await expect(page.locator(".cm-line.rme-src-h")).toHaveText("== Title ==");

    await page.locator(".cm-line.rme-src-quote").click();
    await page.keyboard.press("End");
    await expect(page.locator(".cm-line.rme-src-quote")).toHaveText("Quoted");
    await page.keyboard.press("Home");
    await page.keyboard.press("Home");
    await expect(page.locator(".cm-line.rme-src-quote")).toHaveText("> Quoted");
  });

  test("quotes in quotes show inside the quote, and Enter, Backspace and the quote button take one level", async ({
    page,
  }) => {
    await startWith(page, "Start");
    // Both ways of writing a nested quote, as Phorge takes them (the editor would tidy them).
    await textarea(page).evaluate((t: HTMLTextAreaElement) => {
      t.value = "> Outer line\n>\n> > Inner one\n>> Inner two\n>\n> Outer again";
    });
    const line = (text: string) => page.locator(".cm-line", { hasText: text });
    await expect(line("Outer again")).toBeVisible();
    // Where the text starts on the screen.
    const textLeft = (text: string) =>
      line(text).evaluate((element, word) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const at = node.textContent!.indexOf(word);
          if (at >= 0) {
            const range = document.createRange();
            range.setStart(node, at);
            range.setEnd(node, at + 1);
            return range.getBoundingClientRect().left;
          }
        }
        throw new Error(`no ${word}`);
      }, text.split(" ")[0]);
    // Without their markers.
    await expect(line("Inner one")).toHaveText("Inner one");
    await expect(line("Inner two")).toHaveText("Inner two");
    await expect(line("Inner one")).toHaveClass(/rme-quote-depth-2 rme-quote-open/);
    await expect(line("Inner two")).toHaveClass(/rme-quote-depth-2 rme-quote-close/);
    await expect(line("Outer line")).not.toHaveClass(/rme-quote-depth/);
    // Blank lines between them: no extra space.
    await expect(line("Inner one")).not.toHaveClass(/rme-quote-apart/);
    // As Phorge renders it: the inner quote's border and padding, 15px further in.
    const outer = await textLeft("Outer line");
    expect(Math.abs((await textLeft("Inner one")) - outer - 15)).toBeLessThan(1);
    expect(Math.abs((await textLeft("Inner two")) - outer - 15)).toBeLessThan(1);
    expect(Math.abs((await textLeft("Outer again")) - outer)).toBeLessThan(1);

    // Enter continues the nested quote; on an empty line of it, the outer one.
    await line("Inner two").click();
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("three");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("back");
    await expect
      .poll(() => source(page))
      .toBe("> Outer line\n>\n>> Inner one\n>> Inner two\n>> three\n> back\n>\n> Outer again");
    // Without a blank line, Phorge's margin between the nested quote and the text after it.
    await expect(line("three")).toHaveClass(/rme-quote-close rme-quote-apart/);

    // Backspace at the start of the text takes off the marker of its level.
    await line("three").click();
    await page.keyboard.press("End");
    for (let i = 0; i < "three".length; i++) {
      await page.keyboard.press("ArrowLeft");
    }
    await page.keyboard.press("Backspace");
    await expect
      .poll(() => source(page))
      .toBe("> Outer line\n>\n>> Inner one\n>> Inner two\n> three\n> back\n>\n> Outer again");

    // The quote button takes off one level.
    await line("Inner two").click();
    await page.locator(".remarkup-assist-bar .remarkup-assist.fa-quote-right").first().click();
    await expect
      .poll(() => source(page))
      .toBe("> Outer line\n>\n>> Inner one\n> Inner two\n> three\n> back\n>\n> Outer again");
  });

  test("quote markers are written as Phorge quotes while editing: levels together, a space before the text", async ({
    page,
  }) => {
    // Firefox inserts this text as an input method would, which is not tidied while it is composed.
    await startWith(
      page,
      "> one \n>>two\n> > three\n>  indented\n> \n>>! In T1, @alice wrote:\n> > four\n\n```\n> > code\n```",
    );
    // An edit of the quote tidies all of it; a code block is no quote.
    await page.locator(".cm-line", { hasText: "four" }).click();
    await page.keyboard.press("End");
    await page.keyboard.type("!");
    await expect
      .poll(() => source(page))
      .toBe("> one \n>> two\n>> three\n>  indented\n>\n>>! In T1, @alice wrote:\n>> four!\n\n```\n> > code\n```");

    // Typed: the space comes before the cursor, the levels go together.
    await editor(page).press("Control+a");
    await page.keyboard.insertText("Text");
    await page.keyboard.press("Home");
    await page.keyboard.type(">");
    await expect.poll(() => source(page)).toBe("> Text");
    await page.keyboard.type("y");
    await expect.poll(() => source(page)).toBe("> yText");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("> > z");
    await expect.poll(() => source(page)).toBe("> yText\n\n>> z");
    // Where the cursor is, a blank line keeps its space for the text to come.
    await page.keyboard.press("Enter");
    await expect.poll(() => source(page)).toBe("> yText\n\n>> z\n>> ");
    // Phorge's own changes stay as they are.
    await textarea(page).evaluate((t: HTMLTextAreaElement) => {
      t.value = `> > Quoted.\n\n${t.value}`;
    });
    await expect(page.locator(".cm-line", { hasText: "Quoted." })).toBeVisible();
    // The editor writes its text back with the next edit, in another quote.
    await page.keyboard.type("w");
    await expect.poll(() => source(page)).toBe("> > Quoted.\n\n> yText\n\n>> z\n>> w");
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
    await expect(page.locator(".rme-table-editor td .cm-content:focus")).not.toHaveCSS(
      "caret-color",
      "rgba(0, 0, 0, 0)",
    );
  });
});

test.describe("eighth test round", () => {
  test("dragging from the end of a list item to the end of the one before selects only the item", async ({ page }) => {
    const text = "Intro.\n\n  - one entry\n  - two entry\n  - three entry\n\nEnd.";
    await startWith(page, text);
    await page.locator(".cm-line.rme-src-list", { hasText: "two entry" }).click();
    await page.keyboard.press("End");
    const two = (await page.locator(".cm-line", { hasText: "two entry" }).boundingBox())!;
    const one = (await page.locator(".cm-line.rme-src-list", { hasText: "one entry" }).boundingBox())!;
    // From the end of the item being edited up to the end of the one before it.
    await page.mouse.move(two.x + two.width - 3, two.y + two.height / 2);
    await page.mouse.down();
    await page.mouse.move(one.x + one.width - 3, one.y + one.height / 2, { steps: 6 });
    // The item before does not show selected: only the end of its line is.
    expect((await highlighted(page)).join("")).toBe("");
    await page.mouse.up();
    expect(await selected(page)).toBe("\n  - two entry");
    await page.keyboard.press("Control+x");
    await expect.poll(() => source(page)).toBe("Intro.\n\n  - one entry\n  - three entry\n\nEnd.");
  });

  test("Shift+Up keeps the column like a text field, over blank lines and rendered lists", async ({ page }) => {
    await startWith(page, "First paragraph is here.\nSecond line.\n\n  - one\n  - two\n\nEnd paragraph here.");
    await page.locator(".cm-line", { hasText: "End paragraph" }).click();
    await page.keyboard.press("End");
    const steps = [
      "\nEnd paragraph here.",
      // At the end of the shorter lines.
      "\n\nEnd paragraph here.",
      "\n  - two\n\nEnd paragraph here.",
      "\n  - one\n  - two\n\nEnd paragraph here.",
      "\n\n  - one\n  - two\n\nEnd paragraph here.",
    ];
    for (const step of steps) {
      await page.keyboard.press("Shift+ArrowUp");
      await expect.poll(() => selected(page)).toBe(step);
    }
    // Back in a long enough line: at the column it started from, not at the start of the line.
    await page.keyboard.press("Shift+ArrowUp");
    await expect.poll(() => selected(page)).toMatch(/^.{1,20}\nSecond line\.\n\n {2}- one/);
    expect(await selected(page)).not.toMatch(/^First/);
  });

  for (const font of ["", "serif", "monospace"]) {
    test(`bullets, numbers and checkboxes stay in place when the cursor comes to their item${font ? ` (${font})` : ""}`, async ({
      page,
    }) => {
      await openNewWikiPage(page, "Markers");
      if (font) {
        // E.g. Ubuntu's fonts, whose bullets were a few pixels off.
        await page.addStyleTag({ content: `.rme-editor, .rme-editor * { font-family: ${font} !important; }` });
        // The editor measures the page again, like when Dark Reader changes it.
        await page.evaluate(() => document.documentElement.classList.add("rme-test-font"));
      }
      await editor(page).click();
      await page.keyboard.insertText(
        "Intro.\n\n  - alpha\n  - beta\n    - gamma\n  - delta\n\nMiddle.\n\n  3. one\n  4. two\n    # sub a\n    # sub b\n\nChecks.\n\n  - [ ] open box\n  - [X] checked box\n\n[X] bare box",
      );
      await blur(page);
      await settled(page);
      const content = (await page.locator(".rme-editor .cm-content").boundingBox())!;
      for (const item of ["beta", "gamma", "two", "sub b", "checked box", "bare box"]) {
        const box = await textBox(page, item);
        // The marker before the text, and the start of the text (its place and color), on the item's line;
        // not the editor's edge, which glows with the focus.
        const clip = { x: content.x + 4, y: box.y - 9, width: box.left + 8 - content.x, height: 18 };
        const rendered = await page.screenshot({ clip });
        await page.mouse.click(box.left + 2, box.y);
        await page.keyboard.press("End");
        await expect(page.locator(".cm-line.rme-src-list", { hasText: item })).toBeVisible();
        expect(await page.screenshot({ clip }), `the marker of ${item}`).toEqual(rendered);
        await blur(page);
      }
    });
  }

  test("files dropped or pasted into a table cell go into the cell", async ({ page, browserName }) => {
    await startWith(page, "| a | b |\n| c | d |");
    const cell = page.locator(".rme-table-editor td", { hasText: "d" });
    await cell.evaluate((node) => {
      const data = new DataTransfer();
      data.items.add(new File(["hello"], "note.txt", { type: "text/plain" }));
      const box = node.getBoundingClientRect();
      const init = { bubbles: true, cancelable: true, clientX: box.left + 5, clientY: box.top + 5, dataTransfer: data };
      node.dispatchEvent(new DragEvent("dragover", init));
      node.dispatchEvent(new DragEvent("drop", init));
    });
    await expect.poll(() => source(page)).toMatch(/^\| a \| b \|\n\| c \| d \{F\d+\} \|$/);
    const metadata = await page.locator('input[name="content_metadata"]').inputValue();
    expect(JSON.parse(metadata).attachedFilePHIDs).toHaveLength(1);

    // Firefox ignores clipboardData of synthetic events.
    if (browserName === "chromium") {
      await page.locator(".rme-table-editor td", { hasText: "c" }).click();
      await page.keyboard.press("End");
      await page.evaluate(() => {
        const data = new DataTransfer();
        data.items.add(new File(["hello"], "other.txt", { type: "text/plain" }));
        document.activeElement!.dispatchEvent(
          new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
        );
      });
      await expect.poll(() => source(page)).toMatch(/^\| a \| b \|\n\| c \{F\d+\} \| d \{F\d+\} \|$/);
    }
  });

  test("the upload button puts the file where the caret is in a table cell, also when tables are edited as text", async ({
    page,
  }) => {
    const upload = async () => {
      await page.locator(".remarkup-assist.fa-cloud-upload").click();
      const dialog = page.locator(".jx-client-dialog");
      await dialog
        .locator('input[type="file"]')
        .setInputFiles({ name: "dot.png", mimeType: "image/png", buffer: PNG_BYTES });
      await dialog.locator("button[name=__submit__]").click();
      await expect(dialog).toHaveCount(0);
    };
    await startWith(page, "| a | b |\n| cell | d |");
    await page.locator(".rme-table-editor td", { hasText: "cell" }).click();
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await upload();
    await expect.poll(() => source(page)).toMatch(/^\| a \| b \|\n\| ce\{F\d+\}ll \| d \|$/);

    await page.locator(".rme-table-bar").getByRole("button", { name: "Edit the table as text" }).click();
    const line = (await page.locator(".cm-line", { hasText: "| a | b |" }).boundingBox())!;
    await page.mouse.click(line.x + 5, line.y + line.height / 2);
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("ArrowLeft");
    await upload();
    await expect.poll(() => source(page)).toMatch(/^\| a \| b\{F\d+\} \|\n\| ce\{F\d+\}ll \| d \|$/);
  });
});

test.describe("ninth test round", () => {
  test("lists nested by repeated markers are indented by markers", async ({ page }) => {
    await startWith(page, "- level 1\n-- level 2\n--- level 3\n- back");
    // Nested, like by indentation.
    await expect(page.locator(".cm-line.rme-list-depth-2")).toHaveText(/level 3$/);
    await page.locator(".cm-line.rme-src-list", { hasText: "back" }).click();
    await page.keyboard.press("End");
    await page.keyboard.press("Tab");
    await expect.poll(() => source(page)).toBe("- level 1\n-- level 2\n--- level 3\n-- back");
    await page.keyboard.press("Enter");
    await page.keyboard.type("next");
    await expect.poll(() => source(page)).toBe("- level 1\n-- level 2\n--- level 3\n-- back\n-- next");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Shift+Tab");
    await expect.poll(() => source(page)).toBe("- level 1\n-- level 2\n--- level 3\n-- back\n- next");
    // The item shows its bullet where the rendered one is, not its markers.
    await expect(page.locator(".cm-line.rme-src-list", { hasText: "next" })).toHaveText(/^​next$/);
  });

  test("checklist items without a bullet ([ ] item) can be checked, also while editing", async ({ page }) => {
    await startWith(page, "Intro.\n\n[ ] open\n[] empty\n[X] done");
    await page.locator(".cm-line.rme-src-list", { hasText: "open" }).locator(".rme-item-check").click();
    await expect.poll(() => source(page)).toBe("Intro.\n\n[X] open\n[] empty\n[X] done");
    // While editing, the item shows its checkbox, which can be clicked, and Enter adds one more.
    await page.locator(".cm-line.rme-src-list", { hasText: "empty" }).click({ position: { x: 60, y: 8 } });
    await page.keyboard.press("End");
    const check = page.locator(".cm-line", { hasText: "empty" }).locator(".rme-item-check .remarkup-list-item");
    // Its marker is the checkbox, with the space Phorge puts after it.
    await expect(page.locator(".cm-line", { hasText: "empty" })).toHaveText(/^ empty$/);
    await check.click();
    await expect.poll(() => source(page)).toBe("Intro.\n\n[X] open\n[X] empty\n[X] done");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.type("new");
    await expect.poll(() => source(page)).toBe("Intro.\n\n[X] open\n[X] empty\n[ ] new\n[X] done");
  });

  test("Up and Down keep the column through list items and blank lines, like a text field", async ({ page }) => {
    const text = "Intro paragraph.\n\n  - one entry\n  - two entry\n  - three entry\n\nEnd paragraph.";
    await startWith(page, text);
    await page.locator(".cm-line.rme-src-list", { hasText: "one entry" }).click({ position: { x: 5, y: 8 } });
    await page.keyboard.press("Home");
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("ArrowRight");
    }
    const line = () =>
      textarea(page).evaluate((t: HTMLTextAreaElement) => t.value.slice(0, t.selectionStart).split("\n").pop());
    await expect.poll(line).toBe("  - one ");
    for (const [key, expected] of [
      ["ArrowDown", "  - two "],
      ["ArrowDown", "  - thre"],
      ["ArrowDown", ""],
      ["ArrowDown", "End para"],
      ["ArrowUp", ""],
      ["ArrowUp", "  - thre"],
      ["ArrowUp", "  - two "],
    ]) {
      await page.keyboard.press(key);
      await expect.poll(line, `${key} to ${expected}`).toBe(expected);
    }
  });
});

test.describe("tenth test round", () => {
  test("nothing moves when the cursor goes through the text, line by line", async ({ page }) => {
    const text = [
      "= Title =",
      "Some **bold**, //italic// and `code` with T1 and [[ https://example.com | a link ]].",
      "== Section",
      "  - first item\n  - second **item**\n    - nested\n  - [ ] open box\n  - [X] done box",
      "> A quote\n> over two lines",
      "NOTE: A note.",
      "  # one\n  # two",
      "```\ncode block\n```",
      "| a | b |\n| 1 | 2 |",
      "---",
      "Last line.",
    ].join("\n\n");
    await startWith(page, text);
    // The bottom of the last line, and the tops of all lines.
    const layout = () =>
      page.evaluate(() =>
        [...document.querySelectorAll(".rme-editor .cm-content > *")].map((el) =>
          Math.round(el.getBoundingClientRect().top),
        ),
      );
    const unfocused = await layout();
    await page.locator(".cm-line", { hasText: "Title" }).click();
    await page.keyboard.press("Control+Home");
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      expect((await layout()).at(-1), `the cursor on line ${i + 1}: ${lines[i]}`).toBe(unfocused.at(-1));
      await page.keyboard.press("ArrowDown");
    }
  });
});

test.describe("eleventh test round", () => {
  test("Enter on an empty item ends the list without adding a line; at the start of a block it makes room above", async ({
    page,
  }) => {
    await openNewWikiPage(page, "Enter");
    await editor(page).click();
    await page.keyboard.insertText("  - one\n  - \nNext line.");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await expect.poll(() => source(page)).toBe("  - one\n\nNext line.");
    await expect.poll(() => textarea(page).evaluate((t: HTMLTextAreaElement) => t.selectionStart)).toBe(8);

    await page.keyboard.press("Control+a");
    await page.keyboard.press("Delete");
    await page.keyboard.insertText("Intro.\n\n  - one\n  - two\n\n= Title");
    // At the start of the first item's text (its bullet shows rendered), and of the header's.
    await page.locator(".cm-line", { hasText: "one" }).click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    await expect.poll(() => source(page)).toBe("Intro.\n\n\n  - one\n  - two\n\n= Title");
    // The header shows its markers: Home goes before them.
    await page.locator(".cm-line", { hasText: "Title" }).click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Enter");
    await expect.poll(() => source(page)).toBe("Intro.\n\n\n  - one\n  - two\n\n\n= Title");
    await page.keyboard.type("x");
    await expect.poll(() => source(page)).toBe("Intro.\n\n\n  - one\n  - two\n\n\nx= Title");
  });

  test("a header shows its markers while the cursor is on its line", async ({ page }) => {
    await startWith(page, "== Title ==\n\nText.");
    const header = page.locator(".cm-line.rme-src-h");
    await expect(header).toHaveText("Title");
    await page.locator(".cm-line", { hasText: "Text." }).click();
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press("ArrowUp");
    await expect(header).toHaveText("== Title ==");
    await page.keyboard.press("ArrowDown");
    await expect(header).toHaveText("Title");
  });

  test("Up and Down from before the marker of a list item land before the marker of the next", async ({ page }) => {
    await startWith(page, "  - one entry\n  - two entry\n  - three entry");
    const caret = () => textarea(page).evaluate((t: HTMLTextAreaElement) => t.selectionStart);
    await page.locator(".cm-line", { hasText: "two entry" }).click();
    // The start of the text, then the start of the line.
    await page.keyboard.press("Home");
    await expect.poll(caret).toBe(18);
    await page.keyboard.press("Home");
    await expect.poll(caret).toBe(14);
    await page.keyboard.press("ArrowUp");
    await expect.poll(caret).toBe(0);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect.poll(caret).toBe(28);
    // From the start of the text: at the start of the text.
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowUp");
    await expect.poll(caret).toBe(18);
  });

  test("/ opens the insert menu also after a space, but not in a word or path", async ({ page }) => {
    await openNewWikiPage(page, "Slash");
    await editor(page).click();
    await page.keyboard.type("Pick and/or ");
    await expect(page.locator(".rme-popup, .phuix-autocomplete").filter({ hasText: "Insert" })).toHaveCount(0);
    await page.keyboard.type("/horiz");
    const menu = page.locator(".jx-result", { hasText: "Horizontal line" });
    await expect(menu).toBeVisible();
    await page.keyboard.press("Enter");
    // Only "/horiz" is gone; the line stays and the rule comes after it.
    await expect.poll(() => source(page)).toBe("Pick and/or \n\n---\n\n");
  });

  test("the reference search finds tasks by their title, then by their text, open ones first", async ({ page }) => {
    await openNewWikiPage(page, "Reference search");
    const word = `zq${Date.now().toString(36)}`;
    const task = async (title: string, description: string, status?: string) =>
      conduit(page, "maniphest.edit", {
        transactions: [
          { type: "title", value: title },
          { type: "description", value: description },
          ...(status ? [{ type: "status", value: status }] : []),
        ],
      });
    // Newest first in Phorge's own order: the reverse of the expected one.
    await task("Archived note", `Its text mentions ${word}.`, "resolved");
    await task("Another task", `Its text mentions ${word}.`);
    await task(`Old ${word} work`, "", "resolved");
    await task(`Fix the ${word} board`, "");
    // The daemons index the tasks for the search.
    await expect
      .poll(async () => (await conduit(page, "maniphest.search", { constraints: { query: `~${word}` } })).data.length, {
        timeout: 30000,
      })
      .toBe(4);
    await editor(page).click();
    await page.keyboard.press("Control+Shift+k");
    await page.locator(".rme-picker .rme-picker-search").fill(word);
    const tasks = page.locator(".rme-picker .jx-result", { has: page.locator(".fa-anchor") });
    await expect(tasks).toHaveCount(4);
    await expect(tasks).toContainText([`Fix the ${word} board`, `Old ${word} work`, "Another task", "Archived note"]);
  });

  test("the search lists wiki pages and tasks by title, then by text, open before closed, pages first", async ({
    page,
  }) => {
    test.slow();
    await openNewWikiPage(page, "Search order");
    const word = `zw${Date.now().toString(36)}`;
    const task = (title: string, description: string, status?: string) =>
      conduit(page, "maniphest.edit", {
        transactions: [
          { type: "title", value: title },
          { type: "description", value: description },
          ...(status ? [{ type: "status", value: status }] : []),
        ],
      });
    const wiki = async (title: string, content: string) => {
      const slug = `e2e-${word}-${title.replace(/\W+/g, "-").toLowerCase()}/`;
      await conduit(page, "phriction.create", { slug, title, content });
      return (await conduit(page, "phriction.document.search", { constraints: { paths: [slug] } })).data[0].id;
    };
    await task("Closed task text", `Mentions ${word}.`, "resolved");
    await task("Open task text", `Mentions ${word}.`);
    await task(`Closed ${word} task`, "", "resolved");
    await task(`Open ${word} task`, "");
    await wiki("Open page text", `Mentions ${word}.`);
    await wiki(`Open ${word} page`, "Nothing else.");
    const deleted = await wiki(`Gone ${word} page`, "Nothing else.");
    // Deleted pages count as closed ones.
    await page.goto(`/phriction/delete/${deleted}/`);
    await page.getByRole("button", { name: /Delete/ }).click();
    await page.waitForURL(/\/w\//);
    // The daemons index them for the search.
    const indexed = async (method: string) =>
      (await conduit(page, method, { constraints: { query: `~${word}` } })).data.length;
    await expect.poll(() => indexed("maniphest.search"), { timeout: 30000 }).toBe(4);
    await expect.poll(() => indexed("phriction.document.search"), { timeout: 30000 }).toBe(3);
    await openNewWikiPage(page, "Search order");
    await editor(page).click();
    await page.keyboard.press("Control+k");
    await page.locator(".rme-picker .rme-picker-search").fill(word);
    const results = page.locator(".rme-picker .jx-result");
    await expect(results.filter({ hasText: /Open|Closed|Gone/ })).toHaveText([
      new RegExp(`Open ${word} page`),
      new RegExp(`Open ${word} task`),
      new RegExp(`Gone ${word} page`),
      new RegExp(`Closed ${word} task`),
      /Open page text/,
      /Open task text/,
      /Closed task text/,
    ]);
  });

  test("Phorge's autocomplete works in table cells", async ({ page }) => {
    await startWith(page, "| a | b |\n| c | d |");
    await page.locator(".rme-table-editor td", { hasText: "d" }).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" #demo");
    await expect(page.locator(".jx-result").first()).toHaveText("Demo Project");
    await page.keyboard.press("Enter");
    await expect.poll(() => source(page)).toBe("| a | b |\n| c | d #demo_project  |");
    await page.keyboard.type("[[demo");
    await expect(page.locator(".jx-result").first()).toHaveText("Remarkup Demo");
    await page.keyboard.press("Enter");
    // The link's own "]]", not the ones the cell added for "[[".
    await expect.poll(() => source(page)).toBe("| a | b |\n| c | d #demo_project [[ demo/ ]]  |");
  });
});

test.describe("twelfth test round", () => {
  const LONG = (name: string) => `${name} ${"with words that wrap around the line ".repeat(9)}`;

  for (const [start, keys] of [
    ["the start of its text", ["Home"]],
    ["before its marker", ["Home", "Home"]],
  ] as const) {
    test(`Up goes through every row of a wrapped list item, from ${start} of the next`, async ({ page }) => {
      await startWith(page, `Intro.\n\n  - ${LONG("first")}\n  - ${LONG("second")}`);
      const rows = await page
        .locator(".cm-line", { hasText: "first" })
        .evaluate((line) =>
          Math.round(line.getBoundingClientRect().height / parseFloat(getComputedStyle(line).lineHeight)),
        );
      expect(rows).toBeGreaterThanOrEqual(3);
      await page.locator(".cm-line", { hasText: "second" }).click({ position: { x: 300, y: 8 } });
      for (const key of keys) {
        await page.keyboard.press(key);
      }
      const line = () =>
        textarea(page).evaluate((t: HTMLTextAreaElement) => t.value.slice(0, t.selectionStart).split("\n").length);
      // Each Up a row of the first item, from its last to its first, then the line above it.
      let stayed = 0;
      for (let i = 0; i < rows + 1; i++) {
        await page.keyboard.press("ArrowUp");
        if ((await line()) === 3) {
          stayed++;
        } else {
          break;
        }
      }
      expect(stayed).toBe(rows);
      expect(await line()).toBe(2);
    });
  }

  test("a click on the bullet or number of a list item edits it", async ({ page }) => {
    await startWith(page, "  - one\n  - two\n\n  # first\n  # second");
    const caret = () => textarea(page).evaluate((t: HTMLTextAreaElement) => t.selectionStart);
    for (const [item, at] of [
      ["two", 11],
      ["second", 30],
    ] as const) {
      const text = await textBox(page, item);
      await page.mouse.click(text.left - 3, text.y);
      // After the marker, which shows its source.
      await expect.poll(caret).toBe(at);
      await expect(page.locator(".cm-line", { hasText: item })).toHaveText(new RegExp(`^ {2}[-#] ${item}$`));
    }
  });
});

test.describe("thirteenth test round", () => {
  const caret = (page: Page) => textarea(page).evaluate((t: HTMLTextAreaElement) => t.selectionStart);

  test("a click next to formatted text puts the cursor outside of its markers", async ({ page }) => {
    await startWith(page, "Some **bold** text\n\nEnds **bolder**");
    // On the right half of the last letter, and right of a line ending in it.
    const bold = await textBox(page, "bold");
    await page.mouse.click(bold.right - 1, bold.y);
    await expect.poll(() => caret(page)).toBe(13);
    const bolder = await textBox(page, "bolder");
    await page.mouse.click(bolder.right + 40, bolder.y);
    await expect.poll(() => caret(page)).toBe(35);
    // On the left half of the first letter.
    await page.mouse.click(bold.left + 1, bold.y);
    await expect.poll(() => caret(page)).toBe(5);
    await page.keyboard.type("x");
    await expect.poll(() => source(page)).toBe("Some x**bold** text\n\nEnds **bolder**");
  });

  test("a click between two blocks goes to the nearer line, where the mouse is", async ({ page }) => {
    await startWith(page, "Some text above.\n  - [ ] open box");
    const spacer = (await page.locator(".rme-spacer").boundingBox())!;
    const text = await textBox(page, "text above");
    // Nearer the checklist item: in its text, not before its checkbox.
    await page.mouse.click(text.left, spacer.y + spacer.height - 1);
    await expect.poll(() => caret(page)).toBe(25);
    // Nearer the text above: where the mouse is in it.
    await page.mouse.click(text.left + 1, spacer.y + 1);
    await expect.poll(() => caret(page)).toBe(5);
  });

  test("a click on or right of a bullet or number edits it", async ({ page }) => {
    await startWith(page, "  - one\n  - two\n\n  1. first\n  2. second");
    for (const [item, at] of [
      ["two", 11],
      ["second", 32],
    ] as const) {
      const text = await textBox(page, item);
      const left = await markerLeft(page, item);
      // On the marker, which is drawn by the browser, and between it and the text.
      for (const x of [left + 2, (left + text.left) / 2, text.left - 2]) {
        await page.locator(".cm-line", { hasText: "one" }).click();
        await page.mouse.click(x, text.y);
        await expect.poll(() => caret(page), `${Math.round(text.left - x)}px left of ${item}`).toBe(at);
      }
    }
  });

  test("Backspace at the start of a quote line removes its marker, in a list item a character", async ({ page }) => {
    await startWith(page, "  - one\n  - two\n\n> quoted\n> ");
    await page.locator(".cm-line", { hasText: "quoted" }).click();
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Backspace");
    await expect.poll(() => source(page)).toBe("  - one\n  - two\n\n> quoted\n");
    // In a list item, Backspace deletes what is before the cursor, like anywhere.
    await page.locator(".cm-line", { hasText: "two" }).click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Backspace");
    await expect.poll(() => source(page)).toBe("  - one\n  -two\n\n> quoted\n");
  });
});

test.describe("fourteenth test round", () => {
  const caret = (page: Page) => textarea(page).evaluate((t: HTMLTextAreaElement) => t.selectionStart);

  test("Home and End put the cursor outside of hidden markers", async ({ page }) => {
    await startWith(page, "Ends **bolder**\n**Starts** bold");
    await page.locator(".cm-line", { hasText: "Ends" }).click();
    await page.keyboard.press("Home");
    await page.keyboard.press("End");
    await expect.poll(() => caret(page)).toBe(15);
    await page.locator(".cm-line", { hasText: "Starts" }).click();
    await page.keyboard.press("End");
    await page.keyboard.press("Home");
    await expect.poll(() => caret(page)).toBe(16);
    await page.keyboard.type("x");
    await expect.poll(() => source(page)).toBe("Ends **bolder**\nx**Starts** bold");
  });

  test("a click left of a bullet, number or checkbox goes to the start of the line", async ({ page }) => {
    await startWith(page, "  - one\n  - two\n\n  1. first\n  2. second\n\n  - [ ] box item\n  - [ ] other box");
    for (const [item, start] of [
      ["two", 8],
      ["second", 28],
      ["other box", 58],
    ] as const) {
      await page.locator(".cm-line", { hasText: "one" }).click();
      const text = await textBox(page, item);
      const line = (await page.locator(".cm-line", { hasText: item }).boundingBox())!;
      // In the indentation, left of the marker.
      await page.mouse.click(line.x + 3, text.y);
      await expect.poll(() => caret(page), item).toBe(start);
    }
  });
});

test.describe("fifteenth test round", () => {
  const caret = (page: Page) => textarea(page).evaluate((t: HTMLTextAreaElement) => t.selectionStart);

  test("a click left of a list marker that shows its source goes to the start of the line", async ({ page }) => {
    await startWith(page, "  - one\n  - two");
    const line = page.locator(".cm-line", { hasText: "two" });
    await line.click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Home");
    // The cursor before the marker: it shows "  - two".
    await expect(line).toHaveText("  - two");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await expect.poll(() => caret(page)).toBe(11);
    const box = (await line.boundingBox())!;
    await page.mouse.click(box.x + 3, box.y + box.height / 2);
    await expect.poll(() => caret(page)).toBe(8);
  });

  test("lines that Phorge shows on the line before them are marked: of notes and list items", async ({ page }) => {
    await startWith(
      page,
      "WARNING: This text\ngoes into\nthe same line\n\n  - an item\n    continued here\n  - next item\n\nA paragraph\nkeeps its lines.",
    );
    // The note while it is edited; the list item always.
    await expect(page.locator(".cm-line.rme-joined")).toHaveText(["continued here"]);
    await page.locator(".rme-block-note").click();
    await expect(page.locator(".cm-line.rme-joined")).toHaveText(["goes into", "the same line", "continued here"]);
    await expect(page.locator(".cm-line.rme-joined").first()).toHaveAttribute(
      "title",
      /Phorge shows this line on the line before it/,
    );
  });
});

test.describe("sixteenth test round", () => {
  test("a note of more lines shows on one line like in Phorge, until it is edited", async ({ page }) => {
    await startWith(page, "WARNING: This text\ngoes into\nthe same line\n\nAfter.\n\nNOTE: One line.");
    const rendered = page.locator(".rme-block-note .remarkup-warning");
    await expect(rendered).toHaveText("WARNING: This text goes into the same line");
    // A note of one line is text like any other.
    await expect(page.locator(".cm-line.remarkup-note")).toHaveText("NOTE: One line.");
    // After a note, a blank line is the only space: no gap like between blocks on consecutive lines.
    const line = await editor(page).evaluate((el) => parseFloat(getComputedStyle(el).lineHeight));
    const gap = () =>
      page.evaluate(
        () =>
          [...document.querySelectorAll(".cm-line")].find((l) => l.textContent === "After.")!.getBoundingClientRect()
            .top - document.querySelector(".rme-block-note")!.getBoundingClientRect().bottom,
      );
    await page.waitForTimeout(500);
    await expect.poll(gap).toBeCloseTo(line, 0);
    await rendered.click();
    await expect(page.locator(".rme-block-note")).toHaveCount(0);
    await expect(page.locator(".cm-line.rme-joined")).toHaveText(["goes into", "the same line"]);
  });

  test("an anchor shows with its name, not as a project, until the cursor is on it", async ({ page }) => {
    await startWith(page, "See {anchor #demo-part} here. Not {anchor #demo_project}.");
    const anchor = page.locator(".cm-line .rme-anchor");
    await expect(anchor).toHaveText("demo-part");
    // Like in Phorge, a name with "_" is no anchor's: its "#demo_project" is a project.
    await expect(page.locator(".cm-line .phui-tag-view")).toHaveText("Demo Project");
    await anchor.click();
    await expect(page.locator(".cm-line")).toContainText("See {anchor #demo-part} here.");
  });
});

test.describe("seventeenth test round", () => {
  test("a checkbox is added to or removed from the selected items only, of any kind of list", async ({ page }) => {
    await startWith(page, "  - one\n  - two\n  - three\n\n  # first\n  # second");
    const toolbarButton = page.locator(".remarkup-assist-bar .remarkup-assist.fa-check-square-o").first();
    await page.locator(".cm-line", { hasText: "two" }).click();
    await toolbarButton.click();
    await expect.poll(() => source(page)).toBe("  - one\n  - [ ] two\n  - three\n\n  # first\n  # second");
    await page.locator(".cm-line", { hasText: "second" }).click();
    await toolbarButton.click();
    await expect.poll(() => source(page)).toBe("  - one\n  - [ ] two\n  - three\n\n  # first\n  # [ ] second");
    await toolbarButton.click();
    await expect.poll(() => source(page)).toBe("  - one\n  - [ ] two\n  - three\n\n  # first\n  # second");
    // Switching the kind of the list keeps the checkboxes.
    await page.locator(".cm-line", { hasText: "one" }).click();
    await page.locator(".remarkup-assist-bar .remarkup-assist.fa-list-ol").first().click();
    await expect.poll(() => source(page)).toBe("  # one\n  # [ ] two\n  # three\n\n  # first\n  # second");
  });

  test("the insert menu has anchors, important and warning boxes, emoji and headings by level", async ({ page }) => {
    await openNewWikiPage(page, "Insert menu");
    await editor(page).click();
    await page.keyboard.type("/anch");
    await page.keyboard.press("Enter");
    await page.keyboard.type("setup");
    await expect.poll(() => source(page)).toBe("{anchor #setup}");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/warn");
    await expect(page.locator(".jx-result").first()).toContainText("Warning box");
    await page.keyboard.press("Enter");
    await expect.poll(() => source(page)).toBe("{anchor #setup}\n\nWARNING: Note text");
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/h2");
    await expect(page.locator(".jx-result").first()).toContainText("Heading 2");
  });

  test("the editor is as high as its text, also after deleting much of it", async ({ page }) => {
    await startWith(page, Array.from({ length: 30 }, (_, i) => `Line ${i}`).join("\n\n"));
    const height = () => page.locator(".rme-editor").evaluate((el) => el.getBoundingClientRect().height);
    expect(await height()).toBeGreaterThan(1000);
    await page.locator(".cm-line", { hasText: "Line 0" }).click();
    await page.keyboard.press("End");
    await page.keyboard.press("Control+Shift+End");
    await page.keyboard.press("Delete");
    await expect.poll(height).toBeLessThan(130);
  });

  test("table cells have the live preview: only what the cursor is on shows its source", async ({ page }) => {
    await startWith(page, "| Name | Note |\n| --- | --- |\n| Fe | See **bold** text |\n| Cu | plain |");
    await page.locator(".rme-table-editor td", { hasText: "Cu" }).click();
    const live = page.locator(".rme-table-editor .rme-cell-editor");
    await expect(live).toHaveCount(1);
    const cell = page.locator(".rme-table-editor td", { hasText: "See" });
    const box = (await cell.boundingBox())!;
    await page.mouse.click(box.x + 4, box.y + box.height / 2);
    await expect(live.locator(".cm-line")).toHaveText("See bold text");
    await page.keyboard.press("End");
    await page.keyboard.type(" more");
    await expect
      .poll(() => source(page))
      .toBe("| Name | Note |\n| --- | --- |\n| Fe | See **bold** text more |\n| Cu | plain |");
    // Next to the bold text, its markers.
    await page.keyboard.press("Home");
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("ArrowRight");
    }
    await expect(live.locator(".cm-line")).toHaveText("See **bold** text more");
    // Tab goes on to the next cell, Escape leaves the table, which shows rendered.
    await page.keyboard.press("Tab");
    await expect(live.locator(".cm-line")).toHaveText("Cu");
    await page.keyboard.press("Escape");
    await expect(live).toHaveCount(0);
    await expect(cell.locator("strong")).toHaveText("bold");
  });
});

test.describe("eighteenth test round", () => {
  /** A table with live cells, its cell with "See" being edited. */
  async function liveCell(page: Page) {
    // The choice of the former "live" mode, which tried out what cells are now: tables as tables.
    await page.addInitScript(() => localStorage.setItem("phizziwig-table-mode", "live"));
    await startWith(page, "| Name | Note |\n| --- | --- |\n| Fe | See T1 and [[ /w/ | wiki ]] end |");
    const cell = page.locator(".rme-table-editor td", { hasText: "See" });
    const box = (await cell.boundingBox())!;
    await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
    await expect(page.locator(".rme-cell-editor")).toHaveCount(1);
    return page.locator(".rme-cell-editor .cm-line");
  }

  test("in a live cell, a click on a rendered reference or link puts the cursor at it", async ({ page }) => {
    const line = await liveCell(page);
    // Rendered right away, also references the cell did not show before.
    const reference = line.locator(".rme-inline-ref", { hasText: "T1" });
    await expect(reference).toBeVisible();
    await reference.click();
    await page.keyboard.type("Z");
    await expect.poll(() => source(page)).toContain("| See T1Z and [[ /w/ | wiki ]] end |");
    await page.keyboard.press("Backspace");
    await line.locator(".rme-inline-ref", { hasText: "wiki" }).click();
    await page.keyboard.type("Z");
    await expect.poll(() => source(page)).toContain("| See T1 and [[ /w/ | wiki ]]Z end |");
  });

  test("in a live cell, the insert menu offers what fits in a cell", async ({ page }) => {
    const line = await liveCell(page);
    await page.keyboard.press("End");
    await page.keyboard.type(" /");
    const items = page.locator(".rme-autocomplete .jx-result, .phuix-autocomplete .jx-result");
    await expect(items.first()).toBeVisible();
    const labels = await items.allTextContents();
    expect(labels.some((label) => label.includes("Image macro"))).toBe(true);
    expect(labels.some((label) => label.includes("Table"))).toBe(false);
    await page.keyboard.type("anch");
    await page.keyboard.press("Enter");
    await page.keyboard.type("here");
    await expect.poll(() => source(page)).toContain("| See T1 and [[ /w/ | wiki ]] end {anchor #here} |");
    await expect(line).toBeVisible();
  });

  test("image macros are found by name with their pictures, and go on a line of their own", async ({ page }) => {
    await openNewWikiPage(page, "Macros");
    await editor(page).click();
    await page.keyboard.type("Hello /macro");
    await page.keyboard.press("Enter");
    const result = page.locator(".rme-picker .jx-result", { hasText: "rmecat" });
    await expect(result.locator("img.rme-popup-image")).toHaveAttribute("src", /rmecat/);
    await result.click();
    await expect.poll(() => source(page)).toBe("Hello \nrmecat");
  });

  test("cards and literal text from the insert menu, anchors with a # icon", async ({ page }) => {
    await openNewWikiPage(page, "Cards");
    await editor(page).click();
    await page.keyboard.type("/card");
    await page.keyboard.press("Enter");
    await page.keyboard.type("T1");
    await expect(page.locator(".rme-picker .jx-result").first()).toContainText("Calibrate the detector");
    await page.keyboard.press("Enter");
    await expect.poll(() => source(page)).toBe("{T1}");
    await page.keyboard.type(" /literal");
    await page.keyboard.press("Enter");
    await page.keyboard.type("**as is**");
    await expect.poll(() => source(page)).toBe("{T1} %%%**as is**%%%");
    await page.keyboard.press("End");
    await page.keyboard.insertText(" {anchor #top}");
    await page.keyboard.press("Home");
    await expect(page.locator(".rme-anchor .fa-hashtag")).toBeVisible();
  });
});

test.describe("nineteenth test round", () => {
  const TABLE = "| Name | Note |\n| --- | --- |\n| Fe | some words here |";

  /** The table, its cell with "some words" being edited, "words" selected. */
  async function selectInCell(page: Page) {
    await startWith(page, TABLE);
    await page.locator(".rme-table-editor td", { hasText: "some" }).click();
    await page.keyboard.press("Home");
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press("ArrowRight");
    }
    await page.keyboard.press("Control+Shift+ArrowRight");
  }

  test("in a cell, the insert menu, the link keys and URLs pasted over text work like in the text", async ({
    page,
  }) => {
    await selectInCell(page);
    await page.keyboard.press("Control+k");
    const picker = page.locator(".rme-picker");
    await expect(picker).toContainText("Link to");
    await page.locator(".rme-picker .rme-picker-search").fill("https://example.com/k");
    await expect(page.locator(".rme-picker .jx-result.focused")).toContainText("Link to");
    await page.keyboard.press("Enter");
    await expect.poll(() => source(page)).toContain("| some [[ https://example.com/k | words ]] here |");
    // The link is changed with the same key, also by its bubble.
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".rme-table-editor .rme-link-bubble")).toContainText("Change");
    await page.keyboard.press("Control+z");
    await expect.poll(() => source(page)).toBe(TABLE);

    // A reference with the selected text as its text.
    await page.locator(".rme-table-editor td", { hasText: "some" }).click();
    await page.keyboard.press("Home");
    await page.keyboard.press("Control+Shift+ArrowRight");
    await page.keyboard.press("Control+Shift+K");
    await expect(picker).toContainText("Link to");
    await page.locator(".rme-picker .rme-picker-search").fill("T1");
    await expect(page.locator(".rme-picker .jx-result").first()).toContainText("Calibrate the detector");
    await page.keyboard.press("Enter");
    await expect.poll(() => source(page)).toMatch(/\| \[\[ \S*T1 \| some \]\] words here \|$/);
    await page.keyboard.press("Control+z");
    await expect.poll(() => source(page)).toBe(TABLE);

    // A URL pasted over selected text links it. (Firefox takes only the
    // clipboard's text, copied before the cell is edited: copying ends that.)
    const firefox = page.context().browser()?.browserType().name() === "firefox";
    if (firefox) {
      await page.locator("input[name=title]").fill("https://example.com/p");
      await page.locator("input[name=title]").selectText();
      await page.keyboard.press("Control+c");
    }
    await page.locator(".rme-table-editor td", { hasText: "some" }).click();
    await page.keyboard.press("End");
    await page.keyboard.press("Control+Shift+ArrowLeft");
    if (firefox) {
      await page.keyboard.press("Control+v");
    } else {
      await page.evaluate(() => {
        const data = new DataTransfer();
        data.setData("text/plain", "https://example.com/p");
        document.activeElement!.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
        );
      });
    }
    await expect.poll(() => source(page)).toContain("| some words [[ https://example.com/p | here ]] |");

    // The insert menu, with what fits in a cell.
    await page.keyboard.press("End");
    await page.keyboard.type(" /anch");
    await page.keyboard.press("Enter");
    await page.keyboard.type("x");
    await expect.poll(() => source(page)).toContain("| some words [[ https://example.com/p | here ]] {anchor #x} |");
  });

  test("a table edited as text keeps its source while a search for it is open", async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem("phizziwig-table-mode", "text"));
    await startWith(page, TABLE);
    await page.locator(".rme-block-table").click();
    await page.locator(".cm-line", { hasText: "some" }).click();
    await page.keyboard.press("Control+k");
    // Once the search has its results, the editor has long noticed losing the focus.
    await page.locator(".rme-picker .rme-picker-search").fill("https://example.com");
    await expect(page.locator(".rme-picker .jx-result.focused")).toContainText("Link to");
    await expect(page.locator(".cm-line", { hasText: "some" })).toBeVisible();
    await expect(page.locator(".rme-block-table")).toHaveCount(0);
    // The focus going elsewhere closes the search, and the table shows rendered.
    await page.locator("input[name=title]").click();
    await expect(page.locator(".rme-picker")).toHaveCount(0);
    await expect(page.locator(".rme-block-table")).toHaveCount(1);
  });

  test("the image macros scroll in a short list, their pictures loading when scrolled to", async ({ page }) => {
    const names = Array.from({ length: 60 }, (_, i) => `testmacro${String(i).padStart(2, "0")}`);
    const loaded = new Set<string>();
    await page.route("**/api/macro.query", (route) =>
      route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          result: Object.fromEntries(names.map((name) => [name, { uri: `${FILES_URL}/rme-test-macro/${name}.png` }])),
          error_code: null,
          error_info: null,
        }),
      }),
    );
    await page.route("**/rme-test-macro/*", (route) => {
      loaded.add(route.request().url().split("/").pop()!);
      return route.fulfill({ contentType: "image/png", body: PNG_BYTES });
    });
    await openNewWikiPage(page, "Macros");
    await editor(page).click();
    await page.keyboard.type("/macro");
    await page.keyboard.press("Enter");
    const list = page.locator(".rme-picker .phuix-autocomplete-list");
    await expect(list.locator(".jx-result")).toHaveCount(60);
    const [height, full] = await list.evaluate((el) => [el.clientHeight, el.scrollHeight]);
    expect(height).toBeLessThan(400);
    expect(full).toBeGreaterThan(height * 3);
    await expect.poll(() => loaded.size).toBeGreaterThan(0);
    expect(loaded.has("testmacro59.png")).toBe(false);
    await list.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect.poll(() => loaded.has("testmacro59.png")).toBe(true);
  });

  test("ASCII art from the insert menu: a cow saying something, big letters", async ({ page }) => {
    await openNewWikiPage(page, "Art");
    await editor(page).click();
    await page.keyboard.type("/cow");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Moo!");
    await expect.poll(() => source(page)).toBe("cowsay{{{\nMoo!\n}}}");
    await page.keyboard.press("Control+End");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("/big");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Hi");
    await expect.poll(() => source(page)).toBe("cowsay{{{\nMoo!\n}}}\n\nfiglet{{{Hi}}}");
    await blur(page);
    // Drawn by Phorge.
    await expect(page.locator(".rme-block", { hasText: "Moo!" })).toContainText("(oo)");
  });
});

test.describe("twentieth test round", () => {
  test("icons, keys and navigation paths show as Phorge draws them, their source where the cursor is", async ({
    page,
  }) => {
    // A reference in a path is part of it.
    await startWith(page, "Icon {icon camera color=red} keys {key Ctrl K} path {nav Tasks > T1} end.");
    const line = page.locator(".cm-line", { hasText: "end." });
    await expect(line.locator(".phui-icon-view.fa-camera.red")).toBeVisible();
    await expect(line.locator("kbd")).toHaveCount(2);
    await expect(line.locator(".remarkup-nav-sequence")).toHaveText("Tasks → T1");
    await expect(line).not.toContainText("{icon");
    // The cursor in one shows its source, the others stay drawn.
    await line.click();
    await page.keyboard.press("Home");
    for (let i = 0; i < 7; i++) {
      await page.keyboard.press("ArrowRight");
    }
    await expect(line).toContainText("{icon camera color=red}");
    await expect(line.locator("kbd")).toHaveCount(2);
    await expect(line).not.toContainText("{nav");
  });

  test("icons, keys and navigation paths from the insert menu", async ({ page }) => {
    await openNewWikiPage(page, "Icons");
    await editor(page).click();
    await page.keyboard.type("/icon");
    await page.keyboard.press("Enter");
    // Found by name, a color word colors it.
    await page.locator(".rme-picker .rme-picker-search").fill("camera red");
    const first = page.locator(".rme-picker .jx-result").first();
    await expect(first).toContainText("camera, red");
    // In the color Phorge draws it in, not the menu's.
    const red = await page.evaluate(() => {
      const probe = document.createElement("span");
      probe.className = "phui-icon-view phui-font-fa fa-flag red";
      document.body.append(probe);
      return getComputedStyle(probe).color;
    });
    await expect(first.locator(".fa-camera.red")).toHaveCSS("color", red);
    await page.keyboard.press("Enter");
    await expect.poll(() => source(page)).toBe("{icon camera color=red}");
    // All of them to browse, in a list that scrolls.
    await page.keyboard.type(" /icon");
    await page.keyboard.press("Enter");
    const list = page.locator(".rme-picker .phuix-autocomplete-list");
    await expect.poll(() => list.locator(".jx-result").count()).toBeGreaterThan(300);
    expect(await list.evaluate((el) => el.clientHeight)).toBeLessThan(400);
    await page.locator(".rme-picker .rme-picker-search").fill("cog spin");
    await expect(first).toContainText("cog, spinning");
    await page.keyboard.press("Enter");
    await expect.poll(() => source(page)).toBe("{icon camera color=red} {icon cog spin}");

    await page.keyboard.type(" /keys");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Ctrl S");
    await page.keyboard.press("End");
    await page.keyboard.type(" /nav");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Wiki > Edit");
    await expect
      .poll(() => source(page))
      .toBe("{icon camera color=red} {icon cog spin} {key Ctrl S} {nav Wiki > Edit}");
  });
});

test.describe("twenty-first test round", () => {
  test("the insert menu groups its items under headings", async ({ page }) => {
    await openNewWikiPage(page, "Groups");
    await editor(page).click();
    await page.keyboard.type("/");
    const groups = page.locator(".rme-autocomplete .rme-popup-group");
    await expect(groups).toHaveText(["Headings", "Lists", "Blocks", "Links", "Text", "Images", "ASCII art"]);
    // Each item under its heading.
    const next = (group: string) =>
      page
        .locator(".rme-autocomplete .rme-popup-group", { hasText: new RegExp(`^${group}$`) })
        .evaluate((heading) => heading.nextElementSibling?.textContent);
    expect(await next("Lists")).toContain("Bulleted list");
    expect(await next("ASCII art")).toContain("Cow says");
    // Filtering keeps the headings of what is left; the keys pick items, not headings.
    await page.keyboard.type("li");
    await expect(groups).toHaveText(["Lists", "Blocks", "Links", "Text"]);
    await page.keyboard.press("ArrowDown");
    await expect(page.locator(".rme-autocomplete .jx-result.focused")).toHaveText(/Numbered list/);
  });
});

test.describe("fixes of the review", () => {
  test("a new inline comment can be typed in right away: the editor takes the focus Phorge gives the textarea", async ({
    page,
  }) => {
    await createRevision(page, "Inline focus");
    await addPhlair(page);
    await page.locator("td.new.n").first().click();
    const inline = page.locator(".differential-inline-comment-edit");
    await expect(inline.locator(".rme-editor .cm-content")).toBeFocused();
    await page.keyboard.type("Right away.");
    await expect(inline.locator("textarea.remarkup-assist-textarea")).toHaveValue("Right away.");
    // Later calls too, e.g. when Phorge pins or enlarges the form.
    await blur(page);
    await expect(inline.locator(".rme-editor .cm-content")).not.toBeFocused();
    await inline.locator("textarea.remarkup-assist-textarea").evaluate((t: HTMLTextAreaElement) => t.focus());
    await expect(inline.locator(".rme-editor .cm-content")).toBeFocused();
  });

  test("the editor is read-only while Phorge submits the form", async ({ page }) => {
    await startWith(page, "Text.");
    await textarea(page).evaluate((t: HTMLTextAreaElement) => (t.disabled = true));
    await expect(editor(page)).toHaveAttribute("contenteditable", "false");
    await textarea(page).evaluate((t: HTMLTextAreaElement) => (t.disabled = false));
    await expect(editor(page)).toHaveAttribute("contenteditable", "true");
  });

  test("a search picks for the text it was opened on, also when the text before it changed meanwhile", async ({
    page,
  }) => {
    await startWith(page, "See the docs here.");
    await page.locator(".cm-line", { hasText: "docs" }).click();
    await page.keyboard.press("End");
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("ArrowLeft");
    }
    await page.keyboard.press("Control+Shift+ArrowLeft");
    await page.keyboard.press("Control+k");
    // E.g. an upload before it finishing, or Phorge changing the textarea.
    await textarea(page).evaluate((t: HTMLTextAreaElement) => (t.value = `Uploaded {F1}. ${t.value}`));
    await expect(editor(page)).toContainText("Uploaded");
    await page.locator(".rme-picker .rme-picker-search").fill("https://example.com/docs");
    await expect(page.locator(".rme-picker .jx-result.focused")).toContainText("Link to");
    await page.keyboard.press("Enter");
    await expect.poll(() => source(page)).toBe("Uploaded {F1}. See the [[ https://example.com/docs | docs ]] here.");
  });

  test("a search with its own results takes the first of them on a quick Enter, and tells when it finds nothing", async ({
    page,
  }) => {
    await openNewWikiPage(page, "Quick icon");
    await editor(page).click();
    await page.keyboard.type("/icon");
    await page.keyboard.press("Enter");
    await page.locator(".rme-picker .rme-picker-search").fill("zzzz yyyy");
    await expect(page.locator(".rme-picker .rme-popup-note")).toHaveText("Nothing found.");
    // Faster than the search.
    await page.locator(".rme-picker .rme-picker-search").fill("camera");
    await page.keyboard.press("Enter");
    await expect.poll(() => source(page)).toBe("{icon camera}");
  });

  test("in a table cell: Alt+Shift+arrows move the column, the link button and Option+Space work", async ({ page }) => {
    await startWith(page, "| a | b |\n| --- | --- |\n| one | two |");
    await page.locator(".rme-table-editor td", { hasText: "one" }).click();
    await page.keyboard.press("Alt+Shift+ArrowRight");
    await expect.poll(() => source(page)).toBe("| b   | a   |\n| --- | --- |\n| two | one |");
    // The link button of the toolbar acts on the cell.
    await page.keyboard.press("Control+a");
    await page.locator(".remarkup-assist-button:has(.fa-link)").click();
    await page.locator(".rme-picker .rme-picker-search").fill("T1");
    await expect(page.locator(".rme-picker .jx-result").first()).toContainText("Calibrate the detector");
    await page.keyboard.press("Enter");
    await expect.poll(() => source(page)).toMatch(/\| two \| \[\[ \S*T1 \| one \]\] \|$/);
    // A no-break space (Option+Space on a Mac) does not reset the cell when the table renders.
    await page.keyboard.press("Home");
    // The table renders anew once typing pauses.
    const rendered = page.waitForResponse((response) => /x(%20|\+)y/.test(response.request().postData() ?? ""));
    await page.keyboard.insertText("x\u00a0y ");
    await rendered;
    await settled(page);
    await page.keyboard.type("z");
    await expect.poll(() => source(page)).toMatch(/\| two \| x y z\[\[/);
  });

  test("a link left open in a table cell is kept closed", async ({ page }) => {
    await startWith(page, "| a | b |\n| one | two ]] |");
    await page.locator(".rme-table-editor td", { hasText: "one" }).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" [[");
    await page.keyboard.press("Delete");
    await page.keyboard.press("Delete");
    // Its "]]" stays: without it, the link would take in the next cell.
    await expect.poll(() => source(page)).toBe("| a | b |\n| one [[]] | two ]] |");
  });

  test("files pasted through the editor stay attached when Phorge's upload button rewrites the form's metadata", async ({
    page,
  }) => {
    await openNewWikiPage(page, "Attached");
    await editor(page).click();
    await editor(page).evaluate((node) => {
      const data = new DataTransfer();
      data.items.add(new File(["hello"], "note.txt", { type: "text/plain" }));
      const box = node.getBoundingClientRect();
      node.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          clientX: box.left + 20,
          clientY: box.top + 5,
          dataTransfer: data,
        }),
      );
    });
    await expect(textarea(page)).toHaveValue(/^\{F\d+\}$/);
    const metadata = page.locator('input[name="content_metadata"]');
    const ours = JSON.parse(await metadata.inputValue()).attachedFilePHIDs[0];
    // Phorge's upload writes its own list.
    await metadata.evaluate((input: HTMLInputElement) => (input.value = '{"attachedFilePHIDs":["PHID-FILE-theirs"]}'));
    await page.evaluate(() => {
      const form = document.querySelector<HTMLTextAreaElement>("textarea.remarkup-assist-textarea")!.form!;
      form.addEventListener("submit", (event) => event.preventDefault(), { once: true });
      form.requestSubmit();
    });
    expect(JSON.parse(await metadata.inputValue()).attachedFilePHIDs.sort()).toEqual(["PHID-FILE-theirs", ours].sort());
  });

  test("an upload does not take the place of a placeholder left in the text", async ({ page }) => {
    await startWith(page, "Old {Uploading note.txt 1…} text.");
    await editor(page).evaluate((node) => {
      const data = new DataTransfer();
      data.items.add(new File(["hello"], "note.txt", { type: "text/plain" }));
      const box = node.getBoundingClientRect();
      node.dispatchEvent(
        new DragEvent("drop", {
          bubbles: true,
          cancelable: true,
          clientX: box.right - 5,
          clientY: box.bottom - 5,
          dataTransfer: data,
        }),
      );
    });
    await expect.poll(() => source(page)).toMatch(/^Old \{Uploading note\.txt 1…\} text\.\s*\{F\d+\}$/);
  });

  test("screen readers learn about the insert menu and its focused item", async ({ page }) => {
    await openNewWikiPage(page, "Aria");
    await editor(page).click();
    await page.keyboard.type("/");
    const list = page.locator(".rme-autocomplete .phuix-autocomplete-list");
    await expect(editor(page)).toHaveAttribute("aria-controls", (await list.getAttribute("id"))!);
    await page.keyboard.press("ArrowDown");
    const focused = await page.locator(".rme-autocomplete .jx-result.focused").getAttribute("id");
    await expect(editor(page)).toHaveAttribute("aria-activedescendant", focused!);
    await page.keyboard.press("Escape");
    await expect(editor(page)).not.toHaveAttribute("aria-controls", /./);
  });

  test("shortcuts work on a German keyboard: Ctrl+Shift+7 types a /, Ctrl+Shift+3 a §", async ({ page }) => {
    await openNewWikiPage(page, "German keys");
    await editor(page).click();
    await page.keyboard.type("Title");
    // Playwright types with a US layout; these are the events of a German one.
    const press = (key: string, digit: number) =>
      editor(page).evaluate(
        (content, [key, digit]) => {
          const event = new KeyboardEvent("keydown", {
            key: key as string,
            code: `Digit${digit}`,
            ctrlKey: true,
            shiftKey: true,
            bubbles: true,
            cancelable: true,
          });
          Object.defineProperty(event, "keyCode", { value: 48 + (digit as number) });
          content.dispatchEvent(event);
        },
        [key, digit],
      );
    await press("§", 3);
    await expect.poll(() => source(page)).toBe("=== Title");
    await page.keyboard.press("End");
    await page.keyboard.type("\n\nitem");
    await press("/", 7);
    await expect.poll(() => source(page)).toBe("=== Title\n\n  # item");
    await expect(page.locator(".rme-shortcuts")).toHaveCount(0);
  });
});

test.describe("uploads", () => {
  const panel = (page: Page) => page.locator(".rme-upload-status");

  /** Drops a file of a size on the editor, below its text. */
  async function drop(page: Page, name: string, size = 5): Promise<void> {
    await editor(page).evaluate(
      (node, [name, size]) => {
        const data = new DataTransfer();
        data.items.add(new File([new Uint8Array(size as number).fill(65)], name as string));
        const box = node.getBoundingClientRect();
        node.dispatchEvent(
          new DragEvent("drop", {
            bubbles: true,
            cancelable: true,
            clientX: box.right - 5,
            clientY: box.bottom - 5,
            dataTransfer: data,
          }),
        );
      },
      [name, size] as const,
    );
  }

  /** Holds the requests of a pattern until the returned function is called. */
  async function hold(page: Page, url: RegExp, from = 1): Promise<() => void> {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let seen = 0;
    await page.route(url, async (route) => {
      if (++seen >= from) {
        await held;
      }
      await route.continue();
    });
    return release;
  }

  /** Drags files over an element of the editor and drops them there; whether the drag was taken. */
  async function dragFiles(
    target: Locator,
    files: { name: string; type: string; base64: string }[],
    at: "start" | "end" = "start",
  ): Promise<boolean> {
    return target.evaluate(
      (node, [files, at]) => {
        const data = new DataTransfer();
        for (const { name, type, base64 } of files) {
          data.items.add(new File([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], name, { type }));
        }
        const box = node.getBoundingClientRect();
        const init = {
          bubbles: true,
          cancelable: true,
          clientX: at === "start" ? box.left + 3 : box.right - 3,
          clientY: at === "start" ? box.top + 3 : box.bottom - 3,
          dataTransfer: data,
        };
        // Browsers drop only where the drag over it was taken.
        const over = new DragEvent("dragover", init);
        node.dispatchEvent(over);
        if (over.defaultPrevented) {
          node.dispatchEvent(new DragEvent("drop", init));
        }
        return over.defaultPrevented;
      },
      [files, at] as const,
    );
  }
  const png = (name: string) => ({ name, type: "image/png", base64: PNG_BYTES.toString("base64") });

  test("files dragged on the text or on what shows rendered are dropped there", async ({ page }) => {
    await openNewWikiPage(page, "Drop targets");
    await editor(page).click();
    await page.keyboard.type("First\n\n{F1}\n\nLast");
    await page.keyboard.press("Control+Home");
    const image = page.locator(".rme-image-preview img").first();
    await expect(image).toBeVisible();
    // On the image, which CodeMirror leaves to the browser (it would open the file).
    expect(await dragFiles(image, [png("on-image.png")])).toBe(true);
    await expect.poll(() => source(page)).toMatch(/^First\n\n\{F\d+\}\n\n\{F1\}\n\nLast$/);
    // On the text.
    expect(await dragFiles(page.locator(".cm-line", { hasText: "Last" }), [png("on-text.png")], "end")).toBe(true);
    await expect.poll(() => source(page)).toMatch(/\n\nLast \{F\d+\}$/);
  });

  test("a file dropped next to words is set apart from them, so Phorge embeds it", async ({ page }) => {
    await openNewWikiPage(page, "Drop apart");
    await editor(page).click();
    await page.keyboard.type("Before after");
    // At the end of "after": "after{F1}" would be "after{", a reference and "}".
    await dragFiles(page.locator(".cm-line", { hasText: "Before" }), [png("apart.png")], "end");
    await expect.poll(() => source(page)).toMatch(/^Before after \{F\d+\}$/);
    // The reference hides behind its image.
    await page.keyboard.press("Control+Home");
    await expect(page.locator(".rme-image-preview img")).toBeVisible();
  });

  test("a file dragged by the browser into a word goes after the word", async ({ page, browserName }, testInfo) => {
    test.skip(browserName !== "chromium", "Only Chromium's protocol drags files like a user");
    await openNewWikiPage(page, "Real drag");
    await editor(page).click();
    await page.keyboard.type("Some text here");
    const box = (await page.locator(".cm-line", { hasText: "Some text" }).boundingBox())!;
    const file = testInfo.outputPath("dragged.txt");
    writeFileSync(file, "hello");
    const cdp = await page.context().newCDPSession(page);
    // Into "Som|e".
    const at = { x: box.x + 30, y: box.y + box.height / 2, data: { items: [], files: [file], dragOperationsMask: 1 } };
    for (const type of ["dragEnter", "dragOver", "drop"] as const) {
      await cdp.send("Input.dispatchDragEvent", { type, ...at });
    }
    await expect.poll(() => source(page)).toMatch(/^Some \{F\d+\} text here$/);
  });

  test("an embedded file that is not an image shows its card, its reference hidden", async ({ page }) => {
    await openNewWikiPage(page, "Text file");
    await editor(page).click();
    await page.keyboard.type("Notes:\n\n");
    const name = `notes-${Date.now()}.txt`;
    await dragFiles(editor(page), [{ name, type: "text/plain", base64: btoa("hello") }], "end");
    await expect.poll(() => source(page)).toMatch(/^Notes:\n\n\{F\d+\}$/);
    await page.keyboard.press("Control+Home");
    const card = page.locator(".rme-image-preview .phabricator-remarkup-embed-layout-link");
    await expect(card).toContainText(name);
    await expect(page.locator(".rme-editor .cm-line", { hasText: /\{F\d+\}/ })).toHaveCount(0);
  });

  test("file cards on lines of their own are one below the other, on one line beside each other, also while edited", async ({
    page,
  }) => {
    await openNewWikiPage(page, "Cards");
    const upload = async (name: string) => {
      const phid = await conduit(page, "file.upload", { name, data_base64: btoa(name) });
      return `F${(await conduit(page, "file.info", { phid })).id}`;
    };
    const [a, b] = [await upload(`a-${Date.now()}.txt`), await upload(`b-${Date.now()}.txt`)];
    await editor(page).click();
    await page.keyboard.insertText(`{${a}}\n{${b}}\n\nBetween.\n\n{${a}} {${b}}`);
    await blur(page);
    await settled(page);
    const cards = page.locator(".rme-editor .phabricator-remarkup-embed-layout-link");
    await expect(cards).toHaveCount(4);
    // The second card below the first, or beside it, in the rendered text.
    const layout = async () => {
      const boxes = await cards.evaluateAll((els) => els.map((el) => el.getBoundingClientRect()));
      return [
        boxes[1]!.top >= boxes[0]!.bottom && boxes[1]!.left === boxes[0]!.left,
        boxes[3]!.top < boxes[2]!.bottom && boxes[3]!.left >= boxes[2]!.right,
      ];
    };
    expect(await layout()).toEqual([true, true]);
    // The same while their blocks are edited.
    await editor(page).click();
    // A reference shows on the line of the cursor.
    const reference = page.locator(".cm-line", { hasText: /\{F\d+\}/ });
    await page.keyboard.press("Control+Home");
    await expect(reference).toHaveCount(1);
    expect(await layout()).toEqual([true, true]);
    await page.keyboard.press("Control+End");
    await expect(reference).toContainText(`{${b}}`);
    expect(await layout()).toEqual([true, true]); // A click on a card (on its download link too) edits its embed.
    await blur(page);
    await cards.nth(0).locator("a", { hasText: "Download" }).click();
    await expect.poll(() => textarea(page).evaluate((t: HTMLTextAreaElement) => t.selectionStart)).toBe(a.length + 2);
    expect(page.url()).toMatch(/\/phriction\/edit\//);
  });

  test("a file over 4 MB is uploaded in chunks, with its progress shown", async ({ page }) => {
    await openNewWikiPage(page, "Chunks");
    await editor(page).click();
    const chunks: string[] = [];
    page.on("request", (request) => {
      if (/uploadchunk=1/.test(request.url())) {
        chunks.push(request.url());
      }
    });
    const release = await hold(page, /\/file\/dropupload\/.*uploadchunk=1/, 2);
    // Three chunks of 4 MB; the second waits.
    await drop(page, "big.bin", 9 * 1024 * 1024);
    await expect(panel(page)).toHaveText("Uploading big.bin (33%)…");
    release();
    await expect.poll(() => source(page)).toMatch(/^\{F\d+\}$/);
    expect(chunks).toHaveLength(3);
    await expect(panel(page)).toBeHidden();
    const id = Number(/\d+/.exec(await source(page))![0]);
    const found = (await conduit(page, "file.search", { constraints: { ids: [id] } })) as {
      data: { fields: { size: number } }[];
    };
    expect(found.data[0].fields.size).toBe(9 * 1024 * 1024);
  });

  test("a comment submitted with Ctrl+Enter while a file uploads is sent when the upload is done", async ({ page }) => {
    await createTask(page, "Upload, then submit");
    await addPhlair(page);
    await editor(page).click();
    await page.keyboard.type("See the note.");
    const release = await hold(page, /\/file\/dropupload\//);
    await drop(page, "note.txt");
    await page.keyboard.press("Control+Enter");
    await expect(panel(page)).toContainText("Uploading note.txt… The form is sent when done.");
    await expect(textarea(page)).toHaveValue(/\{Uploading note\.txt \d+…\}/);
    release();
    // Phorge posts the comment and empties the form.
    await expect(textarea(page)).toHaveValue("");
    await page.reload();
    await expect(page.locator(".phui-timeline-view .phabricator-remarkup", { hasText: "See the note." })).toContainText(
      "note.txt",
    );
  });

  test("a page saved with its button while a file uploads is saved when the upload is done; or not, if cancelled", async ({
    page,
  }) => {
    await openNewWikiPage(page, "Upload, then save");
    await editor(page).click();
    await page.keyboard.type("Notes.");
    let release = await hold(page, /\/file\/dropupload\//);
    await drop(page, "note.txt");
    const save = page.getByRole("button", { name: "Create Document" });
    // Cancelled: the page stays.
    await save.click();
    await panel(page).getByRole("link", { name: "Don't send" }).click();
    await expect(panel(page)).not.toContainText("The form is sent");
    release();
    await expect.poll(() => source(page)).toMatch(/^Notes\.\s*\{F\d+\}$/);
    await expect(page).toHaveURL(/\/phriction\/edit\//);
    // Saved once the upload is done.
    await page.unroute(/\/file\/dropupload\//);
    release = await hold(page, /\/file\/dropupload\//);
    await drop(page, "more.txt");
    await save.click();
    await expect(panel(page)).toContainText("The form is sent when done.");
    await expect(page).toHaveURL(/\/phriction\/edit\//);
    release();
    await expect(page).not.toHaveURL(/\/phriction\/edit\//);
    await expect(page.locator(".phabricator-remarkup")).toContainText("more.txt");
  });

  test("a failed upload is told in the panel, not in an alert, and the form waiting for it is not sent", async ({
    page,
  }) => {
    await openNewWikiPage(page, "Failed upload");
    await editor(page).click();
    page.on("dialog", (dialog) => {
      throw new Error(`Unexpected dialog: ${dialog.message()}`);
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route(/\/file\/dropupload\//, async (route) => {
      await held;
      await route.fulfill({ status: 500, body: "Broken" });
    });
    await drop(page, "note.txt");
    await page.keyboard.press("Control+Enter");
    await expect(panel(page)).toContainText("The form is sent when done.");
    release();
    await expect(panel(page)).toHaveText(
      /^Uploading note\.txt failed \(Phorge: 500 for \/file\/dropupload\/\)\. Dismiss$/,
    );
    await expect.poll(() => source(page)).toBe("");
    await panel(page).getByRole("link", { name: "Dismiss" }).click();
    await expect(panel(page)).toBeHidden();
    await expect(page).toHaveURL(/\/phriction\/edit\//);
  });
});

test.describe("search", () => {
  test("Ctrl+F finds in all of the text, also far below and in rendered blocks", async ({ page }) => {
    const filler = Array.from({ length: 300 }, (_, i) => `Line ${i} of the filler text.`).join("\n\n");
    await startWith(page, `${filler}\n\nThe needle is here.\n\n| Name | Value\n| haystack | 1`);
    await page.locator(".cm-line").first().click();
    await page.keyboard.press("Control+Home");
    // Not drawn yet: the browser's find would not see it.
    await expect(page.locator(".cm-line", { hasText: "The needle is here." })).toHaveCount(0);
    await page.keyboard.press("Control+f");
    const field = page.locator(".rme-panels .cm-search input[name=search]");
    await expect(field).toBeFocused();
    // Typed: the panel takes the query on keyup.
    await page.keyboard.type("needle");
    await page.keyboard.press("Enter");
    const found = page.locator(".cm-searchMatch-selected");
    await expect(found).toHaveText("needle");
    await expect(found).toBeInViewport();
    // In a table, which shows its source for it.
    await page.keyboard.press("Control+a");
    await page.keyboard.type("haystack");
    await page.keyboard.press("Enter");
    await expect(found).toHaveText("haystack");
    await expect(found).toBeInViewport();
    await page.screenshot({ path: "test-results/search-panel.png" });
    await page.keyboard.press("Escape");
    await expect(field).toHaveCount(0);
    await expect(editor(page)).toBeFocused();
    // From a table cell too.
    await blur(page);
    await page.locator(".rme-table-editor td", { hasText: "haystack" }).click();
    await page.keyboard.press("Control+f");
    await expect(field).toBeFocused();
  });
});

test.describe("menus by keyboard", () => {
  test("the image menu opens with Shift+F10 on an image's reference, on its size, and the arrow keys choose", async ({
    page,
  }) => {
    await openNewWikiPage(page, "Image menu by keys");
    await editor(page).click();
    await page.keyboard.insertText("Before.\n\n{F1}");
    await page.keyboard.press("ArrowLeft");
    await page.keyboard.press("Shift+F10");
    const menu = page.locator(".rme-image-menu");
    await expect(menu.getByRole("menuitemradio", { name: "Thumbnail" })).toBeFocused();
    await expect(menu.getByRole("menuitemradio", { name: "Thumbnail" })).toHaveAttribute("aria-checked", "true");
    // The text being edited stays as it is while the menu has the focus.
    await expect(page.locator(".cm-line", { hasText: "{F1}" })).toBeVisible();
    await page.keyboard.press("ArrowDown");
    await expect(menu.getByRole("menuitemradio", { name: "Full size" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(menu).toHaveCount(0);
    await expect.poll(() => source(page)).toBe("Before.\n\n{F1, size=full}");
    await expect(editor(page)).toBeFocused();
    // Escape closes it, the focus back in the text; End and Home go to the last and first item.
    await page.keyboard.press("Shift+F10");
    // On the size chosen now.
    await expect(menu.getByRole("menuitemradio", { name: "Full size" })).toBeFocused();
    await page.keyboard.press("End");
    await expect(menu.getByRole("menuitem", { name: "Remove image" })).toBeFocused();
    await page.keyboard.press("Home");
    await expect(menu.getByRole("menuitemradio", { name: "Thumbnail" })).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(menu.getByRole("menuitem", { name: "Remove image" })).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(editor(page)).toBeFocused();
  });

  test("the table button's size grid goes by the arrow keys", async ({ page }) => {
    await openNewWikiPage(page, "Table by keys");
    await editor(page).click();
    await page.locator(".remarkup-assist-button:has(.fa-table)").click();
    const picker = page.locator(".rme-table-picker");
    await expect(picker).toContainText("3 × 2");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowDown");
    await expect(picker).toContainText("4 × 3");
    await page.keyboard.press("Enter");
    await expect.poll(() => source(page)).toMatch(/^\| Column 1 \| Column 2 \| Column 3 \| Column 4 \|\n(.*\n){4}\n$/);
  });
});

test.describe("discoverability", () => {
  test("the empty editor says how to insert and where the shortcuts are", async ({ page }) => {
    await openNewWikiPage(page, "Placeholder");
    await expect(page.locator(".cm-placeholder")).toHaveText(/^.+[.…] Type \/ to insert, F1 for shortcuts\.$/);
  });

  test("a ⋯ button on the image under the mouse opens its menu", async ({ page }) => {
    await startWith(page, "Before.\n\n{F1}\n\nAfter.");
    const image = page.locator(".rme-editor a[data-rme-file] img").first();
    const more = page.locator(".rme-image-more");
    await expect(more).toBeHidden();
    await image.hover();
    await expect(more).toBeVisible();
    // In the image's top right corner.
    const box = (await image.boundingBox())!;
    const button = (await more.boundingBox())!;
    expect(button.x).toBeGreaterThan(box.x + box.width / 2);
    expect(button.x + button.width).toBeLessThanOrEqual(box.x + box.width);
    expect(button.y).toBeGreaterThanOrEqual(box.y);
    expect(button.y + button.height).toBeLessThan(box.y + box.height / 2);
    await more.click();
    await page.locator(".rme-image-menu").getByRole("menuitemradio", { name: "Full size" }).click();
    await expect.poll(() => source(page)).toBe("Before.\n\n{F1, size=full}\n\nAfter.");
    // Gone when the mouse leaves the image.
    await page.locator(".cm-line", { hasText: "Before." }).hover();
    await expect(more).toBeHidden();
  });
});

test.describe("menus and scrolling", () => {
  test("a menu stays at its text when the box around the editor scrolls, hidden while the text is out of view", async ({
    page,
  }) => {
    await openNewWikiPage(page, "Scrolling menu");
    // Like the editor in a dialog, which scrolls inside.
    await page.addStyleTag({ content: ".rme-editor .cm-scroller { max-height: 200px; overflow: auto !important; }" });
    await editor(page).click();
    await page.keyboard.insertText(Array.from({ length: 60 }, (_, i) => `Line ${i}`).join("\n\n"));
    await page.keyboard.press("Control+Home");
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("ArrowDown");
    }
    await page.keyboard.press("End");
    await page.keyboard.type(" /");
    const menu = page.locator(".rme-autocomplete");
    await expect(menu).toBeVisible();
    const before = (await menu.boundingBox())!.y;
    const scroller = page.locator(".rme-editor .cm-scroller");
    // The text moves up, and the menu with it.
    await scroller.evaluate((box) => (box.scrollTop += 40));
    await expect.poll(async () => Math.round((await menu.boundingBox())!.y - before)).toBe(-40);
    await scroller.evaluate((box) => (box.scrollTop += 400));
    await expect(menu).toBeHidden();
    await scroller.evaluate((box) => (box.scrollTop = 0));
    await expect(menu).toBeVisible();
  });
});

test.describe("long texts", () => {
  test("rendered blocks not drawn yet are estimated at about their height, so scrolling does not jump", async ({
    page,
  }) => {
    const code = Array.from({ length: 8 }, (_, i) => `line ${i}`).join("\n");
    const table = ["| A | B", "| - | -", ...Array.from({ length: 6 }, (_, i) => `| ${i} | x`)].join("\n");
    const sections = Array.from({ length: 25 }, (_, i) => `Section ${i}.\n\n\`\`\`\n${code}\n\`\`\`\n\n${table}`);
    await startWith(page, sections.join("\n\n"));
    const height = () =>
      page.locator(".rme-editor .cm-content").evaluate((content) => (content as HTMLElement).offsetHeight);
    // At the top, the middle of the text not drawn yet.
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const estimated = await height();
    // Draw it all, from top to bottom.
    await page.mouse.move(400, 400);
    for (let y = 0; y < 30; y++) {
      await page.mouse.wheel(0, 400);
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
    }
    const drawn = await height();
    expect(Math.abs(drawn - estimated) / drawn).toBeLessThan(0.15);
  });
});

test.describe("inline markup as Phorge finds it", () => {
  test("formatting across lines, emoji, and references only where Phorge has them", async ({ page }) => {
    await startWith(
      page,
      "Some **bold\nacross lines** and :smile: but A1 and x@alice stay text.\n\n> A //quoted// T1\n\n- an __item__\n  with ~~more~~\n\n| **cell** | T1 |\n| - | - |\n| x | y |",
    );
    // Without the focus, the markers are hidden and the text is styled, also across lines.
    const bold = page.locator(".cm-line .rme-bold");
    await expect(bold).toHaveText(["bold", "across lines"]);
    await expect(page.locator(".cm-line", { hasText: "across lines" })).toContainText("😄");
    await expect(page.locator(".cm-line", { hasText: "across lines" })).not.toContainText(":smile:");
    await expect(page.locator(".cm-line", { hasText: "stay text" })).toContainText("A1 and x@alice stay text.");
    await expect(page.locator(".cm-line .rme-italic")).toHaveText("quoted");
    await expect(page.locator(".cm-line", { hasText: "quoted" }).locator(".phui-tag-view, a")).toContainText("T1");
    await expect(page.locator(".cm-line .rme-underline")).toHaveText("item");
    await expect(page.locator(".cm-line .rme-del")).toHaveText("more");
    await expect(page.locator(".rme-table-editor strong")).toHaveText("cell");
  });
});

test.describe("insert menu in cells", () => {
  test("Enter right after / in a table cell inserts the focused item, no new row", async ({ page }) => {
    await startWith(page, "| a | b |\n| 1 | 2 |");
    await page.locator(".rme-table-editor td", { hasText: "1" }).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" /");
    // The first item of a cell's menu: a link, whose search opens.
    await expect(page.locator(".rme-autocomplete .jx-result.focused")).toHaveText(/^Link/);
    await page.keyboard.press("Enter");
    await expect(page.locator(".rme-picker .rme-picker-search")).toBeFocused();
    await expect(page.locator(".rme-table-editor tr")).toHaveCount(2);
    await expect.poll(() => source(page)).toBe("| a | b |\n| 1  | 2 |");
  });
});

test.describe("long menus", () => {
  /** The index of the focused item of a menu, and whether it is in view in its list. */
  const focused = (page: Page) =>
    page.locator(".rme-autocomplete").evaluate((menu) => {
      const items = Array.from(menu.querySelectorAll(".jx-result"));
      const item = menu.querySelector(".jx-result.focused")!;
      const list = menu.querySelector(".phuix-autocomplete-list")!.getBoundingClientRect();
      const box = item.getBoundingClientRect();
      return {
        index: items.indexOf(item),
        count: items.length,
        inView: box.top >= list.top && box.bottom <= list.bottom + 1,
      };
    });

  test("Page Down and Up skip a page of the insert menu, to its last and first item at most", async ({ page }) => {
    await openNewWikiPage(page, "Paging");
    await editor(page).click();
    await page.keyboard.type("/");
    await page.keyboard.press("PageDown");
    const paged = await focused(page);
    expect(paged.index).toBeGreaterThan(3);
    expect(paged.inView).toBe(true);
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press("PageDown");
    }
    await expect.poll(async () => (await focused(page)).index).toBe(paged.count - 1);
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press("PageUp");
    }
    await expect.poll(async () => (await focused(page)).index).toBe(0);
    // The menu is still open, the text unchanged.
    await expect.poll(() => source(page)).toBe("/");
  });

  test("Page Down and Up skip a page of a search's results, e.g. of the icons", async ({ page }) => {
    await openNewWikiPage(page, "Paging icons");
    await editor(page).click();
    await page.keyboard.type("/icon");
    await page.keyboard.press("Enter");
    await expect(page.locator(".rme-picker .rme-picker-search")).toBeFocused();
    await expect(page.locator(".rme-autocomplete .jx-result").nth(20)).toBeAttached();
    await page.keyboard.press("PageDown");
    const paged = await focused(page);
    expect(paged.index).toBeGreaterThan(3);
    expect(paged.inView).toBe(true);
    await page.keyboard.press("PageDown");
    await expect.poll(async () => (await focused(page)).index).toBeGreaterThan(paged.index);
    await page.keyboard.press("PageUp");
    await page.keyboard.press("PageUp");
    await expect.poll(async () => (await focused(page)).index).toBe(0);
  });

  test("Page Down and Up move through the autocomplete's results too", async ({ page }) => {
    await openNewWikiPage(page, "Paging emoji");
    await editor(page).click();
    await page.keyboard.type("Hi :s");
    await expect(page.locator(".rme-autocomplete .jx-result").nth(4)).toBeAttached();
    await page.keyboard.press("PageDown");
    await expect.poll(async () => (await focused(page)).index).toBeGreaterThan(1);
    await page.keyboard.press("PageUp");
    await expect.poll(async () => (await focused(page)).index).toBe(0);
    await expect.poll(() => source(page)).toBe("Hi :s");
  });
});

test.describe("the link dialog", () => {
  const picker = (page: Page) => page.locator(".rme-picker");
  const text = (page: Page) => picker(page).locator(".rme-picker-text");
  const link = (page: Page) => picker(page).locator(".rme-picker-search");

  /** Opens the dialog of the link in the text by its bubble's Change. */
  async function change(page: Page, linkText: string): Promise<void> {
    // A click puts the cursor after the rendered link; one step back is in it, with its bubble.
    await page.locator(".cm-line a", { hasText: linkText }).first().click();
    await page.keyboard.press("ArrowLeft");
    await page.locator(".rme-link-bubble").getByRole("link", { name: "Change" }).click();
    await expect(link(page)).toBeFocused();
  }

  test("Change edits the text and the target of a link; only the text, and the target stays", async ({ page }) => {
    await startWith(page, "See [[ https://example.com/a | the site ]] now.");
    await change(page, "the site");
    await expect(text(page)).toHaveValue("the site");
    await expect(link(page)).toHaveValue("https://example.com/a");
    // Tab goes to the text, and back.
    await page.keyboard.press("Tab");
    await expect(text(page)).toBeFocused();
    await page.keyboard.press("Control+a");
    await page.keyboard.type("the page");
    await page.keyboard.press("Tab");
    await expect(link(page)).toBeFocused();
    // The target's search results do not replace it.
    await expect(picker(page).locator(".jx-result").first()).toBeAttached();
    await page.keyboard.press("Enter");
    await expect.poll(() => source(page)).toBe("See [[ https://example.com/a | the page ]] now.");
    // Also a target its search finds as something else ("T1" as the task's "/T1").
    await startWith(page, "See [[ T1 | the task ]] now.");
    await change(page, "the task");
    await expect(picker(page).locator(".jx-result").first()).toContainText("Calibrate the detector");
    await text(page).fill("it");
    await link(page).press("Enter");
    await expect.poll(() => source(page)).toBe("See [[ T1 | it ]] now.");
  });

  test("an empty text leaves the link alone, an empty link the text alone, both empty nothing", async ({ page }) => {
    await startWith(
      page,
      "A [[ https://example.com/a | one ]] B [[ https://example.com/b | two ]] C [[ /T1 | three ]] D",
    );
    await change(page, "one");
    await text(page).fill("");
    await link(page).press("Enter");
    await expect
      .poll(() => source(page))
      .toBe("A https://example.com/a B [[ https://example.com/b | two ]] C [[ /T1 | three ]] D");
    await blur(page);
    await change(page, "two");
    await link(page).fill("");
    await link(page).press("Enter");
    await expect.poll(() => source(page)).toBe("A https://example.com/a B two C [[ /T1 | three ]] D");
    await blur(page);
    await change(page, "three");
    await text(page).fill("");
    await link(page).fill("");
    await link(page).press("Enter");
    await expect.poll(() => source(page)).toBe("A https://example.com/a B two C  D");
  });

  test("Ctrl+K on selected text: the text in the dialog and highlighted in the editor while it is open", async ({
    page,
  }) => {
    await openNewWikiPage(page, "Link dialog");
    await editor(page).click();
    await page.keyboard.type("Read the manual first.");
    await page.keyboard.press("ArrowLeft");
    for (let i = 0; i < "manual first.".length - 7; i++) {
      await page.keyboard.press("ArrowLeft");
    }
    for (let i = 0; i < "manual".length; i++) {
      await page.keyboard.press("Shift+ArrowLeft");
    }
    await page.keyboard.press("Control+k");
    await expect(text(page)).toHaveValue("manual");
    await expect(link(page)).toBeFocused();
    await expect(page.locator(".rme-editor .rme-picking")).toHaveText("manual");
    await link(page).fill("https://example.com/manual");
    await expect(picker(page).locator(".jx-result.focused")).toContainText("Link to");
    await page.keyboard.press("Enter");
    await expect.poll(() => source(page)).toBe("Read the [[ https://example.com/manual | manual ]] first.");
    await expect(page.locator(".rme-editor .rme-picking")).toHaveCount(0);
    // Escape: nothing changes, the highlight goes.
    await page.keyboard.press("Control+k");
    await page.keyboard.press("Escape");
    await expect(picker(page)).toHaveCount(0);
    await expect(page.locator(".rme-editor .rme-picking")).toHaveCount(0);
  });

  test("a reference: without a text the reference, with one a link to it; Ctrl+K changes it", async ({ page }) => {
    await openNewWikiPage(page, "Reference dialog");
    await editor(page).click();
    await page.keyboard.press("Control+Shift+k");
    await expect(text(page)).toHaveValue("");
    await link(page).fill("T1");
    await expect(picker(page).locator(".jx-result.focused")).toContainText("Calibrate the detector");
    await page.keyboard.press("Enter");
    await expect.poll(() => source(page)).toBe("T1");
    // Ctrl+K on a reference changes it too.
    await page.keyboard.press("Control+k");
    // The reference to change, by its reference.
    await expect(link(page)).toHaveValue("T1");
    await text(page).fill("the detector");
    await link(page).press("Enter");
    await expect.poll(() => source(page)).toBe("[[ /T1 | the detector ]]");
  });
});

test.describe("the comment form on a phone", () => {
  test.use({ viewport: { width: 390, height: 800 } });

  test("an action can be removed by its X, pinned or not", async ({ page }) => {
    await createTask(page, "Remove an action");
    await addPhlair(page);
    const select = page.locator(".phui-comment-action-control select");
    for (const pinned of [false, true]) {
      if (pinned) {
        await page.locator(".remarkup-assist-button:has(.fa-thumb-tack)").click();
        await expect(page.locator(".phui-comment-form-view")).toHaveClass(/remarkup-assist-pinned/);
      }
      await select.selectOption({ label: "Change Priority" });
      const action = page.locator(".phui-comment-action");
      await expect(action).toHaveCount(1);
      // The icon: the link around it has no box of its own (the icon floats).
      const remove = action.locator(".aphront-form-error .fa-times-circle");
      await expect(remove).toBeVisible();
      // At the right of the line of the action's name.
      const label = (await action.locator(".aphront-form-label").boundingBox())!;
      const box = (await remove.boundingBox())!;
      expect(box.y).toBeLessThan(label.y + label.height);
      expect(box.x).toBeGreaterThan(label.x + label.width / 2);
      await page.screenshot({ path: `test-results/phone-action-${pinned}.png` });
      await remove.click();
      await expect(action).toHaveCount(0);
    }
  });

  test("pinned, the form has a handle that sets its height; its text scrolls in it, the submit button sits next to the actions", async ({
    page,
  }) => {
    await createTask(page, "Pinned form");
    await addPhlair(page);
    const form = page.locator(".phui-comment-form-view");
    const submit = form.locator("button[data-sigil~='submit-transactions']");
    await page.locator(".remarkup-assist-button:has(.fa-thumb-tack)").click();
    await expect(form).toHaveClass(/remarkup-assist-pinned/);
    const handle = page.locator(".rme-pinned-resize");
    await expect(handle).toBeVisible();
    // A long text: it scrolls in the editor, not the form with it (one scrollbar).
    await editor(page).click();
    await page.keyboard.insertText(Array.from({ length: 60 }, (_, i) => `Line ${i}`).join("\n\n"));
    const scrolls = (selector: string) =>
      page
        .locator(selector)
        .first()
        .evaluate((el) => el.scrollHeight > el.clientHeight + 1);
    await expect.poll(() => scrolls(".remarkup-assist-pinned .cm-scroller")).toBe(true);
    // Not by a pixel either way, and no wider than the window.
    const form_ = await form.evaluate((el) => ({
      dx: el.scrollWidth - el.clientWidth,
      dy: el.scrollHeight - el.clientHeight,
      width: el.getBoundingClientRect().width,
    }));
    expect(form_).toEqual({ dx: 0, dy: 0, width: 390 });
    // The handle on the middle of the top border, above none of the form's controls.
    const top = (await form.boundingBox())!.y;
    const onBorder = (await handle.boundingBox())!;
    expect(Math.abs(onBorder.y + onBorder.height / 2 - top)).toBeLessThan(1.5);
    expect(Math.abs(onBorder.x + onBorder.width / 2 - 195)).toBeLessThan(1.5);
    expect(onBorder.y + onBorder.height).toBeLessThanOrEqual(
      (await form.locator(".phui-comment-action-bar select").boundingBox())!.y,
    );
    await expect(submit).toBeInViewport();
    // In the row of "Add Action...", in its middle; on a phone as an icon, its label as its tooltip.
    const bar = form.locator(".phui-comment-action-bar");
    await expect(bar.locator("button[data-sigil~='submit-transactions']")).toBeVisible();
    const select = (await bar.locator("select").boundingBox())!;
    const button = (await submit.boundingBox())!;
    expect(Math.abs(button.y + button.height / 2 - (select.y + select.height / 2))).toBeLessThan(2);
    expect(button.width).toBeLessThan(60);
    // As high as the field next to it.
    expect(Math.abs(button.height - select.height)).toBeLessThan(3);
    await expect(submit).toHaveAttribute("title", /\S/);
    // The handle sets the height.
    const before = (await form.boundingBox())!.height;
    const grip = (await handle.boundingBox())!;
    await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
    await page.mouse.down();
    await page.mouse.move(grip.x + grip.width / 2, grip.y - 100, { steps: 5 });
    await page.mouse.up();
    const after = (await form.boundingBox())!.height;
    expect(after).toBeGreaterThan(before + 80);
    await expect(submit).toBeInViewport();
    await page.screenshot({ path: "test-results/phone-pinned.png" });
    // Remembered: pinned again after a reload, it has that height.
    await page.reload();
    await addPhlair(page);
    await page.locator(".remarkup-assist-button:has(.fa-thumb-tack)").click();
    await expect.poll(async () => Math.round((await form.boundingBox())!.height)).toBe(Math.round(after));
    // Many actions: the form scrolls, the row of "Add Action..." stays at its top.
    const actions = form.locator(".phui-comment-action-bar select");
    for (const label of [
      "Change Priority",
      "Change Status",
      "Assign / Claim",
      "Change Subscribers",
      "Change Project Tags",
    ]) {
      await actions.selectOption({ label });
    }
    await form.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(form.locator(".phui-comment-action-bar")).toBeInViewport();
    await expect(submit).toBeInViewport();
    const formTop = (await form.boundingBox())!.y;
    expect((await form.locator(".phui-comment-action-bar").boundingBox())!.y).toBeLessThan(formTop + 20);
    // Removed again by their X, from the last one up.
    const removes = form.locator(".phui-comment-action .aphront-form-error .fa-times-circle");
    while ((await removes.count()) > 0) {
      await removes.last().click();
    }
    // Unpinned, the handle goes, the button is below the text again; the comment is sent as ever.
    await page.locator(".remarkup-assist-button:has(.fa-thumb-tack)").click();
    await expect(form).not.toHaveClass(/remarkup-assist-pinned/);
    await expect(handle).toHaveCount(0);
    await expect(form.locator(".phui-comment-action-bar button")).toHaveCount(0);
    await editor(page).click();
    await page.keyboard.type("Pinned and sent.");
    await page.locator(".remarkup-assist-button:has(.fa-thumb-tack)").click();
    await submit.click();
    await expect(
      page.locator(".phui-timeline-view .phabricator-remarkup", { hasText: "Pinned and sent." }),
    ).toBeVisible();
  });
});

test.describe("feedback", () => {
  test("the feedback button opens a new task for feedback, with the details filled in", async ({ page, context }) => {
    await openNewWikiPage(page, "Feedback");
    const opened = context.waitForEvent("page");
    await page.locator(".rme-feedback-button").click();
    const form = await opened;
    await form.waitForLoadState();
    await addPhlair(form);
    expect(form.url()).toContain("/maniphest/task/edit/form/default/");
    await expect(form.locator('input[name="title"]')).toHaveValue("Phizziwig feedback: ");
    const description = await form.locator('textarea[name="description"]').inputValue();
    expect(description).toContain("What did you do, what happened");
    expect(description).toContain("== Details ==");
    expect(description).toContain(`- Page: ${page.url()}`);
    expect(description).toMatch(/- Editor: Phizziwig \S+/);
    // The editor is on there: screenshots can be pasted. Sent, it is a task.
    await expect(form.locator(".rme-editor")).toHaveCount(1);
    await form.locator('input[name="title"]').fill("Phizziwig feedback: the e2e test");
    await form.getByRole("button", { name: "Create New Task" }).click();
    await expect(form).toHaveURL(/\/T\d+$/);
    await expect(form.locator(".phui-header-header").first()).toContainText("Phizziwig feedback: the e2e test");
  });
});

test.describe("checkboxes in rendered text", () => {
  const boxes = (page: Page, within: string) => page.locator(`${within} ul.remarkup-list-with-checkmarks input`);
  // The boxes clicked are saved 5 seconds after the last click.
  test.beforeEach(async ({ page }) => {
    await page.clock.install();
  });
  const saveNow = (page: Page) => page.clock.runFor(5_000);

  test("a click in a task description saves just that checkbox", async ({ page }) => {
    await page.goto("/maniphest/");
    const description = "Steps:\n\n- [ ] one\n- [x] two\n\n```\n- [ ] in code\n```\n\nThe end.";
    const task = await conduit(page, "maniphest.edit", {
      transactions: [
        { type: "title", value: "Checkboxes to click" },
        { type: "description", value: description },
      ],
    });
    const id = task.object.id;
    await page.goto(`/T${id}`);
    await addPhlair(page);
    const source = async () =>
      (await conduit(page, "maniphest.search", { constraints: { ids: [id] } })).data[0].fields.description.raw;
    const shown = boxes(page, ".phui-property-list-text-content");
    await expect(shown).toHaveCount(2);
    const edits = async () =>
      (await conduit(page, "transaction.search", { objectIdentifier: `T${id}` })).data.filter(
        (t: { type: string }) => t.type === "description",
      ).length;
    const editsBefore = await edits();
    // Shown at once, saved together once the clicks pause, in one edit.
    await shown.nth(0).click();
    await expect(shown.nth(0)).toBeChecked();
    await page.clock.runFor(4_000);
    await shown.nth(1).click();
    await expect(shown.nth(1)).not.toBeChecked();
    await page.clock.runFor(4_000);
    expect(await source()).toBe(description);
    await page.clock.runFor(1_500);
    await expect.poll(source).toBe(description.replace("- [ ] one", "- [x] one").replace("- [x] two", "- [ ] two"));
    expect(await edits()).toBe(editsBefore + 1);
    // Clicked and clicked back: nothing to save.
    await shown.nth(0).click();
    await shown.nth(0).click();
    await saveNow(page);
    // A save would have started now: none runs.
    await expect(page.locator(".rme-saving")).toHaveCount(0);
    await expect(shown.nth(0)).toBeChecked();
    expect(await edits()).toBe(editsBefore + 1);
    expect(await source()).toBe(description.replace("- [ ] one", "- [x] one").replace("- [x] two", "- [ ] two"));
    // Changed by someone else meanwhile: not saved, and said so.
    await conduit(page, "maniphest.edit", {
      objectIdentifier: `T${id}`,
      transactions: [{ type: "description", value: `- [ ] new first\n${await source()}` }],
    });
    const before = await source();
    await shown.nth(0).click();
    await saveNow(page);
    await expect(page.locator(".rme-check-note")).toContainText("changed meanwhile");
    // Shown as it was again.
    await expect(shown.nth(0)).toBeChecked();
    expect(await source()).toBe(before);
  });

  test("a click in a comment saves just that checkbox of the comment, also in a quote", async ({ page }) => {
    await page.goto("/maniphest/");
    const comment = "Also:\n\n> - [ ] quoted\n> - [x] done";
    const task = await conduit(page, "maniphest.edit", {
      transactions: [
        { type: "title", value: "Comment checkboxes" },
        { type: "description", value: "- [ ] not this one" },
        { type: "comment", value: comment },
      ],
    });
    await page.goto(`/T${task.object.id}`);
    await addPhlair(page);
    const shown = boxes(page, ".transaction-comment");
    await expect(shown).toHaveCount(2);
    await shown.nth(0).click();
    await saveNow(page);
    const comments = async () =>
      (await conduit(page, "transaction.search", { objectIdentifier: `T${task.object.id}` })).data
        .filter((t: { type: string }) => t.type === "comment")
        .map((t: { comments: { content: { raw: string } }[] }) => t.comments[0].content.raw);
    await expect.poll(comments).toEqual([comment.replace("> - [ ] quoted", "> - [x] quoted")]);
    await expect(shown.nth(0)).toBeChecked();
    // The description is untouched.
    const fields = (await conduit(page, "maniphest.search", { constraints: { ids: [task.object.id] } })).data[0].fields;
    expect(fields.description.raw).toBe("- [ ] not this one");
  });

  test("in a revision, the summary and the test plan; on a wiki page, the page", async ({ page }) => {
    await createRevision(page, "Revision checkboxes");
    const id = Number(/D(\d+)/.exec(page.url())![1]);
    await conduit(page, "differential.revision.edit", {
      objectIdentifier: `D${id}`,
      transactions: [
        { type: "summary", value: "- [ ] summary item" },
        { type: "testPlan", value: "- [ ] tested here\n- [ ] and there" },
      ],
    });
    await page.goto(`/D${id}`);
    await addPhlair(page);
    await boxes(page, ".phui-property-list-text-content").nth(2).click();
    await saveNow(page);
    const fields = async () =>
      (await conduit(page, "differential.revision.search", { constraints: { ids: [id] } })).data[0].fields;
    await expect.poll(async () => (await fields()).testPlan).toBe("- [ ] tested here\n- [x] and there");
    expect((await fields()).summary).toBe("- [ ] summary item");

    const slug = `e2e-checkboxes-${Date.now()}/`;
    const content = "= Checklist =\n\n- [x] first\n  - [ ] nested\n\n```\n- [ ] code\n```";
    await conduit(page, "phriction.create", { slug, title: "Checklist", content });
    await page.goto(`/w/${slug}`);
    await addPhlair(page);
    const wiki = boxes(page, ".phui-document-content-view");
    await expect(wiki).toHaveCount(2);
    await wiki.nth(1).click();
    await saveNow(page);
    const raw = async () =>
      (
        await conduit(page, "phriction.document.search", {
          constraints: { paths: [slug] },
          attachments: { content: true },
        })
      ).data[0].attachments.content.content.raw;
    await expect.poll(raw).toBe(content.replace("  - [ ] nested", "  - [x] nested"));
  });

  test("a save that fails is said, and the checkbox stays as it was", async ({ page }) => {
    await page.goto("/maniphest/");
    const task = await conduit(page, "maniphest.edit", {
      transactions: [
        { type: "title", value: "Failing checkbox" },
        { type: "description", value: "- [ ] one" },
      ],
    });
    await page.goto(`/T${task.object.id}`);
    await addPhlair(page);
    await page.route(/\/api\/maniphest\.edit/, (route) => route.fulfill({ status: 500, body: "Broken" }));
    const box = boxes(page, ".phui-property-list-text-content").first();
    await box.click();
    await saveNow(page);
    await expect(page.locator(".rme-check-note")).toContainText("could not be saved");
    await expect(box).not.toBeChecked();
  });

  test("boxes clicked are saved at once when the page is hidden, with the source read at the click", async ({
    page,
  }) => {
    await page.goto("/maniphest/");
    const task = await conduit(page, "maniphest.edit", {
      transactions: [
        { type: "title", value: "Hidden with a checkbox" },
        { type: "description", value: "- [ ] one\n- [ ] two" },
      ],
    });
    await page.goto(`/T${task.object.id}`);
    await addPhlair(page);
    const loaded = page.waitForResponse((response) => response.url().includes("/api/maniphest.search"));
    await boxes(page, ".phui-property-list-text-content").first().click();
    await loaded;
    let reads = 0;
    page.on("request", (request) => request.url().includes("/api/maniphest.search") && reads++);
    // Another tab, the tab closing, the screen locking: the page is hidden.
    const saved = page.waitForRequest((request) => request.url().includes("/api/maniphest.edit"));
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await saved;
    // One request: not reading the source again first.
    expect(reads).toBe(0);
    const source = async () =>
      (await conduit(page, "maniphest.search", { constraints: { ids: [task.object.id] } })).data[0].fields.description
        .raw;
    await expect.poll(source).toBe("- [x] one\n- [ ] two");
  });

  test("leaving before the source is read: the browser asks, and meanwhile it is saved", async ({ page }) => {
    await page.goto("/maniphest/");
    const task = await conduit(page, "maniphest.edit", {
      transactions: [
        { type: "title", value: "Leave at once" },
        { type: "description", value: "- [ ] one" },
      ],
    });
    await page.goto(`/T${task.object.id}`);
    await addPhlair(page);
    // A slow server.
    await page.route(/\/api\/maniphest\.search/, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 800));
      await route.continue();
    });
    let asked = false;
    page.on("dialog", async (dialog) => {
      asked = dialog.type() === "beforeunload";
      // Read like a person reads it.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await dialog.accept();
    });
    const box = boxes(page, ".phui-property-list-text-content").first();
    await box.click();
    // The click is taken a task later (after the browser put the box back):
    // leaving before that, there would be nothing to save yet.
    await expect(box).toHaveClass(/rme-pending/);
    await page.goto("/maniphest/");
    expect(asked).toBe(true);
    await page.unroute(/\/api\/maniphest\.search/);
    const source = async () =>
      (await conduit(page, "maniphest.search", { constraints: { ids: [task.object.id] } })).data[0].fields.description
        .raw;
    await expect.poll(source).toBe("- [x] one");
  });

  test("boxes clicked are saved when the page is left before they would be", async ({ page }) => {
    await page.goto("/maniphest/");
    const task = await conduit(page, "maniphest.edit", {
      transactions: [
        { type: "title", value: "Leave with a checkbox" },
        { type: "description", value: "- [ ] one\n- [ ] two" },
      ],
    });
    await page.goto(`/T${task.object.id}`);
    await addPhlair(page);
    // The source is read at the first click.
    const loaded = page.waitForResponse((response) => response.url().includes("/api/maniphest.search"));
    await boxes(page, ".phui-property-list-text-content").nth(1).click();
    await loaded;
    // The browser asks before leaving; leaving, it is saved.
    let asked = false;
    page.on("dialog", (dialog) => {
      asked = dialog.type() === "beforeunload";
      void dialog.accept();
    });
    await page.goto("/maniphest/");
    expect(asked).toBe(true);
    const source = async () =>
      (await conduit(page, "maniphest.search", { constraints: { ids: [task.object.id] } })).data[0].fields.description
        .raw;
    await expect.poll(source).toBe("- [ ] one\n- [x] two");
  });

  test("a link followed (to the same page) saves first: the page it opens shows the boxes saved", async ({ page }) => {
    await page.goto("/maniphest/");
    const task = await conduit(page, "maniphest.edit", {
      transactions: [
        { type: "title", value: "Follow a link" },
        { type: "description", value: "- [ ] one\n- [ ] two" },
      ],
    });
    await page.goto(`/T${task.object.id}`);
    await addPhlair(page);
    await boxes(page, ".phui-property-list-text-content").nth(1).click();
    // A plain link to this page, like a mention of the task in a comment.
    await page.evaluate((id) => {
      const link = document.createElement("a");
      link.href = `/T${id}`;
      link.id = "again";
      link.textContent = "This task again";
      document.querySelector(".phui-timeline-view")!.prepend(link);
    }, task.object.id);
    await page.evaluate(() => ((window as unknown as { old: boolean }).old = true));
    const loaded = page.waitForEvent("load");
    await page.locator("#again").click();
    // A new page.
    await loaded;
    expect(await page.evaluate(() => (window as unknown as { old?: boolean }).old ?? false)).toBe(false);
    // Rendered by the server as saved: no checkbox script needed to see it.
    await expect(page.locator(".phui-property-list-text-content li.remarkup-checked-item")).toHaveText("two");
  });

  test("a page older than the text saves the boxes as it shows them, then shows the text as saved", async ({
    page,
  }) => {
    await page.goto("/maniphest/");
    const task = await conduit(page, "maniphest.edit", {
      transactions: [
        { type: "title", value: "An older page" },
        { type: "description", value: "- [ ] one\n- [ ] two\n- [ ] three" },
      ],
    });
    await page.goto(`/T${task.object.id}`);
    await addPhlair(page);
    // Saved elsewhere meanwhile (another tab, a page left before this one loaded): "two" checked.
    await conduit(page, "maniphest.edit", {
      objectIdentifier: `T${task.object.id}`,
      transactions: [{ type: "description", value: "- [ ] one\n- [x] two\n- [ ] three" }],
    });
    const shown = boxes(page, ".phui-property-list-text-content");
    await expect(shown.nth(1)).not.toBeChecked();
    // "two" as it shows (checked, here unchecked) and "one" clicked: no note, the clicks win.
    await shown.nth(0).click();
    await shown.nth(1).click();
    await shown.nth(1).click();
    await shown.nth(1).click();
    await saveNow(page);
    await expect(page.locator(".rme-saving")).toHaveCount(0);
    await expect(page.locator(".rme-check-note")).toHaveCount(0);
    const source = async () =>
      (await conduit(page, "maniphest.search", { constraints: { ids: [task.object.id] } })).data[0].fields.description
        .raw;
    await expect.poll(source).toBe("- [x] one\n- [x] two\n- [ ] three");
    // A box only the source changed shows as saved.
    await conduit(page, "maniphest.edit", {
      objectIdentifier: `T${task.object.id}`,
      transactions: [{ type: "description", value: "- [x] one\n- [x] two\n- [x] three" }],
    });
    await shown.nth(0).click();
    await saveNow(page);
    await expect(page.locator(".rme-saving")).toHaveCount(0);
    await expect.poll(source).toBe("- [ ] one\n- [x] two\n- [x] three");
    await expect(shown.nth(2)).toBeChecked();
  });
});

test.describe("fullscreen", () => {
  test("the editor has a background of its own in fullscreen, the page's color", async ({ page }) => {
    await createTask(page, "Fullscreen background");
    await addPhlair(page);
    await editor(page).click();
    await page.keyboard.type("Text in fullscreen.");
    await page.locator(".remarkup-assist-button:has(.fa-arrows-alt)").click();
    await expect(page.locator(".remarkup-fullscreen-mode")).toBeVisible();
    const background = await page.locator(".rme-editor").evaluate((el) => getComputedStyle(el).backgroundColor);
    // Opaque: not the textarea's tint, through which the page would show.
    expect(background).toMatch(/^rgb\(/);
    await page.screenshot({ path: "test-results/fullscreen.png" });
  });
});

test.describe("the toolbar on phones", () => {
  const icons = (page: Page) =>
    page
      .locator(".phui-comment-form-view .remarkup-assist-bar .remarkup-assist-button:visible")
      .evaluateAll((buttons) =>
        buttons.map((b) => b.querySelector(".remarkup-assist")!.className.match(/fa-[\w-]+/)![0]),
      );
  const ESSENTIALS = [
    "fa-bold",
    "fa-italic",
    "fa-link",
    "fa-list-ul",
    "fa-check-square-o",
    "fa-cloud-upload",
    "fa-ellipsis-h",
    "fa-arrows-alt",
    "fa-thumb-tack",
    "fa-magic",
  ].sort();

  test("phones get one row of essentials and ⋯, pinned or not; larger screens all buttons", async ({ page }) => {
    await createTask(page, "Toolbar sizes");
    await addPhlair(page);
    const pin = page.locator(".remarkup-assist-button:has(.fa-thumb-tack)");
    // A computer: all of them, pinned or not, and no ⋯.
    const all = await icons(page);
    expect(all).not.toContain("fa-ellipsis-h");
    expect(all.length).toBeGreaterThan(ESSENTIALS.length + 6);
    await pin.click();
    expect((await icons(page)).sort()).toEqual(all.sort());
    await pin.click();
    // A phone: the essentials, pinned or not.
    await page.setViewportSize({ width: 390, height: 800 });
    await expect(page.locator("body")).toHaveClass(/device-phone/);
    await expect.poll(async () => (await icons(page)).sort()).toEqual(ESSENTIALS);
    await pin.click();
    await expect.poll(async () => (await icons(page)).sort()).toEqual(ESSENTIALS);
    // One row.
    const heights = await page
      .locator(".phui-comment-form-view .remarkup-assist-bar .remarkup-assist-button:visible")
      .evaluateAll((buttons) => new Set(buttons.map((b) => Math.round(b.getBoundingClientRect().top))).size);
    expect(heights).toBe(1);
  });

  test("on a phone, ⋯ shows the others in the middle of the window, which work on the text", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 640 });
    await createTask(page, "Toolbar menu");
    await addPhlair(page);
    const bar = page.locator(".phui-comment-form-view .remarkup-assist-bar");
    await editor(page).click();
    await page.keyboard.type("strike me");
    await page.keyboard.press("Shift+Home");
    await bar.locator(".rme-more").click();
    const menu = page.locator(".rme-more-menu");
    await expect(menu.getByRole("menuitem", { name: /Preview/i })).toBeAttached();
    // In the middle, in the window, scrolling itself.
    const box = (await menu.boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - 195)).toBeLessThan(2);
    expect(Math.abs(box.y + box.height / 2 - 320)).toBeLessThan(2);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(640);
    const scrollY = await page.evaluate(() => window.scrollY);
    await menu.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(menu).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
    await menu.getByRole("menuitem", { name: /Strikethrough/ }).click();
    await expect.poll(() => textarea(page).inputValue()).toBe("~~strike me~~");
  });
});

test.describe("the pinned form on a computer", () => {
  test("the submit button, with its label, sits next to the actions", async ({ page }) => {
    await createTask(page, "Pinned on a computer");
    await addPhlair(page);
    await page.locator(".remarkup-assist-button:has(.fa-thumb-tack)").click();
    const bar = page.locator(".phui-comment-form-view .phui-comment-action-bar");
    const submit = bar.locator("button[data-sigil~='submit-transactions']");
    await expect(submit).toBeVisible();
    expect((await submit.boundingBox())!.width).toBeGreaterThan(100);
    const select = (await bar.locator("select").boundingBox())!;
    const button = (await submit.boundingBox())!;
    expect(Math.abs(button.y + button.height / 2 - (select.y + select.height / 2))).toBeLessThan(2);
    // The same margins left, right and between, as "Add Action..." has them on phones.
    const row = (await bar.boundingBox())!;
    const left = select.x - row.x;
    expect(Math.abs(row.x + row.width - (button.x + button.width) - left)).toBeLessThan(1);
    expect(button.height).toBe(select.height);
    // The handle on the top border, above none of the form's controls.
    const handle = (await page.locator(".rme-pinned-resize").boundingBox())!;
    const top = (await page.locator(".phui-comment-form-view").boundingBox())!.y;
    expect(Math.abs(handle.y + handle.height / 2 - top)).toBeLessThan(1.5);
    expect(handle.y + handle.height).toBeLessThanOrEqual(select.y);
    // No scrollbars for a pixel.
    const form = page.locator(".phui-comment-form-view");
    expect(await form.evaluate((el) => [el.scrollWidth - el.clientWidth, el.scrollHeight - el.clientHeight])).toEqual([
      0, 0,
    ]);
  });

  test("a long menu near the bottom of the window stays in the window, scrolling itself", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 600 });
    await createTask(page, "Menu at the bottom");
    await addPhlair(page);
    await page.locator(".remarkup-assist-button:has(.fa-thumb-tack)").click();
    await page.locator(".rme-shortcuts-button").click();
    const menu = page.locator(".rme-shortcuts");
    await expect(menu).toBeVisible();
    const box = (await menu.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(600);
    // More items than room: it scrolls, not the page.
    expect(await menu.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
    const scrollY = await page.evaluate(() => window.scrollY);
    await menu.evaluate((el) => (el.scrollTop = el.scrollHeight));
    await expect(menu).toBeVisible();
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollY);
  });
});

test.describe("the end of the text", () => {
  test("a block at the end has as much room below it as the first line above it", async ({ page }) => {
    await startWith(page, "Text.\n\n```\ncode line\n```");
    const gaps = await page.locator(".rme-editor .cm-content").evaluate((content) => {
      const box = content.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(content.querySelector(".cm-line")!);
      const text = range.getBoundingClientRect();
      const block = content.querySelector(".rme-block-code")!.getBoundingClientRect();
      return { top: text.top - box.top, bottom: box.bottom - block.bottom };
    });
    // At least the room above the first line's text, which its letters start a bit below.
    expect(gaps.bottom).toBeGreaterThanOrEqual(gaps.top);
    expect(gaps.bottom).toBeLessThan(gaps.top + 4);
  });
});

test.describe("the room below the text", () => {
  /** The room between the last line and the end of what shows of the text, scrolled to its end. */
  const roomBelow = (page: Page) =>
    page
      .locator(".rme-editor")
      .last()
      .evaluate((editor) => {
        const scrollers = [editor, editor.querySelector(".cm-scroller")!] as HTMLElement[];
        scrollers.forEach((el) => (el.scrollTop = el.scrollHeight));
        const lines = editor.querySelectorAll(".cm-line");
        const last = lines[lines.length - 1].getBoundingClientRect();
        // The inside of the editor's box, which shows the text, without its border.
        const inside = editor.getBoundingClientRect().top + editor.clientTop + editor.clientHeight;
        return Math.round(inside - last.bottom);
      });

  test("is the same in the text, pinned and in a dialog; in fullscreen like its padding", async ({ page }) => {
    await createTask(page, "Room below");
    await addPhlair(page);
    await editor(page).click();
    await page.keyboard.insertText(Array.from({ length: 40 }, (_, i) => `Line ${i}`).join("\n\n"));
    await page.keyboard.press("Control+End");
    const normal = await roomBelow(page);
    expect(normal).toBeGreaterThan(8);
    const pin = page.locator(".remarkup-assist-button:has(.fa-thumb-tack)");
    await pin.click();
    await expect.poll(() => roomBelow(page)).toBe(normal);
    await pin.click();
    await page.locator(".remarkup-assist-button:has(.fa-arrows-alt)").click();
    // Fullscreen has 16px of padding all round, not 8px.
    await expect.poll(() => roomBelow(page)).toBe(normal + 8);
    await page.keyboard.press("Escape");
    // A dialog: editing the description.
    await page.goto(`${page.url().replace(/\/T(\d+).*/, "/maniphest/task/edit/$1/")}`);
    await addPhlair(page);
    await editor(page).click();
    await page.keyboard.insertText(Array.from({ length: 40 }, (_, i) => `Line ${i}`).join("\n\n"));
    await expect.poll(() => roomBelow(page)).toBe(normal);
  });
});

test.describe("the pinned form's handle by touch", () => {
  test.use({ viewport: { width: 390, height: 800 }, hasTouch: true });

  test("a finger drags the handle and sets the height", async ({ page }) => {
    await createTask(page, "Touch handle");
    await addPhlair(page);
    await page.locator(".remarkup-assist-button:has(.fa-thumb-tack)").click();
    const form = page.locator(".phui-comment-form-view");
    const handle = page.locator(".rme-pinned-resize");
    await expect(handle).toBeVisible();
    // Touches do not scroll the page there.
    await expect(handle).toHaveCSS("touch-action", "none");
    const before = (await form.boundingBox())!.height;
    // A finger: pointer events of the touch kind, which leave the handle as it drags.
    await handle.evaluate((el) => {
      const box = el.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const at = (y: number) => ({
        pointerId: 7,
        pointerType: "touch",
        isPrimary: true,
        clientX: x,
        clientY: y,
        bubbles: true,
      });
      el.dispatchEvent(new PointerEvent("pointerdown", { ...at(box.top + 8), button: 0 }));
      for (let y = box.top + 8; y >= box.top - 150; y -= 30) {
        window.dispatchEvent(new PointerEvent("pointermove", at(y)));
      }
      window.dispatchEvent(new PointerEvent("pointerup", at(box.top - 150)));
    });
    await expect.poll(async () => (await form.boundingBox())!.height).toBeGreaterThan(before + 140);
  });
});

test.describe("leaving a table cell", () => {
  test("Tab right after typing: the cell left shows its text as edited, not its source, until rendered", async ({
    page,
  }) => {
    await startWith(page, "Before.\n\n| Element | Line\n| --- | ---\n| Fe | Ka\n| Cu | Ka\n\nAfter.");
    await page.locator(".rme-table-editor td", { hasText: "Fe" }).click();
    await page.keyboard.press("End");
    await page.keyboard.type(" **iron**");
    // What the cell shows from the moment it is left.
    await page.evaluate(() => {
      const shown: string[] = [];
      (window as unknown as { shown: string[] }).shown = shown;
      const cell = document.querySelector(".rme-table-editor tr[data-row='2'] td[data-col='0']")!;
      const note = () => !cell.querySelector(".cm-editor") && shown.push(cell.textContent ?? "");
      new MutationObserver(note).observe(cell, { childList: true, subtree: true, characterData: true });
    });
    await page.keyboard.press("Tab");
    const cell = page.locator(".rme-table-editor tr[data-row='2'] td[data-col='0']");
    await expect(cell.locator("strong")).toHaveText("iron");
    const shown = await page.evaluate(() => (window as unknown as { shown: string[] }).shown);
    expect(shown.length).toBeGreaterThan(0);
    for (const text of shown) {
      expect(text).not.toContain("**");
    }
  });
});

test.describe("images by their lines", () => {
  const top = (page: Page, text: string) =>
    page.locator(".cm-line", { hasText: text }).evaluate((line) => line.getBoundingClientRect().top);
  const boxes = (page: Page) =>
    page.locator(".rme-image-preview img").evaluateAll((imgs) => imgs.map((img) => img.getBoundingClientRect()));
  const cursor = (page: Page) => textarea(page).evaluate((t: HTMLTextAreaElement) => t.selectionStart);

  test("each image shows by the line of its embed, also while edited", async ({ page }) => {
    await startWith(page, "Intro line.\n{F1}\nMiddle line.\nrmecat\nLast line.\n{F1}\n\nSee this: {F1}");
    await expect(page.locator(".rme-image-preview img")).toHaveCount(4);
    const [image, macro, again, after] = await boxes(page);
    // Above the line of its embed, between the text around it, like in the rendered text.
    expect(image!.top).toBeGreaterThan(await top(page, "Intro line."));
    expect(image!.bottom).toBeLessThan(await top(page, "Middle line."));
    expect(macro!.top).toBeGreaterThan(await top(page, "Middle line."));
    expect(macro!.bottom).toBeLessThan(await top(page, "Last line."));
    expect(again!.top).toBeGreaterThan(await top(page, "Last line."));
    // Below a line with text before the embed.
    expect(after!.top).toBeGreaterThan(await top(page, "See this:"));
    // Nothing moves while the block is edited; the reference shows on its line, below its image.
    await page.locator(".cm-line", { hasText: "Middle line." }).click();
    await page.keyboard.press("ArrowUp");
    await expect(page.locator(".cm-line", { hasText: "{F1}" })).toHaveCount(1);
    expect(await top(page, "{F1}")).toBeGreaterThan(image!.bottom);
    const edited = await boxes(page);
    expect(edited.map((b) => Math.round(b.top))).toEqual([image, macro, again, after].map((b) => Math.round(b!.top)));
  });

  test("a click on an image puts the cursor after its embed; Shift+click selects, Ctrl+click opens it", async ({
    page,
    context,
  }) => {
    const text = "{F1} first.\nText.\n{F1} second.\n\n> Quoted:\n> {F1}";
    await startWith(page, text);
    const images = page.locator(".rme-image-preview img");
    await expect(images).toHaveCount(3);
    // The n-th image of the file is its n-th embed, in the block and in the quote after it.
    await images.nth(1).click();
    await expect.poll(() => cursor(page)).toBe(text.indexOf("{F1} second.") + 4);
    await images.nth(2).click();
    await expect.poll(() => cursor(page)).toBe(text.length);
    await expect(page.locator(".cm-line", { hasText: "{F1}" })).toHaveCount(1);
    await images.nth(0).click({ modifiers: ["Shift"] });
    await expect.poll(() => selected(page)).toBe(text.slice(4));
    const opened = context.waitForEvent("page");
    await images.nth(0).click({ modifiers: ["Control"] });
    expect((await opened).url()).toMatch(new RegExp(`^${FILES_URL}/file/data/.*demo\\.png$`));
    await expect.poll(() => selected(page)).toBe(text.slice(4));
  });

  test("a floating image floats from the line of its embed on, within its block", async ({ page }) => {
    await startWith(page, "Intro line.\n{F1, float}\nBeside the image.\n\nNext paragraph.");
    const [image] = await boxes(page);
    expect(image!.top).toBeGreaterThan(await top(page, "Intro line."));
    expect(image!.right).toBeLessThan(
      await page.locator(".cm-line", { hasText: "Beside the image." }).evaluate((line) => {
        const range = document.createRange();
        range.selectNodeContents(line);
        return range.getClientRects()[0]!.left;
      }),
    );
    await expect.poll(() => top(page, "Next paragraph.")).toBeGreaterThan(image!.bottom);
  });

  test("a long press on an image opens its menu without moving the cursor", async ({ page, browserName }) => {
    test.skip(browserName === "firefox", "Touch input through CDP");
    await startWith(page, "Before.\n\n{F1}");
    await page.locator(".cm-line", { hasText: "Before." }).click();
    const box = (await page.locator(".rme-image-preview img").boundingBox())!;
    const cdp = await page.context().newCDPSession(page);
    const point = { x: box.x + 20, y: box.y + 20 };
    await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
    await expect(page.locator(".rme-image-menu")).toBeVisible();
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    await page.waitForTimeout(300);
    expect(await cursor(page)).toBe("Before.".length);
    await expect(page.locator(".rme-image-menu")).toBeVisible();
  });
});
