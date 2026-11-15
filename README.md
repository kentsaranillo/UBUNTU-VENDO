# Debian VendoOS

## Install from GitHub

This repository contains the Ubuntu/Debian server source, installer, customer portal themes, Admin dashboard, and ESP firmware sources and BIN files.

On a fresh Ubuntu or Debian server, install Git and download the source:

```sh
sudo apt update
sudo apt install -y git
git clone https://github.com/kentsaranillo/UBUNTU-VENDO.git
cd UBUNTU-VENDO
ip -br link
```

Choose a dedicated customer LAN port and a WAN port from the interface list. Replace the example interface names and management subnet before running:

```sh
sudo CUSTOMER_IF=enp2s0f1 WAN_IF=enp2s0f0 HOTSPOT_MODE=lan \
  MANAGEMENT_CIDR=192.168.1.0/24 bash deploy/debian/install.sh
```

The installer configures system services and networking. Use console access for first installation. Open `http://SERVER-IP:3080/admin` afterward and use the administrator credentials printed by the installer.

Recent features include Lite, Neon and Battle Royale portals, voucher print templates, pause/resume, PayMongo settings, backup and restore, weighted Multi-WAN routing, HTTPS and DNS-over-HTTPS WAN checks, per-WAN diagnostics, and ESP fleet firmware downloads. Payment setup is documented in [payments and loyalty](docs/payments-ads-loyalty.md). Firmware builds and installation-key requirements are in [fleet firmware](firmware/fleet/README.md).

For application source updates, use the validated release installer on the server:

```sh
sudo sh /opt/debian-vendoos/deploy/debian/deploy-release.sh /path/to/release.tar.gz
```

It backs up source and the database, validates syntax, restores executable permissions, checks startup, and restores the previous source release if startup fails. Operating-system service changes require installation of the updated unit files separately.

Version 0.4 adds centralized fleet operations and Debian-managed customer VLANs: live customer control, per-station rates, voucher batches and sellers, sales exports, cash variance, gateway health, backups, staged ESP firmware releases, automatic 802.1Q interfaces, VLAN DHCP scopes and captive firewall membership. It also adds configurable WAN/customer/AP-bridge roles, per-VLAN CAKE shaping, automatic vendo selection by customer zone, and browser-bound recovery when a phone rotates its private MAC. It remains a fully Debian-native gateway and does not require MikroTik RouterOS.

A self-contained WiFi-vendo gateway for Debian. It does **not** require MikroTik, RouterOS, RADIUS, Docker, or a cloud connection.

Debian performs all gateway duties:

- WiFi access point through `hostapd`, or an external access point through a dedicated LAN port
- DHCP, DNS, and captive-portal discovery through `dnsmasq`
- internet NAT and MAC-based access enforcement through `nftables`
- Node.js controller and responsive customer/admin interfaces
- SQLite WAL database, automatic backups, sales, vouchers, rates, and audit events
- multiple ESP vendo stations, exclusive 60-second coin-slot leases, duplicate-safe pulses, and remote commands
- time stacking, pausing/resuming, live countdowns, and automatic connection when a paid coin lease expires

## Network layout

All roles sign in at `/admin` with their own credentials. Seller accounts automatically open `/seller`, Collector accounts open `/collector`, and administrative roles open their permitted dashboard modules. An Owner or Admin creates those accounts under System → Team access. The Staff portal access form links a seller code or assigns collector stations. Reload accounts in that form after creating a new account.

Sellers issue vouchers using enabled Admin rates, print their own stock, and record received payments with Mark sold. Issued voucher face value is separate from recorded sales. Collectors see assigned station balances and record counted cash, variance and notes. Collection receipts belong to the signed-in collector. Submissions use idempotency keys to prevent duplicate financial operations on retries. These roles use dedicated scoped APIs and are redirected from the Admin dashboard.

```text
Internet
   |
[Debian WAN: eth0]
[Debian VendoOS]
[Customer WiFi/LAN: wlan0 or enp2s0] --- phones + ESP vendo stations
```

Use a dedicated customer interface. Never use the same interface for both WAN and customer traffic.

### Multi-WAN load balancing and failover

Open **Network → Multi-WAN**, add each internet interface, confirm its IPv4 gateway, choose a weight, and set a health target. Saving while the enable switch is off stores the configuration without changing live routes. When enabled, VendoOS installs a weighted ECMP default route at metric 20 while retaining the DHCP/static default route as an emergency fallback.

- Weight `2` receives approximately twice as many new connections as weight `1`.
- Load balancing is per connection, so a single download uses one WAN rather than bonding both links.
- A WAN leaves the route after two failed five-second checks and returns automatically after a successful check.
- The firewall and NAT WAN-interface set follows all configured uplinks automatically.
- Do not assign a customer LAN, AP bridge, or VLAN trunk interface as a WAN.

### Mode A: Debian creates the WiFi network

The WiFi adapter must support AP mode (`iw list` should show `AP`).

```sh
sudo CUSTOMER_IF=wlan0 WAN_IF=eth0 HOTSPOT_MODE=wifi \
  SSID=VendoOS-WiFi bash deploy/debian/install.sh
```

### Mode B: external access point

Connect a dedicated Debian Ethernet port to an access point configured in **AP/bridge mode**. Disable DHCP and NAT on that access point.

```sh
sudo CUSTOMER_IF=enp2s0 WAN_IF=eth0 HOTSPOT_MODE=lan \
  bash deploy/debian/install.sh
```

If the WAN interface is also connected to a trusted management LAN, allow only that subnet to reach the dashboard:

```sh
sudo CUSTOMER_IF=enp2s0 WAN_IF=eth0 HOTSPOT_MODE=lan \
  MANAGEMENT_CIDR=172.16.20.0/28 bash deploy/debian/install.sh
```

The installer supports Debian/Ubuntu on amd64, arm64, and armhf. It installs Node.js 22, creates a restricted service account, generates the secrets, configures services, and runs a health check.

## First login

At the end of installation the terminal displays the generated admin password.

- Portal: `http://10.88.0.1:3080/`
- Admin: `http://10.88.0.1:3080/admin`
- Configuration and secrets: `/etc/debian-vendoos/vendo.env`
- Database: `/var/lib/debian-vendoos/vendo.db`
- Backups: `/var/backups/debian-vendoos/`

Do not expose port 3080 on the public WAN. Remote administration should use a VPN such as WireGuard or Tailscale.

## Enroll a vendo station

The ESP calls `POST /api/device/provision` once after a reset using the provisioning key in `/etc/debian-vendoos/vendo.env`. The server returns its unique device token. It then sends a heartbeat every 15 seconds.

Each heartbeat tells the controller whether a customer owns the coin slot. The enable output is active only during that lease. Coin pulses are accepted only for the active customer, and every pulse has a unique ID so retries never double-credit.

See [ESP protocol](docs/esp-protocol.md) for the exact requests.

## Multiple stations on one customer network

All online vendos can share the same customer network. A captive popup cannot physically know which coin slot a person is standing beside, so VendoOS provides two reliable association methods:

1. the customer selects the nearby station by name; or
2. a station-specific QR/NFC link opens `http://10.88.0.1:3080/?machine=ID` and locks the portal to that online station.

This is safer than guessing by signal strength or IP address.

## Operations

```sh
sudo systemctl status debian-vendoos vendo-access-sync vendo-multiwan vendo-dnsmasq vendo-hostapd
sudo journalctl -u debian-vendoos -f
sudo /opt/debian-vendoos/deploy/debian/health-check.sh
sudo systemctl reload vendo-firewall
sudo systemctl start vendo-backup.service
```

### Verify and restore a database backup

Daily and dashboard-created backups are checked with SQLite's integrity check. From **Admin → System → Backups**, admins can download any listed copy, run **Verify** to test a temporary restore copy, or use **Restore** to replace the live database after an explicit confirmation. The UI restore pauses the controller briefly and saves a pre-restore safety copy first. To test a backup from the shell without changing the live database, run:

```sh
sudo /opt/debian-vendoos/deploy/debian/restore.sh --test vendo-YYYYMMDDTHHMMSSZ.db
```

To restore after checking the filename and timestamp, run:

```sh
sudo /opt/debian-vendoos/deploy/debian/restore.sh --apply vendo-YYYYMMDDTHHMMSSZ.db
```

The restore script validates the file and asks the operator to type `RESTORE`. It first saves the current database as `pre-restore-*.db`, pauses the controller and database sync services, then swaps in the backup and restarts them. A restore rolls back the entire database, including sales, vouchers, users, rates, and network settings; it is not a partial restore. The safety copy can be restored by the same command if needed.

Edit `/etc/debian-vendoos/vendo.env`, then restart affected services:

```sh
sudo systemctl restart vendo-network vendo-dnsmasq vendo-hostapd vendo-firewall debian-vendoos vendo-access-sync
```

The firewall installer owns only `table inet vendo`; it does not flush unrelated nftables rules.

## Captive portal behavior

DHCP option 114 advertises the RFC 8910 captive API. Android, iOS, Windows, and many Linux clients also use their platform connectivity-check endpoints, which VendoOS answers locally. Before authorization, HTTP is redirected to the local portal. HTTPS is not intercepted because doing so would cause certificate errors.

After coin or voucher credit, the entitlement synchronizer puts the device MAC in a timed nftables set. Internet forwarding then starts without adding a RouterOS user or profile.

## Development

Requires Node.js 22.5 or newer because the controller uses the built-in `node:sqlite` module.

```powershell
$env:ADMIN_PASSWORD='Development-password-123!'
$env:PROVISION_KEY='development-provision-key-123456'
$env:ALLOW_TEST_MAC='1'
npm.cmd test
npm.cmd run check
node server.js
```

The automated end-to-end test uses a temporary database and covers provisioning, heartbeat, coin leasing, duplicate pulses, time credit, pause/resume, vouchers, remote commands, admin authorization, and the portal assets.

## Current production boundary

This first release is a solid single-gateway system. One gateway can run many ESP stations and customer devices on its hotspot zone. For multi-site roaming or tens of thousands of concurrent clients, add a central PostgreSQL/control plane and site gateways; do not stretch one Layer-2 customer network between sites.
# Payments, sponsored ads, loyalty and offsite recovery

See [payments, ads, loyalty, and backup setup](docs/payments-ads-loyalty.md) for PayMongo Hosted Checkout configuration, public HTTPS/webhook requirements, campaign management, reward points, and optional encrypted offsite backups.
