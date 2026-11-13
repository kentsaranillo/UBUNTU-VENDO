#!/bin/sh
set -eu
. /etc/debian-vendoos/vendo.env
BACKUP_DIR=/var/backups/debian-vendoos
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 0750 -o vendo -g vendo "$BACKUP_DIR"
/usr/bin/sqlite3 "$DB_FILE" ".backup '$BACKUP_DIR/vendo-$STAMP.db'"
BACKUP_FILE="$BACKUP_DIR/vendo-$STAMP.db"
if [ ! -s "$BACKUP_FILE" ] || [ "$(/usr/bin/sqlite3 -readonly "$BACKUP_FILE" 'PRAGMA integrity_check;')" != 'ok' ]; then
  rm -f "$BACKUP_FILE"
  echo "VendoOS backup failed integrity validation." >&2
  exit 1
fi
chown vendo:vendo "$BACKUP_FILE"
find "$BACKUP_DIR" -type f -name 'vendo-*.db' -mtime +30 -delete
if [ -n "${OFFSITE_BACKUP_SSH_TARGET:-}" ] || [ -n "${OFFSITE_BACKUP_PATH:-}" ] || [ -n "${OFFSITE_BACKUP_SSH_KEY:-}" ] || [ -n "${OFFSITE_BACKUP_ENCRYPTION_KEY_FILE:-}" ]; then
  : "${OFFSITE_BACKUP_SSH_TARGET:?Set OFFSITE_BACKUP_SSH_TARGET to user@host when enabling offsite backup}"
  : "${OFFSITE_BACKUP_PATH:?Set OFFSITE_BACKUP_PATH when enabling offsite backup}"
  : "${OFFSITE_BACKUP_SSH_KEY:?Set OFFSITE_BACKUP_SSH_KEY when enabling offsite backup}"
  : "${OFFSITE_BACKUP_ENCRYPTION_KEY_FILE:?Set OFFSITE_BACKUP_ENCRYPTION_KEY_FILE when enabling offsite backup}"
  [ -r "$OFFSITE_BACKUP_SSH_KEY" ] || { echo "Offsite SSH key is not readable." >&2; exit 1; }
  [ -r "$OFFSITE_BACKUP_ENCRYPTION_KEY_FILE" ] || { echo "Offsite encryption key file is not readable." >&2; exit 1; }
  case "$OFFSITE_BACKUP_PATH" in /*) ;; *) echo "Offsite backup path must be absolute." >&2; exit 1 ;; esac
  OFFSITE_TEMP="$(mktemp /tmp/vendoos-backup.XXXXXX.enc)"
  trap 'rm -f "$OFFSITE_TEMP"' EXIT HUP INT TERM
  chmod 0600 "$OFFSITE_TEMP"
  openssl enc -aes-256-cbc -salt -pbkdf2 -iter 310000 \
    -pass "file:$OFFSITE_BACKUP_ENCRYPTION_KEY_FILE" \
    -in "$BACKUP_FILE" -out "$OFFSITE_TEMP"
  scp -q -i "$OFFSITE_BACKUP_SSH_KEY" \
    -o BatchMode=yes -o StrictHostKeyChecking=yes \
    "$OFFSITE_TEMP" "$OFFSITE_BACKUP_SSH_TARGET:$OFFSITE_BACKUP_PATH/$(basename "$BACKUP_FILE").enc"
  rm -f "$OFFSITE_TEMP"
  trap - EXIT HUP INT TERM
fi
