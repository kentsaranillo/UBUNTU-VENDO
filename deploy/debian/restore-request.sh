#!/usr/bin/env bash
set -uo pipefail

REQUEST_DIR=/run/debian-vendoos/restore-requests
PROCESSING_DIR=/run/debian-vendoos/restore-processing
STATUS_DIR=/run/debian-vendoos/restore-status
BACKUP_DIR=/var/backups/debian-vendoos
RESTORE_TOOL=/opt/debian-vendoos/deploy/debian/restore.sh

write_status() {
  local id=$1 status=$2 message=$3 temp="$STATUS_DIR/$1.json.tmp"
  printf '{"id":"%s","status":"%s","message":"%s"}\n' "$id" "$status" "$message" > "$temp"
  chown root:vendo "$temp"
  chmod 0640 "$temp"
  mv -f -- "$temp" "$STATUS_DIR/$id.json"
}

shopt -s nullglob
for request in "$REQUEST_DIR"/*.request; do
  id=$(basename -- "$request" .request)
  if [[ ! "$id" =~ ^[a-f0-9]{32}$ || ! -f "$request" || -L "$request" ]]; then
    rm -f -- "$request"
    continue
  fi

  processing="$PROCESSING_DIR/$id.request"
  if ! mv -- "$request" "$processing"; then continue; fi
  IFS= read -r backup_name < "$processing" || backup_name=''
  supplied_id=$(sed -n '2p' "$processing")
  operation=$(sed -n '3p' "$processing")
  if [[ "$supplied_id" != "$id" || ! "$operation" =~ ^(test|apply)$ || ! "$backup_name" =~ ^[A-Za-z0-9][A-Za-z0-9._-]*\.db$ || -L "$BACKUP_DIR/$backup_name" || ! -f "$BACKUP_DIR/$backup_name" ]]; then
    write_status "$id" failed 'The restore request was invalid.'
    rm -f -- "$processing"
    continue
  fi

  if [[ "$operation" == test ]]; then
    write_status "$id" verifying 'A temporary restore copy is being checked.'
    if "$RESTORE_TOOL" --test "$backup_name"; then
      write_status "$id" complete 'Backup integrity and temporary restore-copy checks passed.'
      logger -t vendoos-restore "Restore test passed for $backup_name (request $id)"
    else
      write_status "$id" failed 'Backup validation or temporary restore-copy check failed.'
      logger -p user.err -t vendoos-restore "Restore test failed for $backup_name (request $id)"
    fi
  else
    write_status "$id" restoring 'The live database is being replaced; services may pause briefly.'
    if printf 'RESTORE\n' | "$RESTORE_TOOL" --apply "$backup_name"; then
      write_status "$id" complete 'Restore finished and VendoOS services restarted.'
      logger -t vendoos-restore "Admin restore completed for $backup_name (request $id)"
    else
      write_status "$id" failed 'Restore did not complete. Check VendoOS service logs and the pre-restore safety backup.'
      logger -p user.err -t vendoos-restore "Admin restore failed for $backup_name (request $id)"
    fi
  fi
  rm -f -- "$processing"
done
