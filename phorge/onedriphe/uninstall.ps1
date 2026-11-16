<#
.SYNOPSIS
  Removes OneDriphe (see install.ps1 and README.md).

.DESCRIPTION
  Removes the "onedriphe" link scheme, the entry in Windows' list of apps,
  and the folder of the scripts: of the current user's install
  ("%LOCALAPPDATA%\Programs\OneDriphe", HKCU), and of the install for every
  user ("C:\Program Files\OneDriphe", HKLM), which needs administrator
  rights: without them it asks for them (UAC) and runs again in a window of
  its own. Windows' list of apps (Settings -> Apps -> Installed apps ->
  OneDriphe -> Uninstall) runs the copy of it in the install's folder, for
  that install.

  Started by itself, it waits for Enter at the end, so that its window can be
  read.

.PARAMETER Scope
  User (the current user's install), Machine (the one for every user), or
  All (both, the default).

.PARAMETER Quiet
  Does not wait for Enter at the end (for Intune and scripts).

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File uninstall.ps1
#>
[CmdletBinding()]
param(
  [ValidateSet('User', 'Machine', 'All')] [string] $Scope = 'All',
  [switch] $Quiet,
  [switch] $Elevated
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# As install.ps1: in a 32-bit PowerShell (Intune), run in the 64-bit one.
if ([Environment]::Is64BitOperatingSystem -and -not [Environment]::Is64BitProcess) {
  $native = Join-Path $env:SystemRoot 'Sysnative\WindowsPowerShell\v1.0\powershell.exe'
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath, '-Scope', $Scope)
  if ($Quiet) {
    $arguments += '-Quiet'
  }
  if ($Elevated) {
    $arguments += '-Elevated'
  }
  & $native @arguments
  exit $LASTEXITCODE
}

$installs = @{
  User = @{ Folder = (Join-Path $env:LOCALAPPDATA 'Programs\OneDriphe'); Hive = 'HKCU:\Software' }
  Machine = @{ Folder = (Join-Path $env:ProgramFiles 'OneDriphe'); Hive = 'HKLM:\SOFTWARE' }
}

# The parts of an install that are there.
function Get-Parts($Install) {
  $parts = @(
    "$($Install.Hive)\Classes\onedriphe",
    "$($Install.Hive)\Microsoft\Windows\CurrentVersion\Uninstall\OneDriphe",
    $Install.Folder
  )
  return @($parts | Where-Object { Test-Path -LiteralPath $_ })
}

function Remove-Install($Install) {
  # This script may be the copy in the folder: PowerShell has read it already.
  Set-Location $env:SystemRoot
  foreach ($part in Get-Parts $Install) {
    Remove-Item -LiteralPath $part -Recurse -Force
  }
}

<#
  Removes the installs of the scope. Without administrator rights, it hands
  the install for every user to an elevated run in a window of its own
  ($script:handedOver), which waits for Enter itself.
#>
function Uninstall-OneDriphe {
  $removed = @()
  if ($Scope -ne 'Machine' -and (Get-Parts $installs.User).Count -gt 0) {
    Remove-Install $installs.User
    $removed += 'for you'
  }
  if ($Scope -ne 'User' -and (Get-Parts $installs.Machine).Count -gt 0) {
    $principal = New-Object Security.Principal.WindowsPrincipal ([Security.Principal.WindowsIdentity]::GetCurrent())
    if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
      Remove-Install $installs.Machine
      $removed += 'for every user'
    } elseif ($Elevated) {
      throw 'The install for every user can only be removed with administrator rights.'
    } else {
      if ($removed.Count -gt 0) {
        Write-Output "OneDriphe is removed $($removed -join ' and ')."
      }
      $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
      try {
        Start-Process -FilePath $powershell -Verb RunAs -ArgumentList (
          "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" -Scope Machine -Elevated")
      } catch {
        throw 'The install for every user is not removed: it needs administrator rights, which were not given.'
      }
      $script:handedOver = $true
      return
    }
  }
  if ($removed.Count -gt 0) {
    Write-Output "OneDriphe is removed $($removed -join ' and ')."
  } else {
    Write-Output 'OneDriphe is not installed.'
  }
}

$failed = $false
$script:handedOver = $false
try {
  Uninstall-OneDriphe
} catch {
  Write-Output "OneDriphe could not be removed: $($_.Exception.Message)"
  $failed = $true
} finally {
  if (-not $script:handedOver -and -not $Quiet -and [Environment]::UserInteractive) {
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
