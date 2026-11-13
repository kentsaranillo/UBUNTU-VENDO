#!/bin/sh
set -eu
. /etc/debian-vendoos/vendo.env
/usr/bin/curl --fail --silent --show-error "http://127.0.0.1:$PORT/health"
/usr/sbin/nft list set inet vendo allowed_macs >/dev/null
for unit in vendo-network.service vendo-firewall.service debian-vendoos.service vendo-vlan-sync.service vendo-dnsmasq.service vendo-multiwan.service vendo-access-sync.service vendo-recovery.timer; do
  /usr/bin/systemctl is-active --quiet "$unit"
done
