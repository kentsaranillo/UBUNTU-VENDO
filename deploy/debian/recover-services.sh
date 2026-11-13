#!/bin/sh
set -u

ENV_FILE=/etc/debian-vendoos/vendo.env
[ -r "$ENV_FILE" ] || { echo "Missing $ENV_FILE" >&2; exit 1; }
. "$ENV_FILE"

failed=0

ensure_started() {
  unit=$1
  if /usr/bin/systemctl is-active --quiet "$unit"; then
    return 0
  fi
  echo "Recovering $unit"
  /usr/bin/systemctl reset-failed "$unit" >/dev/null 2>&1 || true
  if ! /usr/bin/systemctl start "$unit"; then
    echo "Unable to recover $unit" >&2
    failed=1
    return 1
  fi
}

# A oneshot unit can remain marked active even if an external network manager
# later removes the customer address or firewall table. Reapply only when the
# actual runtime state is missing.
if ! /usr/sbin/ip -4 address show dev "$CUSTOMER_IF" 2>/dev/null | /bin/grep -Fq "$HOTSPOT_ADDRESS/"; then
  echo "Customer gateway address is missing; reapplying network configuration"
  /usr/bin/systemctl restart vendo-network.service || failed=1
fi
ensure_started vendo-network.service || true

if ! /usr/sbin/nft list table inet vendo >/dev/null 2>&1; then
  echo "VendoOS firewall table is missing; reloading firewall"
  /usr/bin/systemctl restart vendo-firewall.service || failed=1
fi
ensure_started vendo-firewall.service || true

# Start dependency producers first. This also repairs consumers which systemd
# left inactive after a transient dependency failure during boot.
ensure_started debian-vendoos.service || true
ensure_started vendo-vlan-sync.service || true
ensure_started vendo-dnsmasq.service || true
ensure_started vendo-multiwan.service || true
ensure_started vendo-access-sync.service || true

if [ "${HOTSPOT_MODE:-lan}" = wifi ]; then
  ensure_started vendo-hostapd.service || true
fi

if ! /usr/bin/curl --fail --silent --max-time 5 "http://127.0.0.1:${PORT}/health" >/dev/null 2>&1; then
  echo "Controller health endpoint failed; restarting controller"
  /usr/bin/systemctl restart debian-vendoos.service || failed=1
fi

for unit in vendo-network.service vendo-firewall.service debian-vendoos.service vendo-vlan-sync.service vendo-dnsmasq.service vendo-multiwan.service vendo-access-sync.service; do
  if ! /usr/bin/systemctl is-active --quiet "$unit"; then
    echo "$unit is still inactive" >&2
    failed=1
  fi
done

exit "$failed"
