#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

ENV_FILE=/etc/debian-vendoos/vendo.env
[[ -r "$ENV_FILE" ]] || { echo "Missing VendoOS environment: $ENV_FILE" >&2; exit 1; }
# This root-owned file is the same configuration used by the systemd services.
# shellcheck disable=SC1090
. "$ENV_FILE"

DB_FILE=${DB_FILE:-/var/lib/debian-vendoos/vendo.db}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/debian-vendoos}
MODE=${1:-}
BACKUP_NAME=${2:-}

usage() {
  cat <<'EOF'
Usage:
  sudo restore.sh --test BACKUP.db   Validate and restore-test a copy
  sudo restore.sh --apply BACKUP.db  Replace the live database after confirmation

BACKUP.db must be a file directly inside /var/backups/debian-vendoos.
EOF
}

if [[ "$MODE" != --test && "$MODE" != --apply ]] || [[ -z "$BACKUP_NAME" ]] || [[ $# -ne 2 ]]; then
  usage >&2
  exit 2
fi

if [[ ! "$BACKUP_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*\.db$ ]]; then
  echo "Invalid backup filename." >&2
  exit 2
fi

BACKUP_DIR=$(realpath -e -- "$BACKUP_DIR")
[[ ! -L "$BACKUP_DIR/$BACKUP_NAME" ]] || { echo "Backup symlinks are not allowed." >&2; exit 1; }
BACKUP_PATH=$(realpath -e -- "$BACKUP_DIR/$BACKUP_NAME")
[[ "$(dirname -- "$BACKUP_PATH")" == "$BACKUP_DIR" && -f "$BACKUP_PATH" && ! -L "$BACKUP_PATH" ]] || {
  echo "Backup must be a regular file directly inside $BACKUP_DIR." >&2
  exit 1
}
[[ -s "$BACKUP_PATH" ]] || { echo "Backup file is empty." >&2; exit 1; }
[[ -f "$DB_FILE" ]] || { echo "Live database does not exist: $DB_FILE" >&2; exit 1; }

sql_quote() { local value=${1//\'/\'\'}; printf "'%s'" "$value"; }

validate_database() {
  local file=$1 integrity tables
  integrity=$(/usr/bin/sqlite3 -readonly "$file" 'PRAGMA integrity_check;')
  [[ "$integrity" == ok ]] || { echo "SQLite integrity check failed: $integrity" >&2; return 1; }
  tables=$(/usr/bin/sqlite3 -readonly "$file" "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name IN ('settings','zones','machines','rates','access_entitlements');")
  [[ "$tables" == 5 ]] || { echo "Backup is missing required VendoOS tables." >&2; return 1; }
}

validate_database "$BACKUP_PATH"

if [[ "$MODE" == --test ]]; then
  test_copy=$(mktemp "$BACKUP_DIR/.restore-test.XXXXXX")
  trap 'rm -f -- "$test_copy"' EXIT
  rm -f -- "$test_copy"
  /usr/bin/sqlite3 "$BACKUP_PATH" ".backup $(sql_quote "$test_copy")"
  validate_database "$test_copy"
  for table in settings zones machines rates access_entitlements sales vouchers; do
    source_count=$(/usr/bin/sqlite3 -readonly "$BACKUP_PATH" "SELECT COUNT(*) FROM \"$table\";")
    copy_count=$(/usr/bin/sqlite3 -readonly "$test_copy" "SELECT COUNT(*) FROM \"$table\";")
    [[ "$source_count" == "$copy_count" ]] || { echo "Restore-copy row count mismatch in $table." >&2; exit 1; }
  done
  echo "PASS: $BACKUP_NAME is intact and a restore copy opens with matching core table counts."
  exit 0
fi

cat <<EOF
This will replace the live VendoOS database with:
  $BACKUP_NAME

It rolls back sales, vouchers, rates, users, sessions, and network settings to
the backup time. VendoOS services will pause briefly. A pre-restore safety
backup will be saved before replacement.
EOF
read -r -p 'Type RESTORE to continue: ' confirmation
[[ "$confirmation" == RESTORE ]] || { echo "Restore cancelled."; exit 1; }

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
SAFETY_PATH="$BACKUP_DIR/pre-restore-$STAMP.db"
STAGED_PATH=$(mktemp "$(dirname -- "$DB_FILE")/.vendo-restore.XXXXXX")
RESTORE_REPLACED=0
SERVICES_STOPPED=0

start_services() {
  local failed=0 unit
  for unit in debian-vendoos.service vendo-access-sync.service vendo-vlan-sync.service vendo-multiwan.service; do
    /usr/bin/systemctl start "$unit" || failed=1
  done
  return "$failed"
}

on_exit() {
  local status=$?
  trap - EXIT
  if (( status != 0 && RESTORE_REPLACED )) && [[ -f "$SAFETY_PATH" ]]; then
    echo "Restore did not finish cleanly; restoring the pre-restore safety copy." >&2
    local recovery_copy
    recovery_copy=$(mktemp "$(dirname -- "$DB_FILE")/.vendo-recovery.XXXXXX")
    rm -f -- "$recovery_copy"
    /usr/bin/sqlite3 "$SAFETY_PATH" ".backup $(sql_quote "$recovery_copy")"
    chown --reference="$DB_FILE" "$recovery_copy"
    chmod --reference="$DB_FILE" "$recovery_copy"
    mv -f -- "$recovery_copy" "$DB_FILE"
    rm -f -- "$DB_FILE-wal" "$DB_FILE-shm"
    RESTORE_REPLACED=0
  fi
  rm -f -- "$STAGED_PATH"
  if (( SERVICES_STOPPED )); then
    if ! start_services; then
      echo "One or more VendoOS services did not restart; inspect systemctl status." >&2
      status=1
    fi
  fi
  exit "$status"
}
trap on_exit EXIT

SERVICES_STOPPED=1
for unit in vendo-access-sync.service debian-vendoos.service vendo-vlan-sync.service vendo-multiwan.service; do
  /usr/bin/systemctl stop "$unit"
done

/usr/bin/sqlite3 "$DB_FILE" "PRAGMA wal_checkpoint(TRUNCATE);" >/dev/null
/usr/bin/sqlite3 "$DB_FILE" ".backup $(sql_quote "$SAFETY_PATH")"
chown --reference="$DB_FILE" "$SAFETY_PATH"
chmod --reference="$DB_FILE" "$SAFETY_PATH"
validate_database "$SAFETY_PATH"

rm -f -- "$STAGED_PATH"
/usr/bin/sqlite3 "$BACKUP_PATH" ".backup $(sql_quote "$STAGED_PATH")"
validate_database "$STAGED_PATH"
chown --reference="$DB_FILE" "$STAGED_PATH"
chmod --reference="$DB_FILE" "$STAGED_PATH"

mv -f -- "$STAGED_PATH" "$DB_FILE"
RESTORE_REPLACED=1
rm -f -- "$DB_FILE-wal" "$DB_FILE-shm"

if ! validate_database "$DB_FILE"; then
  echo "Restored database failed validation; rolling back to $SAFETY_PATH." >&2
  recovery_copy=$(mktemp "$(dirname -- "$DB_FILE")/.vendo-recovery.XXXXXX")
  rm -f -- "$recovery_copy"
  /usr/bin/sqlite3 "$SAFETY_PATH" ".backup $(sql_quote "$recovery_copy")"
  chown --reference="$DB_FILE" "$recovery_copy"
  chmod --reference="$DB_FILE" "$recovery_copy"
  mv -f -- "$recovery_copy" "$DB_FILE"
  rm -f -- "$DB_FILE-wal" "$DB_FILE-shm"
  RESTORE_REPLACED=0
  exit 1
fi

/usr/bin/logger -t vendoos-restore "Database restored from $BACKUP_NAME; safety copy $SAFETY_PATH"
echo "Restore complete. Safety copy: $SAFETY_PATH"
