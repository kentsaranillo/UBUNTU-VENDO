#!/bin/sh
# Usage: sudo deploy-release.sh /absolute/path/to/release.tar.gz
set -eu
APP=/opt/debian-vendoos
BACKUPS=/var/backups/debian-vendoos
[ "$(id -u)" = 0 ] || { echo "Run as root" >&2; exit 1; }
[ "$#" = 1 ] && [ -f "$1" ] || { echo "Supply a release archive" >&2; exit 1; }
exec 9>/run/vendoos-deployment.lock
flock -n 9 || { echo "Another deployment is running" >&2; exit 1; }
stage=$(mktemp -d)
stamp=$(date -u +%Y%m%dT%H%M%SZ)
backup="$BACKUPS/release-$stamp.tar.gz"
changed=0
timer_active=0
systemctl is-active --quiet vendo-recovery.timer && timer_active=1
cleanup() {
  result=$?
  trap - EXIT INT TERM
  if [ "$result" != 0 ] && [ "$changed" = 1 ]; then
    echo "Deployment failed. Restoring $backup" >&2
    tar -xzf "$backup" -C "$APP"
    systemctl restart debian-vendoos vendo-multiwan vendo-vlan-sync || true
    curl --fail --silent --max-time 5 http://127.0.0.1:3080/health || echo "Rollback needs attention" >&2
  fi
  [ "$timer_active" = 0 ] || systemctl start vendo-recovery.timer
  rm -rf -- "$stage"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 1' INT TERM
# Reject traversal, links, runtime data and unrelated top-level paths.
python3 - "$1" "$stage" <<'PY'
import pathlib, sys, tarfile
allowed = {'server.js', 'access-sync.js', 'multiwan-sync.js', 'vlan-sync.js', 'staff-portals.js',
           'package.json', 'public', 'deploy', 'docs', 'firmware', 'tools', 'test',
           'README.md', '.gitignore', '.gitattributes'}
with tarfile.open(sys.argv[1]) as archive:
    for member in archive.getmembers():
        path = pathlib.PurePosixPath(member.name)
        if path.is_absolute() or '..' in path.parts or not path.parts or path.parts[0] not in allowed:
            raise ValueError('Unsafe release path: ' + member.name)
        if not (member.isfile() or member.isdir()):
            raise ValueError('Links and special files are forbidden')
    archive.extractall(sys.argv[2], filter='data')
PY
for file in server.js access-sync.js multiwan-sync.js vlan-sync.js staff-portals.js; do
  [ ! -f "$stage/$file" ] || /usr/local/bin/node --check "$stage/$file"
done
if [ -d "$stage/deploy" ]; then
  find "$stage/deploy" -name '*.sh' -type f -exec sh -c 'for script do sh -n "$script" || exit 1; done' sh {} +
fi
if [ -d "$stage/public" ]; then
  find "$stage/public" -name '*.js' -type f -exec sh -c 'for script do /usr/local/bin/node --check "$script" || exit 1; done' sh {} +
fi
# Normalize Windows archive modes before copying.
find "$stage" -type d -exec chmod 755 {} +
find "$stage" -type f -exec chmod 644 {} +
if [ -d "$stage/deploy/debian" ]; then
  find "$stage/deploy/debian" -name '*.sh' -type f -exec chmod 755 {} +
  [ ! -f "$stage/deploy/debian/vendoos-power" ] || chmod 755 "$stage/deploy/debian/vendoos-power"
fi
mkdir -p "$BACKUPS"
tar -czf "$backup" -C "$APP" --exclude=./data --exclude=./.git --exclude='*/.pio' --exclude=./backups .
sh "$APP/deploy/debian/backup.sh"
systemctl stop vendo-recovery.timer
changed=1
cp -a "$stage/." "$APP/"
chown -R root:root "$APP/public" "$APP/deploy"
systemctl restart debian-vendoos vendo-multiwan vendo-vlan-sync
attempt=0
healthy() {
  for service in debian-vendoos vendo-multiwan vendo-vlan-sync; do
    systemctl is-active --quiet "$service" || return 1
  done
  curl --fail --silent --max-time 3 http://127.0.0.1:3080/health
}
until healthy; do
  attempt=$((attempt + 1))
  [ "$attempt" -lt 20 ] || exit 1
  sleep 2
done
sleep 5
healthy || exit 1
changed=0
echo "Release healthy. Rollback archive: $backup"
