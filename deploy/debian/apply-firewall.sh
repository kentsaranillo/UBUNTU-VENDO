#!/bin/sh
set -eu
. /etc/debian-vendoos/vendo.env
MANAGEMENT_CIDR=${MANAGEMENT_CIDR:-127.0.0.1/32}

case "$CUSTOMER_IF$WAN_IF" in *[!A-Za-z0-9_.:-]*) echo "Invalid interface name" >&2; exit 1;; esac
case "$MANAGEMENT_CIDR" in *[!0-9./]*) echo "Invalid MANAGEMENT_CIDR" >&2; exit 1;; esac

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
sed -e "s/__CUSTOMER_IF__/$CUSTOMER_IF/g" -e "s/__WAN_IF__/$WAN_IF/g" -e "s|__MANAGEMENT_CIDR__|$MANAGEMENT_CIDR|g" /etc/debian-vendoos/vendo.nft > "$TMP"

if /usr/sbin/nft list table inet vendo >/dev/null 2>&1; then
  /usr/sbin/nft delete table inet vendo
fi
/usr/sbin/nft -f "$TMP"
