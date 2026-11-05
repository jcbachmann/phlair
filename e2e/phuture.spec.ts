// Phuture, the snoozing of list items, as the userscript adds it. Each test
// lists only tasks it created ("/maniphest/?ids=..."), as tests run in
// parallel against the same Phorge; the snoozes are in each test's browser.

import { readFileSync } from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { AUTH_FILE } from "./env";
import { addPhlair, conduit } from "./helpers";

/** Creates tasks and returns their IDs. */
async function createTasks(page: Page, ...titles: string[]): Promise<number[]> {
  await page.goto("/maniphest/");
  const ids: number[] = [];
  for (const title of titles) {
    const task = await conduit(page, "maniphest.edit", { transactions: [{ type: "title", value: title }] });
    ids.push(task.object.id);
  }
  return ids;
}

/** Opens a list of the tasks, with Phlair. */
async function openList(page: Page, ids: number[]): Promise<void> {
  await page.goto(`/maniphest/?ids=${ids.join(",")}`);
  await addPhlair(page);
  await expect(page.locator(".phuture-menu-button")).toBeVisible();
}

function item(page: Page, id: number): Locator {
  return page.locator("li.phui-oi").filter({ has: page.locator(`a.phui-oi-link[href="/T${id}"]`) });
}

/** The item's snooze button; workboards show it on hover only. */
async function snoozeButton(page: Page, id: number): Promise<Locator> {
  await item(page, id).hover();
  return item(page, id).locator(".phuture-action a");
}

async function snooze(page: Page, id: number, choice: string | RegExp): Promise<void> {
  await (await snoozeButton(page, id)).click();
  await page.locator(".phuture-menu").getByRole("link", { name: choice }).click();
}

async function mainMenu(page: Page, choice: string): Promise<void> {
  await page.locator(".phuture-menu-button").click();
  await page.locator(".phuture-menu").getByRole("link", { name: choice }).click();
}

const count = (page: Page) => page.locator(".phuture-menu-button .phabricator-main-menu-alert-count");

test("a snoozed item is hidden on every list, until it is woken up", async ({ page }) => {
  const [first, second] = await createTasks(page, "Snooze me", "Keep me");
  await openList(page, [first, second]);
  await expect(page.locator("li.phui-oi .phuture-action")).toHaveCount(2);
  await expect(count(page)).toBeHidden();

  await snooze(page, first, /^Tomorrow/);
  await expect(item(page, first)).toBeHidden();
  await expect(item(page, second)).toBeVisible();
  await expect(count(page)).toHaveText("1");
  await expect(page.locator(".phuture-menu-button")).toHaveAttribute(
    "aria-label",
    /^1 snoozed item on this page, hidden/,
  );

  // Another list, after a reload.
  await openList(page, [first]);
  await expect(item(page, first)).toBeHidden();

  // The clock opens its menu and closes it again.
  await page.locator(".phuture-menu-button").click();
  await expect(page.locator(".phuture-menu")).toBeVisible();
  await page.locator(".phuture-menu-button").click();
  await expect(page.locator(".phuture-menu")).toHaveCount(0);

  await mainMenu(page, "Show snoozed items");
  await expect(item(page, first)).toBeVisible();
  await expect(count(page)).toBeHidden();
  const button = await snoozeButton(page, first);
  await expect(button).toHaveText("+1");
  await expect(button).toHaveAttribute("aria-label", /^Snoozed until /);

  await button.click();
  await expect(page.locator(".phuture-menu")).toContainText("Snoozed until");
  await page.locator(".phuture-menu").getByRole("link", { name: "Wake up now" }).click();
  await expect(button).toHaveText("");
  await expect(button).toHaveAttribute("aria-label", "Snooze");
  await mainMenu(page, "Show snoozed items");
  await expect(item(page, first)).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem("phuture-snoozes"))).toBeNull();
});

test("snoozing until a picked day", async ({ page }) => {
  const [id] = await createTasks(page, "Snooze me until a day");
  await page.clock.setFixedTime(new Date("2026-11-02T12:00:00Z"));
  await openList(page, [id]);
  await snooze(page, id, "Pick a day…");
  const picker = page.locator("input.phuture-date");
  // Not before tomorrow.
  await expect(picker).toHaveAttribute("min", "2026-11-03");
  await picker.fill("2026-11-20");
  await expect(item(page, id)).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem("phuture-snoozes"))).toBe(`{"T${id}":"2026-11-20"}`);
  await expect(picker).toHaveCount(0);
});

// The old plugin woke items up an hour late east of UTC (and a day early
// west of it): it took the UTC midnight of the day for its local one.
// 23:30 on 4 November in each zone.
const LATE_EVENING = {
  "Europe/Berlin": "2026-11-04T23:30:00+01:00",
  "America/New_York": "2026-11-04T23:30:00-05:00",
};
for (const [timezoneId, lateEvening] of Object.entries(LATE_EVENING)) {
  test.describe(timezoneId, () => {
    test.use({ timezoneId });

    test("items wake up when their day begins, while the page is open", async ({ page }) => {
      const [id] = await createTasks(page, `Snoozed overnight in ${timezoneId}`);
      await page.clock.install({ time: new Date(lateEvening) });
      await openList(page, [id]);
      await snooze(page, id, /^Tomorrow/);
      await expect(item(page, id)).toBeHidden();
      expect(await page.evaluate(() => localStorage.getItem("phuture-snoozes"))).toBe(`{"T${id}":"2026-11-05"}`);

      await page.clock.runFor("29:00");
      await expect(item(page, id)).toBeHidden();
      await page.clock.runFor("02:00");
      await expect(item(page, id)).toBeVisible();
      expect(await page.evaluate(() => localStorage.getItem("phuture-snoozes"))).toBeNull();
    });
  });
}

test("the snoozes of the old plugin are taken over", async ({ page }) => {
  const [id, other] = await createTasks(page, "Snoozed by the old plugin", "Not snoozed");
  await page.goto("/maniphest/");
  await page.evaluate(
    ([id, other]) => {
      const inThreeDays = new Date();
      inThreeDays.setDate(inThreeDays.getDate() + 3);
      inThreeDays.setHours(0, 0, 0, 0);
      localStorage.setItem(`T${id}`, inThreeDays.toISOString());
      const yesterday = new Date(Date.now() - 86_400_000);
      localStorage.setItem(`T${other}`, yesterday.toISOString());
      localStorage.setItem("snooze override show", "false");
    },
    [id, other],
  );
  await openList(page, [id, other]);
  await expect(item(page, id)).toBeHidden();
  await expect(item(page, other)).toBeVisible();
  await mainMenu(page, "Show snoozed items");
  await expect(await snoozeButton(page, id)).toHaveText("+3");
  expect(await page.evaluate(() => Object.keys(localStorage).sort())).toEqual([
    "phuture-show-snoozed",
    "phuture-snoozes",
    "phuture-took-over-old-snoozes",
  ]);
});

test("snoozes go to another browser by export and import", async ({ page, browser }) => {
  const [id] = await createTasks(page, "Snoozed elsewhere");
  await openList(page, [id]);
  await snooze(page, id, "In a week");
  const downloading = page.waitForEvent("download");
  await mainMenu(page, "Export snoozes");
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("phuture-snoozes.json");
  const file = await download.path();
  expect(JSON.parse(readFileSync(file, "utf8")).snoozes).toHaveProperty(`T${id}`);

  const other = await browser.newPage({ storageState: AUTH_FILE });
  try {
    await openList(other, [id]);
    await expect(item(other, id)).toBeVisible();
    const choosing = other.waitForEvent("filechooser");
    await mainMenu(other, "Import snoozes…");
    await (await choosing).setFiles(file);
    await expect(other.locator(".phuture-note")).toHaveText("Imported 1 snooze.");
    await expect(item(other, id)).toBeHidden();
  } finally {
    await other.close();
  }
});

test("items that lists add later get a snooze button too", async ({ page }) => {
  const [id, later] = await createTasks(page, "There from the start", "Added later");
  await openList(page, [id]);
  await snooze(page, id, /^Tomorrow/);
  await page.evaluate(
    ([id, later]) => {
      const original = document.querySelector(`a.phui-oi-link[href="/T${id}"]`)!.closest("li")!;
      for (const target of [id, later]) {
        // As Phorge renders it, without Phuture's button.
        const copy = original.cloneNode(true) as HTMLElement;
        copy.className = "phui-oi phui-oi-standard";
        copy.querySelector(".phui-oi-actions")!.remove();
        copy.querySelector("a.phui-oi-link")!.setAttribute("href", `/T${target}`);
        original.parentElement!.append(copy);
      }
    },
    [id, later],
  );
  await expect(item(page, later)).toBeVisible();
  await expect(item(page, later).locator(".phuture-action")).toHaveCount(1);
  await expect(item(page, id)).toHaveCount(2);
  await expect(item(page, id).first()).toBeHidden();
  await expect(item(page, id).last()).toBeHidden();
  await expect(count(page)).toHaveText("2");
});

test("cards on workboards are snoozed too, next to their own action", async ({ page }) => {
  await page.goto("/project/");
  const name = `Snooze board ${Date.now()}`;
  const project = await conduit(page, "project.edit", { transactions: [{ type: "name", value: name }] });
  const task = await conduit(page, "maniphest.edit", {
    transactions: [
      { type: "title", value: "A card to snooze" },
      { type: "projects.set", value: [project.object.phid] },
    ],
  });
  const id: number = task.object.id;
  await page.goto(`/project/board/${project.object.id}/`);
  await page.getByRole("button", { name: "Create Workboard" }).click();
  await expect(item(page, id)).toBeVisible();
  await addPhlair(page);

  // Phorge's edit button keeps its place; the card makes room for both.
  await expect(item(page, id).locator(".phui-oi-actions > li")).toHaveCount(2);
  await expect(item(page, id)).toContainClass("phui-oi-with-2-actions");
  await expect(item(page, id)).not.toContainClass("phui-oi-with-1-actions");
  await snooze(page, id, /^Tomorrow/);
  await expect(item(page, id)).toBeHidden();
});

/** Adds HTML to the list of the page, as Phorge renders it later (e.g. a dialog), and waits for Phuture to see it. */
async function addToPage(page: Page, html: string): Promise<void> {
  await page.evaluate((html) => {
    const box = document.createElement("div");
    box.innerHTML = html;
    document.querySelector(".phui-oi-list-view")!.after(box);
  }, html);
}

test("commits, as in audit lists, can be snoozed: their items have a menu", async ({ page }) => {
  const [id] = await createTasks(page, "Beside a commit");
  await openList(page, [id]);
  // A commit as DiffusionCommitGraphView renders it (with PHP, in dev/phorge), with its menu.
  const hash = `rDEMO${Date.now().toString(16)}`;
  await addToPage(
    page,
    `<ul class="phui-oi-list-view phui-oi-list-flush "><li class="phui-oi phui-oi-no-bar phui-oi-enabled phui-oi-standard" data-sigil=""><div class="phui-oi-frame"><div class="fuel-grid-tablet fuel-grid-component"><div class="fuel-grid"><div class="fuel-grid-body"><div class="fuel-grid-row fuel-grid-cell-count-2"><div class="fuel-grid-cell"><div class="phui-oi-frame-content"><div class="phui-oi-content-box"><div class="phui-oi-table"><div class="phui-oi-table-row"><div class="phui-oi-col1"><div class="phui-oi-name"><span class="phui-oi-objname" data-sigil="ungrabbable">rDEMOabc123</span> <a href="/${hash}" class="phui-oi-link" title="Fix the detector">Fix the detector</a></div><div class="phui-oi-content"></div></div></div></div></div></div></div><div class="phui-oi-menu fuel-grid-cell"><div class="fuel-menu-component"><div class="fuel-menu"><div class="fuel-menu-item fuel-menu-item-background-color-orange has-link"><a href="/${hash}" class="fuel-menu-item-link"><span class="fuel-menu-item-icon"><span class="visual-only phui-icon-view phui-font-fa fa-exclamation-circle orange" aria-hidden="true"></span></span>Needs Audit</a></div></div></div></div></div></div></div></div></div></li></ul>`,
  );
  const commit = page.locator("li.phui-oi").filter({ has: page.locator(`a.phui-oi-link[href="/${hash}"]`) });
  await commit.hover();
  await commit.locator(".phuture-action a").click();
  await page
    .locator(".phuture-menu")
    .getByRole("link", { name: /^Tomorrow/ })
    .click();
  await expect(commit).toBeHidden();
  await expect(item(page, id)).toBeVisible();
  await expect(count(page)).toHaveText("1");
});

test("choices like Choose Subtype of a new task have no snooze button", async ({ page }) => {
  const [id] = await createTasks(page, "Beside the choices");
  await openList(page, [id]);
  // Clickable items as ManiphestTaskSubtaskController renders them (with PHP, in dev/phorge); on a page, and in a dialog.
  const choice = (href: string, extra = "") =>
    `<ul class="phui-oi-list-view phui-oi-list-flush phui-oi-list-big "><li class="phui-oi phui-oi-with-attrs phui-oi-no-bar phui-oi-enabled ${extra} phui-oi-standard" data-sigil="linked-container"><div class="phui-oi-frame"><div class="phui-oi-frame-content"><div class="phui-oi-content-box"><div class="phui-oi-table"><div class="phui-oi-table-row"><div class="phui-oi-col1"><div class="phui-oi-name"><a href="${href}" class="phui-oi-link" title="Bug Report">Bug Report</a></div><div class="phui-oi-content"><ul class="phui-oi-attributes"><li class="phui-oi-attribute">Bug</li></ul></div></div></div></div></div></div></div></li></ul>`;
  // With a task as Phorge renders it, whose button shows that Phuture has seen what was added.
  const task = await item(page, id).evaluate((li) => {
    const copy = li.cloneNode(true) as HTMLElement;
    copy.className = "phui-oi phui-oi-standard";
    copy.querySelector(".phui-oi-actions")!.remove();
    return `<ul class="phui-oi-list-view">${copy.outerHTML}</ul>`;
  });
  await addToPage(
    page,
    choice("/maniphest/task/edit/form/2/?parent=1", "phui-oi-linked-container") +
      `<div class="aphront-dialog-view">${choice("/maniphest/task/edit/form/3/")}</div>` +
      task,
  );
  await expect(item(page, id).last().locator(".phuture-action")).toHaveCount(1);
  await expect(page.locator(`a.phui-oi-link[href^="/maniphest/task/edit/form/"]`)).toHaveCount(2);
  await expect(page.locator(".phuture-action")).toHaveCount(2);
});
