# Tests of OneDriphe on Windows itself, as administrator (GitHub Actions'
# windows-latest; by hand: an elevated Windows PowerShell, on a computer
# without OneDriphe installed for every user). They install it for every
# user, also from a 32-bit PowerShell as Intune runs it, run the installed
# helper with a library in the registry, and remove it again. They leave
# nothing behind.

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

$script:failures = 0
$script:count = 0
function Assert-Equal($Expected, $Actual, [string] $Name) {
  $script:count++
  if ($Expected -ne $Actual -or ($null -eq $Expected) -ne ($null -eq $Actual)) {
    $script:failures++
    Write-Output "FAIL: $Name`n  expected: $Expected`n  actual:   $Actual"
  }
}

$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$powershell32 = Join-Path $env:SystemRoot 'SysWOW64\WindowsPowerShell\v1.0\powershell.exe'
$folder = Join-Path $env:ProgramFiles 'OneDriphe'
$scheme = 'HKLM:\SOFTWARE\Classes\onedriphe'
$apps = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\OneDriphe'
$library = 'HKCU:\Software\SyncEngines\Providers\OneDrive\OneDripheTest'
$root = Join-Path $env:TEMP "onedriphe-test-$PID"

# Runs a script of this folder in a PowerShell of its own, and returns its exit code.
function Invoke-Script([string] $PowerShell, [string] $Name, [string[]] $Arguments) {
  & $PowerShell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot $Name) @Arguments | Out-Host
  return $LASTEXITCODE
}

function Test-Installed {
  return (Test-Path "$scheme\shell\open\command") -and (Test-Path $apps) -and
    (Test-Path (Join-Path $folder 'onedriphe.ps1')) -and (Test-Path (Join-Path $folder 'uninstall.ps1'))
}

function Test-Removed {
  return -not ((Test-Path $scheme) -or (Test-Path $apps) -or (Test-Path $folder))
}

try {
  Assert-Equal $true (Test-Removed) 'not installed before'

  Assert-Equal 0 (Invoke-Script $powershell 'install.ps1' @('-Quiet')) 'install: exit code'
  Assert-Equal $true (Test-Installed) 'install: for every user'
  $command = (Get-Item "$scheme\shell\open\command").GetValue('')
  Assert-Equal $true ($command -like '"*\conhost.exe" --headless "*\powershell.exe" * -File "*\OneDriphe\onedriphe.ps1" "%1"') "install: the command, without a window ($command)"
  Assert-Equal 'OneDriphe' (Get-ItemProperty "$scheme\shell\open").FriendlyAppName 'install: the name for browsers'
  Assert-Equal 'OneDriphe' (Get-ItemProperty $apps).DisplayName 'install: in the list of apps'
  Assert-Equal $true ((Get-ItemProperty $apps).UninstallString -like '*\uninstall.ps1" -Scope Machine') 'install: the list of apps removes it for every user'

  # The installed helper, with a library in the registry.
  New-Item -ItemType Directory -Path (Join-Path $root 'Plans') | Out-Null
  New-Item -ItemType File -Path (Join-Path $root 'Plans\Budget.xlsx') | Out-Null
  New-Item -Path $library -Force | Out-Null
  Set-ItemProperty -Path $library -Name UrlNamespace -Value 'https://contoso.sharepoint.com/sites/P/Shared Documents/'
  Set-ItemProperty -Path $library -Name MountPoint -Value $root
  $helper = Join-Path $folder 'onedriphe.ps1'
  $site = 'onedriphe:https://contoso.sharepoint.com/sites/P/Shared%20Documents'
  $explain = { param($Link) & $powershell -NoProfile -ExecutionPolicy Bypass -File $helper -Explain $Link }
  Assert-Equal "open $root\Plans" (& $explain "$site/Plans") 'the helper: a synced folder'
  Assert-Equal "select $root\Plans\Budget.xlsx" (& $explain "$site/Plans/Budget.xlsx") 'the helper: a synced file'
  Assert-Equal "open $root\Plans" (& $explain "$site/Plans/New.xlsx") 'the helper: a file not there: its folder'
  Assert-Equal 'browser https://contoso.sharepoint.com/sites/P/Shared%20Documents/Gone/' (& $explain "$site/Gone/a.zip") 'the helper: a folder not there: the browser, at the folder'
  $list = (& $powershell -NoProfile -ExecutionPolicy Bypass -File $helper -List) -join "`n"
  Assert-Equal $true ($list -like "*$root*True*SyncEngines\OneDripheTest*") "the helper: -List ($list)"

  Assert-Equal 0 (Invoke-Script $powershell 'install.ps1' @('-Quiet')) 'install again: exit code'
  Assert-Equal $true (Test-Installed) 'install again: installed'

  Assert-Equal 0 (Invoke-Script $powershell 'uninstall.ps1' @('-Scope', 'Machine', '-Quiet')) 'uninstall: exit code'
  Assert-Equal $true (Test-Removed) 'uninstall: removed'

  # As Intune runs it: a 32-bit PowerShell, where Program Files and HKLM are the 32-bit ones.
  Assert-Equal 0 (Invoke-Script $powershell32 'install.ps1' @('-Quiet')) '32-bit install: exit code'
  Assert-Equal $true (Test-Installed) '32-bit install: where the 64-bit PowerShell looks'
  Assert-Equal $false (Test-Path (Join-Path ${env:ProgramFiles(x86)} 'OneDriphe')) '32-bit install: not in Program Files (x86)'
  Assert-Equal 0 (Invoke-Script $powershell32 'uninstall.ps1' @('-Scope', 'Machine', '-Quiet')) '32-bit uninstall: exit code'
  Assert-Equal $true (Test-Removed) '32-bit uninstall: removed'
} finally {
  if (-not (Test-Removed)) {
    Invoke-Script $powershell 'uninstall.ps1' @('-Scope', 'Machine', '-Quiet') | Out-Null
  }
  Remove-Item -LiteralPath $library -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}

if ($script:failures -gt 0) {
  Write-Output "$script:failures of $script:count failed."
  exit 1
}
Write-Output "All $script:count passed."
exit 0
