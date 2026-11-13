'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DB_FILE = path.resolve(process.env.DB_FILE || path.join(DATA_DIR, 'vendo.db'));
const RUN_DIR = '/run/debian-vendoos';
const CONFIG_FILE = path.join(RUN_DIR, 'dnsmasq-vlans.conf');
const CAKE_STATUS_FILE = path.join(RUN_DIR, 'cake-status.json');
const CLIENT_DNS = '8.8.8.8,1.1.1.1';
const db = new DatabaseSync(DB_FILE, { readOnly: true });
db.exec('PRAGMA busy_timeout=5000;');
fs.mkdirSync(RUN_DIR, { recursive: true });
let previous = '';
let previousInterfaceSignature = '';
let lastInterfaceReconcileAt = 0;

function run(file, args, ignore = false) {
  try { return execFileSync(file, args, { encoding: 'utf8', timeout: 5000 }); }
  catch (error) { if (!ignore) throw error; return ''; }
}
function interfaceName(zone) { return `${zone.parent_if}.${zone.vlan_id}`.slice(0, 15); }
function settings() { return Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(item => [item.key, item.value])); }
function configuredWans(config) {
  if (config.multi_wan_enabled === '1') {
    try {
      const rows = JSON.parse(config.multi_wan_config || '[]');
      const names = rows.filter(item => item?.enabled !== false).map(item => item.interface).filter(Boolean);
      if (names.length) return [...new Set(names)];
    } catch {}
  }
  return config.network_wan_if ? [config.network_wan_if] : [];
}
function syncNftSet(name, desired) {
  const output = run('/usr/sbin/nft', ['list', 'set', 'inet', 'vendo', name], true);
  const current = new Set([...output.matchAll(/"([A-Za-z0-9_.:-]+)"/g)].map(match => match[1]));
  for (const item of desired) if (!current.has(item)) run('/usr/sbin/nft', ['add', 'element', 'inet', 'vendo', name, `{ "${item}" }`], true);
  for (const item of current) if (!desired.has(item)) run('/usr/sbin/nft', ['delete', 'element', 'inet', 'vendo', name, `{ "${item}" }`], true);
}
function cakeOptions(config, direction) {
  const profile = ['besteffort', 'diffserv3', 'diffserv4', 'diffserv8'].includes(config.cake_profile) ? config.cake_profile : 'diffserv4';
  const rtt = Math.max(1, Math.min(1000, Number(config.cake_rtt_ms) || 100));
  const overhead = Math.max(-64, Math.min(256, Number(config.cake_overhead_bytes) || 0));
  return [profile, 'bandwidth', direction === 'download' ? `${Number(config.cake_download_mbps)}mbit` : `${Number(config.cake_upload_mbps)}mbit`, 'rtt', `${rtt}ms`, 'overhead', String(overhead), direction === 'download' ? 'dual-dsthost' : 'dual-srchost', ...(direction === 'upload' && config.cake_nat !== '0' ? ['nat'] : ['nonat']), ...(direction === 'upload' && config.cake_ack_filter !== '0' ? ['ack-filter'] : ['no-ack-filter']), 'wash'];
}
function applyCake(name, config, direction) {
  if (!name) return { interface: name, direction, state: 'skipped' };
  try {
    run('/usr/sbin/tc', ['qdisc', 'replace', 'dev', name, 'root', 'cake', ...cakeOptions(config, direction)]);
    return { interface: name, direction, state: 'active' };
  } catch (error) {
    return { interface: name, direction, state: 'failed', error: String(error.stderr || error.message).trim().slice(0, 300) };
  }
}
function applyFqCodel(name, config, direction) {
  if (!name) return { interface: name, direction, state: 'skipped', algorithm: 'fq_codel' };
  const rate = direction === 'download' ? Number(config.cake_download_mbps) : Number(config.cake_upload_mbps);
  const target = Math.max(1, Math.min(100, Number(config.fq_codel_target_ms) || 5));
  const interval = Math.max(10, Math.min(1000, Number(config.fq_codel_interval_ms) || 100));
  try {
    run('/usr/sbin/tc', ['qdisc', 'replace', 'dev', name, 'root', 'handle', '1:', 'htb', 'default', '10']);
    run('/usr/sbin/tc', ['class', 'replace', 'dev', name, 'parent', '1:', 'classid', '1:10', 'htb', 'rate', `${rate}mbit`, 'ceil', `${rate}mbit`, 'burst', '32k']);
    run('/usr/sbin/tc', ['qdisc', 'replace', 'dev', name, 'parent', '1:10', 'handle', '10:', 'fq_codel', 'limit', '10240', 'flows', '1024', 'target', `${target}ms`, 'interval', `${interval}ms`, 'quantum', '1514', config.fq_codel_ecn === '0' ? 'noecn' : 'ecn']);
    return { interface: name, direction, state: 'active', algorithm: 'fq_codel', rate_mbps: rate };
  } catch (error) {
    return { interface: name, direction, state: 'failed', algorithm: 'fq_codel', error: String(error.stderr || error.message).trim().slice(0, 300) };
  }
}
function applySqm(name, config, direction) {
  if (config.sqm_algorithm === 'fq_codel') return applyFqCodel(name, config, direction);
  const cake = applyCake(name, config, direction);
  if (cake.state === 'active') return { ...cake, algorithm: 'cake' };
  clearCake(name);
  const fallback = applyFqCodel(name, config, direction);
  if (fallback.state === 'active') return { ...fallback, state: 'degraded', requested_algorithm: 'cake', fallback_reason: cake.error };
  return { ...cake, algorithm: 'cake', fallback_error: fallback.error };
}
function clearCake(name) { if (name) run('/usr/sbin/tc', ['qdisc', 'delete', 'dev', name, 'root'], true); }
function writeCakeStatus(value) { fs.writeFileSync(CAKE_STATUS_FILE, JSON.stringify({ ...value, updated_at: new Date().toISOString() }), { mode: 0o644 }); }
function applyRoutingTuning() {
  for (const setting of ['net.ipv4.ip_forward=1','net.ipv4.tcp_mtu_probing=1','net.ipv4.conf.all.rp_filter=2','net.ipv4.conf.default.rp_filter=2','net.netfilter.nf_conntrack_tcp_timeout_established=86400']) run('/usr/sbin/sysctl', ['-w', setting], true);
}

function sync() {
  try {
    const config = settings();
    const all = db.prepare('SELECT * FROM zones WHERE managed=1 ORDER BY id').all();
    const active = all.filter(zone => zone.enabled);
    const main = db.prepare('SELECT * FROM zones WHERE managed=0 AND enabled=1 ORDER BY id LIMIT 1').get();
    const customer = config.network_mode === 'bridge' && config.network_bridge_if ? config.network_bridge_if : config.network_customer_if;
    const wans = configuredWans(config);
    const customerInterfaces = new Set(customer ? [customer] : []);
    const interfaceSignature = JSON.stringify({ zones: all.map(zone => [zone.id, zone.enabled, zone.parent_if, zone.vlan_id, zone.gateway, zone.subnet, zone.netmask]), customer, main: main && [main.gateway, main.subnet, main.netmask] });
    const reconcileInterfaces = interfaceSignature !== previousInterfaceSignature || Date.now() - lastInterfaceReconcileAt >= 30000;
    if (reconcileInterfaces) {
      for (const zone of all) {
        const name = interfaceName(zone);
        if (!zone.enabled) { run('/usr/sbin/ip', ['link', 'delete', name], true); continue; }
        if (!run('/usr/sbin/ip', ['link', 'show', name], true)) run('/usr/sbin/ip', ['link', 'add', 'link', zone.parent_if, 'name', name, 'type', 'vlan', 'id', String(zone.vlan_id)]);
        run('/usr/sbin/ip', ['link', 'set', name, 'up']);
        run('/usr/sbin/ip', ['address', 'replace', `${zone.gateway}/${zone.subnet.split('/')[1]}`, 'dev', name]);
        customerInterfaces.add(name);
      }
      if (customer && main) {
        run('/usr/sbin/ip', ['link', 'set', customer, 'up']);
        run('/usr/sbin/ip', ['address', 'replace', `${main.gateway}/${main.subnet.split('/')[1]}`, 'dev', customer]);
      }
      previousInterfaceSignature = interfaceSignature;
      lastInterfaceReconcileAt = Date.now();
    } else {
      for (const zone of active) customerInterfaces.add(interfaceName(zone));
    }
    syncNftSet('customer_interfaces', customerInterfaces);
    syncNftSet('wan_interfaces', new Set(wans));

    const signature = JSON.stringify({ active: active.map(zone => [zone.id, zone.updated_at]), customer, wans, mode: config.network_mode, sqm: config.cake_enabled, algorithm: config.sqm_algorithm, preset: config.sqm_preset, down: config.cake_download_mbps, up: config.cake_upload_mbps, profile: config.cake_profile, rtt: config.cake_rtt_ms, overhead: config.cake_overhead_bytes, nat: config.cake_nat, ack: config.cake_ack_filter, fqTarget: config.fq_codel_target_ms, fqInterval: config.fq_codel_interval_ms, fqEcn: config.fq_codel_ecn });
    if (signature !== previous) {
      applyRoutingTuning();
      const lines = ['# Generated by VendoOS network sync'];
      if (customer && main) lines.push(`interface=${customer}`, `dhcp-range=${customer},${process.env.DHCP_START || '10.88.0.20'},${process.env.DHCP_END || '10.88.0.250'},${main.netmask || '255.255.255.0'},${process.env.DHCP_LEASE || '12h'}`, `dhcp-option=${customer},option:router,${main.gateway}`, `dhcp-option=${customer},option:dns-server,${CLIENT_DNS}`);
      for (const zone of active) {
        const name = interfaceName(zone);
        lines.push(`interface=${name}`, `dhcp-range=${name},${zone.dhcp_start},${zone.dhcp_end},${zone.netmask},12h`, `dhcp-option=${name},option:router,${zone.gateway}`, `dhcp-option=${name},option:dns-server,${CLIENT_DNS}`);
      }
      fs.writeFileSync(CONFIG_FILE, `${lines.join('\n')}\n`, { mode: 0o644 });
      const downloadInterfaces = new Set(customer ? [customer] : []);
      for (const zone of active) downloadInterfaces.add(interfaceName(zone));
      if (config.cake_enabled === '1') {
        run('/usr/sbin/modprobe', ['sch_cake'], true);
        run('/usr/sbin/modprobe', ['sch_fq_codel'], true);
        const interfaces = [...downloadInterfaces].map(name => applySqm(name, config, 'download'));
        interfaces.push(...wans.map(name => applySqm(name, config, 'upload')));
        const failed = interfaces.filter(item => item.state === 'failed');
        const degraded = interfaces.filter(item => item.state === 'degraded');
        writeCakeStatus({ enabled: true, state: failed.length ? 'failed' : degraded.length ? 'degraded' : 'active', algorithm: config.sqm_algorithm || 'cake', preset: config.sqm_preset || 'balanced', interfaces, error: failed.map(item => `${item.interface}: ${item.error}`).join('; ') });
      } else {
        for (const name of downloadInterfaces) clearCake(name);
        for (const wan of wans) clearCake(wan);
        writeCakeStatus({ enabled: false, state: 'disabled', algorithm: config.sqm_algorithm || 'cake', preset: config.sqm_preset || 'balanced', interfaces: [] });
      }
      if (previous) run('/usr/bin/systemctl', ['try-restart', 'vendo-dnsmasq.service'], true);
      previous = signature;
    }
  } catch (error) { console.error(`Network sync failed: ${error.message}`); writeCakeStatus({ enabled: false, state: 'failed', algorithm: null, interfaces: [], error: error.message }); }
}

sync();
const timer = setInterval(sync, 3000);
function shutdown() { clearInterval(timer); try { db.close(); } finally { process.exit(0); } }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
