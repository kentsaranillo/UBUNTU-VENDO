#!/bin/sh
set -eu

if [ "$(id -u)" -ne 0 ]; then
  echo "Run this installer as root: sudo bash deploy/debian/install.sh" >&2
  exit 1
fi
if [ ! -r /etc/os-release ]; then echo "Debian-compatible Linux is required" >&2; exit 1; fi
. /etc/os-release
case "${ID:-}:${ID_LIKE:-}" in *debian*|*ubuntu*) : ;; *) echo "This installer supports Debian and Debian-derived systems" >&2; exit 1;; esac

SOURCE_DIR="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
APP_DIR=/opt/debian-vendoos
CONFIG_DIR=/etc/debian-vendoos
DATA_DIR_DEFAULT=/var/lib/debian-vendoos

CUSTOMER_IF=${CUSTOMER_IF:-wlan0}
WAN_IF=${WAN_IF:-eth0}
MANAGEMENT_CIDR=${MANAGEMENT_CIDR:-127.0.0.1/32}
HOTSPOT_MODE=${HOTSPOT_MODE:-wifi}
SSID=${SSID:-VendoOS-WiFi}
WIFI_CHANNEL=${WIFI_CHANNEL:-6}
WIFI_COUNTRY=${WIFI_COUNTRY:-PH}
HOTSPOT_ADDRESS=${HOTSPOT_ADDRESS:-10.88.0.1}
HOTSPOT_CIDR=${HOTSPOT_CIDR:-10.88.0.1/24}
HOTSPOT_SUBNET=${HOTSPOT_SUBNET:-10.88.0.0/24}
HOTSPOT_PREFIX=${HOTSPOT_PREFIX:-24}
HOTSPOT_NETMASK=${HOTSPOT_NETMASK:-255.255.255.0}
DHCP_START=${DHCP_START:-10.88.0.20}
DHCP_END=${DHCP_END:-10.88.0.250}
DHCP_LEASE=${DHCP_LEASE:-12h}
PORT=${PORT:-3080}
PORTAL_URL=${PORTAL_URL:-http://$HOTSPOT_ADDRESS:$PORT/}

case "$CUSTOMER_IF$WAN_IF" in *[!A-Za-z0-9_.:-]*) echo "Invalid network interface name" >&2; exit 1;; esac
case "$HOTSPOT_MODE" in wifi|lan) : ;; *) echo "HOTSPOT_MODE must be wifi or lan" >&2; exit 1;; esac
case "$SSID" in *[!A-Za-z0-9_.\ -]*) echo "SSID contains unsupported characters" >&2; exit 1;; esac

# PPPoE is optional at runtime, but installing its small Debian helpers keeps
# every physical WAN ready for DHCP, static IP, or ISP username/password mode.
if ! command -v pppd >/dev/null 2>&1 || ! command -v pppoe >/dev/null 2>&1; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ppp pppoe
fi

for required_command in node rsync openssl dnsmasq nft ip tc modprobe sudo; do
  command -v "$required_command" >/dev/null 2>&1 || {
    echo "Missing required command: $required_command" >&2
    exit 1
  }
done

need_node=1
if command -v node >/dev/null 2>&1; then
  major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
  [ "$major" -ge 22 ] && need_node=0
fi
if [ "$need_node" -eq 1 ]; then
  case "$(dpkg --print-architecture)" in
    amd64) node_arch=x64 ;;
    arm64) node_arch=arm64 ;;
    armhf) node_arch=armv7l ;;
    *) echo "Unsupported architecture: $(dpkg --print-architecture)" >&2; exit 1 ;;
  esac
  temp_dir="$(mktemp -d)"
  trap 'rm -rf "$temp_dir"' EXIT
  curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt -o "$temp_dir/SHASUMS256.txt"
  node_file="$(awk -v suffix="linux-$node_arch.tar.xz" '$2 ~ suffix "$" { print $2; exit }' "$temp_dir/SHASUMS256.txt")"
  [ -n "$node_file" ] || { echo "Unable to locate Node.js 22 for $node_arch" >&2; exit 1; }
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/$node_file" -o "$temp_dir/$node_file"
  (cd "$temp_dir" && grep " $node_file$" SHASUMS256.txt | sha256sum -c -)
  install -d /usr/local/lib/nodejs
  tar -xJf "$temp_dir/$node_file" -C /usr/local/lib/nodejs
  node_root="/usr/local/lib/nodejs/${node_file%.tar.xz}"
  ln -sf "$node_root/bin/node" /usr/local/bin/node
  ln -sf "$node_root/bin/npm" /usr/local/bin/npm
  rm -rf "$temp_dir"
  trap - EXIT
else
  if [ "$(command -v node)" != /usr/local/bin/node ]; then ln -sf "$(command -v node)" /usr/local/bin/node; fi
fi

if ! id vendo >/dev/null 2>&1; then useradd --system --home-dir "$APP_DIR" --shell /usr/sbin/nologin vendo; fi
install -d -m 0755 "$APP_DIR" "$CONFIG_DIR"
install -d -m 0750 -o vendo -g vendo "$DATA_DIR_DEFAULT" /var/backups/debian-vendoos
rsync -a --delete --exclude data --exclude backups --exclude .git --exclude .pio --exclude node_modules "$SOURCE_DIR/" "$APP_DIR/"
chown -R root:root "$APP_DIR"
find "$APP_DIR" -type d -exec chmod 0755 {} +
chmod 0755 "$APP_DIR"/deploy/debian/*.sh
install -m 0644 "$APP_DIR/deploy/debian/vendoos-restore-tmpfiles.conf" /etc/tmpfiles.d/debian-vendoos-restore.conf
systemd-tmpfiles --create /etc/tmpfiles.d/debian-vendoos-restore.conf

# Keep the web service unprivileged while allowing only the two explicit
# dashboard power actions through a root-owned helper.
/usr/sbin/visudo -cf "$APP_DIR/deploy/debian/vendoos-power.sudoers"
install -m 0750 -o root -g vendo "$APP_DIR/deploy/debian/vendoos-power" /usr/local/sbin/vendoos-power
install -d -m 0750 /etc/sudoers.d
install -m 0440 -o root -g root "$APP_DIR/deploy/debian/vendoos-power.sudoers" /etc/sudoers.d/vendoos-power

generated_password=''
if [ ! -f "$CONFIG_DIR/vendo.env" ]; then
  generated_password="$(openssl rand -base64 24 | tr -d '\n')"
  provision_key="$(openssl rand -hex 32)"
  umask 077
  cat > "$CONFIG_DIR/vendo.env" <<EOF
PORT=$PORT
HOST=0.0.0.0
DATA_DIR=$DATA_DIR_DEFAULT
DB_FILE=$DATA_DIR_DEFAULT/vendo.db
BACKUP_DIR=/var/backups/debian-vendoos
CUSTOMER_IF=$CUSTOMER_IF
WAN_IF=$WAN_IF
MANAGEMENT_CIDR=$MANAGEMENT_CIDR
HOTSPOT_MODE=$HOTSPOT_MODE
HOTSPOT_ADDRESS=$HOTSPOT_ADDRESS
HOTSPOT_CIDR=$HOTSPOT_CIDR
HOTSPOT_SUBNET=$HOTSPOT_SUBNET
HOTSPOT_PREFIX=$HOTSPOT_PREFIX
HOTSPOT_NETMASK=$HOTSPOT_NETMASK
DHCP_START=$DHCP_START
DHCP_END=$DHCP_END
DHCP_LEASE=$DHCP_LEASE
SSID=$SSID
WIFI_CHANNEL=$WIFI_CHANNEL
WIFI_COUNTRY=$WIFI_COUNTRY
PORTAL_URL=$PORTAL_URL
ADMIN_PASSWORD=$generated_password
PROVISION_KEY=$provision_key
COIN_LEASE_SECONDS=20
HARDWARE_ONLINE_SECONDS=90
EOF
fi
chmod 0600 "$CONFIG_DIR/vendo.env"
. "$CONFIG_DIR/vendo.env"

# Keep NetworkManager from reclaiming the dedicated customer interface.
if systemctl is-active --quiet NetworkManager.service; then
  install -d -m 0755 /etc/NetworkManager/conf.d
  cat > /etc/NetworkManager/conf.d/90-debian-vendoos-unmanaged.conf <<EOF
[keyfile]
unmanaged-devices=interface-name:$CUSTOMER_IF
EOF
  nmcli device set "$CUSTOMER_IF" managed no 2>/dev/null || true
fi

escape_sed() { printf '%s' "$1" | sed 's/[&|]/\\&/g'; }
render() {
  source_file=$1 destination=$2
  sed \
    -e "s|__CUSTOMER_IF__|$(escape_sed "$CUSTOMER_IF")|g" \
    -e "s|__WAN_IF__|$(escape_sed "$WAN_IF")|g" \
    -e "s|__HOTSPOT_ADDRESS__|$(escape_sed "$HOTSPOT_ADDRESS")|g" \
    -e "s|__HOTSPOT_NETMASK__|$(escape_sed "$HOTSPOT_NETMASK")|g" \
    -e "s|__DHCP_START__|$(escape_sed "$DHCP_START")|g" \
    -e "s|__DHCP_END__|$(escape_sed "$DHCP_END")|g" \
    -e "s|__DHCP_LEASE__|$(escape_sed "$DHCP_LEASE")|g" \
    -e "s|__PORTAL_URL__|$(escape_sed "$PORTAL_URL")|g" \
    -e "s|__SSID__|$(escape_sed "$SSID")|g" \
    -e "s|__WIFI_CHANNEL__|$(escape_sed "$WIFI_CHANNEL")|g" \
    -e "s|__WIFI_COUNTRY__|$(escape_sed "$WIFI_COUNTRY")|g" \
    "$source_file" > "$destination"
}
render "$APP_DIR/deploy/debian/dnsmasq.conf" "$CONFIG_DIR/dnsmasq.conf"
render "$APP_DIR/deploy/debian/hostapd.conf" "$CONFIG_DIR/hostapd.conf"
cp "$APP_DIR/deploy/debian/vendo.nft" "$CONFIG_DIR/vendo.nft"

cat > /etc/sysctl.d/90-debian-vendoos.conf <<EOF
net.ipv4.ip_forward=1
net.ipv4.tcp_mtu_probing=1
net.ipv4.conf.all.rp_filter=2
net.ipv4.conf.default.rp_filter=2
net.netfilter.nf_conntrack_tcp_timeout_established=86400
net.ipv6.conf.$CUSTOMER_IF.disable_ipv6=1
EOF
sysctl --system >/dev/null

for unit in debian-vendoos.service vendo-access-sync.service vendo-vlan-sync.service vendo-multiwan.service vendo-network.service vendo-firewall.service vendo-dnsmasq.service vendo-hostapd.service vendo-backup.service vendo-backup.timer vendo-recovery.service vendo-recovery.timer vendo-restore.service vendo-restore.path; do
  install -m 0644 "$APP_DIR/deploy/debian/$unit" "/etc/systemd/system/$unit"
done
install -m 0644 "$APP_DIR/deploy/debian/vendoos-restore-tmpfiles.conf" /etc/tmpfiles.d/debian-vendoos-restore.conf
systemd-tmpfiles --create /etc/tmpfiles.d/debian-vendoos-restore.conf
systemctl disable --now dnsmasq.service hostapd.service >/dev/null 2>&1 || true
systemctl daemon-reload
systemctl enable vendo-network.service vendo-firewall.service vendo-vlan-sync.service vendo-multiwan.service vendo-dnsmasq.service vendo-hostapd.service debian-vendoos.service vendo-access-sync.service vendo-backup.timer vendo-recovery.timer vendo-restore.path

# Initialize the database before the read-only VLAN synchronizer starts.
systemctl restart vendo-network.service vendo-firewall.service
systemctl restart debian-vendoos.service
systemctl restart vendo-vlan-sync.service
systemctl restart vendo-multiwan.service vendo-dnsmasq.service vendo-hostapd.service vendo-access-sync.service
systemctl start vendo-backup.timer vendo-recovery.timer vendo-restore.path
systemctl reset-failed dnsmasq.service hostapd.service >/dev/null 2>&1 || true

ready=0
for attempt in $(seq 1 20); do
  if curl -fsS "http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
if [ "$ready" -ne 1 ]; then
  echo "Install completed, but health check failed. Run: journalctl -u debian-vendoos -n 100" >&2
  exit 1
fi

echo
echo "Debian VendoOS is running."
echo "Portal: $PORTAL_URL"
echo "Admin:  http://$HOTSPOT_ADDRESS:$PORT/admin"
if [ -n "$generated_password" ]; then echo "Admin password: $generated_password"; else echo "Admin password: preserved in $CONFIG_DIR/vendo.env"; fi
echo "Provisioning key: stored in $CONFIG_DIR/vendo.env"
echo "Health check: sudo $APP_DIR/deploy/debian/health-check.sh"
