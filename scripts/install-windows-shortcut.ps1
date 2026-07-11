[CmdletBinding()]
param(
  [string]$ShortcutPath = '',
  [switch]$SelfTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
$trayScript = Join-Path $PSScriptRoot 'codexfast-tray.ps1'
$powershell = (Get-Command powershell.exe -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath $trayScript -PathType Leaf)) {
  throw "Tray launcher not found: $trayScript"
}
if (-not $ShortcutPath) {
  $ShortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'CodexFast.lnk'
}
if ($SelfTest) {
  $ShortcutPath = Join-Path $env:TEMP "codexfast-shortcut-selftest-$PID.lnk"
}

function Resolve-CodexIconPath {
  try {
    $package = @(
      Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue
      Get-AppxPackage -Name 'OpenAI.CodexBeta' -ErrorAction SilentlyContinue
    ) | Where-Object { $_.InstallLocation } | Select-Object -First 1
    if ($package) {
      $candidate = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
      if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        return $candidate
      }
    }
  } catch {
    # The shortcut remains usable with the PowerShell icon.
  }
  return $powershell
}

$shell = New-Object -ComObject WScript.Shell
try {
  Remove-Item -LiteralPath $ShortcutPath -Force -ErrorAction SilentlyContinue
  $shortcut = $shell.CreateShortcut($ShortcutPath)
  $shortcut.TargetPath = $powershell
  $shortcut.Arguments =
    '-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}"' -f $trayScript
  $shortcut.WorkingDirectory = $projectRoot
  $shortcut.Description =
    'Launch CodexFast in the Windows notification area with project-local logs'
  $shortcut.WindowStyle = 7
  $shortcut.IconLocation = "$(Resolve-CodexIconPath),0"
  $shortcut.Save()

  $verified = $shell.CreateShortcut($ShortcutPath)
  if (
    -not (Test-Path -LiteralPath $ShortcutPath -PathType Leaf) -or
    $verified.TargetPath -ne $powershell -or
    $verified.WorkingDirectory -ne $projectRoot -or
    $verified.Arguments -notlike '*codexfast-tray.ps1*'
  ) {
    throw "Shortcut verification failed: $ShortcutPath"
  }

  if ($SelfTest) {
    Write-Output 'codexfast Windows shortcut self-test passed'
  } else {
    Write-Output "CodexFast shortcut installed: $ShortcutPath"
  }
} finally {
  if ($SelfTest) {
    Remove-Item -LiteralPath $ShortcutPath -Force -ErrorAction SilentlyContinue
  }
}
