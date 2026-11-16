// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { tokenizeInline } from "../src/phizziwig/inline";
import { genericLinkName, htmlToRemarkup, sharePointToRemarkup } from "../src/phizziwig/paste";
import { repairShareLink, sharePointDescription, sharePointLabel, sharePointLink } from "../src/phizziwig/sharepoint";
import { closeDropdown } from "../src/dropdown";
import {
  asRendered,
  closeOpeningNote,
  enhanceSharePointLink,
  enhanceSharePointLinks,
  HELP_AFTER,
  openWays,
  showOpenWays,
} from "../src/phizziwig/sharePointLinks";
import { chooseOptions } from "../src/tools";

const SITE = "https://contoso.sharepoint.com";
const SHARE = `${SITE}/:x:/s/Projects/EaB3c-Xy_Z?e=Ab12cd`;

describe("sharePointLink", () => {
  it("tells a sharing link's kind of file and site, not its name", () => {
    expect(sharePointLink(SHARE)).toEqual({
      kind: "excel",
      site: "Projects",
      desktop: { app: "Excel", uri: `ms-excel:ofe|u|${SHARE}` },
    });
    expect(sharePointLink(`${SITE}/:b:/t/Team%20A/EaB?e=1`)).toEqual({ kind: "pdf", site: "Team A" });
    expect(sharePointLink(`${SITE}/:v:/g/Video/EaB`)).toEqual({ kind: "video", site: "Video" });
    expect(sharePointLink(`${SITE}/:z:/s/A/EaB`)).toEqual({ kind: "file", site: "A" });
    expect(sharePointLink("https://contoso-my.sharepoint.com/:w:/g/personal/ann_contoso_com/EaB?e=1")).toMatchObject({
      kind: "word",
      site: "OneDrive",
    });
  });

  it("reads the path of a sharing link that has one (/r/)", () => {
    expect(sharePointLink(`${SITE}/:f:/r/sites/Projects/Shared%20Documents/Plans?csf=1&web=1`)).toEqual({
      kind: "folder",
      name: "Plans",
      site: "Projects",
      folder: "Shared Documents",
      fileUrl: `${SITE}/sites/Projects/Shared%20Documents/Plans`,
    });
    expect(sharePointLink(`${SITE}/:p:/r/sites/Projects/Shared%20Documents/Kick-off.pptx?d=w1&csf=1`)).toEqual({
      kind: "powerpoint",
      name: "Kick-off.pptx",
      site: "Projects",
      folder: "Shared Documents",
      fileUrl: `${SITE}/sites/Projects/Shared%20Documents/Kick-off.pptx`,
      folderUrl: `${SITE}/sites/Projects/Shared%20Documents/`,
      desktop: {
        app: "PowerPoint",
        uri: `ms-powerpoint:ofe|u|${SITE}/sites/Projects/Shared%20Documents/Kick-off.pptx`,
      },
    });
    // Office's viewer names the file, but its path is only an ID.
    expect(
      sharePointLink(
        `${SITE}/:x:/r/sites/Projects/_layouts/15/Doc.aspx?sourcedoc=%7B12AB%7D&file=Budget%202027.xlsx&action=default`,
      ),
    ).toEqual({ kind: "excel", name: "Budget 2027.xlsx", site: "Projects" });
    expect(sharePointLink(`${SITE}/:x:/r/sites/Projects/_layouts/15/Doc.aspx?sourcedoc=%7B12AB%7D`)).toEqual({
      kind: "excel",
      site: "Projects",
    });
    // A sharing link to a page is no file's: what it is is all it tells.
    expect(sharePointLink(`${SITE}/:u:/r/sites/Projects/SitePages/Home.aspx`)).toEqual({
      kind: "file",
      site: "Projects",
    });
  });

  it("reads files and folders of the address bar", () => {
    const file = `${SITE}/sites/Projects/Shared%20Documents/Q%26A/Budget.xlsx`;
    expect(sharePointLink(`${file}?web=1`)).toEqual({
      kind: "excel",
      name: "Budget.xlsx",
      site: "Projects",
      folder: "Shared Documents/Q&A",
      fileUrl: file,
      folderUrl: `${SITE}/sites/Projects/Shared%20Documents/Q%26A/`,
      desktop: { app: "Excel", uri: `ms-excel:ofe|u|${file}` },
    });
    expect(
      sharePointLink(
        `${SITE}/sites/Projects/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2FProjects%2FShared%20Documents%2FSpec%2Epdf&parent=%2Fsites`,
      ),
    ).toEqual({
      kind: "pdf",
      name: "Spec.pdf",
      site: "Projects",
      folder: "Shared Documents",
      fileUrl: `${SITE}/sites/Projects/Shared%20Documents/Spec.pdf`,
      folderUrl: `${SITE}/sites/Projects/Shared%20Documents/`,
    });
    expect(
      sharePointLink(
        `${SITE}/sites/Projects/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2FProjects%2FShared%20Documents%2FPlans`,
      ),
    ).toMatchObject({ kind: "folder", name: "Plans", folder: "Shared Documents" });
    expect(sharePointLink(`${SITE}/sites/Projects/_layouts/15/Doc.aspx?sourcedoc=%7B12AB%7D&file=Budget.xlsx`)).toEqual(
      { kind: "excel", name: "Budget.xlsx", site: "Projects" },
    );
    expect(sharePointLink(`${SITE}/Shared%20Documents/a.docx`)).toMatchObject({
      kind: "word",
      name: "a.docx",
      folder: "Shared Documents",
    });
    expect(sharePointLink("https://contoso-my.sharepoint.com/personal/ann_contoso_com/Documents/a.txt")).toMatchObject({
      kind: "text",
      site: "OneDrive",
      folder: "Documents",
    });
  });

  it("takes other pages of SharePoint for none of its files", () => {
    expect(sharePointLink("https://contoso-my.sharepoint.com/person.aspx")).toBeNull();
    expect(sharePointLink(`${SITE}/sites/Intranet/SitePages/Holidays.aspx`)).toBeNull();
    expect(sharePointLink(`${SITE}/sites/Intranet`)).toBeNull();
    expect(sharePointLink(`${SITE}/`)).toBeNull();
    expect(sharePointLink(`${SITE}/sites/Intranet/_layouts/15/viewlsts.aspx`)).toBeNull();
    expect(sharePointLink(`${SITE}/sites/Projects/Lists/Tasks`)).toBeNull();
    // A folder without its kind in the URL can not be told from a list or a page.
    expect(sharePointLink(`${SITE}/sites/Projects/Shared%20Documents/Plans`)).toBeNull();
  });

  it("knows only SharePoint's hosts", () => {
    expect(sharePointLink("https://example.com/:x:/s/A/B")).toBeNull();
    expect(sharePointLink("https://contoso.sharepoint.com.example.com/:x:/s/A/B")).toBeNull();
    expect(sharePointLink("https://sharepoint.com/:x:/s/A/B")).toBeNull();
    expect(sharePointLink("ftp://contoso.sharepoint.com/:x:/s/A/B")).toBeNull();
    expect(sharePointLink("no link")).toBeNull();
  });
});

describe("sharePointLabel", () => {
  it("is the name, else the kind and site", () => {
    expect(sharePointLabel({ kind: "excel", name: "Budget.xlsx", site: "Projects" })).toBe("Budget.xlsx");
    expect(sharePointLabel({ kind: "excel", site: "Projects" })).toBe("Excel workbook in Projects");
    expect(sharePointLabel({ kind: "folder" })).toBe("Folder");
  });
});

describe("sharePointDescription", () => {
  it("tells the kind, the name and where the file is, as far as the URL does", () => {
    expect(sharePointDescription(sharePointLink(`${SITE}/sites/Projects/Shared%20Documents/Q%26A/Budget.xlsx`)!)).toBe(
      "Excel workbook: Budget.xlsx\nin Projects › Shared Documents › Q&A",
    );
    expect(sharePointDescription(sharePointLink(SHARE)!)).toBe("Excel workbook\nin Projects");
    expect(sharePointDescription({ kind: "pdf" })).toBe("PDF");
  });
});

describe("repairShareLink", () => {
  it("turns the emoji Phorge made of ':x:' back", () => {
    expect(repairShareLink(`${SITE}/❌/s/Projects/EaB?e=1`)).toBe(`${SITE}/:x:/s/Projects/EaB?e=1`);
    expect(repairShareLink(`${SITE}/%E2%9D%8C/s/Projects/EaB`)).toBe(`${SITE}/:x:/s/Projects/EaB`);
    expect(repairShareLink(`${SITE}/🅱️/s/A/B`)).toBe(`${SITE}/:b:/s/A/B`);
    expect(repairShareLink(`${SITE}/🅱/s/A/B`)).toBe(`${SITE}/:b:/s/A/B`);
    expect(repairShareLink(`${SITE}/✌️/s/A/B`)).toBe(`${SITE}/:v:/s/A/B`);
    expect(repairShareLink(`${SITE}/⭕/s/A/B`)).toBe(`${SITE}/:o:/s/A/B`);
  });

  it("leaves other links", () => {
    expect(repairShareLink(SHARE)).toBe(SHARE);
    expect(repairShareLink(`${SITE}/😄/s/A/B`)).toBe(`${SITE}/😄/s/A/B`);
    expect(repairShareLink("https://example.com/❌/s/A/B")).toBe("https://example.com/❌/s/A/B");
  });
});

describe("pasting SharePoint links", () => {
  it("names a URL pasted alone", () => {
    expect(sharePointToRemarkup(` ${SHARE}\n`)).toBe(`[[ ${SHARE} | Excel workbook in Projects ]]`);
    const file = `${SITE}/sites/Projects/Shared%20Documents/Budget.xlsx?web=1`;
    expect(sharePointToRemarkup(file)).toBe(`[[ ${file} | Budget.xlsx ]]`);
    expect(sharePointToRemarkup("https://example.com/a")).toBeNull();
    expect(sharePointToRemarkup(`see ${SHARE}`)).toBeNull();
    expect(sharePointToRemarkup(`${SHARE}\n${SHARE}`)).toBeNull();
  });

  it("selects a name that is only the kind of file", () => {
    const markup = sharePointToRemarkup(SHARE)!;
    const [from, to] = genericLinkName(markup)!;
    expect(markup.slice(from, to)).toBe("Excel workbook in Projects");
    expect(genericLinkName(sharePointToRemarkup(`${SITE}/sites/P/Shared%20Documents/Budget.xlsx`)!)).toBeNull();
    expect(genericLinkName(`[[ ${SHARE} | Budget ]]`)).toBeNull();
    expect(genericLinkName(`[[ https://example.com/ | Excel workbook in Projects ]]`)).toBeNull();
    expect(genericLinkName(`x [[ ${SHARE} | Excel workbook in Projects ]]`)).toBeNull();
  });

  it("names a link of pasted HTML that shows its URL", () => {
    expect(htmlToRemarkup(`<a href="${SHARE}">${SHARE}</a>`)).toBe(`[[ ${SHARE} | Excel workbook in Projects ]]`);
    expect(htmlToRemarkup(`<a href="${SHARE}">Budget</a>`)).toBe(`[[ ${SHARE} | Budget ]]`);
    expect(htmlToRemarkup(`<a href="https://example.com/a">https://example.com/a</a>`)).toBe("https://example.com/a");
  });
});

describe("the SharePoint rule of the tokenizer", () => {
  const kinds = (text: string, sharePoint: boolean) =>
    tokenizeInline(text, { sharePoint }).map((token) => [token.kind, text.slice(token.from, token.to)]);

  it("links a sharing link before ':x:' becomes an emoji, with the library", () => {
    expect(kinds(`see ${SHARE}.`, true)).toEqual([["url", SHARE]]);
    expect(kinds(`see <${SHARE}>`, true)).toEqual([["url", `<${SHARE}>`]]);
    expect(tokenizeInline(SHARE, { sharePoint: true })[0].children).toBeUndefined();
    // As Phorge renders it without the library: a URL with the emoji in it.
    expect(tokenizeInline(SHARE, { sharePoint: false })[0].children?.map((token) => token.kind)).toEqual(["emoji"]);
  });
});

describe("enhanceSharePointLinks", () => {
  const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0";
  const LINUX = "Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0";
  const FOLDER = `${SITE}/sites/P/Shared%20Documents/Forms/AllItems.aspx?id=%2Fsites%2FP%2FShared%20Documents%2FPlans%202026&viewid=1`;
  const FILE = `${SITE}/sites/P/Shared%20Documents/Plans/Budget.xlsx?web=1`;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
    chooseOptions({});
    closeDropdown();
    closeOpeningNote();
    document.body.innerHTML = "";
  });

  function render(html: string, agent = WINDOWS): HTMLElement {
    vi.stubGlobal("navigator", { userAgent: agent });
    document.body.innerHTML = `<div class="phabricator-remarkup"><p>${html}</p></div>`;
    enhanceSharePointLinks(document);
    return document.querySelector("p")!;
  }

  /** The ways to open a link, as the menu of a click on it shows them; none for a plain link. */
  function waysOfClick(link: HTMLAnchorElement): string[] {
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(click);
    const menu = document.querySelector(".phizziwig-sharepoint-menu");
    expect(click.defaultPrevented).toBe(menu !== null);
    const labels = Array.from(menu?.querySelectorAll(".phabricator-action-view-item") ?? []).map(
      (item) => item.textContent!,
    );
    closeDropdown();
    return labels;
  }

  function ways(href: string, agent = WINDOWS): string[] {
    vi.stubGlobal("navigator", { userAgent: agent });
    return openWays(sharePointLink(href)!, href).map((way) => `${way.group} › ${way.label}: ${way.href}`);
  }

  it("keeps a link's text, with the kind's icon and a tooltip; a click shows the ways to open it", () => {
    const p = render(`<a href="${SHARE}" class="remarkup-link" target="_blank">${SHARE}</a>`);
    const link = p.querySelector<HTMLAnchorElement>("a.phizziwig-sharepoint")!;
    expect(link.textContent).toBe(SHARE);
    expect(link.title).toBe("Excel workbook\nin Projects\nClick to choose how to open it");
    expect(link.getAttribute("href")).toBe(SHARE);
    expect(link.getAttribute("aria-haspopup")).toBe("menu");
    expect(link.querySelector(".phui-icon-view")!.classList).toContain("fa-file-excel-o");
    // Nothing next to the link.
    expect(p.querySelectorAll("a")).toHaveLength(1);
    // Headings, then where each opens it.
    expect(waysOfClick(link)).toEqual(["Open file", "In the browser", "In Excel"]);
  });

  it("keeps the name a link has; a file's folder opens in the browser on every system", () => {
    const p = render(`<a href="${SITE}/sites/P/Shared%20Documents/Spec.pdf">The spec</a>`, LINUX);
    const link = p.querySelector("a")!;
    expect(link.textContent).toBe("The spec");
    expect(link.title).toBe("PDF: Spec.pdf\nin P › Shared Documents\nClick to choose how to open it");
    expect(link.querySelector(".fa-file-pdf-o")).not.toBeNull();
    expect(waysOfClick(link)).toEqual(["Open file", "In the browser", "Open file location", "In the browser"]);
  });

  it("leaves a link with one way to open it a plain link", () => {
    const p = render(`<a href="${FOLDER}">Plans</a> <a href="${SITE}/:b:/s/P/EaB">a PDF</a>`, LINUX);
    for (const link of Array.from(p.querySelectorAll("a"))) {
      expect(link.title).not.toContain("Click");
      expect(link.hasAttribute("aria-haspopup")).toBe(false);
      expect(waysOfClick(link)).toEqual([]);
    }
  });

  it("knows the ways to open a link", () => {
    const folder = `${SITE}/sites/P/Shared%20Documents/Plans%202026`;
    const file = `${SITE}/sites/P/Shared%20Documents/Plans/Budget.xlsx`;
    const location = `${SITE}/sites/P/Shared%20Documents/Plans/`;
    expect(ways(FILE, LINUX)).toEqual([
      `Open file › In the browser: ${FILE}`,
      `Open file location › In the browser: ${location}`,
    ]);
    expect(ways(FILE)).toEqual([
      `Open file › In the browser: ${FILE}`,
      `Open file › In Excel: ms-excel:ofe|u|${file}`,
      `Open file location › In the browser: ${location}`,
    ]);
    // Android has Office's apps.
    expect(ways(SHARE, "Mozilla/5.0 (Linux; Android 15) Chrome/140.0")).toEqual([
      `Open file › In the browser: ${SHARE}`,
      `Open file › In Excel: ms-excel:ofe|u|${SHARE}`,
    ]);
    // With OneDriphe: in Explorer a folder itself, a file at its location.
    chooseOptions({ onedriphe: true });
    expect(ways(FOLDER)).toEqual([
      `Open folder › In the browser: ${FOLDER}`,
      `Open folder › In Explorer: onedriphe:${folder}`,
    ]);
    expect(ways(FILE).at(-1)).toBe(`Open file location › In Explorer: onedriphe:${file}`);
    // On Linux, in the file manager.
    expect(ways(FILE, LINUX)).toEqual([
      `Open file › In the browser: ${FILE}`,
      `Open file location › In the browser: ${location}`,
      `Open file location › In the file manager: onedriphe:${file}`,
    ]);
    // Not for sharing links, which have no path, nor where OneDriphe is not: macOS, Android, ChromeOS.
    expect(ways(SHARE).some((way) => way.includes("onedriphe:"))).toBe(false);
    for (const agent of [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) Safari/605.1.15",
      "Mozilla/5.0 (Linux; Android 15) Chrome/140.0",
      "Mozilla/5.0 (X11; CrOS x86_64 16000.0.0) Chrome/140.0",
    ]) {
      expect(ways(FOLDER, agent)).toEqual([`Open folder › In the browser: ${FOLDER}`]);
    }
  });

  it("opens the chosen way: a page as the link would, an app with a note until it took the focus", () => {
    vi.useFakeTimers();
    const followed: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      followed.push(`${this.getAttribute("href")} ${this.target || "here"}`);
    });
    /** Clicks the item of the menu under a heading. */
    const choose = (link: HTMLAnchorElement, heading: string, label: string) => {
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      let under = "";
      for (const item of Array.from(document.querySelectorAll(".phabricator-action-view-item"))) {
        if (!(item instanceof HTMLAnchorElement)) {
          under = item.textContent!;
        } else if (under === heading && item.textContent === label) {
          item.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
          return;
        }
      }
      throw new Error(`No "${label}" under "${heading}"`);
    };
    const p = render(`<a href="${FILE}" target="_blank">Budget</a>`);
    const link = p.querySelector("a")!;

    choose(link, "Open file location", "In the browser");
    expect(followed.pop()).toBe(`${SITE}/sites/P/Shared%20Documents/Plans/ _blank`);
    expect(document.querySelector(".phizziwig-sharepoint-note")).toBeNull();

    choose(link, "Open file", "In Excel");
    expect(followed.pop()).toBe(`ms-excel:ofe|u|${SITE}/sites/P/Shared%20Documents/Plans/Budget.xlsx here`);
    const note = () => document.querySelector(".phizziwig-sharepoint-note");
    expect(note()!.textContent).toBe("Opening in Excel…");
    vi.advanceTimersByTime(HELP_AFTER);
    expect(note()!.textContent).toBe(
      "Nothing happening? If the browser asks, allow it to open Excel. Without Excel on this computer: open it in the browser.",
    );
    expect(note()!.querySelector("a")!.getAttribute("href")).toBe(FILE);
    // Excel took the focus.
    window.dispatchEvent(new Event("blur"));
    expect(note()).toBeNull();

    chooseOptions({ onedriphe: true });
    const explorer = render(`<a href="${FILE}">Budget</a>`).querySelector("a")!;
    choose(explorer, "Open file location", "In Explorer");
    expect(note()!.textContent).toBe("Opening in Explorer…");
    vi.advanceTimersByTime(HELP_AFTER);
    expect(note()!.textContent).toContain(
      "allow it to open OneDriphe. Without OneDriphe on this computer: install it.",
    );
    expect(note()!.querySelector("a")!.getAttribute("href")).toBe("/settings/panel/phlair/");
    note()!.querySelector<HTMLButtonElement>("button")!.click();
    expect(note()).toBeNull();

    const linux = render(`<a href="${FILE}">Budget</a>`, LINUX).querySelector("a")!;
    choose(linux, "Open file location", "In the file manager");
    expect(note()!.textContent).toBe("Opening in the file manager…");
    vi.advanceTimersByTime(HELP_AFTER);
    expect(note()!.textContent).toContain(
      "allow it to open OneDriphe. Without OneDriphe on this computer: install it.",
    );
  });

  it("leaves Ctrl+click, a click in the editor, and other buttons to the browser and the editor", () => {
    const p = render(`<a href="${FILE}">Budget</a>`);
    const link = p.querySelector("a")!;
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }]) {
      const click = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
      link.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(false);
    }
    expect(document.querySelector(".phizziwig-sharepoint-menu")).toBeNull();
    // The editor's links: Ctrl+click shows the menu (openLink.ts), a click edits.
    document.body.innerHTML = `<div class="rme-editor"><a href="${FILE}">Budget</a></div>`;
    const inEditor = document.querySelector("a")!;
    enhanceSharePointLink(inEditor);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 });
    inEditor.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    expect(showOpenWays(inEditor)).toBe(true);
    expect(document.querySelector(".phizziwig-sharepoint-menu")).not.toBeNull();
    expect(showOpenWays(document.createElement("a"))).toBe(false);
  });

  it("repairs a link Phorge broke", () => {
    const broken = `${SITE}/❌/s/Projects/EaB`;
    const p = render(`<a href="${broken}" class="remarkup-link">${broken}</a>`);
    const link = p.querySelector("a")!;
    expect(link.getAttribute("href")).toBe(`${SITE}/:x:/s/Projects/EaB`);
    expect(link.textContent).toBe(`${SITE}/:x:/s/Projects/EaB`);
  });

  it("can be undone in a copy, for the text as Phorge rendered it", () => {
    const broken = `${SITE}/❌/s/Projects/EaB`;
    const p = render(`<a href="${broken}">${broken}</a> and <a href="${SITE}/sites/P/Shared%20Documents/a.docx">a</a>`);
    const copy = p.cloneNode(true) as HTMLElement;
    asRendered(copy);
    expect(copy.textContent).toBe(`${broken} and a`);
    expect(copy.querySelector(".phui-icon-view")).toBeNull();
    expect(p.textContent).toBe(`${SITE}/:x:/s/Projects/EaB and a`);
  });

  it("leaves other links, the editor, and links it did already", () => {
    const person = "https://contoso-my.sharepoint.com/person.aspx";
    const p = render(
      `<a href="https://example.com/a">https://example.com/a</a><a href="${person}">${person}</a><a href="${SHARE}">${SHARE}</a>`,
    );
    expect(p.querySelector("a")!.outerHTML).toBe(`<a href="https://example.com/a">https://example.com/a</a>`);
    expect(p.querySelectorAll("a")[1].outerHTML).toBe(`<a href="${person}">${person}</a>`);
    enhanceSharePointLinks(document);
    expect(p.querySelectorAll(".phui-icon-view")).toHaveLength(1);

    document.body.innerHTML = `<div class="rme-editor"><div class="phabricator-remarkup"><a href="${SHARE}">${SHARE}</a></div></div>`;
    enhanceSharePointLinks(document);
    expect(document.querySelector("a")!.textContent).toBe(SHARE);
  });
});
