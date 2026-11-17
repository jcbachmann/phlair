# OneDriphe

OneDriphe, Phlair's helper for Windows and Linux, opens SharePoint and OneDrive folders in Explorer, where the OneDrive
app syncs them, or on Linux in the file manager, where rclone mounts them (see [Linux](#linux)). It is what **In
Explorer** or **In the file manager** (under _Open file location_, or _Open folder_) in the menu of a SharePoint link in
Phorge talks to. A web page cannot open a file manager itself: browsers do not let websites open local folders. The menu
item opens `onedriphe:https://…sharepoint.com/…`, and the browser hands such links to OneDriphe.

When a link arrives, OneDriphe:

1. takes only `https` links to `*.sharepoint.com` and ignores everything else;
2. looks the link up among the libraries the OneDrive app syncs whose folder exists, including shortcuts ("Add
   shortcut to My files") and the work OneDrive itself, and builds the local path from the rest of the link;
3. opens the folder in Explorer. For a file, it opens the file's folder with the file selected, also in an Explorer
   window that shows the folder already (`explorer /select` alone only brings such a window to the front); for a file
   that is not there (not synced yet, renamed), its folder. It **never opens or starts a file**;
4. opens the link in the browser instead where it finds no local folder: the library is not synced, or the link has no
   path (a sharing link from "Copy link"). For a file, it opens the link of its folder, which SharePoint shows; the
   file's own link would download most kinds of files.

It runs without a window: PowerShell is a console program, which by itself shows a console window (or Windows
Terminal's) for a moment, so the scheme starts it through the console host without a window
(`conhost.exe --headless`, Windows 10 1809 and later). An unexpected error is written to `%TEMP%\OneDriphe.log`, and
the link opens in the browser.

Files for Windows: `onedriphe.ps1` (the helper), `install.ps1` (installs it), `uninstall.ps1` (removes it), the tests
`onedriphe.tests.ps1` and `windows.tests.ps1`, and `compatibility.ps1` (see Tests). They are plain PowerShell for the
Windows PowerShell 5.1 that comes with Windows; nothing else is needed. For Linux: `onedriphe.py` (the helper, for the
Python 3 of a current distribution), `install.sh` and the tests `test_onedriphe.py`.

## Turning it on

1. **Install OneDriphe** on the computer: from the download in Phorge's settings, no administrator rights needed; or
   IT for every computer, see below.
2. **Turn it on** in Phorge: _Settings → Phlair → OneDriphe: SharePoint Links → On_ (Phizziwig must be on too).
   With the browser extension instead: its options page, _OneDriphe: SharePoint links_.
3. Reload the page. A click on a link to a folder or file with a path now offers **In Explorer**. The first time,
   the browser asks whether to open the link with an app; allow it, and tick "Always allow" for the site. While
   OneDriphe starts, a note under the link says so, and after a few seconds without Explorer what to do.

Which links have it: links copied from the browser's address bar while looking at a folder or file in SharePoint
(`…/Forms/AllItems.aspx?id=…`, `…/Shared Documents/Plan.docx`). Sharing links from "Copy link" (`…/:f:/s/Site/EaB3…`)
name no path, so they do not.

## Installing on one computer

Users find the steps in the setting itself (_Settings → Phlair_), with links to download the installer as one file,
`install-onedriphe.ps1`, and the uninstaller, `uninstall-onedriphe.ps1`. Phorge serves them at `/phlair/onedriphe/`
(`OneDripheDownloadController`), with Windows line breaks: this folder's `install.ps1` with `onedriphe.ps1` and
`uninstall.ps1` in it, and `uninstall.ps1`.

Windows runs no scripts by default (execution policy _Restricted_): a double-click opens one in an editor, and
`.\install-onedriphe.ps1` fails. The command allows it for that run, unless a policy allows only signed scripts (see
below). In PowerShell:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:USERPROFILE\Downloads\install-onedriphe.ps1"
```

The menu item "Run with PowerShell" of `.ps1` files would be simpler, but it differs between versions of Windows: older
ones allowed the script for that run, current Windows 11 runs `powershell.exe -file` without that (key
`HKCR\SystemFileAssociations\.ps1\Shell\Windows.PowerShell.Run`), so under the default policy it shows an error and
closes. The setting does not count on it. A browser names a second download of the same file
`install-onedriphe (1).ps1`, so the setting says to delete an earlier one first. The installer waits for Enter at the
end, so that its output can be read where it has a window of its own.

From a copy of this folder: `powershell -ExecutionPolicy Bypass -File .\install.ps1`.

The installer copies `onedriphe.ps1` and `uninstall.ps1` to a folder, registers the `onedriphe` scheme, and adds
_OneDriphe_ to Windows' list of apps:

| Run                      | For        | Folder                              | Registry                  |
| ------------------------ | ---------- | ----------------------------------- | ------------------------- |
| as a user                | that user  | `%LOCALAPPDATA%\Programs\OneDriphe` | `HKCU\Software\Classes\…` |
| as administrator, SYSTEM | every user | `C:\Program Files\OneDriphe`        | `HKLM\SOFTWARE\Classes\…` |

Installing again replaces an earlier install of the same kind; that is also how to update it. Where both are
installed, the user's wins (Windows reads HKCU before HKLM). The folder for every user is one users cannot change; that
is for rolling it out, not a protection against programs of the user: they can register the scheme for the user anyway.
In a 32-bit PowerShell on 64-bit Windows, the installer and the uninstaller run themselves again in the 64-bit one, so
that they use the 64-bit Program Files and registry, as the scheme and the list of apps do.

At the end, the installer lists the libraries of the OneDrive app. If the list is empty, OneDrive syncs no library yet:
sign in to the OneDrive app with the work account and click "Sync" (or "Add shortcut to My files") on a SharePoint
library. `Exists` is `False` for a folder OneDrive no longer uses (it keeps old keys); OneDriphe skips those. To check
later which libraries it sees, and what a click on a link does:

```powershell
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Programs\OneDriphe\onedriphe.ps1" -List
powershell -ExecutionPolicy Bypass -File "$env:LOCALAPPDATA\Programs\OneDriphe\onedriphe.ps1" -Explain "onedriphe:https://…"
```

## Removing it

In Windows' Settings: _Apps → Installed apps → OneDriphe → Uninstall_. This runs the copy of `uninstall.ps1` in the
install's folder, which removes the scheme, the entry in the list of apps, and the folder; for the install for every
user, it asks for administrator rights (UAC). The downloaded uninstaller, or `uninstall.ps1` of this folder, removes
both kinds (`-Scope User` or `-Scope Machine` only one); run it as the installer.

## Rolling it out (IT)

- **Intune** (Win32 app, or a GPO startup script): install command
  `powershell.exe -ExecutionPolicy Bypass -File install.ps1 -Quiet`, uninstall command
  `powershell.exe -ExecutionPolicy Bypass -File uninstall.ps1 -Scope Machine -Quiet`, install behavior _System_ (which
  installs for every user), detection rule: the registry key `HKLM\SOFTWARE\Classes\onedriphe\shell\open\command`
  exists. `-Quiet` keeps them from waiting for Enter.
- **No prompt in the browser:** the Edge and Chrome policy `AutoLaunchProtocolsFromOrigins` with
  `[{"protocol": "onedriphe", "allowed_origins": ["https://phorge.example.com"]}]` (the Phorge instance). Firefox asks
  once per scheme; its policy `Handlers` can preset it.
- **Signed scripts:** where a policy allows only signed PowerShell scripts (`AllSigned`), neither `-ExecutionPolicy
Bypass` overrides it: sign the scripts with the company's code signing certificate before
  rolling them out.
- **Security tools:** a browser that starts a hidden PowerShell with `-ExecutionPolicy Bypass` through
  `conhost.exe --headless` is what detection rules of endpoint protection look for (e.g. Microsoft Defender for
  Endpoint, Sigma's "Powershell Executed From Headless ConHost Process"). Allow the exact command line of the scheme
  (`HKLM\SOFTWARE\Classes\onedriphe\shell\open\command`), preferably of the signed install for every user. Where a
  click does nothing, check the security tool's alerts first.
- **AppLocker, WDAC:** script rules usually allow scripts in Program Files only, so there only the install for every
  user runs.
- **For everyone in Phorge:** once every computer has OneDriphe, the administrator can turn it on for all users
  in _Settings → Global Default Settings → Phlair_.
- **Only the company's links:** _Config → Phlair → `phlair.onedriphe-hosts`_ limits _In Explorer_ to links to these
  hosts, e.g. `contoso.sharepoint.com` and `contoso-my.sharepoint.com` (the OneDrives); links of customers' tenants,
  which no one syncs, then open in the browser only. Empty: links to any host.

## How it finds the local folder

The OneDrive app lists every synced library and shortcut in `HKCU\Software\SyncEngines\Providers\OneDrive\*`:
`UrlNamespace` is the library's SharePoint URL and `MountPoint` its local folder. The work OneDrive itself is in
`HKCU\Software\Microsoft\OneDrive\Accounts\Business*` (`UserFolder`, `ServiceEndpointUri`), and usually among the
libraries too; OneDrive also keeps keys of earlier sign-ins. OneDriphe takes each library once, and only those whose
folder exists; `-List` shows them all with the keys that name them (`Source`). Microsoft does not document these keys,
though admin scripts have used them for years. If they change, OneDriphe opens links in the browser, and `-List` shows
what it found. It reads them at each click, so libraries synced after installing count at once.

The local path is the library's folder plus the rest of the link, decoded. It stays inside the synced folder; the link
opens in the browser instead where a name is one Windows does not take as it is:

- `.` and `..`, characters Windows does not allow (`\ / : * ? " < > |`, control characters);
- devices (`CON`, `PRN`, `AUX`, `NUL`, `CONIN$`, `CONOUT$`, `COM1`–`COM9`, `LPT1`–`LPT9`, also with superscript
  digits and with an extension, e.g. `NUL.txt`);
- names ending in `.` or a space, which Windows drops (`Plans.` would be `Plans`);

and where a junction or symbolic link is on the way, which could lead out of the folder (OneDrive's files that are
online only are no links).

## Linux

On Linux, OneDriphe is `onedriphe.py`, a Python script that does what the one for Windows does, with two differences:

- **Where the libraries are:** there is no OneDrive app for Linux, and no registry to read. OneDriphe reads a list the
  user writes, `~/.config/onedriphe/libraries`: per line a library's SharePoint URL, then its local folder (`~` is the
  home folder; the folder may contain spaces), e.g.
  `https://contoso.sharepoint.com/sites/Projects/Shared%20Documents ~/SharePoint/Projects`. The folder is any that has
  the library's files under their names: a mount of rclone (`rclone mount`, which downloads files only when they are
  opened), or the folder of another client. A link to a library that is not listed opens in the browser.
- **Names:** Linux takes every name but `.`, `..` and ones with `/`; those, and a symbolic link that leads out of the
  library's folder, send the link to the browser. Names compare without case where the folder has only one entry of
  that name (SharePoint does not tell `Plan.docx` from `plan.docx`, Linux does).

It shows folders and files through the file manager's D-Bus interface (`org.freedesktop.FileManager1`, `ShowFolders` and
`ShowItems`, which select the file; Nautilus, Dolphin, Nemo, Caja and Thunar have it), with `busctl` of systemd; without
the interface, `xdg-open` opens the folder. It never opens a file. An unexpected error is written to
`~/.cache/onedriphe.log`, and the link opens in the browser.

**Installing** (no root): the setting links to `install-onedriphe.sh` (`OneDripheDownloadController`: `install.sh` with
`onedriphe.py` in it, in place of the line `write_helper() { … } # ONEDRIPHE-HELPER`). Run it with
`sh ~/Downloads/install-onedriphe.sh`, or `sh install.sh` in a copy of this folder. It copies the helper to
`~/.local/bin/onedriphe`, adds a desktop entry for the scheme `x-scheme-handler/onedriphe`
(`~/.local/share/applications/onedriphe.desktop`, which `xdg-mime` makes the default), and creates the list of
libraries with an explanation where there is none. Installing again updates it and keeps the list. Browsers find the
scheme through the desktop entry. Browsers in a Snap or Flatpak (Ubuntu's Firefox is a Snap) hand it to the desktop
portal, which is to start OneDriphe outside the sandbox; that is not tried yet. `~/.local/bin/onedriphe --list` shows the libraries, `--explain "onedriphe:https://…"` what a click does, and
`--uninstall` removes the helper and its scheme (not the list, which the user wrote).

## Tests

`npm run test:linux` runs `test_onedriphe.py` (Python's `unittest`): the links OneDriphe takes, the list of libraries,
the mapping to local paths, what a click does in a folder of real files and symbolic links, the calls of the file
manager, the command, and installing, updating and removing it in a temporary home folder. GitHub Actions runs them on
its runner's Python 3, and `shellcheck` on the installer. Phorge's E2E tests download the
installer, compare it with this folder's files and run it. Untested by machines: the file manager's window and the
browser's prompt.

`npm run test:windows` runs, in a PowerShell 7 container (a pinned image):

- `onedriphe.tests.ps1`: the links OneDriphe takes, the mapping to local paths, the names it refuses, the libraries it
  uses, what a click does in a folder of real files and symbolic links, the script itself with `-Explain`, and that all
  scripts parse and are ASCII (Windows PowerShell 5.1 reads scripts without a BOM as ANSI);
- `compatibility.ps1`: PSScriptAnalyzer's checks that the scripts' syntax, commands and .NET types are those of
  Windows PowerShell 5.1 (the container's PowerShell 7 parses syntax that 5.1 does not).

GitHub Actions also runs them on Windows itself (`windows-latest`, Windows PowerShell 5.1), with
`windows.tests.ps1`: it installs OneDriphe for every user, also from a 32-bit PowerShell as Intune runs it, runs the
installed helper with a library in the registry, and removes it again. By hand, in an elevated Windows PowerShell on a
computer without OneDriphe installed for every user:

```powershell
powershell -ExecutionPolicy Bypass -File .\onedriphe.tests.ps1
powershell -ExecutionPolicy Bypass -File .\windows.tests.ps1
```

Untested by machines: starting Explorer, the browser's prompt, and the uninstaller's request for administrator rights
(UAC); try them by clicking.
