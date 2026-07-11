[CmdletBinding()]
param(
  [switch]$SelfTest,
  [switch]$NoAutoStart,
  [switch]$SmokeTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:ProjectRoot = Split-Path -Parent $PSScriptRoot
$script:CliPath = Join-Path $script:ProjectRoot 'bin\codexfast'
$script:LogDirectory = Join-Path $script:ProjectRoot 'logs'
$script:LogPath = Join-Path $script:LogDirectory 'launcher.log'
$script:PreviousLogPath = Join-Path $script:LogDirectory 'launcher.previous.log'
$script:NodePath = (Get-Command node.exe -ErrorAction Stop).Source
$script:LauncherProcess = $null
$script:SessionLogOffset = 0L
$script:ReadyNotified = $false
$script:ExitHandled = $false
$script:NotifyIcon = $null
$script:StatusItem = $null
$script:StartItem = $null
$script:Timer = $null
$script:SmokeTimer = $null
$script:ApplicationContext = $null
$script:Mutex = $null
$script:OwnedIcon = $null

function Quote-CmdArgument {
  param([Parameter(Mandatory = $true)][string]$Value)

  return '"' + $Value.Replace('"', '""') + '"'
}

function Get-LauncherCommandLine {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string]$LogPath
  )

  $node = Quote-CmdArgument $script:NodePath
  $cli = Quote-CmdArgument $script:CliPath
  $log = Quote-CmdArgument $LogPath
  return "$node $cli $Command >> $log 2>&1"
}

function New-LauncherProcessStartInfo {
  param(
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter(Mandatory = $true)][string]$LogPath
  )

  $commandLine = Get-LauncherCommandLine -Command $Command -LogPath $LogPath
  $startInfo = New-Object System.Diagnostics.ProcessStartInfo
  $startInfo.FileName = $env:ComSpec
  $startInfo.Arguments = '/d /s /c "' + $commandLine + '"'
  $startInfo.WorkingDirectory = $script:ProjectRoot
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  return $startInfo
}

function Invoke-TraySelfTest {
  if (-not (Test-Path -LiteralPath $script:CliPath -PathType Leaf)) {
    throw "Generated CLI not found: $script:CliPath"
  }
  if (-not (Test-Path -LiteralPath $script:NodePath -PathType Leaf)) {
    throw "Node.js not found: $script:NodePath"
  }

  $testLog = Join-Path $env:TEMP "codexfast-tray-selftest-$PID.log"
  $originalLogPath = $script:LogPath
  $originalLogOffset = $script:SessionLogOffset
  try {
    Remove-Item -LiteralPath $testLog -Force -ErrorAction SilentlyContinue
    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = New-LauncherProcessStartInfo `
      -Command 'version' `
      -LogPath $testLog
    if (-not $process.Start()) {
      throw 'Could not start the tray self-test process.'
    }
    $process.WaitForExit()
    $exitCode = $process.ExitCode
    $process.Dispose()
    $output = if (Test-Path -LiteralPath $testLog) {
      (Get-Content -LiteralPath $testLog -Raw).Trim()
    } else {
      ''
    }
    if ($exitCode -ne 0 -or $output -notmatch '^codexfast\s+\d+\.\d+\.\d+$') {
      throw "Tray self-test command failed with exit code ${exitCode}: $output"
    }
    $script:LogPath = $testLog
    $script:SessionLogOffset = 0L
    if ((Get-CurrentSessionLog).Trim() -ne $output) {
      throw 'Tray self-test could not read the redirected session log.'
    }
    Write-Output 'codexfast tray self-test passed'
    Write-Output "Log path: $originalLogPath"
  } finally {
    $script:LogPath = $originalLogPath
    $script:SessionLogOffset = $originalLogOffset
    Remove-Item -LiteralPath $testLog -Force -ErrorAction SilentlyContinue
  }
}

function Ensure-LogDirectory {
  if (-not (Test-Path -LiteralPath $script:LogDirectory -PathType Container)) {
    New-Item -ItemType Directory -Path $script:LogDirectory -Force | Out-Null
  }
}

function Rotate-LauncherLog {
  Ensure-LogDirectory
  if (-not (Test-Path -LiteralPath $script:LogPath -PathType Leaf)) {
    return
  }
  $maximumLogSize = 5MB
  if ((Get-Item -LiteralPath $script:LogPath).Length -lt $maximumLogSize) {
    return
  }
  Remove-Item -LiteralPath $script:PreviousLogPath -Force -ErrorAction SilentlyContinue
  Move-Item -LiteralPath $script:LogPath -Destination $script:PreviousLogPath
}

function Get-CurrentSessionLog {
  if (-not (Test-Path -LiteralPath $script:LogPath -PathType Leaf)) {
    return ''
  }
  $stream = [System.IO.File]::Open(
    $script:LogPath,
    [System.IO.FileMode]::Open,
    [System.IO.FileAccess]::Read,
    [System.IO.FileShare]::ReadWrite
  )
  try {
    $offset = [Math]::Min($script:SessionLogOffset, $stream.Length)
    [void]$stream.Seek($offset, [System.IO.SeekOrigin]::Begin)
    $reader = New-Object System.IO.StreamReader($stream)
    try {
      return $reader.ReadToEnd()
    } finally {
      $reader.Dispose()
    }
  } finally {
    $stream.Dispose()
  }
}

function Get-LauncherLogTail {
  if (-not (Test-Path -LiteralPath $script:LogPath -PathType Leaf)) {
    return 'No launcher log is available.'
  }
  return ((Get-Content -LiteralPath $script:LogPath -Tail 24) -join [Environment]::NewLine)
}

function Set-TrayStatus {
  param([Parameter(Mandatory = $true)][string]$Status)

  $script:StatusItem.Text = "Status: $Status"
  $tooltip = "CodexFast: $Status"
  if ($tooltip.Length -gt 63) {
    $tooltip = $tooltip.Substring(0, 63)
  }
  $script:NotifyIcon.Text = $tooltip
  $script:StartItem.Enabled = $null -eq $script:LauncherProcess
}

function Show-TrayNotification {
  param(
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string]$Message,
    [System.Windows.Forms.ToolTipIcon]$Icon = [System.Windows.Forms.ToolTipIcon]::Info
  )

  $script:NotifyIcon.BalloonTipTitle = $Title
  $script:NotifyIcon.BalloonTipText = $Message
  $script:NotifyIcon.BalloonTipIcon = $Icon
  $script:NotifyIcon.ShowBalloonTip(4000)
}

function Show-LauncherError {
  param([Parameter(Mandatory = $true)][string]$Message)

  [void][System.Windows.Forms.MessageBox]::Show(
    $Message,
    'CodexFast Launcher',
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::Error
  )
}

function Start-CodexFastLauncher {
  if ($null -ne $script:LauncherProcess -and -not $script:LauncherProcess.HasExited) {
    return
  }
  if (-not (Test-Path -LiteralPath $script:CliPath -PathType Leaf)) {
    Show-LauncherError "Generated CLI not found:`n$script:CliPath"
    return
  }

  try {
    Rotate-LauncherLog
    Ensure-LogDirectory
    $script:SessionLogOffset = if (Test-Path -LiteralPath $script:LogPath) {
      (Get-Item -LiteralPath $script:LogPath).Length
    } else {
      0L
    }
    Add-Content -LiteralPath $script:LogPath -Encoding UTF8 -Value @(
      ''
      "===== CodexFast tray session $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') ====="
    )

    $process = New-Object System.Diagnostics.Process
    $process.StartInfo = New-LauncherProcessStartInfo `
      -Command 'launch' `
      -LogPath $script:LogPath
    if (-not $process.Start()) {
      throw 'Could not start the codexfast launcher process.'
    }
    $script:LauncherProcess = $process
    $script:ReadyNotified = $false
    $script:ExitHandled = $false
    Set-TrayStatus 'Starting'
  } catch {
    $script:LauncherProcess = $null
    Set-TrayStatus 'Failed to start'
    Show-LauncherError $_.Exception.Message
  }
}

function Complete-LauncherProcess {
  if ($null -eq $script:LauncherProcess -or $script:ExitHandled) {
    return
  }
  if (-not $script:LauncherProcess.HasExited) {
    return
  }

  $script:ExitHandled = $true
  $script:LauncherProcess.WaitForExit()
  $exitCode = $script:LauncherProcess.ExitCode
  $script:LauncherProcess.Dispose()
  $script:LauncherProcess = $null
  $script:StartItem.Enabled = $true

  if ($exitCode -eq 0) {
    Set-TrayStatus 'Stopped'
    Show-TrayNotification `
      -Title 'CodexFast stopped' `
      -Message 'Codex Desktop closed and the runtime launcher exited normally.'
    return
  }

  Set-TrayStatus "Failed (exit $exitCode)"
  Show-TrayNotification `
    -Title 'CodexFast launch failed' `
    -Message "The launcher exited with code $exitCode. Open the log for details." `
    -Icon ([System.Windows.Forms.ToolTipIcon]::Error)
  $tail = Get-LauncherLogTail
  Show-LauncherError "CodexFast exited with code $exitCode.`n`n$tail"
}

function Update-LauncherStatus {
  if ($null -eq $script:LauncherProcess) {
    return
  }

  $sessionLog = Get-CurrentSessionLog
  if (
    -not $script:ReadyNotified -and
    $sessionLog.Contains('Runtime launch completed.')
  ) {
    $script:ReadyNotified = $true
    Set-TrayStatus 'Active'
    Show-TrayNotification `
      -Title 'CodexFast is active' `
      -Message 'Runtime model patches are active. Keep the tray icon running.'
  }
  Complete-LauncherProcess
}

function Open-LauncherLog {
  Ensure-LogDirectory
  if (-not (Test-Path -LiteralPath $script:LogPath -PathType Leaf)) {
    New-Item -ItemType File -Path $script:LogPath -Force | Out-Null
  }
  Start-Process -FilePath 'notepad.exe' -ArgumentList @($script:LogPath)
}

function Request-TrayExit {
  if ($null -ne $script:LauncherProcess -and -not $script:LauncherProcess.HasExited) {
    [void][System.Windows.Forms.MessageBox]::Show(
      'CodexFast is active. Quit Codex Desktop first so the runtime launcher can shut down safely.',
      'CodexFast Launcher',
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Information
    )
    return
  }
  if ($null -ne $script:LauncherProcess) {
    Complete-LauncherProcess
  }

  $script:Timer.Stop()
  $script:NotifyIcon.Visible = $false
  $script:ApplicationContext.ExitThread()
}

function Resolve-TrayIcon {
  try {
    $package = @(
      Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue
      Get-AppxPackage -Name 'OpenAI.CodexBeta' -ErrorAction SilentlyContinue
    ) | Where-Object { $_.InstallLocation } | Select-Object -First 1
    if ($package) {
      $executable = Join-Path $package.InstallLocation 'app\ChatGPT.exe'
      if (Test-Path -LiteralPath $executable -PathType Leaf) {
        $icon = [System.Drawing.Icon]::ExtractAssociatedIcon($executable)
        if ($icon) {
          $script:OwnedIcon = $icon
          return $icon
        }
      }
    }
  } catch {
    # Fall back to a system icon when the package icon is not readable.
  }
  return [System.Drawing.SystemIcons]::Application
}

function Start-TrayApplication {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  [System.Windows.Forms.Application]::EnableVisualStyles()

  $createdNew = $false
  $mutexName = if ($SmokeTest) {
    "Local\CodexFastTraySmokeTest-$PID"
  } else {
    'Local\CodexFastTray'
  }
  $script:Mutex = New-Object System.Threading.Mutex(
    $true,
    $mutexName,
    [ref]$createdNew
  )
  if (-not $createdNew) {
    [void][System.Windows.Forms.MessageBox]::Show(
      'CodexFast tray is already running.',
      'CodexFast Launcher',
      [System.Windows.Forms.MessageBoxButtons]::OK,
      [System.Windows.Forms.MessageBoxIcon]::Information
    )
    return
  }

  $script:ApplicationContext = New-Object System.Windows.Forms.ApplicationContext
  $script:NotifyIcon = New-Object System.Windows.Forms.NotifyIcon
  $script:NotifyIcon.Icon = Resolve-TrayIcon
  $script:NotifyIcon.Text = 'CodexFast: Stopped'
  $script:NotifyIcon.Visible = $true

  $menu = New-Object System.Windows.Forms.ContextMenuStrip
  $script:StatusItem = New-Object System.Windows.Forms.ToolStripMenuItem('Status: Stopped')
  $script:StatusItem.Enabled = $false
  $script:StartItem = New-Object System.Windows.Forms.ToolStripMenuItem('Start CodexFast')
  $viewLogItem = New-Object System.Windows.Forms.ToolStripMenuItem('View launcher log')
  $openProjectItem = New-Object System.Windows.Forms.ToolStripMenuItem('Open project folder')
  $exitItem = New-Object System.Windows.Forms.ToolStripMenuItem('Exit tray')

  [void]$menu.Items.Add($script:StatusItem)
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  [void]$menu.Items.Add($script:StartItem)
  [void]$menu.Items.Add($viewLogItem)
  [void]$menu.Items.Add($openProjectItem)
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  [void]$menu.Items.Add($exitItem)
  $script:NotifyIcon.ContextMenuStrip = $menu

  $script:StartItem.Add_Click({ Start-CodexFastLauncher })
  $viewLogItem.Add_Click({ Open-LauncherLog })
  $openProjectItem.Add_Click({
    Start-Process -FilePath 'explorer.exe' -ArgumentList @($script:ProjectRoot)
  })
  $exitItem.Add_Click({ Request-TrayExit })
  $script:NotifyIcon.Add_DoubleClick({ Open-LauncherLog })

  $script:Timer = New-Object System.Windows.Forms.Timer
  $script:Timer.Interval = 500
  $script:Timer.Add_Tick({ Update-LauncherStatus })
  $script:Timer.Start()

  if (-not $NoAutoStart -and -not $SmokeTest) {
    Start-CodexFastLauncher
  }
  if ($SmokeTest) {
    $script:SmokeTimer = New-Object System.Windows.Forms.Timer
    $script:SmokeTimer.Interval = 800
    $script:SmokeTimer.Add_Tick({
      $script:SmokeTimer.Stop()
      $script:NotifyIcon.Visible = $false
      $script:ApplicationContext.ExitThread()
    })
    $script:SmokeTimer.Start()
  }
  [System.Windows.Forms.Application]::Run($script:ApplicationContext)
  if ($SmokeTest) {
    Write-Output 'codexfast tray smoke test passed'
  }
}

if ($SelfTest) {
  Invoke-TraySelfTest
  exit 0
}

try {
  Start-TrayApplication
} catch {
  try {
    Ensure-LogDirectory
    Add-Content -LiteralPath $script:LogPath -Encoding UTF8 -Value `
      "Tray fatal error: $($_.Exception.ToString())"
    Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
    Show-LauncherError $_.Exception.Message
  } catch {
    # The tray has no console; avoid masking the original failure.
  }
  exit 1
} finally {
  if ($script:Timer) {
    $script:Timer.Stop()
    $script:Timer.Dispose()
  }
  if ($script:SmokeTimer) {
    $script:SmokeTimer.Stop()
    $script:SmokeTimer.Dispose()
  }
  if ($script:NotifyIcon) {
    $script:NotifyIcon.Visible = $false
    $script:NotifyIcon.Dispose()
  }
  if ($script:OwnedIcon) {
    $script:OwnedIcon.Dispose()
  }
  if ($script:Mutex) {
    try { $script:Mutex.ReleaseMutex() } catch {}
    $script:Mutex.Dispose()
  }
}
