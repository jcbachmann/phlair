# Checks that OneDriphe's scripts run on Windows PowerShell 5.1 as Windows
# 10 and 11 have it (syntax, commands and their parameters, .NET types), with
# PSScriptAnalyzer, which it installs if it is not there. "npm run
# test:windows" runs it in a PowerShell container after the tests: the
# container's PowerShell 7 parses syntax that 5.1 does not.

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$version = '1.23.0'
if (-not (Get-Module -ListAvailable PSScriptAnalyzer | Where-Object { $_.Version -eq $version })) {
  Install-Module PSScriptAnalyzer -RequiredVersion $version -Scope CurrentUser -Force
}
Import-Module PSScriptAnalyzer -RequiredVersion $version

# Windows PowerShell 5.1 of Windows 10 1809, with .NET Framework 4 (a profile of PSScriptAnalyzer).
$windows = 'win-48_x64_10.0.17763.0_5.1.17763.316_x64_4.0.30319.42000_framework'
$settings = @{
  IncludeRules = @('PSUseCompatibleSyntax', 'PSUseCompatibleCommands', 'PSUseCompatibleTypes')
  Rules = @{
    PSUseCompatibleSyntax = @{ Enable = $true; TargetVersions = @('5.1') }
    PSUseCompatibleCommands = @{ Enable = $true; TargetProfiles = @($windows) }
    PSUseCompatibleTypes = @{ Enable = $true; TargetProfiles = @($windows) }
  }
}
$findings = @()
foreach ($name in 'onedriphe.ps1', 'install.ps1', 'uninstall.ps1', 'onedriphe.tests.ps1', 'windows.tests.ps1') {
  $findings += @(Invoke-ScriptAnalyzer -Path (Join-Path $PSScriptRoot $name) -Settings $settings)
}
if ($findings.Count -gt 0) {
  $findings | Format-Table ScriptName, Line, Message -AutoSize -Wrap | Out-String -Width 200
  Write-Output "$($findings.Count) incompatibilities with Windows PowerShell 5.1."
  exit 1
}
Write-Output 'Compatible with Windows PowerShell 5.1.'
