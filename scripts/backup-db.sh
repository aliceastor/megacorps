#!/usr/bin/env bash
# Dump the MegaCorps PostgreSQL database from the docker compose stack.
# Usage:
#   ./scripts/backup-db.sh                      # writes backups/megacorps-<timestamp>.dump
#   CONTAINER=my-pg OUTPUT_DIR=/srv/backups KEEP_DAYS=14 ./scripts/backup-db.sh
set -euo pipefail

CONTAINER="${CONTAINER:-megacorps-postgres}"
DATABASE="${DATABASE:-megacorps}"
DB_USER="${DB_USER:-megacorps}"
OUTPUT_DIR="${OUTPUT_DIR:-backups}"
KEEP_DAYS="${KEEP_DAYS:-30}"

mkdir -p "$OUTPUT_DIR"
timestamp="$(date +%Y%m%d-%H%M%S)"
out_file="$OUTPUT_DIR/megacorps-$timestamp.dump"

# Custom format (-Fc) supports pg_restore with selective/parallel restore.
docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DATABASE" -Fc -f /tmp/megacorps-backup.dump
docker cp "$CONTAINER:/tmp/megacorps-backup.dump" "$out_file"
docker exec "$CONTAINER" rm -f /tmp/megacorps-backup.dump

echo "Backup written to $out_file"

if [ "$KEEP_DAYS" -gt 0 ]; then
  find "$OUTPUT_DIR" -name 'megacorps-*.dump' -type f -mtime "+$KEEP_DAYS" -print -delete
fi

echo "Restore example:"
echo "  docker cp $out_file $CONTAINER:/tmp/restore.dump"
echo "  docker exec $CONTAINER pg_restore -U $DB_USER -d $DATABASE --clean --if-exists /tmp/restore.dump"
