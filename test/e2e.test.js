'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PASSWORD = 'Test-admin-password-2026!';
const PROVISION_KEY = 'test-provision-key-123456789';
const CLIENT = '02:00:00:00:00:11';
const CLIENT_2 = '02:00:00:00:00:22';
const CLIENT_3 = '02:00:00:00:00:33';
const CLIENT_4 = '02:00:00:00:00:44';
const CLIENT_5 = '02:00:00:00:00:55';
let child;
let base;
let tempDir;
let output = '';

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
    server.on('error', reject);
  });
}
async function request(url, options = {}, mac = CLIENT) {
  const response = await fetch(`${base}${url}`, { ...options, headers: { 'content-type': 'application/json', 'x-test-client-mac': mac, ...(options.headers || {}) } });
  const type = response.headers.get('content-type') || '';
  const body = type.includes('json') ? await response.json() : await response.text();
  return { response, body };
}
async function requestHost(host, path = '/') {
  const target = new URL(base);
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: target.hostname, port: target.port, path, method: 'GET', headers: { host } }, response => {
      response.resume();
      response.on('end', () => resolve(response));
    });
    req.on('error', reject);
    req.end();
  });
}
async function waitHealthy() {
  for (let i = 0; i < 80; i += 1) {
    try { const result = await request('/health'); if (result.response.ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Server did not become healthy:\n${output}`);
}

test.before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debian-vendoos-test-'));
  const port = await freePort(); base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: tempDir, DB_FILE: path.join(tempDir, 'test.db'), BACKUP_DIR: path.join(tempDir, 'backups'), ADMIN_PASSWORD: PASSWORD, PROVISION_KEY, ALLOW_TEST_MAC: '1', DISABLE_SYSTEM_POWER: '1', COIN_LEASE_SECONDS: '5', PORTAL_URL: `${base}/` },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
  await waitHealthy();
});
test.after(async () => {
  if (child && child.exitCode === null) { child.kill('SIGTERM'); await new Promise(resolve => child.once('exit', resolve)); }
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('Smart QoS supports CAKE, FQ-CoDel fallback, and routing optimization', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
  const client = fs.readFileSync(path.join(ROOT, 'public', 'admin.js'), 'utf8');
  const sync = fs.readFileSync(path.join(ROOT, 'vlan-sync.js'), 'utf8');
  const firewall = fs.readFileSync(path.join(ROOT, 'deploy', 'debian', 'vendo.nft'), 'utf8');
  assert.match(html, /Smart QoS &amp; SQM/);
  assert.match(html, /value="fq_codel"/);
  assert.match(html, /Gaming · lowest latency/);
  assert.match(html, /cake_profile/);
  assert.match(html, /cake_overhead_bytes/);
  assert.match(client, /cakeStatusDetail/);
  assert.match(html, /id="sqmRuntimeStats"/);
  assert.match(html, /id="sqmInterfacesBody"/);
  assert.match(client, /function renderSqmRuntime/);
  assert.match(client, /Queue backlog/);
  assert.match(html, /Configured bandwidth utilization/);
  assert.match(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'), /function sqmQueueStats/);
  assert.match(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'), /'qdisc', 'show'/);
  assert.match(fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8'), /const queueStats = sqmQueueStats\(\)/);
  assert.match(client, /cake_ack_filter/);
  assert.match(client, /function applySqmPreset/);
  assert.match(sync, /dual-dsthost/);
  assert.match(sync, /dual-srchost/);
  assert.match(sync, /function applyFqCodel/);
  assert.match(sync, /'htb', 'default', '10'/);
  assert.match(sync, /requested_algorithm: 'cake'/);
  assert.match(sync, /net\.ipv4\.tcp_mtu_probing=1/);
  assert.match(sync, /cake-status\.json/);
  assert.match(firewall, /ct state invalid drop/);
  assert.match(firewall, /tcp option maxseg size set rt mtu/);
});

test('network administration is organized into focused accessible sections', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
  const client = fs.readFileSync(path.join(ROOT, 'public', 'admin.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  for (const label of ['Overview', 'Interfaces', 'WAN & Failover', 'Traffic Routing', 'QoS & Speed', 'Customers', 'Customer VLANs', 'Advanced Setup']) assert.match(client, new RegExp(`label:'${label}'`));
  for (const id of ['networkOverviewPanel', 'networkOverviewStats', 'networkDetailGrid', 'networkHealthList']) assert.match(html, new RegExp(`id="${id}"`));
  for (const section of ['interfaces', 'multiwan', 'bandwidth', 'vlans']) assert.match(html, new RegExp(`data-network-section="${section}"`));
  assert.match(html, /id="interfaceLinksPanel"/);
  assert.match(client, /event\.key==='ArrowRight'/);
  assert.match(client, /button\.tabIndex=i===index\?0:-1/);
  assert.match(client, /button\.dataset\.sectionKey/);
  assert.match(client, /function renderNetworkOverview/);
  assert.match(client, /networkOverviewStatus/);
  assert.match(css, /data-subsection="bandwidth"/);
  assert.match(css, /network-overview-stats/);
  assert.match(css, /th:nth-child\(8\)\{width:18%\}/);
  assert.match(client, /wan-source-button/);
});

test('rate editor uses day hour minute second fields', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
  const client = fs.readFileSync(path.join(ROOT, 'public', 'admin.js'), 'utf8');
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  for (const field of ['duration_days', 'duration_hours', 'duration_minutes', 'duration_seconds']) assert.match(html, new RegExp(`name="${field}"`));
  assert.match(client, /rateDurationParts/);
  assert.match(client, /HR \$\{pad\(p\.minutes\)\}MIN/);
  assert.match(client, /Number\(v\.duration_days\)\*86400/);
  assert.match(server, /int\(body\.duration_seconds, 0, 1, 365 \* 86400\)/);
});

test('voucher generation and print use day hour minute second time and validity', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
  const client = fs.readFileSync(path.join(ROOT, 'public', 'admin.js'), 'utf8');
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  for (const prefix of ['duration', 'validity']) for (const part of ['days', 'hours', 'minutes', 'seconds']) assert.match(html, new RegExp(`name="${prefix}_${part}"`));
  assert.match(html, /Voucher validity/);
  assert.match(html, /<th>Validity<\/th>/);
  assert.match(client, /<b>TIME<\/b> \$\{rateDuration\(r\.duration_seconds\)\}/);
  assert.match(client, /<b>VALID<\/b>/);
  assert.match(client, /function voucherValidity/);
  assert.match(server, /const validity = int\(body\.validity_seconds, 0, 0, 3650 \* 86400\)/);
  assert.match(server, /validity \? futureIso\(validity\)/);
});

test('stations display sortable ESP uptime from heartbeat telemetry', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
  const client = fs.readFileSync(path.join(ROOT, 'public', 'admin.js'), 'utf8');
  assert.match(html, /<th>Station uptime<\/th>/);
  assert.match(html, /admin\.js\?v=0\.10\.22/);
  assert.match(client, /function stationUptime/);
  assert.match(client, /m\.telemetry\?\.uptime_seconds/);
  assert.match(client, /Last reported/);
  assert.match(client, /data-sort-value="\$\{uptime\}"/);
});

test('role-based access UI exposes team management and adapts by permission', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
  const client = fs.readFileSync(path.join(ROOT, 'public', 'admin.js'), 'utf8');
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(html, /id="accessControlPanel"/);
  assert.match(html, /id="adminUsersBody"/);
  for (const role of ['owner', 'admin', 'technician', 'collector', 'seller', 'viewer']) assert.match(html, new RegExp(`value="${role}"`));
  assert.match(client, /function applyRoleAccess/);
  assert.match(client, /write_scopes/);
  assert.match(client, /can_manage_users/);
  assert.match(client, /role-readonly/);
  assert.match(server, /function adminCan/);
  assert.match(server, /At least one enabled Owner or Admin account is required/);
});

test('admin exposes automatic pause and reconnect customer controls', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
  const client = fs.readFileSync(path.join(ROOT, 'public', 'admin.js'), 'utf8');
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(client, /sessionActionButton\('auto_pause'/);
  assert.match(client, /Auto paused/);
  assert.match(client, /Reconnect now/);
  assert.match(html, /name="auto_pause_reconnect_enabled"/);
  assert.match(html, /Automatic pause &amp; reconnect/);
  assert.match(client, /auto_pause_reconnect_enabled/);
  assert.match(server, /auto_reconnect/);
  assert.match(server, /access\.auto_reconnected/);
});

test('Live Users actions use compact accessible icon buttons', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
  const client = fs.readFileSync(path.join(ROOT, 'public', 'admin.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  assert.match(html, /style\.css\?v=0\.8\.33/);
  assert.match(client, /const sessionActionIcons=/);
  assert.match(client, /class="mini-button session-icon-button/);
  assert.match(client, /aria-label="\$\{esc\(label\)\}"/);
  assert.match(client, /title="\$\{esc\(label\)\}"/);
  for (const action of ['speed','extend','auto_pause','pause','resume','disconnect','block','unblock','delete']) assert.match(client, new RegExp(`${action}:`));
  assert.match(css, /\.session-icon-button\{[^}]*width:32px/);
  assert.match(css, /\.session-icon-button:focus-visible/);
});

test('Live Users traffic usage is collected from per-client nftables counters', () => {
  const firewall = fs.readFileSync(path.join(ROOT, 'deploy', 'debian', 'vendo.nft'), 'utf8');
  const sync = fs.readFileSync(path.join(ROOT, 'access-sync.js'), 'utf8');
  const client = fs.readFileSync(path.join(ROOT, 'public', 'admin.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
  assert.match(firewall, /set accounting_upload[\s\S]*?counter/);
  assert.match(firewall, /set accounting_download[\s\S]*?counter/);
  assert.ok(firewall.indexOf('ip saddr @accounting_upload') < firewall.indexOf('ct state established,related accept'));
  assert.ok(firewall.indexOf('ip daddr @accounting_download') < firewall.indexOf('ct state established,related accept'));
  assert.match(sync, /function syncAccounting/);
  assert.match(sync, /column: 'bytes_in'/);
  assert.match(sync, /column: 'bytes_out'/);
  assert.match(sync, /SET \$\{direction\.column\}=\$\{direction\.column\}\+\?/);
  assert.match(client, /function refreshSessionUsage/);
  assert.match(client, /setInterval\(refreshSessionUsage,2000\)/);
  assert.match(html, /admin\.js\?v=0\.10\.22/);
});

test('Add Time uses an accessible DD HR MIN dialog with validity preview', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
  const client = fs.readFileSync(path.join(ROOT, 'public', 'admin.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  assert.match(html, /id="extendSessionModal"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /Time to add · DD \/ HR \/ MIN/);
  assert.match(html, /name="days"/);
  assert.match(html, /name="hours"/);
  assert.match(html, /name="minutes"/);
  assert.match(html, /id="extendNewValidity"/);
  assert.match(html, /id="extendExpiryDate"/);
  assert.doesNotMatch(client, /prompt\('Minutes to add'/);
  assert.match(client, /function accessDuration/);
  assert.match(client, /function updateExtendValidity/);
  assert.match(client, /action:'extend',seconds/);
  assert.match(css, /\.extend-validity/);
});

test('voucher form automatically prepares a readable batch code', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
  const client = fs.readFileSync(path.join(ROOT, 'public', 'admin.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public', 'style.css'), 'utf8');
  assert.match(html, /id="newVoucherBatchCode"/);
  assert.match(html, /Generated automatically\. You may replace it/);
  assert.match(client, /function voucherBatchCode/);
  assert.match(client, /VB-\$\{date\.getFullYear\(\)\}/);
  assert.match(client, /setVoucherBatchCode\(true\)/);
  assert.match(client, /vouchers generated in \$\{r\.batch_code\}/);
  assert.match(css, /\.batch-code-control/);
});

test('random MAC protection uses persistent identity and MAC history', () => {
  const adminClient = fs.readFileSync(path.join(ROOT, 'public', 'admin.js'), 'utf8');
  const portalClient = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(server, /device_mac_history/);
  assert.match(server, /vendo_device_key=.*Max-Age=31536000/);
  assert.match(server, /HttpOnly; SameSite=Lax/);
  assert.match(server, /targetRemaining/);
  assert.match(adminClient, /Random MAC/);
  assert.match(adminClient, /previous_mac/);
  assert.match(portalClient, /Private MAC changed/);
  assert.match(portalClient, /identity_conflict/);
});

test('admin exposes fleet-wide ESP OTA controls and progress', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
  const client = fs.readFileSync(path.join(ROOT, 'public', 'admin.js'), 'utf8');
  assert.match(html, /id="deployAllFirmware"/);
  assert.match(html, /id="firmwareRollouts"/);
  assert.match(html, /Start safe rollout/);
  assert.match(html, /id="firmwareStatusBody"/);
  assert.match(html, /ESP8266-W5500/);
  assert.match(client, /all_esp:true/);
  assert.match(client, /strategy:'canary'/);
  assert.match(client, /Verifying health/);
  assert.match(client, /refreshFirmwareStatus/);
  assert.match(client, /waiting_offline/);
  const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const firmware = fs.readFileSync(path.join(ROOT, 'firmware', 'fleet', 'src', 'main.cpp'), 'utf8');
  assert.match(server, /function otaSignature/);
  assert.match(server, /function createFirmwareRollout/);
  assert.match(firmware, /validOtaManifest/);
  assert.match(firmware, /writeVerifiedFirmware/);
});

test('per-client speed limits use traffic-control filters alongside CAKE', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
  const client = fs.readFileSync(path.join(ROOT, 'public', 'admin.js'), 'utf8');
  const sync = fs.readFileSync(path.join(ROOT, 'access-sync.js'), 'utf8');
  assert.match(client, /sessionActionButton\('speed'/);
  assert.match(client, /Download\/upload speed/);
  assert.match(sync, /clsact/);
  assert.match(sync, /flower/);
  assert.match(sync, /src_ip/);
  assert.match(sync, /dst_ip/);
  assert.match(sync, /pref', '40000/);
  assert.match(html, /id="userSpeedForm"/);
  assert.match(client, /api\/admin\/network\/user-speed/);
});

test('ESP8266 pins use board silk-screen labels in the admin UI', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
  const client = fs.readFileSync(path.join(ROOT, 'public', 'admin.js'), 'utf8');
  assert.match(html, /D1 \(GPIO5\)/);
  assert.match(html, /D4 \(GPIO2\)/);
  assert.match(html, /D8 \(GPIO15\)/);
  assert.match(client, /function pinLabel/);
  assert.match(client, /16:'D0',5:'D1',4:'D2',0:'D3',2:'D4',14:'D5',12:'D6',13:'D7',15:'D8'/);
  assert.match(client, /Pulse \$\{pinLabel\(m\.board,m\.coin_pin\)\}/);
});

test('network interface table supports large paged views', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
  const client = fs.readFileSync(path.join(ROOT, 'public', 'admin.js'), 'utf8');
  assert.match(html, /id="interfacePageSize"/);
  assert.match(html, /value="100"/);
  assert.match(html, /value="500"/);
  assert.match(html, /value="1000"/);
  assert.match(client, /function paginateInterfaces/);
  assert.match(client, /interfacePagePrevious/);
  assert.match(client, /interfacePageNext/);
});

test('all customer networks advertise the requested public DNS defaults', () => {
  const sync = fs.readFileSync(path.join(ROOT, 'vlan-sync.js'), 'utf8');
  const dnsmasq = fs.readFileSync(path.join(ROOT, 'deploy', 'debian', 'dnsmasq.conf'), 'utf8');
  const firewall = fs.readFileSync(path.join(ROOT, 'deploy', 'debian', 'vendo.nft'), 'utf8');
  assert.match(sync, /CLIENT_DNS = '8\.8\.8\.8,1\.1\.1\.1'/);
  assert.match(sync, /option:dns-server,\$\{CLIENT_DNS\}/);
  assert.ok(dnsmasq.indexOf('server=8.8.8.8') < dnsmasq.indexOf('server=1.1.1.1'));
  assert.match(firewall, /ip daddr \{ 8\.8\.8\.8, 1\.1\.1\.1 \} udp dport 53 accept/);
  assert.match(firewall, /ip daddr \{ 8\.8\.8\.8, 1\.1\.1\.1 \} tcp dport 53 accept/);
});

test('VLAN DHCP scales to large ranges and exposes a health checker', () => {
  const dnsmasq = fs.readFileSync(path.join(ROOT, 'deploy', 'debian', 'dnsmasq.conf'), 'utf8');
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'public', 'admin.html'), 'utf8');
  const client = fs.readFileSync(path.join(ROOT, 'public', 'admin.js'), 'utf8');
  assert.match(dnsmasq, /^port=0$/m);
  assert.doesNotMatch(dnsmasq, /^bind-dynamic$/m);
  assert.match(source, /function vlanHealth/);
  assert.match(source, /\/api\/admin\/network\/vlans\/health/);
  assert.match(source, /vlan_health:vlanHealth\(snapshot\)/);
  assert.match(html, /id="checkVlans"/);
  assert.match(html, /id="vlanHealthSummary"/);
  assert.match(client, /function renderVlanHealth/);
  assert.match(client, /api\/admin\/network\/vlans\/health/);
});

test('SQLite is tuned and indexed for large network workloads', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  for (const setting of ['busy_timeout=10000', 'cache_size=-${DB_CACHE_KIB}', 'temp_store=MEMORY', 'mmap_size=${DB_MMAP_BYTES}', 'wal_autocheckpoint=1000', 'journal_size_limit=67108864']) assert.match(source, new RegExp(setting.replaceAll('$', '\\$')));
  for (const index of ['zones_vlan_lookup', 'machines_zone_enabled', 'rates_zone_lookup', 'coin_sessions_status_expiry', 'coin_pulses_session', 'access_identity_updated', 'hardware_commands_machine_status', 'firmware_rollouts_status', 'admin_sessions_expiry', 'sales_machine_created', 'vouchers_status_expiry']) assert.match(source, new RegExp(`CREATE INDEX IF NOT EXISTS ${index}`));
  assert.match(source, /PRAGMA optimize=0x10002/);
  assert.match(source, /6 \* 60 \* 60 \* 1000/);
});

test('runtime is capacity tuned for 1000 active vendo stations', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  const portal = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const firmware = fs.readFileSync(path.join(ROOT, 'firmware', 'fleet', 'src', 'main.cpp'), 'utf8');
  assert.match(source, /const statementCache = new Map/);
  assert.match(source, /DEVICE_HEARTBEAT_PERSIST_MS/);
  assert.match(source, /heartbeatPersistedAt/);
  assert.match(source, /api\/admin\/capacity/);
  assert.match(source, /target_active_stations:1000/);
  assert.match(source, /server\.maxConnections = 5000/);
  assert.match(source, /setInterval\(\(\) => cleanup\(true\), 1000\)/);
  assert.match(portal, /if \(!startCoinStream\(\)\) pollCoin\(\)/);
  assert.match(portal, /setTimeout\(pollCoin, 1500\)/);
  assert.match(portal, /setInterval\(renderCoinCountdown, 250\)/);
  assert.match(portal, /coinDeadline - Date\.now\(\)/);
  assert.match(portal, /String\(secs\)\.padStart\(2, '0'\)\}s/);
  assert.doesNotMatch(portal, /startCoinStream\(\); pollCoin\(\)/);
  assert.match(firmware, /VENDO_FIRMWARE_VERSION "0\.2\.13"/);
  assert.match(firmware, /heartbeatJitterMs/);
  assert.match(firmware, /heartbeat_idle_ms/);
});

test('10.0.0.1 redirects to the portal without an explicit port', () => {
  const firewall = fs.readFileSync(path.join(ROOT, 'deploy', 'debian', 'vendo.nft'), 'utf8');
  const shortcut = 'iifname @customer_interfaces ip daddr 10.0.0.1 tcp dport 80 redirect to :3080';
  assert.match(firewall, new RegExp(shortcut.replaceAll('.', '\\.')));
  assert.ok(firewall.indexOf(shortcut) < firewall.indexOf('ether saddr @allowed_macs return'));
});

test('customer identification is VLAN aware and subnet restricted', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(source, /function customerZoneForIp/);
  assert.match(source, /zone\.parent_if}\.\$\{zone\.vlan_id/);
  assert.match(source, /'\/proc\/net\/arp'/);
  assert.match(source, /readDhcpLeases\(\)\.find\(item => item\.ip === ip/);
});

test('voucher redemption never applies a VLAN restriction', () => {
  const source = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.doesNotMatch(source, /voucher\.zone_id && Number\(voucher\.zone_id\)/);
  assert.match(source, /seller_code,zone_id,duration_seconds/);
  assert.match(source, /cleanText\(body\.seller_code, 30\) \|\| null, null, duration/);
});

test('complete Debian-native vendo flow', async () => {
  let result = await request('/health'); assert.equal(result.response.status, 200); assert.equal(result.body.ok, true);
  const shortcut = await requestHost('10.0.0.1'); assert.equal(shortcut.statusCode, 302); assert.equal(shortcut.headers.location, '/portal');
  const adminShortcut = await requestHost('10.0.0.1', '/admin'); assert.equal(adminShortcut.statusCode, 200);
  result = await request('/portal'); assert.equal(result.response.status, 200); assert.match(result.body, /Fast WiFi/); assert.match(result.body, /promo-portal/); assert.match(result.body, /portal\.css\?v=0\.9\.13/); assert.match(result.body, /app\.js\?v=0\.9\.11/); assert.match(result.body, /insertCoinAudio/); assert.match(result.body, /voucherToast/); assert.match(result.body, /redeemButton/); assert.match(result.body, /command-status/); assert.match(result.body, /access-title/); assert.match(result.body, /pauseLabel/); assert.match(result.body, /action-copy/); assert.match(result.body, /portalFooterBrand/); assert.doesNotMatch(result.body, /Ask the operator for assistance/);
  result = await request('/portal-mockups'); assert.equal(result.response.status, 200); assert.match(result.body, /VendoOS Portal Concepts/); assert.match(result.body, /Eighteen static illustrated/); for (const id of ['pulse-night','signal-lite','ocean-glass','arcade-grid','local-fiesta','obsidian-gold','frosted-silver','emerald-club','royal-amethyst','monochrome-studio','holiday-christmas','holiday-new-year','holiday-valentine','holiday-lunar','holiday-easter','holiday-eid','holiday-halloween','holiday-fiesta']) assert.match(result.body, new RegExp(`id="${id}"`)); assert.doesNotMatch(result.body, /id="(?:orange-command|command-)/);
  result = await request('/assets/portal-mockups.css?v=4'); assert.equal(result.response.status, 200); assert.match(result.body, /\.phone\{/); assert.match(result.body, /\.simple-tagline\{/); assert.match(result.body, /\.gold\{/); assert.match(result.body, /\.royal\{/); assert.match(result.body, /@media\(max-width:580px\)/);
  result = await request('/assets/portal-mockups-orange.css?v=16'); assert.equal(result.response.status, 200); assert.match(result.body, /\.digit-time\{/); assert.match(result.body, /\.stack-actions/); assert.match(result.body, /\.orange-banner\{/); for(const theme of ['christmas','new-year','valentine','lunar','easter','eid','halloween','fiesta']) assert.match(result.body,new RegExp(`holiday-${theme}`)); assert.match(result.body, /Static poster art v4/); assert.match(result.body, /Illustrated worlds v3/); for(const asset of ['portal-world-adventure.webp','portal-world-fiesta.webp','portal-world-premium.webp','portal-world-halloween.webp','portal-world-christmas.webp']) assert.match(result.body,new RegExp(asset)); for(const theme of ['pulse','lite','ocean','arcade','fiesta','gold','silver','emerald','royal','mono']) assert.match(result.body,new RegExp(`stacked-portal\\.${theme}`)); assert.match(result.body, /content:none!important/); assert.match(result.body, /prefers-reduced-motion:reduce/); assert.doesNotMatch(result.body, /\.signal-rings/); assert.doesNotMatch(result.body, /voucher-action/);
  result = await request('/assets/portal-mockups.js?v=17'); assert.equal(result.response.status, 200); for(const name of ['Pulse Night','Obsidian Gold','Monochrome Studio','Christmas Glow','Midnight Countdown','Valentine Signal','Lucky Lantern','Spring Pastel','Emerald Crescent','Midnight Pumpkin','Banderitas Fiesta']) assert.match(result.body,new RegExp(name)); assert.match(result.body, /stackedPortal/); assert.match(result.body, /const banner = '<section class="orange-banner" aria-label="Promotional banner"><\/section>'/); assert.equal((result.body.match(/layout:'stacked'/g) || []).length, 18); assert.doesNotMatch(result.body, /(?:Orange Command|Command Carbon|theme:'command-')/); assert.doesNotMatch(result.body, /Login using voucher code/); assert.doesNotMatch(result.body, /class="hero"/);
  result = await request('/assets/app.js?v=0.9.11'); assert.equal(result.response.status, 200); assert.match(result.body, /state\.context\.settings/); assert.match(result.body, /PORTAL_THEMES/); assert.match(result.body, /PORTAL_THEME_COPY/); assert.match(result.body, /PAUSE & DISCONNECT/); for(const theme of ['holiday-christmas','holiday-new-year','holiday-valentine','holiday-lunar','holiday-easter','holiday-eid','holiday-halloween','holiday-fiesta']) assert.match(result.body,new RegExp(theme)); assert.doesNotMatch(result.body, /command-(?:orange|carbon|azure|emerald|violet|sunset|nordic|street|cafe|bauhaus|zen|navy|pop)/); assert.match(result.body, /document\.body\.style\.setProperty\('--portal-primary'/); assert.match(result.body, /portalBanner'\)\.classList\.remove\('hidden'\)/); assert.match(result.body, /voucherFeedback/); assert.match(result.body, /new EventSource/);
  result = await request('/assets/portal.css?v=0.9.13', { headers: { 'accept-encoding': 'br' } }); assert.equal(result.response.status, 200); assert.equal(result.response.headers.get('content-encoding'), 'br'); assert.match(result.body, /portal-theme-lite/); assert.match(result.body, /Static poster art v4/); assert.match(result.body, /Immersive portal v2/); for(const asset of ['portal-world-adventure.webp','portal-world-fiesta.webp','portal-world-premium.webp','portal-world-halloween.webp','portal-world-christmas.webp']) assert.match(result.body,new RegExp(asset)); for(const theme of ['christmas','new-year','valentine','lunar','easter','eid','halloween','fiesta']) assert.match(result.body,new RegExp(`portal-theme-holiday-${theme}`)); assert.match(result.body, /content:none!important/); assert.match(result.body, /prefers-reduced-motion:reduce/); assert.match(result.body, /voucher-toast/); assert.ok(Number(result.response.headers.get('content-length')) < 38000, 'compressed portal CSS stays below 38 KB with illustrated themes');
  for(const asset of ['portal-world-adventure.webp','portal-world-fiesta.webp','portal-world-premium.webp','portal-world-halloween.webp','portal-world-christmas.webp']) { result = await request(`/assets/${asset}`); assert.equal(result.response.status, 200); assert.match(result.response.headers.get('content-type') || '', /image\/webp/); assert.ok(Number(result.response.headers.get('content-length')) < 180000, `${asset} stays below 180 KB`); }
  result = await request('/admin'); assert.equal(result.response.status, 200); assert.match(result.body, /Administrator login/); assert.match(result.body, /style\.css\?v=0\.8\.33/); assert.match(result.body, /admin\.js\?v=0\.10\.22/); assert.match(result.body, /portal-editor-preview promo-portal/); assert.match(result.body, /href="\/portal-mockups"/); assert.match(result.body, />18 mockups</); assert.match(result.body, /portal-theme-picker/); for(const theme of ['dark','lite','holiday-christmas','holiday-new-year','holiday-valentine','holiday-lunar','holiday-easter','holiday-eid','holiday-halloween','holiday-fiesta']) assert.match(result.body,new RegExp(`value="${theme}"`)); assert.doesNotMatch(result.body, /value="command-/); assert.match(result.body, /Holiday Ramadan &amp; Eid/); assert.match(result.body, /Holiday Philippine Fiesta/); assert.match(result.body, /hardwareUsageChart/); assert.match(result.body, /multiWanForm/); assert.match(result.body, /systemPowerPanel/);
  result = await request('/assets/admin.js?v=0.10.22'); assert.equal(result.response.status, 200); assert.match(result.body, /PORTAL_THEME_META/); assert.match(result.body, /PORTAL_PREVIEW_COPY/); for(const theme of ['holiday-christmas','holiday-new-year','holiday-valentine','holiday-lunar','holiday-easter','holiday-eid','holiday-halloween','holiday-fiesta']) assert.match(result.body,new RegExp(theme)); assert.doesNotMatch(result.body, /command-(?:orange|carbon|azure|emerald|violet|sunset|nordic|street|cafe|bauhaus|zen|navy|pop)/); assert.match(result.body, /previewFooterBrand/); assert.match(result.body, /renderNetworkOverview/); assert.match(result.body, /api\/admin\/system\/power/); assert.match(result.body, /api\/admin\/sales\/reset/);
  result = await request('/generate_204', { redirect: 'manual' }); assert.equal(result.response.status, 302); assert.equal(result.response.headers.get('location'), `${base}/`);

  result = await request('/api/admin/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: 'wrong-password' }) }); assert.equal(result.response.status, 401);
  result = await request('/api/admin/login', { method: 'POST', body: JSON.stringify({ username: 'admin', password: PASSWORD }) }); assert.equal(result.response.status, 200); assert.equal(result.body.user.role, 'admin'); assert.equal(result.body.user.can_manage_users, true); const adminToken = result.body.token;

  const adminHeaders = { authorization: `Bearer ${adminToken}` };
  result = await request('/api/admin/me', { headers: adminHeaders }); assert.equal(result.response.status, 200); assert.equal(result.body.user.username, 'admin'); const adminUserId = result.body.user.id;
  result = await request('/api/admin/users', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ username: 'readonly.qa', password: 'Viewer-password-2026!', role: 'viewer' }) }); assert.equal(result.response.status, 201); const viewerId = result.body.id;
  result = await request('/api/admin/login', { method: 'POST', body: JSON.stringify({ username: 'readonly.qa', password: 'Viewer-password-2026!' }) }); assert.equal(result.response.status, 200); assert.equal(result.body.user.read_only, true); const viewerHeaders = { authorization: `Bearer ${result.body.token}` };
  result = await request('/api/admin/summary', { headers: viewerHeaders }); assert.equal(result.response.status, 200);
  result = await request('/api/admin/network', { headers: viewerHeaders }); assert.equal(result.response.status, 200);
  result = await request('/api/admin/sales/reset', { method: 'POST', headers: viewerHeaders, body: '{}' }); assert.equal(result.response.status, 403);
  result = await request('/api/admin/users', { headers: viewerHeaders }); assert.equal(result.response.status, 403);
  result = await request(`/api/admin/users/${adminUserId}`, { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ role: 'viewer', enabled: true }) }); assert.equal(result.response.status, 409); assert.match(result.body.error, /At least one enabled Owner or Admin/);
  result = await request(`/api/admin/users/${viewerId}`, { method: 'DELETE', headers: adminHeaders }); assert.equal(result.response.status, 200);
  result = await request('/api/admin/system/power', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ action: 'invalid' }) }); assert.equal(result.response.status, 400);
  result = await request('/api/admin/system/power', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ action: 'reboot' }) }); assert.equal(result.response.status, 202); assert.equal(result.body.simulated, true);
  result = await request('/api/admin/system/power', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ action: 'shutdown' }) }); assert.equal(result.response.status, 202); assert.equal(result.body.simulated, true);
  const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
  result = await request('/api/admin/portal-assets/logo', { method: 'PUT', headers: { ...adminHeaders, 'content-type': 'image/png' }, body: png }); assert.equal(result.response.status, 201); assert.match(result.body.url, /^\/assets\/uploads\/portal-logo\.png\?v=/);
  result = await request('/api/public/branding'); assert.match(result.body.portal_logo_url, /^\/assets\/uploads\/portal-logo\.png\?v=/); assert.ok(Object.hasOwn(result.body, 'portal_banner_url')); assert.ok(Object.hasOwn(result.body, 'portal_insert_sound_url'));
  result = await request(result.body.portal_logo_url); assert.equal(result.response.status, 200);
  result = await request('/api/admin/portal-assets/logo', { method: 'DELETE', headers: adminHeaders }); assert.equal(result.response.status, 200);
  result = await request('/api/public/branding'); assert.equal(result.body.portal_logo_url, '/assets/defaults/vendo-logo.svg'); assert.equal(result.body.portal_banner_url, '/assets/portal-world-premium.webp?v=1');
  result = await request(result.body.portal_logo_url); assert.equal(result.response.status, 200);
  result = await request('/assets/defaults/vendo-banner.webp'); assert.equal(result.response.status, 200); assert.match(result.response.headers.get('cache-control'), /immutable/);

  result = await request('/api/device/provision', { method: 'POST', headers: { 'x-provision-key': PROVISION_KEY }, body: JSON.stringify({ hardware_id: 'ESP8266-AABBCC', name: 'Front Counter', coin_pin: 2, enable_pin: 15 }) });
  assert.equal(result.response.status, 200); const deviceToken = result.body.token; const machineId = Number(result.body.machine.id);
  const deviceHeaders = { 'x-vendo-device': 'ESP8266-AABBCC', authorization: `Bearer ${deviceToken}` };

  result = await request('/api/device/heartbeat', { method: 'POST', headers: deviceHeaders, body: JSON.stringify({ firmware_version: '0.1.0', uptime_seconds: 93784 }) });
  assert.equal(result.response.status, 200); assert.equal(result.body.coin_slot_enabled, false);
  result = await request('/api/admin/machines', { headers: { authorization: `Bearer ${adminToken}` } }); assert.equal(result.body[0].telemetry.uptime_seconds, 93784);
  result = await request(`/api/admin/machines/${machineId}`, { method: 'PATCH', headers: { authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ name: 'Front Counter', location: 'Entrance', coin_pin: 4, enable_pin: 5 }) });
  assert.equal(result.response.status, 200); assert.equal(result.body.coin_pin, 4); assert.equal(result.body.enable_pin, 5);
  result = await request('/api/device/heartbeat', { method: 'POST', headers: deviceHeaders, body: '{}' });
  assert.equal(result.body.config.coin_pin, 4); assert.equal(result.body.config.enable_pin, 5, 'pin changes must reach the ESP on its next heartbeat');
  result = await request(`/api/admin/machines/${machineId}`, { method: 'PATCH', headers: { authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ name: 'Front Counter', location: 'Entrance', coin_pin: 4, enable_pin: 4 }) });
  assert.equal(result.response.status, 400); assert.match(result.body.error, /different GPIO/i);
  result = await request(`/api/admin/machines/${machineId}`, { method: 'PATCH', headers: { authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ name: 'Front Counter', location: 'Entrance', coin_pin: 6, enable_pin: 5 }) });
  assert.equal(result.response.status, 400); assert.match(result.body.error, /ESP8266 coin pulse GPIO/i);
  result = await request('/api/public/context'); assert.equal(result.response.status, 200); assert.equal(result.body.machines.length, 1); assert.equal(result.body.rates.length, 4);

  result = await request('/api/public/sessions', { method: 'POST', body: JSON.stringify({ machine_id: machineId }) });
  assert.equal(result.response.status, 201); const session = result.body; assert.equal(session.amount_centavos, 0); assert.ok(session.seconds_left > 0 && session.seconds_left <= 5);
  const streamResponse = await fetch(`${base}/api/public/sessions/${session.id}/stream?token=${encodeURIComponent(session.token)}`); assert.equal(streamResponse.status, 200); assert.match(streamResponse.headers.get('content-type'), /text\/event-stream/); const streamReader = streamResponse.body.getReader(); const firstStreamEvent = await streamReader.read(); assert.match(new TextDecoder().decode(firstStreamEvent.value), /"amount_centavos":0/);
  result = await request('/api/device/heartbeat', { method: 'POST', headers: deviceHeaders, body: '{}' }); assert.equal(result.body.coin_slot_enabled, true);

  result = await request('/api/device/pulse', { method: 'POST', headers: deviceHeaders, body: JSON.stringify({ pulse_id: 'boot1-1', value_centavos: 100 }) });
  assert.equal(result.response.status, 200); assert.equal(result.body.amount_centavos, 100); assert.equal(result.body.credited_seconds, 600); assert.ok(result.body.seconds_left >= 4 && result.body.seconds_left <= 5, 'each pulse must reset the configured lease');
  const pulseStreamEvent = await streamReader.read(); assert.match(new TextDecoder().decode(pulseStreamEvent.value), /"amount_centavos":100/); await streamReader.cancel();
  result = await request('/api/device/pulse', { method: 'POST', headers: deviceHeaders, body: JSON.stringify({ pulse_id: 'boot1-1', value_centavos: 100 }) });
  assert.equal(result.body.amount_centavos, 100, 'duplicate pulses must be idempotent');
  result = await request('/api/device/pulse', { method: 'POST', headers: deviceHeaders, body: JSON.stringify({ pulse_id: 'boot1-2', value_centavos: 100 }) });
  assert.equal(result.body.amount_centavos, 200); assert.equal(result.body.credited_seconds, 1200);

  result = await request(`/api/public/sessions/${session.id}/complete`, { method: 'POST', headers: { authorization: `Bearer ${session.token}` }, body: '{}' });
  assert.equal(result.response.status, 200); assert.equal(result.body.access.status, 'active'); assert.ok(result.body.access.remaining_seconds >= 1199);

  result = await request('/api/public/sessions', { method: 'POST', body: JSON.stringify({ machine_id: machineId }) }, CLIENT_3);
  assert.equal(result.response.status, 201); const unattendedSession = result.body;
  result = await request('/api/device/pulse', { method: 'POST', headers: deviceHeaders, body: JSON.stringify({ pulse_id: 'boot1-auto-1', value_centavos: 100 }) });
  assert.equal(result.response.status, 200); assert.equal(result.body.amount_centavos, 100);
  for (let attempt = 0; attempt < 32; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 250));
    result = await request(`/api/public/sessions/${unattendedSession.id}`, { headers: { authorization: `Bearer ${unattendedSession.token}` } }, CLIENT_3);
    if (result.body.status === 'completed') break;
  }
  assert.equal(result.body.status, 'completed', 'coin credit must finalize automatically when the countdown ends');
  assert.equal(result.body.amount_centavos, 100); assert.equal(result.body.credited_seconds, 600);
  result = await request('/api/public/access', {}, CLIENT_3); assert.equal(result.body.status, 'active'); assert.ok(result.body.remaining_seconds >= 599);

  result = await request('/api/public/access'); assert.equal(result.body.status, 'active');
  result = await request('/generate_204', { redirect: 'manual' }); assert.equal(result.response.status, 204);
  result = await request('/api/public/access/pause', { method: 'POST', body: '{}' }); assert.equal(result.body.status, 'paused');
  result = await request('/api/public/access/resume', { method: 'POST', body: '{}' }); assert.equal(result.body.status, 'active');

  result = await request('/api/admin/vouchers/generate', { method: 'POST', headers: { authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ quantity: 2, duration_seconds: 3600, validity_seconds: 90061, batch_code: 'TEST-BATCH', seller_code: 'SELLER-A' }) });
  assert.equal(result.response.status, 201); assert.equal(result.body.codes.length, 2); const voucherCode = result.body.codes[0];
  assert.equal(result.body.duration_seconds, 3600); assert.equal(result.body.validity_seconds, 90061); assert.ok(Date.parse(result.body.expires_at) > Date.now());
  assert.equal(result.body.zone_id, null, 'new vouchers must work on every customer VLAN by default');
  result = await request('/api/admin/vouchers?batch=TEST-BATCH', { headers: { authorization: `Bearer ${adminToken}` } }); assert.equal(result.body[0].zone_id, null);
  result = await request('/api/public/vouchers/redeem', { method: 'POST', body: JSON.stringify({ code: voucherCode }) }, CLIENT_2);
  assert.equal(result.response.status, 200); assert.equal(result.body.access.status, 'active'); assert.ok(result.body.access.remaining_seconds >= 3599);
  result = await request('/api/public/vouchers/redeem', { method: 'POST', body: JSON.stringify({ code: voucherCode }) }, CLIENT_2); assert.equal(result.response.status, 400); assert.match(result.body.error, /invalid, expired, or already used/i);
  result = await request('/api/public/vouchers/redeem', { method: 'POST', body: JSON.stringify({ code: 'NOT-A-VOUCHER' }) }, CLIENT_2); assert.equal(result.response.status, 400);

  result = await request(`/api/admin/machines/${machineId}/commands`, { method: 'POST', headers: { authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ command: 'restart' }) }); assert.equal(result.response.status, 202);
  result = await request('/api/device/heartbeat', { method: 'POST', headers: deviceHeaders, body: '{}' }); assert.equal(result.body.commands[0].command, 'restart');
  const commandId = result.body.commands[0].id;
  result = await request('/api/device/heartbeat', { method: 'POST', headers: deviceHeaders, body: JSON.stringify({ ack_command_ids: [commandId] }) }); assert.equal(result.response.status, 200);

  result = await request('/api/admin/rates', { method: 'POST', headers: { authorization: `Bearer ${adminToken}` }, body: JSON.stringify({ name: 'PHP 3 / 35 min', price_centavos: 300, duration_seconds: 2100, rate_limit: '6M/6M' }) });
  assert.equal(result.response.status, 200); assert.equal(result.body.length, 5);

  result = await request('/api/admin/summary', { headers: { authorization: `Bearer ${adminToken}` } });
  assert.equal(result.response.status, 200); assert.equal(result.body.total_machines, 1); assert.equal(result.body.online_machines, 1); assert.equal(result.body.sales.length, 3);
  assert.equal(typeof result.body.hardware_usage.cpu_percent, 'number'); assert.equal(typeof result.body.hardware_usage.memory_percent, 'number'); assert.ok(Array.isArray(result.body.interface_usage)); assert.ok(Array.isArray(result.body.interface_usage_history));
  result = await request('/api/admin/usage', { headers: { authorization: `Bearer ${adminToken}` } }); assert.equal(result.response.status, 200); assert.ok(Array.isArray(result.body.usage_history)); assert.ok(Array.isArray(result.body.interface_usage)); assert.ok(Array.isArray(result.body.interface_usage_history));
  assert.equal(typeof result.body.network_usage.rx_bps, 'number'); assert.ok(Array.isArray(result.body.usage_history)); assert.ok(result.body.usage_history.length >= 1);

  const auth = { authorization: `Bearer ${adminToken}` };
  result = await request('/api/admin/network/multiwan', { method: 'POST', headers: auth, body: JSON.stringify({ enabled: false, wans: [] }) }); assert.equal(result.response.status, 200); assert.equal(result.body.enabled, false);
  result = await request('/api/admin/network/multiwan', { method: 'POST', headers: auth, body: JSON.stringify({ enabled: true, wans: [] }) }); assert.equal(result.response.status, 400);
  result = await request('/api/admin/network/pbr', { method: 'POST', headers: auth, body: JSON.stringify({ enabled: false, policies: [] }) }); assert.equal(result.response.status, 200); assert.equal(result.body.enabled, false);
  result = await request('/api/admin/network/pbr', { method: 'POST', headers: auth, body: JSON.stringify({ enabled: true, policies: [] }) }); assert.equal(result.response.status, 400);
  result = await request('/api/admin/network', { headers: auth }); assert.equal(result.response.status, 200); assert.equal(result.body.settings.multi_wan_enabled, '0'); assert.equal(result.body.multi_wan.mode, 'weighted-ecmp'); assert.equal(typeof result.body.interface_configs, 'object'); assert.equal(typeof result.body.interface_roles, 'object'); assert.equal(typeof result.body.interface_apply_status.state, 'string'); assert.equal(typeof result.body.pbr.state, 'string');
  const configurableInterface = result.body.interfaces.find(item => item.ifname !== 'lo' && item.linkinfo?.info_kind !== 'vlan');
  if(configurableInterface){
    result = await request(`/api/admin/network/interfaces/${encodeURIComponent(configurableInterface.ifname)}/config`, { method: 'PUT', headers: auth, body: JSON.stringify({ mode: 'pppoe', pppoe_username: 'test@example', dns: ['1.1.1.1'], cost: 100 }) }); assert.equal(result.response.status, 400); assert.match(result.body.error, /password/i);
    result = await request(`/api/admin/network/interfaces/${encodeURIComponent(configurableInterface.ifname)}/config`, { method: 'PUT', headers: auth, body: JSON.stringify({ mode: 'pppoe', pppoe_username: 'test@example', pppoe_password: 'secret-value', pppoe_service: 'internet', mtu: 1492, dns: ['1.1.1.1'], cost: 100 }) }); assert.equal(result.response.status, 202); assert.equal(result.body.config.pppoe_password_set, true); assert.equal('pppoe_password' in result.body.config, false);
    result = await request('/api/admin/network', { headers: auth }); assert.equal(result.body.interface_configs[configurableInterface.ifname].pppoe_password_set, true); assert.equal('password' in result.body.interface_configs[configurableInterface.ifname], false); assert.equal(Object.keys(result.body.settings).some(key=>key.startsWith('network_interface_secret:')), false);
    result = await request(`/api/admin/network/interfaces/${encodeURIComponent(configurableInterface.ifname)}/config`, { method: 'PUT', headers: auth, body: JSON.stringify({ mode: 'pppoe', pppoe_username: 'test@example', pppoe_password: '', mtu: 1480, dns: [], cost: 110 }) }); assert.equal(result.response.status, 202);
    result = await request(`/api/admin/network/interfaces/${encodeURIComponent(configurableInterface.ifname)}/config`, { method: 'PUT', headers: auth, body: JSON.stringify({ mode: 'dhcp', dns: ['8.8.8.8'], cost: 100 }) }); assert.equal(result.response.status, 202);
    result = await request('/api/admin/network', { headers: auth }); assert.equal(result.body.interface_configs[configurableInterface.ifname].mode, 'dhcp'); assert.equal(result.body.interface_configs[configurableInterface.ifname].pppoe_password_set, false);
  }
  if(process.platform==='linux'){
    result = await request('/api/admin/network/interfaces/lo/description', { method: 'PUT', headers: auth, body: JSON.stringify({ description: 'Local system loopback' }) }); assert.equal(result.response.status, 200); assert.equal(result.body.description, 'Local system loopback');
    result = await request('/api/admin/network', { headers: auth }); assert.equal(result.response.status, 200); assert.equal(result.body.interface_descriptions.lo, 'Local system loopback');
    assert.ok(Array.isArray(result.body.interfaces)); assert.ok(result.body.interfaces.every(item=>Array.isArray(item.ipv4_addresses)&&Array.isArray(item.ipv6_addresses)&&typeof item.address_mode==='string'&&typeof item.default_gateway==='string'));
    result = await request('/api/admin/network/interfaces/lo/config', { method: 'PUT', headers: auth, body: JSON.stringify({ mode: 'dhcp', dns: ['1.1.1.1'], cost: 100 }) }); assert.equal(result.response.status, 400);
  }
  result = await request('/api/admin/settings', { method: 'POST', headers: auth, body: JSON.stringify({ brand_name: 'Test WiFi', portal_headline: 'Connect in seconds.', portal_tagline: 'FAST · FAIR · LOCAL', portal_announcement: 'Welcome to the test zone.', support_text: 'Call the operator.', portal_theme: 'lite', portal_primary_color: '#2255aa', portal_accent_color: '#ffcc22', portal_logo_url: '/assets/test-logo.png' }) });
  assert.equal(result.response.status, 200); assert.equal(result.body.brand_name, 'Test WiFi');
  result = await request('/api/public/branding', {}, ''); assert.equal(result.response.status, 200); assert.equal(result.body.portal_primary_color, '#2255aa'); assert.equal(result.body.portal_headline, 'Connect in seconds.'); assert.equal(result.body.portal_theme, 'lite');
  result = await request('/api/admin/settings', { method: 'POST', headers: auth, body: JSON.stringify({ portal_theme: 'command-azure' }) }); assert.equal(result.response.status, 400);
  result = await request('/api/admin/settings', { method: 'POST', headers: auth, body: JSON.stringify({ portal_theme: 'holiday-christmas' }) }); assert.equal(result.response.status, 200); assert.equal(result.body.portal_primary_color, '#c52e37'); assert.equal(result.body.portal_accent_color, '#f0c75e');
  result = await request('/api/public/branding', {}, ''); assert.equal(result.body.portal_theme, 'holiday-christmas'); assert.equal(result.body.portal_banner_url, '/assets/portal-world-christmas.webp?v=1');
  result = await request(result.body.portal_banner_url); assert.equal(result.response.status, 200); assert.match(result.response.headers.get('cache-control'), /immutable/);
  result = await request('/api/admin/settings', { method: 'POST', headers: auth, body: JSON.stringify({ portal_primary_color: 'red' }) }); assert.equal(result.response.status, 400);
  result = await request('/api/admin/settings', { method: 'POST', headers: auth, body: JSON.stringify({ portal_theme: 'neon' }) }); assert.equal(result.response.status, 400);
  result = await request('/api/admin/sellers', { method: 'POST', headers: auth, body: JSON.stringify({ code: 'SELLER-A', name: 'Test Seller', location: 'Market' }) }); assert.equal(result.response.status, 201);
  result = await request('/api/admin/sellers', { headers: auth }); assert.equal(result.body[0].code, 'SELLER-A');
  result = await request('/api/admin/vouchers?batch=TEST-BATCH', { headers: auth }); assert.equal(result.body.length, 2); assert.ok(result.body[0].code_value);
  result = await request('/api/admin/vouchers/generate', { method: 'POST', headers: auth, body: JSON.stringify({ quantity: 4, duration_seconds: 900, batch_code: 'DELETE-BATCH' }) }); assert.equal(result.body.codes.length, 4);
  result = await request('/api/admin/vouchers', { method: 'DELETE', headers: auth, body: JSON.stringify({ quantity: 2, batch_code: 'DELETE-BATCH' }) }); assert.equal(result.body.deleted, 2);
  result = await request('/api/admin/vouchers?batch=DELETE-BATCH', { headers: auth }); assert.equal(result.body.length, 2); const selectedVoucherId = result.body[0].id;
  result = await request('/api/admin/vouchers', { method: 'DELETE', headers: auth, body: JSON.stringify({ ids: [selectedVoucherId] }) }); assert.equal(result.body.deleted, 1);
  result = await request('/api/admin/vouchers', { method: 'DELETE', headers: auth, body: JSON.stringify({ batch_code: 'DELETE-BATCH' }) }); assert.equal(result.body.deleted, 1);
  result = await request('/api/admin/vouchers?batch=DELETE-BATCH', { headers: auth }); assert.equal(result.body.length, 0);
  result = await request('/api/admin/rates', { headers: auth }); const selectedRates = result.body.slice(0, 2).map(rate => rate.id);
  result = await request('/api/admin/rates/defaults', { method: 'POST', headers: auth, body: JSON.stringify({ rate_ids: selectedRates }) }); assert.equal(result.body.rate_ids.length, 2);
  result = await request('/api/admin/rates/apply-all', { method: 'PUT', headers: auth, body: JSON.stringify({ rate_ids: selectedRates }) }); assert.ok(result.body.machine_count >= 1);
  result = await request(`/api/admin/machines/${machineId}/rates`, { method: 'PUT', headers: auth, body: JSON.stringify({ rate_ids: selectedRates }) }); assert.equal(result.body.length, 2);
  result = await request('/api/public/context'); assert.equal(result.body.machine_rates[machineId].length, 2);
  result = await request('/api/admin/sessions', { headers: auth }); const live = result.body.find(item => item.mac === CLIENT); assert.ok(live);
  result = await request(`/api/admin/sessions/${live.id}/actions`, { method: 'POST', headers: auth, body: JSON.stringify({ action: 'auto_pause' }) }); assert.equal(result.response.status, 200); assert.equal(result.body.status, 'paused'); assert.equal(result.body.auto_reconnect, true);
  result = await request('/api/admin/sessions', { headers: auth }); assert.equal(result.body.find(item => item.id === live.id).auto_reconnect, true);
  result = await request('/api/public/context'); assert.equal(result.body.access.status, 'active'); assert.equal(result.body.access.auto_reconnect, false);
  result = await request('/api/admin/settings', { method: 'POST', headers: auth, body: JSON.stringify({ auto_pause_reconnect_enabled: '0' }) }); assert.equal(result.body.auto_pause_reconnect_enabled, '0');
  result = await request(`/api/admin/sessions/${live.id}/actions`, { method: 'POST', headers: auth, body: JSON.stringify({ action: 'auto_pause' }) }); assert.equal(result.response.status, 409); assert.match(result.body.error, /disabled in System settings/i);
  result = await request('/api/admin/settings', { method: 'POST', headers: auth, body: JSON.stringify({ auto_pause_reconnect_enabled: '1' }) }); assert.equal(result.body.auto_pause_reconnect_enabled, '1');
  result = await request(`/api/admin/sessions/${live.id}/actions`, { method: 'POST', headers: auth, body: JSON.stringify({ action: 'extend', seconds: 600 }) }); assert.ok(result.body.remaining_seconds >= 1790);
  result = await request(`/api/admin/sessions/${live.id}/actions`, { method: 'POST', headers: auth, body: JSON.stringify({ action: 'speed', rate_limit: '10M/3M' }) }); assert.equal(result.response.status, 200); assert.equal(result.body.rate_limit, '10M/3M');
  result = await request(`/api/admin/sessions/${live.id}/actions`, { method: 'POST', headers: auth, body: JSON.stringify({ action: 'speed', rate_limit: 'unlimited' }) }); assert.equal(result.response.status, 400);
  result = await request('/api/admin/network/user-speed', { method: 'POST', headers: auth, body: JSON.stringify({ enabled: true, download_mbps: 8, upload_mbps: 2, apply_to_all_users: true }) }); assert.equal(result.response.status, 200); assert.ok(result.body.affected_users >= 1); assert.equal(result.body.rate_limit, '8M/2M');
  result = await request('/api/admin/sessions', { headers: auth }); assert.ok(result.body.filter(item => ['active','paused'].includes(item.status)).every(item => item.rate_limit === '8M/2M'));
  result = await request('/api/admin/vouchers/generate', { method: 'POST', headers: auth, body: JSON.stringify({ quantity: 1, duration_seconds: 300, batch_code: 'GLOBAL-SPEED' }) }); const globalSpeedVoucher = result.body.codes[0];
  result = await request('/api/public/vouchers/redeem', { method: 'POST', body: JSON.stringify({ code: globalSpeedVoucher }) }, CLIENT_4); assert.equal(result.response.status, 200); assert.equal(result.body.access.rate_limit, '8M/2M');
  result = await request('/api/admin/network/user-speed', { method: 'POST', headers: auth, body: JSON.stringify({ enabled: true, download_mbps: 0, upload_mbps: 2 }) }); assert.equal(result.response.status, 400);
  result = await request('/api/admin/sessions', { headers: auth }); const removable = result.body.find(item => item.mac === CLIENT_3); assert.ok(removable);
  result = await request(`/api/admin/sessions/${removable.id}/actions`, { method: 'POST', headers: auth, body: JSON.stringify({ action: 'block' }) }); assert.equal(result.response.status, 200); assert.equal(result.body.status, 'blocked');
  result = await request('/api/public/sessions', { method: 'POST', body: JSON.stringify({ machine_id: machineId }) }, CLIENT_3); assert.equal(result.response.status, 403);
  result = await request(`/api/admin/sessions/${removable.id}/actions`, { method: 'POST', headers: auth, body: JSON.stringify({ action: 'unblock' }) }); assert.equal(result.response.status, 200); assert.equal(result.body.status, 'expired');
  result = await request(`/api/admin/sessions/${removable.id}`, { method: 'DELETE', headers: auth }); assert.equal(result.response.status, 200); assert.equal(result.body.deleted, true);
  result = await request('/api/admin/sessions', { headers: auth }); assert.equal(result.body.some(item => item.id === removable.id), false);
  result = await request('/api/admin/collections', { method: 'POST', headers: auth, body: JSON.stringify({ machine_id: machineId, actual_amount_centavos: 150, collector: 'Tester' }) }); assert.equal(result.body.system_amount_centavos, 300); assert.equal(result.body.variance_centavos, -150);
  result = await request('/api/admin/collections', { headers: auth }); assert.equal(result.body.length, 1);
  result = await request('/api/admin/backups', { method: 'POST', headers: auth, body: '{}' }); assert.equal(result.response.status, 201);
  result = await request('/api/admin/backups', { headers: auth }); assert.equal(result.body.length, 1);
  result = await request('/api/admin/export/sales.csv', { headers: auth }); assert.equal(result.response.status, 200); assert.match(result.body, /Front Counter/);
  result = await request('/api/admin/sales/reset', { method: 'POST', headers: auth, body: '{}' }); assert.equal(result.response.status, 200); assert.ok(result.body.deleted_sales >= 4); assert.match(result.body.backup, /^pre-sales-reset-/);
  result = await request('/api/admin/sales', { headers: auth }); assert.equal(result.body.length, 0);
  result = await request('/api/admin/summary', { headers: auth }); assert.equal(result.body.sales_today_centavos, 0); assert.equal(result.body.cash_waiting_centavos, 0);
  result = await request('/api/admin/firmware', { method: 'PUT', headers: { ...auth, 'content-type': 'application/octet-stream', 'x-firmware-version': '0.2.0', 'x-firmware-board': 'ESP8266' }, body: Buffer.from([0xe9, 0x00, 0x00, 0x00]) }); assert.equal(result.response.status, 201);
  result = await request('/api/admin/firmware', { method: 'PUT', headers: { ...auth, 'content-type': 'application/octet-stream', 'x-firmware-version': 'bad-version', 'x-firmware-board': 'ESP8266' }, body: Buffer.from([0xe9, 0x00, 0x00, 0x00]) }); assert.equal(result.response.status, 400);
  result = await request('/api/admin/firmware', { method: 'PUT', headers: { ...auth, 'content-type': 'application/octet-stream', 'x-firmware-version': '0.2.1', 'x-firmware-board': 'ESP8266' }, body: Buffer.from([0x00, 0x00, 0x00, 0x00]) }); assert.equal(result.response.status, 400);
  result = await request('/api/admin/firmware', { headers: auth }); assert.equal(result.body.length, 1); assert.equal(result.body[0].signed, 1); const releaseId = result.body[0].id;
  result = await request('/api/admin/firmware/deploy', { method: 'POST', headers: auth, body: JSON.stringify({ release_id: releaseId }) }); assert.equal(result.body.queued, 1);
  result = await request('/api/admin/firmware/deploy', { method: 'POST', headers: auth, body: JSON.stringify({ release_id: releaseId }) }); assert.equal(result.body.queued, 0); assert.equal(result.body.already_queued, 1);
  result = await request('/api/admin/firmware/deploy', { method: 'POST', headers: auth, body: JSON.stringify({ all_esp: true }) }); assert.equal(result.body.queued, 0); assert.equal(result.body.already_queued, 1);
  result = await request('/api/admin/firmware/status', { headers: auth }); assert.equal(result.response.status, 200); assert.equal(result.body.counts.total, 1); assert.equal(result.body.machines[0].target_version, '0.2.0'); assert.ok(['queued','waiting_offline'].includes(result.body.machines[0].status)); assert.equal(result.body.rollouts[0].status, 'canary');

  result = await request('/api/public/context'); const deviceKey = result.body.device_key,deviceCookie=result.response.headers.get('set-cookie')?.split(';')[0]; assert.ok(deviceKey); assert.match(deviceCookie, /^vendo_device_key=/);
  result = await request('/api/public/context', { headers: { 'x-vendo-device-key': deviceKey } }, CLIENT_3); assert.equal(result.body.restored_private_mac, true); assert.equal(result.body.access.status, 'active');
  result = await request('/api/public/context', { headers: { cookie: deviceCookie } }, CLIENT_5); assert.equal(result.body.restored_private_mac, true); assert.equal(result.body.access.status, 'active'); assert.equal(result.body.previous_mac, CLIENT_3);
  result = await request('/api/admin/sessions', { headers: auth }); const randomized = result.body.find(item => item.mac === CLIENT_5); assert.ok(randomized); assert.equal(randomized.random_mac_detected, true); assert.equal(randomized.previous_mac, CLIENT_3); assert.ok(randomized.identity_id);

  result = await request('/api/admin/stations/enroll', { method: 'POST', headers: auth, body: JSON.stringify({ name: 'VLAN 186 Vendo', hardware_id: 'ESP8266-VLAN186', location: 'Test gate', parent_if: 'eth-test', vlan_id: 186, zone_name: 'Test VLAN 186', subnet: '10.186.0.0/24', gateway: '10.186.0.1', dhcp_start: '10.186.0.20', dhcp_end: '10.186.0.200', coin_pin: 2, enable_pin: 15 }) });
  assert.equal(result.response.status, 201); assert.equal(result.body.zone.vlan_id, 186); const vlanMachineId = Number(result.body.machine.id); const vlanZoneId = Number(result.body.zone.id);
  result = await request('/api/admin/zones', { headers: auth }); assert.ok(result.body.some(zone => zone.vlan_id === 186 && zone.machine_count === 1));
  result = await request('/api/admin/stations/enroll', { method: 'POST', headers: auth, body: JSON.stringify({ parent_if: 'eth-test', vlan_id: 190, vlan_end: 192, zone_name: 'Range Zone' }) });
  assert.equal(result.response.status, 201); assert.equal(result.body.count, 3); assert.deepEqual(result.body.zones.map(zone => zone.vlan_id), [190, 191, 192]); const vlan190ZoneId = Number(result.body.zones[0].id);
  result = await request('/api/admin/stations/enroll', { method: 'POST', headers: auth, body: JSON.stringify({ parent_if: 'eth-test', vlan_id: 192, vlan_end: 193 }) }); assert.equal(result.response.status, 409);
  result = await request('/api/admin/stations/enroll', { method: 'POST', headers: auth, body: JSON.stringify({ parent_if: 'eth-test', vlan_id: 4094 }) }); assert.equal(result.response.status, 201); assert.equal(result.body.zone.subnet, '10.16.30.0/24');
  result = await request('/api/admin/stations/enroll', { method: 'POST', headers: auth, body: JSON.stringify({ parent_if: 'eth-test', vlan_id: 1, vlan_end: 4094 }) }); assert.equal(result.response.status, 409); assert.match(result.body.error, /overlaps existing VLAN/, 'the maximum automatic range must pass validation before conflict checking');
  result = await request('/api/admin/stations/enroll', { method: 'POST', headers: auth, body: JSON.stringify({ parent_if: 'eth-test', vlan_id: 1, vlan_end: 4095 }) }); assert.equal(result.response.status, 400);
  result = await request('/api/admin/zones', { headers: auth }); assert.equal(result.body.filter(zone => [190,191,192].includes(zone.vlan_id)).length, 3); assert.equal(result.body.some(zone => zone.vlan_id === 193), false, 'overlapping range must not partially create VLANs');
  result = await request('/api/device/provision', { method: 'POST', headers: { 'x-provision-key': PROVISION_KEY }, body: JSON.stringify({ hardware_id: 'ESP8266-VLAN186', name: 'VLAN 186 Vendo', coin_pin: 2, enable_pin: 15 }) }); assert.equal(result.response.status, 200);
  result = await request('/api/admin/machines', { headers: auth }); assert.equal(result.body.find(machine => machine.id === vlanMachineId).zone_id, vlanZoneId, 'provisioning must preserve the reserved VLAN');
  result = await request(`/api/admin/zones/${vlan190ZoneId}`, { method: 'PATCH', headers: auth, body: JSON.stringify({ name: 'North Wing', description: 'Second-floor customer access', parent_if: 'eth-test', subnet: '10.190.0.0/24', gateway: '10.190.0.1', dhcp_start: '10.190.0.20', dhcp_end: '10.190.0.250', enabled: true }) }); assert.equal(result.response.status, 200); assert.equal(result.body.description, 'Second-floor customer access');
  result = await request(`/api/admin/zones/${vlan190ZoneId}/stations`, { method: 'PUT', headers: auth, body: JSON.stringify({ machine_ids: [vlanMachineId] }) }); assert.equal(result.response.status, 200);
  result = await request('/api/admin/machines', { headers: auth }); assert.equal(result.body.find(machine => machine.id === vlanMachineId).zone_id, vlan190ZoneId, 'station assignment must move the station to the selected VLAN');
  result = await request(`/api/admin/zones/${vlan190ZoneId}`, { method: 'DELETE', headers: auth }); assert.equal(result.response.status, 409, 'a VLAN with an assigned station must not be deleted');
  result = await request(`/api/admin/zones/${vlan190ZoneId}/stations`, { method: 'PUT', headers: auth, body: JSON.stringify({ machine_ids: [] }) }); assert.equal(result.response.status, 200);
  result = await request(`/api/admin/zones/${vlan190ZoneId}`, { method: 'DELETE', headers: auth }); assert.equal(result.response.status, 200); assert.equal(result.body.archived, true);
  result = await request('/api/admin/zones', { headers: auth }); assert.equal(result.body.find(zone => zone.id === vlan190ZoneId).enabled, 0, 'deleted VLAN must be archived for historical records');
  result = await request(`/api/admin/machines/${vlanMachineId}`, { method: 'DELETE', headers: auth }); assert.equal(result.response.status, 200);

  result = await request('/api/device/heartbeat', { method: 'POST', headers: { 'x-vendo-device': 'ESP8266-AABBCC', authorization: 'Bearer wrong' }, body: '{}' }); assert.equal(result.response.status, 401);

  result = await request(`/api/admin/machines/${machineId}`, { method: 'DELETE', headers: { authorization: `Bearer ${adminToken}` } }); assert.equal(result.response.status, 200);
  result = await request('/api/public/context'); assert.equal(result.body.machines.length, 0);
});
