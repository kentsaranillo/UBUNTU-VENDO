'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execAsync = promisify(execFile);
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const DB_FILE = path.resolve(process.env.DB_FILE || path.join(DATA_DIR, 'vendo.db'));
const RUN_DIR = '/run/debian-vendoos';
const STATUS_FILE = path.join(RUN_DIR, 'multiwan-status.json');
const INTERFACE_STATUS_FILE = path.join(RUN_DIR, 'interface-sync-status.json');
const PBR_STATUS_FILE = path.join(RUN_DIR, 'pbr-status.json');
const PBR_TABLE = 'vendo_pbr';
const NETPLAN_FILE = '/etc/netplan/90-vendoos-interfaces.yaml';
const INTERFACE_SETTING_PREFIX = 'network_interface_config:';
const INTERFACE_SECRET_PREFIX = 'network_interface_secret:';
const PPP_PEERS_DIR = '/etc/ppp/peers';
const PPP_PEER_PREFIX = 'vendoos-';
const ROUTE_METRIC = '20';
const ROUTE_PROTOCOL = '186';
const db = new DatabaseSync(DB_FILE, { readOnly: true });
db.exec('PRAGMA busy_timeout=5000;');
fs.mkdirSync(RUN_DIR, { recursive: true });

const linkState = new Map();
let appliedSignature = '';
let interfaceSignature = '';
let pbrSignature = '';

function run(file, args, ignore = false) {
  try { return execFileSync(file, args, { encoding: 'utf8', timeout: 5000 }).trim(); }
  catch (error) { if (!ignore) throw error; return ''; }
}
function settings() {
  return Object.fromEntries(db.prepare('SELECT key,value FROM settings').all().map(item => [item.key, item.value]));
}

function writeJson(file, value) {
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o644 });
  fs.renameSync(temporary, file);
}
function interfaceConfigurations(values) {
  const items = [];
  for (const [key, value] of Object.entries(values)) {
    if (!key.startsWith(INTERFACE_SETTING_PREFIX)) continue;
    const interfaceName = key.slice(INTERFACE_SETTING_PREFIX.length);
    if (!/^[A-Za-z0-9_.:-]+$/.test(interfaceName) || interfaceName === 'lo') continue;
    try {
      const config = JSON.parse(value);
      if (config && ['dhcp', 'static', 'pppoe'].includes(config.mode)) items.push({ interface: interfaceName, ...config, password: values[`${INTERFACE_SECRET_PREFIX}${interfaceName}`] || '' });
    } catch {}
  }
  return items.sort((a, b) => a.interface.localeCompare(b.interface));
}
function netplanYaml(items) {
  const lines = ['network:', '  version: 2', '  renderer: networkd', '  ethernets:'];
  for (const item of items) {
    lines.push(`    ${item.interface}:`, '      optional: true', `      dhcp4: ${item.mode === 'dhcp' ? 'true' : 'false'}`, '      dhcp6: false');
    if (item.mode === 'dhcp') lines.push('      dhcp4-overrides:', `        route-metric: ${Number(item.cost) || 100}`);
    else if (item.mode === 'static') {
      lines.push('      addresses:', `        - ${item.address}`);
      if (item.gateway) lines.push('      routes:', '        - to: default', `          via: ${item.gateway}`, `          metric: ${Number(item.cost) || 100}`);
    }
    if (Array.isArray(item.dns) && item.dns.length) lines.push('      nameservers:', '        addresses:', ...item.dns.map(server => `          - ${server}`));
  }
  return lines.join('\n') + '\n';
}
function peerName(interfaceName) { return `${PPP_PEER_PREFIX}${createHash('sha256').update(interfaceName).digest('hex').slice(0, 10)}`; }
function pppInterfaceName(interfaceName) { return `ppp-${createHash('sha256').update(interfaceName).digest('hex').slice(0, 8)}`; }
function pppQuote(value) { return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`; }
function pppPeer(item) {
  const mtu = Math.max(576, Math.min(1492, Number(item.mtu) || 1492)), lines = [
    'plugin rp-pppoe.so', `nic-${item.interface}`, `user ${pppQuote(item.pppoe_username)}`, `password ${pppQuote(item.password)}`,
    `ifname ${pppInterfaceName(item.interface)}`, 'noauth', 'persist', 'maxfail 0', 'holdoff 5', 'hide-password',
    'lcp-echo-interval 10', 'lcp-echo-failure 3', `mtu ${mtu}`, `mru ${mtu}`, 'defaultroute', `defaultroute-metric ${Number(item.cost) || 100}`
  ];
  if (item.pppoe_service) lines.push(`rp_pppoe_service ${pppQuote(item.pppoe_service)}`);
  if (!Array.isArray(item.dns) || !item.dns.length) lines.push('usepeerdns');
  return lines.join('\n') + '\n';
}
function syncPppoe(items) {
  fs.mkdirSync(PPP_PEERS_DIR, { recursive: true, mode: 0o755 });
  const active = new Set(items.filter(item => item.mode === 'pppoe').map(item => peerName(item.interface)));
  for (const file of fs.readdirSync(PPP_PEERS_DIR).filter(name => name.startsWith(PPP_PEER_PREFIX))) {
    if (active.has(file)) continue;
    run('/usr/bin/poff', [file], true);
    fs.rmSync(path.join(PPP_PEERS_DIR, file), { force: true });
  }
  for (const item of items.filter(entry => entry.mode === 'pppoe')) {
    if (!item.pppoe_username || !item.password) throw new Error(`PPPoE credentials are incomplete for ${item.interface}`);
    const name = peerName(item.interface), file = path.join(PPP_PEERS_DIR, name), desired = pppPeer(item), existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (existing !== desired) {
      if (existing) run('/usr/bin/poff', [name], true);
      fs.writeFileSync(file, desired, { mode: 0o600 });
      fs.chmodSync(file, 0o600);
    }
    const running = run('/usr/bin/pgrep', ['-f', `pppd call ${name}`], true);
    if (!running) run('/usr/bin/pon', [name]);
  }
}
function runLong(file, args) { return execFileSync(file, args, { encoding: 'utf8', timeout: 30000 }).trim(); }
function syncInterfaces(values) {
  const items = interfaceConfigurations(values);
  if (!items.length) {
    syncPppoe([]);
    writeJson(INTERFACE_STATUS_FILE, { state: 'idle', managed_count: 0, updated_at: new Date().toISOString() });
    return;
  }
  const desired = netplanYaml(items);
  const signature = createHash('sha256').update(JSON.stringify(items)).digest('hex');
  let prior = {};
  try { prior = JSON.parse(fs.readFileSync(INTERFACE_STATUS_FILE, 'utf8')); } catch {}
  if (prior.state === 'failed' && prior.signature === signature) return;
  if (signature === interfaceSignature || (prior.state === 'applied' && prior.signature === signature && fs.existsSync(NETPLAN_FILE) && fs.readFileSync(NETPLAN_FILE, 'utf8') === desired)) {
    interfaceSignature = signature;
    syncPppoe(items);
    return;
  }
  const existed = fs.existsSync(NETPLAN_FILE);
  const backup = existed ? fs.readFileSync(NETPLAN_FILE) : null;
  writeJson(INTERFACE_STATUS_FILE, { state: 'applying', managed_count: items.length, interfaces: items.map(item => item.interface), updated_at: new Date().toISOString() });
  try {
    const temporary = `${NETPLAN_FILE}.tmp`;
    fs.writeFileSync(temporary, desired, { mode: 0o600 });
    fs.renameSync(temporary, NETPLAN_FILE);
    fs.chmodSync(NETPLAN_FILE, 0o600);
    runLong('/usr/sbin/netplan', ['generate']);
    runLong('/usr/sbin/netplan', ['apply']);
    syncPppoe(items);
    interfaceSignature = signature;
    writeJson(INTERFACE_STATUS_FILE, { state: 'applied', managed_count: items.length, interfaces: items.map(item => item.interface), modes: Object.fromEntries(items.map(item => [item.interface, item.mode])), signature, updated_at: new Date().toISOString() });
  } catch (error) {
    try {
      if (backup) fs.writeFileSync(NETPLAN_FILE, backup, { mode: 0o600 }); else fs.rmSync(NETPLAN_FILE, { force: true });
      runLong('/usr/sbin/netplan', ['generate']);
      runLong('/usr/sbin/netplan', ['apply']);
    } catch {}
    writeJson(INTERFACE_STATUS_FILE, { state: 'failed', managed_count: items.length, interfaces: items.map(item => item.interface), signature, error: error.message, updated_at: new Date().toISOString() });
    throw error;
  }
}


function pbrPolicies(values) {
  try {
    const parsed = JSON.parse(values.pbr_policies || '[]');
    return Array.isArray(parsed) ? parsed.filter(item => item && item.enabled !== false).sort((a, b) => Number(a.priority) - Number(b.priority)) : [];
  } catch { return []; }
}
function customerInterfaces(values) {
  const names = new Set();
  const primary = values.network_mode === 'bridge' && values.network_bridge_if ? values.network_bridge_if : values.network_customer_if;
  if (primary && /^[A-Za-z0-9_.:-]+$/.test(primary)) names.add(primary);
  try {
    for (const zone of db.prepare('SELECT parent_if,vlan_id FROM zones WHERE managed=1 AND enabled=1').all()) {
      const name = `${zone.parent_if}.${zone.vlan_id}`.slice(0, 15);
      if (/^[A-Za-z0-9_.:-]+$/.test(name)) names.add(name);
    }
  } catch {}
  return [...names];
}
function nftPortSet(value) { return String(value || '').split(',').map(item => item.trim()).filter(Boolean).join(', '); }
function pbrNft(policies, customers) {
  const lines = ['table inet ' + PBR_TABLE + ' {', '  set customer_interfaces {', '    type ifname', `    elements = { ${customers.map(name => '"' + name + '"').join(', ')} }`, '  }'];
  policies.forEach((item, index) => {
    if (item.class === 'streaming') lines.push(`  set destinations_${index + 1} {`, '    type ipv4_addr', '    flags interval', `    elements = { ${item.match.split(',').map(value => value.trim()).filter(Boolean).join(', ')} }`, '  }');
  });
  lines.push('  chain classify {', '    type filter hook prerouting priority mangle - 5; policy accept;', '    iifname @customer_interfaces ct mark != 0 meta mark set ct mark');
  policies.forEach((item, index) => {
    const mark = 0x100 + index + 1;
    const start = `    iifname @customer_interfaces ct mark 0`;
    if (item.class === 'streaming') lines.push(`${start} ip daddr @destinations_${index + 1} meta mark set ${mark} ct mark set meta mark`);
    else if (item.class === 'gaming') lines.push(`${start} meta l4proto { tcp, udp } th dport { ${nftPortSet(item.match)} } meta mark set ${mark} ct mark set meta mark`);
    else {
      lines.push(`${start} meta l4proto tcp tcp dport { 80, 443 } meta mark set ${mark} ct mark set meta mark`);
      lines.push(`${start} meta l4proto udp udp dport 443 meta mark set ${mark} ct mark set meta mark`);
    }
  });
  lines.push('  }', '}');
  return lines.join('\n') + '\n';
}
function clearPbr() {
  run('/usr/sbin/nft', ['delete', 'table', 'inet', PBR_TABLE], true);
  for (let index = 1; index <= 32; index++) {
    run('/usr/sbin/ip', ['rule', 'del', 'priority', String(11100 + index)], true);
    run('/usr/sbin/ip', ['route', 'flush', 'table', String(10100 + index)], true);
  }
}
function syncPbr(values, wans) {
  const enabled = values.pbr_enabled === '1';
  const policies = pbrPolicies(values).slice(0, 32);
  const wanMap = new Map(wans.map(item => [item.interface, item]));
  const active = policies.filter(item => wanMap.get(item.interface)?.online);
  const signature = JSON.stringify({ enabled, policies, active: active.map(item => item.id), customers: customerInterfaces(values) });
  if (signature === pbrSignature) return;
  clearPbr();
  if (!enabled || !policies.length) {
    pbrSignature = signature;
    writeJson(PBR_STATUS_FILE, { enabled: false, state: 'disabled', policy_count: policies.length, active_count: 0, updated_at: new Date().toISOString() });
    return;
  }
  const customers = customerInterfaces(values);
  if (!customers.length) {
    writeJson(PBR_STATUS_FILE, { enabled: true, state: 'failed', policy_count: policies.length, active_count: 0, error: 'No customer interface is configured', updated_at: new Date().toISOString() });
    return;
  }
  try {
    const activePolicies = policies.filter(item => wanMap.get(item.interface)?.online);
    activePolicies.forEach((item, index) => {
      const wan = wanMap.get(item.interface), table = 10100 + index + 1, priority = 11100 + index + 1, mark = 0x100 + index + 1;
      run('/usr/sbin/ip', ['route', 'replace', 'table', String(table), 'default', 'via', wan.gateway, 'dev', wan.interface, 'onlink']);
      run('/usr/sbin/ip', ['rule', 'add', 'priority', String(priority), 'fwmark', `${mark}/0xffff`, 'table', String(table)]);
    });
    const file = path.join(RUN_DIR, 'pbr.nft');
    fs.writeFileSync(file, pbrNft(activePolicies, customers), { mode: 0o600 });
    runLong('/usr/sbin/nft', ['-f', file]);
    pbrSignature = signature;
    writeJson(PBR_STATUS_FILE, { enabled: true, state: activePolicies.length === policies.length ? 'active' : 'degraded', policy_count: policies.length, active_count: activePolicies.length, fallback_count: policies.length - activePolicies.length, policies: policies.map(item => ({ id: item.id, name: item.name, interface: item.interface, active: activePolicies.includes(item) })), updated_at: new Date().toISOString() });
  } catch (error) {
    clearPbr();
    writeJson(PBR_STATUS_FILE, { enabled: true, state: 'failed', policy_count: policies.length, active_count: 0, error: error.message, updated_at: new Date().toISOString() });
    throw error;
  }
}

function configuration(values) {
  try {
    const parsed = JSON.parse(values.multi_wan_config || '[]');
    return Array.isArray(parsed) ? parsed.filter(item => item && item.enabled !== false) : [];
  } catch { return []; }
}
async function probe(item) {
  const started = Date.now();
  const output = run('/usr/bin/ping', ['-n', '-I', item.interface, '-c', '1', '-W', '1', item.health_target], true);
  const pingOk = /1 received|1 packets received/.test(output);
  const carrier = run('/usr/sbin/ip', ['-j', 'link', 'show', 'dev', item.interface], true);
  const link = JSON.parse(carrier || '[]')[0];
  const cable = Boolean(link?.flags?.includes('LOWER_UP'));
  const gatewayOk = cable && /1 received|1 packets received/.test(run('/usr/bin/ping', ['-n', '-I', item.interface, '-c', '1', '-W', '1', item.gateway], true));
  async function fetchProbe(host, address, route, dns = false) {
    try {
      const { stdout } = await execAsync('/usr/bin/curl', ['--silent', '--show-error', '--fail', '--noproxy', '*', '--interface', item.interface, '--connect-timeout', '2', '--max-time', '4', '--resolve', `${host}:443:${address}`, '-H', 'accept: application/dns-json', `https://${host}${route}`], { timeout: 5000, maxBuffer: 65536 });
      if (!dns) return true;
      const reply = JSON.parse(stdout);
      return reply.Status === 0 && reply.Answer?.some(answer => answer.type === 1);
    } catch { return false; }
  }
  const [httpsOk, dnsOk] = cable ? await Promise.all([
    fetchProbe('one.one.one.one', '1.1.1.1', '/cdn-cgi/trace'),
    fetchProbe('dns.google', '8.8.8.8', '/resolve?name=example.com&type=A', true)
  ]) : [false, false];
  const ok = cable && httpsOk && dnsOk;
  const diagnosis = !cable ? 'cable_disconnected' : !httpsOk && !gatewayOk ? 'gateway_unreachable' : !httpsOk ? 'internet_unavailable' : !dnsOk ? 'dns_failed' : 'online';
  const errors = { cable_disconnected: 'Cable disconnected', gateway_unreachable: 'Gateway unreachable', internet_unavailable: 'Internet HTTPS check failed', dns_failed: 'DNS service check failed' };
  const prior = linkState.get(item.interface) || { online: false, failures: 0 };
  const failures = ok ? 0 : prior.failures + 1;
  const online = ok || (prior.online && failures < 2);
  const match = output.match(/time[=<]([0-9.]+)/);
  const state = { online, failures, latency_ms: ok ? Number(match?.[1] || Date.now() - started) : null };
  linkState.set(item.interface, state);
  return { ...item, ...state, diagnosis, checks: { cable, gateway: gatewayOk, ping: pingOk, https: httpsOk, dns: dnsOk, dns_transport: 'https' }, last_checked: new Date().toISOString(), error: errors[diagnosis] || '' };
}
function removeManagedRoute() {
  const present = run('/usr/sbin/ip', ['route', 'show', 'default', 'proto', ROUTE_PROTOCOL], true);
  if (present) run('/usr/sbin/ip', ['route', 'del', 'default', 'proto', ROUTE_PROTOCOL, 'metric', ROUTE_METRIC], true);
}
function applyRoute(active) {
  const signature = JSON.stringify(active.map(item => [item.interface, item.gateway, item.weight]));
  if (signature === appliedSignature) return;
  if (!active.length) removeManagedRoute();
  else {
    const args = ['route', 'replace', 'default', 'proto', ROUTE_PROTOCOL, 'metric', ROUTE_METRIC];
    for (const item of active) args.push('nexthop', 'via', item.gateway, 'dev', item.interface, 'weight', String(item.weight));
    run('/usr/sbin/ip', args);
  }
  appliedSignature = signature;
}
function writeStatus(status) {
  const temporary = `${STATUS_FILE}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(status), { mode: 0o644 });
  fs.renameSync(temporary, STATUS_FILE);
}
let syncing = false;
async function sync() {
  if (syncing) return;
  syncing = true;
  try {
    const values = settings();
    let interfaceSyncError = '';
    try { syncInterfaces(values); }
    catch (error) { interfaceSyncError = error.message; console.error(`WAN interface configuration sync failed: ${error.message}`); }
    if (!interfaceSyncError) {
      try { const interfaceStatus = JSON.parse(fs.readFileSync(INTERFACE_STATUS_FILE, 'utf8')); if (interfaceStatus.state === 'failed') interfaceSyncError = interfaceStatus.error || 'Interface configuration sync failed'; } catch {}
    }
    const enabled = values.multi_wan_enabled === '1';
    const pbrEnabled = values.pbr_enabled === '1';
    const configured = configuration(values);
    const wans = (enabled || pbrEnabled) ? await Promise.all(configured.map(probe)) : configured.map(item => ({ ...item, online: false, state: 'disabled' }));
    syncPbr(values, wans);
    if (!enabled) {
      applyRoute([]);
      writeStatus({ enabled: false, mode: 'weighted-ecmp', active_count: 0, route_metric: Number(ROUTE_METRIC), interface_sync_error: interfaceSyncError, wans, updated_at: new Date().toISOString() });
      return;
    }
    const active = wans.filter(item => item.online);
    applyRoute(active);
    writeStatus({ enabled: true, mode: 'weighted-ecmp', active_count: active.length, route_metric: Number(ROUTE_METRIC), degraded: active.length < configured.length, interface_sync_error: interfaceSyncError, wans, updated_at: new Date().toISOString() });
  } catch (error) {
    writeStatus({ enabled: true, mode: 'weighted-ecmp', active_count: 0, degraded: true, error: error.message, wans: [], updated_at: new Date().toISOString() });
    console.error(`Multi-WAN sync failed: ${error.message}`);
  } finally {
    syncing = false;
  }
}

sync();
const timer = setInterval(sync, 5000);
function shutdown() { clearInterval(timer); try { db.close(); } finally { process.exit(0); } }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
