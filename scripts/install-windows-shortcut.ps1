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
$node = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
if (-not (Test-Path -LiteralPath $trayScript -PathType Leaf)) {
  throw "Tray launcher not found: $trayScript"
}
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
  throw "Node.js executable not found: $node"
}
if (-not $ShortcutPath) {
  $ShortcutPath = Join-Path ([Environment]::GetFolderPath('Desktop')) 'CodexFast.lnk'
}
if ($SelfTest) {
  $ShortcutPath = Join-Path $env:TEMP "codexfast-shortcut-selftest-$PID.lnk"
}
$ShortcutPath = [System.IO.Path]::GetFullPath($ShortcutPath)
$shortcutDirectory = Split-Path -Parent $ShortcutPath
$temporaryShortcutPath = Join-Path $shortcutDirectory (
  ".{0}.codexfast-{1}.lnk" -f `
    [System.IO.Path]::GetFileNameWithoutExtension($ShortcutPath),
    [Guid]::NewGuid().ToString('N')
)
$backupShortcutPath = "$temporaryShortcutPath.backup"
if ($SelfTest) {
  Set-Content -LiteralPath $ShortcutPath -Encoding ASCII -Value 'existing shortcut'
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
  $shortcutArguments =
    '-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "{0}" -NodePath "{1}"' -f `
      $trayScript,
      $node
  $shortcut = $shell.CreateShortcut($temporaryShortcutPath)
  $shortcut.TargetPath = $powershell
  $shortcut.Arguments = $shortcutArguments
  $shortcut.WorkingDirectory = $projectRoot
  $shortcut.Description =
    'Launch CodexFast in the Windows notification area with project-local logs'
  $shortcut.WindowStyle = 7
  $shortcut.IconLocation = "$(Resolve-CodexIconPath),0"
  $shortcut.Save()

  $verified = $shell.CreateShortcut($temporaryShortcutPath)
  if (
    -not (Test-Path -LiteralPath $temporaryShortcutPath -PathType Leaf) -or
    $verified.TargetPath -ne $powershell -or
    $verified.WorkingDirectory -ne $projectRoot -or
    $verified.Arguments -ne $shortcutArguments
  ) {
    throw "Shortcut verification failed: $temporaryShortcutPath"
  }
  if (Test-Path -LiteralPath $ShortcutPath -PathType Leaf) {
    [System.IO.File]::Replace(
      $temporaryShortcutPath,
      $ShortcutPath,
      $backupShortcutPath,
      $true
    )
    Remove-Item -LiteralPath $backupShortcutPath -Force -ErrorAction SilentlyContinue
  } else {
    [System.IO.File]::Move($temporaryShortcutPath, $ShortcutPath)
  }

  $verified = $shell.CreateShortcut($ShortcutPath)
  if (
    -not (Test-Path -LiteralPath $ShortcutPath -PathType Leaf) -or
    $verified.TargetPath -ne $powershell -or
    $verified.WorkingDirectory -ne $projectRoot -or
    $verified.Arguments -ne $shortcutArguments
  ) {
    throw "Installed shortcut verification failed: $ShortcutPath"
  }

  if ($SelfTest) {
    Write-Output 'codexfast Windows shortcut self-test passed'
  } else {
    Write-Output "CodexFast shortcut installed: $ShortcutPath"
  }
} finally {
  Remove-Item -LiteralPath $temporaryShortcutPath -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $backupShortcutPath -Force -ErrorAction SilentlyContinue
  if ($SelfTest) {
    Remove-Item -LiteralPath $ShortcutPath -Force -ErrorAction SilentlyContinue
  }
}
