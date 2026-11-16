<#
.SYNOPSIS
  OneDriphe opens a SharePoint or OneDrive folder in Explorer, where the
  OneDrive app syncs it, for "In Explorer" of Phlair's menu (links
  "onedriphe:https://...").

.DESCRIPTION
  The browser starts this script with the link (install.ps1 registers the
  "onedriphe" scheme). It
  - takes only https links to *.sharepoint.com, and ignores anything else;
  - finds the synced library the link is in, among those the OneDrive app
    lists in the registry whose folder exists, and builds the local path from
    the rest of the link;
  - opens a folder in Explorer, and a file's folder with the file selected;
    a file that is not there (not synced yet, renamed): its folder. It never
    opens or starts a file;
  - opens the link in the browser where it finds no local folder: the library
    is not synced, or the link has no path. For a file, it opens the link of
    its folder, so that the browser does not download the file.
  The path stays in the library's folder: names Windows does not allow, and
  junctions or symbolic links on the way, send the link to the browser.
  An unexpected error is written to %TEMP%\OneDriphe.log, and the link opens
  in the browser.

  Windows PowerShell 5.1 runs it: plain ASCII, no PowerShell 7 syntax.

.PARAMETER Link
  The link, "onedriphe:https://x.sharepoint.com/sites/Site/Shared%20Documents/Folder".

.PARAMETER List
  Lists the libraries of the OneDrive app: SharePoint URL, local folder,
  whether the folder exists, and the registry keys that name it.

.PARAMETER Explain
  Tells what a click on the link does, without doing it.

.EXAMPLE
  .\onedriphe.ps1 -List

.EXAMPLE
  .\onedriphe.ps1 -Explain "onedriphe:https://contoso.sharepoint.com/sites/P/Shared%20Documents/Plans"
#>
[CmdletBinding()]
param(
  [Parameter(Position = 0)] [string] $Link,
  [switch] $List,
  [switch] $Explain
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# The link as an https URL of SharePoint, or $null. A "\" it does not take: browsers send it encoded.
function ConvertTo-SharePointUrl([string] $Link) {
  $text = $Link -replace '^onedriphe:', ''
  $url = $null
  if ($text.Contains('\') -or -not [Uri]::TryCreate($text, [UriKind]::Absolute, [ref] $url)) {
    return $null
  }
  if ($url.Scheme -ne 'https' -or $url.Host -notmatch '^[a-z0-9-]+\.sharepoint\.com$' -or
      $url.UserInfo -or -not $url.IsDefaultPort) {
    return $null
  }
  return $url
}

<#
  The decoded segments of a URL's path as it was written ("/sites/A/Shared%20Documents/" gives "sites", "A",
  "Shared Documents"): not of Uri.AbsolutePath, where .NET Framework (Windows PowerShell 5.1) drops a "." at the
  end of a segment and resolves "..", and .NET (PowerShell 7) does not; Test-WindowsName judges them all alike.
#>
function Get-PathSegments([Uri] $Url) {
  $path = ($Url.OriginalString -replace '^[a-z][a-z0-9+.-]*://[^/?#]*', '') -replace '[?#].*$', ''
  $segments = @()
  foreach ($segment in $path.Split('/')) {
    if ($segment -ne '') {
      $segments += [Uri]::UnescapeDataString($segment)
    }
  }
  return ,$segments
}

# Whether a name is one of a file: it has an extension, "Budget.xlsx" (as Phlair's sharepoint.ts tells).
function Test-FileName([string] $Name) {
  return $Name -match '\.[A-Za-z0-9]{1,8}$'
}

<#
  Whether Windows takes a name as it is, for a file or folder: not "." or "..",
  no character it does not allow, no device ("CON", "NUL", "COM1", ...: also
  with an extension, "NUL.txt"), and no "." or " " at the end, which Windows
  drops ("Plans." would be "Plans").
#>
function Test-WindowsName([string] $Name) {
  return -not ($Name -eq '' -or $Name -eq '.' -or $Name -eq '..' -or
    $Name -match '[\\/:*?"<>|\x00-\x1f]' -or $Name -match '[. ]$' -or
    $Name -match '^(CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[0-9\u00B9\u00B2\u00B3]|LPT[0-9\u00B9\u00B2\u00B3])(\.|$)')
}

<#
  The library a URL is in, among the libraries (objects with Url, the
  library's SharePoint URL, and Path, its local folder), and the names of the
  rest of the URL: an object with Root (the library's folder) and Names, or
  $null. The library with the longest URL wins (a shortcut to a folder of a
  library that is synced too). A name Windows does not take as it is gives $null.
#>
function Get-LibraryMatch([Uri] $Url, $Libraries) {
  $target = Get-PathSegments $Url
  $best = $null
  $bestLength = -1
  foreach ($library in @($Libraries)) {
    $libraryUrl = $null
    if (-not $library.Url -or -not $library.Path -or
        -not [Uri]::TryCreate($library.Url, [UriKind]::Absolute, [ref] $libraryUrl) -or
        $libraryUrl.Host -ne $Url.Host) {
      continue
    }
    $prefix = Get-PathSegments $libraryUrl
    if ($prefix.Count -eq 0 -or $prefix.Count -gt $target.Count -or $prefix.Count -le $bestLength) {
      continue
    }
    $same = $true
    for ($i = 0; $i -lt $prefix.Count; $i++) {
      # -ne ignores case, as SharePoint and Windows do.
      if ($prefix[$i] -ne $target[$i]) {
        $same = $false
        break
      }
    }
    if ($same) {
      $best = $library
      $bestLength = $prefix.Count
    }
  }
  if ($null -eq $best) {
    return $null
  }
  $names = @()
  for ($i = $bestLength; $i -lt $target.Count; $i++) {
    if (-not (Test-WindowsName $target[$i])) {
      return $null
    }
    $names += $target[$i]
  }
  return [pscustomobject] @{ Root = [string] $best.Path; Names = $names }
}

# A folder with names below it.
function Join-Names([string] $Root, $Names) {
  $path = $Root
  foreach ($name in @($Names)) {
    $path = [IO.Path]::Combine($path, $name)
  }
  return $path
}

# The local path of a URL in one of the libraries (see Get-LibraryMatch), or $null.
function Resolve-LocalPath([Uri] $Url, $Libraries) {
  $match = Get-LibraryMatch $Url $Libraries
  if ($null -eq $match) {
    return $null
  }
  return Join-Names $match.Root $match.Names
}

<#
  Whether the way from the root through the names (as far as it exists) has
  no junction or symbolic link, which could lead out of the root. OneDrive's
  files that are online only are no links.
#>
function Test-NoLinks([string] $Root, $Names) {
  $path = $Root
  foreach ($name in @($Names)) {
    $path = [IO.Path]::Combine($path, $name)
    if (-not (Test-Path -LiteralPath $path)) {
      return $true
    }
    $type = (Get-Item -LiteralPath $path -Force).LinkType
    if ($type -eq 'Junction' -or $type -eq 'SymbolicLink') {
      return $false
    }
  }
  return $true
}

<#
  What to show of the root and the names: an object with Action "open" (a
  folder) or "select" (a file, in its folder) and Target (the path); or $null
  (the browser). A file that is not there gives its folder.
#>
function Get-ExplorerTarget([string] $Root, $Names) {
  $Names = @($Names)
  if (-not (Test-NoLinks $Root $Names)) {
    return $null
  }
  $path = Join-Names $Root $Names
  if (Test-Path -LiteralPath $path -PathType Container) {
    return [pscustomobject] @{ Action = 'open'; Target = $path }
  }
  if (Test-Path -LiteralPath $path -PathType Leaf) {
    return [pscustomobject] @{ Action = 'select'; Target = $path }
  }
  if ($Names.Count -gt 0 -and (Test-FileName $Names[$Names.Count - 1])) {
    $folder = Join-Names $Root ($Names | Select-Object -First ($Names.Count - 1))
    if (Test-Path -LiteralPath $folder -PathType Container) {
      return [pscustomobject] @{ Action = 'open'; Target = $folder }
    }
  }
  return $null
}

<#
  The URL the browser opens instead: for a file, the URL of its folder, which
  SharePoint shows (the file's own URL would download most kinds of files).
#>
function Get-BrowserUrl([Uri] $Url) {
  $path = $Url.AbsolutePath
  $name = [Uri]::UnescapeDataString($path.Substring($path.LastIndexOf('/') + 1))
  if (-not (Test-FileName $name)) {
    return $Url.AbsoluteUri
  }
  return $Url.GetLeftPart([UriPartial]::Authority) + $path.Substring(0, $path.LastIndexOf('/') + 1)
}

<#
  What a click on the URL does, with the libraries: an object with Action
  "open", "select" (see Get-ExplorerTarget) or "browser", and Target.
#>
function Get-ClickAction([Uri] $Url, $Libraries) {
  $match = Get-LibraryMatch $Url $Libraries
  if ($null -ne $match) {
    $target = Get-ExplorerTarget $match.Root $match.Names
    if ($null -ne $target) {
      return $target
    }
  }
  return [pscustomobject] @{ Action = 'browser'; Target = (Get-BrowserUrl $Url) }
}

<#
  Shows a file in its folder, selected. "explorer /select" selects it in a new
  window, but where a window shows the folder already, it only brings that
  window to the front: there, select it through the shell's windows first.
#>
function Show-File([string] $Path) {
  $folder = [IO.Path]::GetDirectoryName($Path)
  $name = [IO.Path]::GetFileName($Path)
  try {
    $windows = @((New-Object -ComObject Shell.Application).Windows())
  } catch {
    $windows = @()
  }
  foreach ($window in $windows) {
    try {
      $view = $window.Document
      if ($view.Folder.Self.Path -eq $folder) {
        # Select it (1), and no other (4), scrolled into view (8), with the focus (16).
        $view.SelectItem($view.Folder.ParseName($name), 1 + 4 + 8 + 16)
      }
    } catch {
      # Not a window of a folder.
    }
  }
  Start-Process -FilePath 'explorer.exe' -ArgumentList "/select,`"$Path`""
}

# Does what Get-ClickAction tells.
function Invoke-ClickAction($Action) {
  if ($Action.Action -eq 'select') {
    Show-File $Action.Target
  } elseif ($Action.Action -eq 'open') {
    Start-Process -FilePath 'explorer.exe' -ArgumentList "`"$($Action.Target)`""
  } else {
    Start-Process -FilePath $Action.Target
  }
}

<#
  The libraries the OneDrive app syncs, with their SharePoint URL, local
  folder, and Source: the registry keys that name them.
#>
function Get-SyncedLibraries {
  $libraries = @()
  # Every synced library and shortcut ("Add shortcut to My files") of the OneDrive app.
  $engines = 'HKCU:\Software\SyncEngines\Providers\OneDrive'
  if (Test-Path $engines) {
    foreach ($key in Get-ChildItem $engines) {
      $values = Get-ItemProperty $key.PSPath
      if ($values.PSObject.Properties['UrlNamespace'] -and $values.PSObject.Properties['MountPoint']) {
        $libraries += [pscustomobject] @{
          Url = [string] $values.UrlNamespace
          Path = [string] $values.MountPoint
          Source = "SyncEngines\$($key.PSChildName)"
        }
      }
    }
  }
  # The work OneDrive itself (also among those above): its endpoint is "https://x-my.sharepoint.com/personal/<user>/_api".
  $accounts = 'HKCU:\Software\Microsoft\OneDrive\Accounts'
  if (Test-Path $accounts) {
    foreach ($key in Get-ChildItem $accounts | Where-Object { $_.PSChildName -like 'Business*' }) {
      $values = Get-ItemProperty $key.PSPath
      if ($values.PSObject.Properties['ServiceEndpointUri'] -and $values.PSObject.Properties['UserFolder']) {
        $site = ([string] $values.ServiceEndpointUri) -replace '/_api/?$', ''
        $libraries += [pscustomobject] @{
          Url = "$site/Documents/"
          Path = [string] $values.UserFolder
          Source = "Accounts\$($key.PSChildName)"
        }
      }
    }
  }
  return Select-UniqueLibraries $libraries
}

<#
  Each library once: the OneDrive app names a library in more than one place
  (and keeps old keys), with the same URL and folder (case, a "/" or "\" at
  the end, and the URL's encoding aside). The first one stays, with the
  sources of all.
#>
function Select-UniqueLibraries($Libraries) {
  # Its keys ignore case, as PowerShell's tables do.
  $unique = [ordered] @{}
  foreach ($library in @($Libraries)) {
    $url = [Uri]::UnescapeDataString(([string] $library.Url).TrimEnd('/'))
    $key = $url + '|' + ([string] $library.Path).TrimEnd('\', '/')
    if ($unique.Contains($key)) {
      $unique[$key].Source += ", $($library.Source)"
    } else {
      $unique[$key] = [pscustomobject] @{ Url = $library.Url; Path = $library.Path; Source = [string] $library.Source }
    }
  }
  return ,@($unique.Values)
}

<#
  The libraries whose folder exists: a key OneDrive kept of a library synced
  to another folder before (a folder deleted, or one it no longer syncs to,
  if listed first) must not win over the library's folder now.
#>
function Select-ExistingLibraries($Libraries) {
  return ,@(@($Libraries) | Where-Object { Test-LibraryFolder $_ })
}

function Test-LibraryFolder($Library) {
  return [bool] ($Library.Path -and (Test-Path -LiteralPath $Library.Path -PathType Container))
}

# The libraries for -List: each with Url, Path, Exists (whether its folder exists) and Source.
function Get-LibraryList($Libraries) {
  $entries = @()
  foreach ($library in @($Libraries)) {
    $entries += [pscustomobject] @{
      Url = $library.Url
      Path = $library.Path
      Exists = Test-LibraryFolder $library
      Source = $library.Source
    }
  }
  return ,$entries
}

# Adds a line to %TEMP%\OneDriphe.log, which nobody sees otherwise: the script runs without a window.
function Write-OneDripheLog([string] $Message) {
  try {
    $line = '{0:yyyy-MM-dd HH:mm:ss} {1}' -f (Get-Date), $Message
    Add-Content -LiteralPath (Join-Path $env:TEMP 'OneDriphe.log') -Value $line -Encoding UTF8
  } catch {
    # Nowhere to tell it.
  }
}

# Dot-sourced by the tests: the functions only.
if ($MyInvocation.InvocationName -eq '.') {
  return
}

if ($List) {
  # A parameter, not the pipeline: Get-SyncedLibraries returns its list as one object.
  $libraries = Get-LibraryList (Get-SyncedLibraries)
  $libraries | Format-Table Url, Path, Exists, Source -AutoSize | Out-String -Width 4096
  return
}

$url = ConvertTo-SharePointUrl $Link
if ($null -eq $url) {
  if ($Explain) {
    Write-Output 'nothing: not an https link to SharePoint'
  }
  exit 1
}
try {
  $action = Get-ClickAction $url (Select-ExistingLibraries (Get-SyncedLibraries))
} catch {
  Write-OneDripheLog "$Link`: $($_.Exception.Message) (line $($_.InvocationInfo.ScriptLineNumber))"
  $action = [pscustomobject] @{ Action = 'browser'; Target = (Get-BrowserUrl $url) }
}
if ($Explain) {
  Write-Output "$($action.Action) $($action.Target)"
  return
}
try {
  Invoke-ClickAction $action
} catch {
  Write-OneDripheLog "$Link`: $($_.Exception.Message) (line $($_.InvocationInfo.ScriptLineNumber))"
  if ($action.Action -ne 'browser') {
    Start-Process -FilePath (Get-BrowserUrl $url)
  }
}
