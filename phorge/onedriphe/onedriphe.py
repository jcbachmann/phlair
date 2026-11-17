#!/usr/bin/env python3
"""OneDriphe for Linux: opens a SharePoint folder in the file manager.

The browser starts it with the link of "In the file manager" in Phlair's menu
("onedriphe:https://..."; install.sh registers the scheme). It

- takes only https links to *.sharepoint.com, and ignores anything else;
- finds the library the link is in, among those in ~/.config/onedriphe/libraries
  (a SharePoint URL and a local folder per line: a mount of rclone, or the
  folder of another client), and builds the local path from the rest of the
  link;
- shows a folder in the file manager, and a file in its folder, selected; a
  file that is not there (renamed, not synced yet): its folder. It never
  opens or starts a file;
- opens the link in the browser where it finds no local folder: the library is
  not listed, or the link has no path. For a file, it opens the link of its
  folder, so that the browser does not download the file.

The path stays in the library's folder: "..", and symbolic links that lead out
of it, send the link to the browser. An unexpected error is written to
~/.cache/onedriphe.log, and the link opens in the browser.

The Python 3 of a current distribution, nothing else.
"""

import os
import re
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import List, NamedTuple, Optional, Sequence
from urllib.parse import SplitResult, unquote, urlsplit

USAGE = """usage: onedriphe LINK         open a link, as the browser does
       onedriphe --explain LINK  tell what a click on the link does
       onedriphe --list          list the libraries and their folders
       onedriphe --uninstall     remove OneDriphe
(installed as ~/.local/bin/onedriphe)"""

SCHEME = "onedriphe:"


class Library(NamedTuple):
    """A SharePoint library (or a folder of one) on this computer."""

    url: str
    folder: str


class Action(NamedTuple):
    """What a click does: "open" a folder, "select" a file in its folder, or open "browser" a URL."""

    action: str
    target: str


def config_home() -> Path:
    return Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config")


def libraries_file() -> Path:
    return config_home() / "onedriphe" / "libraries"


def sharepoint_url(link: str) -> Optional[SplitResult]:
    """The link as an https URL of SharePoint, or None. Without user info or port, whitespace or control characters."""
    text = link[len(SCHEME):] if link.startswith(SCHEME) else link
    if re.search(r"[\s\x00-\x1f\x7f]", text):
        return None
    try:
        url = urlsplit(text)
    except ValueError:  # e.g. "https://[x/": not a URL
        return None
    host = url.hostname or ""
    if url.scheme != "https" or url.netloc.lower() != host or not re.fullmatch(r"[a-z0-9-]+\.sharepoint\.com", host):
        return None
    return url


def path_segments(url: SplitResult) -> Optional[List[str]]:
    """The decoded segments of a URL's path ("/sites/A/Shared%20Documents/": "sites", "A", "Shared Documents"); None
    where one is not UTF-8."""
    try:
        return [unquote(segment, errors="strict") for segment in url.path.split("/") if segment]
    except UnicodeDecodeError:
        return None


def is_file_name(name: str) -> bool:
    """Whether a name is one of a file: it has an extension, "Budget.xlsx" (as Phlair's sharepoint.ts tells)."""
    return re.search(r"\.[A-Za-z0-9]{1,8}$", name) is not None


def is_plain_name(name: str) -> bool:
    """Whether a name is one of a file or folder in the folder above: not "." or "..", no "/" (from "%2F")."""
    return name not in ("", ".", "..") and re.search(r"[/\x00-\x1f\x7f]", name) is None


def read_libraries(file: Path) -> List[Library]:
    """The libraries of the file: per line a URL, then (after spaces) the folder; "~" is the home folder, "#" a
    comment. Lines that are no such pair are left out (onedriphe --list shows what it takes)."""
    try:
        text = file.read_text(encoding="utf-8")
    except FileNotFoundError:
        return []
    libraries = []
    for line in text.splitlines():
        parts = line.strip().split(None, 1)
        if len(parts) == 2 and not parts[0].startswith("#"):
            libraries.append(Library(parts[0], os.path.expanduser(parts[1].strip())))
    return libraries


class Match(NamedTuple):
    root: str
    names: List[str]


def library_match(url: SplitResult, libraries: Sequence[Library]) -> Optional[Match]:
    """The library a URL is in, and the names of the rest of the URL; or None. The library with the longest URL wins
    (one listed for a folder of another), else the first listed. Names are compared without case, as SharePoint
    does."""
    target = path_segments(url)
    if target is None:
        return None
    best: Optional[Library] = None
    best_length = 0
    for library in libraries:
        library_url = sharepoint_url(library.url)
        prefix = path_segments(library_url) if library_url else None
        if not library_url or not prefix or library_url.hostname != url.hostname or not os.path.isabs(library.folder):
            continue
        if best_length < len(prefix) <= len(target) and all(
            a.lower() == b.lower() for a, b in zip(prefix, target)
        ):
            best, best_length = library, len(prefix)
    if best is None:
        return None
    names = target[best_length:]
    if not all(is_plain_name(name) for name in names):
        return None
    return Match(best.folder, names)


def find_name(folder: str, name: str) -> str:
    """The path of a name in a folder: as written, or else of the one entry with the same name in another case
    (SharePoint does not tell them apart, Linux does); as written where there is none."""
    path = os.path.join(folder, name)
    if os.path.lexists(path) or not os.path.isdir(folder):
        return path
    same = [entry for entry in os.listdir(folder) if entry.lower() == name.lower()]
    return os.path.join(folder, same[0]) if len(same) == 1 else path


def manager_target(root: str, names: Sequence[str]) -> Optional[Action]:
    """What to show of the root and the names: "open" a folder, "select" a file; or None (the browser). A file that
    is not there gives its folder. A path that leads out of the root (through a symbolic link) gives None."""
    path = root
    for name in names:
        path = find_name(path, name)
    real_root = os.path.realpath(root)
    if os.path.commonpath([real_root, os.path.realpath(path)]) != real_root:
        return None
    if os.path.isdir(path):
        return Action("open", path)
    if os.path.isfile(path):
        return Action("select", path)
    folder = os.path.dirname(path)
    if names and is_file_name(names[-1]) and os.path.isdir(folder):
        return Action("open", folder)
    return None


def browser_url(url: SplitResult) -> str:
    """The URL the browser opens instead: for a file, the one of its folder, which SharePoint shows (the file's own
    URL would download most kinds of files)."""
    folder, _, name = url.path.rpartition("/")
    if not is_file_name(unquote(name)):
        return url.geturl()
    return f"https://{url.netloc}{folder}/"


def click_action(url: SplitResult, libraries: Sequence[Library]) -> Action:
    """What a click on the URL does, with the libraries."""
    match = library_match(url, libraries)
    target = manager_target(match.root, match.names) if match else None
    return target or Action("browser", browser_url(url))


def show(method: str, path: str) -> bool:
    """Asks the file manager to show a folder ("ShowFolders") or a file in its folder, selected ("ShowItems"),
    through its D-Bus interface (Nautilus, Dolphin, Nemo, Caja, Thunar, ...)."""
    command = [
        "busctl", "--user", "call", "org.freedesktop.FileManager1", "/org/freedesktop/FileManager1",
        "org.freedesktop.FileManager1", method, "ass", "1", Path(path).as_uri(), startup_id(),
    ]  # fmt: skip
    try:
        return subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def startup_id() -> str:
    """The token the browser gave for bringing the next window to the front (Wayland, X11): without it, GNOME only
    tells that the file manager is ready."""
    return os.environ.get("XDG_ACTIVATION_TOKEN") or os.environ.get("DESKTOP_STARTUP_ID") or ""


def xdg_open(target: str) -> None:
    subprocess.Popen(["xdg-open", target], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def perform(action: Action) -> None:
    """Does what click_action() tells. Without the file manager's D-Bus interface, xdg-open shows the folder."""
    if action.action == "select":
        if not show("ShowItems", action.target):
            xdg_open(os.path.dirname(action.target))
    elif action.action == "open":
        if not show("ShowFolders", action.target):
            xdg_open(action.target)
    else:
        xdg_open(action.target)


def log(message: str) -> None:
    """Adds a line to ~/.cache/onedriphe.log, which nobody sees otherwise: the browser starts OneDriphe without a
    terminal."""
    try:
        cache = Path(os.environ.get("XDG_CACHE_HOME") or Path.home() / ".cache")
        cache.mkdir(parents=True, exist_ok=True)
        with open(cache / "onedriphe.log", "a", encoding="utf-8") as file:
            file.write(f"{time.strftime('%Y-%m-%d %H:%M:%S')} {message}\n")
    except OSError:
        pass  # Nowhere to tell it.


def list_libraries() -> None:
    file = libraries_file()
    libraries = read_libraries(file)
    print(f"Libraries in {file}:" if libraries else f"No libraries in {file} yet.")
    for library in libraries:
        url = sharepoint_url(library.url)
        state = "" if os.path.isdir(library.folder) else "  (no such folder)"
        if not os.path.isabs(library.folder):
            state = "  (not a folder from / or ~: left out)"
        if not url or not path_segments(url):
            state = "  (not an https URL of a SharePoint library)"
        print(f"  {library.url}\n    {library.folder}{state}")


def uninstall() -> None:
    """Removes the helper and its scheme; keeps the list of libraries, which the user wrote."""
    data = Path(os.environ.get("XDG_DATA_HOME") or Path.home() / ".local" / "share")
    desktop = data / "applications" / "onedriphe.desktop"
    mimeapps = config_home() / "mimeapps.list"
    try:
        lines = mimeapps.read_text(encoding="utf-8").splitlines(keepends=True)
        kept = [line for line in lines if not line.startswith("x-scheme-handler/onedriphe=")]
        if kept != lines:
            mimeapps.write_text("".join(kept), encoding="utf-8")
    except FileNotFoundError:
        pass
    # Where install.sh puts OneDriphe.
    for file in (desktop, Path.home() / ".local" / "bin" / "onedriphe"):
        file.unlink(missing_ok=True)
    if shutil.which("update-desktop-database"):
        subprocess.run(["update-desktop-database", str(desktop.parent)], stderr=subprocess.DEVNULL)
    print(f"OneDriphe is removed. Your list of libraries stays in {libraries_file()}.")


def main(argv: Sequence[str]) -> int:
    if list(argv) == ["--list"]:
        list_libraries()
        return 0
    if list(argv) == ["--uninstall"]:
        uninstall()
        return 0
    explain = len(argv) == 2 and argv[0] == "--explain"
    if not explain and (len(argv) != 1 or argv[0].startswith("-")):
        print(USAGE, file=sys.stderr)
        return 2
    link = argv[-1]
    url = sharepoint_url(link)
    if url is None:
        if explain:
            print("nothing: not an https link to SharePoint")
        return 1
    try:
        action = click_action(url, read_libraries(libraries_file()))
    except Exception as error:  # noqa: BLE001 - whatever it is, the browser still opens the link
        log(f"{link}: {error!r}")
        action = Action("browser", browser_url(url))
    if explain:
        print(f"{action.action} {action.target}")
        return 0
    try:
        perform(action)
    except Exception as error:  # noqa: BLE001 - e.g. no xdg-open: nothing else would open it either
        log(f"{link}: {error!r}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
