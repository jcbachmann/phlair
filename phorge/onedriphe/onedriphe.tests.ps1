# Tests of onedriphe.ps1 without Windows: the URL checks and the mapping
# to local paths; and that all scripts parse (npm run test:windows runs them in a PowerShell container;
# on Windows: powershell -ExecutionPolicy Bypass -File onedriphe.tests.ps1).

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'onedriphe.ps1')

$script:failures = 0
$script:count = 0
function Assert-Equal($Expected, $Actual, [string] $Name) {
  $script:count++
  if ($Expected -ne $Actual -or ($null -eq $Expected) -ne ($null -eq $Actual)) {
    $script:failures++
    Write-Output "FAIL: $Name`n  expected: $Expected`n  actual:   $Actual"
  }
}

$libraries = @(
  # A shortcut to a folder of a library synced too, listed first.
  [pscustomobject] @{ Url = 'https://contoso.sharepoint.com/sites/Projects/Shared%20Documents/Plans/2026'; Path = 'C:\Users\me\OneDrive - Contoso\2026' },
  [pscustomobject] @{ Url = 'https://contoso.sharepoint.com/sites/Projects/Shared Documents/'; Path = 'C:\Users\me\Contoso\Projects - Documents' },
  [pscustomobject] @{ Url = 'https://contoso-my.sharepoint.com/personal/me_contoso_com/Documents/'; Path = 'C:\Users\me\OneDrive - Contoso\' },
  [pscustomobject] @{ Url = 'not a url'; Path = 'C:\x' },
  [pscustomobject] @{ Url = 'https://contoso.sharepoint.com/sites/Empty/Docs/'; Path = '' }
)

function Resolve([string] $Link) {
  $url = ConvertTo-SharePointUrl $Link
  if ($null -eq $url) {
    return 'not taken'
  }
  $path = Resolve-LocalPath $url $libraries
  # As on Windows: the path joins names with the system's separator, "/" in the container.
  if ($null -ne $path) {
    $path = $path -replace '[\\/]+', '\'
  }
  return $path
}

# Which links it takes.
Assert-Equal 'C:\Users\me\Contoso\Projects - Documents\Plans' (Resolve 'onedriphe:https://contoso.sharepoint.com/sites/Projects/Shared%20Documents/Plans') 'a folder of a library'
Assert-Equal 'C:\Users\me\Contoso\Projects - Documents' (Resolve 'onedriphe:https://contoso.sharepoint.com/sites/Projects/Shared%20Documents/') 'the library itself'
Assert-Equal 'C:\Users\me\Contoso\Projects - Documents\Plans\Budget 2026.xlsx' (Resolve 'onedriphe:https://contoso.sharepoint.com/sites/projects/shared%20documents/Plans/Budget%202026.xlsx') 'a file, the case of the URL aside'
Assert-Equal 'C:\Users\me\Contoso\Projects - Documents\Pl%C3%A4ne' (Resolve 'onedriphe:https://contoso.sharepoint.com/sites/Projects/Shared%20Documents/Pl%25C3%25A4ne') 'decoded once only'
Assert-Equal "C:\Users\me\Contoso\Projects - Documents\Pl$([char]0xE4)ne" (Resolve "onedriphe:https://contoso.sharepoint.com/sites/Projects/Shared%20Documents/Pl$([char]0xE4)ne") 'a name not encoded'
Assert-Equal 'C:\Users\me\OneDrive - Contoso\2026\Q1' (Resolve 'onedriphe:https://contoso.sharepoint.com/sites/Projects/Shared%20Documents/Plans/2026/Q1') 'the longest library wins'
Assert-Equal 'C:\Users\me\OneDrive - Contoso\Notes\a.docx' (Resolve 'onedriphe:https://contoso-my.sharepoint.com/personal/me_contoso_com/Documents/Notes/a.docx') 'the work OneDrive'
Assert-Equal 'C:\Users\me\Contoso\Projects - Documents\Plans' (Resolve 'https://contoso.sharepoint.com/sites/Projects/Shared%20Documents/Plans?web=1#top') 'without the scheme, with a query'

# Links without a synced library: the browser.
Assert-Equal $null (Resolve 'onedriphe:https://contoso.sharepoint.com/sites/Other/Shared%20Documents/Plans') 'a library not synced'
Assert-Equal $null (Resolve 'onedriphe:https://contoso.sharepoint.com/sites/Projects/Shared%20Documentsx/Plans') 'a library of a longer name'
Assert-Equal $null (Resolve 'onedriphe:https://contoso.sharepoint.com/sites/Projects') 'a site, above the library'
Assert-Equal $null (Resolve 'onedriphe:https://contoso.sharepoint.com/:f:/s/Projects/EaB3xyz') 'a sharing link (no path)'
Assert-Equal $null (Resolve 'onedriphe:https://fabrikam.sharepoint.com/sites/Projects/Shared%20Documents/Plans') 'another tenant'
Assert-Equal $null (Resolve 'onedriphe:https://contoso.sharepoint.com/sites/Empty/Docs/a') 'a library without a folder'

# Paths that would leave the library's folder, or names Windows does not allow.
Assert-Equal $null (Resolve 'onedriphe:https://contoso.sharepoint.com/sites/Projects/Shared%20Documents/%2E%2E/%2E%2E/Windows') 'encoded ".."'
Assert-Equal $null (Resolve 'onedriphe:https://contoso.sharepoint.com/sites/Projects/Shared%20Documents/a%5C..%5C..%5CWindows') 'encoded backslashes'
Assert-Equal $null (Resolve 'onedriphe:https://contoso.sharepoint.com/sites/Projects/Shared%20Documents/a%2F..%2F..') 'encoded slashes'
Assert-Equal $null (Resolve 'onedriphe:https://contoso.sharepoint.com/sites/Projects/Shared%20Documents/C%3A') 'a drive'
Assert-Equal $null (Resolve 'onedriphe:https://contoso.sharepoint.com/sites/Projects/Shared%20Documents/a%22%20-x') 'a quote'
Assert-Equal $null (Resolve 'onedriphe:https://contoso.sharepoint.com/sites/Projects/Shared%20Documents/a%0Ab') 'a line break'
foreach ($device in 'CON', 'nul', 'Aux.txt', 'COM1', "LPT$([char]0xB9)", 'conin$', 'PRN.tar.gz') {
  Assert-Equal $null (Resolve "onedriphe:https://contoso.sharepoint.com/sites/Projects/Shared%20Documents/Plans/$([Uri]::EscapeDataString($device))") "the device $device"
}
Assert-Equal $null (Resolve 'onedriphe:https://contoso.sharepoint.com/sites/Projects/Shared%20Documents/Plans./a') 'a dot at the end'
Assert-Equal $null (Resolve 'onedriphe:https://contoso.sharepoint.com/sites/Projects/Shared%20Documents/Plans%2E/a') 'an encoded dot at the end'
Assert-Equal $null (Resolve 'onedriphe:https://contoso.sharepoint.com/sites/Projects/Shared%20Documents/Plans/../Other') '"..", which .NET Framework resolves'
Assert-Equal $null (Resolve 'onedriphe:https://contoso.sharepoint.com/sites/Projects/Shared%20Documents/./Plans') '"."'
Assert-Equal 'not taken' (Resolve 'onedriphe:https://contoso.sharepoint.com/sites/Projects/Shared%20Documents/a\..\..\Windows') 'a backslash'
Assert-Equal $null (Resolve 'onedriphe:https://contoso.sharepoint.com/sites/Projects/Shared%20Documents/Plans%20/a') 'a space at the end'
Assert-Equal 'C:\Users\me\Contoso\Projects - Documents\CONTRACTS\COM10\nul2.txt\.hidden' (Resolve 'onedriphe:https://contoso.sharepoint.com/sites/Projects/Shared%20Documents/CONTRACTS/COM10/nul2.txt/.hidden') 'names like devices, and a dot at the start'

# Links it does not take at all.
Assert-Equal 'not taken' (Resolve 'onedriphe:http://contoso.sharepoint.com/sites/Projects/Shared%20Documents/Plans') 'http'
Assert-Equal 'not taken' (Resolve 'onedriphe:https://contoso.sharepoint.com.evil.example/sites/Projects/Shared%20Documents/Plans') 'another host'
Assert-Equal 'not taken' (Resolve 'onedriphe:https://me@contoso.sharepoint.com/sites/Projects/Shared%20Documents/Plans') 'a user name'
Assert-Equal 'not taken' (Resolve 'onedriphe:https://contoso.sharepoint.com:8443/sites/Projects/Shared%20Documents/Plans') 'a port'
Assert-Equal 'not taken' (Resolve 'onedriphe:file:///C:/Windows') 'a file URL'
Assert-Equal 'not taken' (Resolve 'onedriphe:C:\Windows') 'a path'
Assert-Equal 'not taken' (Resolve 'onedriphe:') 'nothing'

# Each library once, with where the registry names it.
$named = Select-UniqueLibraries @(
  [pscustomobject] @{ Url = 'https://contoso-my.sharepoint.com/personal/me_contoso_com/Documents/'; Path = 'C:\Users\me\OneDrive - Contoso'; Source = 'SyncEngines\a' },
  [pscustomobject] @{ Url = 'https://contoso.sharepoint.com/sites/P/Shared%20Documents/'; Path = 'C:\Users\me\Contoso\P - Documents'; Source = 'SyncEngines\b' },
  [pscustomobject] @{ Url = 'https://contoso-my.sharepoint.com/personal/me_contoso_com/Documents'; Path = 'C:\Users\me\OneDrive - Contoso\'; Source = 'SyncEngines\c' },
  [pscustomobject] @{ Url = 'https://Contoso-my.sharepoint.com/personal/me_contoso_com/Documents/'; Path = 'c:\users\me\OneDrive - Contoso'; Source = 'Accounts\Business1' },
  [pscustomobject] @{ Url = 'https://contoso.sharepoint.com/sites/P/Shared Documents/'; Path = 'C:\Users\me\Contoso\P - Documents'; Source = 'SyncEngines\d' },
  [pscustomobject] @{ Url = 'https://contoso.sharepoint.com/sites/P/Shared%20Documents/'; Path = 'C:\Users\me\Contoso\P - Documents (old)'; Source = 'SyncEngines\e' }
)
Assert-Equal 3 $named.Count 'each library once'
Assert-Equal 'SyncEngines\a, SyncEngines\c, Accounts\Business1' $named[0].Source 'the work OneDrive, with its sources'
Assert-Equal 'C:\Users\me\OneDrive - Contoso' $named[0].Path 'the first one stays'
Assert-Equal 'SyncEngines\b, SyncEngines\d' $named[1].Source 'a library, encoded or not'
Assert-Equal 'C:\Users\me\Contoso\P - Documents (old)' $named[2].Path 'another folder for the same URL stays'
Assert-Equal 0 (Select-UniqueLibraries @()).Count 'no libraries'

# What the browser opens instead: for a file, its folder.
function Browse([string] $Link) {
  return Get-BrowserUrl (ConvertTo-SharePointUrl $Link)
}
Assert-Equal 'https://contoso.sharepoint.com/sites/P/Shared%20Documents/Plans/' (Browse 'https://contoso.sharepoint.com/sites/P/Shared%20Documents/Plans/Budget%202026.xlsx') 'a file: its folder'
Assert-Equal 'https://contoso.sharepoint.com/sites/P/Shared%20Documents/Plans' (Browse 'https://contoso.sharepoint.com/sites/P/Shared%20Documents/Plans') 'a folder: itself'
Assert-Equal 'https://contoso.sharepoint.com/sites/P/Shared%20Documents/Plans/' (Browse 'https://contoso.sharepoint.com/sites/P/Shared%20Documents/Plans/') 'a folder with "/" at the end: itself'
Assert-Equal 'https://contoso.sharepoint.com/sites/P/Shared%20Documents/Pl%C3%A4ne/' (Browse 'https://contoso.sharepoint.com/sites/P/Shared%20Documents/Pl%C3%A4ne/a.pdf?web=1') 'a file: its folder, encoded as it was, without the query'

# What Explorer shows, in a folder of real files and links.
$root = Join-Path ([IO.Path]::GetTempPath()) "onedriphe-test-$PID"
$outside = Join-Path ([IO.Path]::GetTempPath()) "onedriphe-outside-$PID"
try {
  New-Item -ItemType Directory -Path (Join-Path $root 'Plans') | Out-Null
  New-Item -ItemType File -Path (Join-Path $root 'Plans/Budget.xlsx') | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $outside 'Secret') | Out-Null
  New-Item -ItemType File -Path (Join-Path $outside 'Secret/a.txt') | Out-Null
  New-Item -ItemType SymbolicLink -Path (Join-Path $root 'Out') -Target $outside | Out-Null
  New-Item -ItemType SymbolicLink -Path (Join-Path $root 'Plans/Link.xlsx') -Target (Join-Path $outside 'Secret/a.txt') | Out-Null

  function Show($Names) {
    $target = Get-ExplorerTarget $root $Names
    if ($null -eq $target) {
      return 'browser'
    }
    return "$($target.Action) $($target.Target.Substring($root.Length) -replace '\\', '/')"
  }
  Assert-Equal 'open /Plans' (Show @('Plans')) 'a folder: open'
  Assert-Equal 'open ' (Show @()) 'the library: open'
  Assert-Equal 'select /Plans/Budget.xlsx' (Show @('Plans', 'Budget.xlsx')) 'a file: its folder, with it selected'
  Assert-Equal 'open /Plans' (Show @('Plans', 'New.xlsx')) 'a file that is not there: its folder'
  Assert-Equal 'open ' (Show @('New.xlsx')) 'a file of the library that is not there: the library'
  Assert-Equal 'browser' (Show @('Plans', 'Old')) 'a folder that is not there: the browser'
  Assert-Equal 'browser' (Show @('Gone', 'New.xlsx')) 'a file in a folder that is not there: the browser'
  Assert-Equal 'browser' (Show @('Out')) 'a symbolic link to a folder'
  Assert-Equal 'browser' (Show @('Out', 'Secret')) 'a folder through a symbolic link'
  Assert-Equal 'browser' (Show @('Out', 'Secret', 'b.txt')) 'a file that is not there, through a symbolic link'
  Assert-Equal 'browser' (Show @('Plans', 'Link.xlsx')) 'a symbolic link to a file'
  $missing = Get-ExplorerTarget (Join-Path $root 'Missing') @('Plans')
  Assert-Equal $null $missing 'a library whose folder is not there'
  # Junctions are Windows' own (on Windows PowerShell 5.1 its LinkType says so too).
  if ($env:OS -eq 'Windows_NT') {
    New-Item -ItemType Junction -Path (Join-Path $root 'Jump') -Target $outside | Out-Null
    Assert-Equal 'browser' (Show @('Jump', 'Secret')) 'a folder through a junction'
  }

  # Only libraries whose folder exists: an old key of a library synced elsewhere before does not win.
  $synced = @(
    [pscustomobject] @{ Url = 'https://contoso.sharepoint.com/sites/P/Shared%20Documents/'; Path = (Join-Path $root 'Gone') },
    [pscustomobject] @{ Url = 'https://contoso.sharepoint.com/sites/P/Shared%20Documents/'; Path = $root },
    [pscustomobject] @{ Url = 'https://contoso.sharepoint.com/sites/Q/Shared%20Documents/'; Path = '' }
  )
  $existing = Select-ExistingLibraries $synced
  Assert-Equal 1 $existing.Count 'the libraries whose folder exists'
  Assert-Equal $root $existing[0].Path 'the library in its folder now'
  Assert-Equal 0 (Select-ExistingLibraries @()).Count 'no libraries, none existing'

  # -List: each library on a line of its own, from a list returned as one object (as Get-SyncedLibraries does).
  $listed = Get-LibraryList (Select-UniqueLibraries @(
      [pscustomobject] @{ Url = 'https://contoso.sharepoint.com/sites/P/Old/'; Path = (Join-Path $root 'Gone'); Source = 'SyncEngines\a' },
      [pscustomobject] @{ Url = 'https://contoso.sharepoint.com/sites/P/Shared%20Documents/'; Path = $root; Source = 'SyncEngines\b' }
    ))
  Assert-Equal 2 $listed.Count 'the list: each library'
  Assert-Equal "False $(Join-Path $root 'Gone') SyncEngines\a" "$($listed[0].Exists) $($listed[0].Path) $($listed[0].Source)" 'the list: a folder that is gone'
  Assert-Equal "True $root SyncEngines\b" "$($listed[1].Exists) $($listed[1].Path) $($listed[1].Source)" 'the list: a folder that exists'
  $table = $listed | Format-Table Url, Path, Exists, Source -AutoSize | Out-String -Width 4096
  Assert-Equal $true ($table -like "*/sites/P/Shared%20Documents/*$root*True*SyncEngines\b*") "the list as a table ($table)"
  Assert-Equal 0 (Get-LibraryList @()).Count 'the list: no libraries'

  function Click([string] $Link) {
    $action = Get-ClickAction (ConvertTo-SharePointUrl $Link) $existing
    return "$($action.Action) $($action.Target -replace [regex]::Escape($root), '<root>' -replace '\\', '/')"
  }
  $site = 'https://contoso.sharepoint.com/sites/P/Shared%20Documents'
  Assert-Equal 'open <root>/Plans' (Click "onedriphe:$site/Plans") 'a click on a synced folder'
  Assert-Equal 'select <root>/Plans/Budget.xlsx' (Click "onedriphe:$site/Plans/Budget.xlsx") 'a click on a synced file'
  Assert-Equal "browser $site/Archive" (Click "onedriphe:$site/Archive") 'a click on a folder that is not synced'
  Assert-Equal "browser $site/Archive/" (Click "onedriphe:$site/Archive/Old.zip") 'a click on a file that is not synced: its folder'
  Assert-Equal 'browser https://contoso.sharepoint.com/sites/Q/Shared%20Documents/a/' (Click 'onedriphe:https://contoso.sharepoint.com/sites/Q/Shared%20Documents/a/b.pdf') 'a library without a folder: the browser'

  # The script itself, as the browser starts it, with -Explain: no library in the registry here.
  $script = Join-Path $PSScriptRoot 'onedriphe.ps1'
  if ($env:OS -ne 'Windows_NT') {
    Assert-Equal "browser $site/Plans/" (& $script -Explain "onedriphe:$site/Plans/Budget.xlsx") 'the script: a file of a library not synced'
  }
  Assert-Equal 'nothing: not an https link to SharePoint' (& $script -Explain 'onedriphe:http://example.com/a') 'the script: a link it does not take'
  Assert-Equal 1 $LASTEXITCODE 'the script: exit code 1 for a link it does not take'
  # -List runs (its table on Windows: windows.tests.ps1).
  Assert-Equal $true ((& $script -List | Out-String) -is [string]) 'the script: -List'
} finally {
  Remove-Item -LiteralPath $root, $outside -Recurse -Force -ErrorAction SilentlyContinue
}

# The installer and the uninstaller need Windows to run, but parse anywhere;
# and Windows PowerShell 5.1 reads scripts without a BOM as ANSI: ASCII only.
foreach ($name in 'onedriphe.ps1', 'install.ps1', 'uninstall.ps1', 'onedriphe.tests.ps1', 'windows.tests.ps1') {
  $path = Join-Path $PSScriptRoot $name
  $errors = $null
  [System.Management.Automation.Language.Parser]::ParseFile($path, [ref] $null, [ref] $errors) | Out-Null
  Assert-Equal 0 $errors.Count "$name parses"
  $bytes = [IO.File]::ReadAllBytes($path)
  Assert-Equal 0 @($bytes | Where-Object { $_ -gt 127 }).Count "$name is ASCII"
}
Assert-Equal 1 ([regex]::Matches((Get-Content -Raw (Join-Path $PSScriptRoot 'install.ps1')), '(?m)^\$helper = \$null # ONEDRIPHE-HELPER\r?$')).Count 'the installer has the place for the helper'
Assert-Equal 1 ([regex]::Matches((Get-Content -Raw (Join-Path $PSScriptRoot 'install.ps1')), '(?m)^\$uninstaller = \$null # ONEDRIPHE-UNINSTALLER\r?$')).Count 'the installer has the place for the uninstaller'

if ($script:failures -gt 0) {
  Write-Output "$script:failures of $script:count failed."
  exit 1
}
Write-Output "All $script:count passed."
exit 0
