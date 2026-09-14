param(
  [Parameter(Mandatory = $true)][int]$ExpectedPid,
  [Parameter(Mandatory = $true)][string]$ExpectedCreationUtc
)

# One-time migration from the old elevated manager, which has no shutdown API.
# This helper stops only that verified, idle Node manager. It never starts an elevated app.
$ErrorActionPreference = 'Stop'
$taskRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$taskData = Join-Path $taskRoot 'data'
$taskResultFile = Join-Path $taskData 'legacy-shutdown-result.json'

try {
  $taskStatus = Invoke-RestMethod 'http://127.0.0.1:3400/api/status' -TimeoutSec 5
  if ($taskStatus.server.status -ne 'stopped' -or $taskStatus.server.players.Count -ne 0) {
    throw 'Minecraft is not stopped and empty. Refusing migration.'
  }
  if ([System.IO.Path]::GetFullPath($taskStatus.setup.dataDir) -ne $taskData) {
    throw 'The dashboard data directory does not match this checkout.'
  }
  $taskOwners = @(Get-NetTCPConnection -LocalPort 3400 -State Listen | Select-Object -ExpandProperty OwningProcess -Unique)
  if ($taskOwners.Count -ne 1 -or $taskOwners[0] -ne $ExpectedPid) { throw 'Dashboard process identity changed.' }
  $taskProcess = Get-CimInstance Win32_Process -Filter "ProcessId=$ExpectedPid"
  if (!$taskProcess -or $taskProcess.Name -ne 'node.exe' -or
      $taskProcess.CreationDate.ToUniversalTime() -ne [DateTime]::Parse($ExpectedCreationUtc).ToUniversalTime()) {
    throw 'Process creation time changed; refusing to stop a reused PID.'
  }
  if (Get-NetTCPConnection -LocalPort 25565 -State Listen -ErrorAction SilentlyContinue) {
    throw 'The game port is listening. Refusing migration.'
  }
  Stop-Process -Id $ExpectedPid -ErrorAction Stop
  Wait-Process -Id $ExpectedPid -Timeout 10 -ErrorAction SilentlyContinue
  if (Get-NetTCPConnection -LocalPort 3400 -State Listen -ErrorAction SilentlyContinue) {
    throw 'Port 3400 is still occupied after stopping the old manager.'
  }
  @{ success = $true; stoppedPid = $ExpectedPid; completedAt = [DateTime]::UtcNow.ToString('o') } |
    ConvertTo-Json | Set-Content -LiteralPath $taskResultFile -Encoding utf8
} catch {
  @{ success = $false; error = $_.Exception.Message; completedAt = [DateTime]::UtcNow.ToString('o') } |
    ConvertTo-Json | Set-Content -LiteralPath $taskResultFile -Encoding utf8
  exit 1
}
