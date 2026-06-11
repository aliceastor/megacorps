# Dump the MegaCorps PostgreSQL database from the docker compose stack.
# Usage:
#   ./scripts/backup-db.ps1                       # writes backups/megacorps-<timestamp>.dump
#   ./scripts/backup-db.ps1 -OutputDir D:\backups -KeepDays 14
param(
  [string]$Container = "megacorps-postgres",
  [string]$Database = "megacorps",
  [string]$User = "megacorps",
  [string]$OutputDir = "backups",
  [int]$KeepDays = 30
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $OutputDir)) { New-Item -ItemType Directory -Force $OutputDir | Out-Null }
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outFile = Join-Path $OutputDir "megacorps-$timestamp.dump"

# Custom format (-Fc) supports pg_restore with selective/parallel restore.
docker exec $Container pg_dump -U $User -d $Database -Fc -f "/tmp/megacorps-backup.dump"
if ($LASTEXITCODE -ne 0) { throw "pg_dump failed with exit code $LASTEXITCODE" }
docker cp "${Container}:/tmp/megacorps-backup.dump" $outFile
if ($LASTEXITCODE -ne 0) { throw "docker cp failed with exit code $LASTEXITCODE" }
docker exec $Container rm -f /tmp/megacorps-backup.dump | Out-Null

Write-Host "Backup written to $outFile"

if ($KeepDays -gt 0) {
  $cutoff = (Get-Date).AddDays(-$KeepDays)
  Get-ChildItem $OutputDir -Filter "megacorps-*.dump" |
    Where-Object { $_.LastWriteTime -lt $cutoff } |
    ForEach-Object {
      Write-Host "Pruning old backup $($_.Name)"
      Remove-Item $_.FullName -Force -Confirm:$false
    }
}

Write-Host "Restore example:"
Write-Host "  docker cp $outFile ${Container}:/tmp/restore.dump"
Write-Host "  docker exec $Container pg_restore -U $User -d $Database --clean --if-exists /tmp/restore.dump"
