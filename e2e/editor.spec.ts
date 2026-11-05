import { expect, type Locator, type Page, test } from "@playwright/test";
import { addPhlair, createTask, editor, openNewWikiPage, openWithEditor, settled, textarea } from "./helpers";

// Whitespace differs, e.g. between the rows of tables; list markers are drawn by the browser.
const normalize = (text: string) => text.replace(/[\s\u200b]+/g, "");

test("shows the whole text like Phorge's preview, its markup hidden", async ({ page }) => {
  // The seeded wiki page uses every remarkup construct. Tall, so all of its lines are drawn.
  await page.setViewportSize({ width: 1280, height: 4000 });
  await openWithEditor(page, "/phriction/edit/2/");
  await page.addStyleTag({ content: ".rme-editor { height: auto !important; max-height: none !important; }" });
  const preview = page.locator(".phui-remarkup-preview .phui-preview-body");
  await expect(preview).toContainText("A reply quote.");
  await settled(page);

  // Without the focus, all markup is hidden: the text is the preview's.
  const shown = normalize((await editor(page).textContent())!);
  expect(shown).toBe(normalize((await preview.textContent())!));
  await expect(page.locator(".cm-line.remarkup-note.rme-first")).toHaveCount(2);
  await expect(page.locator(".rme-editor a.phui-tag-view", { hasText: "T1" }).first()).toBeVisible();
  await expect(page.locator(".rme-image-preview img")).toBeVisible();
});

test("edits the clicked text and saves what is typed", async ({ page }) => {
  const slug = await openNewWikiPage(page, "Editing");
  await editor(page).click();
  await page.keyboard.type("= Plan =\n\nNOTE: Check T1 first.\n\nSome text.");

  // The note looks like a note, also while it is edited.
  const note = page.locator(".cm-line.rme-src-note");
  await expect(note).toContainText("Check T1 first.");
  await note.click();
  await expect(note).toHaveText("NOTE: Check T1 first.");
  await page.keyboard.press("End");
  await page.keyboard.type(" Then T2.");

  await expect(textarea(page)).toHaveValue("= Plan =\n\nNOTE: Check T1 first. Then T2.\n\nSome text.");
  await page.getByRole("button", { name: "Create Document" }).click();
  // Saved: the page itself, not the form with an error.
  await page.waitForURL(`**/w/${slug}`);
  await expect(page.locator(".phui-document-view .remarkup-note")).toHaveText("NOTE: Check T1 first. Then T2.");
});

test("entering a block does not move the text below it", async ({ page }) => {
  await openNewWikiPage(page, "Layout");
  await editor(page).click();
  await page.keyboard.insertText(
    [
      "== Header ==",
      "NOTE: A note.",
      "> A quote\n> two lines",
      // Indented code after a list would continue the list.
      "  indented code",
      "- one\n- two\n  - nested",
      "End.",
    ].join("\n\n"),
  );
  const blur = () => page.evaluate(() => (document.activeElement as HTMLElement).blur());
  const end = page.locator(".cm-line", { hasText: "End." });
  await blur();
  await settled(page);
  const top = async () => (await end.boundingBox())!.y;
  const before = await top();
  for (const kind of ["src-h", "src-note", "src-quote", "block-code", "src-list"]) {
    await page
      .locator(`.rme-${kind}`)
      .first()
      .click({ position: { x: 3, y: 3 } });
    if (kind === "block-code") {
      // The code block, rendered by the server, shows its source.
      await expect(page.locator(".rme-block-code")).toHaveCount(0);
    }
    expect(Math.abs((await top()) - before), `moved by entering ${kind}`).toBeLessThan(0.5);
    await blur();
    expect(Math.abs((await top()) - before), `moved by leaving ${kind}`).toBeLessThan(0.5);
  }
});

test("arrow keys move into rendered blocks instead of skipping them", async ({ page }) => {
  await openNewWikiPage(page, "Arrows");
  await editor(page).click();
  await page.keyboard.insertText("First\n\n```\nSecond\n```\n\nThird");
  // The code block shows its source while the cursor is in it.
  const source = page.locator(".cm-line.rme-src-code", { hasText: "Second" });

  await page.keyboard.press("Control+Home");
  await page.keyboard.press("ArrowDown");
  await expect(source).toHaveCount(0);
  await page.keyboard.press("ArrowDown");
  await expect(source).toHaveText("Second");

  await page.keyboard.press("Control+End");
  await page.keyboard.press("ArrowUp");
  await expect(source).toHaveCount(0);
  await page.keyboard.press("ArrowUp");
  await expect(source).toHaveText("Second");
});

test("edits tables with Tab, Enter and the table toolbar", async ({ page }) => {
  await openNewWikiPage(page, "Table");
  await editor(page).click();
  await page.keyboard.type("| Element | Line");
  await page.keyboard.press("Enter");
  await page.keyboard.type("Fe");
  await page.keyboard.press("Tab");
  await page.keyboard.type("Ka");
  await expect(textarea(page)).toHaveValue("| Element | Line\n| Fe      | Ka");

  await page
    .locator(".rme-table-bar")
    .getByRole("button", { name: /first row a header/ })
    .click();
  // The icons sit in their buttons like Phorge's own icons.
  const offset = (glyph: string) =>
    page
      .locator(glyph)
      .first()
      .evaluate((el) => el.getBoundingClientRect().top - el.closest("a")!.getBoundingClientRect().top);
  expect(await offset(".rme-table-bar .remarkup-assist")).toBeCloseTo(await offset(".remarkup-assist.fa-table"), 0);
  await page.locator(".rme-table-bar").getByRole("button", { name: "Insert a column on the right" }).click();
  await page.keyboard.type("keV");
  await expect(textarea(page)).toHaveValue("| Element | Line | \n| ------- | ---- | ---\n| Fe      | Ka   | keV");
});

test("Phorge's toolbar buttons act on the editor's selection", async ({ page }) => {
  await openNewWikiPage(page, "Toolbar");
  await editor(page).click();
  await page.keyboard.type("make this bold");
  await page.keyboard.press("Shift+Control+ArrowLeft");
  await page.getByRole("link", { name: "Bold" }).click();
  await expect(textarea(page)).toHaveValue("make this **bold**");
  // The editor keeps the focus, so typing goes on in the editor.
  await page.keyboard.type("strong");
  await expect(textarea(page)).toHaveValue("make this **strong**");
});

test("continues and ends lists and quotes on Enter", async ({ page }) => {
  await openNewWikiPage(page, "Lists");
  await editor(page).click();
  await page.keyboard.type("- one\ntwo\n\n> quoted\nmore\n\nafter");
  await expect(textarea(page)).toHaveValue("- one\n- two\n\n> quoted\n> more\n\nafter");
});

test("completes user names in Phorge's autocomplete menu", async ({ page }) => {
  await openNewWikiPage(page, "Mentions");
  await editor(page).click();
  await page.keyboard.type("Ask @ali");
  const menu = page.locator(".rme-autocomplete");
  await expect(menu.locator(".phuix-autocomplete-head")).toHaveText(/Find User:\s*ali/);
  await expect(menu.locator("a.jx-result.focused")).toContainText("alice");
  await page.keyboard.press("Enter");
  await expect(textarea(page)).toHaveValue("Ask @alice ");
  await expect(menu).toHaveCount(0);
});

test("completes projects at the start of a line and after a space", async ({ page }) => {
  // The project "Demo Project" (#demo_project) is created by dev/phorge/seed.php.
  await openNewWikiPage(page, "Projects");
  await editor(page).click();
  await page.keyboard.type("#dem");
  await expect(page.locator(".rme-autocomplete a.jx-result.focused")).toContainText("Demo Project");
  await page.keyboard.press("Tab");
  await page.keyboard.type("and (#dem");
  await expect(page.locator(".rme-autocomplete a.jx-result.focused")).toContainText("Demo Project");
  await page.keyboard.press("Enter");
  await expect(textarea(page)).toHaveValue("#demo_project and (#demo_project ");
});

test("completes wiki pages after [[", async ({ page }) => {
  // The daemons of dev/phorge index the seeded "Remarkup Demo" page.
  await openNewWikiPage(page, "Wiki links");
  await editor(page).click();
  await page.keyboard.type("See [[de");
  await expect(page.locator(".rme-autocomplete a.jx-result.focused")).toContainText("Remarkup Demo");
  await page.keyboard.press("Enter");
  await expect(textarea(page)).toHaveValue("See [[ demo/ ]] ");
});

test("does not complete numbered lists and closes the menu on Escape", async ({ page }) => {
  await openNewWikiPage(page, "No completion");
  await editor(page).click();
  await page.keyboard.type("# one");
  await expect(page.locator(".rme-autocomplete")).toHaveCount(0);
  // Enter continues the list, Enter on the empty item ends it.
  await page.keyboard.type("\n\nAsk @ali");
  await expect(page.locator(".rme-autocomplete")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".rme-autocomplete")).toHaveCount(0);
  await page.keyboard.press("Enter");
  await expect(textarea(page)).toHaveValue("# one\n\nAsk @ali\n");
});

test("submits a comment with Ctrl+Enter", async ({ page }) => {
  await createTask(page, "Submit test");
  await addPhlair(page);
  await editor(page).click();
  await page.keyboard.type("Ship it.");
  await page.keyboard.press("Control+Enter");
  // Phorge posts the comment and empties the form.
  await expect(textarea(page)).toHaveValue("");
  await page.reload();
  await expect(page.locator(".phui-timeline-view .phabricator-remarkup", { hasText: "Ship it." })).toBeVisible();
});

test("can be switched off and remembers that", async ({ page }) => {
  await openWithEditor(page, "/phriction/edit/2/");
  const toggle = page.locator(".rme-toggle");
  await toggle.click();
  await expect(page.locator(".rme-editor")).toHaveCount(0);
  await expect(page.locator(".rme-format")).toHaveCount(0);
  await expect(textarea(page)).toBeVisible();
  await expect(textarea(page)).toHaveValue(/^= Remarkup demo =/);

  await page.reload();
  await addPhlair(page);
  await expect(page.locator(".rme-toggle")).toBeVisible();
  await expect(page.locator(".rme-editor")).toHaveCount(0);
  await page.locator(".rme-toggle").click();
  await expect(editor(page)).toBeVisible();
});

test("works in the comment form of a task", async ({ page }) => {
  await createTask(page, "Comment test");
  await addPhlair(page);
  await editor(page).click();
  await page.keyboard.type("WARNING: Blocks T2.\n\nNext");
  await expect(page.locator(".cm-line.remarkup-warning")).toContainText("Blocks T2.");
  await expect(textarea(page)).toHaveValue("WARNING: Blocks T2.\n\nNext");
});

for (const event of ["drop", "paste"] as const) {
  test(`uploads ${event === "drop" ? "dropped" : "pasted"} files and inserts a reference`, async ({
    page,
    browserName,
  }) => {
    test.skip(event === "paste" && browserName === "firefox", "Firefox ignores clipboardData of synthetic events");
    await openNewWikiPage(page, "Upload");
    await editor(page).click();
    await page.keyboard.type("Screenshot:\n\n");
    await editor(page).evaluate((node, type) => {
      const data = new DataTransfer();
      data.items.add(new File(["hello"], "note.txt", { type: "text/plain" }));
      // Dropped below the text.
      const box = node.getBoundingClientRect();
      const init = { bubbles: true, cancelable: true, clientX: box.left + 20, clientY: box.bottom - 5 };
      node.dispatchEvent(
        type === "drop"
          ? new DragEvent("drop", { ...init, dataTransfer: data })
          : new ClipboardEvent("paste", { ...init, clipboardData: data }),
      );
    }, event);
    await expect(textarea(page)).toHaveValue(/^Screenshot:\n\n\{F\d+\}$/);
    const metadata = await page.locator('input[name="content_metadata"]').inputValue();
    expect(JSON.parse(metadata).attachedFilePHIDs).toHaveLength(1);
  });
}

test("types characters that are keyboard shortcuts of the page", async ({ page }) => {
  // "?" opens the shortcut help, "z" pins the comment form of a task.
  await createTask(page, "Shortcut test");
  await addPhlair(page);
  await editor(page).click();
  await page.keyboard.type("Ready? z j k");
  await expect(textarea(page)).toHaveValue("Ready? z j k");
  await expect(page.locator(".jx-client-dialog")).toHaveCount(0);
});

test("keeps the toolbar in view while editing further down", async ({ page }) => {
  await openNewWikiPage(page, "Long page");
  await editor(page).click();
  const filler = Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1}.`).join("\n\n");
  await page.keyboard.insertText(`${filler}\n\n| a | b |\n| 1 | 2 |\n\nEnd.`);
  await page.locator(".rme-block-table").click();
  await expect(page.locator(".rme-table-bar")).toBeInViewport();
  await expect(page.getByRole("link", { name: "Bold" })).toBeInViewport();
});

test("Home and End reach the ends of long table rows", async ({ page }) => {
  await openNewWikiPage(page, "Long rows");
  await editor(page).click();
  const long = `| Name | ${"long text ".repeat(30)}|`;
  await page.keyboard.insertText(`${long}\n| short | row |\n\nEnd.`);
  // With the text cursor in it, a table shows its source.
  await page.keyboard.press("Control+Home");
  // Long rows wrap instead of making the editor scroll sideways.
  const scroller = page.locator(".rme-editor .cm-scroller");
  expect(await scroller.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);

  const cursor = () => textarea(page).evaluate((t: HTMLTextAreaElement) => t.selectionStart);
  await page.locator(".cm-line.rme-src-table").first().locator("text=Name").click();
  // The first press goes to the end of the visual row, the second to the end of the line.
  await page.keyboard.press("End");
  await page.keyboard.press("End");
  expect(await cursor()).toBe(long.length);
  await page.keyboard.press("Home");
  await page.keyboard.press("Home");
  expect(await cursor()).toBe(0);
});

test("clicks below image thumbnails land on the clicked line", async ({ page }) => {
  // {F1} is the image of dev/phorge/seed.php; Phorge floats thumbnails left.
  await openNewWikiPage(page, "Images");
  await editor(page).click();
  const sections = [1, 2, 3, 4].map((i) => `== Screenshot ${i}\n\n{F1}\n\nWhat screenshot ${i} shows.`);
  const quote = "> first line\n> second line\n> third line\n> fourth line";
  await page.keyboard.insertText([...sections, "= How it works", "1. One\n2. Two", "= Quote", quote].join("\n\n"));
  await expect(page.locator(".rme-image-preview img").first()).toBeVisible();
  // Edit the list first, then the quote, like moving through the page.
  await page.locator(".cm-line", { hasText: "One" }).click();
  for (const word of ["fourth", "second", "third", "first"]) {
    await page.locator(".cm-line.rme-src-quote", { hasText: word }).locator(`text=${word}`).click();
    const line = await textarea(page).evaluate(
      (t: HTMLTextAreaElement) => t.value.split("\n")[t.value.slice(0, t.selectionStart).split("\n").length - 1],
    );
    expect(line, `clicked "${word}"`).toContain(word);
  }
});

test("Up and Down move line by line through rendered blocks", async ({ page }) => {
  await openNewWikiPage(page, "Up and down");
  await editor(page).click();
  const text = [
    "= Header =",
    "{F1}",
    "NOTE: A note\nwith two lines.",
    "- a list\n- of items",
    "> a quote",
    "== Second header ==",
    "End.",
  ].join("\n\n");
  await page.keyboard.insertText(text);
  const lines = text.split("\n").length;
  const line = () =>
    textarea(page).evaluate((t: HTMLTextAreaElement) => t.value.slice(0, t.selectionStart).split("\n").length);
  for (const [key, from, step] of [
    ["ArrowUp", lines, -1],
    ["ArrowDown", 1, 1],
  ] as const) {
    await page.keyboard.press(step < 0 ? "Control+End" : "Control+Home");
    const visited = [await line()];
    while (visited.length < 2 * lines && visited[visited.length - 1] !== from + step * (lines - 1)) {
      await page.keyboard.press(key);
      visited.push(await line());
    }
    // Every press moves to the next line; no line is skipped.
    expect(visited).toEqual(Array.from({ length: lines }, (_, i) => from + step * i));
  }
});

test("formatting buttons add remarkup without knowing the syntax", async ({ page }) => {
  await openNewWikiPage(page, "Formatting");
  await editor(page).click();
  const button = (name: RegExp) => page.locator(".rme-format").and(page.getByRole("button", { name }));
  const expectText = (text: string) => expect(textarea(page)).toHaveValue(text);

  // The buttons show Phorge's tooltips, like its own buttons, with the
  // shortcut while the editor is on (Phorge's own tip without it).
  await button(/^Strikethrough/).hover();
  await expect(page.locator(".jx-tooltip-container .jx-tooltip")).toHaveText("Strikethrough (Ctrl+Shift+X)");
  const bold = page.locator(".remarkup-assist-button:has(.fa-bold)");
  await bold.hover();
  await expect(page.locator(".jx-tooltip-container .jx-tooltip")).toHaveText("Bold (Ctrl+B)");
  await page.getByRole("button", { name: /^Phizziwig/ }).click();
  await bold.hover();
  await expect(page.locator(".jx-tooltip-container .jx-tooltip")).toHaveText("Bold");
  await page.getByRole("button", { name: /^Phizziwig/ }).click();
  await editor(page).click();

  await page.keyboard.type("Title");
  for (const text of ["= Title", "== Title", "=== Title", "Title"]) {
    await button(/^Heading/).click();
    await expectText(text);
  }

  await page.keyboard.type(" remove me");
  await page.keyboard.press("Shift+Control+ArrowLeft");
  await button(/^Strikethrough/).click();
  await expectText("Title remove ~~me~~");
  await button(/^Strikethrough/).click();
  await expectText("Title remove me");

  await button(/^Checklist/).click();
  await expectText("  - [ ] Title remove me");
  // Only the checkbox goes: it is independent of the list.
  await button(/^Checklist/).click();
  await expectText("  - Title remove me");
  await page.keyboard.press("Control+Shift+8");
  await expectText("Title remove me");

  for (const text of ["NOTE: ", "IMPORTANT: ", "WARNING: ", ""]) {
    await button(/^Note box/).click();
    await expectText(`${text}Title remove me`);
  }

  await page.keyboard.press("End");
  await button(/^Horizontal line/).click();
  await page.keyboard.type("Below");
  await expectText("Title remove me\n\n---\n\nBelow");
});

test("places tooltips like Phorge's, also when the toolbar sticks to the top", async ({ page }) => {
  await openNewWikiPage(page, "Tooltips");
  await editor(page).click();
  await page.keyboard.insertText(Array.from({ length: 60 }, (_, i) => `Paragraph ${i + 1}.`).join("\n\n"));
  // The control's own top; the toolbar may already stick to the window.
  const barTop = await page
    .locator(".remarkup-assist-bar")
    .evaluate((bar) => bar.parentElement!.getBoundingClientRect().top + scrollY);
  const tip = async (hover: () => Promise<void>) => {
    await page.mouse.move(5, 500);
    await hover();
    const container = page.locator(".jx-tooltip-container");
    await expect(container).toHaveCount(1);
    return container.evaluate((el) => ({
      align: /jx-tooltip-align-(\w)/.exec(el.className)?.[1],
      top: Math.round(el.getBoundingClientRect().top),
    }));
  };
  // From the toolbar a bit below the top of the window to stuck at the top.
  for (const offset of [70, 60, 55, 50, 45, 40, 35, 30, 25, 10, 0, -300]) {
    await page.evaluate((y) => window.scrollTo(0, y), barTop - offset);
    // Phorge's own tip (no shortcut) and one of the editor's, both one line.
    const native = await tip(() => page.getByRole("link", { name: "Quote" }).hover());
    const added = await tip(() => page.getByRole("button", { name: "Horizontal line" }).hover());
    expect(added, `toolbar ${offset}px below the top`).toEqual(native);
  }
});

test("lists, highlighted and monospaced text look like in Phorge's preview, also while editing", async ({ page }) => {
  await openNewWikiPage(page, "Same look");
  await editor(page).click();
  await page.keyboard.insertText(
    [
      "Text with !!highlighted!! and `monospaced` words, `https://example.com/*`, `http://localhost:8087/*`.",
      "1. One\n2. Two that is long enough to wrap onto a second line of the editor, so wrapped lines are compared too.",
      "- Outer\n  - Nested one\n  - Nested two\n- Outer two",
      "- [ ] Open\n- [X] Done",
      "# First\n# Second",
      "End.",
    ].join("\n\n"),
  );
  const blur = () => page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await blur();
  await settled(page);
  await page.addStyleTag({ content: ".phui-remarkup-preview { display: block !important; }" });
  const preview = page.locator(".phui-remarkup-preview .phui-preview-body .phabricator-remarkup");
  await expect(preview).toContainText("End.");
  const endTop = () => page.locator(".cm-line", { hasText: "End." }).evaluate((el) => el.getBoundingClientRect().top);
  // The left edge of the first letter of each item, from the left edge of the text.
  const firstLetters = (selector: string, container: string) =>
    page.locator(selector).evaluateAll(
      (elements, container) =>
        elements.map((el) => {
          const left = document.querySelector(container)!.getBoundingClientRect().left;
          const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            const i = (node.textContent ?? "").search(/[^\s\u200b]/);
            if (i >= 0) {
              const range = document.createRange();
              range.setStart(node, i);
              range.setEnd(node, i + 1);
              return Math.round(range.getBoundingClientRect().left - left);
            }
          }
          return null;
        }),
      container,
    );
  const inPreview = await firstLetters(
    ".phui-remarkup-preview .phui-preview-body li",
    ".phui-remarkup-preview .phui-preview-body .phabricator-remarkup",
  );
  const items = () => firstLetters(".cm-line.rme-src-list", ".rme-editor .cm-line");
  expect(await items()).toEqual(inPreview);
  const before = await endTop();
  for (const text of ["One", "Outer", "Open", "First"]) {
    await page.locator(".cm-line.rme-src-list", { hasText: text }).first().click();
    // Wrapped lines of an item start where the item text starts.
    expect(await items(), `editing ${text}`).toEqual(inPreview);
    expect(await endTop(), `editing ${text} moved the text below`).toBeCloseTo(before, 0);
  }

  const style = (selector: string) =>
    page.locator(selector).evaluate((el) => {
      const s = getComputedStyle(el);
      // Font names with or without quotes, as each stylesheet writes them.
      return [s.backgroundColor, s.padding, s.fontFamily.replace(/"/g, ""), s.fontSize];
    });
  const highlight = await style(".phui-remarkup-preview .remarkup-highlight");
  const monospaced = await style(".phui-remarkup-preview .remarkup-monospaced >> nth=0");
  await page.locator(".cm-line", { hasText: "Text with" }).click();
  // At the start of the text, so the cursor is on none of them.
  await page.keyboard.press("Control+Home");
  expect(await style(".cm-line .remarkup-highlight")).toEqual(highlight);
  expect(await style(".cm-line .remarkup-monospaced >> nth=0")).toEqual(monospaced);
  // Each monospaced text is one element (its backticks hidden), with nothing styled inside, like URLs.
  await expect(page.locator(".cm-line tt.remarkup-monospaced")).toHaveText([
    "monospaced",
    "https://example.com/*",
    "http://localhost:8087/*",
  ]);
  await expect(page.locator(".cm-line tt .rme-link")).toHaveCount(0);
});

test.describe("tables", () => {
  const TABLE = "| Element | Line\n| --- | ---\n| Fe | **Ka**\n| Cu | Ka";

  test.beforeEach(async ({ page }) => {
    await openNewWikiPage(page, "Table editing");
    await editor(page).click();
    await page.keyboard.insertText(`Before.\n\n${TABLE}\n\nAfter.`);
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await expect(page.locator(".rme-table-editor td strong")).toHaveText("Ka");
  });

  const cell = (page: Page, text: string) => page.locator(".rme-table-editor :is(th, td)", { hasText: text });
  const source = (page: Page) => textarea(page).inputValue();

  test("look like Phorge's tables", async ({ page }) => {
    const style = (locator: Locator) =>
      locator.evaluate((el) => {
        const s = getComputedStyle(el);
        return [s.padding, s.borderTopWidth, s.borderTopColor, s.fontWeight, s.backgroundColor];
      });
    // Phorge's own preview below the form renders the same table; the
    // editor hides it, as it shows the same.
    await expect(page.locator(".phui-remarkup-preview")).toBeHidden();
    await page.addStyleTag({ content: ".phui-remarkup-preview { display: block !important; }" });
    const preview = page.locator(".phui-remarkup-preview .remarkup-table");
    await expect(preview).toBeVisible();
    expect(await style(cell(page, "Element"))).toEqual(await style(preview.locator("th").first()));
    expect(await style(cell(page, "Cu"))).toEqual(await style(preview.locator("td", { hasText: "Cu" })));
  });

  test("edit a cell in place, changing only that cell in the text", async ({ page }) => {
    await cell(page, "Fe").click();
    await page.keyboard.type("rrum is iron");
    expect(await source(page)).toBe(`Before.\n\n${TABLE.replace("| Fe |", "| Ferrum is iron |")}\n\nAfter.`);
    // The cell being edited shows its remarkup, the others their rendered content.
    await cell(page, "Ka").first().click();
    await expect(cell(page, "**Ka**").locator(".cm-content")).toBeFocused();
    await expect(cell(page, "Ferrum is iron")).toBeVisible();
    await page.keyboard.press("Control+z");
    expect(await source(page)).toBe(`Before.\n\n${TABLE}\n\nAfter.`);
  });

  test("Tab, Enter and the toolbar change the table around the focused cell", async ({ page }) => {
    await cell(page, "Cu").click();
    await page.keyboard.press("Tab");
    await page.keyboard.press("Tab");
    await page.keyboard.type("Zn");
    await page.keyboard.press("Tab");
    await page.keyboard.type("Ka");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Ni");
    await page
      .locator(".rme-table-bar")
      .getByRole("button", { name: /first row a header/ })
      .click();
    expect(await source(page)).toBe(
      "Before.\n\n| Element | Line\n| Fe      | **Ka**\n| Cu      | Ka\n| Zn      | Ka\n| Ni      | \n\nAfter.",
    );
  });

  test("arrow keys move into, through and out of a table", async ({ page }) => {
    await page.locator(".cm-line", { hasText: "Before." }).click();
    await page.keyboard.press("End");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    await expect(cell(page, "Element").locator(".cm-content")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(cell(page, "Fe").locator(".cm-content")).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("ArrowDown");
    // Out of the table: the text cursor is on the line after it.
    await page.keyboard.type("x");
    expect(await source(page)).toBe(`Before.\n\n${TABLE}\nx\nAfter.`);
  });

  test("toolbar buttons format the selection in a cell", async ({ page }) => {
    await cell(page, "Cu").click();
    await page.keyboard.type(" copper");
    await page.keyboard.press("Shift+Control+ArrowLeft");
    await page.getByRole("link", { name: "Bold" }).click();
    expect(await source(page)).toBe(`Before.\n\n${TABLE.replace("| Cu |", "| Cu **copper** |")}\n\nAfter.`);
    await page
      .locator(".rme-format")
      .and(page.getByRole("button", { name: "Highlight" }))
      .click();
    expect(await source(page)).toBe(`Before.\n\n${TABLE.replace("| Cu |", "| Cu **!!copper!!** |")}\n\nAfter.`);
  });

  test("other cells keep their look while a cell is typed in", async ({ page }) => {
    const width = () => page.locator(".rme-table-editor table").evaluate((t) => t.getBoundingClientRect().width);
    const before = await width();
    await cell(page, "Cu").click();
    for (const key of ["x", "y", "z"]) {
      await page.keyboard.type(key);
      // Right after the key, before the changed table is rendered: the rendered
      // bold text of another cell stays, and so does the table width.
      expect(await page.locator(".rme-table-editor td strong").count()).toBe(1);
      expect(await width()).toBe(before);
    }
  });

  test("typing with spaces is not disturbed by renderings arriving in between", async ({ page }) => {
    // The editor's renderings of the table (Phorge's preview renders the whole text, without separators).
    let renderings = 0;
    page.on("request", (request) => request.postData()?.includes("RMESEP") && renderings++);
    await cell(page, "Cu").click();
    // Slower than the pause after which the table is rendered again (600 ms).
    await page.keyboard.type(" is Cu", { delay: 800 });
    expect(renderings).toBeGreaterThanOrEqual(3);
    expect(await source(page)).toBe(`Before.\n\n${TABLE.replace("| Cu |", "| Cu is Cu |")}\n\nAfter.`);
  });

  test("can be switched to editing as text and back", async ({ page }) => {
    await cell(page, "Cu").click();
    await page.keyboard.type("2");
    await page.locator(".rme-table-bar").getByRole("button", { name: "Edit the table as text" }).click();
    await expect(page.locator(".cm-line.rme-src-table")).toHaveCount(4);
    // The cursor is where it was in the cell.
    await page.keyboard.type("O");
    expect(await source(page)).toBe(`Before.\n\n${TABLE.replace("| Cu |", "| Cu2O |")}\n\nAfter.`);
    await page.locator(".rme-table-bar").getByRole("button", { name: "Edit the table as a table" }).click();
    await expect(cell(page, "Cu2O").locator(".cm-content")).toBeFocused();
    // The choice is remembered: other tables are then edited as text too.
    await page.locator(".rme-table-bar").getByRole("button", { name: "Edit the table as text" }).click();
    // Tall, so all of its lines are drawn.
    await page.setViewportSize({ width: 1280, height: 4000 });
    await openWithEditor(page, "/phriction/edit/2/");
    await page.addStyleTag({ content: ".rme-editor { height: auto !important; max-height: none !important; }" });
    await expect(page.locator(".rme-block-table table.remarkup-table")).toBeVisible();
    await expect(page.locator(".rme-table-editor")).toHaveCount(0);
  });

  test("Enter in an empty last row leaves the table", async ({ page }) => {
    await cell(page, "Cu").click();
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("Next paragraph");
    // Adding and removing a row aligns the table.
    expect(await source(page)).toBe(
      "Before.\n\n| Element | Line\n| ------- | ------\n| Fe      | **Ka**\n| Cu      | Ka\nNext paragraph\nAfter.",
    );
  });
});

test.describe("images", () => {
  test.beforeEach(async ({ page }) => {
    await openNewWikiPage(page, "Images");
    await editor(page).click();
    await page.keyboard.insertText("Before.\n\n{F1}\n\nAfter.");
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    await expect(page.locator(".rme-image-preview img")).toBeVisible();
  });

  test("show their reference only while it is edited, and nothing moves", async ({ page }) => {
    const after = () =>
      page.locator(".cm-line", { hasText: "After." }).evaluate((el) => el.getBoundingClientRect().top);
    const before = await after();
    const line = page.locator(".cm-line").nth(2);
    await expect(line).toHaveText("");
    await line.click();
    await expect(line).toHaveText("{F1}");
    await expect(page.locator(".rme-image-preview img")).toBeVisible();
    expect(await after()).toBeCloseTo(before, 0);
  });

  test("have a context menu to change size, layout and alt text", async ({ page }) => {
    const choose = async (label: string) => {
      await page.locator(".rme-image-preview img").first().click({ button: "right" });
      await page.locator(".rme-image-menu a", { hasText: label }).click();
    };
    const source = () => textarea(page).inputValue();
    await choose("Right");
    await expect.poll(source).toBe("Before.\n\n{F1, layout=right}\n\nAfter.");
    await choose("Full size");
    await expect.poll(source).toBe("Before.\n\n{F1, layout=right, size=full}\n\nAfter.");
    await choose("Text flows around the image");
    await expect.poll(source).toBe("Before.\n\n{F1, layout=right, size=full, float}\n\nAfter.");
    page.once("dialog", (dialog) => dialog.accept("Plot, 2nd try"));
    await choose("Alternative text");
    await expect.poll(source).toBe('Before.\n\n{F1, layout=right, size=full, float, alt="Plot, 2nd try"}\n\nAfter.');
    await choose("Remove image");
    await expect.poll(source).toBe("Before.\n\n\n\nAfter.");
  });
});

test("aligned table source lines up on screen, also with formatted cells", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("phizziwig-table-mode", "text"));
  await openNewWikiPage(page, "Aligned");
  await editor(page).click();
  await page.keyboard.insertText(
    "| Element | Line | Note\n|---|---|---\n| Fe | `Ka` | !!main!! **x**\n| Cu | Ka | T1 and @alice",
  );
  await page
    .locator(".rme-table-bar")
    .getByRole("button", { name: /Align the columns/ })
    .click();
  const pipes = await page.locator(".cm-line.rme-src-table").evaluateAll((lines) =>
    lines.map((line) => {
      const xs: number[] = [];
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const text = node.textContent ?? "";
        for (let i = 0; i < text.length; i++) {
          if (text[i] === "|") {
            const range = document.createRange();
            range.setStart(node, i);
            range.setEnd(node, i + 1);
            xs.push(Math.round(range.getBoundingClientRect().left));
          }
        }
      }
      return xs;
    }),
  );
  expect(pipes).toHaveLength(4);
  for (const row of pipes) {
    expect(row).toEqual(pipes[0]);
  }
});

for (const setting of [null, '13px "DejaVu Sans Mono"']) {
  test(`code blocks have the rendered font while edited${setting ? ", with a Monospaced Font setting" : ""}`, async ({
    page,
  }) => {
    await page.goto(`/phriction/edit/?slug=${encodeURIComponent(`e2e/code-${Date.now()}/`)}`);
    if (setting) {
      // The rule Phorge adds for the user's "Monospaced Font" setting.
      await page.addStyleTag({
        content: `.PhabricatorMonospaced, .phabricator-remarkup .remarkup-code-block .remarkup-code { font: ${setting} !important; }`,
      });
    }
    await addPhlair(page);
    await editor(page).click();
    await page.keyboard.insertText("Before.\n\n```\nfirst line\nsecond line\nthird line\n```\n\nAfter.");
    await page.evaluate(() => (document.activeElement as HTMLElement).blur());
    const rendered = await page.locator(".rme-block .remarkup-code").evaluate((pre) => {
      const s = getComputedStyle(pre);
      const content = pre.getBoundingClientRect().height - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom);
      return { font: [s.fontFamily, s.fontSize], lineHeight: Math.round((content / 3) * 10) / 10 };
    });
    await page.locator(".rme-block-code").click();
    const source = await page.locator(".cm-line.rme-src-code", { hasText: "second line" }).evaluate((line) => {
      const s = getComputedStyle(line);
      return {
        font: [s.fontFamily, s.fontSize],
        lineHeight: Math.round(line.getBoundingClientRect().height * 10) / 10,
      };
    });
    expect(source).toEqual(rendered);
  });
}
