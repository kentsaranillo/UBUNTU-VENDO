'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DB_FILE = path.resolve(process.env.DB_FILE || path.join(DATA_DIR, 'vendo.db'));
const INTERVAL_MS = Math.max(500, Number(process.env.ACCESS_SYNC_MS || 2000));
const DRY_RUN = process.env.NFT_DRY_RUN === '1';
const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA busy_timeout=5000;');

let previousNft = '';
let previousLimits = '';
let previousInterfaces = new Set();
const accountingBaselines = new Map();
function nftBatch() {
  const now = Date.now();
  const rows = db.prepare(`SELECT client_mac,expires_at FROM access_entitlements
    WHERE status='active' AND expires_at IS NOT NULL AND expires_at>datetime('now') ORDER BY client_mac`).all();
  const lines = ['flush set inet vendo allowed_macs'];
  for (const row of rows) {
    const ttl = Math.max(1, Math.ceil((Date.parse(row.expires_at) - now) / 1000));
    lines.push(`add element inet vendo allowed_macs { ${row.client_mac.toLowerCase()} timeout ${ttl}s }`);
  }
  return lines.join('\n') + '\n';
}

function setting(key) {
  return db.prepare('SELECT value FROM settings WHERE key=?').get(key)?.value || '';
}

function customerInterface(zone) {
  if (Number(zone.managed) && zone.parent_if && Number(zone.vlan_id)) return `${zone.parent_if}.${zone.vlan_id}`.slice(0, 15);
  const bridge = setting('network_bridge_if');
  return setting('network_mode') === 'bridge' && bridge ? bridge : setting('network_customer_if');
}

function tcRate(value) {
  const match = String(value || '').trim().match(/^([1-9]\d*(?:\.\d+)?)([KMG])$/i);
  return match ? `${match[1]}${match[2].toLowerCase()}bit` : '';
}

function limitRows() {
  return db.prepare(`SELECT a.id,a.ip_address,a.rate_limit,z.managed,z.parent_if,z.vlan_id
    FROM access_entitlements a JOIN zones z ON z.id=a.zone_id
    WHERE a.status='active' AND a.expires_at IS NOT NULL AND a.expires_at>datetime('now')
      AND a.ip_address IS NOT NULL AND a.ip_address<>''
    ORDER BY a.id`).all().map(row => {
      const [download, upload] = String(row.rate_limit || '').split('/').map(tcRate);
      return { ...row, interface: customerInterface(row), download, upload };
    }).filter(row => row.interface && row.download && row.upload && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(row.ip_address));
}

function tc(args, ignoreError = false) {
  if (DRY_RUN) { process.stdout.write(`tc ${args.join(' ')}\n`); return; }
  try { execFileSync('/usr/sbin/tc', args, { encoding: 'utf8', timeout: 5000, stdio: 'ignore' }); }
  catch (error) { if (!ignoreError) throw error; }
}

function nft(args, input = null) {
  if (DRY_RUN) return '';
  return execFileSync('/usr/sbin/nft', args, { input, encoding: 'utf8', timeout: 5000 });
}

function accountingElements(name) {
  const parsed = JSON.parse(nft(['-j', 'list', 'set', 'inet', 'vendo', name]) || '{"nftables":[]}');
  const set = parsed.nftables.map(item => item.set).find(Boolean) || {};
  const counters = new Map();
  for (const item of set.elem || []) {
    const element = item?.elem || item;
    const value = typeof element === 'string' ? element : element?.val;
    const bytes = Number(element?.counter?.bytes ?? item?.counter?.bytes ?? 0);
    if (value) counters.set(String(value), Number.isFinite(bytes) ? bytes : 0);
  }
  return counters;
}

function changeAccountingElement(action, name, ip) {
  nft([action, 'element', 'inet', 'vendo', name, `{ ${ip} }`]);
}

function syncAccounting() {
  if (DRY_RUN) return;
  const rows = db.prepare(`SELECT id,ip_address FROM access_entitlements
    WHERE status='active' AND expires_at IS NOT NULL AND expires_at>datetime('now')
      AND ip_address GLOB '[0-9]*.[0-9]*.[0-9]*.[0-9]*' ORDER BY id`).all();
  const desired = new Set(rows.map(row => row.ip_address));
  const directions = [
    { set: 'accounting_download', column: 'bytes_in' },
    { set: 'accounting_upload', column: 'bytes_out' }
  ];
  for (const direction of directions) {
    const current = accountingElements(direction.set);
    for (const row of rows) {
      const key = `${direction.set}:${row.ip_address}`;
      if (!current.has(row.ip_address)) {
        changeAccountingElement('add', direction.set, row.ip_address);
        accountingBaselines.set(key, 0);
        continue;
      }
      const bytes = current.get(row.ip_address) || 0;
      const previous = accountingBaselines.get(key);
      if (previous !== undefined) {
        const delta = bytes >= previous ? bytes - previous : bytes;
        if (delta > 0) db.prepare(`UPDATE access_entitlements SET ${direction.column}=${direction.column}+? WHERE id=?`).run(delta, row.id);
      }
      accountingBaselines.set(key, bytes);
    }
    for (const ip of current.keys()) {
      if (desired.has(ip)) continue;
      changeAccountingElement('delete', direction.set, ip);
      accountingBaselines.delete(`${direction.set}:${ip}`);
    }
  }
}

function syncLimits() {
  const rows = limitRows();
  const signature = JSON.stringify(rows.map(row => [row.id, row.interface, row.ip_address, row.download, row.upload]));
  if (signature === previousLimits) return;
  const desiredInterfaces = new Set(rows.map(row => row.interface));
  const interfaces = new Set([...previousInterfaces, ...desiredInterfaces]);
  for (const iface of interfaces) {
    if (!DRY_RUN && !fs.existsSync(`/sys/class/net/${iface}`)) continue;
    tc(['qdisc', 'add', 'dev', iface, 'clsact'], true);
    tc(['filter', 'del', 'dev', iface, 'ingress', 'protocol', 'ip', 'pref', '40000'], true);
    tc(['filter', 'del', 'dev', iface, 'egress', 'protocol', 'ip', 'pref', '40000'], true);
  }
  for (const row of rows) {
    if (!DRY_RUN && !fs.existsSync(`/sys/class/net/${row.interface}`)) continue;
    tc(['filter', 'add', 'dev', row.interface, 'ingress', 'protocol', 'ip', 'pref', '40000', 'flower', 'src_ip', `${row.ip_address}/32`, 'action', 'police', 'rate', row.upload, 'burst', '64k', 'conform-exceed', 'drop']);
    tc(['filter', 'add', 'dev', row.interface, 'egress', 'protocol', 'ip', 'pref', '40000', 'flower', 'dst_ip', `${row.ip_address}/32`, 'action', 'police', 'rate', row.download, 'burst', '64k', 'conform-exceed', 'drop']);
  }
  previousInterfaces = desiredInterfaces;
  previousLimits = signature;
}

function sync() {
  try {
    const batch = nftBatch();
    if (batch !== previousNft) {
      if (DRY_RUN) process.stdout.write(batch);
      else execFileSync('/usr/sbin/nft', ['-f', '-'], { input: batch, encoding: 'utf8', timeout: 5000 });
      previousNft = batch;
    }
    syncLimits();
    try { syncAccounting(); }
    catch (error) { console.error(`Traffic accounting failed: ${error.message}`); }
  } catch (error) {
    console.error(`Access sync failed: ${error.message}`);
  }
}

sync();
setInterval(sync, INTERVAL_MS);
function shutdown() { try { db.close(); } finally { process.exit(0); } }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

