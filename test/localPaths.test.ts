import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chooseSharePointFolders, sharePointOfPath } from "../src/phizziwig/localPaths";
import { sharePointToRemarkup } from "../src/phizziwig/paste";
import { sharePointLink } from "../src/phizziwig/sharepoint";

const SYNCTHING = "https://contoso.sharepoint.com/sites/Firmendaten/Syncthing";
const FOLDER = "https://contoso.sharepoint.com/:f:/r/sites/Firmendaten/Syncthing";

describe("local paths of SharePoint libraries", () => {
  beforeEach(() => {
    chooseSharePointFolders({
      [SYNCTHING]: [
        "JCB Team - Syncthing",
        "Firmendaten - Syncthing",
        "OneDrive - Contoso/Syncthing",
        "SharePoint\\Syncthing",
      ],
      // A shortcut to a folder of the library, by its own name.
      [`${SYNCTHING}/jcb-projekte`]: ["OneDrive - Contoso/jcb-projekte"],
      "https://contoso.sharepoint.com/sites/Verwaltung/Shared%20Documents": ["Verwaltung - Dokumente"],
    });
  });
  afterEach(() => chooseSharePointFolders({}));

  const url = (path: string) => sharePointOfPath(path)?.url ?? null;

  it("links a folder of a library, as Explorer, WSL, macOS, Linux and file URLs write it", () => {
    for (const path of [
      "C:\\Users\\me\\OneDrive - Contoso\\JCB Team - Syncthing\\jcb-vorlagen",
      '"C:\\Users\\me\\OneDrive - Contoso\\JCB Team - Syncthing\\jcb-vorlagen"',
      "  C:\\Users\\me\\Firmendaten - Syncthing\\jcb-vorlagen\\  ",
      "C:/Users/me/OneDrive - Contoso/Syncthing/jcb-vorlagen",
      "/mnt/c/Users/me/OneDrive - Contoso/Syncthing/jcb-vorlagen",
      "/Users/me/Library/CloudStorage/OneDrive-Contoso/JCB Team - Syncthing/jcb-vorlagen",
      "/home/me/SharePoint/Syncthing/jcb-vorlagen",
      "~/SharePoint/syncthing/jcb-vorlagen",
      "file:///C:/Users/me/OneDrive%20-%20Contoso/JCB%20Team%20-%20Syncthing/jcb-vorlagen",
    ]) {
      expect(sharePointOfPath(path), path).toEqual({ url: `${FOLDER}/jcb-vorlagen`, name: "jcb-vorlagen" });
    }
  });

  it("links files by their path, shown in the browser", () => {
    expect(sharePointOfPath("C:\\Users\\me\\JCB Team - Syncthing\\Plans 2026\\Budget [1].xlsx")).toEqual({
      url: `${SYNCTHING}/Plans%202026/Budget%20%5B1%5D.xlsx?web=1`,
      name: "Budget [1].xlsx",
    });
    expect(url("C:\\x\\Verwaltung - Dokumente\\Ä & ö#.pdf")).toBe(
      "https://contoso.sharepoint.com/sites/Verwaltung/Shared%20Documents/%C3%84%20%26%20%C3%B6%23.pdf?web=1",
    );
  });

  it("takes a name whose extension is digits only for a folder", () => {
    expect(sharePointOfPath("C:\\x\\JCB Team - Syncthing\\v1.2")).toEqual({ url: `${FOLDER}/v1.2`, name: "v1.2" });
    expect(url("C:\\x\\JCB Team - Syncthing\\2026.11\\Plan.step")).toBe(`${SYNCTHING}/2026.11/Plan.step?web=1`);
  });

  it('finds names whatever their Unicode form (macOS: "a" and "¨")', () => {
    chooseSharePointFolders({ [SYNCTHING]: ["Gesch\u00e4ft"] });
    expect(url("/Users/me/Gescha\u0308ft/O\u0308l")).toBe(`${FOLDER}/%C3%96l`);
    chooseSharePointFolders({ [SYNCTHING]: ["Gescha\u0308ft"] });
    expect(url("/Users/me/Gesch\u00e4ft/x")).toBe(`${FOLDER}/x`);
  });

  it("links the library itself", () => {
    expect(sharePointOfPath("C:\\Users\\me\\JCB Team - Syncthing")).toEqual({
      url: FOLDER,
      name: "JCB Team - Syncthing",
    });
  });

  it("takes the first library's folder from the left, and of names there the longest", () => {
    // A folder named like a library inside the library.
    expect(url("C:\\Users\\me\\JCB Team - Syncthing\\a\\Firmendaten - Syncthing\\b")).toBe(
      `${FOLDER}/a/Firmendaten%20-%20Syncthing/b`,
    );
    // The shortcut to the folder, not "Syncthing" of another shortcut.
    expect(url("C:\\Users\\me\\OneDrive - Contoso\\jcb-projekte\\852")).toBe(`${FOLDER}/jcb-projekte/852`);
  });

  it("of names in one place, takes the longest, else the first listed", () => {
    chooseSharePointFolders({
      [SYNCTHING]: ["SharePoint/Syncthing", "Twice"],
      [`${SYNCTHING}/jcb-projekte`]: ["Twice", "SharePoint"],
    });
    expect(url("/home/me/SharePoint/Syncthing/x")).toBe(`${FOLDER}/x`);
    expect(url("/home/me/Twice/x")).toBe(`${FOLDER}/x`);
  });

  it("leaves other text and paths as pasted", () => {
    for (const text of [
      // Not in a listed library: "Syncthing" alone is not one of its names.
      "C:\\Program Files\\Syncthing\\config",
      "C:\\Users\\me\\Desktop\\Plans",
      "/home/me/SharePoint/Other/x",
      // No absolute path.
      "JCB Team - Syncthing\\jcb-vorlagen",
      "Syncthing/jcb-vorlagen",
      "see C:\\Users\\me\\JCB Team - Syncthing\\x",
      "C:\\Users\\me\\JCB Team - Syncthing\\a\nC:\\Users\\me\\JCB Team - Syncthing\\b",
      "\\\\server\\share\\JCB Team - Syncthing\\x",
      // Names that leave the folder.
      "C:\\Users\\me\\JCB Team - Syncthing\\..\\Other",
      "/home/me/SharePoint/Syncthing/./x",
      "file:///C:/%E0%A4%A",
      // A file URL of another computer, or with more than a path.
      "file://server/share/JCB%20Team%20-%20Syncthing/x",
      "file:///C:/x/JCB%20Team%20-%20Syncthing/Q#1.docx",
      "file:///C:/x/JCB%20Team%20-%20Syncthing/a?b",
    ]) {
      expect(sharePointOfPath(text), text).toBeNull();
    }
  });

  it("knows no libraries without a valid configuration, and no link without a name", () => {
    for (const config of [
      undefined,
      null,
      [],
      "x",
      { [SYNCTHING]: "JCB Team - Syncthing" },
      { [SYNCTHING]: [1] },
      { "not a URL": ["JCB Team - Syncthing"] },
      { "https://contoso.sharepoint.com/": ["JCB Team - Syncthing"] },
    ]) {
      chooseSharePointFolders(config);
      expect(url("C:\\Users\\me\\JCB Team - Syncthing"), JSON.stringify(config)).toBeNull();
    }
  });

  it("pastes as a link the SharePoint menu knows: a folder with its path, a file with its folder", () => {
    expect(sharePointToRemarkup("C:\\Users\\me\\JCB Team - Syncthing\\jcb-vorlagen")).toBe(
      `[[ ${FOLDER}/jcb-vorlagen | jcb-vorlagen ]]`,
    );
    expect(sharePointLink(`${FOLDER}/jcb-vorlagen`)).toMatchObject({
      kind: "folder",
      fileUrl: `${SYNCTHING}/jcb-vorlagen`,
    });
    expect(sharePointLink(`${SYNCTHING}/Plans/Budget.xlsx?web=1`)).toMatchObject({
      kind: "excel",
      fileUrl: `${SYNCTHING}/Plans/Budget.xlsx`,
      folderUrl: `${SYNCTHING}/Plans/`,
    });
  });

  it("pastes Office's links for its apps as their URL", () => {
    expect(sharePointToRemarkup(`ms-word:ofe|u|${SYNCTHING}/Spec.docx`)).toBe(
      `[[ ${SYNCTHING}/Spec.docx | Spec.docx ]]`,
    );
    expect(sharePointToRemarkup(`ms-excel:ofv|u|${SYNCTHING}/Budget.xlsx`)).toBe(
      `[[ ${SYNCTHING}/Budget.xlsx | Budget.xlsx ]]`,
    );
    expect(sharePointToRemarkup("ms-word:ofe|u|http://evil.com/a.docx")).toBeNull();
  });
});
