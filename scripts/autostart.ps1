# Starts the reader's server (scripts/serve.mjs) every time you sign in to Windows, or stops doing so.
# Nothing runs this for you: start it yourself from the project folder, after `npm run build`.
#
#   powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1             # add the task and start the server now
#   powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Lan        # the same, also reachable from the home network
#   powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Remove     # remove the task and stop the server
#
# The task belongs to your own account and needs no administrator rights. It points at this folder,
# so if you move the project, run the script again from the new place.
param(
  [switch]$Remove,
  [switch]$Lan,
  [int]$Port = 8787
)

$ErrorActionPreference = 'Stop'
$taskName = 'Zakladka reader server'

if ($Remove) {
  $existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
  if ($existing) {
    Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Output "Removed the task '$taskName'."
  } else {
    Write-Output "There is no task '$taskName'."
  }
  exit 0
}

$project = Split-Path -Parent $PSScriptRoot
$server = Join-Path $project 'scripts\serve.mjs'
if (-not (Test-Path (Join-Path $project 'dist\index.html'))) {
  throw "The app is not built yet. Run 'npm run build' in $project first."
}
$node = (Get-Command node -ErrorAction Stop).Source

$arguments = "`"$server`" --port $Port"
if ($Lan) { $arguments += ' --lan' }
# Through a hidden PowerShell, so that no console window stays on screen.
$command = "& `"$node`" $arguments"
$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -WindowStyle Hidden -Command `"$($command -replace '"', '\"')`"" -WorkingDirectory $project
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description 'Serves the Zakladka e-book reader and proxies requests to local model servers.' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
Write-Output "The server will start when you sign in, and is starting now: http://localhost:$Port"
Write-Output "To undo: powershell -ExecutionPolicy Bypass -File scripts\autostart.ps1 -Remove"
