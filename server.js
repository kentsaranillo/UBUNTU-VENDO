'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const zlib = require('node:zlib');
const { execFileSync, spawn } = require('node:child_process');
const { monitorEventLoopDelay } = require('node:perf_hooks');
const { DatabaseSync } = require('node:sqlite');

const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(ROOT, 'data'));
const DB_FILE = path.resolve(process.env.DB_FILE || path.join(DATA_DIR, 'vendo.db'));
const BACKUP_DIR = path.resolve(process.env.BACKUP_DIR || path.join(ROOT, 'backups'));
const RESTORE_REQUEST_DIR = '/run/debian-vendoos/restore-requests';
const RESTORE_STATUS_DIR = '/run/debian-vendoos/restore-status';
const PORTAL_UPLOAD_DIR = path.join(DATA_DIR, 'portal-assets');
const PORT = int(process.env.PORT, 3080, 1, 65535);
const HOST = process.env.HOST || '0.0.0.0';
const CUSTOMER_IF = process.env.CUSTOMER_IF || 'wlan0';
const HOTSPOT_ADDRESS = process.env.HOTSPOT_ADDRESS || '10.88.0.1';
const HOTSPOT_SUBNET = process.env.HOTSPOT_SUBNET || '10.88.0.0/24';
const HOTSPOT_NETMASK = process.env.HOTSPOT_NETMASK || '255.255.255.0';
const DHCP_START = process.env.DHCP_START || '10.88.0.20';
const DHCP_END = process.env.DHCP_END || '10.88.0.250';
const PORTAL_URL = process.env.PORTAL_URL || `http://10.88.0.1:${PORT}/`;
const ADMIN_USERNAME = cleanText(process.env.ADMIN_USERNAME || 'admin', 64).toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const PROVISION_KEY = process.env.PROVISION_KEY || '';
const COIN_LEASE_SECONDS = int(process.env.COIN_LEASE_SECONDS, 20, 5, 300);
const HARDWARE_ONLINE_SECONDS = int(process.env.HARDWARE_ONLINE_SECONDS, 90, 15, 900);
const ALLOW_TEST_MAC = process.env.ALLOW_TEST_MAC === '1';
const DB_CACHE_KIB = int(process.env.DB_CACHE_KIB, 32768, 4096, 262144);
const DB_MMAP_BYTES = int(process.env.DB_MMAP_BYTES, 134217728, 0, 1073741824);
const DEVICE_HEARTBEAT_IDLE_MS = int(process.env.DEVICE_HEARTBEAT_IDLE_MS, 3000, 1000, 60000);
const DEVICE_HEARTBEAT_ACTIVE_MS = int(process.env.DEVICE_HEARTBEAT_ACTIVE_MS, 1500, 500, 30000);
const DEVICE_HEARTBEAT_JITTER_MS = int(process.env.DEVICE_HEARTBEAT_JITTER_MS, 2000, 0, 10000);
const DEVICE_HEARTBEAT_PERSIST_MS = int(process.env.DEVICE_HEARTBEAT_PERSIST_MS, 5000, 1000, 60000);
const PAYMENT_KEY_FILE = path.join(DATA_DIR, 'paymongo.key');

if (ADMIN_PASSWORD.length < 12) throw new Error('ADMIN_PASSWORD must contain at least 12 characters');
if (PROVISION_KEY.length < 16) throw new Error('PROVISION_KEY must contain at least 16 characters');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });
fs.mkdirSync(PORTAL_UPLOAD_DIR, { recursive: true });
const db = new DatabaseSync(DB_FILE);
db.exec(`PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
PRAGMA busy_timeout=10000;
PRAGMA synchronous=NORMAL;
PRAGMA cache_size=-${DB_CACHE_KIB};
PRAGMA temp_store=MEMORY;
PRAGMA mmap_size=${DB_MMAP_BYTES};
PRAGMA wal_autocheckpoint=1000;
PRAGMA journal_size_limit=67108864;`);
const rawPrepare = db.prepare.bind(db);
const statementCache = new Map();
db.prepare = source => {
  const sql = String(source); let statement = statementCache.get(sql);
  if (statement) return statement;
  statement = rawPrepare(sql); statementCache.set(sql, statement);
  if (statementCache.size > 512) statementCache.delete(statementCache.keys().next().value);
  return statement;
};

db.exec(`
CREATE TABLE IF NOT EXISTS zones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  subnet TEXT NOT NULL,
  gateway TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS machines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hardware_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  zone_id INTEGER NOT NULL REFERENCES zones(id),
  token_hash TEXT NOT NULL,
  coin_pin INTEGER NOT NULL DEFAULT 2,
  enable_pin INTEGER NOT NULL DEFAULT 15,
  config_version INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_seen_at TEXT,
  ip_address TEXT,
  firmware_version TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS rates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id INTEGER REFERENCES zones(id),
  name TEXT NOT NULL,
  price_centavos INTEGER NOT NULL CHECK(price_centavos > 0),
  duration_seconds INTEGER NOT NULL CHECK(duration_seconds > 0),
  rate_limit TEXT NOT NULL DEFAULT '5M/5M',
  pausable INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS coin_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  public_token_hash TEXT NOT NULL,
  machine_id INTEGER NOT NULL REFERENCES machines(id),
  zone_id INTEGER NOT NULL REFERENCES zones(id),
  client_mac TEXT NOT NULL,
  amount_centavos INTEGER NOT NULL DEFAULT 0,
  credited_seconds INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','completed','cancelled','expired')),
  lease_expires_at TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS one_open_coin_session_per_machine
ON coin_sessions(machine_id) WHERE status='open';
CREATE TABLE IF NOT EXISTS coin_pulses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id INTEGER NOT NULL REFERENCES machines(id),
  session_id INTEGER NOT NULL REFERENCES coin_sessions(id),
  pulse_id TEXT NOT NULL,
  value_centavos INTEGER NOT NULL CHECK(value_centavos > 0),
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(machine_id, pulse_id)
);
CREATE TABLE IF NOT EXISTS access_entitlements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  zone_id INTEGER NOT NULL REFERENCES zones(id),
  client_mac TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','expired','blocked')),
  expires_at TEXT,
  remaining_seconds INTEGER NOT NULL DEFAULT 0,
  rate_limit TEXT NOT NULL DEFAULT '5M/5M',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(zone_id, client_mac)
);
CREATE TABLE IF NOT EXISTS sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id INTEGER REFERENCES machines(id),
  zone_id INTEGER NOT NULL REFERENCES zones(id),
  client_mac TEXT NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('coin','voucher','manual')),
  amount_centavos INTEGER NOT NULL DEFAULT 0,
  credited_seconds INTEGER NOT NULL,
  session_id INTEGER UNIQUE REFERENCES coin_sessions(id),
  reference TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS vouchers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code_hash TEXT NOT NULL UNIQUE,
  code_hint TEXT NOT NULL,
  batch_code TEXT NOT NULL,
  seller_code TEXT,
  zone_id INTEGER REFERENCES zones(id),
  duration_seconds INTEGER NOT NULL,
  rate_limit TEXT NOT NULL DEFAULT '5M/5M',
  status TEXT NOT NULL DEFAULT 'unused' CHECK(status IN ('unused','used','disabled')),
  expires_at TEXT,
  used_by_mac TEXT,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS vouchers_batch ON vouchers(batch_code, status);
CREATE INDEX IF NOT EXISTS sales_created ON sales(created_at);
CREATE INDEX IF NOT EXISTS access_status ON access_entitlements(status, expires_at);
CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin',
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS admin_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER REFERENCES admin_users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS hardware_commands (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  command TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','acked','failed')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  delivered_at TEXT,
  acked_at TEXT
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  level TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  details_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

function ensureColumn(table, column, definition) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!columns.some(item => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
ensureColumn('machines', 'location', "TEXT NOT NULL DEFAULT ''");
ensureColumn('machines', 'board', "TEXT NOT NULL DEFAULT 'ESP8266'");
ensureColumn('machines', 'device_type', "TEXT NOT NULL DEFAULT 'coin'");
ensureColumn('machines', 'latitude', 'REAL');
ensureColumn('machines', 'longitude', 'REAL');
ensureColumn('machines', 'cash_on_hand_centavos', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('machines', 'lifetime_coin_centavos', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('machines', 'last_coin_at', 'TEXT');
ensureColumn('machines', 'last_status_json', "TEXT NOT NULL DEFAULT '{}'");
ensureColumn('rates', 'expiry_seconds', 'INTEGER NOT NULL DEFAULT 86400');
ensureColumn('rates', 'pause_limit', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('rates', 'points', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('rates', 'is_default', 'INTEGER NOT NULL DEFAULT 1');
ensureColumn('admin_sessions', 'user_id', 'INTEGER REFERENCES admin_users(id) ON DELETE CASCADE');
ensureColumn('coin_sessions', 'client_ip', 'TEXT');
ensureColumn('access_entitlements', 'ip_address', 'TEXT');
ensureColumn('access_entitlements', 'first_seen_at', 'TEXT');
ensureColumn('access_entitlements', 'last_seen_at', 'TEXT');
ensureColumn('access_entitlements', 'bytes_in', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('access_entitlements', 'bytes_out', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('access_entitlements', 'last_machine_id', 'INTEGER');
ensureColumn('access_entitlements', 'auto_reconnect', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('vouchers', 'code_value', 'TEXT');
ensureColumn('vouchers', 'price_centavos', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('sales', 'payment_provider', "TEXT NOT NULL DEFAULT ''");
ensureColumn('zones', 'vlan_id', 'INTEGER');
ensureColumn('zones', 'parent_if', "TEXT NOT NULL DEFAULT ''");
ensureColumn('zones', 'dhcp_start', "TEXT NOT NULL DEFAULT ''");
ensureColumn('zones', 'dhcp_end', "TEXT NOT NULL DEFAULT ''");
ensureColumn('zones', 'netmask', "TEXT NOT NULL DEFAULT '255.255.255.0'");
ensureColumn('zones', 'managed', 'INTEGER NOT NULL DEFAULT 0');
ensureColumn('zones', 'updated_at', "TEXT NOT NULL DEFAULT ''");
ensureColumn('zones', 'default_machine_id', 'INTEGER');
ensureColumn('zones', 'description', "TEXT NOT NULL DEFAULT ''");
db.prepare(`UPDATE zones SET updated_at=? WHERE updated_at=''`).run(nowIso());

db.exec(`
CREATE TABLE IF NOT EXISTS sellers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  contact TEXT,
  location TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS machine_rates (
  machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
  rate_id INTEGER NOT NULL REFERENCES rates(id) ON DELETE CASCADE,
  PRIMARY KEY(machine_id, rate_id)
);
CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  machine_id INTEGER NOT NULL REFERENCES machines(id),
  system_amount_centavos INTEGER NOT NULL,
  actual_amount_centavos INTEGER NOT NULL,
  variance_centavos INTEGER NOT NULL,
  collector TEXT,
  notes TEXT,
  period_started_at TEXT,
  collected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS firmware_releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL,
  board TEXT NOT NULL,
  file_name TEXT NOT NULL,
  file_path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(version, board)
);
CREATE TABLE IF NOT EXISTS firmware_rollouts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  release_id INTEGER NOT NULL REFERENCES firmware_releases(id),
  strategy TEXT NOT NULL DEFAULT 'canary',
  status TEXT NOT NULL DEFAULT 'canary',
  target_machine_ids_json TEXT NOT NULL DEFAULT '[]',
  canary_machine_ids_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  promoted_at TEXT,
  completed_at TEXT,
  error TEXT
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS checkout_orders (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL,
  zone_id INTEGER NOT NULL REFERENCES zones(id),
  client_mac TEXT NOT NULL,
  identity_id INTEGER REFERENCES device_identities(id),
  rate_id INTEGER REFERENCES rates(id),
  rate_name TEXT NOT NULL,
  amount_centavos INTEGER NOT NULL,
  duration_seconds INTEGER NOT NULL,
  rate_limit TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'creating' CHECK(status IN ('creating','pending','paid','fulfilled','cancelled','failed','expired')),
  checkout_session_id TEXT UNIQUE,
  payment_id TEXT,
  voucher_id INTEGER REFERENCES vouchers(id),
  voucher_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS payment_gateway_config (
  id INTEGER PRIMARY KEY CHECK(id=1),
  secret_key_cipher TEXT NOT NULL,
  webhook_secret_cipher TEXT NOT NULL,
  return_base_url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS checkout_orders_customer_status ON checkout_orders(zone_id,client_mac,status,created_at);
CREATE INDEX IF NOT EXISTS checkout_orders_created ON checkout_orders(created_at,status);
CREATE TABLE IF NOT EXISTS ad_campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  headline TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  image_url TEXT NOT NULL DEFAULT '',
  target_url TEXT NOT NULL DEFAULT '',
  sponsor TEXT NOT NULL DEFAULT '',
  zone_id INTEGER REFERENCES zones(id),
  starts_at TEXT,
  ends_at TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  impressions INTEGER NOT NULL DEFAULT 0,
  clicks INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ad_campaign_active ON ad_campaigns(enabled,starts_at,ends_at,zone_id);
CREATE TABLE IF NOT EXISTS loyalty_ledger (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identity_id INTEGER NOT NULL REFERENCES device_identities(id) ON DELETE CASCADE,
  points INTEGER NOT NULL,
  reason TEXT NOT NULL,
  reference TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS loyalty_identity_created ON loyalty_ledger(identity_id,created_at);
CREATE TABLE IF NOT EXISTS device_identities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash TEXT NOT NULL UNIQUE,
  zone_id INTEGER NOT NULL REFERENCES zones(id),
  last_mac TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS device_mac_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identity_id INTEGER NOT NULL REFERENCES device_identities(id) ON DELETE CASCADE,
  zone_id INTEGER NOT NULL REFERENCES zones(id),
  mac TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(identity_id, zone_id, mac)
);
CREATE INDEX IF NOT EXISTS device_mac_history_identity ON device_mac_history(identity_id,last_seen_at);
CREATE INDEX IF NOT EXISTS collections_machine ON collections(machine_id, collected_at);
CREATE INDEX IF NOT EXISTS vouchers_seller ON vouchers(seller_code, status);
`);
ensureColumn('firmware_releases', 'signature', "TEXT NOT NULL DEFAULT ''");
ensureColumn('payment_gateway_config','enabled','INTEGER NOT NULL DEFAULT 0');
ensureColumn('access_entitlements', 'identity_id', 'INTEGER');
db.exec(`
CREATE INDEX IF NOT EXISTS zones_vlan_lookup ON zones(enabled,managed,vlan_id);
CREATE INDEX IF NOT EXISTS machines_zone_enabled ON machines(zone_id,enabled,last_seen_at);
CREATE INDEX IF NOT EXISTS rates_zone_lookup ON rates(zone_id,enabled,is_default,sort_order,price_centavos);
CREATE INDEX IF NOT EXISTS coin_sessions_status_expiry ON coin_sessions(status,lease_expires_at);
CREATE INDEX IF NOT EXISTS coin_pulses_session ON coin_pulses(session_id,id);
CREATE INDEX IF NOT EXISTS access_identity_updated ON access_entitlements(identity_id,updated_at);
CREATE INDEX IF NOT EXISTS hardware_commands_machine_status ON hardware_commands(machine_id,status,id);
CREATE INDEX IF NOT EXISTS firmware_rollouts_status ON firmware_rollouts(status,release_id,id);
CREATE INDEX IF NOT EXISTS admin_sessions_expiry ON admin_sessions(expires_at);
CREATE INDEX IF NOT EXISTS sales_machine_created ON sales(machine_id,created_at);
CREATE INDEX IF NOT EXISTS vouchers_status_expiry ON vouchers(status,expires_at);
`);
db.exec('PRAGMA optimize=0x10002;');
setInterval(() => { try { db.exec('PRAGMA optimize'); } catch {} }, 6 * 60 * 60 * 1000).unref();
db.prepare(`UPDATE access_entitlements SET identity_id=(SELECT d.id FROM device_identities d WHERE d.zone_id=access_entitlements.zone_id AND d.last_mac=access_entitlements.client_mac ORDER BY d.updated_at DESC LIMIT 1) WHERE identity_id IS NULL`).run();
db.prepare(`INSERT OR IGNORE INTO device_mac_history(identity_id,zone_id,mac,first_seen_at,last_seen_at) SELECT id,zone_id,last_mac,created_at,updated_at FROM device_identities`).run();
const seedSetting = db.prepare(`INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO NOTHING`);
seedSetting.run('brand_name', 'VendoOS WiFi');
seedSetting.run('currency', 'PHP');
seedSetting.run('timezone', 'Asia/Manila');
seedSetting.run('support_text', 'Ask the operator for assistance.');
seedSetting.run('portal_tagline', 'CONNECT · STREAM · PLAY');
seedSetting.run('portal_headline', 'Fast WiFi. Fair rates.');
seedSetting.run('portal_announcement', 'Reliable internet, ready when you are.');
seedSetting.run('portal_theme', 'battle-royale');
seedSetting.run('portal_primary_color', '#ffa847');
seedSetting.run('portal_accent_color', '#70d5ff');
seedSetting.run('portal_logo_url', '');
seedSetting.run('portal_banner_url', '');
seedSetting.run('portal_insert_sound_url', '');
seedSetting.run('portal_coin_sound_url', '');
seedSetting.run('auto_pause_reconnect_enabled', '1');
db.prepare("UPDATE settings SET value='battle-royale',updated_at=? WHERE key='portal_theme' AND value NOT IN ('battle-royale','neon','ad-showcase','lite')").run(nowIso());
seedSetting.run('network_wan_if', process.env.WAN_IF || '');
seedSetting.run('multi_wan_enabled', '0');
seedSetting.run('multi_wan_config', '[]');
seedSetting.run('network_customer_if', CUSTOMER_IF);
seedSetting.run('network_mode', 'lan');
seedSetting.run('network_bridge_if', '');
seedSetting.run('cake_enabled', '0');
seedSetting.run('cake_download_mbps', '100');
seedSetting.run('cake_upload_mbps', '50');
seedSetting.run('cake_profile', 'diffserv4');
seedSetting.run('cake_rtt_ms', '100');
seedSetting.run('cake_overhead_bytes', '0');
seedSetting.run('cake_nat', '1');
seedSetting.run('cake_ack_filter', '1');
seedSetting.run('sqm_algorithm', 'cake');
seedSetting.run('sqm_preset', 'balanced');
seedSetting.run('fq_codel_target_ms', '5');
seedSetting.run('fq_codel_interval_ms', '100');
seedSetting.run('fq_codel_ecn', '1');
seedSetting.run('global_user_speed_enabled', '0');
seedSetting.run('global_user_download_mbps', '5');
seedSetting.run('global_user_upload_mbps', '5');

const defaultZone = db.prepare(`INSERT INTO zones(code,name,subnet,gateway,dhcp_start,dhcp_end,netmask)
  VALUES('zone-main','Main Hotspot',?,?,?,?,?)
  ON CONFLICT(code) DO UPDATE SET name=excluded.name RETURNING id`)
  .get(HOTSPOT_SUBNET, HOTSPOT_ADDRESS, DHCP_START, DHCP_END, HOTSPOT_NETMASK);
const zoneId = Number(defaultZone.id);
if (!db.prepare('SELECT 1 FROM rates LIMIT 1').get()) {
  const seed = db.prepare(`INSERT INTO rates(zone_id,name,price_centavos,duration_seconds,rate_limit,sort_order)
    VALUES(?,?,?,?,?,?)`);
  seed.run(zoneId, 'PHP 1 / 10 min', 100, 600, '5M/5M', 1);
  seed.run(zoneId, 'PHP 5 / 2 hours', 500, 7200, '5M/5M', 2);
  seed.run(zoneId, 'PHP 10 / 5 hours', 1000, 18000, '8M/8M', 3);
  seed.run(zoneId, 'PHP 20 / 12 hours', 2000, 43200, '10M/10M', 4);
}

function int(value, fallback, min = Number.MIN_SAFE_INTEGER, max = Number.MAX_SAFE_INTEGER) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}
function nowIso() { return new Date().toISOString(); }
function futureIso(seconds) { return new Date(Date.now() + seconds * 1000).toISOString(); }
function sha(value) {
  const input = Buffer.isBuffer(value) ? value : String(value);
  return crypto.createHash('sha256').update(input).digest('hex');
}
function otaSignature(digest) { return crypto.createHmac('sha256', PROVISION_KEY).update(String(digest)).digest('hex'); }
function randomToken(bytes = 32) { return crypto.randomBytes(bytes).toString('base64url'); }
function samePlain(a, b) {
  const aa = Buffer.from(sha(a)); const bb = Buffer.from(sha(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function passwordDigest(password, salt) {
  return crypto.scryptSync(String(password), String(salt), 64).toString('hex');
}
function passwordRecord(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, hash: passwordDigest(password, salt) };
}
function verifyPassword(password, row) {
  if (!row?.password_hash || !row?.password_salt) return false;
  const supplied = Buffer.from(passwordDigest(password, row.password_salt), 'hex');
  const stored = Buffer.from(row.password_hash, 'hex');
  return supplied.length === stored.length && crypto.timingSafeEqual(supplied, stored);
}
function matchesHash(secret, storedHash) {
  const aa = Buffer.from(sha(secret)); const bb = Buffer.from(String(storedHash || ''));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}
function cleanText(value, max = 100) { return String(value || '').trim().slice(0, max); }
function machinePinError(board, coinPin, enablePin) {
  if (coinPin === enablePin) return 'Coin pulse and coin enable must use different GPIO pins';
  const type = String(board || '').toUpperCase();
  if (type.includes('ESP8266')) {
    const coinPins = new Set([0, 2, 4, 5, 12, 13, 14]);
    const enablePins = new Set([0, 2, 4, 5, 12, 13, 14, 15, 16]);
    if (!coinPins.has(coinPin)) return 'ESP8266 coin pulse GPIO must be one of 0, 2, 4, 5, 12, 13 or 14';
    if (!enablePins.has(enablePin)) return 'ESP8266 coin enable GPIO must be one of 0, 2, 4, 5, 12, 13, 14, 15 or 16';
  } else if (type.includes('ESP32')) {
    const coinPins = new Set([4, 5, 13, 14, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33, 34, 35, 36, 39]);
    const enablePins = new Set([4, 5, 13, 14, 16, 17, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33]);
    if (!coinPins.has(coinPin)) return 'Select a supported ESP32 coin pulse GPIO';
    if (!enablePins.has(enablePin)) return 'Select an output-capable ESP32 coin enable GPIO';
  } else if (coinPin < 0 || coinPin > 39 || enablePin < 0 || enablePin > 39) return 'GPIO pins must be between 0 and 39';
  return '';
}
if (!/^[a-z0-9._-]{3,64}$/.test(ADMIN_USERNAME)) throw new Error('ADMIN_USERNAME is invalid');
if (!db.prepare('SELECT 1 FROM admin_users LIMIT 1').get()) {
  const credentials = passwordRecord(ADMIN_PASSWORD);
  db.prepare('INSERT INTO admin_users(username,password_hash,password_salt,role) VALUES(?,?,?,?)')
    .run(ADMIN_USERNAME, credentials.hash, credentials.salt, 'admin');
}
function normalizeMac(value) {
  const mac = String(value || '').trim().toUpperCase().replace(/-/g, ':');
  return /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(mac) ? mac : '';
}
function ipNumber(value) {
  const parts = String(value || '').split('.').map(Number);
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function interfaceSyncStatus() {
  try { return JSON.parse(fs.readFileSync('/run/debian-vendoos/interface-sync-status.json', 'utf8')); }
  catch { return { state: 'idle', managed_count: 0, updated_at: null }; }
}

function interfaceRoles(snapshot, settings) {
  const roles = Object.fromEntries(snapshot.interfaces.map(item => [item.ifname, []]));
  const add = (name, role) => { if (name && roles[name] && !roles[name].includes(role)) roles[name].push(role); };
  add(settings.network_wan_if, 'Primary WAN');
  add(settings.network_customer_if, 'Customer network');
  add(settings.network_bridge_if, 'AP bridge');
  add('lo', 'Loopback');
  let wans=[]; try { wans=JSON.parse(settings.multi_wan_config||'[]'); } catch {}
  wans.filter(item=>item&&item.enabled!==false).forEach((item,index)=>add(item.interface, `ISP ${index+1}`));
  let policies=[]; try { policies=JSON.parse(settings.pbr_policies||'[]'); } catch {}
  policies.filter(item=>item&&item.enabled!==false).forEach(item=>add(item.interface, 'PBR target'));
  try {
    for (const zone of db.prepare('SELECT parent_if,vlan_id FROM zones WHERE managed=1 AND enabled=1').all()) {
      add(zone.parent_if, 'VLAN trunk');
      add(`${zone.parent_if}.${zone.vlan_id}`.slice(0,15), `Customer VLAN ${zone.vlan_id}`);
    }
  } catch {}
  for (const item of snapshot.interfaces) {
    if (item.linkinfo?.info_kind === 'vlan' && !roles[item.ifname].some(role=>role.startsWith('Customer VLAN'))) add(item.ifname, 'VLAN');
    if (settings[`network_interface_config:${item.ifname}`]) add(item.ifname, 'Managed IP');
  }
  return roles;
}

function interfaceConfigurations(settings) {
  const values = {};
  for (const [key, value] of Object.entries(settings)) {
    if (!key.startsWith('network_interface_config:')) continue;
    try {
      const name = key.slice('network_interface_config:'.length), config = JSON.parse(value);
      if (config && typeof config === 'object') values[name] = { ...config, pppoe_password_set: Boolean(settings[`network_interface_secret:${name}`]) };
    } catch {}
  }
  return values;
}
function validInterfaceCidr(value) {
  const [ip, prefix] = String(value || '').split('/');
  return ipNumber(ip) !== null && Number.isInteger(Number(prefix)) && Number(prefix) >= 1 && Number(prefix) <= 32;
}
function interfaceCidrContains(cidr, ip) {
  if (!validInterfaceCidr(cidr) || ipNumber(ip) === null) return false;
  const [network, prefixText] = cidr.split('/'); const prefix = Number(prefixText);
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipNumber(network) & mask) === (ipNumber(ip) & mask);
}

function validCidr(value) { const [ip, prefix] = String(value || '').split('/'); return ipNumber(ip) !== null && Number.isInteger(Number(prefix)) && Number(prefix) >= 8 && Number(prefix) <= 30; }
function prefixNetmask(prefix) { const mask = (0xffffffff << (32 - Number(prefix))) >>> 0; return [24,16,8,0].map(shift => (mask >>> shift) & 255).join('.'); }
function automaticVlanAddressing(vlanId) {
  const id = Number(vlanId);
  const prefix = id <= 254 ? `10.${id}.0` : `10.${Math.floor((id - 255) / 254) + 1}.${((id - 255) % 254) + 1}`;
  return { subnet: `${prefix}.0/24`, gateway: `${prefix}.1`, dhcpStart: `${prefix}.20`, dhcpEnd: `${prefix}.250` };
}
function cidrContains(cidr, ip) {
  if (!validCidr(cidr) || ipNumber(ip) === null) return false;
  const [network, prefixText] = cidr.split('/'); const prefix = Number(prefixText); const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (ipNumber(network) & mask) === (ipNumber(ip) & mask);
}
function customerZoneForIp(ip) {
  if (ipNumber(ip) === null) return null;
  return db.prepare('SELECT * FROM zones WHERE enabled=1 ORDER BY managed DESC,id').all().find(zone => cidrContains(zone.subnet, ip)) || null;
}
function requestZone(req) { return customerZoneForIp(clientIp(req)) || db.prepare('SELECT * FROM zones WHERE id=?').get(zoneId); }
function cookieValue(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('='); if (index < 0) continue;
    if (part.slice(0, index).trim() === name) { try { return decodeURIComponent(part.slice(index + 1).trim()); } catch { return ''; } }
  }
  return '';
}
function suppliedDeviceKey(req) { return cleanText(req.headers['x-vendo-device-key'] || cookieValue(req, 'vendo_device_key'), 128); }
function rememberDeviceMac(identityId, zoneId, mac) {
  const now = nowIso();
  db.prepare(`INSERT INTO device_mac_history(identity_id,zone_id,mac,first_seen_at,last_seen_at) VALUES(?,?,?,?,?) ON CONFLICT(identity_id,zone_id,mac) DO UPDATE SET last_seen_at=excluded.last_seen_at`).run(identityId, zoneId, mac, now, now);
}
function identifyDevice(req, zone, mac) {
  const supplied = suppliedDeviceKey(req); const row = supplied ? db.prepare('SELECT * FROM device_identities WHERE token_hash=?').get(sha(supplied)) : null;
  if (row) {
    if (row.last_mac !== mac) {
      const prior = db.prepare('SELECT * FROM access_entitlements WHERE identity_id=? ORDER BY updated_at DESC LIMIT 1').get(row.id) || db.prepare('SELECT * FROM access_entitlements WHERE zone_id=? AND client_mac=?').get(row.zone_id, row.last_mac);
      if (prior) {
        const target = db.prepare('SELECT * FROM access_entitlements WHERE zone_id=? AND client_mac=?').get(zone.id, mac);
        const targetRemaining = target?.status === 'active' && target.expires_at ? Math.max(0, Math.ceil((Date.parse(target.expires_at) - Date.now()) / 1000)) : Number(target?.remaining_seconds || 0);
        if (target && target.id !== prior.id && target.identity_id && Number(target.identity_id) !== Number(row.id) && targetRemaining > 0 && ['active','paused'].includes(target.status)) {
          rememberDeviceMac(row.id, row.zone_id, row.last_mac);
          return { key: supplied, identity_id: row.id, restored: false, conflict: true, previous_mac: row.last_mac };
        }
        db.exec('BEGIN IMMEDIATE');
        try { if (target && target.id !== prior.id) db.prepare('DELETE FROM access_entitlements WHERE id=?').run(target.id); db.prepare('UPDATE access_entitlements SET identity_id=?,zone_id=?,client_mac=?,ip_address=?,last_seen_at=?,updated_at=? WHERE id=?').run(row.id, zone.id, mac, clientIp(req), nowIso(), nowIso(), prior.id); db.exec('COMMIT'); }
        catch (error) { db.exec('ROLLBACK'); throw error; }
        event('info','device.mac_migrated',`Private MAC changed from ${row.last_mac} to ${mac}`,{identity_id:row.id,from:row.last_mac,to:mac});
      } else {
        db.prepare('UPDATE access_entitlements SET identity_id=? WHERE zone_id=? AND client_mac=? AND identity_id IS NULL').run(row.id, zone.id, mac);
      }
      rememberDeviceMac(row.id, row.zone_id, row.last_mac);
      rememberDeviceMac(row.id, zone.id, mac);
      db.prepare('UPDATE device_identities SET zone_id=?,last_mac=?,updated_at=? WHERE id=?').run(zone.id,mac,nowIso(),row.id);
    } else rememberDeviceMac(row.id, zone.id, mac);
    db.prepare('UPDATE access_entitlements SET identity_id=? WHERE zone_id=? AND client_mac=? AND identity_id IS NULL').run(row.id, zone.id, mac);
    return { key: supplied, identity_id: row.id, restored: row.last_mac !== mac, conflict: false, previous_mac: row.last_mac !== mac ? row.last_mac : null };
  }
  const key=randomToken(); const result=db.prepare('INSERT INTO device_identities(token_hash,zone_id,last_mac) VALUES(?,?,?)').run(sha(key),zone.id,mac),identityId=Number(result.lastInsertRowid);
  rememberDeviceMac(identityId, zone.id, mac);
  db.prepare('UPDATE access_entitlements SET identity_id=? WHERE zone_id=? AND client_mac=? AND identity_id IS NULL').run(identityId, zone.id, mac);
  return { key,identity_id:identityId,restored:false,conflict:false,previous_mac:null };
}
function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
  res.end(body);
}
function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => {
      data += chunk;
      if (data.length > limit) { reject(Object.assign(new Error('Request too large'), { status: 413 })); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); } catch { reject(Object.assign(new Error('Invalid JSON'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}
function readRawBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > limit) { reject(Object.assign(new Error('Upload is too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function textResponse(res, status, body, type = 'text/plain; charset=utf-8', headers = {}) {
  const data = Buffer.from(String(body));
  res.writeHead(status, { 'content-type': type, 'content-length': data.length, 'cache-control': 'no-store', ...headers });
  res.end(data);
}
function csvCell(value) { const raw = String(value ?? ''); return /[",\r\n]/.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw; }
function csvResponse(res, fileName, headers, rows) {
  const body = [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
  return textResponse(res, 200, body, 'text/csv; charset=utf-8', { 'content-disposition': `attachment; filename="${fileName}"` });
}
function dateFilter(value) { const text = cleanText(value, 30); return /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2})?)?$/.test(text) ? text.replace('T', ' ') : ''; }
function readDhcpLeases() {
  const candidates = ['/var/lib/misc/dnsmasq.leases', '/var/lib/dnsmasq/dnsmasq.leases'];
  const file = candidates.find(candidate => fs.existsSync(candidate));
  if (!file) return [];
  try {
    return fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(line => {
      const [expires, mac, ip, hostname, client_id] = line.trim().split(/\s+/);
      return { expires_at: Number(expires) ? new Date(Number(expires) * 1000).toISOString() : null, mac: normalizeMac(mac), ip, hostname: hostname === '*' ? '' : hostname, client_id: client_id === '*' ? '' : client_id };
    });
  } catch { return []; }
}
function activeUsers() {
  const leases = new Map(readDhcpLeases().map(lease => [lease.mac, lease]));
  return db.prepare(`SELECT a.*,z.name zone_name,m.name machine_name,
    (SELECT COUNT(*) FROM device_mac_history h WHERE h.identity_id=a.identity_id) mac_history_count,
    (SELECT h.mac FROM device_mac_history h WHERE h.identity_id=a.identity_id AND h.mac<>a.client_mac ORDER BY h.last_seen_at DESC LIMIT 1) previous_mac
    FROM access_entitlements a JOIN zones z ON z.id=a.zone_id LEFT JOIN machines m ON m.id=a.last_machine_id WHERE a.status IN ('active','paused','blocked') ORDER BY a.updated_at DESC`).all().map(row => {
    const state = accessState(row.zone_id, row.client_mac); const lease = leases.get(row.client_mac) || {};
    return { id: row.id, identity_id: row.identity_id || null, mac: row.client_mac, previous_mac: row.previous_mac || '', random_mac_detected: Number(row.mac_history_count || 0) > 1, ip: row.ip_address || lease.ip || '', hostname: lease.hostname || '', zone_name: row.zone_name, machine_name: row.machine_name || '', status: state.status, auto_reconnect: state.auto_reconnect, remaining_seconds: state.remaining_seconds, expires_at: state.expires_at, rate_limit: row.rate_limit, bytes_in: Number(row.bytes_in || 0), bytes_out: Number(row.bytes_out || 0), first_seen_at: row.first_seen_at, last_seen_at: row.last_seen_at || row.updated_at };
  });
}
let systemSnapshotCache = null, systemSnapshotCachedAt = 0;
function systemSnapshot(force = false) {
  if (!force && systemSnapshotCache && Date.now() - systemSnapshotCachedAt < 4000) return systemSnapshotCache;
  const memoryTotal = os.totalmem(); const memoryFree = os.freemem();
  let disk = { total_bytes: 0, used_bytes: 0, available_bytes: 0, used_percent: 0 };
  try {
    const line = execFileSync('/usr/bin/df', ['-kP', '/'], { encoding: 'utf8', timeout: 2000 }).trim().split(/\r?\n/).pop().trim().split(/\s+/);
    disk = { total_bytes: Number(line[1]) * 1024, used_bytes: Number(line[2]) * 1024, available_bytes: Number(line[3]) * 1024, used_percent: Number(String(line[4]).replace('%', '')) };
  } catch {}
  let interfaces = [];
  try {
    let defaultRoutes=[];
    try{defaultRoutes=JSON.parse(execFileSync('/usr/sbin/ip',['-j','route','show','default'],{encoding:'utf8',timeout:2000}));}catch{}
    interfaces = JSON.parse(execFileSync('/usr/sbin/ip', ['-j', 'address'], { encoding: 'utf8', timeout: 2000 })).map(item => {
      const name = String(item.ifname || ''); const root = /^[A-Za-z0-9_.:-]+$/.test(name) ? path.join('/sys/class/net', name) : '';
      const read = (relative, fallback = '') => { try { return fs.readFileSync(path.join(root, relative), 'utf8').trim(); } catch { return fallback; } };
      const speed = Number(read('speed', '0')); const carrier = read('carrier', '0') === '1';
      const route=defaultRoutes.find(entry=>entry.dev===name)||{};
      const ipv4=(item.addr_info||[]).filter(address=>address.family==='inet'),ipv6=(item.addr_info||[]).filter(address=>address.family==='inet6');
      const address_mode=ipv4.some(address=>address.dynamic)||route.protocol==='dhcp'?'dhcp':ipv4.length?'static':'none';
      return { ...item, ipv4_addresses:ipv4.map(address=>`${address.local}/${address.prefixlen}`),ipv6_addresses:ipv6.map(address=>`${address.local}/${address.prefixlen}`),address_mode,default_gateway:route.gateway||'',route_protocol:route.protocol||'',operstate: read('operstate', item.operstate || 'unknown'), carrier, speed_mbps: Number.isFinite(speed) && speed > 0 ? speed : 0, duplex: read('duplex', ''), rx_bytes: Number(read('statistics/rx_bytes', '0')) || 0, tx_bytes: Number(read('statistics/tx_bytes', '0')) || 0 };
    });
  } catch {}
  const serviceNames = ['debian-vendoos','vendo-access-sync','vendo-vlan-sync','vendo-multiwan','vendo-dnsmasq','vendo-firewall','vendo-network','vendo-backup.timer'];
  const services = Object.fromEntries(serviceNames.map(name => {
    try { return [name, execFileSync('/usr/bin/systemctl', ['is-active', name], { encoding: 'utf8', timeout: 2000 }).trim()]; } catch (error) { return [name, String(error.stdout || 'inactive').trim() || 'inactive']; }
  }));
  systemSnapshotCache = { hostname: os.hostname(), platform: os.platform(), release: os.release(), node: process.version, uptime_seconds: Math.floor(os.uptime()), load_average: os.loadavg(), cpu_count: os.cpus().length, memory_total: memoryTotal, memory_used: memoryTotal - memoryFree, memory_percent: memoryTotal ? Math.round((memoryTotal - memoryFree) / memoryTotal * 100) : 0, disk, interfaces, services, dhcp_leases: readDhcpLeases() };
  systemSnapshotCachedAt = Date.now();
  return systemSnapshotCache;
}
function vlanHealth(snapshot = systemSnapshot()) {
  const zones = db.prepare(`SELECT vlan_id,parent_if,gateway,subnet FROM zones WHERE managed=1 AND enabled=1 ORDER BY vlan_id`).all();
  const enabledZones = Number(db.prepare('SELECT COUNT(*) total FROM zones WHERE enabled=1').get().total);
  const interfaces = new Map((snapshot.interfaces || []).map(item => [item.ifname, item]));
  const missingInterfaces = [], missingGateways = [];
  let interfacesReady = 0, gatewaysReady = 0;
  for (const zone of zones) {
    const name = `${zone.parent_if}.${zone.vlan_id}`.slice(0, 15), item = interfaces.get(name);
    if (!item || item.operstate === 'down') missingInterfaces.push(name); else interfacesReady += 1;
    const prefix = String(zone.subnet || '').split('/')[1] || '24';
    if (item && (item.ipv4_addresses || []).includes(`${zone.gateway}/${prefix}`)) gatewaysReady += 1;
    else missingGateways.push(`${name}:${zone.gateway}`);
  }
  let dhcpScopes = 0, scalableMode = false;
  try { dhcpScopes = (fs.readFileSync('/run/debian-vendoos/dnsmasq-vlans.conf', 'utf8').match(/^dhcp-range=/gm) || []).length; } catch {}
  try { scalableMode = /^port=0$/m.test(fs.readFileSync('/etc/debian-vendoos/dnsmasq.conf', 'utf8')) && !/^bind-dynamic$/m.test(fs.readFileSync('/etc/debian-vendoos/dnsmasq.conf', 'utf8')); } catch {}
  const dhcpStatus = snapshot.services?.['vendo-dnsmasq'] || 'unknown', firewallStatus = snapshot.services?.['vendo-firewall'] || 'unknown';
  const checks = [
    { key:'interfaces', label:'VLAN interfaces', ok:interfacesReady===zones.length, value:`${interfacesReady}/${zones.length}`, detail:missingInterfaces.length?`${missingInterfaces.length} missing or down`:'All configured VLAN links are ready' },
    { key:'gateways', label:'Gateway addresses', ok:gatewaysReady===zones.length, value:`${gatewaysReady}/${zones.length}`, detail:missingGateways.length?`${missingGateways.length} gateway addresses missing`:'All VLAN gateways are assigned' },
    { key:'dhcp_scopes', label:'DHCP scopes', ok:dhcpScopes>=enabledZones, value:`${dhcpScopes}/${enabledZones}`, detail:dhcpScopes>=enabledZones?'Every enabled customer network has a scope':'Generated DHCP configuration is incomplete' },
    { key:'dhcp_service', label:'DHCP service', ok:dhcpStatus==='active', value:dhcpStatus, detail:dhcpStatus==='active'?'dnsmasq DHCP is running':'New clients cannot obtain addresses' },
    { key:'capacity', label:'Scalable mode', ok:scalableMode, value:scalableMode?'DHCP only':'Legacy binding', detail:scalableMode?'Single wildcard DHCP socket supports large VLAN ranges':'Per-interface DNS sockets can exhaust capacity' },
    { key:'firewall', label:'VLAN firewall', ok:firewallStatus==='active', value:firewallStatus, detail:firewallStatus==='active'?'Captive access rules are loaded':'Customer forwarding protection is unavailable' }
  ];
  return { status:checks.every(check=>check.ok)?'healthy':'attention', checked_at:nowIso(), configured_vlans:zones.length, enabled_networks:enabledZones, interfaces_ready:interfacesReady, gateways_ready:gatewaysReady, dhcp_scopes:dhcpScopes, dhcp_status:dhcpStatus, firewall_status:firewallStatus, scalable_mode:scalableMode, missing_interfaces:missingInterfaces.slice(0,20), missing_gateways:missingGateways.slice(0,20), checks };
}
function cpuTimes() {
  return os.cpus().reduce((sum, cpu) => {
    const total = Object.values(cpu.times).reduce((value, part) => value + part, 0);
    return { idle: sum.idle + cpu.times.idle, total: sum.total + total };
  }, { idle: 0, total: 0 });
}
function networkCounters() {
  let interfaceNames = [];
  try {
    const settings = settingsMap();
    if (settings.multi_wan_enabled === '1') {
      const configured = JSON.parse(settings.multi_wan_config || '[]');
      interfaceNames = configured.filter(item => item.enabled !== false).map(item => cleanText(item.interface, 30));
    }
    if (!interfaceNames.length) interfaceNames = [cleanText(settings.network_wan_if || process.env.WAN_IF, 30)];
  } catch { interfaceNames = [cleanText(process.env.WAN_IF, 30)]; }
  interfaceNames = [...new Set(interfaceNames.filter(name => /^[A-Za-z0-9_.:-]+$/.test(name)))];
  let rxBytes = 0, txBytes = 0;
  for (const interfaceName of interfaceNames) {
    try {
      const root = path.join('/sys/class/net', interfaceName, 'statistics');
      rxBytes += Number(fs.readFileSync(path.join(root, 'rx_bytes'), 'utf8')) || 0;
      txBytes += Number(fs.readFileSync(path.join(root, 'tx_bytes'), 'utf8')) || 0;
    } catch {}
  }
  return { interface: interfaceNames.join(' + ') || 'WAN', rx_bytes: rxBytes, tx_bytes: txBytes };
}
function interfaceCounters() {
  try {
    return fs.readdirSync('/sys/class/net').filter(name => name !== 'lo' && /^[A-Za-z0-9_.:-]+$/.test(name)).sort().map(name => {
      const root=path.join('/sys/class/net',name),read=file=>{try{return fs.readFileSync(path.join(root,file),'utf8').trim()}catch{return''}};
      return { interface:name,operstate:read('operstate')||'unknown',rx_bytes:Number(read('statistics/rx_bytes'))||0,tx_bytes:Number(read('statistics/tx_bytes'))||0 };
    });
  } catch { return []; }
}
let cpuBaseline = cpuTimes();
let networkBaseline = null;
let interfaceBaseline = { at: 0, counters: {} };
let currentUsage = { timestamp: new Date().toISOString(), cpu_percent: 0, memory_percent: 0, rx_bps: 0, tx_bps: 0, interface: 'WAN', rx_bytes: 0, tx_bytes: 0 };
let currentInterfaceUsage = [];
const usageHistory = [];
const interfaceUsageHistory = [];
function sampleSystemUsage() {
  const now = Date.now(); const cpu = cpuTimes(); const network = networkCounters(); const interfaces=interfaceCounters();
  const totalDelta = Math.max(1, cpu.total - cpuBaseline.total); const idleDelta = Math.max(0, cpu.idle - cpuBaseline.idle);
  const memoryTotal = os.totalmem();
  const elapsed = networkBaseline ? Math.max(0.1, (now - networkBaseline.at) / 1000) : 0;
  currentUsage = {
    timestamp: new Date(now).toISOString(),
    cpu_percent: Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 100))),
    memory_percent: memoryTotal ? Math.round((memoryTotal - os.freemem()) / memoryTotal * 100) : 0,
    rx_bps: elapsed && network.interface === networkBaseline.interface ? Math.max(0, Math.round((network.rx_bytes - networkBaseline.rx_bytes) * 8 / elapsed)) : 0,
    tx_bps: elapsed && network.interface === networkBaseline.interface ? Math.max(0, Math.round((network.tx_bytes - networkBaseline.tx_bytes) * 8 / elapsed)) : 0,
    interface: network.interface, rx_bytes: network.rx_bytes, tx_bytes: network.tx_bytes
  };
  const interfaceElapsed=interfaceBaseline.at?Math.max(.1,(now-interfaceBaseline.at)/1000):0;
  currentInterfaceUsage=interfaces.map(item=>{const previous=interfaceBaseline.counters[item.interface];return{...item,rx_bps:previous&&interfaceElapsed?Math.max(0,Math.round((item.rx_bytes-previous.rx_bytes)*8/interfaceElapsed)):0,tx_bps:previous&&interfaceElapsed?Math.max(0,Math.round((item.tx_bytes-previous.tx_bytes)*8/interfaceElapsed)):0}});
  interfaceBaseline={at:now,counters:Object.fromEntries(interfaces.map(item=>[item.interface,item]))};
  cpuBaseline = cpu; networkBaseline = { ...network, at: now };
  usageHistory.push(currentUsage); if (usageHistory.length > 60) usageHistory.shift();
  interfaceUsageHistory.push({timestamp:currentUsage.timestamp,interfaces:currentInterfaceUsage}); if(interfaceUsageHistory.length>60)interfaceUsageHistory.shift();
  return currentUsage;
}
function settingsMap() { return Object.fromEntries(db.prepare('SELECT key,value FROM settings ORDER BY key').all().map(item => [item.key, item.value])); }
function pbrStatus() {
  try { return JSON.parse(fs.readFileSync('/run/debian-vendoos/pbr-status.json', 'utf8')); }
  catch { return { enabled: false, state: 'disabled', policy_count: 0, active_count: 0, updated_at: null }; }
}
function multiWanStatus() {
  try { return JSON.parse(fs.readFileSync('/run/debian-vendoos/multiwan-status.json', 'utf8')); }
  catch { return { enabled: false, mode: 'weighted-ecmp', active_count: 0, wans: [], updated_at: null }; }
}
function sqmQueueStats() {
  try {
    const rows = JSON.parse(execFileSync('/usr/sbin/tc', ['-s', '-j', 'qdisc', 'show'], { encoding: 'utf8', timeout: 4000, maxBuffer: 16 * 1024 * 1024 }));
    const number = (...values) => { for (const value of values) { const parsed = Number(value); if (Number.isFinite(parsed)) return parsed; } return 0; };
    const result = new Map();
    for (const row of rows) {
      if (!row.dev || !['cake', 'fq_codel', 'htb'].includes(row.kind)) continue;
      if (result.has(row.dev) && row.kind === 'htb') continue;
      result.set(row.dev, {
        qdisc: row.kind || 'unknown',
        bytes: number(row.bytes, row.stats?.bytes, row.stats2?.bytes),
        packets: number(row.packets, row.stats?.packets, row.stats2?.packets),
        drops: number(row.drops, row.stats?.drops, row.stats2?.drops),
        overlimits: number(row.overlimits, row.stats?.overlimits, row.stats2?.overlimits),
        requeues: number(row.requeues, row.stats?.requeues, row.stats2?.requeues),
        backlog_bytes: number(row.backlog, row.stats?.backlog, row.stats2?.backlog),
        queue_length: number(row.qlen, row.stats?.qlen, row.stats2?.qlen),
        memory_used: number(row.memory_used, row.stats2?.memory_used),
        memory_limit: number(row.memory_limit, row.stats2?.memory_limit),
        capacity_estimate_bps: number(row.capacity_estimate, row.stats2?.capacity_estimate)
      });
    }
    return result;
  } catch { return new Map(); }
}
function cakeStatus() {
  let status;
  try { status = JSON.parse(fs.readFileSync('/run/debian-vendoos/cake-status.json', 'utf8')); }
  catch { status = { enabled: false, state: 'unknown', algorithm: null, interfaces: [], updated_at: null }; }
  const queueStats = sqmQueueStats();
  const interfaces = (Array.isArray(status.interfaces) ? status.interfaces : []).map(item => {
    const usage = currentInterfaceUsage.find(entry => entry.interface === item.interface) || {};
    const queue = queueStats.get(item.interface) || null;
    return { ...item, live_rate_bps: Number(usage.tx_bps || 0), rx_bps: Number(usage.rx_bps || 0), tx_bps: Number(usage.tx_bps || 0), queue };
  });
  const queues = interfaces.map(item => item.queue).filter(Boolean);
  return {
    ...status,
    interfaces,
    totals: {
      bytes: queues.reduce((sum, item) => sum + item.bytes, 0),
      packets: queues.reduce((sum, item) => sum + item.packets, 0),
      drops: queues.reduce((sum, item) => sum + item.drops, 0),
      overlimits: queues.reduce((sum, item) => sum + item.overlimits, 0),
      requeues: queues.reduce((sum, item) => sum + item.requeues, 0),
      backlog_bytes: queues.reduce((sum, item) => sum + item.backlog_bytes, 0),
      queue_length: queues.reduce((sum, item) => sum + item.queue_length, 0),
      live_rate_bps: interfaces.reduce((sum, item) => sum + item.live_rate_bps, 0)
    }
  };
}
const PUBLIC_SETTING_KEYS=['brand_name','support_text','currency','portal_tagline','portal_headline','portal_announcement','portal_theme','portal_primary_color','portal_accent_color','portal_logo_url','portal_banner_url','portal_insert_sound_url','portal_coin_sound_url'];
const PORTAL_THEME_PRESETS={
  lite:{primary:'#000000',accent:'#ffffff',banner:''},
  'battle-royale':{primary:'#ffa847',accent:'#70d5ff',banner:'/assets/portal-world-battle-royale-bright.webp?v=1'},
  neon:{primary:'#ff45d4',accent:'#39eaff',banner:'/assets/portal-world-neon.webp?v=1'},
  'ad-showcase':{primary:'#ef7b32',accent:'#138c84',banner:'/assets/portal-ad-showcase-cafe.png?v=1'}
};
const PORTAL_THEMES=new Set(Object.keys(PORTAL_THEME_PRESETS));
db.prepare("UPDATE settings SET value='lite',updated_at=? WHERE key='portal_theme' AND value LIKE 'command-%'").run(nowIso());
function publicBranding(){
  const placeholders=PUBLIC_SETTING_KEYS.map(()=>'?').join(',');
  const values=Object.fromEntries(db.prepare(`SELECT key,value FROM settings WHERE key IN (${placeholders})`).all(...PUBLIC_SETTING_KEYS).map(item=>[item.key,item.value]));
  if(!PORTAL_THEMES.has(values.portal_theme))values.portal_theme='battle-royale';
  if(!values.portal_logo_url)values.portal_logo_url='/assets/defaults/vendo-logo.svg';
  if(!values.portal_banner_url)values.portal_banner_url=PORTAL_THEME_PRESETS[values.portal_theme]?.banner||'/assets/defaults/vendo-banner.webp';
  return values;
}
function machineRows() {
  return db.prepare(`SELECT m.*,z.name zone_name,z.code zone_code,
    CASE WHEN m.last_seen_at>? THEN 1 ELSE 0 END online,
    (SELECT COUNT(*) FROM access_entitlements a WHERE a.last_machine_id=m.id AND a.status='active' AND a.expires_at>?) active_users,
    (SELECT COALESCE(SUM(amount_centavos),0) FROM sales s WHERE s.machine_id=m.id AND s.created_at>=datetime('now','start of day')) sales_today_centavos
    FROM machines m JOIN zones z ON z.id=m.zone_id WHERE m.enabled=1 ORDER BY m.name`).all(onlineCutoff(), nowIso()).map(row => {
      try { row.telemetry = JSON.parse(row.last_status_json || '{}'); } catch { row.telemetry = {}; }
      return row;
    });
}
function salesRows(url, limit = 1000) {
  const from = dateFilter(url.searchParams.get('from')); const to = dateFilter(url.searchParams.get('to'));
  const machine = int(url.searchParams.get('machine'), 0, 1); const method = cleanText(url.searchParams.get('method'), 20);
  const conditions = []; const params = [];
  if (from) { conditions.push('s.created_at>=?'); params.push(from); }
  if (to) { conditions.push("s.created_at<datetime(?,'+1 day')"); params.push(to); }
  if (machine) { conditions.push('s.machine_id=?'); params.push(machine); }
  if (['coin','voucher','manual'].includes(method)) { conditions.push('s.method=?'); params.push(method); }
  params.push(limit);
  return db.prepare(`SELECT s.*,m.name machine_name FROM sales s LEFT JOIN machines m ON m.id=s.machine_id ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY s.id DESC LIMIT ?`).all(...params);
}
function clientIp(req) {
  if (ALLOW_TEST_MAC && req.headers['x-test-client-ip']) return String(req.headers['x-test-client-ip']);
  return String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}
function resolveMac(req) {
  if (ALLOW_TEST_MAC) {
    const test = normalizeMac(req.headers['x-test-client-mac']);
    if (test) return test;
  }
  const ip = clientIp(req);
  const zone = customerZoneForIp(ip);
  if (!zone) return '';
  const lease = readDhcpLeases().find(item => item.ip === ip && item.mac);
  if (lease) return normalizeMac(lease.mac);
  const settings = settingsMap();
  const customer = settings.network_mode === 'bridge' && settings.network_bridge_if ? settings.network_bridge_if : settings.network_customer_if || CUSTOMER_IF;
  const candidates = new Set(zone.managed ? [`${zone.parent_if}.${zone.vlan_id}`.slice(0, 15), zone.parent_if] : [customer, CUSTOMER_IF]);
  for (const device of candidates) {
    if (!device || !/^[A-Za-z0-9_.:-]+$/.test(device)) continue;
    try {
      const rows = JSON.parse(execFileSync('/usr/sbin/ip', ['-j', 'neigh', 'show', 'to', ip, 'dev', device], { encoding: 'utf8', timeout: 1500 }) || '[]');
      const mac = normalizeMac(rows.find(item => item.lladdr)?.lladdr);
      if (mac) return mac;
    } catch {}
  }
  try {
    const row = fs.readFileSync('/proc/net/arp', 'utf8').split(/\r?\n/).slice(1).map(line => line.trim().split(/\s+/)).find(parts => parts[0] === ip && candidates.has(parts[5]));
    return normalizeMac(row?.[3]);
  } catch { return ''; }
}
function event(level, type, message, details = {}) {
  db.prepare('INSERT INTO events(level,type,message,details_json) VALUES(?,?,?,?)').run(level, type, message, JSON.stringify(details));
}

function isEspBoard(board) { return /^ESP(?:8266|32)(?:-[A-Z0-9_-]+)?$/i.test(String(board || '')); }
function installedFirmwareMatches(machine, release) {
  return String(machine.firmware_version || '') === `${release.version}-${machine.board}`;
}
function firmwareCommandPayload(row) {
  try { return JSON.parse(row.payload_json || '{}'); } catch { return {}; }
}
function queueFirmwareForMachines(release, machines) {
  const activeCommands = db.prepare(`SELECT machine_id,payload_json FROM hardware_commands WHERE command='firmware_update' AND status IN ('pending','delivered') ORDER BY id DESC`).all();
  const pending = new Set(activeCommands.filter(row => Number(firmwareCommandPayload(row).release_id) === Number(release.id)).map(row => Number(row.machine_id)));
  const add = db.prepare(`INSERT INTO hardware_commands(machine_id,command,payload_json) VALUES(?,'firmware_update',?)`);
  let queued = 0, already_current = 0, already_queued = 0;
  for (const machine of machines) {
    if (machine.board !== release.board) continue;
    if (installedFirmwareMatches(machine, release)) { already_current += 1; continue; }
    if (pending.has(Number(machine.id))) { already_queued += 1; continue; }
    add.run(machine.id, JSON.stringify({ release_id: release.id, version: release.version, board: release.board, url: `/api/device/firmware/${release.id}`, sha256: release.sha256, signature: release.signature }));
    queued += 1;
  }
  return { queued, already_current, already_queued };
}
function machineOtaHealthy(machine, release) {
  if (!machine || !installedFirmwareMatches(machine, release) || !machine.last_seen_at || machine.last_seen_at <= onlineCutoff()) return false;
  let telemetry = {}; try { telemetry = JSON.parse(machine.last_status_json || '{}'); } catch {}
  return Number(telemetry.uptime_seconds || 0) >= 60 && Number(telemetry.free_heap || 0) >= 10000;
}
function createFirmwareRollout(release, machines) {
  const targets = machines.filter(machine => machine.board === release.board && !installedFirmwareMatches(machine, release));
  if (!targets.length) return { rollout_id: null, queued: 0, already_current: machines.length };
  const active = db.prepare(`SELECT id FROM firmware_rollouts WHERE release_id=? AND status IN ('canary','rolling') ORDER BY id DESC LIMIT 1`).get(release.id);
  if (active) return { rollout_id: active.id, queued: 0, already_active: targets.length };
  const canary = targets.find(machine => machine.last_seen_at && machine.last_seen_at > onlineCutoff()) || targets[0];
  const created = nowIso();
  const result = db.prepare(`INSERT INTO firmware_rollouts(release_id,strategy,status,target_machine_ids_json,canary_machine_ids_json,created_at,updated_at) VALUES(?,'canary','canary',?,?,?,?)`).run(release.id, JSON.stringify(targets.map(machine => machine.id)), JSON.stringify([canary.id]), created, created);
  const queued = queueFirmwareForMachines(release, [canary]);
  event('warning','firmware.canary_started',`${release.board} ${release.version} canary rollout started`,{rollout_id:Number(result.lastInsertRowid),canary_machine_id:canary.id,target_count:targets.length});
  return { rollout_id: Number(result.lastInsertRowid), canary_machine_id: canary.id, target_count: targets.length, ...queued };
}
function advanceFirmwareRollouts() {
  const rollouts = db.prepare(`SELECT * FROM firmware_rollouts WHERE status IN ('canary','rolling') ORDER BY id`).all();
  for (const rollout of rollouts) {
    const release = db.prepare('SELECT * FROM firmware_releases WHERE id=? AND enabled=1').get(rollout.release_id);
    if (!release) { db.prepare(`UPDATE firmware_rollouts SET status='failed',error='Release unavailable',updated_at=? WHERE id=?`).run(nowIso(), rollout.id); continue; }
    let targetIds = [], canaryIds = [];
    try { targetIds = JSON.parse(rollout.target_machine_ids_json || '[]').map(Number); canaryIds = JSON.parse(rollout.canary_machine_ids_json || '[]').map(Number); } catch {}
    const machines = targetIds.length ? db.prepare(`SELECT * FROM machines WHERE enabled=1 AND id IN (${targetIds.map(()=>'?').join(',')})`).all(...targetIds) : [];
    const byId = new Map(machines.map(machine => [Number(machine.id), machine]));
    if (rollout.status === 'canary') {
      const canaries = canaryIds.map(id => byId.get(id)).filter(Boolean);
      if (canaries.length && canaries.every(machine => machineOtaHealthy(machine, release))) {
        const remaining = machines.filter(machine => !canaryIds.includes(Number(machine.id)));
        queueFirmwareForMachines(release, remaining);
        const status = remaining.length ? 'rolling' : 'completed';
        db.prepare(`UPDATE firmware_rollouts SET status=?,promoted_at=?,completed_at=?,updated_at=? WHERE id=?`).run(status, nowIso(), status === 'completed' ? nowIso() : null, nowIso(), rollout.id);
        event('info','firmware.canary_passed',`${release.board} ${release.version} canary passed`,{rollout_id:rollout.id,remaining:remaining.length});
      } else if (Date.now() - Date.parse(rollout.created_at) > 15 * 60 * 1000) {
        db.prepare(`UPDATE firmware_rollouts SET status='failed',error='Canary did not become healthy within 15 minutes',updated_at=? WHERE id=?`).run(nowIso(), rollout.id);
        event('error','firmware.canary_failed',`${release.board} ${release.version} canary failed`,{rollout_id:rollout.id});
      }
    } else if (machines.length && machines.every(machine => machineOtaHealthy(machine, release))) {
      db.prepare(`UPDATE firmware_rollouts SET status='completed',completed_at=?,updated_at=? WHERE id=?`).run(nowIso(), nowIso(), rollout.id);
      event('info','firmware.rollout_completed',`${release.board} ${release.version} rollout completed`,{rollout_id:rollout.id,target_count:machines.length});
    }
  }
}
function firmwareFleetStatus() {
  const releases = db.prepare("SELECT id,version,board,file_name,sha256,size_bytes,created_at,CASE WHEN length(signature)=64 THEN 1 ELSE 0 END signed FROM firmware_releases WHERE enabled=1 ORDER BY id DESC").all();
  const releaseById = new Map(releases.map(release => [Number(release.id), release]));
  const latestByBoard = new Map();
  releases.forEach(release => { if (!latestByBoard.has(release.board)) latestByBoard.set(release.board, release); });
  const latestCommands = new Map();
  db.prepare(`SELECT * FROM hardware_commands WHERE command='firmware_update' ORDER BY id DESC`).all().forEach(command => {
    if (!latestCommands.has(Number(command.machine_id))) latestCommands.set(Number(command.machine_id), command);
  });
  const cutoff = onlineCutoff();
  const machines = db.prepare(`SELECT id,name,hardware_id,board,firmware_version,last_seen_at,last_status_json FROM machines WHERE enabled=1 AND (board LIKE 'ESP8266%' OR board LIKE 'ESP32%') ORDER BY name`).all().map(machine => {
    const command = latestCommands.get(Number(machine.id));
    const payload = command ? firmwareCommandPayload(command) : {};
    const commandedRelease = releaseById.get(Number(payload.release_id));
    const latestRelease = latestByBoard.get(machine.board);
    const commandReleaseCurrent = commandedRelease && installedFirmwareMatches(machine, commandedRelease);
    const commandRelevant = Boolean(command && commandedRelease && (!commandReleaseCurrent || ['pending','delivered'].includes(command.status)));
    const target = commandRelevant ? commandedRelease : latestRelease || null;
    const online = Boolean(machine.last_seen_at && machine.last_seen_at > cutoff);
    const current = target && installedFirmwareMatches(machine, target);
    let status = current ? (machineOtaHealthy(machine, target) ? 'up_to_date' : 'verifying') : latestRelease ? 'update_available' : 'no_release';
    if (commandRelevant && !current) {
      if (command.status === 'pending') status = online ? 'queued' : 'waiting_offline';
      else if (command.status === 'delivered') status = 'installing';
      else if (command.status === 'acked') {
        const age = Date.now() - Date.parse(command.acked_at || command.created_at);
        status = age > 180000 ? 'verify_failed' : 'restarting';
      } else status = 'failed';
    }
    return { id: machine.id, name: machine.name, hardware_id: machine.hardware_id, board: machine.board, installed_version: machine.firmware_version || '', target_version: target?.version || '', release_id: target?.id || null, online, last_seen_at: machine.last_seen_at, command_id: command?.id || null, command_status: command?.status || null, status };
  });
  const counts = machines.reduce((summary, machine) => { summary.total += 1; summary[machine.status] = (summary[machine.status] || 0) + 1; if (machine.online) summary.online += 1; return summary; }, { total: 0, online: 0 });
  const rollouts=db.prepare(`SELECT r.*,f.version,f.board FROM firmware_rollouts r JOIN firmware_releases f ON f.id=r.release_id ORDER BY r.id DESC LIMIT 20`).all().map(row=>{let targets=[],canaries=[];try{targets=JSON.parse(row.target_machine_ids_json||'[]');canaries=JSON.parse(row.canary_machine_ids_json||'[]')}catch{}return{id:row.id,release_id:row.release_id,version:row.version,board:row.board,strategy:row.strategy,status:row.status,target_count:targets.length,canary_count:canaries.length,created_at:row.created_at,updated_at:row.updated_at,promoted_at:row.promoted_at,completed_at:row.completed_at,error:row.error}});
  return { counts, machines, rollouts };
}

function scheduleSystemPower(action) {
  const command = action === 'reboot' ? 'reboot' : 'shutdown';
  setTimeout(() => {
    const child = spawn('/usr/bin/sudo', ['-n', '/usr/local/sbin/vendoos-power', command], { detached: true, stdio: 'ignore' });
    child.on('error', error => event('error', 'system.power_failed', `Unable to ${action} the server`, { action, error: error.message }));
    child.on('exit', code => { if (code) event('error', 'system.power_failed', `${action} command exited with code ${code}`, { action, code }); });
    child.unref();
  }, 1500).unref();
}
function onlineCutoff() { return new Date(Date.now() - HARDWARE_ONLINE_SECONDS * 1000).toISOString(); }
const coinSessionStreams = new Map();
const heartbeatPersistedAt = new Map();
const requestMetrics = { started_at: nowIso(), total: 0, completed: 0, errors: 0, active: 0, peak_active: 0 };
const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
eventLoopDelay.enable();
function capacitySnapshot() {
  const cutoff = onlineCutoff(), configured = Number(db.prepare('SELECT COUNT(*) total FROM machines WHERE enabled=1').get().total), online = Number(db.prepare('SELECT COUNT(*) total FROM machines WHERE enabled=1 AND last_seen_at>?').get(cutoff).total), activeCoinSessions = Number(db.prepare("SELECT COUNT(*) total FROM coin_sessions WHERE status='open' AND lease_expires_at>?").get(nowIso()).total);
  const size = file => { try { return fs.statSync(file).size; } catch { return 0; } };
  const event_loop_delay_ms = { mean:Number.isFinite(eventLoopDelay.mean)?Number((eventLoopDelay.mean/1e6).toFixed(2)):0, p95:Number((eventLoopDelay.percentile(95)/1e6).toFixed(2)), max:Number((eventLoopDelay.max/1e6).toFixed(2)) };
  eventLoopDelay.reset();
  return { target_active_stations:1000, configured_stations:configured, online_stations:online, active_coin_sessions:activeCoinSessions, coin_streams:[...coinSessionStreams.values()].reduce((total,listeners)=>total+listeners.size,0), requests:{...requestMetrics}, event_loop_delay_ms, statement_cache:{size:statementCache.size,limit:512}, database:{bytes:size(DB_FILE),wal_bytes:size(`${DB_FILE}-wal`),cache_kib:DB_CACHE_KIB,mmap_bytes:DB_MMAP_BYTES}, heartbeat:{idle_ms:DEVICE_HEARTBEAT_IDLE_MS,active_ms:DEVICE_HEARTBEAT_ACTIVE_MS,jitter_ms:DEVICE_HEARTBEAT_JITTER_MS,persist_ms:DEVICE_HEARTBEAT_PERSIST_MS}, server:{cpu_count:os.cpus().length,memory_used_bytes:process.memoryUsage().rss,uptime_seconds:Math.floor(process.uptime())} };
}
function publishCoinSession(id) {
  const listeners = coinSessionStreams.get(Number(id));
  if (!listeners?.size) return;
  const row = db.prepare('SELECT * FROM coin_sessions WHERE id=?').get(Number(id));
  if (!row) return;
  const message = `data: ${JSON.stringify(sessionView(row))}\n\n`;
  for (const res of [...listeners]) {
    try { res.write(message); }
    catch { listeners.delete(res); }
  }
  if (row.status !== 'open') {
    for (const res of [...listeners]) { try { res.end(); } catch {} }
    coinSessionStreams.delete(Number(id));
  }
}
function openCoinSessionStream(req, res, row) {
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'keep-alive', 'x-accel-buffering': 'no' });
  res.write(`data: ${JSON.stringify(sessionView(row))}\n\n`);
  const id = Number(row.id); const listeners = coinSessionStreams.get(id) || new Set(); listeners.add(res); coinSessionStreams.set(id, listeners);
  const keepAlive = setInterval(() => { try { res.write(': keepalive\n\n'); } catch {} }, 10000); keepAlive.unref();
  req.on('close', () => { clearInterval(keepAlive); listeners.delete(res); if (!listeners.size) coinSessionStreams.delete(id); });
}
let cleaning = false, lastCleanupAt = 0, lastRolloutAdvanceAt = 0, lastEventPruneAt = 0;
function cleanup(force = false) {
  const startedAt = Date.now();
  if (cleaning || (!force && startedAt - lastCleanupAt < 750)) return;
  cleaning = true;
  lastCleanupAt = startedAt;
  try {
    const now = nowIso();
    const expiredSessions = db.prepare(`SELECT * FROM coin_sessions WHERE status='open' AND lease_expires_at<=?`).all(now);
    for (const row of expiredSessions) {
      if (Number(row.amount_centavos) > 0) {
        try { completeSession(row, true); }
        catch (error) {
          db.prepare(`UPDATE coin_sessions SET status='expired' WHERE id=? AND status='open'`).run(row.id);
          event('error', 'coin.auto_credit_failed', `Coin session ${row.id} could not be credited automatically`, {
            machine_id: row.machine_id,
            amount_centavos: row.amount_centavos,
            error: String(error?.message || error)
          });
          publishCoinSession(row.id);
        }
      } else { db.prepare(`UPDATE coin_sessions SET status='expired' WHERE id=? AND status='open'`).run(row.id); publishCoinSession(row.id); }
    }
    db.prepare(`UPDATE access_entitlements SET status='expired',remaining_seconds=0,updated_at=?
      WHERE status='active' AND expires_at IS NOT NULL AND expires_at<=?`).run(now, now);
    db.prepare('DELETE FROM admin_sessions WHERE expires_at<=?').run(now);
    if (startedAt - lastRolloutAdvanceAt >= 10000) { advanceFirmwareRollouts(); lastRolloutAdvanceAt = startedAt; }
    if (startedAt - lastEventPruneAt >= 3600000) {
      db.prepare('DELETE FROM events WHERE id < COALESCE((SELECT id FROM events ORDER BY id DESC LIMIT 1 OFFSET 99999),0)').run();
      lastEventPruneAt = startedAt;
    }
  } finally { cleaning = false; }
}
function accessState(zone, mac) {
  cleanup();
  const row = db.prepare('SELECT * FROM access_entitlements WHERE zone_id=? AND client_mac=?').get(zone, mac);
  if (!row) return { status: 'none', auto_reconnect: false, remaining_seconds: 0, expires_at: null, rate_limit: null, ip_address: null, bytes_in: 0, bytes_out: 0 };
  if (row.status === 'blocked') return { status: 'blocked', auto_reconnect: false, remaining_seconds: 0, expires_at: null, rate_limit: row.rate_limit, ip_address: row.ip_address, bytes_in: Number(row.bytes_in || 0), bytes_out: Number(row.bytes_out || 0) };
  let remaining = Number(row.remaining_seconds || 0);
  if (row.status === 'active' && row.expires_at) remaining = Math.max(0, Math.ceil((Date.parse(row.expires_at) - Date.now()) / 1000));
  return { status: remaining > 0 ? row.status : 'expired', auto_reconnect: Boolean(row.auto_reconnect) && row.status === 'paused' && remaining > 0, remaining_seconds: remaining, expires_at: row.expires_at, rate_limit: row.rate_limit, ip_address: row.ip_address, bytes_in: Number(row.bytes_in || 0), bytes_out: Number(row.bytes_out || 0) };
}
function autoReconnectAccess(zone, mac) {
  const row = db.prepare('SELECT id,status,remaining_seconds,auto_reconnect FROM access_entitlements WHERE zone_id=? AND client_mac=?').get(zone, mac);
  if (!row || row.status !== 'paused' || !Number(row.auto_reconnect) || Number(row.remaining_seconds) <= 0) return false;
  const now = nowIso();
  db.prepare(`UPDATE access_entitlements SET status='active',expires_at=?,remaining_seconds=0,auto_reconnect=0,last_seen_at=?,updated_at=? WHERE id=?`)
    .run(futureIso(Number(row.remaining_seconds)), now, now, row.id);
  event('info', 'access.auto_reconnected', 'Customer access reconnected automatically', { zone_id: zone, client_mac: mac });
  return true;
}
function globalUserRateLimit(fallback = '5M/5M') {
  const settings = settingsMap();
  if (settings.global_user_speed_enabled !== '1') return fallback;
  const download = Number(settings.global_user_download_mbps); const upload = Number(settings.global_user_upload_mbps);
  if (!Number.isFinite(download) || download <= 0 || !Number.isFinite(upload) || upload <= 0) return fallback;
  return `${download}M/${upload}M`;
}
function grantAccess(zone, mac, seconds, rateLimit = '5M/5M', ipAddress = null, machineId = null) {
  rateLimit = globalUserRateLimit(rateLimit);
  const current = accessState(zone, mac);
  if (current.status === 'blocked') throw Object.assign(new Error('This customer is blocked. Unblock the customer before adding time.'), { status: 403 });
  const total = Math.max(0, current.remaining_seconds) + seconds;
  if (current.status === 'paused') {
    db.prepare(`INSERT INTO access_entitlements(zone_id,client_mac,status,expires_at,remaining_seconds,rate_limit,ip_address,last_machine_id,first_seen_at,last_seen_at,updated_at)
      VALUES(?,?,'paused',NULL,?,?,?,?,?,?,?) ON CONFLICT(zone_id,client_mac) DO UPDATE SET
      status='paused',expires_at=NULL,remaining_seconds=excluded.remaining_seconds,rate_limit=excluded.rate_limit,ip_address=COALESCE(excluded.ip_address,access_entitlements.ip_address),last_machine_id=COALESCE(excluded.last_machine_id,access_entitlements.last_machine_id),last_seen_at=excluded.last_seen_at,updated_at=excluded.updated_at`)
      .run(zone, mac, total, rateLimit, ipAddress, machineId, nowIso(), nowIso(), nowIso());
    return accessState(zone, mac);
  }
  const expires = futureIso(total);
  db.prepare(`INSERT INTO access_entitlements(zone_id,client_mac,status,expires_at,remaining_seconds,rate_limit,ip_address,last_machine_id,first_seen_at,last_seen_at,auto_reconnect,updated_at)
    VALUES(?,?,'active',?,0,?,?,?,?,?,0,?) ON CONFLICT(zone_id,client_mac) DO UPDATE SET
    status='active',expires_at=excluded.expires_at,remaining_seconds=0,rate_limit=excluded.rate_limit,ip_address=COALESCE(excluded.ip_address,access_entitlements.ip_address),last_machine_id=COALESCE(excluded.last_machine_id,access_entitlements.last_machine_id),last_seen_at=excluded.last_seen_at,auto_reconnect=0,updated_at=excluded.updated_at`)
    .run(zone, mac, expires, rateLimit, ipAddress, machineId, nowIso(), nowIso(), nowIso());
  return accessState(zone, mac);
}
function ratesFor(zone, machineId = null, includeDisabled = false) {
  const select = `SELECT id,name,price_centavos,duration_seconds,rate_limit,pausable,sort_order,expiry_seconds,pause_limit,points,is_default,enabled FROM rates`;
  if (machineId && db.prepare('SELECT 1 FROM machine_rates WHERE machine_id=? LIMIT 1').get(machineId)) {
    return db.prepare(`${select} WHERE id IN (SELECT rate_id FROM machine_rates WHERE machine_id=?) ${includeDisabled ? '' : 'AND enabled=1'} ORDER BY sort_order,price_centavos`).all(machineId);
  }
  const defaults = db.prepare(`${select} WHERE (zone_id=? OR zone_id IS NULL) AND is_default=1 ${includeDisabled ? '' : 'AND enabled=1'} ORDER BY sort_order,price_centavos`).all(zone);
  if (defaults.length) return defaults;
  return db.prepare(`${select} WHERE (zone_id=? OR zone_id IS NULL) ${includeDisabled ? '' : 'AND enabled=1'} ORDER BY sort_order,price_centavos`).all(zone);
}
function coinCredit(zone, amount, machineId = null) {
  const rates = ratesFor(zone, machineId);
  if (!rates.length || amount <= 0) return { seconds: 0, rate_limit: '5M/5M' };
  const dp = Array(amount + 1).fill(null); dp[0] = { seconds: 0, rate_limit: rates[0].rate_limit };
  for (let cents = 1; cents <= amount; cents += 1) {
    for (const rate of rates) {
      const price = Number(rate.price_centavos);
      if (price <= cents && dp[cents - price]) {
        const candidate = { seconds: dp[cents - price].seconds + Number(rate.duration_seconds), rate_limit: rate.rate_limit };
        if (!dp[cents] || candidate.seconds > dp[cents].seconds) dp[cents] = candidate;
      }
    }
  }
  if (dp[amount]) return dp[amount];
  let best = { seconds: 0, rate_limit: rates[0].rate_limit };
  for (let cents = 0; cents <= amount; cents += 1) if (dp[cents] && dp[cents].seconds > best.seconds) best = dp[cents];
  return best;
}
function requireMac(req, res) {
  const mac = resolveMac(req);
  if (!mac) json(res, 409, { error: 'Unable to identify this device on the customer network' });
  return mac;
}
function paymentEncryptionKey(create = false) {
  try { const key=fs.readFileSync(PAYMENT_KEY_FILE);if(key.length!==32)throw new Error('PayMongo encryption key file is invalid');if(process.platform!=='win32'&&(fs.statSync(PAYMENT_KEY_FILE).mode&0o077)!==0)fs.chmodSync(PAYMENT_KEY_FILE,0o600);return key; }
  catch (error) {
    if (error.code !== 'ENOENT' || !create) return null;
    const key = crypto.randomBytes(32);
    try { fs.writeFileSync(PAYMENT_KEY_FILE,key,{flag:'wx',mode:0o600}); }
    catch (writeError) { if(writeError.code!=='EEXIST')throw writeError; }
    return fs.readFileSync(PAYMENT_KEY_FILE);
  }
}
function encryptPaymentSecret(secret) {
  const key=paymentEncryptionKey(true),nonce=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',key,nonce),encrypted=Buffer.concat([cipher.update(String(secret),'utf8'),cipher.final()]);
  return [nonce.toString('base64'),cipher.getAuthTag().toString('base64'),encrypted.toString('base64')].join('.');
}
function decryptPaymentSecret(value) {
  if(!value)return '';
  const key=paymentEncryptionKey(false);if(!key)throw new Error('PayMongo encryption key is missing; re-enter gateway secrets in Admin settings');
  const [nonce,tag,data]=String(value).split('.');if(!nonce||!tag||!data)throw new Error('Encrypted PayMongo configuration is invalid');
  const decipher=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(nonce,'base64'));decipher.setAuthTag(Buffer.from(tag,'base64'));return Buffer.concat([decipher.update(Buffer.from(data,'base64')),decipher.final()]).toString('utf8');
}
function paymentConfig() {
  const stored=db.prepare('SELECT * FROM payment_gateway_config WHERE id=1').get();
  let storedSecret='',storedWebhook='',error='';
  if(stored){try{storedSecret=decryptPaymentSecret(stored.secret_key_cipher);storedWebhook=decryptPaymentSecret(stored.webhook_secret_cipher)}catch(cause){error=cause.message}}
  const secretKey=process.env.PAYMONGO_SECRET_KEY||storedSecret,webhookSecret=process.env.PAYMONGO_WEBHOOK_SECRET||storedWebhook;
  const returnBaseUrl=String(process.env.PAYMONGO_RETURN_BASE_URL||stored?.return_base_url||'').replace(/\/+$/,'');
  const envManaged=Boolean(process.env.PAYMONGO_SECRET_KEY||process.env.PAYMONGO_WEBHOOK_SECRET||process.env.PAYMONGO_RETURN_BASE_URL),configured=Boolean(/^sk_(test|live)_/.test(secretKey)&&webhookSecret&&/^https:\/\//i.test(returnBaseUrl));
  return {secretKey,webhookSecret,returnBaseUrl,enabled:Boolean(configured&&(envManaged||stored?.enabled)),configured,mode:secretKey.startsWith('sk_live_')?'live':secretKey.startsWith('sk_test_')?'test':'unset',source:envManaged?'environment':stored?'admin':'unset',configuredSecret:Boolean(secretKey),configuredWebhook:Boolean(webhookSecret),updatedAt:stored?.updated_at||null,error};
}
function paymongoSignatureValid(req, raw, config) {
  if (!config.webhookSecret) return false;
  const parts = Object.fromEntries(String(req.headers['paymongo-signature'] || '').split(',').map(item => item.trim().split(/=(.*)/s).slice(0, 2)));
  const timestamp = Number(parts.t);
  if (!Number.isFinite(timestamp) || Math.abs(Date.now() / 1000 - timestamp) > 300) return false;
  const liveMode = config.secretKey.startsWith('sk_live_');
  const provided = String(liveMode ? parts.li || '' : parts.te || '');
  if (!/^[a-f0-9]{64}$/i.test(provided)) return false;
  const expected = crypto.createHmac('sha256', config.webhookSecret).update(`${parts.t}.${raw.toString('utf8')}`).digest();
  const actual = Buffer.from(provided, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function fulfillPaymongoSession(session, eventId) {
  const attributes = session?.attributes || {};
  const orderId = cleanText(attributes.reference_number, 80);
  const order = orderId && db.prepare('SELECT * FROM checkout_orders WHERE id=?').get(orderId);
  if (!order || order.checkout_session_id !== session.id) throw new Error('PayMongo session does not match an order');
  if (attributes.amount_total != null && Number(attributes.amount_total) !== Number(order.amount_centavos)) throw new Error('PayMongo amount did not match the order');
  if (attributes.currency && String(attributes.currency).toUpperCase() !== 'PHP') throw new Error('PayMongo currency did not match the order');
  db.exec('BEGIN IMMEDIATE');
  try {
    if (db.prepare('SELECT 1 FROM payment_webhook_events WHERE event_id=?').get(eventId)) { db.exec('COMMIT'); return; }
    const freshOrder=db.prepare('SELECT * FROM checkout_orders WHERE id=?').get(order.id);
    if (!['paid','fulfilled'].includes(freshOrder.status)) {
      const code = crypto.randomBytes(6).toString('hex').toUpperCase();
      const voucher = db.prepare(`INSERT INTO vouchers(code_hash,code_hint,code_value,batch_code,zone_id,duration_seconds,rate_limit,price_centavos,status)
        VALUES(?,?,?,?,?,?,?,?,'unused') RETURNING id`).get(sha(code),`${code.slice(0,4)}…${code.slice(-3)}`,code,`PAYMONGO-${freshOrder.id}`,freshOrder.zone_id,freshOrder.duration_seconds,freshOrder.rate_limit,freshOrder.amount_centavos);
      db.prepare(`UPDATE checkout_orders SET status='fulfilled',voucher_id=?,voucher_code=?,payment_id=?,updated_at=? WHERE id=? AND status<>'fulfilled'`)
        .run(voucher.id,code,cleanText(attributes.payment_intent_id || attributes.payment_id,100),nowIso(),freshOrder.id);
      db.prepare(`INSERT INTO sales(zone_id,client_mac,method,amount_centavos,credited_seconds,reference,payment_provider) VALUES(?,?,'voucher',?,?,?,'PayMongo')`)
        .run(freshOrder.zone_id,freshOrder.client_mac,freshOrder.amount_centavos,freshOrder.duration_seconds,`PAYMONGO-${freshOrder.id}`);
      if (freshOrder.identity_id) {
        const configured=Number(db.prepare('SELECT points FROM rates WHERE id=?').get(freshOrder.rate_id)?.points||0),points=configured||Math.floor(Number(freshOrder.amount_centavos)/1000);
        if(points>0)db.prepare('INSERT OR IGNORE INTO loyalty_ledger(identity_id,points,reason,reference) VALUES(?,?,?,?)').run(freshOrder.identity_id,points,'PayMongo voucher purchase',`PAYMONGO-${freshOrder.id}`);
      }
    }
    db.prepare('INSERT INTO payment_webhook_events(event_id,event_type) VALUES(?,?)').run(eventId,'checkout_session.payment.paid');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}
function bearer(req) { return String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim(); }
function adminAuth(req, res) {
  const token = bearer(req);
  const row = token && db.prepare(`SELECT s.id,s.user_id,u.username,u.role FROM admin_sessions s
    JOIN admin_users u ON u.id=s.user_id AND u.enabled=1
    WHERE s.token_hash=? AND s.expires_at>?`).get(sha(token), nowIso());
  if (!row) { json(res, 401, { error: 'Authentication required' }); return false; }
  return row;
}
const ADMIN_ROLES = new Set(['owner','admin','technician','collector','seller','viewer']);
const FULL_ACCESS_ROLES = new Set(['owner','admin']);
const ROLE_MODULES = {
  owner: ['overview','sessions','stations','rates','vouchers','sellers','sales','collections','network','system','activity'],
  admin: ['overview','sessions','stations','rates','vouchers','sellers','sales','collections','network','system','activity'],
  technician: ['overview','sessions','stations','rates','network','system','activity'],
  collector: ['overview','sales','collections','activity'],
  seller: ['overview','rates','vouchers','sellers','sales','activity'],
  viewer: ['overview','sessions','stations','rates','vouchers','sellers','sales','collections','network','system','activity']
};
const ROLE_WRITE_SCOPES = {
  owner: ['*'], admin: ['*'], technician: ['sessions','machines','zones','network','firmware'],
  collector: ['collections'], seller: ['voucher_issue'], viewer: []
};
const ROLE_READ_GROUPS = {
  technician: new Set(['overview','usage','sessions','machines','zones','rates','network','firmware']),
  collector: new Set(['overview','usage','machines','sales','collections']),
  seller: new Set(['overview','usage','rates','vouchers','sellers','sales'])
};
function normalizedAdminRole(role) { return ADMIN_ROLES.has(String(role)) ? String(role) : 'viewer'; }
function adminEndpointGroup(pathname) {
  if (pathname.startsWith('/api/admin/users') || pathname === '/api/admin/me') return 'users';
  if (pathname === '/api/admin/summary' || pathname === '/api/admin/capacity') return 'overview';
  if (pathname === '/api/admin/usage') return 'usage';
  if (pathname.startsWith('/api/admin/sessions')) return 'sessions';
  if (pathname.startsWith('/api/admin/machines') || pathname.startsWith('/api/admin/stations')) return 'machines';
  if (pathname.startsWith('/api/admin/zones')) return 'zones';
  if (pathname.startsWith('/api/admin/rates')) return 'rates';
  if (pathname.startsWith('/api/admin/vouchers') || pathname.includes('/export/vouchers')) return 'vouchers';
  if (pathname.startsWith('/api/admin/sellers')) return 'sellers';
  if (pathname.startsWith('/api/admin/sales') || pathname.includes('/export/sales') || pathname.startsWith('/api/admin/reports')) return 'sales';
  if (pathname.startsWith('/api/admin/collections')) return 'collections';
  if (pathname.startsWith('/api/admin/network')) return 'network';
  if (pathname.startsWith('/api/admin/firmware')) return 'firmware';
  if (pathname.startsWith('/api/admin/settings') || pathname.startsWith('/api/admin/portal-assets')) return 'settings';
  if (pathname.startsWith('/api/admin/campaigns') || pathname.startsWith('/api/admin/payments')) return 'settings';
  if (pathname.startsWith('/api/admin/backups')) return 'backups';
  if (pathname.startsWith('/api/admin/system')) return 'system';
  return 'other';
}
function adminRoleProfile(row) {
  const role = normalizedAdminRole(row.role);
  return { id: Number(row.user_id || row.id), username: row.username, role, modules: ROLE_MODULES[role], write_scopes: ROLE_WRITE_SCOPES[role], can_manage_users: FULL_ACCESS_ROLES.has(role), read_only: role === 'viewer' };
}
function adminCan(row, method, pathname) {
  const role = normalizedAdminRole(row.role); const group = adminEndpointGroup(pathname);
  if (pathname === '/api/admin/me') return method === 'GET';
  if (group === 'users') return FULL_ACCESS_ROLES.has(role);
  if (FULL_ACCESS_ROLES.has(role)) return true;
  if (method === 'GET') {
    if (role === 'viewer') return true;
    return ROLE_READ_GROUPS[role]?.has(group) || false;
  }
  if (role === 'technician') return ['sessions','machines','zones','network','firmware'].includes(group);
  if (role === 'collector') return method === 'POST' && group === 'collections';
  if (role === 'seller') return method === 'POST' && pathname === '/api/admin/vouchers/generate';
  return false;
}
function machineAuth(req, res) {
  const hardwareId = cleanText(req.headers['x-vendo-device'], 80);
  const token = bearer(req);
  const machine = hardwareId && token && db.prepare('SELECT * FROM machines WHERE hardware_id=? AND token_hash=? AND enabled=1').get(hardwareId, sha(token));
  if (!machine) { json(res, 401, { error: 'Device authentication failed' }); return null; }
  return machine;
}
function publicSession(id, token, res) {
  const row = db.prepare('SELECT * FROM coin_sessions WHERE id=?').get(id);
  if (!row || !matchesHash(token, row.public_token_hash)) { json(res, 404, { error: 'Coin session not found' }); return null; }
  return row;
}
function awardLoyalty(zone,mac,amountCentavos,reference,reason='WiFi purchase'){
  const identity=db.prepare('SELECT id FROM device_identities WHERE zone_id=? AND last_mac=?').get(zone,mac),points=Math.floor(Number(amountCentavos||0)/1000);
  if(identity&&points>0)db.prepare('INSERT OR IGNORE INTO loyalty_ledger(identity_id,points,reason,reference) VALUES(?,?,?,?)').run(identity.id,points,reason,`LOYALTY-${reference}`);
}
function sessionView(row) {
  const credit = coinCredit(row.zone_id, Number(row.amount_centavos), row.machine_id);
  return {
    id: row.id,
    machine_id: row.machine_id,
    status: row.status,
    amount_centavos: Number(row.amount_centavos),
    credited_seconds: row.status === 'completed' ? Number(row.credited_seconds) : credit.seconds,
    lease_expires_at: row.lease_expires_at,
    seconds_left: row.status === 'open' ? Math.max(0, Math.ceil((Date.parse(row.lease_expires_at) - Date.now()) / 1000)) : 0
  };
}
function completeSession(row, allowExpired = false) {
  if (row.status === 'completed') return { session: row, access: accessState(row.zone_id, row.client_mac) };
  if (row.status !== 'open' || (!allowExpired && Date.parse(row.lease_expires_at) <= Date.now())) throw Object.assign(new Error('Coin session is no longer active'), { status: 409 });
  const credit = coinCredit(row.zone_id, Number(row.amount_centavos), row.machine_id);
  if (credit.seconds <= 0) throw Object.assign(new Error('No valid coin credit was received'), { status: 409 });
  db.exec('BEGIN IMMEDIATE');
  try {
    const fresh = db.prepare('SELECT * FROM coin_sessions WHERE id=?').get(row.id);
    if (fresh.status === 'completed') { db.exec('COMMIT'); return { session: fresh, access: accessState(fresh.zone_id, fresh.client_mac) }; }
    db.prepare(`UPDATE coin_sessions SET status='completed',credited_seconds=?,completed_at=? WHERE id=? AND status='open'`).run(credit.seconds, nowIso(), row.id);
    const access = grantAccess(row.zone_id, row.client_mac, credit.seconds, credit.rate_limit, row.client_ip, row.machine_id);
    db.prepare(`INSERT OR IGNORE INTO sales(machine_id,zone_id,client_mac,method,amount_centavos,credited_seconds,session_id,reference)
      VALUES(?,?,?,'coin',?,?,?,?)`).run(row.machine_id, row.zone_id, row.client_mac, row.amount_centavos, credit.seconds, row.id, `COIN-${row.id}`);
    awardLoyalty(row.zone_id,row.client_mac,row.amount_centavos,`COIN-${row.id}`,'Coin session');
    db.exec('COMMIT');
    event('info', 'coin.completed', `Coin session ${row.id} credited`, { machine_id: row.machine_id, amount_centavos: row.amount_centavos, seconds: credit.seconds });
    publishCoinSession(row.id);
    return { session: db.prepare('SELECT * FROM coin_sessions WHERE id=?').get(row.id), access };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

const loginAttempts = new Map();
function loginAllowed(ip) {
  const now = Date.now(); const prior = (loginAttempts.get(ip) || []).filter(t => now - t < 10 * 60_000);
  loginAttempts.set(ip, prior); return prior.length < 8;
}
function loginFailed(ip) { const prior = loginAttempts.get(ip) || []; prior.push(Date.now()); loginAttempts.set(ip, prior); }

const staticFileCache = new Map();
const PORTAL_ASSET_SPECS = {
  logo: { setting: 'portal_logo_url', types: { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp' }, limit: 2 * 1024 * 1024 },
  banner: { setting: 'portal_banner_url', types: { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg', 'image/webp': 'webp' }, limit: 5 * 1024 * 1024 },
  'insert-sound': { setting: 'portal_insert_sound_url', types: { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3' }, limit: 8 * 1024 * 1024 },
  'coin-sound': { setting: 'portal_coin_sound_url', types: { 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3' }, limit: 3 * 1024 * 1024 }
};
function validPortalAsset(data, extension) {
  if (extension === 'png') return data.length > 8 && data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (extension === 'jpg') return data.length > 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
  if (extension === 'webp') return data.length > 12 && data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP';
  if (extension === 'mp3') return data.length > 3 && (data.subarray(0, 3).toString() === 'ID3' || (data[0] === 0xff && (data[1] & 0xe0) === 0xe0));
  return false;
}
function sendFile(req, res, file, { litePortal = false } = {}) {
  if (!fs.existsSync(file)) return json(res, 404, { error: 'Not found' });
  const stat = fs.statSync(file); if (!stat.isFile()) return json(res, 404, { error: 'Not found' });
  const ext = path.extname(file).toLowerCase();
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon', '.mp3': 'audio/mpeg' };
  const etag = `"${stat.size.toString(16)}-${Math.trunc(stat.mtimeMs).toString(16)}${litePortal ? '-lite' : ''}"`;
  const requestUrl = new URL(req.url, 'http://localhost');
  const versioned = requestUrl.searchParams.has('v') || requestUrl.pathname.startsWith('/assets/defaults/') || requestUrl.pathname.startsWith('/assets/uploads/');
  const cacheControl = ext === '.html' ? 'no-cache' : versioned ? 'public, max-age=31536000, immutable' : 'public, max-age=3600';
  if (req.headers['if-none-match'] === etag) { res.writeHead(304, { etag, 'cache-control': cacheControl }); return res.end(); }
  const accepts = String(req.headers['accept-encoding'] || ''); const compressible = ['.html','.css','.js','.svg'].includes(ext) && stat.size > 1024;
  const encoding = compressible && /\bbr\b/.test(accepts) ? 'br' : compressible && /\bgzip\b/.test(accepts) ? 'gzip' : '';
  const cacheKey = `${file}:${etag}:${encoding}`; let data = staticFileCache.get(cacheKey);
  if (!data) {
    let source = fs.readFileSync(file);
    if (litePortal) {
      const html = source.toString().replace(/^[ \t]*<link rel="stylesheet" href="\/assets\/portal-(?!lite\.css)[^"]+">\r?\n/gm, '')
        .replace('portal-page promo-portal', 'portal-page portal-lite-mode')
        .replace('>--:--:--</div>', '>00:00:00:00</div>');
      source = Buffer.from(html);
    }
    data = encoding === 'br' ? zlib.brotliCompressSync(source, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4 } }) : encoding === 'gzip' ? zlib.gzipSync(source, { level: 6 }) : source;
    staticFileCache.set(cacheKey, data);
  }
  const headers = { 'content-type': types[ext] || 'application/octet-stream', 'content-length': data.length, 'cache-control': cacheControl, etag };
  if (encoding) { headers['content-encoding'] = encoding; headers.vary = 'Accept-Encoding'; }
  res.writeHead(200, headers); res.end(data);
}

async function route(req, res) {
  cleanup();
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);
  const method = req.method || 'GET';

  if (method === 'POST' && pathname === '/api/webhooks/paymongo') {
    const config=paymentConfig();
    const raw = await readRawBody(req, 256 * 1024);
    if (!paymongoSignatureValid(req, raw,config)) return json(res, 401, { error: 'Invalid webhook signature' });
    let envelope;
    try { envelope = JSON.parse(raw.toString('utf8')); } catch { return json(res,400,{error:'Invalid webhook payload'}); }
    const eventData = envelope?.data || {}, eventType = cleanText(eventData.attributes?.type,100);
    if (eventType !== 'checkout_session.payment.paid') return json(res,200,{received:true,ignored:true});
    const eventId = cleanText(eventData.id,100), session = eventData.attributes?.data;
    if (!eventId || !session?.id || !session?.attributes) return json(res,400,{error:'Incomplete payment event'});
    try { fulfillPaymongoSession(session,eventId); }
    catch (error) { console.error('PayMongo fulfillment error:',error.message); return json(res,500,{error:'Payment fulfillment will be retried'}); }
    event('info','payment.paymongo_paid','PayMongo checkout paid and voucher fulfilled',{order_id:session.attributes.reference_number,event_id:eventId});
    return json(res,200,{received:true});
  }

  if (method === 'GET' && pathname === '/health') return json(res, 200, { ok: true, service: 'debian-vendoos', time: nowIso() });
  if (method === 'GET' && pathname === '/' && url.hostname === '10.0.0.1') {
    res.writeHead(302, { location: '/portal', 'cache-control': 'no-store' });
    return res.end();
  }
  if (method === 'GET' && ['/generate_204','/gen_204','/hotspot-detect.html','/ncsi.txt','/connecttest.txt'].includes(pathname)) {
    const mac = resolveMac(req); const active = mac && accessState(requestZone(req).id, mac).status === 'active';
    if (!active) { res.writeHead(302, { location: PORTAL_URL, 'cache-control': 'no-store' }); return res.end(); }
    if (pathname === '/ncsi.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('Microsoft NCSI'); }
    if (pathname === '/connecttest.txt') { res.writeHead(200, { 'content-type': 'text/plain' }); return res.end('Microsoft Connect Test'); }
    res.writeHead(['/generate_204','/gen_204'].includes(pathname) ? 204 : 200, { 'content-type': 'text/html' }); return res.end(pathname === '/hotspot-detect.html' ? '<HTML><HEAD><TITLE>Success</TITLE></HEAD><BODY>Success</BODY></HTML>' : '');
  }
  if (method === 'GET' && pathname === '/api/captive') {
    const mac = resolveMac(req); const state = mac ? accessState(requestZone(req).id, mac) : { status: 'none', remaining_seconds: 0 };
    return json(res, 200, { captive: state.status !== 'active', 'user-portal-url': PORTAL_URL, 'venue-info-url': PORTAL_URL, 'seconds-remaining': state.remaining_seconds, 'can-extend-session': true });
  }
  if (method === 'GET' && (pathname === '/' || pathname === '/portal')) {
    const litePortal = db.prepare("SELECT value FROM settings WHERE key='portal_theme'").get()?.value === 'lite';
    return sendFile(req, res, path.join(PUBLIC_DIR, 'portal.html'), { litePortal });
  }
  if (method === 'GET' && pathname === '/admin') return sendFile(req, res, path.join(PUBLIC_DIR, 'admin.html'));
  if (method === 'GET' && pathname.startsWith('/assets/')) {
    const relative = pathname.slice('/assets/'.length);
    const uploadRelative=relative.startsWith('uploads/')?relative.slice('uploads/'.length):'';
    const root=uploadRelative?PORTAL_UPLOAD_DIR:PUBLIC_DIR;
    const file=path.resolve(root,uploadRelative||relative);
    if (!file.startsWith(root + path.sep)) return json(res, 400, { error: 'Invalid asset path' });
    return sendFile(req, res, file);
  }

  if (method === 'GET' && pathname === '/api/public/branding') return json(res,200,publicBranding());
  if (method === 'GET' && pathname === '/api/public/context') {
    const mac = requireMac(req, res); if (!mac) return;
    const currentZone = requestZone(req);
    const identity = identifyDevice(req, currentZone, mac);
    res.setHeader('set-cookie', `vendo_device_key=${encodeURIComponent(identity.key)}; Max-Age=31536000; Path=/; HttpOnly; SameSite=Lax`);
    db.prepare(`UPDATE access_entitlements SET ip_address=?,last_seen_at=?,updated_at=? WHERE zone_id=? AND client_mac=?`).run(clientIp(req), nowIso(), nowIso(), currentZone.id, mac);
    autoReconnectAccess(currentZone.id, mac);
    const zones = db.prepare('SELECT id,code,name,gateway FROM zones WHERE enabled=1 ORDER BY name').all();
    const machines = db.prepare(`SELECT id,name,zone_id,last_seen_at FROM machines WHERE enabled=1 AND zone_id=? AND last_seen_at>? ORDER BY name`).all(currentZone.id, onlineCutoff());
    const machine_rates = Object.fromEntries(machines.map(machine => [machine.id, ratesFor(machine.zone_id, machine.id)]));
    const settings = publicBranding();
    const selectedMachine = machines.find(machine => machine.id === Number(currentZone.default_machine_id)) || (machines.length === 1 ? machines[0] : null);
    const campaigns=settings.portal_theme === 'lite' ? [] : db.prepare(`SELECT id,name,headline,body,image_url,target_url,sponsor FROM ad_campaigns WHERE enabled=1 AND (zone_id IS NULL OR zone_id=?) AND (starts_at IS NULL OR starts_at<=?) AND (ends_at IS NULL OR ends_at>?) ORDER BY id DESC LIMIT 3`).all(currentZone.id,nowIso(),nowIso());
    const loyaltyPoints=db.prepare('SELECT COALESCE(SUM(points),0) AS points FROM loyalty_ledger WHERE identity_id=?').get(identity.identity_id)?.points||0;
    return json(res, 200, { portal_url: PORTAL_URL, client_mac: mac, client_ip: clientIp(req), device_key: identity.key, identity_id: identity.identity_id, restored_private_mac: identity.restored, identity_conflict: identity.conflict, previous_mac: identity.previous_mac, access: accessState(currentZone.id, mac), zone: currentZone, zones, machines, selected_machine_id: selectedMachine?.id || null, rates: ratesFor(currentZone.id), machine_rates, settings, lease_seconds: COIN_LEASE_SECONDS, payments:{enabled:paymentConfig().enabled}, campaigns, loyalty:{points:Number(loyaltyPoints),reward_threshold:100,reward_seconds:1800} });
  }
  if (method === 'POST' && pathname === '/api/public/payments/checkout') {
    const gateway=paymentConfig();if (!gateway.enabled) return json(res,503,{error:'Online checkout is not configured for this VendoOS server yet'});
    const mac=requireMac(req,res);if(!mac)return;
    const zone=requestZone(req),deviceKey=suppliedDeviceKey(req),identity=deviceKey&&db.prepare('SELECT id FROM device_identities WHERE token_hash=? AND zone_id=? AND last_mac=?').get(sha(deviceKey),zone.id,mac);
    if(accessState(zone.id,mac).status==='blocked')return json(res,403,{error:'This device is blocked'});
    const body=await readBody(req),rateId=int(body.rate_id,0,1),machineId=int(body.machine_id,0,1),machine=machineId&&db.prepare('SELECT id,zone_id,enabled FROM machines WHERE id=?').get(machineId),availableRates=machine&&Number(machine.zone_id)===Number(zone.id)&&machine.enabled?ratesFor(zone.id,machineId):ratesFor(zone.id,null),rate=availableRates.find(item=>Number(item.id)===rateId);
    if(!rate)return json(res,404,{error:'WiFi plan is unavailable'});
    db.prepare("UPDATE checkout_orders SET status='expired',updated_at=? WHERE status IN ('creating','pending') AND expires_at<=?").run(nowIso(),nowIso());
    const recent=db.prepare("SELECT COUNT(*) n FROM checkout_orders WHERE zone_id=? AND client_mac=? AND created_at>=datetime('now','-1 hour')").get(zone.id,mac).n;
    const pending=db.prepare("SELECT COUNT(*) n FROM checkout_orders WHERE zone_id=? AND client_mac=? AND status IN ('creating','pending')").get(zone.id,mac).n;
    if(recent>=6||pending>=2)return json(res,429,{error:'Too many checkout attempts. Please wait a few minutes and try again.'});
    const id=crypto.randomBytes(12).toString('hex'),token=randomToken();
    db.prepare(`INSERT INTO checkout_orders(id,token_hash,zone_id,client_mac,identity_id,rate_id,rate_name,amount_centavos,duration_seconds,rate_limit,status,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,'creating',?)`).run(id,sha(token),zone.id,mac,identity?.id||null,rate.id,rate.name,rate.price_centavos,rate.duration_seconds,rate.rate_limit,futureIso(30*60));
    const successUrl=`${gateway.returnBaseUrl}/portal?payment_order=${encodeURIComponent(id)}`;
    const cancelUrl=`${gateway.returnBaseUrl}/portal?payment_cancelled=1`;
    let provider;
    try {
      const response=await fetch('https://api.paymongo.com/v2/checkout_sessions',{method:'POST',headers:{authorization:`Basic ${Buffer.from(`${gateway.secretKey}:`).toString('base64')}`,'content-type':'application/json'},body:JSON.stringify({data:{attributes:{line_items:[{name:`WiFi voucher — ${rate.name}`,amount:Number(rate.price_centavos),currency:'PHP',quantity:1}],payment_method_types:['gcash','paymaya'],success_url:successUrl,cancel_url:cancelUrl,reference_number:id,description:`WiFi access voucher: ${rate.name}`}}}),signal:AbortSignal.timeout(12000)});
      provider=await response.json();if(!response.ok)throw new Error(`PayMongo returned ${response.status}`);
    } catch(error) { db.prepare("UPDATE checkout_orders SET status='failed',updated_at=? WHERE id=?").run(nowIso(),id);console.error('PayMongo checkout error:',error.message);return json(res,502,{error:'Could not start checkout. Please try again.'}); }
    const session=provider?.data,checkoutUrl=session?.attributes?.checkout_url;
    if(!session?.id||!checkoutUrl||!/^https:\/\/checkout\.paymongo\.com\//i.test(checkoutUrl)) { db.prepare("UPDATE checkout_orders SET status='failed',updated_at=? WHERE id=?").run(nowIso(),id);return json(res,502,{error:'Payment provider did not return a valid checkout page'}); }
    db.prepare("UPDATE checkout_orders SET status='pending',checkout_session_id=?,updated_at=? WHERE id=?").run(session.id,nowIso(),id);
    return json(res,201,{checkout_url:checkoutUrl,order_id:id,token,expires_at:futureIso(30*60)});
  }
  const paymentOrderMatch=pathname.match(/^\/api\/public\/payments\/orders\/([a-f0-9]{24})$/);
  if(method==='GET'&&paymentOrderMatch){
    const token=cleanText(url.searchParams.get('token'),128),order=db.prepare(`SELECT o.id,o.status,o.rate_name,o.amount_centavos,o.duration_seconds,o.voucher_code,o.expires_at,v.status voucher_status,v.used_by_mac,o.client_mac FROM checkout_orders o LEFT JOIN vouchers v ON v.id=o.voucher_id WHERE o.id=? AND o.token_hash=?`).get(paymentOrderMatch[1],sha(token));
    if(!order)return json(res,404,{error:'Payment order not found'});
    if(order.status==='pending'&&Date.parse(order.expires_at)<=Date.now()){db.prepare("UPDATE checkout_orders SET status='expired',updated_at=? WHERE id=? AND status='pending'").run(nowIso(),order.id);order.status='expired'}
    const status=order.status==='fulfilled'&&order.voucher_status==='used'&&order.used_by_mac===order.client_mac?'redeemed':order.status;
    return json(res,200,{order:{id:order.id,status,rate_name:order.rate_name,amount_centavos:order.amount_centavos,duration_seconds:order.duration_seconds,voucher_code:order.status==='fulfilled'&&order.voucher_status==='unused'?order.voucher_code:null,expires_at:order.expires_at}});
  }
  if(method==='POST'&&(pathname==='/api/public/ads/impression'||pathname==='/api/public/ads/click')){
    const mac=requireMac(req,res);if(!mac)return;const zone=requestZone(req),body=await readBody(req),id=int(body.campaign_id,0,1);if(!id)return json(res,400,{error:'Campaign is required'});
    const active=db.prepare(`SELECT id FROM ad_campaigns WHERE id=? AND enabled=1 AND (zone_id IS NULL OR zone_id=?) AND (starts_at IS NULL OR starts_at<=?) AND (ends_at IS NULL OR ends_at>?)`).get(id,zone.id,nowIso(),nowIso());if(!active)return json(res,404,{error:'Campaign is not active'});
    const field=pathname.endsWith('/click')?'clicks':'impressions';db.prepare(`UPDATE ad_campaigns SET ${field}=${field}+1 WHERE id=?`).run(id);return json(res,200,{ok:true});
  }
  if(method==='GET'&&pathname==='/api/public/loyalty'){
    const mac=requireMac(req,res);if(!mac)return;const key=suppliedDeviceKey(req),identity=key&&db.prepare('SELECT id FROM device_identities WHERE token_hash=?').get(sha(key));if(!identity)return json(res,401,{error:'Device identity is unavailable'});
    const ledger=db.prepare('SELECT points,reason,created_at FROM loyalty_ledger WHERE identity_id=? ORDER BY id DESC LIMIT 25').all(identity.id),points=db.prepare('SELECT COALESCE(SUM(points),0) points FROM loyalty_ledger WHERE identity_id=?').get(identity.id).points;return json(res,200,{points,ledger,reward_threshold:100});
  }
  if(method==='POST'&&pathname==='/api/public/loyalty/redeem'){
    const mac=requireMac(req,res);if(!mac)return;const zone=requestZone(req),key=suppliedDeviceKey(req),identity=key&&db.prepare('SELECT id FROM device_identities WHERE token_hash=? AND zone_id=? AND last_mac=?').get(sha(key),zone.id,mac);if(!identity)return json(res,401,{error:'Refresh the portal before redeeming rewards'});
    const points=Number(db.prepare('SELECT COALESCE(SUM(points),0) points FROM loyalty_ledger WHERE identity_id=?').get(identity.id).points);if(points<100)return json(res,409,{error:'You need 100 points to claim 30 minutes of WiFi'});
    const reference=`REWARD-${crypto.randomBytes(12).toString('hex')}`;db.exec('BEGIN IMMEDIATE');try{const current=Number(db.prepare('SELECT COALESCE(SUM(points),0) points FROM loyalty_ledger WHERE identity_id=?').get(identity.id).points);if(current<100)throw Object.assign(new Error('You need 100 points to claim 30 minutes of WiFi'),{status:409});db.prepare('INSERT INTO loyalty_ledger(identity_id,points,reason,reference) VALUES(?,-100,?,?)').run(identity.id,'30-minute WiFi reward',reference);const access=grantAccess(zone.id,mac,1800,'5M/5M',clientIp(req));db.prepare(`INSERT INTO sales(zone_id,client_mac,method,amount_centavos,credited_seconds,reference) VALUES(?,?,'manual',0,?,?)`).run(zone.id,mac,1800,reference);db.exec('COMMIT');return json(res,200,{access,points:current-100});}catch(error){db.exec('ROLLBACK');throw error;}
  }
  if(pathname.startsWith('/api/admin/payments')||pathname.startsWith('/api/admin/campaigns')){const admin=adminAuth(req,res);if(!admin)return;if(!adminCan(admin,method,pathname))return json(res,403,{error:'This role cannot manage payments or advertising'});}
  if(method==='GET'&&pathname==='/api/admin/payments/status'){
    const orders=db.prepare(`SELECT status,COUNT(*) count,COALESCE(SUM(amount_centavos),0) amount_centavos FROM checkout_orders GROUP BY status`).all();
    let config;try{config=paymentConfig()}catch(error){return json(res,200,{enabled:false,configured:false,error:error.message,mode:'unset',return_base_url:'',source:'unavailable',orders})}
    const envManaged=Boolean(process.env.PAYMONGO_SECRET_KEY||process.env.PAYMONGO_WEBHOOK_SECRET||process.env.PAYMONGO_RETURN_BASE_URL),secretKey=config.secretKey;
    return json(res,200,{enabled:config.enabled,configured:config.configured,mode:config.mode,return_base_url:config.returnBaseUrl,webhook_path:'/api/webhooks/paymongo',source:config.source,env_managed:envManaged,secret_hint:secretKey?`${config.mode==='live'?'sk_live':config.mode==='test'?'sk_test':'key'}_••••${secretKey.slice(-4)}`:'',webhook_configured:config.configuredWebhook,updated_at:config.updatedAt,error:config.error||'',orders});
  }
  if(method==='POST'&&pathname==='/api/admin/payments/config'){
    if(process.env.PAYMONGO_SECRET_KEY||process.env.PAYMONGO_WEBHOOK_SECRET||process.env.PAYMONGO_RETURN_BASE_URL)return json(res,409,{error:'PayMongo is managed by server environment variables; edit /etc/debian-vendoos/vendo.env instead.'});
    const body=await readBody(req),prior=paymentConfig();
    if(prior.error&&(!String(body.secret_key||'').trim()||!String(body.webhook_secret||'').trim()))return json(res,409,{error:`${prior.error}. Enter both PayMongo secrets to replace the encrypted configuration.`});
    let secretKey=body.clear_secret_key?'':(String(body.secret_key||'').trim()||prior.secretKey),webhookSecret=body.clear_webhook_secret?'':(String(body.webhook_secret||'').trim()||prior.webhookSecret);
    const returnBaseUrl=String(body.return_base_url??prior.returnBaseUrl).trim().replace(/\/+$/,'');
    if(secretKey&&!/^sk_(test|live)_[A-Za-z0-9_-]{8,}$/i.test(secretKey))return json(res,400,{error:'Secret key must be a valid PayMongo test or live key'});
    if(webhookSecret&&webhookSecret.length<16)return json(res,400,{error:'Webhook signing secret is too short'});
    if(returnBaseUrl){let parsed;try{parsed=new URL(returnBaseUrl)}catch{return json(res,400,{error:'Return URL must be a complete HTTPS URL'})}if(parsed.protocol!=='https:'||parsed.username||parsed.password||parsed.search||parsed.hash||parsed.hostname==='localhost'||!parsed.hostname.includes('.'))return json(res,400,{error:'Return URL must be a public HTTPS origin without credentials, query, or fragment'});}
    if((secretKey||webhookSecret)&&!returnBaseUrl)return json(res,400,{error:'Set a public HTTPS return URL before configuring payment credentials'});
    try{
      const secretCipher=secretKey?encryptPaymentSecret(secretKey):'',webhookCipher=webhookSecret?encryptPaymentSecret(webhookSecret):'';
      const enabled=Object.hasOwn(body,'enabled')?Boolean(body.enabled):prior.enabled;
      db.prepare(`INSERT INTO payment_gateway_config(id,secret_key_cipher,webhook_secret_cipher,return_base_url,enabled,updated_at) VALUES(1,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET secret_key_cipher=excluded.secret_key_cipher,webhook_secret_cipher=excluded.webhook_secret_cipher,return_base_url=excluded.return_base_url,enabled=excluded.enabled,updated_at=excluded.updated_at`).run(secretCipher,webhookCipher,returnBaseUrl,enabled?1:0,nowIso());
    }catch(error){console.error('Unable to save PayMongo configuration:',error.message);return json(res,500,{error:'Could not securely save PayMongo settings'});}
    event('info','payment.gateway_configured','PayMongo gateway settings updated',{mode:secretKey.startsWith('sk_live_')?'live':secretKey.startsWith('sk_test_')?'test':'unset',enabled:Boolean(secretKey&&webhookSecret&&returnBaseUrl)});
    const saved=paymentConfig();return json(res,200,{ok:true,enabled:saved.enabled,configured:saved.configured,mode:saved.mode,return_base_url:saved.returnBaseUrl,source:saved.source,webhook_configured:saved.configuredWebhook});
  }
  if(method==='GET'&&pathname==='/api/admin/campaigns')return json(res,200,db.prepare(`SELECT c.*,z.name zone_name FROM ad_campaigns c LEFT JOIN zones z ON z.id=c.zone_id ORDER BY c.id DESC`).all());
  if(method==='POST'&&pathname==='/api/admin/campaigns'){
    const body=await readBody(req),name=cleanText(body.name,80),headline=cleanText(body.headline,120),image=cleanText(body.image_url,500),target=cleanText(body.target_url,500),bodyText=cleanText(body.body,300),sponsor=cleanText(body.sponsor,80),zoneId=body.zone_id?int(body.zone_id,0,1):null,starts=cleanText(body.starts_at,40),ends=cleanText(body.ends_at,40);
    if(!name||!headline)return json(res,400,{error:'Campaign name and headline are required'});
    if(image&&!image.startsWith('/assets/'))return json(res,400,{error:'Campaign images must use a local /assets/ URL'});
    if(target&&!/^https:\/\//i.test(target))return json(res,400,{error:'Campaign destination must use HTTPS'});
    if(zoneId&&!db.prepare('SELECT 1 FROM zones WHERE id=? AND enabled=1').get(zoneId))return json(res,400,{error:'Select an active WiFi zone'});
    if(starts&&Number.isNaN(Date.parse(starts))||ends&&Number.isNaN(Date.parse(ends))||starts&&ends&&Date.parse(ends)<=Date.parse(starts))return json(res,400,{error:'Campaign schedule dates are invalid'});
    const result=db.prepare(`INSERT INTO ad_campaigns(name,headline,body,image_url,target_url,sponsor,zone_id,starts_at,ends_at,enabled) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(name,headline,bodyText,image,target,sponsor,zoneId,starts||null,ends||null,body.enabled===false?0:1);
    event('info','ads.campaign_created',`Ad campaign created: ${name}`,{campaign_id:Number(result.lastInsertRowid)});return json(res,201,{ok:true,id:Number(result.lastInsertRowid)});
  }
  const campaignMatch=pathname.match(/^\/api\/admin\/campaigns\/(\d+)$/);
  if(campaignMatch&&method==='PATCH'){
    const id=Number(campaignMatch[1]),old=db.prepare('SELECT * FROM ad_campaigns WHERE id=?').get(id);if(!old)return json(res,404,{error:'Campaign not found'});
    const body=await readBody(req),value=(key,max,fallback)=>Object.hasOwn(body,key)?cleanText(body[key],max):fallback;
    const name=value('name',80,old.name),headline=value('headline',120,old.headline),image=value('image_url',500,old.image_url),target=value('target_url',500,old.target_url),bodyText=value('body',300,old.body),sponsor=value('sponsor',80,old.sponsor),zoneId=Object.hasOwn(body,'zone_id')?(body.zone_id?int(body.zone_id,0,1):null):old.zone_id,starts=Object.hasOwn(body,'starts_at')?cleanText(body.starts_at,40):old.starts_at,ends=Object.hasOwn(body,'ends_at')?cleanText(body.ends_at,40):old.ends_at;
    if(!name||!headline||image&&!image.startsWith('/assets/')||target&&!/^https:\/\//i.test(target))return json(res,400,{error:'Campaign fields are invalid; image must be local and destination HTTPS'});
    if((starts&&Number.isNaN(Date.parse(starts)))||(ends&&Number.isNaN(Date.parse(ends)))||(starts&&ends&&Date.parse(ends)<=Date.parse(starts)))return json(res,400,{error:'Campaign schedule dates are invalid'});
    db.prepare(`UPDATE ad_campaigns SET name=?,headline=?,body=?,image_url=?,target_url=?,sponsor=?,zone_id=?,starts_at=?,ends_at=?,enabled=?,updated_at=? WHERE id=?`).run(name,headline,bodyText,image,target,sponsor,zoneId,starts||null,ends||null,Object.hasOwn(body,'enabled')?(body.enabled?1:0):old.enabled,nowIso(),id);return json(res,200,{ok:true});
  }
  if(campaignMatch&&method==='DELETE'){const id=Number(campaignMatch[1]);db.prepare('DELETE FROM ad_campaigns WHERE id=?').run(id);return json(res,200,{ok:true});}
  if (method === 'GET' && pathname === '/api/public/access') {
    const mac = requireMac(req, res); if (!mac) return;
    return json(res, 200, accessState(requestZone(req).id, mac));
  }
  if (method === 'POST' && pathname === '/api/public/sessions') {
    const mac = requireMac(req, res); if (!mac) return;
    if (accessState(requestZone(req).id, mac).status === 'blocked') return json(res, 403, { error: 'This device is blocked' });
    const body = await readBody(req); const machineId = int(body.machine_id, 0, 1);
    const machine = db.prepare('SELECT * FROM machines WHERE id=? AND enabled=1 AND last_seen_at>?').get(machineId, onlineCutoff());
    if (!machine) return json(res, 409, { error: 'Selected coin station is offline' });
    const occupied = db.prepare(`SELECT id,client_mac,lease_expires_at FROM coin_sessions WHERE machine_id=? AND status='open' AND lease_expires_at>?`).get(machine.id, nowIso());
    if (occupied) return json(res, 409, { error: 'Coin slot is currently in use', available_at: occupied.lease_expires_at });
    const token = randomToken();
    try {
      const result = db.prepare(`INSERT INTO coin_sessions(public_token_hash,machine_id,zone_id,client_mac,client_ip,lease_expires_at)
        VALUES(?,?,?,?,?,?)`).run(sha(token), machine.id, machine.zone_id, mac, clientIp(req), futureIso(COIN_LEASE_SECONDS));
      event('info', 'coin.opened', `Coin slot opened at ${machine.name}`, { machine_id: machine.id, client_mac: mac });
      return json(res, 201, { token, ...sessionView(db.prepare('SELECT * FROM coin_sessions WHERE id=?').get(result.lastInsertRowid)) });
    } catch (error) {
      if (String(error.message).includes('UNIQUE')) return json(res, 409, { error: 'Coin slot is currently in use' });
      throw error;
    }
  }
  const publicSessionStreamMatch = pathname.match(/^\/api\/public\/sessions\/(\d+)\/stream$/);
  if (publicSessionStreamMatch && method === 'GET') {
    const row = publicSession(Number(publicSessionStreamMatch[1]), cleanText(url.searchParams.get('token'), 256), res); if (!row) return;
    return openCoinSessionStream(req, res, row);
  }
  const publicSessionMatch = pathname.match(/^\/api\/public\/sessions\/(\d+)(?:\/(complete|cancel))?$/);
  if (publicSessionMatch && ['GET','POST'].includes(method)) {
    const row = publicSession(Number(publicSessionMatch[1]), bearer(req), res); if (!row) return;
    const action = publicSessionMatch[2];
    if (!action && method === 'GET') return json(res, 200, sessionView(row));
    if (action === 'cancel' && method === 'POST') {
      db.prepare(`UPDATE coin_sessions SET status='cancelled' WHERE id=? AND status='open'`).run(row.id);
      publishCoinSession(row.id);
      return json(res, 200, { ok: true });
    }
    if (action === 'complete' && method === 'POST') {
      const result = completeSession(row); return json(res, 200, { session: sessionView(result.session), access: result.access });
    }
  }
  if (method === 'POST' && pathname === '/api/public/access/pause') {
    const mac = requireMac(req, res); if (!mac) return;
    const currentZone = requestZone(req); const state = accessState(currentZone.id, mac);
    if (state.status !== 'active' || state.remaining_seconds <= 0) return json(res, 409, { error: 'No active time to pause' });
    db.prepare(`UPDATE access_entitlements SET status='paused',expires_at=NULL,remaining_seconds=?,auto_reconnect=0,updated_at=? WHERE zone_id=? AND client_mac=?`).run(state.remaining_seconds, nowIso(), currentZone.id, mac);
    return json(res, 200, accessState(currentZone.id, mac));
  }
  if (method === 'POST' && pathname === '/api/public/access/resume') {
    const mac = requireMac(req, res); if (!mac) return;
    const currentZone = requestZone(req); const state = accessState(currentZone.id, mac);
    if (state.status !== 'paused' || state.remaining_seconds <= 0) return json(res, 409, { error: 'No paused time to resume' });
    db.prepare(`UPDATE access_entitlements SET status='active',expires_at=?,remaining_seconds=0,auto_reconnect=0,updated_at=? WHERE zone_id=? AND client_mac=?`).run(futureIso(state.remaining_seconds), nowIso(), currentZone.id, mac);
    return json(res, 200, accessState(currentZone.id, mac));
  }
  if (method === 'POST' && pathname === '/api/public/vouchers/redeem') {
    const mac = requireMac(req, res); if (!mac) return;
    const currentZone = requestZone(req);
    if (accessState(currentZone.id, mac).status === 'blocked') return json(res, 403, { error: 'This device is blocked' });
    const body = await readBody(req); const code = cleanText(body.code, 64).toUpperCase().replace(/\s/g, '');
    const voucher = code && db.prepare(`SELECT * FROM vouchers WHERE code_hash=? AND status='unused' AND (expires_at IS NULL OR expires_at>?)`).get(sha(code), nowIso());
    if (!voucher) { event('warning','voucher.rejected','Voucher redemption rejected',{reason:'invalid_expired_or_used',zone_id:currentZone.id,client_mac:mac}); return json(res, 400, { error: 'Voucher is invalid, expired, or already used' }); }
    db.exec('BEGIN IMMEDIATE');
    try {
      const changed = db.prepare(`UPDATE vouchers SET status='used',used_by_mac=?,used_at=? WHERE id=? AND status='unused'`).run(mac, nowIso(), voucher.id);
      if (!changed.changes) throw Object.assign(new Error('Voucher was already used'), { status: 409 });
      const access = grantAccess(currentZone.id, mac, Number(voucher.duration_seconds), voucher.rate_limit, clientIp(req));
      if(!String(voucher.batch_code).startsWith('PAYMONGO-')){
        db.prepare(`INSERT INTO sales(zone_id,client_mac,method,amount_centavos,credited_seconds,reference) VALUES(?,?,'voucher',?,?,?)`).run(currentZone.id, mac, voucher.price_centavos, voucher.duration_seconds, `VOUCHER-${voucher.id}`);
        awardLoyalty(currentZone.id,mac,voucher.price_centavos,`VOUCHER-${voucher.id}`,'Voucher redeemed');
      }
      db.exec('COMMIT'); return json(res, 200, { ok: true, access });
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  if (method === 'POST' && pathname === '/api/device/provision') {
    const key = String(req.headers['x-provision-key'] || '');
    if (!samePlain(key, PROVISION_KEY)) return json(res, 401, { error: 'Provisioning key is invalid' });
    const body = await readBody(req); const hardwareId = cleanText(body.hardware_id, 80); const name = cleanText(body.name, 80) || `Vendo ${hardwareId.slice(-6)}`;
    if (!/^[A-Za-z0-9._:-]{4,80}$/.test(hardwareId)) return json(res, 400, { error: 'hardware_id is invalid' });
    const token = randomToken(); const detectedZone = requestZone(req);
    const existing = db.prepare('SELECT id,zone_id FROM machines WHERE hardware_id=?').get(hardwareId);
    let id;
    if (existing) {
      db.prepare(`UPDATE machines SET name=?,zone_id=?,token_hash=?,coin_pin=?,enable_pin=?,board=?,device_type=?,enabled=1,config_version=config_version+1,updated_at=? WHERE id=?`)
        .run(name, existing.zone_id || detectedZone.id, sha(token), int(body.coin_pin, 2, 0, 39), int(body.enable_pin, 15, 0, 39), cleanText(body.board, 40) || 'ESP8266', cleanText(body.device_type, 30) || 'coin', nowIso(), existing.id); id = existing.id;
    } else {
      id = db.prepare(`INSERT INTO machines(hardware_id,name,zone_id,token_hash,coin_pin,enable_pin,board,device_type) VALUES(?,?,?,?,?,?,?,?)`)
        .run(hardwareId, name, detectedZone.id, sha(token), int(body.coin_pin, 2, 0, 39), int(body.enable_pin, 15, 0, 39), cleanText(body.board, 40) || 'ESP8266', cleanText(body.device_type, 30) || 'coin').lastInsertRowid;
    }
    const machineZoneId = db.prepare('SELECT zone_id FROM machines WHERE id=?').get(id).zone_id;
    db.prepare('UPDATE zones SET default_machine_id=COALESCE(default_machine_id,?),updated_at=? WHERE id=?').run(id, nowIso(), machineZoneId);
    event('info', 'device.provisioned', `${name} provisioned`, { machine_id: id, hardware_id: hardwareId });
    const machine = db.prepare('SELECT id,name,coin_pin,enable_pin,config_version FROM machines WHERE id=?').get(id);
    return json(res, 200, { token, heartbeat_seconds: Math.ceil(DEVICE_HEARTBEAT_IDLE_MS / 1000), heartbeat_idle_ms: DEVICE_HEARTBEAT_IDLE_MS, heartbeat_active_ms: DEVICE_HEARTBEAT_ACTIVE_MS, heartbeat_jitter_ms: DEVICE_HEARTBEAT_JITTER_MS, api_base: PORTAL_URL.replace(/\/$/, ''), machine });
  }
  if (method === 'POST' && pathname === '/api/device/heartbeat') {
    const machine = machineAuth(req, res); if (!machine) return;
    const body = await readBody(req);
    const now = nowIso(), ackIds = [...new Set((Array.isArray(body.ack_command_ids) ? body.ack_command_ids : []).slice(0, 20).map(id => int(id, 0, 1)).filter(Boolean))];
    if (ackIds.length) db.prepare(`UPDATE hardware_commands SET status='acked',acked_at=? WHERE machine_id=? AND id IN (${ackIds.map(() => '?').join(',')})`).run(now, machine.id, ...ackIds);
    const shouldPersist = ackIds.length || Date.now() - (heartbeatPersistedAt.get(machine.id) || 0) >= DEVICE_HEARTBEAT_PERSIST_MS;
    if (shouldPersist) {
      db.prepare(`UPDATE machines SET last_seen_at=?,ip_address=?,firmware_version=?,last_status_json=?,updated_at=? WHERE id=?`)
        .run(now, clientIp(req), cleanText(body.firmware_version, 40), JSON.stringify({ uptime_seconds: int(body.uptime_seconds, 0, 0), free_heap: int(body.free_heap, 0, 0), rssi: int(body.rssi, 0, -200, 0), coin_slot: body.coin_slot || null }), now, machine.id);
      heartbeatPersistedAt.set(machine.id, Date.now());
    }
    const commands = db.prepare(`SELECT id,command,payload_json FROM hardware_commands WHERE machine_id=? AND status IN ('pending','delivered') ORDER BY id LIMIT 10`).all(machine.id).map(row => ({ id: row.id, command: row.command, payload: JSON.parse(row.payload_json) }));
    if (commands.length) db.prepare(`UPDATE hardware_commands SET status='delivered',delivered_at=? WHERE status='pending' AND id IN (${commands.map(() => '?').join(',')})`).run(now, ...commands.map(command => command.id));
    const active = db.prepare(`SELECT id,client_mac,lease_expires_at FROM coin_sessions WHERE machine_id=? AND status='open' AND lease_expires_at>?`).get(machine.id, nowIso());
    return json(res, 200, { ok: true, server_time: now, coin_slot_enabled: Boolean(active), active_session_id: active?.id || null, config: { coin_pin: machine.coin_pin, enable_pin: machine.enable_pin, version: machine.config_version, heartbeat_idle_ms: DEVICE_HEARTBEAT_IDLE_MS, heartbeat_active_ms: DEVICE_HEARTBEAT_ACTIVE_MS, heartbeat_jitter_ms: DEVICE_HEARTBEAT_JITTER_MS }, commands });
  }
  if (method === 'POST' && pathname === '/api/device/pulse') {
    const machine = machineAuth(req, res); if (!machine) return;
    const body = await readBody(req); const pulseId = cleanText(body.pulse_id, 100); const value = int(body.value_centavos, 0, 1, 100000);
    if (!pulseId || !value) return json(res, 400, { error: 'pulse_id and value_centavos are required' });
    const session = db.prepare(`SELECT * FROM coin_sessions WHERE machine_id=? AND status='open' AND lease_expires_at>?`).get(machine.id, nowIso());
    if (!session) return json(res, 409, { error: 'Coin slot is disabled; no active customer session' });
    try {
      db.exec('BEGIN IMMEDIATE');
      db.prepare(`INSERT INTO coin_pulses(machine_id,session_id,pulse_id,value_centavos) VALUES(?,?,?,?)`).run(machine.id, session.id, pulseId, value);
      db.prepare(`UPDATE coin_sessions SET amount_centavos=amount_centavos+?,lease_expires_at=? WHERE id=? AND status='open'`).run(value, futureIso(COIN_LEASE_SECONDS), session.id);
      db.prepare(`UPDATE machines SET cash_on_hand_centavos=cash_on_hand_centavos+?,lifetime_coin_centavos=lifetime_coin_centavos+?,last_coin_at=?,updated_at=? WHERE id=?`).run(value, value, nowIso(), nowIso(), machine.id);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      if (!String(error.message).includes('UNIQUE')) throw error;
    }
    publishCoinSession(session.id);
    return json(res, 200, sessionView(db.prepare('SELECT * FROM coin_sessions WHERE id=?').get(session.id)));
  }
  if (method === 'POST' && pathname === '/api/device/complete') {
    const machine = machineAuth(req, res); if (!machine) return;
    const body = await readBody(req); const row = db.prepare('SELECT * FROM coin_sessions WHERE id=? AND machine_id=?').get(int(body.session_id, 0), machine.id);
    if (!row) return json(res, 404, { error: 'Session not found' });
    const result = completeSession(row); return json(res, 200, { session: sessionView(result.session), access: result.access });
  }

  if (method === 'POST' && pathname === '/api/admin/login') {
    const ip = clientIp(req); if (!loginAllowed(ip)) return json(res, 429, { error: 'Too many attempts; try again later' });
    const body = await readBody(req);
    const username = cleanText(body.username, 64).toLowerCase();
    const user = username && db.prepare('SELECT * FROM admin_users WHERE username=? AND enabled=1').get(username);
    if (!user || !verifyPassword(body.password || '', user)) { loginFailed(ip); return json(res, 401, { error: 'Unable to authenticate' }); }
    loginAttempts.delete(ip); const token = randomToken();
    db.prepare('INSERT INTO admin_sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(sha(token), user.id, futureIso(12 * 3600));
    event('info', 'auth.login', `${user.username} signed in`, { user_id: user.id, role: normalizedAdminRole(user.role), ip });
    return json(res, 200, { token, expires_at: futureIso(12 * 3600), user: adminRoleProfile({ ...user, user_id: user.id }) });
  }
  if (method === 'POST' && pathname === '/api/admin/logout') {
    if (!adminAuth(req, res)) return; db.prepare('DELETE FROM admin_sessions WHERE token_hash=?').run(sha(bearer(req))); return json(res, 200, { ok: true });
  }
  let currentAdmin = null;
  if (pathname.startsWith('/api/admin/')) {
    currentAdmin = adminAuth(req, res); if (!currentAdmin) return;
    if (!adminCan(currentAdmin, method, pathname)) return json(res, 403, { error: `Role ${normalizedAdminRole(currentAdmin.role)} is not allowed to perform this action`, role: normalizedAdminRole(currentAdmin.role) });
  }

  if (method === 'GET' && pathname === '/api/admin/me') return json(res, 200, { user: adminRoleProfile(currentAdmin) });
  if (method === 'GET' && pathname === '/api/admin/capacity') return json(res, 200, capacitySnapshot());
  if (method === 'GET' && pathname === '/api/admin/users') {
    return json(res, 200, db.prepare(`SELECT id,username,role,enabled,created_at,updated_at FROM admin_users ORDER BY username COLLATE NOCASE`).all().map(user => ({ ...user, role: normalizedAdminRole(user.role), enabled: Boolean(user.enabled) })));
  }
  if (method === 'POST' && pathname === '/api/admin/users') {
    const body = await readBody(req); const username = cleanText(body.username, 64).toLowerCase(); const password = String(body.password || ''); const role = normalizedAdminRole(body.role);
    if (!/^[a-z0-9._-]{3,64}$/.test(username)) return json(res, 400, { error: 'Username must be 3–64 characters using letters, numbers, dot, dash or underscore' });
    if (password.length < 12) return json(res, 400, { error: 'Password must contain at least 12 characters' });
    if (!ADMIN_ROLES.has(String(body.role))) return json(res, 400, { error: 'Select a valid role' });
    const credentials = passwordRecord(password);
    try {
      const result = db.prepare(`INSERT INTO admin_users(username,password_hash,password_salt,role,enabled) VALUES(?,?,?,?,1)`).run(username, credentials.hash, credentials.salt, role);
      event('warning', 'auth.user_created', `${currentAdmin.username} created ${username}`, { actor_user_id: currentAdmin.user_id, user_id: result.lastInsertRowid, role });
      return json(res, 201, { id: Number(result.lastInsertRowid), username, role, enabled: true });
    } catch (error) { if (String(error.message).includes('UNIQUE')) return json(res, 409, { error: 'Username already exists' }); throw error; }
  }
  const adminUserMatch = pathname.match(/^\/api\/admin\/users\/(\d+)$/);
  if (adminUserMatch && method === 'PATCH') {
    const id = Number(adminUserMatch[1]); const target = db.prepare('SELECT * FROM admin_users WHERE id=?').get(id); if (!target) return json(res, 404, { error: 'User not found' });
    const body = await readBody(req); const role = Object.hasOwn(body, 'role') ? String(body.role) : target.role; const enabled = Object.hasOwn(body, 'enabled') ? Boolean(body.enabled) : Boolean(target.enabled); const password = String(body.password || '');
    if (!ADMIN_ROLES.has(role)) return json(res, 400, { error: 'Select a valid role' });
    if (id === Number(currentAdmin.user_id) && !enabled) return json(res, 409, { error: 'You cannot disable your own account' });
    const removesFullAccess = FULL_ACCESS_ROLES.has(normalizedAdminRole(target.role)) && (!enabled || !FULL_ACCESS_ROLES.has(role));
    const fullCount = Number(db.prepare(`SELECT COUNT(*) total FROM admin_users WHERE enabled=1 AND role IN ('owner','admin')`).get().total);
    if (removesFullAccess && fullCount <= 1) return json(res, 409, { error: 'At least one enabled Owner or Admin account is required' });
    if (password && password.length < 12) return json(res, 400, { error: 'Password must contain at least 12 characters' });
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('UPDATE admin_users SET role=?,enabled=?,updated_at=? WHERE id=?').run(role, enabled ? 1 : 0, nowIso(), id);
      if (password) { const credentials = passwordRecord(password); db.prepare('UPDATE admin_users SET password_hash=?,password_salt=?,updated_at=? WHERE id=?').run(credentials.hash, credentials.salt, nowIso(), id); }
      if (!enabled || password || role !== target.role) db.prepare('DELETE FROM admin_sessions WHERE user_id=? AND id<>?').run(id, currentAdmin.id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    event('warning', 'auth.user_updated', `${currentAdmin.username} updated ${target.username}`, { actor_user_id: currentAdmin.user_id, user_id: id, role, enabled, password_reset: Boolean(password) });
    return json(res, 200, { id, username: target.username, role, enabled });
  }
  if (adminUserMatch && method === 'DELETE') {
    const id = Number(adminUserMatch[1]); if (id === Number(currentAdmin.user_id)) return json(res, 409, { error: 'You cannot delete your own account' });
    const target = db.prepare('SELECT * FROM admin_users WHERE id=?').get(id); if (!target) return json(res, 404, { error: 'User not found' });
    const fullCount = Number(db.prepare(`SELECT COUNT(*) total FROM admin_users WHERE enabled=1 AND role IN ('owner','admin')`).get().total);
    if (target.enabled && FULL_ACCESS_ROLES.has(normalizedAdminRole(target.role)) && fullCount <= 1) return json(res, 409, { error: 'At least one enabled Owner or Admin account is required' });
    db.prepare('DELETE FROM admin_users WHERE id=?').run(id);
    event('warning', 'auth.user_deleted', `${currentAdmin.username} deleted ${target.username}`, { actor_user_id: currentAdmin.user_id, user_id: id, role: target.role });
    return json(res, 200, { ok: true });
  }

  if (method === 'POST' && pathname === '/api/admin/system/power') {
    const body = await readBody(req); const action = cleanText(body.action, 20).toLowerCase();
    if (!['reboot', 'shutdown'].includes(action)) return json(res, 400, { error: 'Action must be reboot or shutdown' });
    const simulated = process.env.DISABLE_SYSTEM_POWER === '1';
    if (!simulated && process.platform !== 'linux') return json(res, 501, { error: 'Server power controls are available only on Linux' });
    if (!simulated && !fs.existsSync('/usr/local/sbin/vendoos-power')) return json(res, 503, { error: 'Server power helper is not installed' });
    event('warning', `system.${action}_requested`, `${action === 'reboot' ? 'Reboot' : 'Shutdown'} requested from the admin dashboard`, { action, simulated });
    if (!simulated) scheduleSystemPower(action);
    return json(res, 202, { ok: true, action, simulated, message: `${action === 'reboot' ? 'Reboot' : 'Shutdown'} scheduled` });
  }

  if(method==='GET'&&pathname==='/api/admin/usage')return json(res,200,{
    hardware_usage:{cpu_percent:currentUsage.cpu_percent,memory_percent:currentUsage.memory_percent,load_1m:Number(os.loadavg()[0].toFixed(2))},
    network_usage:{interface:currentUsage.interface,rx_bps:currentUsage.rx_bps,tx_bps:currentUsage.tx_bps,rx_bytes:currentUsage.rx_bytes,tx_bytes:currentUsage.tx_bytes},
    usage_history:usageHistory.slice(-36),interface_usage:currentInterfaceUsage,interface_usage_history:interfaceUsageHistory.slice(-36)
  });

  if (method === 'GET' && pathname === '/api/admin/summary') {
    const machines = machineRows(); const users = activeUsers();
    const summary = {
      sales_today_centavos: Number(db.prepare(`SELECT COALESCE(SUM(amount_centavos),0) total FROM sales WHERE created_at>=datetime('now','start of day')`).get().total),
      sales_week_centavos: Number(db.prepare(`SELECT COALESCE(SUM(amount_centavos),0) total FROM sales WHERE created_at>=datetime('now','-6 days','start of day')`).get().total),
      sales_month_centavos: Number(db.prepare(`SELECT COALESCE(SUM(amount_centavos),0) total FROM sales WHERE created_at>=datetime('now','start of month')`).get().total),
      cash_waiting_centavos: machines.reduce((sum, item) => sum + Number(item.cash_on_hand_centavos || 0), 0),
      active_users: users.filter(item => item.status === 'active').length,
      online_machines: machines.filter(item => item.online).length,
      total_machines: machines.length,
      machines,
      sales: db.prepare(`SELECT s.id,s.method,s.amount_centavos,s.credited_seconds,s.client_mac,s.created_at,m.name machine_name FROM sales s LEFT JOIN machines m ON m.id=s.machine_id ORDER BY s.id DESC LIMIT 50`).all(),
      events: db.prepare('SELECT id,level,type,message,created_at FROM events ORDER BY id DESC LIMIT 30').all(),
      rates: ratesFor(zoneId, null, true),
      sales_chart: db.prepare(`SELECT date(created_at) day,COALESCE(SUM(amount_centavos),0) total_centavos,COALESCE(SUM(CASE WHEN method='coin' THEN amount_centavos ELSE 0 END),0) coin_centavos FROM sales WHERE created_at>=datetime('now','-13 days','start of day') GROUP BY date(created_at) ORDER BY day`).all(),
      voucher_counts: db.prepare(`SELECT status,COUNT(*) total FROM vouchers GROUP BY status`).all(),
      hardware_usage: { cpu_percent: currentUsage.cpu_percent, memory_percent: currentUsage.memory_percent, disk_percent: systemSnapshot().disk.used_percent, load_1m: Number(os.loadavg()[0].toFixed(2)), cpu_count: os.cpus().length },
      network_usage: { interface: currentUsage.interface, rx_bps: currentUsage.rx_bps, tx_bps: currentUsage.tx_bps, rx_bytes: currentUsage.rx_bytes, tx_bytes: currentUsage.tx_bytes },
      usage_history: usageHistory.slice(-36),
      interface_usage: currentInterfaceUsage,
      interface_usage_history: interfaceUsageHistory.slice(-36)
    };
    return json(res, 200, summary);
  }
  if (method === 'GET' && pathname === '/api/admin/sessions') return json(res, 200, activeUsers());
  const sessionAction = pathname.match(/^\/api\/admin\/sessions\/(\d+)\/actions$/);
  if (method === 'POST' && sessionAction) {
    const row = db.prepare('SELECT * FROM access_entitlements WHERE id=?').get(Number(sessionAction[1]));
    if (!row) return json(res, 404, { error: 'User session not found' });
    const body = await readBody(req); const action = cleanText(body.action, 20);
    if (action === 'extend') grantAccess(row.zone_id, row.client_mac, int(body.seconds, 0, 60, 365 * 86400), row.rate_limit, row.ip_address, row.last_machine_id);
    else if (action === 'pause') { const state = accessState(row.zone_id, row.client_mac); if (state.status !== 'active' || state.remaining_seconds <= 0) return json(res, 409, { error: 'No active time to pause' }); db.prepare(`UPDATE access_entitlements SET status='paused',expires_at=NULL,remaining_seconds=?,auto_reconnect=0,updated_at=? WHERE id=?`).run(state.remaining_seconds, nowIso(), row.id); }
    else if (action === 'auto_pause') { if (settingsMap().auto_pause_reconnect_enabled === '0') return json(res, 409, { error: 'Automatic pause and reconnect is disabled in System settings' }); const state = accessState(row.zone_id, row.client_mac); if (state.status !== 'active' || state.remaining_seconds <= 0) return json(res, 409, { error: 'No active time to auto pause' }); db.prepare(`UPDATE access_entitlements SET status='paused',expires_at=NULL,remaining_seconds=?,auto_reconnect=1,updated_at=? WHERE id=?`).run(state.remaining_seconds, nowIso(), row.id); }
    else if (action === 'resume') { const state = accessState(row.zone_id, row.client_mac); if (state.status !== 'paused' || state.remaining_seconds <= 0) return json(res, 409, { error: 'No paused time to reconnect' }); db.prepare(`UPDATE access_entitlements SET status='active',expires_at=?,remaining_seconds=0,auto_reconnect=0,updated_at=? WHERE id=?`).run(futureIso(state.remaining_seconds), nowIso(), row.id); }
    else if (action === 'speed') {
      const rateLimit = cleanText(body.rate_limit, 30).toUpperCase().replace(/\s+/g, '');
      if (!/^[1-9]\d*(?:\.\d+)?[KMG]\/[1-9]\d*(?:\.\d+)?[KMG]$/.test(rateLimit)) return json(res, 400, { error: 'Use download/upload format, for example 10M/5M' });
      db.prepare(`UPDATE access_entitlements SET rate_limit=?,updated_at=? WHERE id=?`).run(rateLimit, nowIso(), row.id);
    }
    else if (action === 'disconnect') db.prepare(`UPDATE access_entitlements SET status='expired',expires_at=NULL,remaining_seconds=0,auto_reconnect=0,updated_at=? WHERE id=?`).run(nowIso(), row.id);
    else if (action === 'block') db.prepare(`UPDATE access_entitlements SET status='blocked',expires_at=NULL,remaining_seconds=0,auto_reconnect=0,updated_at=? WHERE id=?`).run(nowIso(), row.id);
    else if (action === 'unblock') db.prepare(`UPDATE access_entitlements SET status='expired',auto_reconnect=0,updated_at=? WHERE id=?`).run(nowIso(), row.id);
    else return json(res, 400, { error: 'Unsupported session action' });
    event('info', `access.${action}`, `${action} applied to ${row.client_mac}`, { access_id: row.id });
    return json(res, 200, accessState(row.zone_id, row.client_mac));
  }
  const sessionItem = pathname.match(/^\/api\/admin\/sessions\/(\d+)$/);
  if (method === 'DELETE' && sessionItem) {
    const row = db.prepare('SELECT * FROM access_entitlements WHERE id=?').get(Number(sessionItem[1]));
    if (!row) return json(res, 404, { error: 'Customer record not found' });
    const openSessions = db.prepare(`SELECT id FROM coin_sessions WHERE zone_id=? AND client_mac=? AND status='open'`).all(row.zone_id, row.client_mac);
    db.prepare(`UPDATE coin_sessions SET status='cancelled' WHERE zone_id=? AND client_mac=? AND status='open'`).run(row.zone_id, row.client_mac);
    for (const session of openSessions) publishCoinSession(session.id);
    db.prepare('DELETE FROM access_entitlements WHERE id=?').run(row.id);
    event('info', 'access.deleted', `Customer ${row.client_mac} deleted`, { access_id: row.id, zone_id: row.zone_id });
    return json(res, 200, { deleted: true, id: row.id });
  }
  if (method === 'GET' && pathname === '/api/admin/machines') return json(res, 200, machineRows());
  if (method === 'GET' && pathname === '/api/admin/zones') return json(res, 200, db.prepare(`SELECT z.*,
    (SELECT COUNT(*) FROM machines m WHERE m.zone_id=z.id AND m.enabled=1) machine_count,
    (SELECT COUNT(*) FROM access_entitlements a WHERE a.zone_id=z.id AND a.status IN ('active','paused')) active_access_count
    FROM zones z ORDER BY z.enabled DESC,z.managed,z.vlan_id,z.id`).all());
  const zoneItem = pathname.match(/^\/api\/admin\/zones\/(\d+)$/);
  if (method === 'PATCH' && zoneItem) {
    const id = Number(zoneItem[1]); const zone = db.prepare('SELECT * FROM zones WHERE id=?').get(id);
    if (!zone) return json(res, 404, { error: 'Customer VLAN not found' });
    const body = await readBody(req); const name = cleanText(body.name, 80); const description = cleanText(body.description, 240);
    const parentIf = cleanText(body.parent_if, 30) || zone.parent_if; const subnet = cleanText(body.subnet, 30) || zone.subnet;
    const gateway = cleanText(body.gateway, 20) || zone.gateway; const dhcpStart = cleanText(body.dhcp_start, 20) || zone.dhcp_start;
    const dhcpEnd = cleanText(body.dhcp_end, 20) || zone.dhcp_end; const enabled = body.enabled === undefined ? Boolean(zone.enabled) : Boolean(body.enabled);
    if (!name) return json(res, 400, { error: 'VLAN name is required' });
    if (zone.managed && !/^[A-Za-z0-9_.:-]{1,30}$/.test(parentIf)) return json(res, 400, { error: 'Enter a valid parent interface' });
    if (!validCidr(subnet) || ipNumber(gateway) === null || !cidrContains(subnet, gateway) || ipNumber(dhcpStart) === null || ipNumber(dhcpEnd) === null || !cidrContains(subnet, dhcpStart) || !cidrContains(subnet, dhcpEnd) || ipNumber(dhcpStart) > ipNumber(dhcpEnd)) return json(res, 400, { error: 'Subnet, gateway and DHCP range must belong to the same network' });
    if (!enabled) {
      const assigned = db.prepare('SELECT COUNT(*) total FROM machines WHERE zone_id=? AND enabled=1').get(id).total;
      const access = db.prepare(`SELECT COUNT(*) total FROM access_entitlements WHERE zone_id=? AND status IN ('active','paused')`).get(id).total;
      if (assigned) return json(res, 409, { error: `Move ${assigned} station(s) to another VLAN before disabling this VLAN` });
      if (access) return json(res, 409, { error: `This VLAN still has ${access} active or paused customer access record(s)` });
    }
    const prefix = Number(subnet.split('/')[1]);
    db.prepare(`UPDATE zones SET name=?,description=?,parent_if=?,subnet=?,gateway=?,dhcp_start=?,dhcp_end=?,netmask=?,enabled=?,updated_at=? WHERE id=?`).run(name,description,parentIf,subnet,gateway,dhcpStart,dhcpEnd,prefixNetmask(prefix),enabled?1:0,nowIso(),id);
    event('info','vlan.updated',`${name} updated`,{zone_id:id,vlan_id:zone.vlan_id,enabled});
    return json(res, 200, db.prepare('SELECT * FROM zones WHERE id=?').get(id));
  }
  const zoneStations = pathname.match(/^\/api\/admin\/zones\/(\d+)\/stations$/);
  if (method === 'PUT' && zoneStations) {
    const id = Number(zoneStations[1]); const zone = db.prepare('SELECT * FROM zones WHERE id=? AND enabled=1').get(id);
    if (!zone) return json(res, 404, { error: 'Active customer VLAN not found' });
    const body = await readBody(req); const ids = [...new Set((Array.isArray(body.machine_ids) ? body.machine_ids : []).map(Number).filter(Number.isInteger))];
    if (ids.length) {
      const placeholders = ids.map(()=>'?').join(','); const found = db.prepare(`SELECT COUNT(*) total FROM machines WHERE enabled=1 AND id IN (${placeholders})`).get(...ids).total;
      if (found !== ids.length) return json(res, 400, { error: 'One or more selected stations are unavailable' });
    }
    const current = db.prepare('SELECT id FROM machines WHERE zone_id=? AND enabled=1').all(id).map(row=>row.id); const removed = current.filter(machineId=>!ids.includes(machineId));
    const fallback = removed.length ? db.prepare('SELECT id FROM zones WHERE id<>? AND enabled=1 ORDER BY managed ASC,id LIMIT 1').get(id) : null;
    if (removed.length && !fallback) return json(res, 409, { error: 'Create or enable another VLAN before removing stations from this VLAN' });
    db.exec('BEGIN IMMEDIATE');
    try {
      const move = db.prepare('UPDATE machines SET zone_id=?,config_version=config_version+1,updated_at=? WHERE id=? AND enabled=1');
      ids.forEach(machineId=>move.run(id,nowIso(),machineId)); removed.forEach(machineId=>move.run(fallback.id,nowIso(),machineId));
      db.prepare(`UPDATE zones SET default_machine_id=(SELECT id FROM machines WHERE zone_id=zones.id AND enabled=1 ORDER BY id LIMIT 1),updated_at=?`).run(nowIso());
      db.exec('COMMIT');
    } catch(error) { db.exec('ROLLBACK'); throw error; }
    event('info','vlan.stations_updated',`${zone.name} station assignments updated`,{zone_id:id,machine_ids:ids,removed_machine_ids:removed});
    return json(res, 200, { ok:true, zone_id:id, machine_ids:ids, reassigned_to: fallback?.id || null });
  }
  if (method === 'DELETE' && zoneItem) {
    const id = Number(zoneItem[1]); const zone = db.prepare('SELECT * FROM zones WHERE id=?').get(id);
    if (!zone) return json(res, 404, { error: 'Customer VLAN not found' });
    if (!zone.managed) return json(res, 409, { error: 'The default customer network cannot be deleted' });
    const assigned = db.prepare('SELECT COUNT(*) total FROM machines WHERE zone_id=? AND enabled=1').get(id).total;
    const access = db.prepare(`SELECT COUNT(*) total FROM access_entitlements WHERE zone_id=? AND status IN ('active','paused')`).get(id).total;
    if (assigned) return json(res, 409, { error: `Move ${assigned} station(s) to another VLAN before deleting this VLAN` });
    if (access) return json(res, 409, { error: `This VLAN still has ${access} active or paused customer access record(s)` });
    db.prepare('UPDATE zones SET enabled=0,default_machine_id=NULL,updated_at=? WHERE id=?').run(nowIso(),id);
    event('warning','vlan.deleted',`${zone.name} archived and removed from the live network`,{zone_id:id,vlan_id:zone.vlan_id});
    return json(res, 200, { ok:true, archived:true });
  }
  if (method === 'POST' && pathname === '/api/admin/stations/enroll') {
    const body = await readBody(req); const vlanId = Number(body.vlan_id); const vlanEnd = body.vlan_end === undefined || body.vlan_end === null || body.vlan_end === '' ? vlanId : Number(body.vlan_end); const addressing = Number.isInteger(vlanId) && vlanId >= 1 && vlanId <= 4094 ? automaticVlanAddressing(vlanId) : null; const parentIf = cleanText(body.parent_if, 30) || settingsMap().network_customer_if || CUSTOMER_IF; const subnet = cleanText(body.subnet, 30) || addressing?.subnet || ''; const gateway = cleanText(body.gateway, 20) || addressing?.gateway || ''; const dhcpStart = cleanText(body.dhcp_start, 20) || addressing?.dhcpStart || ''; const dhcpEnd = cleanText(body.dhcp_end, 20) || addressing?.dhcpEnd || ''; const hardwareId = cleanText(body.hardware_id, 80); const name = cleanText(body.name, 80);
    if (!Number.isInteger(vlanId) || vlanId < 1 || vlanId > 4094 || !Number.isInteger(vlanEnd) || vlanEnd < 1 || vlanEnd > 4094 || !/^[A-Za-z0-9_.:-]{1,30}$/.test(parentIf)) return json(res, 400, { error: 'VLAN IDs must be whole numbers between 1 and 4094, with a valid parent interface' });
    if (vlanEnd !== vlanId) {
      if (vlanEnd < vlanId) return json(res, 400, { error: 'End VLAN must be greater than or equal to Start VLAN' });
      const count = vlanEnd - vlanId + 1;
      if (count > 4094) return json(res, 400, { error: 'Create no more than 4094 VLANs at a time' });
      if (hardwareId || cleanText(body.subnet,30) || cleanText(body.gateway,20) || cleanText(body.dhcp_start,20) || cleanText(body.dhcp_end,20)) return json(res, 400, { error: 'Hardware assignment and custom addressing are available only when creating one VLAN' });
      const ids = Array.from({length:count},(_,index)=>vlanId+index);
      const conflicts = db.prepare('SELECT vlan_id FROM zones WHERE enabled=1 AND vlan_id BETWEEN ? AND ? ORDER BY vlan_id').all(vlanId, vlanEnd);
      if (conflicts.length) return json(res, 409, { error: `VLAN range overlaps existing VLAN ${conflicts.map(item=>item.vlan_id).join(', ')}` });
      const prefix = cleanText(body.zone_name,80) || 'VLAN'; const zones=[];
      const addZone = db.prepare(`INSERT INTO zones(code,name,subnet,gateway,vlan_id,parent_if,dhcp_start,dhcp_end,netmask,managed,enabled,updated_at) VALUES(?,?,?,?,?,?,?,?,?,1,1,?) RETURNING *`);
      db.exec('BEGIN IMMEDIATE');
      try {
        for(const id of ids) { const network = automaticVlanAddressing(id); zones.push(addZone.get(`vlan-${id}`,`${prefix} ${id}`,network.subnet,network.gateway,id,parentIf,network.dhcpStart,network.dhcpEnd,prefixNetmask(24),nowIso())); }
        db.exec('COMMIT');
      } catch(error) { db.exec('ROLLBACK'); throw error; }
      event('info','vlan.range_created',`VLAN range ${vlanId}-${vlanEnd} created`,{vlan_start:vlanId,vlan_end:vlanEnd,count,parent_if:parentIf});
      return json(res,201,{zones,count,status:'awaiting_auto_discovery'});
    }
    if (!validCidr(subnet) || ipNumber(gateway) === null || !cidrContains(subnet, gateway) || ipNumber(dhcpStart) === null || ipNumber(dhcpEnd) === null || !cidrContains(subnet, dhcpStart) || !cidrContains(subnet, dhcpEnd) || ipNumber(dhcpStart) > ipNumber(dhcpEnd)) return json(res, 400, { error: 'Subnet, gateway and DHCP range must belong to the same network' });
    if (hardwareId && !/^[A-Za-z0-9._:-]{4,80}$/.test(hardwareId)) return json(res, 400, { error: 'hardware_id is invalid' });
    const conflict = db.prepare('SELECT id,parent_if FROM zones WHERE vlan_id=? AND enabled=1').get(vlanId); if (conflict && conflict.parent_if !== parentIf) return json(res, 409, { error: 'VLAN ID is already used on another parent interface' });
    const code = `vlan-${vlanId}`; const prefix = Number(subnet.split('/')[1]);
    const zone = db.prepare(`INSERT INTO zones(code,name,subnet,gateway,vlan_id,parent_if,dhcp_start,dhcp_end,netmask,managed,enabled,updated_at) VALUES(?,?,?,?,?,?,?,?,?,1,1,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name,subnet=excluded.subnet,gateway=excluded.gateway,vlan_id=excluded.vlan_id,parent_if=excluded.parent_if,dhcp_start=excluded.dhcp_start,dhcp_end=excluded.dhcp_end,netmask=excluded.netmask,managed=1,enabled=1,updated_at=excluded.updated_at RETURNING *`).get(code, cleanText(body.zone_name, 80) || `VLAN ${vlanId}`, subnet, gateway, vlanId, parentIf, dhcpStart, dhcpEnd, prefixNetmask(prefix), nowIso());
    let machineId = null;
    if (hardwareId) {
      const existing = db.prepare('SELECT id FROM machines WHERE hardware_id=?').get(hardwareId); const machineName = name || `Vendo ${hardwareId.slice(-6)}`;
      if (existing) { db.prepare(`UPDATE machines SET name=?,zone_id=?,location=?,coin_pin=?,enable_pin=?,enabled=1,updated_at=?,config_version=config_version+1 WHERE id=?`).run(machineName, zone.id, cleanText(body.location, 120), int(body.coin_pin, 2, 0, 39), int(body.enable_pin, 15, 0, 39), nowIso(), existing.id); machineId = existing.id; }
      else machineId = db.prepare(`INSERT INTO machines(hardware_id,name,zone_id,token_hash,coin_pin,enable_pin,location,board,device_type) VALUES(?,?,?,?,?,?,?,?,?)`).run(hardwareId,machineName,zone.id,sha(randomToken()),int(body.coin_pin,2,0,39),int(body.enable_pin,15,0,39),cleanText(body.location,120),cleanText(body.board,40)||'ESP8266','coin').lastInsertRowid;
      db.prepare('UPDATE zones SET default_machine_id=COALESCE(default_machine_id,?),updated_at=? WHERE id=?').run(machineId,nowIso(),zone.id);
    }
    event('info','station.enrolled',hardwareId?`${name || hardwareId} assigned to VLAN ${vlanId}`:`VLAN ${vlanId} ready for automatic ESP enrollment`,{machine_id:machineId,zone_id:zone.id,vlan_id:vlanId,parent_if:parentIf});
    return json(res, 201, { machine: machineId ? machineRows().find(item => item.id === Number(machineId)) : null, zone, status: machineId ? 'pending_device_heartbeat' : 'awaiting_auto_discovery' });
  }
  const machineItem = pathname.match(/^\/api\/admin\/machines\/(\d+)$/);
  if (method === 'PATCH' && machineItem) {
    const id = Number(machineItem[1]); const body = await readBody(req);
    const machine = db.prepare('SELECT * FROM machines WHERE id=? AND enabled=1').get(id);
    if (!machine) return json(res, 404, { error: 'Machine not found' });
    const name = cleanText(body.name, 80) || machine.name; const location = cleanText(body.location, 120);
    const coinPin = int(body.coin_pin, machine.coin_pin, 0, 39); const enablePin = int(body.enable_pin, machine.enable_pin, 0, 39);
    const pinError = machinePinError(machine.board, coinPin, enablePin);
    if (pinError) return json(res, 400, { error: pinError });
    db.prepare(`UPDATE machines SET name=?,location=?,coin_pin=?,enable_pin=?,updated_at=?,config_version=config_version+1 WHERE id=?`).run(name, location, coinPin, enablePin, nowIso(), id);
    event('info', 'station.pins_updated', `${name} GPIO configuration updated`, { machine_id: id, board: machine.board, coin_pin: coinPin, enable_pin: enablePin });
    return json(res, 200, machineRows().find(item => item.id === id));
  }
  if (method === 'GET' && pathname === '/api/admin/rates') return json(res, 200, ratesFor(zoneId, null, true));
  if (method === 'POST' && pathname === '/api/admin/rates') {
    const body = await readBody(req); const price = int(body.price_centavos, 0, 1, 1000000); const duration = int(body.duration_seconds, 0, 1, 365 * 86400);
    if (!price || !duration) return json(res, 400, { error: 'Valid price and duration are required' });
    const id = int(body.id, 0, 1);
    if (id) db.prepare(`UPDATE rates SET name=?,price_centavos=?,duration_seconds=?,rate_limit=?,pausable=?,sort_order=?,enabled=?,expiry_seconds=?,pause_limit=?,points=?,is_default=?,updated_at=? WHERE id=?`).run(cleanText(body.name, 80), price, duration, cleanText(body.rate_limit, 30) || '5M/5M', body.pausable === false ? 0 : 1, int(body.sort_order, 0, 0, 999), body.enabled === false ? 0 : 1, int(body.expiry_seconds, 86400, 0, 365 * 86400), int(body.pause_limit, 0, 0, 999), int(body.points, 0, 0, 100000), body.is_default === false ? 0 : 1, nowIso(), id);
    else db.prepare(`INSERT INTO rates(zone_id,name,price_centavos,duration_seconds,rate_limit,pausable,sort_order,expiry_seconds,pause_limit,points,is_default) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(zoneId, cleanText(body.name, 80) || `PHP ${price / 100}`, price, duration, cleanText(body.rate_limit, 30) || '5M/5M', body.pausable === false ? 0 : 1, int(body.sort_order, 0, 0, 999), int(body.expiry_seconds, 86400, 0, 365 * 86400), int(body.pause_limit, 0, 0, 999), int(body.points, 0, 0, 100000), body.is_default === false ? 0 : 1);
    return json(res, 200, ratesFor(zoneId, null, true));
  }
  const rateDelete = pathname.match(/^\/api\/admin\/rates\/(\d+)$/);
  if (method === 'DELETE' && rateDelete) { db.prepare('DELETE FROM rates WHERE id=?').run(Number(rateDelete[1])); return json(res, 200, { ok: true }); }
  if (method === 'POST' && pathname === '/api/admin/rates/defaults') {
    const body=await readBody(req); const ids=[...new Set((Array.isArray(body.rate_ids)?body.rate_ids:[]).map(Number).filter(Number.isInteger))];
    if(!ids.length)return json(res,400,{error:'Select at least one rate to use as default'}); const placeholders=ids.map(()=>'?').join(',');
    const found=db.prepare(`SELECT COUNT(*) total FROM rates WHERE id IN (${placeholders}) AND enabled=1`).get(...ids).total; if(found!==ids.length)return json(res,400,{error:'One or more selected rates are unavailable'});
    db.exec('BEGIN IMMEDIATE'); try{db.prepare('UPDATE rates SET is_default=0,updated_at=?').run(nowIso());db.prepare(`UPDATE rates SET is_default=1,updated_at=? WHERE id IN (${placeholders})`).run(nowIso(),...ids);db.exec('COMMIT')}catch(error){db.exec('ROLLBACK');throw error}
    event('info','rates.defaults_updated',`${ids.length} default rates selected`,{rate_ids:ids}); return json(res,200,{ok:true,rate_ids:ids});
  }
  if (method === 'PUT' && pathname === '/api/admin/rates/apply-all') {
    const body=await readBody(req); const ids=[...new Set((Array.isArray(body.rate_ids)?body.rate_ids:[]).map(Number).filter(Number.isInteger))];
    if(!ids.length)return json(res,400,{error:'Select at least one rate to apply'}); const placeholders=ids.map(()=>'?').join(',');
    const found=db.prepare(`SELECT COUNT(*) total FROM rates WHERE id IN (${placeholders}) AND enabled=1`).get(...ids).total; if(found!==ids.length)return json(res,400,{error:'One or more selected rates are unavailable'});
    const machines=db.prepare('SELECT id FROM machines WHERE enabled=1').all(); const add=db.prepare('INSERT INTO machine_rates(machine_id,rate_id) VALUES(?,?)');
    db.exec('BEGIN IMMEDIATE'); try{db.prepare('DELETE FROM machine_rates').run();machines.forEach(machine=>ids.forEach(rateId=>add.run(machine.id,rateId)));db.exec('COMMIT')}catch(error){db.exec('ROLLBACK');throw error}
    event('info','rates.applied_all',`${ids.length} rates applied to ${machines.length} stations`,{rate_ids:ids,machine_count:machines.length}); return json(res,200,{ok:true,rate_ids:ids,machine_count:machines.length});
  }
  const machineRates = pathname.match(/^\/api\/admin\/machines\/(\d+)\/rates$/);
  if (machineRates && method === 'GET') return json(res, 200, ratesFor(zoneId, Number(machineRates[1]), true));
  if (machineRates && method === 'PUT') {
    const body = await readBody(req); const machineId = Number(machineRates[1]);
    if (!db.prepare('SELECT 1 FROM machines WHERE id=? AND enabled=1').get(machineId)) return json(res, 404, { error: 'Machine not found' });
    const ids = [...new Set((Array.isArray(body.rate_ids) ? body.rate_ids : []).map(Number).filter(Number.isInteger))];
    db.exec('BEGIN IMMEDIATE'); try { db.prepare('DELETE FROM machine_rates WHERE machine_id=?').run(machineId); const add = db.prepare('INSERT INTO machine_rates(machine_id,rate_id) VALUES(?,?)'); ids.forEach(id => add.run(machineId, id)); db.exec('COMMIT'); } catch (error) { db.exec('ROLLBACK'); throw error; }
    return json(res, 200, ratesFor(zoneId, machineId, true));
  }
  if (method === 'POST' && pathname === '/api/admin/vouchers/generate') {
    const body = await readBody(req); const quantity = int(body.quantity, 0, 1, 500); const duration = int(body.duration_seconds, 0, 60, 365 * 86400); const validity = int(body.validity_seconds, 0, 0, 3650 * 86400); const expiresAt = validity ? futureIso(validity) : (body.expires_at || null);
    if (!quantity || !duration) return json(res, 400, { error: 'Quantity and duration are required' });
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; const prefix = cleanText(body.prefix, 8).toUpperCase().replace(/[^A-Z2-9]/g, '');
    const batch = cleanText(body.batch_code, 30).toUpperCase() || `B${Date.now().toString(36).toUpperCase()}`; const codes = [];
    for (let i = 0; i < quantity; i += 1) {
      let raw = ''; for (let j = 0; j < 8; j += 1) raw += alphabet[crypto.randomInt(alphabet.length)];
      const code = `${prefix}${prefix ? '-' : ''}${raw}`;
      db.prepare(`INSERT INTO vouchers(code_hash,code_hint,code_value,batch_code,seller_code,zone_id,duration_seconds,rate_limit,price_centavos,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(sha(code), `${code.slice(0, 4)}…${code.slice(-3)}`, code, batch, cleanText(body.seller_code, 30) || null, null, duration, cleanText(body.rate_limit, 30) || '5M/5M', int(body.price_centavos, 0, 0, 1000000), expiresAt);
      codes.push(code);
    }
    event('info', 'voucher.generated', `${quantity} vouchers generated`, { batch_code: batch, zone_id:null, duration_seconds:duration, validity_seconds:validity });
    return json(res, 201, { batch_code: batch, zone_id:null, duration_seconds:duration, validity_seconds:validity, expires_at:expiresAt, codes });
  }
  if (method === 'POST' && pathname.match(/^\/api\/admin\/machines\/\d+\/commands$/)) {
    const id = Number(pathname.split('/')[4]); const body = await readBody(req);
    const machine = db.prepare('SELECT id FROM machines WHERE id=? AND enabled=1').get(id); if (!machine) return json(res, 404, { error: 'Machine not found' });
    const allowed = ['restart','refresh_config','disable_coin','enable_coin','firmware_update']; const command = cleanText(body.command, 40);
    if (!allowed.includes(command)) return json(res, 400, { error: 'Unsupported command' });
    const result = db.prepare('INSERT INTO hardware_commands(machine_id,command,payload_json) VALUES(?,?,?)').run(id, command, JSON.stringify(body.payload || {}));
    return json(res, 202, { id: result.lastInsertRowid, status: 'pending' });
  }
  if (method === 'DELETE' && pathname.match(/^\/api\/admin\/machines\/\d+$/)) {
    const id = Number(pathname.split('/')[4]);
    const open = db.prepare(`SELECT 1 FROM coin_sessions WHERE machine_id=? AND status='open'`).get(id);
    if (open) return json(res, 409, { error: 'Cancel the active coin session before deleting this station' });
    const result = db.prepare('UPDATE machines SET enabled=0,updated_at=? WHERE id=?').run(nowIso(), id);
    if (!result.changes) return json(res, 404, { error: 'Machine not found' });
    event('warning', 'device.deleted', `Station ${id} disabled`, { machine_id: id }); return json(res, 200, { ok: true });
  }
  if (method === 'GET' && pathname === '/api/admin/vouchers') {
    const batch = cleanText(url.searchParams.get('batch'), 30); const seller = cleanText(url.searchParams.get('seller'), 30); const status = cleanText(url.searchParams.get('status'), 20); const conditions=[]; const params=[];
    if (batch) { conditions.push('batch_code=?'); params.push(batch); } if (seller) { conditions.push('seller_code=?'); params.push(seller); } if (['unused','used','disabled'].includes(status)) { conditions.push('status=?'); params.push(status); }
    const rows = db.prepare(`SELECT id,code_hint,code_value,batch_code,seller_code,zone_id,price_centavos,duration_seconds,rate_limit,status,expires_at,used_at,used_by_mac,created_at FROM vouchers ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 2000`).all(...params);
    return json(res, 200, rows);
  }
  if (method === 'DELETE' && pathname === '/api/admin/vouchers') {
    const body = await readBody(req); const quantity = int(body.quantity, 0, 1, 500);
    let result; let scope = 'selection';
    if (quantity) {
      const clauses=[]; const params=[]; const batch=cleanText(body.batch_code,30); const seller=cleanText(body.seller_code,30); const requestedStatus=cleanText(body.status,20); const status=['unused','used','disabled'].includes(requestedStatus)?requestedStatus:'unused';
      if(batch){clauses.push('batch_code=?');params.push(batch)} if(seller){clauses.push('seller_code=?');params.push(seller)} clauses.push('status=?');params.push(status);
      const rows=db.prepare(`SELECT id FROM vouchers WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT ?`).all(...params,quantity);
      if(!rows.length)return json(res,404,{error:'No matching vouchers are available to delete'});
      const ids=rows.map(row=>row.id); result=db.prepare(`DELETE FROM vouchers WHERE id IN (${ids.map(()=>'?').join(',')})`).run(...ids); scope=`quantity:${quantity}`;
    } else {
      const ids=[...new Set((Array.isArray(body.ids)?body.ids:[]).slice(0,500).map(Number).filter(id=>Number.isInteger(id)&&id>0))]; const clauses=[]; const params=[];
      if(ids.length){clauses.push(`id IN (${ids.map(()=>'?').join(',')})`);params.push(...ids)}
      const batch=cleanText(body.batch_code,30); const seller=cleanText(body.seller_code,30);
      if(batch){clauses.push('batch_code=?');params.push(batch);scope=`batch:${batch}`} if(seller){clauses.push('seller_code=?');params.push(seller);scope=`seller:${seller}`}
      if(!clauses.length)return json(res,400,{error:'Select voucher IDs, a batch, a quantity, or a seller'});
      result=db.prepare(`DELETE FROM vouchers WHERE ${clauses.join(' OR ')}`).run(...params);
    }
    event('warning','voucher.deleted',`${result.changes} voucher(s) deleted`,{scope,deleted:result.changes});
    return json(res, 200, { ok: true, deleted: result.changes });
  }
  if (method === 'GET' && pathname === '/api/admin/export/vouchers.csv') {
    const rows = db.prepare('SELECT code_value,batch_code,seller_code,duration_seconds,status,expires_at,used_at FROM vouchers ORDER BY id DESC').all();
    return csvResponse(res, 'vouchers.csv', ['Code','Batch','Seller','Seconds','Status','Expires','Used'], rows.map(r=>[r.code_value,r.batch_code,r.seller_code,r.duration_seconds,r.status,r.expires_at,r.used_at]));
  }
  if (method === 'GET' && pathname === '/api/admin/sellers') return json(res, 200, db.prepare(`SELECT s.*,(SELECT COUNT(*) FROM vouchers v WHERE v.seller_code=s.code) voucher_count,(SELECT COUNT(*) FROM vouchers v WHERE v.seller_code=s.code AND v.status='used') redeemed_count FROM sellers s ORDER BY s.name`).all());
  if (method === 'POST' && pathname === '/api/admin/sellers') {
    const body=await readBody(req); const code=cleanText(body.code,30).toUpperCase(); if(!code||!cleanText(body.name,80)) return json(res,400,{error:'Seller code and name are required'});
    db.prepare(`INSERT INTO sellers(code,name,contact,location) VALUES(?,?,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name,contact=excluded.contact,location=excluded.location,enabled=1,updated_at=CURRENT_TIMESTAMP`).run(code,cleanText(body.name,80),cleanText(body.contact,100),cleanText(body.location,120));
    return json(res,201,{ok:true});
  }
  const sellerDelete=pathname.match(/^\/api\/admin\/sellers\/([^/]+)$/);
  if(method==='DELETE'&&sellerDelete){ const code=decodeURIComponent(sellerDelete[1]); const used=db.prepare(`SELECT 1 FROM vouchers WHERE seller_code=? AND status='used' LIMIT 1`).get(code); if(used) db.prepare('UPDATE sellers SET enabled=0,updated_at=? WHERE code=?').run(nowIso(),code); else { db.prepare('UPDATE vouchers SET seller_code=NULL WHERE seller_code=?').run(code); db.prepare('DELETE FROM sellers WHERE code=?').run(code); } return json(res,200,{ok:true,archived:Boolean(used)}); }
  if (method === 'GET' && pathname === '/api/admin/sales') return json(res, 200, salesRows(url));
  if (method === 'POST' && pathname === '/api/admin/sales/reset') {
    const body = await readBody(req); const machineId = body.machine_id ? int(body.machine_id, 0, 1) : 0;
    let machine = null;
    if (machineId) { machine = db.prepare('SELECT id,name FROM machines WHERE id=?').get(machineId); if (!machine) return json(res, 404, { error: 'Station not found' }); }
    const backupName = `pre-sales-reset-${new Date().toISOString().replace(/[:.]/g, '-')}.db`;
    const backupPath = path.join(BACKUP_DIR, backupName);
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    db.exec('BEGIN IMMEDIATE');
    try {
      const deleted = machineId ? db.prepare('DELETE FROM sales WHERE machine_id=?').run(machineId) : db.prepare('DELETE FROM sales').run();
      const cashReset = machineId
        ? db.prepare('UPDATE machines SET cash_on_hand_centavos=0,updated_at=? WHERE id=?').run(nowIso(), machineId)
        : db.prepare('UPDATE machines SET cash_on_hand_centavos=0,updated_at=?').run(nowIso());
      db.exec('COMMIT');
      const scope = machine ? machine.name : 'all stations';
      event('warning', 'sales.reset', `Sales reset for ${scope}`, { machine_id: machineId || null, deleted_sales: deleted.changes, cash_reset_stations: cashReset.changes, backup: backupName });
      return json(res, 200, { ok: true, scope, deleted_sales: deleted.changes, cash_reset_stations: cashReset.changes, backup: backupName });
    } catch (error) { db.exec('ROLLBACK'); try { fs.unlinkSync(backupPath); } catch {} throw error; }
  }
  if (method === 'GET' && pathname === '/api/admin/export/sales.csv') { const rows=salesRows(url,10000); return csvResponse(res,'sales.csv',['Date','Station','Method','Payment provider','Client','Amount centavos','Seconds','Reference'],rows.map(r=>[r.created_at,r.machine_name,r.method,r.payment_provider,r.client_mac,r.amount_centavos,r.credited_seconds,r.reference])); }
  if (method === 'GET' && pathname === '/api/admin/reports/daily') return json(res,200,db.prepare(`SELECT date(s.created_at) day,m.name machine_name,s.method,COUNT(*) transactions,SUM(s.amount_centavos) amount_centavos,SUM(s.credited_seconds) credited_seconds FROM sales s LEFT JOIN machines m ON m.id=s.machine_id GROUP BY date(s.created_at),s.machine_id,s.method ORDER BY day DESC,machine_name`).all());
  if (method === 'GET' && pathname === '/api/admin/collections') return json(res,200,db.prepare(`SELECT c.*,m.name machine_name FROM collections c JOIN machines m ON m.id=c.machine_id ORDER BY c.id DESC LIMIT 1000`).all());
  if (method === 'POST' && pathname === '/api/admin/collections') {
    const body=await readBody(req); const id=int(body.machine_id,0,1); const machine=db.prepare('SELECT * FROM machines WHERE id=? AND enabled=1').get(id); if(!machine)return json(res,404,{error:'Machine not found'});
    const actual=int(body.actual_amount_centavos,0,0,100000000); const system=Number(machine.cash_on_hand_centavos||0); const result=db.prepare(`INSERT INTO collections(machine_id,system_amount_centavos,actual_amount_centavos,variance_centavos,collector,notes,period_started_at) VALUES(?,?,?,?,?,?,?)`).run(id,system,actual,actual-system,cleanText(body.collector,80),cleanText(body.notes,500),body.period_started_at||null); db.prepare('UPDATE machines SET cash_on_hand_centavos=0,updated_at=? WHERE id=?').run(nowIso(),id); event('info','cash.collected',`Cash collected from ${machine.name}`,{machine_id:id,system,actual,variance:actual-system}); return json(res,201,{id:result.lastInsertRowid,system_amount_centavos:system,actual_amount_centavos:actual,variance_centavos:actual-system});
  }
  if (method === 'GET' && pathname === '/api/admin/network') {
    const snapshot=systemSnapshot(),settings=settingsMap(),interface_descriptions={};
    for(const item of snapshot.interfaces){const key=`network_interface_description:${item.ifname}`,value=settings[key];if(value)interface_descriptions[item.ifname]=value;}
    const publicSettings=Object.fromEntries(Object.entries(settings).filter(([key])=>!key.startsWith('network_interface_secret:')));
    const sqm=cakeStatus();
    return json(res,200,{...snapshot,settings:publicSettings,interface_descriptions,interface_roles:interfaceRoles(snapshot,settings),interface_configs:interfaceConfigurations(settings),interface_apply_status:interfaceSyncStatus(),multi_wan:multiWanStatus(),pbr:pbrStatus(),cake:sqm,sqm,vlan_health:vlanHealth(snapshot)});
  }
  if (method === 'GET' && pathname === '/api/admin/network/vlans/health') return json(res,200,vlanHealth());
  const interfaceDescriptionMatch=pathname.match(/^\/api\/admin\/network\/interfaces\/([^/]+)\/description$/);
  if(method==='PUT'&&interfaceDescriptionMatch){
    const name=cleanText(decodeURIComponent(interfaceDescriptionMatch[1]),30),interfaces=new Set(fs.readdirSync('/sys/class/net'));
    if(!interfaces.has(name))return json(res,404,{error:'Network interface not found'});
    const body=await readBody(req),description=cleanText(body.description,120),key=`network_interface_description:${name}`;
    if(description)db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(key,description,nowIso());else db.prepare('DELETE FROM settings WHERE key=?').run(key);
    event('info','network.interface_description',`Interface ${name} description updated`,{interface:name,description});
    return json(res,200,{interface:name,description});
  }

  const interfaceConfigMatch=pathname.match(/^\/api\/admin\/network\/interfaces\/([^/]+)\/config$/);
  if(method==='PUT'&&interfaceConfigMatch){
    const name=cleanText(decodeURIComponent(interfaceConfigMatch[1]),30),snapshot=systemSnapshot(),detected=snapshot.interfaces.find(item=>item.ifname===name);
    if(!detected)return json(res,404,{error:'Network interface not found'});
    if(name==='lo'||detected.linkinfo?.info_kind==='vlan')return json(res,400,{error:'Use the customer VLAN editor for loopback or VLAN interfaces'});
    const body=await readBody(req),mode=cleanText(body.mode,10),address=cleanText(body.address,50),gateway=cleanText(body.gateway,45),cost=int(body.cost,100,1,65535),pppoeUsername=cleanText(body.pppoe_username,128),pppoePassword=String(body.pppoe_password||'').slice(0,256),pppoeService=cleanText(body.pppoe_service,64),mtu=int(body.mtu,1492,576,1492);
    if(!['dhcp','static','pppoe'].includes(mode))return json(res,400,{error:'Internet source must be DHCP, static IP, or PPPoE'});
    if(mode==='static'&&!validInterfaceCidr(address))return json(res,400,{error:'Enter a valid static IPv4 address with CIDR prefix'});
    if(gateway&&ipNumber(gateway)===null)return json(res,400,{error:'Enter a valid IPv4 gateway'});
    if(mode==='static'&&gateway&&!interfaceCidrContains(address,gateway))return json(res,400,{error:'Gateway must be inside the static interface subnet'});
    const dns=[...new Set((Array.isArray(body.dns)?body.dns:[]).map(value=>cleanText(value,45)).filter(Boolean))].slice(0,3);
    if(dns.some(value=>ipNumber(value)===null))return json(res,400,{error:'DNS servers must be valid IPv4 addresses'});
    const secretKey=`network_interface_secret:${name}`,savedSecret=db.prepare('SELECT value FROM settings WHERE key=?').get(secretKey)?.value;
    if(mode==='pppoe'&&!pppoeUsername)return json(res,400,{error:'Enter the PPPoE username supplied by the ISP'});
    if(mode==='pppoe'&&!pppoePassword&&!savedSecret)return json(res,400,{error:'Enter the PPPoE password supplied by the ISP'});
    if(/[\r\n\0]/.test(pppoeUsername+pppoePassword+pppoeService))return json(res,400,{error:'PPPoE fields contain unsupported control characters'});
    const config={mode,address:mode==='static'?address:'',gateway:mode==='static'?gateway:'',dns,cost,pppoe_username:mode==='pppoe'?pppoeUsername:'',pppoe_service:mode==='pppoe'?pppoeService:'',mtu:mode==='pppoe'?mtu:1492};
    const key=`network_interface_config:${name}`,set=db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`);
    db.exec('BEGIN IMMEDIATE');
    try{set.run(key,JSON.stringify(config),nowIso());if(mode==='pppoe'&&pppoePassword)set.run(secretKey,pppoePassword,nowIso());if(mode!=='pppoe')db.prepare('DELETE FROM settings WHERE key=?').run(secretKey);db.exec('COMMIT')}catch(error){db.exec('ROLLBACK');throw error}
    event('warning','network.interface_config_queued',`IP configuration queued for ${name}`,{interface:name,...config});
    return json(res,202,{queued:true,interface:name,config:{...config,pppoe_password_set:mode==='pppoe'}});
  }


  if (method === 'POST' && pathname === '/api/admin/network/pbr') {
    const body=await readBody(req),settings=settingsMap();let wans=[];
    try{wans=JSON.parse(settings.multi_wan_config||'[]')}catch{}
    const available=new Map(wans.filter(item=>item&&item.enabled!==false).map(item=>[cleanText(item.interface,30),item]));
    const input=Array.isArray(body.policies)?body.policies.slice(0,32):[],policies=[],priorities=new Set();
    for(let index=0;index<input.length;index++){
      const item=input[index]||{},name=cleanText(item.name,60),trafficClass=cleanText(item.class,20),interfaceName=cleanText(item.interface,30),priority=int(item.priority,index+1,1,999),enabled=item.enabled!==false;
      if(!name)return json(res,400,{error:`Policy ${index+1} requires a name`});
      if(!['browsing','gaming','streaming'].includes(trafficClass))return json(res,400,{error:`Policy ${name} has an invalid traffic class`});
      if(!available.has(interfaceName))return json(res,400,{error:`Policy ${name} must use an enabled ISP from Multi-WAN`});
      if(priorities.has(priority))return json(res,400,{error:'Each PBR policy requires a unique priority'});priorities.add(priority);
      let match='';
      if(trafficClass==='streaming'){
        const values=String(item.match||'').split(/[\s,]+/).filter(Boolean);
        if(!values.length||values.some(value=>!validInterfaceCidr(value)))return json(res,400,{error:`Streaming policy ${name} requires valid destination CIDRs`});
        match=[...new Set(values)].join(',');
      }else if(trafficClass==='gaming'){
        const values=String(item.match||'').split(',').map(value=>value.trim()).filter(Boolean);
        if(!values.length||values.some(value=>{const parts=value.split('-').map(Number);return parts.some(port=>!Number.isInteger(port)||port<1||port>65535)||parts.length>2||(parts.length===2&&parts[1]<parts[0])}))return json(res,400,{error:`Gaming policy ${name} requires valid ports or port ranges`});
        match=[...new Set(values)].join(',');
      }
      policies.push({id:cleanText(item.id,40)||`pbr-${Date.now()}-${index}`,name,class:trafficClass,interface:interfaceName,priority,match,enabled});
    }
    const enabled=Boolean(body.enabled);if(enabled&&!policies.some(item=>item.enabled))return json(res,400,{error:'Add and enable at least one PBR policy'});
    const set=db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`);
    set.run('pbr_enabled',enabled?'1':'0',nowIso());set.run('pbr_policies',JSON.stringify(policies),nowIso());
    event('warning','network.pbr_changed',enabled?'Policy-based routing enabled':'Policy-based routing disabled',{policy_count:policies.length});
    return json(res,200,{enabled,policies});
  }

  if (method === 'POST' && pathname === '/api/admin/network/multiwan') {
    const body=await readBody(req),snapshot=systemSnapshot(),interfaces=new Set(snapshot.interfaces.map(item=>item.ifname));
    const customer=cleanText(db.prepare("SELECT value FROM settings WHERE key='network_customer_if'").get()?.value,30);
    const bridge=cleanText(db.prepare("SELECT value FROM settings WHERE key='network_bridge_if'").get()?.value,30);
    const input=Array.isArray(body.wans)?body.wans.slice(0,8):[],seen=new Set(),wans=[];
    for(const item of input){
      const interfaceName=cleanText(item.interface,30),detected=snapshot.interfaces.find(entry=>entry.ifname===interfaceName),gateway=cleanText(item.gateway||detected?.default_gateway,45),target=cleanText(item.health_target||'1.1.1.1',45),weight=int(item.weight,1,1,100);
      if(!interfaces.has(interfaceName)||interfaceName==='lo')return json(res,400,{error:`WAN interface ${interfaceName||'(empty)'} does not exist`});
      if(interfaceName===customer||interfaceName===bridge)return json(res,400,{error:`${interfaceName} is assigned to the customer network and cannot also be a WAN`});
      if(seen.has(interfaceName))return json(res,400,{error:`WAN interface ${interfaceName} is duplicated`});
      if(ipNumber(gateway)===null||ipNumber(target)===null)return json(res,400,{error:`${interfaceName} requires valid IPv4 gateway and health-check addresses`});
      seen.add(interfaceName);wans.push({interface:interfaceName,gateway,weight,health_target:target,enabled:item.enabled!==false});
    }
    const enabled=Boolean(body.enabled);
    if(enabled&&!wans.some(item=>item.enabled))return json(res,400,{error:'Add and enable at least one WAN before enabling Multi-WAN'});
    const set=db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`);
    set.run('multi_wan_config',JSON.stringify(wans),nowIso());set.run('multi_wan_enabled',enabled?'1':'0',nowIso());
    event('warning','network.multiwan_changed',enabled?'Multi-WAN enabled':'Multi-WAN disabled',{wans:wans.map(item=>({interface:item.interface,gateway:item.gateway,weight:item.weight,enabled:item.enabled}))});
    return json(res,200,{enabled,wans});
  }
  if (method === 'POST' && pathname === '/api/admin/network/user-speed') {
    const body = await readBody(req); const enabled = Boolean(body.enabled); const download = Number(body.download_mbps); const upload = Number(body.upload_mbps);
    if (!Number.isFinite(download) || download < 0.1 || download > 100000 || !Number.isFinite(upload) || upload < 0.1 || upload > 100000) return json(res, 400, { error: 'Download and upload speed must be between 0.1 and 100,000 Mbps' });
    const tidy = value => String(Number(value.toFixed(3))); const downloadText = tidy(download); const uploadText = tidy(upload); const rateLimit = `${downloadText}M/${uploadText}M`; const now = nowIso();
    const set = db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`);
    db.exec('BEGIN IMMEDIATE');
    try {
      set.run('global_user_speed_enabled', enabled ? '1' : '0', now); set.run('global_user_download_mbps', downloadText, now); set.run('global_user_upload_mbps', uploadText, now);
      const affected = enabled && body.apply_to_all_users ? Number(db.prepare(`UPDATE access_entitlements SET rate_limit=?,updated_at=? WHERE status IN ('active','paused')`).run(rateLimit, now).changes) : 0;
      db.exec('COMMIT'); event('warning', 'network.user_speed_changed', enabled ? `Global user speed set to ${rateLimit}` : 'Global user speed disabled', { rate_limit: rateLimit, affected_users: affected });
      return json(res, 200, { enabled, download_mbps: downloadText, upload_mbps: uploadText, rate_limit: rateLimit, affected_users: affected });
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  if (method === 'POST' && pathname === '/api/admin/network/settings') {
    const body=await readBody(req); const interfaces=new Set(fs.readdirSync('/sys/class/net')); const wan=cleanText(body.network_wan_if,30),customer=cleanText(body.network_customer_if,30),bridge=cleanText(body.network_bridge_if,30),mode=cleanText(body.network_mode,20);
    if(!interfaces.has(wan)||!interfaces.has(customer)||!['lan','bridge','vlan'].includes(mode))return json(res,400,{error:'Select valid WAN and customer interfaces'}); if(mode==='bridge'&&bridge&&!interfaces.has(bridge))return json(res,400,{error:'Selected AP bridge does not exist'});
    const down=int(body.cake_download_mbps,0,1,100000),up=int(body.cake_upload_mbps,0,1,100000);if(body.cake_enabled&&(!down||!up))return json(res,400,{error:'Valid SQM download and upload speeds are required'});
    const algorithm=cleanText(body.sqm_algorithm||'cake',20);if(!['cake','fq_codel'].includes(algorithm))return json(res,400,{error:'Select CAKE or FQ-CoDel'});
    const preset=cleanText(body.sqm_preset||'balanced',20);if(!['balanced','gaming','streaming','compatibility','custom'].includes(preset))return json(res,400,{error:'Select a valid Smart QoS preset'});
    const profile=cleanText(body.cake_profile||'diffserv4',20);if(!['besteffort','diffserv3','diffserv4','diffserv8'].includes(profile))return json(res,400,{error:'Select a valid CAKE traffic profile'});
    const rtt=int(body.cake_rtt_ms,100,1,1000),overhead=int(body.cake_overhead_bytes,0,-64,256);
    const fqTarget=int(body.fq_codel_target_ms,5,1,100),fqInterval=int(body.fq_codel_interval_ms,100,10,1000);
    const values={network_wan_if:wan,network_customer_if:customer,network_bridge_if:bridge,network_mode:mode,cake_enabled:body.cake_enabled?'1':'0',cake_download_mbps:String(down||100),cake_upload_mbps:String(up||50),sqm_algorithm:algorithm,sqm_preset:preset,cake_profile:profile,cake_rtt_ms:String(rtt),cake_overhead_bytes:String(overhead),cake_nat:body.cake_nat===false?'0':'1',cake_ack_filter:body.cake_ack_filter===false?'0':'1',fq_codel_target_ms:String(fqTarget),fq_codel_interval_ms:String(fqInterval),fq_codel_ecn:body.fq_codel_ecn===false?'0':'1'};const set=db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`);for(const [key,value]of Object.entries(values))set.run(key,value,nowIso());event('warning','network.settings_changed','Network settings updated',{wan,customer,bridge,mode,sqm_enabled:values.cake_enabled,sqm_algorithm:algorithm,sqm_preset:preset});return json(res,200,values);
  }
  const portalAssetMatch=pathname.match(/^\/api\/admin\/portal-assets\/(logo|banner|insert-sound|coin-sound)$/);
  if(method==='PUT'&&portalAssetMatch){
    const kind=portalAssetMatch[1],spec=PORTAL_ASSET_SPECS[kind],type=String(req.headers['content-type']||'').split(';')[0].trim().toLowerCase(),extension=spec.types[type];
    if(!extension)return json(res,415,{error:`Unsupported ${kind} file type`});
    const raw=await readRawBody(req,spec.limit);
    if(!raw.length||!validPortalAsset(raw,extension))return json(res,400,{error:`The uploaded ${kind} file is invalid`});
    const directory=PORTAL_UPLOAD_DIR;fs.mkdirSync(directory,{recursive:true});
    for(const name of fs.readdirSync(directory))if(name.startsWith(`portal-${kind}.`))fs.rmSync(path.join(directory,name),{force:true});
    const fileName=`portal-${kind}.${extension}`,filePath=path.join(directory,fileName);fs.writeFileSync(filePath,raw,{mode:0o644});
    const assetUrl=`/assets/uploads/${fileName}?v=${Date.now()}`;
    db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`).run(spec.setting,assetUrl,nowIso());
    staticFileCache.clear();event('info','branding.asset_uploaded',`Portal ${kind} updated`,{kind,size_bytes:raw.length});return json(res,201,{kind,url:assetUrl,size_bytes:raw.length});
  }
  if(method==='DELETE'&&portalAssetMatch){
    const kind=portalAssetMatch[1],spec=PORTAL_ASSET_SPECS[kind],directory=PORTAL_UPLOAD_DIR;
    if(fs.existsSync(directory))for(const name of fs.readdirSync(directory))if(name.startsWith(`portal-${kind}.`))fs.rmSync(path.join(directory,name),{force:true});
    db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value='',updated_at=excluded.updated_at`).run(spec.setting,'',nowIso());
    staticFileCache.clear();event('info','branding.asset_removed',`Portal ${kind} removed`,{kind});return json(res,200,{ok:true,kind});
  }
  if (method === 'GET' && pathname === '/api/admin/settings') return json(res,200,settingsMap());
  if (method === 'POST' && pathname === '/api/admin/settings') {
    const body=await readBody(req);
    const allowed=['brand_name','currency','timezone','support_text','portal_tagline','portal_headline','portal_announcement','portal_theme','portal_primary_color','portal_accent_color','auto_pause_reconnect_enabled'];
    const colorKeys=new Set(['portal_primary_color','portal_accent_color']);
    const values={};
    for(const key of allowed){
      if(!Object.hasOwn(body,key))continue;
      const value=key==='auto_pause_reconnect_enabled'?(String(body[key])==='1'?'1':'0'):cleanText(body[key],300);
      if(colorKeys.has(key)&&!/^#[0-9a-f]{6}$/i.test(value))return json(res,400,{error:`${key} must be a six-digit hex color`});
      if(key==='portal_theme'&&!PORTAL_THEMES.has(value))return json(res,400,{error:`portal_theme must be one of: ${[...PORTAL_THEMES].join(', ')}`});
      values[key]=value;
    }
    const preset=PORTAL_THEME_PRESETS[values.portal_theme];
    if(preset){
      if(!Object.hasOwn(values,'portal_primary_color'))values.portal_primary_color=preset.primary;
      if(!Object.hasOwn(values,'portal_accent_color'))values.portal_accent_color=preset.accent;
      const currentBanner=db.prepare("SELECT value FROM settings WHERE key='portal_banner_url'").get()?.value||'';
      const bundledBanners=new Set(Object.values(PORTAL_THEME_PRESETS).map(item=>item.banner));
      const currentTheme=db.prepare("SELECT value FROM settings WHERE key='portal_theme'").get()?.value||'';
      if(!currentBanner||bundledBanners.has(currentBanner)||currentTheme!==values.portal_theme)values.portal_banner_url=preset.banner;
    }
    const set=db.prepare(`INSERT INTO settings(key,value,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at`);
    for(const [key,value] of Object.entries(values))set.run(key,value,nowIso());
    event('info','branding.updated','Portal branding settings updated',{keys:Object.keys(values)});
    return json(res,200,settingsMap());
  }
  if (method === 'GET' && pathname === '/api/admin/backups') { const files=fs.existsSync(BACKUP_DIR)?fs.readdirSync(BACKUP_DIR).filter(name=>name.endsWith('.db')).map(name=>{const stat=fs.statSync(path.join(BACKUP_DIR,name));return{name,size_bytes:stat.size,created_at:stat.mtime.toISOString()};}).sort((a,b)=>b.created_at.localeCompare(a.created_at)):[]; return json(res,200,files); }
  if(method==='POST'&&pathname==='/api/admin/backups/delete-batch'){
    const body=await readBody(req),names=Array.isArray(body.names)?[...new Set(body.names.map(name=>cleanText(name,120)))]:[];
    if(!names.length||names.length>100||names.some(name=>!/^[A-Za-z0-9][A-Za-z0-9._-]*\.db$/.test(name)))return json(res,400,{error:'Select between 1 and 100 valid backups'});
    const queuedNames=new Set();
    for(const directory of [RESTORE_REQUEST_DIR,path.join(path.dirname(RESTORE_REQUEST_DIR),'restore-processing')]){
      try{for(const requestName of fs.readdirSync(directory).filter(file=>file.endsWith('.request'))){try{queuedNames.add(fs.readFileSync(path.join(directory,requestName),'utf8').split(/\r?\n/,1)[0])}catch{}}}catch{}
    }
    if(names.some(name=>queuedNames.has(name)))return json(res,409,{error:'A selected backup is in use by a pending restore. Wait for it to finish before deleting.'});
    let directoryReal;try{directoryReal=fs.realpathSync(BACKUP_DIR)}catch{return json(res,404,{error:'Backup directory not found'})}
    const files=[];
    for(const name of names){const file=path.join(BACKUP_DIR,name);let stat;try{stat=fs.lstatSync(file)}catch{return json(res,404,{error:`Backup not found: ${name}`})}if(stat.isSymbolicLink()||!stat.isFile())return json(res,400,{error:`Not a regular backup file: ${name}`});const real=fs.realpathSync(file);if(path.dirname(real)!==directoryReal)return json(res,400,{error:`Backup is outside the backup directory: ${name}`});files.push({name,file})}
    const deleted=[];for(const item of files){fs.unlinkSync(item.file);deleted.push(item.name)}
    event('warning','backup.batch_deleted',`Administrator deleted ${deleted.length} backup${deleted.length===1?'':'s'}`,{backups:deleted});return json(res,200,{deleted,deleted_count:deleted.length});
  }
  const backupDownloadMatch=pathname.match(/^\/api\/admin\/backups\/download\/([^/]+)$/);
  if(method==='GET'&&backupDownloadMatch){
    const name=decodeURIComponent(backupDownloadMatch[1]);if(!/^[A-Za-z0-9][A-Za-z0-9._-]*\.db$/.test(name))return json(res,404,{error:'Backup not found'});
    const file=path.join(BACKUP_DIR,name);if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())return json(res,404,{error:'Backup not found'});let real;try{real=fs.realpathSync(file)}catch{return json(res,404,{error:'Backup not found'})}
    if(path.dirname(real)!==fs.realpathSync(BACKUP_DIR)||!fs.statSync(real).isFile())return json(res,404,{error:'Backup not found'});
    const stat=fs.statSync(real);res.writeHead(200,{'content-type':'application/octet-stream','content-length':stat.size,'content-disposition':`attachment; filename="${name}"`,'cache-control':'no-store','x-content-type-options':'nosniff'});fs.createReadStream(real).pipe(res);return;
  }
  if(method==='POST'&&(pathname==='/api/admin/backups/restore'||pathname==='/api/admin/backups/verify')){
    const body=await readBody(req),name=cleanText(body.name,120);
    const operation=pathname.endsWith('/verify')?'test':'apply';
    if(operation==='apply'&&body.confirmation!=='RESTORE')return json(res,400,{error:'Type RESTORE to confirm database replacement'});
    if(!/^[A-Za-z0-9][A-Za-z0-9._-]*\.db$/.test(name))return json(res,400,{error:'Select a valid backup'});
    const file=path.join(BACKUP_DIR,name);if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())return json(res,400,{error:'Backup symlinks are not allowed'});let real;try{real=fs.realpathSync(file)}catch{return json(res,404,{error:'Backup not found'})}
    if(path.dirname(real)!==fs.realpathSync(BACKUP_DIR)||!fs.statSync(real).isFile())return json(res,404,{error:'Backup not found'});
    let check;
    try{check=new DatabaseSync(real,{readOnly:true});const integrity=check.prepare('PRAGMA integrity_check').get()?.integrity_check;const required=check.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('settings','zones','machines','rates','access_entitlements')").get()?.count;if(integrity!=='ok'||Number(required)!==5)return json(res,400,{error:'Backup failed SQLite integrity or VendoOS schema validation'});}finally{check?.close()}
    if(!fs.existsSync(RESTORE_REQUEST_DIR)||!fs.existsSync(RESTORE_STATUS_DIR))return json(res,503,{error:'Admin restore service is not installed'});
    if(fs.readdirSync(RESTORE_REQUEST_DIR).some(fileName=>fileName.endsWith('.request')))return json(res,409,{error:'A database restore is already queued'});
    const id=crypto.randomUUID().replace(/-/g,''),temporary=path.join(RESTORE_REQUEST_DIR,`${id}.tmp`),request=path.join(RESTORE_REQUEST_DIR,`${id}.request`);
    fs.writeFileSync(temporary,`${name}\n${id}\n${operation}\n`,{mode:0o600,flag:'wx'});
    event(operation==='apply'?'warning':'info',operation==='apply'?'backup.restore_requested':'backup.restore_verified',`${operation==='apply'?'Administrator requested restore from':'Administrator requested restore test for'} ${name}`,{backup:name,request_id:id});
    json(res,202,{id,status:'queued'});
    setTimeout(()=>{try{fs.renameSync(temporary,request)}catch(error){try{fs.unlinkSync(temporary)}catch{};try{event('error','backup.restore_queue_failed','Unable to queue database restore',{id,error:error.message})}catch{}}},700);
    return;
  }
  if(method==='GET'&&pathname==='/api/admin/backups/restore-status'){
    const id=String(new URL(req.url,'http://localhost').searchParams.get('id')||'');if(!/^[a-f0-9]{32}$/.test(id))return json(res,400,{error:'Invalid restore request id'});
    const statusFile=path.join(RESTORE_STATUS_DIR,`${id}.json`);try{return json(res,200,JSON.parse(fs.readFileSync(statusFile,'utf8')))}catch{return json(res,200,{id,status:'queued',message:'Waiting for the restore service'})}
  }
  if (method === 'POST' && pathname === '/api/admin/backups') {
    const name=`vendo-${new Date().toISOString().replace(/[:.]/g,'-')}.db`,target=path.join(BACKUP_DIR,name);
    fs.mkdirSync(BACKUP_DIR,{recursive:true});db.exec(`VACUUM INTO '${target.replace(/'/g,"''")}'`);
    let check;
    try {
      check=new DatabaseSync(target,{readOnly:true});
      const integrity=check.prepare('PRAGMA integrity_check').get()?.integrity_check;
      const required=check.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name IN ('settings','zones','machines','rates','access_entitlements')").get()?.count;
      if(integrity!=='ok'||Number(required)!==5)throw new Error('Created backup did not pass integrity and schema validation');
    } catch(error) { try{check?.close()}catch{};try{fs.unlinkSync(target)}catch{};throw error; }
    check.close();event('info','backup.created',`Backup ${name} created and validated`);return json(res,201,{name,verified:true});
  }
  if (method === 'GET' && pathname === '/api/admin/firmware') return json(res,200,db.prepare("SELECT id,version,board,file_name,sha256,size_bytes,created_at,CASE WHEN length(signature)=64 THEN 1 ELSE 0 END signed FROM firmware_releases WHERE enabled=1 ORDER BY id DESC").all());
  if (method === 'GET' && pathname === '/api/admin/firmware/status') return json(res, 200, firmwareFleetStatus());
  const adminFirmwareDownload = pathname.match(/^\/api\/admin\/firmware\/(\d+)\/download$/);
  if (method === 'GET' && adminFirmwareDownload) {
    const release = db.prepare('SELECT * FROM firmware_releases WHERE id=? AND enabled=1').get(Number(adminFirmwareDownload[1]));
    if (!release || !fs.existsSync(release.file_path)) return json(res, 404, { error: 'Firmware file is unavailable' });
    const filename = path.basename(release.file_name).replace(/[^A-Za-z0-9._-]/g, '_');
    res.setHeader('content-disposition', `attachment; filename="${filename}"`);
    return sendFile(req, res, release.file_path);
  }
  if (method === 'PUT' && pathname === '/api/admin/firmware') {
    const raw=await readRawBody(req); const version=cleanText(req.headers['x-firmware-version'],40); const board=cleanText(req.headers['x-firmware-board'],40);
    if(!raw.length||!version||!board)return json(res,400,{error:'Firmware file, version and board are required'});
    if(!/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(version))return json(res,400,{error:'Version must use semantic version format, for example 0.3.1'});
    if(!isEspBoard(board))return json(res,400,{error:'Board must be ESP8266, ESP32, or a named ESP variant'});
    if(raw.length<4||raw[0]!==0xe9)return json(res,400,{error:'The uploaded file is not a valid ESP firmware image'});
    const fileName=`${board.replace(/[^a-z0-9_-]/gi,'_')}-${version.replace(/[^a-z0-9_.-]/gi,'_')}.bin`; const filePath=path.join(BACKUP_DIR,fileName); fs.writeFileSync(filePath,raw,{mode:0o640}); const digest=sha(raw),signature=otaSignature(digest);
    db.prepare(`INSERT INTO firmware_releases(version,board,file_name,file_path,sha256,signature,size_bytes) VALUES(?,?,?,?,?,?,?) ON CONFLICT(version,board) DO UPDATE SET file_name=excluded.file_name,file_path=excluded.file_path,sha256=excluded.sha256,signature=excluded.signature,size_bytes=excluded.size_bytes,enabled=1,created_at=CURRENT_TIMESTAMP`).run(version,board,fileName,filePath,digest,signature,raw.length);
    event('info','firmware.uploaded',`${board} firmware ${version} uploaded`,{board,version,sha256:digest,size_bytes:raw.length});
    return json(res,201,{version,board,file_name:fileName,sha256:digest,size_bytes:raw.length});
  }
  if (method === 'POST' && pathname === '/api/admin/firmware/deploy') {
    const body=await readBody(req);
    if(body.all_esp){
      const releases=db.prepare('SELECT * FROM firmware_releases WHERE enabled=1 ORDER BY id DESC').all(),latest=new Map();
      releases.forEach(release=>{if(!latest.has(release.board))latest.set(release.board,release)});
      const machines=db.prepare(`SELECT id,name,board,firmware_version FROM machines WHERE enabled=1 AND (board LIKE 'ESP8266%' OR board LIKE 'ESP32%')`).all();
      const grouped=new Map(); machines.forEach(machine=>{if(!grouped.has(machine.board))grouped.set(machine.board,[]);grouped.get(machine.board).push(machine)});
      const totals={queued:0,already_current:0,already_queued:0,without_release:0,rollouts:[]};
      for(const [board,boardMachines] of grouped){
        const release=latest.get(board); if(!release||!release.signature||release.signature!==otaSignature(release.sha256)){totals.without_release+=boardMachines.length;continue}
        const result=createFirmwareRollout(release,boardMachines); totals.rollouts.push(result); totals.queued+=Number(result.queued||0); totals.already_current+=Number(result.already_current||0); totals.already_queued+=Number(result.already_queued||0);
      }
      event('warning','firmware.deployed_all','Fleet OTA requested from the admin dashboard',totals);
      return json(res,202,totals);
    }
    const release=db.prepare('SELECT * FROM firmware_releases WHERE id=? AND enabled=1').get(int(body.release_id,0,1)); if(!release)return json(res,404,{error:'Firmware release not found'});
    if(!release.signature||release.signature!==otaSignature(release.sha256))return json(res,409,{error:'Firmware release is unsigned or its controller signature is invalid. Upload the BIN again before deployment.'});
    let machines;
    if(Array.isArray(body.machine_ids)&&body.machine_ids.length){
      const ids=[...new Set(body.machine_ids.map(value=>int(value,0,1)).filter(Boolean))]; const placeholders=ids.map(()=>'?').join(',');
      machines=db.prepare(`SELECT id,name,board,firmware_version FROM machines WHERE enabled=1 AND id IN (${placeholders})`).all(...ids);
      if(machines.some(machine=>machine.board!==release.board))return json(res,409,{error:`Selected stations must use ${release.board}`});
    }else machines=db.prepare('SELECT id,name,board,firmware_version FROM machines WHERE enabled=1 AND board=?').all(release.board);
    const result=body.strategy==='canary'?createFirmwareRollout(release,machines):queueFirmwareForMachines(release,machines);
    event('warning','firmware.deployed',`${release.board} firmware ${release.version} queued`,{release_id:release.id,...result});
    return json(res,202,result);
  }
  const firmwareDownload=pathname.match(/^\/api\/device\/firmware\/(\d+)$/);
  if(method==='GET'&&firmwareDownload){const machine=machineAuth(req,res);if(!machine)return;const release=db.prepare('SELECT * FROM firmware_releases WHERE id=? AND enabled=1').get(Number(firmwareDownload[1]));if(!release)return json(res,404,{error:'Firmware not found'});if(release.board!==machine.board)return json(res,409,{error:'Firmware board does not match this station'});return sendFile(req,res,release.file_path);}

  if (method === 'GET') {
    const mac = resolveMac(req); const state = mac ? accessState(requestZone(req).id, mac) : { status: 'none' };
    if (state.status !== 'active') { res.writeHead(302, { location: PORTAL_URL, 'cache-control': 'no-store' }); return res.end(); }
  }
  return json(res, 404, { error: 'Not found' });
}

const server = http.createServer((req, res) => {
  requestMetrics.total += 1; requestMetrics.active += 1; requestMetrics.peak_active = Math.max(requestMetrics.peak_active, requestMetrics.active);
  let recorded = false; const record = () => { if (recorded) return; recorded = true; requestMetrics.active = Math.max(0, requestMetrics.active - 1); requestMetrics.completed += 1; if (res.statusCode >= 500) requestMetrics.errors += 1; };
  res.once('finish', record); res.once('close', record);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  res.setHeader('content-security-policy', "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  route(req, res).catch(error => {
    console.error(error);
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : 'Internal server error' });
    else res.end();
  });
});
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
server.requestTimeout = 30000;
server.maxRequestsPerSocket = 1000;
server.maxConnections = 5000;

sampleSystemUsage();
// Finalize unattended coin sessions promptly when the customer-facing countdown reaches zero.
const maintenance = setInterval(() => cleanup(true), 1000);
const usageSampler = setInterval(sampleSystemUsage, 5000);
server.listen(PORT, HOST, () => console.log(`Debian VendoOS listening on http://${HOST}:${PORT}`));
function shutdown() { clearInterval(maintenance); clearInterval(usageSampler); server.close(() => { db.close(); process.exit(0); }); setTimeout(() => process.exit(1), 5000).unref(); }
process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);

