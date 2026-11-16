<#
.SYNOPSIS
  Installs OneDriphe, which opens SharePoint and OneDrive folders of Phlair's
  "In Explorer" in Explorer; see README.md. uninstall.ps1 removes it.

.DESCRIPTION
  Without administrator rights it installs for the current user: in
  "%LOCALAPPDATA%\Programs\OneDriphe" and the user's registry (HKCU). As
  administrator (or as SYSTEM, from Intune) it installs for every user of the
  computer: in "C:\Program Files\OneDriphe", where users can not change it,
  and HKLM.

  It copies onedriphe.ps1 and uninstall.ps1 (next to it, or in it as
  downloaded from Phorge's Settings -> Phlair) to the folder, registers the
  "onedriphe" link scheme, and adds "OneDriphe" to Windows' list of apps,
  which can uninstall it. Installing again replaces an earlier install of the
  same kind.

  Started in a window of its own, it waits for Enter
  at the end, so that its window can be read.

.PARAMETER Quiet
  Does not wait for Enter at the end (for Intune and scripts).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File install.ps1
#>
[CmdletBinding()]
param([switch] $Quiet)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# A 32-bit PowerShell on 64-bit Windows (Intune runs install commands in one)
# sees "Program Files (x86)" and the 32-bit part of HKLM, which the 64-bit
# PowerShell of the scheme and the list of apps does not: run in that one.
if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) {
  $native = Join-Path $env:SystemRoot 'Sysnative\WindowsPowerShell\v1.0\powershell.exe'
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath)
  if ($Quiet) {
    $arguments += '-Quiet'
  }
  & $native @arguments
  exit $LASTEXITCODE
}

# The scripts it installs: next to it, or in it. The download from Phorge's
# settings (OneDripheDownloadController) puts them in the next lines.
$helper = $null # ONEDRIPHE-HELPER
$uninstaller = $null # ONEDRIPHE-UNINSTALLER

# Puts a script in the folder, and returns its path.
function Install-Script([string] $Folder, [string] $Name, $Content) {
  $path = Join-Path $Folder $Name
  if ($null -ne $Content) {
    Set-Content -LiteralPath $path -Value $Content -Encoding ASCII
  } else {
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot $Name) -Destination $path -Force
  }
  return $path
}

# A registry key, with the keys above it; -Force replaces a key of an earlier install, with its values.
function New-Key([string] $Path, [string] $Value) {
  $parent = Split-Path $Path -Parent
  if (-not (Test-Path $parent)) {
    New-Key $parent
  }
  if ($Value) {
    New-Item -Path $Path -Value $Value -Force | Out-Null
  } else {
    New-Item -Path $Path -Force | Out-Null
  }
}

function Install-OneDriphe {
  $principal = New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())
  if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    $scope = 'Machine'
    $folder = Join-Path $env:ProgramFiles 'OneDriphe'
    $hive = 'HKLM:\SOFTWARE'
    $who = 'every user of this computer'
  } else {
    $scope = 'User'
    $folder = Join-Path $env:LOCALAPPDATA 'Programs\OneDriphe'
    $hive = 'HKCU:\Software'
    $who = "you ($env:USERNAME)"
  }
  $scheme = "$hive\Classes\onedriphe"
  $apps = "$hive\Microsoft\Windows\CurrentVersion\Uninstall\OneDriphe"
  $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

  New-Item -ItemType Directory -Path $folder -Force | Out-Null
  $script = Install-Script $folder 'onedriphe.ps1' $helper
  $uninstall = Install-Script $folder 'uninstall.ps1' $uninstaller

  New-Key $scheme 'URL:OneDriphe'
  New-ItemProperty -Path $scheme -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
  # The name browsers may show when they ask whether to open the link.
  New-Key "$scheme\shell\open"
  New-ItemProperty -Path "$scheme\shell\open" -Name 'FriendlyAppName' -Value 'OneDriphe' -PropertyType String -Force |
    Out-Null
  # PowerShell is a console program: started by itself, it shows a console
  # window (or Windows Terminal's) for a moment, -WindowStyle Hidden or not.
  # The console host without a window ("--headless", Windows 10 1809 and
  # later) shows none.
  $console = Join-Path $env:SystemRoot 'System32\conhost.exe'
  New-Key "$scheme\shell\open\command" (
    "`"$console`" --headless `"$powershell`" -NoProfile -NonInteractive -ExecutionPolicy Bypass " +
    "-WindowStyle Hidden -File `"$script`" `"%1`"")

  # Windows' list of apps (Settings -> Apps -> Installed apps), which runs the uninstaller.
  New-Key $apps
  $entry = @{
    DisplayName = 'OneDriphe'
    Publisher = 'J&C Bachmann GmbH'
    InstallLocation = $folder
    DisplayIcon = (Join-Path $env:SystemRoot 'explorer.exe')
    UninstallString = "`"$powershell`" -NoProfile -ExecutionPolicy Bypass -File `"$uninstall`" -Scope $scope"
  }
  foreach ($name in $entry.Keys) {
    New-ItemProperty -Path $apps -Name $name -Value $entry[$name] -PropertyType String -Force | Out-Null
  }
  foreach ($name in 'NoModify', 'NoRepair') {
    New-ItemProperty -Path $apps -Name $name -Value 1 -PropertyType DWord -Force | Out-Null
  }

  Write-Output "OneDriphe is installed for $who, in $folder."
  Write-Output 'To remove it: Settings -> Apps -> Installed apps -> OneDriphe -> Uninstall.'
  Write-Output 'The libraries it finds (empty: OneDrive syncs none yet; Exists False: a folder OneDrive no longer uses):'
  & $script -List
}

$failed = $false
try {
  Install-OneDriphe
} catch {
  Write-Output "OneDriphe could not be installed: $($_.Exception.Message)"
  $failed = $true
} finally {
  if (-not $Quiet -and [Environment]::UserInteractive) {
    try {
      Read-Host 'Press Enter to close this window' | Out-Null
    } catch {
      # No console to read from.
    }
  }
}
if ($failed) {
  exit 1
}
