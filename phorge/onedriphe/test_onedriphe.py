"""Tests of onedriphe.py and install.sh (npm run test:linux: python3 -m unittest in this folder)."""

import io
import os
import shutil
import stat
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

import onedriphe
from onedriphe import Action, Library

HERE = Path(__file__).resolve().parent
SITE = "https://contoso.sharepoint.com/sites/Projects"


def url(link):
    return onedriphe.sharepoint_url(link)


class Links(unittest.TestCase):
    def test_takes_https_links_to_sharepoint(self):
        self.assertEqual(url(f"onedriphe:{SITE}/Docs/A").path, "/sites/Projects/Docs/A")
        self.assertIsNotNone(url(f"{SITE}/Docs"))
        self.assertIsNotNone(url("https://Contoso.SharePoint.com/sites/P"))

    def test_ignores_other_links(self):
        for link in [
            "onedriphe:http://contoso.sharepoint.com/sites/P",
            "onedriphe:https://contoso.sharepoint.com.evil.com/sites/P",
            "onedriphe:https://evil.com/contoso.sharepoint.com/",
            "onedriphe:https://sharepoint.com/sites/P",
            "onedriphe:https://a.b.sharepoint.com/sites/P",
            "onedriphe:https://me@contoso.sharepoint.com/sites/P",
            "onedriphe:https://contoso.sharepoint.com:8443/sites/P",
            "onedriphe:https://contoso.sharepoint.com\\@evil.com/sites/P",
            "onedriphe:https://contoso.sharepoint.com/sites/P Q",
            "onedriphe:https://contoso.sharepoint.com/sites/P\n",
            "onedriphe:file:///etc",
            "onedriphe:https://[contoso.sharepoint.com/sites/P",
            "onedriphe:https://contoso.sharepoint.com\uff03@evil.com/",
            "onedriphe:",
        ]:
            self.assertIsNone(url(link), link)

    def test_segments_are_decoded(self):
        self.assertEqual(onedriphe.path_segments(url(f"{SITE}/Shared%20Documents/%C3%9Cbersicht/")),
                         ["sites", "Projects", "Shared Documents", "Übersicht"])  # fmt: skip
        self.assertIsNone(onedriphe.path_segments(url(f"{SITE}/%FF")))

    def test_browser_url_of_a_file_is_its_folder(self):
        self.assertEqual(onedriphe.browser_url(url(f"{SITE}/Docs/Plans/Budget%202026.xlsx")), f"{SITE}/Docs/Plans/")
        self.assertEqual(onedriphe.browser_url(url(f"{SITE}/Docs/Plans")), f"{SITE}/Docs/Plans")
        self.assertEqual(onedriphe.browser_url(url(f"{SITE}/Docs/v1.0")), f"{SITE}/Docs/")
        for folder in ["Plans.", "Archive.2020-2025"]:
            self.assertEqual(onedriphe.browser_url(url(f"{SITE}/Docs/{folder}")), f"{SITE}/Docs/{folder}")


class Mapping(unittest.TestCase):
    libraries = [
        Library(f"{SITE}/Shared%20Documents/Plans/2026", "/shortcut/2026"),
        Library(f"{SITE}/Shared%20Documents/", "/mnt/projects"),
        Library("https://contoso-my.sharepoint.com/personal/me_contoso_com/Documents", "/mnt/me"),
        Library("not a url", "/x"),
        Library("https://contoso.sharepoint.com/", "/whole-site"),
    ]

    def match(self, link):
        return onedriphe.library_match(url(link), self.libraries)

    def test_the_longest_library_wins(self):
        self.assertEqual(self.match(f"{SITE}/Shared%20Documents/Plans/2026/Q1"), ("/shortcut/2026", ["Q1"]))
        self.assertEqual(self.match(f"{SITE}/Shared%20Documents/Plans/2025"), ("/mnt/projects", ["Plans", "2025"]))
        self.assertEqual(self.match(f"{SITE}/shared%20documents/plans"), ("/mnt/projects", ["plans"]))
        self.assertEqual(self.match(f"{SITE}/Shared%20Documents"), ("/mnt/projects", []))
        self.assertEqual(self.match("https://contoso-my.sharepoint.com/personal/me_contoso_com/Documents/A"),
                         ("/mnt/me", ["A"]))  # fmt: skip

    def test_the_first_of_two_lines_for_a_library_wins(self):
        libraries = [Library(f"{SITE}/Docs", "/first"), Library(f"{SITE}/docs/", "/second")]
        self.assertEqual(onedriphe.library_match(url(f"{SITE}/Docs/A"), libraries), ("/first", ["A"]))

    def test_a_folder_not_from_the_root_is_left_out(self):
        libraries = [Library(f"{SITE}/Docs", "SharePoint/Docs"), Library(f"{SITE}/Docs", "-x")]
        self.assertIsNone(onedriphe.library_match(url(f"{SITE}/Docs/A"), libraries))

    def test_no_library(self):
        self.assertIsNone(self.match(f"{SITE}/Other/A"))
        self.assertIsNone(self.match("https://fabrikam.sharepoint.com/sites/Projects/Shared%20Documents/A"))
        self.assertIsNone(self.match(f"{SITE}/Shared%20Docu"))

    def test_names_stay_in_the_library(self):
        for rest in ["..", "../Other", "A/../..", ".", "a%2F..%2F..", "%2E%2E", "a%00b", "%0A"]:
            self.assertIsNone(self.match(f"{SITE}/Shared%20Documents/{rest}"), rest)
        self.assertEqual(self.match(f"{SITE}/Shared%20Documents/..a/b.."), ("/mnt/projects", ["..a", "b.."]))

    def test_reads_the_list(self):
        with tempfile.TemporaryDirectory() as home, mock.patch.dict(os.environ, {"HOME": home}):
            file = Path(home, "libraries")
            file.write_text(
                "# comment\n\n"
                f"  {SITE}/Shared%20Documents   ~/SharePoint/Projects - Docs  \n"
                "only-one-part\n"
                f"#{SITE}/X /x\n",
                encoding="utf-8",
            )
            self.assertEqual(onedriphe.read_libraries(file),
                             [Library(f"{SITE}/Shared%20Documents", f"{home}/SharePoint/Projects - Docs")])  # fmt: skip
            self.assertEqual(onedriphe.read_libraries(Path(home, "missing")), [])


class Folders(unittest.TestCase):
    def setUp(self):
        self.base = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.base)
        self.root = self.base / "library"
        (self.root / "Plans" / "Q1").mkdir(parents=True)
        (self.root / "Plans" / "Budget.xlsx").write_text("x")
        (self.root / "Same").mkdir()
        (self.root / "same").mkdir()
        (self.base / "outside").mkdir()
        (self.base / "outside" / "secret.txt").write_text("x")
        (self.root / "Out").symlink_to(self.base / "outside")
        (self.root / "In").symlink_to(self.root / "Plans")

    def target(self, *names):
        return onedriphe.manager_target(str(self.root), list(names))

    def test_a_folder_opens_and_a_file_is_selected(self):
        self.assertEqual(self.target(), Action("open", str(self.root)))
        self.assertEqual(self.target("Plans", "Q1"), Action("open", str(self.root / "Plans" / "Q1")))
        self.assertEqual(self.target("Plans", "Budget.xlsx"), Action("select", str(self.root / "Plans" / "Budget.xlsx")))

    def test_a_missing_file_gives_its_folder(self):
        self.assertEqual(self.target("Plans", "Old.docx"), Action("open", str(self.root / "Plans")))
        self.assertIsNone(self.target("Plans", "Q2"))
        self.assertIsNone(self.target("Gone", "Old.docx"))

    def test_names_in_another_case(self):
        self.assertEqual(self.target("plans", "q1"), Action("open", str(self.root / "Plans" / "Q1")))
        self.assertEqual(self.target("Plans", "BUDGET.XLSX"), Action("select", str(self.root / "Plans" / "Budget.xlsx")))
        # Two that differ only in case: the one written.
        self.assertEqual(self.target("same"), Action("open", str(self.root / "same")))
        self.assertIsNone(self.target("SAME"))

    def test_symbolic_links_stay_in_the_library(self):
        self.assertIsNone(self.target("Out"))
        self.assertIsNone(self.target("Out", "secret.txt"))
        self.assertIsNone(self.target("Out", "missing.txt"))
        self.assertEqual(self.target("In", "Q1"), Action("open", str(self.root / "In" / "Q1")))

    def test_a_library_whose_folder_is_missing(self):
        self.assertIsNone(onedriphe.manager_target(str(self.base / "unmounted"), ["Plans"]))

    def test_a_click(self):
        libraries = [Library(f"{SITE}/Docs", str(self.root))]
        self.assertEqual(onedriphe.click_action(url(f"{SITE}/Docs/Plans/Budget.xlsx"), libraries),
                         Action("select", str(self.root / "Plans" / "Budget.xlsx")))  # fmt: skip
        self.assertEqual(onedriphe.click_action(url(f"{SITE}/Docs/Gone/A.pdf"), libraries),
                         Action("browser", f"{SITE}/Docs/Gone/"))  # fmt: skip
        self.assertEqual(onedriphe.click_action(url(f"{SITE}/Other/A.pdf"), libraries),
                         Action("browser", f"{SITE}/Other/"))  # fmt: skip


class Opening(unittest.TestCase):
    def setUp(self):
        patch = mock.patch.dict(os.environ, {"XDG_ACTIVATION_TOKEN": "", "DESKTOP_STARTUP_ID": ""})
        patch.start()
        self.addCleanup(patch.stop)

    def run_perform(self, action, shown=True):
        with mock.patch("subprocess.run") as run, mock.patch("subprocess.Popen") as popen:
            run.return_value.returncode = 0 if shown else 1
            onedriphe.perform(action)
        calls = [call.args[0] for call in run.call_args_list] + [call.args[0] for call in popen.call_args_list]
        return calls

    def test_the_file_manager_selects_a_file(self):
        calls = self.run_perform(Action("select", "/mnt/a b/c,d#.txt"))
        self.assertEqual(calls, [["busctl", "--user", "call", "org.freedesktop.FileManager1",
                                  "/org/freedesktop/FileManager1", "org.freedesktop.FileManager1", "ShowItems", "ass",
                                  "1", "file:///mnt/a%20b/c%2Cd%23.txt", ""]])  # fmt: skip

    def test_the_file_manager_gets_the_browsers_token_to_come_to_the_front(self):
        with mock.patch.dict(os.environ, {"XDG_ACTIVATION_TOKEN": "token-1", "DESKTOP_STARTUP_ID": "id-2"}):
            self.assertEqual(self.run_perform(Action("open", "/mnt/a"))[0][-1], "token-1")
        with mock.patch.dict(os.environ, {"XDG_ACTIVATION_TOKEN": "", "DESKTOP_STARTUP_ID": "id-2"}):
            self.assertEqual(self.run_perform(Action("open", "/mnt/a"))[0][-1], "id-2")

    def test_the_file_manager_opens_a_folder(self):
        self.assertEqual(self.run_perform(Action("open", "/mnt/a"))[0][6:], ["ShowFolders", "ass", "1", "file:///mnt/a", ""])

    def test_without_the_file_managers_interface_xdg_open_shows_the_folder(self):
        self.assertEqual(self.run_perform(Action("select", "/mnt/a/b.txt"), shown=False)[-1], ["xdg-open", "/mnt/a"])
        self.assertEqual(self.run_perform(Action("open", "/mnt/a"), shown=False)[-1], ["xdg-open", "/mnt/a"])

    def test_the_browser(self):
        self.assertEqual(self.run_perform(Action("browser", f"{SITE}/Docs/")), [["xdg-open", f"{SITE}/Docs/"]])


class Command(unittest.TestCase):
    def setUp(self):
        self.home = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.home)
        patch = mock.patch.dict(os.environ, {"HOME": self.home, "XDG_CONFIG_HOME": "", "XDG_CACHE_HOME": ""})
        patch.start()
        self.addCleanup(patch.stop)
        Path(self.home, "Docs", "Plans").mkdir(parents=True)
        Path(self.home, ".config", "onedriphe").mkdir(parents=True)
        Path(self.home, ".config", "onedriphe", "libraries").write_text(f"{SITE}/Docs ~/Docs\n")

    def main(self, *argv):
        output = io.StringIO()
        with redirect_stdout(output):
            code = onedriphe.main(list(argv))
        return code, output.getvalue()

    def test_explain(self):
        self.assertEqual(self.main("--explain", f"onedriphe:{SITE}/Docs/Plans"), (0, f"open {self.home}/Docs/Plans\n"))
        self.assertEqual(self.main("--explain", "onedriphe:https://evil.com/"),
                         (1, "nothing: not an https link to SharePoint\n"))  # fmt: skip

    def test_list(self):
        with open(Path(self.home, ".config", "onedriphe", "libraries"), "a") as file:
            file.write(f"{SITE}/Other SharePoint/Other\nhttp://x/ /x\n")
        code, output = self.main("--list")
        self.assertEqual(code, 0)
        self.assertIn(f"{SITE}/Docs\n    {self.home}/Docs\n", output)
        self.assertIn(f"{SITE}/Other\n    SharePoint/Other  (not a folder from / or ~: left out)\n", output)
        self.assertIn("http://x/\n    /x  (not an https URL of a SharePoint library)\n", output)

    def test_usage(self):
        with mock.patch("sys.stderr", io.StringIO()):
            self.assertEqual(self.main(), (2, ""))
            self.assertEqual(self.main("--help"), (2, ""))
            self.assertEqual(self.main("--open", f"{SITE}/Docs"), (2, ""))
            self.assertEqual(self.main(f"{SITE}/Docs", f"{SITE}/Docs"), (2, ""))

    def test_an_unexpected_error_opens_the_browser_and_is_logged(self):
        with mock.patch("onedriphe.click_action", side_effect=OSError("boom")), mock.patch("subprocess.Popen") as popen:
            self.assertEqual(self.main(f"onedriphe:{SITE}/Docs/Plans/A.docx"), (0, ""))
        self.assertEqual(popen.call_args.args[0], ["xdg-open", f"{SITE}/Docs/Plans/"])
        self.assertIn("boom", Path(self.home, ".cache", "onedriphe.log").read_text())


@unittest.skipUnless(shutil.which("sh"), "needs sh")
class Installer(unittest.TestCase):
    def setUp(self):
        self.home = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.home)
        self.env = {"HOME": str(self.home), "PATH": os.environ["PATH"]}

    def run_script(self, *command):
        return subprocess.run(command, env=self.env, capture_output=True, text=True, check=True).stdout

    def test_installs_updates_and_removes(self):
        output = self.run_script("sh", str(HERE / "install.sh"))
        helper = self.home / ".local" / "bin" / "onedriphe"
        desktop = self.home / ".local" / "share" / "applications" / "onedriphe.desktop"
        libraries = self.home / ".config" / "onedriphe" / "libraries"
        self.assertEqual(helper.read_text(), (HERE / "onedriphe.py").read_text())
        self.assertTrue(helper.stat().st_mode & stat.S_IXUSR)
        self.assertIn(f'Exec="{helper}" %u\n', desktop.read_text())
        self.assertIn("MimeType=x-scheme-handler/onedriphe;\n", desktop.read_text())
        self.assertIn(f"No libraries in {libraries} yet.", output)
        if shutil.which("xdg-mime"):
            self.assertIn("x-scheme-handler/onedriphe=onedriphe.desktop", (self.home / ".config" / "mimeapps.list").read_text())
        # Again, to update: the user's list stays.
        libraries.write_text(f"{SITE}/Docs ~/Docs\n")
        self.assertIn(f"{SITE}/Docs\n    {self.home}/Docs  (no such folder)", self.run_script("sh", str(HERE / "install.sh")))
        self.assertEqual(libraries.read_text(), f"{SITE}/Docs ~/Docs\n")

        (self.home / ".config" / "mimeapps.list").write_text(
            "[Default Applications]\nx-scheme-handler/onedriphe=onedriphe.desktop\ntext/plain=gedit.desktop\n"
        )
        self.assertIn("OneDriphe is removed.", self.run_script(str(helper), "--uninstall"))
        self.assertFalse(helper.exists())
        self.assertFalse(desktop.exists())
        self.assertEqual((self.home / ".config" / "mimeapps.list").read_text(),
                         "[Default Applications]\ntext/plain=gedit.desktop\n")  # fmt: skip
        self.assertTrue(libraries.exists())


if __name__ == "__main__":
    unittest.main()
