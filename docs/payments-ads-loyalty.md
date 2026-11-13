# Payments, sponsored campaigns, and loyalty

## PayMongo hosted voucher checkout

VendoOS offers each enabled WiFi rate through PayMongo Hosted Checkout. Customers choose GCash or Maya, pay on PayMongo's page, then return to the portal. The controller does not accept or store wallet credentials. The portal checks order status and automatically redeems the voucher after the signed webhook creates it. The paid webhook is the source of truth; a successful return redirect alone never grants time.

Owner/Admin → System → PayMongo voucher checkout can store the public HTTPS URL and test/live credentials and enable/disable checkout. The API key and signing secret are encrypted with AES-256-GCM in SQLite; the random encryption key is a separate mode-`0600` file in the VendoOS data directory. Secrets are write-only in the UI. Restoring the database without that key file requires entering the two secrets again. Alternatively, the checkout path accepts environment overrides:

```ini
PAYMONGO_SECRET_KEY=sk_test_...
PAYMONGO_WEBHOOK_SECRET=whsk_...
PAYMONGO_RETURN_BASE_URL=https://wifi.example.com
```

For environment configuration, put these values in `/etc/debian-vendoos/vendo.env` on the server, owned by root and mode `0600`; environment values make the Admin form read-only. Never put live secrets in this repository, the portal JavaScript, or a support message. `PAYMONGO_RETURN_BASE_URL` must be the public HTTPS origin/path which routes `/portal` and `/api/webhooks/paymongo` to the controller. A private RFC1918 address such as `172.16.x.x` is not reachable by PayMongo; use a domain with HTTPS and a firewall/reverse proxy route, or a secure tunnel with a stable HTTPS hostname.

In PayMongo Developers → Webhooks, add:

```text
https://wifi.example.com/api/webhooks/paymongo
```

Subscribe to `checkout_session.payment.paid`. The server verifies the raw request body using the mode-specific `Paymongo-Signature` HMAC, enforces a five-minute timestamp window, checks the reference and amount, and processes event IDs idempotently. If fulfillment fails, the endpoint returns an error so PayMongo can retry. The database preserves each order, payment reference, voucher, and webhook event for reconciliation.

**Captive-network requirement:** VendoOS blocks unrestricted internet until the device has time. A customer must be able to reach PayMongo Hosted Checkout and the selected wallet provider while still captive. This build does not create an unrestricted pre-payment internet bypass or automatically open payment-provider destinations in the firewall. Before enabling checkout for WiFi-only devices, configure a narrowly scoped, reviewed walled garden for PayMongo and wallet-provider destinations at the network edge; do not allow all Internet traffic as a payment workaround. Customers using mobile data can complete checkout independently of the captive WiFi path.

### Rollout procedure

1. Start with a PayMongo **test** secret and its matching webhook signing secret.
2. Configure the public HTTPS return URL and webhook endpoint, then restart `debian-vendoos` to load environment changes.
3. Open WiFi Rates on a customer device, complete a test GCash/Maya payment, and confirm a single voucher and sale appear in Admin.
4. Confirm the portal returns and grants the purchased time only after the paid webhook arrives.
5. Replace both test secrets with the matching **live** secrets, preserve HTTPS, and make a low-value live transaction before wider rollout.

The Admin → System → GCash & Maya panel shows whether required settings were loaded and displays order counts. It never displays secrets. Do not enable live payment until webhook delivery and fulfillment have been confirmed.

## Sponsored WiFi campaigns

Admin → System → Sponsored WiFi campaigns creates, edits, pauses, schedules, and deletes offers. Campaigns can target all WiFi zones or one zone. Use a local `/assets/...` URL for an image and an HTTPS destination link. The portal escapes campaign copy, records impressions/clicks, and opens destinations in a separate tab. Keep campaign text short for mobile screens.

## Loyalty

The device identity cookie keeps points with a customer across private MAC changes handled by VendoOS. Coin purchases and redeemed non-PayMongo vouchers earn one point per PHP 10; PayMongo purchases use the WiFi rate's configured point award when present, otherwise the same PHP 10 rule. Each 100 points can be exchanged for 30 minutes at the default 5 Mbps rate (or the gateway's configured global speed). Payment and coin ledger references are unique, so retries cannot award duplicate points. The portal shows the balance and enables the reward button when eligible.

## Backups and offsite copies

The existing daily backup timer creates SQLite online backups, runs `PRAGMA integrity_check`, and retains 30 days locally. Admin → System → Backups supports download, verify, restore, and batch delete. Restore creates a safety backup first and validates the candidate before replacement.

An optional encrypted offsite copy can be enabled in `/etc/debian-vendoos/vendo.env`:

```ini
OFFSITE_BACKUP_SSH_TARGET=backup-user@backup.example.com
OFFSITE_BACKUP_PATH=/srv/vendoos-backups
OFFSITE_BACKUP_SSH_KEY=/etc/debian-vendoos/offsite-backup-key
OFFSITE_BACKUP_ENCRYPTION_KEY_FILE=/etc/debian-vendoos/offsite-backup-passphrase
```

Install the SSH private key and passphrase file as root-readable mode `0600`. Pin the backup server's host key in root's `known_hosts` before enabling strict SSH verification. The daily backup job encrypts its already-verified SQLite copy with OpenSSL AES-256-CBC/PBKDF2 before transfer; VendoOS does not copy the passphrase to the remote server. Keep an independent protected copy of the passphrase. Enabling any one `OFFSITE_BACKUP_*` value requires all four. The remote destination must exist and remote retention must be managed on the backup host.

Decrypt an offsite file on a trusted machine with the matching key file:

```sh
openssl enc -d -aes-256-cbc -pbkdf2 -iter 310000 \
  -pass file:/secure/path/offsite-backup-passphrase \
  -in vendo-YYYYMMDDTHHMMSSZ.db.enc -out vendo-restore.db
```

Then run `sqlite3 -readonly vendo-restore.db 'PRAGMA integrity_check;'` before importing through Admin restore.

## Admin and network security

- Keep Admin on a management VLAN or VPN. Do not expose port 3080 directly to the public Internet.
- Use HTTPS for the public portal when online checkout is enabled; only expose the webhook path through the reverse proxy.
- Give operators least-privilege roles and rotate unique passwords. Restrict `/etc/debian-vendoos/vendo.env` to root.
- Keep PayMongo test/live keys paired with their respective webhook signing secret.
- The capacity card reports active stations, event-loop delay, WAL/database size, active requests, errors, memory, and uptime. Use it with the WAN/VLAN health panels to spot degradation before increasing station density.
