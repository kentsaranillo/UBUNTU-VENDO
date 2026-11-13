#!/bin/sh
set -eu
. /etc/debian-vendoos/vendo.env

if ! /usr/sbin/ip link show "$CUSTOMER_IF" >/dev/null 2>&1; then
  echo "Customer interface $CUSTOMER_IF does not exist" >&2
  exit 1
fi

/usr/sbin/ip link set "$CUSTOMER_IF" up
/usr/sbin/ip -4 route flush dev "$CUSTOMER_IF" proto dhcp
/usr/sbin/ip -4 address flush dev "$CUSTOMER_IF" dynamic
/usr/sbin/ip address replace "$HOTSPOT_CIDR" dev "$CUSTOMER_IF"

if [ "$HOTSPOT_MODE" = "wifi" ]; then
  /usr/sbin/iw dev "$CUSTOMER_IF" set power_save off 2>/dev/null || true
fi
