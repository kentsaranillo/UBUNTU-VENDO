'use strict';

const $ = id => document.getElementById(id);
const state = { context: null, access: null, machineId: null, session: null, timer: null, accessTimer: null, voucherToastTimer: null, lastCoinAmount: 0, soundContext: null, insertSoundTimer: null, coinStream: null, coinCountdown: null, coinDeadline: 0 };

async function api(url, options = {}) {
  const deviceKey = localStorage.getItem('vendo_device_key') || '';
  const response = await fetch(url, { cache: 'no-store', ...options, headers: { 'content-type': 'application/json', ...(deviceKey ? { 'x-vendo-device-key': deviceKey } : {}), ...(options.headers || {}) } });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}
function money(centavos) { return `₱${(Number(centavos || 0) / 100).toFixed(2)}`; }
function duration(seconds) {
  return clockDuration(seconds);
}
function durationParts(seconds) {
  let value = Math.max(0, Math.floor(Number(seconds || 0))); const days = Math.floor(value / 86400); value %= 86400;
  const hours = Math.floor(value / 3600); value %= 3600; const minutes = Math.floor(value / 60); const secs = value % 60;
  return [[days, 'D'], [hours, 'HR'], [minutes, 'MIN'], [secs, 'SEC']];
}
function clockDuration(seconds) {
  return durationParts(seconds).map(([value], index) => String(value).padStart(2, '0') + ['d', 'h', 'm', 's'][index]).join(' ');
}
function renderDuration(element, seconds) {
  const parts = durationParts(seconds);
  element.textContent = clockDuration(seconds);
  element.setAttribute('aria-label', `${parts[0][0]} days, ${parts[1][0]} hours, ${parts[2][0]} minutes, ${parts[3][0]} seconds remaining`);
}
function setPortalState(accessState) {
  const allowed = new Set(['ready', 'active', 'paused', 'offline', 'coin']);
  document.body.dataset.accessState = allowed.has(accessState) ? accessState : 'ready';
}
function notice(message, isError = false) { $('portalNotice').textContent = message || ''; $('portalNotice').style.color = isError ? 'var(--danger)' : 'var(--brand-dark)'; }
function closeVoucherToast() { clearTimeout(state.voucherToastTimer); const toast = $('voucherToast'); toast.classList.remove('show'); setTimeout(() => { if (!toast.classList.contains('show')) toast.hidden = true; }, 180); }
function voucherFeedback(message, type = 'error') {
  const toast = $('voucherToast'), success = type === 'success'; clearTimeout(state.voucherToastTimer);
  $('voucherToastIcon').textContent = success ? '✓' : '!'; $('voucherToastTitle').textContent = success ? 'Voucher accepted' : 'Voucher not accepted'; $('voucherToastMessage').textContent = message;
  toast.className = `voucher-toast ${success ? 'success' : 'error'}`; toast.hidden = false; requestAnimationFrame(() => toast.classList.add('show'));
  state.voucherToastTimer = setTimeout(closeVoucherToast, success ? 6500 : 9000);
}
function openModal(id) { const modal = $(id); modal.classList.add('open'); modal.setAttribute('aria-hidden', 'false'); if (id === 'coinModal') setPortalState('coin'); modal.querySelector('button')?.focus(); }
function closeModal(id) { const modal = $(id); modal.classList.remove('open'); modal.setAttribute('aria-hidden', 'true'); if (id === 'coinModal') renderAccess(); }
function selectedMachine() { return Number($('machineSelect').value || state.machineId || 0); }
function validColor(value, fallback) { return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : fallback; }
const PORTAL_THEMES = ['battle-royale', 'neon', 'ad-showcase', 'lite'];
const PORTAL_THEME_COPY = {
  lite:{active:'CONNECTED',ready:'DISCONNECTED',paused:'PAUSED',coin:'INSERT COIN',rates:'WIFI RATES',ratesDetail:'',voucher:'Voucher Here..',redeem:'SUBMIT'},
  'battle-royale':{active:'CONNECTED',ready:'DISCONNECTED',paused:'TIME PAUSED',time:'REMAINING TIME',pause:'PAUSE & DISCONNECT',resume:'RECONNECT',coin:'INSERT COIN',rates:'WIFI RATES',ratesDetail:'View available play time',voucher:'Enter voucher code',redeem:'REDEEM'},
  neon:{active:'ONLINE',ready:'DISCONNECTED',paused:'PAUSED',time:'TIME REMAINING',pause:'PAUSE CONNECTION',resume:'RECONNECT',coin:'INSERT COIN',rates:'WIFI RATES',ratesDetail:'Choose a time package',voucher:'Enter voucher code',redeem:'CONNECT'},
  'ad-showcase':{active:'CONNECTED',ready:'GET ONLINE',paused:'PAUSED',time:'TIME REMAINING',pause:'PAUSE & DISCONNECT',resume:'RECONNECT',coin:'INSERT COIN',rates:'WIFI PLANS',ratesDetail:'Pick a plan that fits your day',voucher:'Enter voucher code',redeem:'REDEEM'}
};
function themeCopy(){return PORTAL_THEME_COPY[state.portalTheme]||{active:'CONNECTED',ready:'READY TO CONNECT',paused:'TIME PAUSED',coin:'INSERT COIN / ADD TIME',coinDetail:'Add time by inserting coin',rates:'WIFI RATES',ratesDetail:'View available WiFi rates',voucher:'Enter voucher code',redeem:'REDEEM'}}
function applyBranding(settings = {}) {
  const brand = settings.brand_name || 'VendoOS WiFi';
  const theme = PORTAL_THEMES.includes(settings.portal_theme) ? settings.portal_theme : 'battle-royale';
  const primary = validColor(settings.portal_primary_color, '#ffa847');
  const accent = validColor(settings.portal_accent_color, '#70d5ff');
  state.portalTheme = theme;
  const liteLogo = $('liteLogo');
  liteLogo.hidden = theme !== 'lite';
  if (theme === 'lite') {
    liteLogo.onerror = () => { liteLogo.onerror = null; liteLogo.src = '/assets/portal-lite-logo.svg'; };
    liteLogo.src = settings.portal_logo_url && settings.portal_logo_url !== '/assets/defaults/vendo-logo.svg'
      ? settings.portal_logo_url : '/assets/portal-lite-logo.svg';
  }
  document.body.classList.toggle('promo-portal', theme !== 'lite');
  const pauseButton = $('pauseButton');
  if (theme === 'lite') $('coinButton').after(pauseButton);
  else $('expiryText').after(pauseButton);
  document.documentElement.style.setProperty('--portal-primary', primary);
  document.documentElement.style.setProperty('--portal-accent', accent);
  document.documentElement.style.setProperty('--brand', primary);
  document.documentElement.style.setProperty('--brand-dark', primary);
  document.body.style.setProperty('--portal-primary', primary);
  document.body.style.setProperty('--portal-accent', accent);
  document.body.style.setProperty('--brand', primary);
  document.body.style.setProperty('--brand-dark', primary);
  for (const name of PORTAL_THEMES) document.body.classList.toggle(name==='lite'?'portal-lite-mode':`portal-theme-${name}`, theme === name);
  document.body.classList.remove('portal-theme-command');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'lite' ? '#ffffff' : theme === 'neon' ? '#070713' : theme === 'ad-showcase' ? '#fff8ef' : '#eef2f5');
  document.title = 'WiFi Access';
  const announcement = settings.portal_announcement || '';
  $('portalAnnouncement').textContent = announcement;
  $('portalAnnouncement').classList.toggle('hidden', !announcement || theme === 'ad-showcase');
  $('adPromo').classList.toggle('hidden', theme !== 'ad-showcase');
  $('adPromoBrand').textContent = brand;
  $('adPromoHeadline').textContent = settings.portal_headline || 'A great local offer is waiting';
  $('adPromoTagline').textContent = settings.portal_tagline || '';
  $('adPromoMessage').textContent = announcement;
  $('adPromoMessage').classList.toggle('hidden', !announcement);
  const banner = theme === 'lite' ? '' : settings.portal_banner_url || '';
  $('portalBanner').classList.remove('hidden');
  $('portalBannerImage').hidden = !banner;
  if (banner) { $('portalBannerImage').src = banner; $('portalBannerImage').alt = 'Battle royale game artwork'; }
  else { $('portalBannerImage').removeAttribute('src'); $('portalBannerImage').alt = ''; }
  $('insertCoinAudio').src = settings.portal_insert_sound_url || '';
  $('coinReceivedAudio').src = settings.portal_coin_sound_url || '';
  const copy=themeCopy(),coinCopy=$('coinButton').querySelector('.action-copy'),rateCopy=$('ratesButton').querySelector('.action-copy');
  coinCopy.querySelector('strong').textContent=copy.coin;
  rateCopy.querySelector('strong').textContent=copy.rates;rateCopy.querySelector('small').textContent=copy.ratesDetail;
  $('voucherCode').placeholder=copy.voucher;$('redeemButton').textContent=copy.redeem;
}
function soundContext() { if (!state.soundContext) state.soundContext = new (window.AudioContext || window.webkitAudioContext)(); return state.soundContext; }
function tone(frequency, duration = .16, volume = .035, delay = 0) { try { const context=soundContext(),start=context.currentTime+delay,oscillator=context.createOscillator(),gain=context.createGain();oscillator.type='sine';oscillator.frequency.setValueAtTime(frequency,start);gain.gain.setValueAtTime(.0001,start);gain.gain.exponentialRampToValueAtTime(volume,start+.02);gain.gain.exponentialRampToValueAtTime(.0001,start+duration);oscillator.connect(gain).connect(context.destination);oscillator.start(start);oscillator.stop(start+duration+.03) } catch {} }
function playAudio(element, kind) { const source=element?.getAttribute('src');if(source){element.currentTime=0;element.play().catch(()=>{});return}if(kind==='insert'){clearInterval(state.insertSoundTimer);const pulse=()=>{tone(392,.22,.018);tone(587,.18,.014,.18)};pulse();state.insertSoundTimer=setInterval(pulse,2400)}else{tone(880,.12,.055);tone(1320,.2,.04,.1)} }
function stopInsertAudio() { clearInterval(state.insertSoundTimer);state.insertSoundTimer=null;const audio=$('insertCoinAudio');audio.pause();audio.currentTime=0; }

function renderRates() {
  const rates = state.context.machine_rates?.[selectedMachine()] || state.context.rates;
  const enabled=Boolean(state.context.payments?.enabled);
  $('ratesList').innerHTML = rates.map(rate => `<div class="rate-card"><div><strong>${escapeHtml(rate.name)}</strong><span>${duration(rate.duration_seconds)} · ${escapeHtml(rate.rate_limit)}</span></div><div class="rate-purchase"><div class="rate-price">${money(rate.price_centavos)}</div>${enabled?`<button type="button" class="button primary checkout-button" data-checkout-rate="${Number(rate.id)}">Pay with GCash / Maya</button>`:''}</div></div>`).join('') || '<p class="muted">No rates configured.</p>';
}
function renderCampaigns() {
  const campaigns=state.context?.campaigns||[],container=$('campaignShowcase');
  container.classList.toggle('hidden',!campaigns.length);
  container.innerHTML=campaigns.map(c=>`<article class="campaign-card" data-campaign-id="${Number(c.id)}">${c.image_url?`<img src="${escapeHtml(c.image_url)}" alt="${escapeHtml(c.sponsor||c.name)}" loading="lazy">`:''}<div><small>SPONSORED${c.sponsor?` · ${escapeHtml(c.sponsor)}`:''}</small><strong>${escapeHtml(c.headline)}</strong>${c.body?`<p>${escapeHtml(c.body)}</p>`:''}${/^https:\/\//i.test(c.target_url||'')?`<a href="${escapeHtml(c.target_url)}" target="_blank" rel="noopener noreferrer" data-campaign-click="${Number(c.id)}">Learn more</a>`:''}</div></article>`).join('');
  campaigns.forEach(c=>api('/api/public/ads/impression',{method:'POST',body:JSON.stringify({campaign_id:c.id})}).catch(()=>{}));
}
function renderLoyalty(){const loyalty=state.context?.loyalty||{points:0,reward_threshold:100};$('loyaltyBalance').hidden=Number(loyalty.points)<=0;$('loyaltyBalance').innerHTML=`<span>${Number(loyalty.points)||0} WiFi reward points</span>${Number(loyalty.points)>=Number(loyalty.reward_threshold||100)?'<button type="button" class="loyalty-redeem">CLAIM 30 MIN</button>':''}`;}
async function startCheckout(rateId) {
  const button=document.querySelector(`[data-checkout-rate="${Number(rateId)}"]`);if(button)button.disabled=true;
  try { const result=await api('/api/public/payments/checkout',{method:'POST',body:JSON.stringify({rate_id:Number(rateId),machine_id:selectedMachine()})});sessionStorage.setItem('vendo_pending_payment',JSON.stringify({orderId:result.order_id,token:result.token}));window.location.assign(result.checkout_url); }
  catch(error){notice(error.message,true);if(button)button.disabled=false;}
}
async function resumePaymentReturn() {
  const params=new URLSearchParams(location.search),saved=JSON.parse(sessionStorage.getItem('vendo_pending_payment')||'null'),orderId=params.get('payment_order')||saved?.orderId,token=params.get('payment_token')||saved?.token;if(!orderId||!token)return;
  sessionStorage.setItem('vendo_pending_payment',JSON.stringify({orderId,token}));const cleanUrl=new URL(location.href);cleanUrl.searchParams.delete('payment_order');cleanUrl.searchParams.delete('payment_token');history.replaceState({},'',cleanUrl);
  notice('Payment received by PayMongo. Confirming your voucher…');
  for(let attempt=0;attempt<90;attempt++){
    try {
      const result=await api(`/api/public/payments/orders/${encodeURIComponent(orderId)}?token=${encodeURIComponent(token)}`),order=result.order;
      if(order.status==='redeemed'){sessionStorage.removeItem('vendo_pending_payment');await refreshAccess();notice('Payment confirmed. Your WiFi time is active.');return;}
      if(order.status==='fulfilled'&&order.voucher_code){
        const redeemed=await api('/api/public/vouchers/redeem',{method:'POST',body:JSON.stringify({code:order.voucher_code})});sessionStorage.removeItem('vendo_pending_payment');state.access=redeemed.access;renderAccess();notice('Payment confirmed. Your WiFi time is active.');return;
      }
      if(['cancelled','failed','expired'].includes(order.status)){sessionStorage.removeItem('vendo_pending_payment');notice('This checkout did not complete. You can choose a WiFi plan and try again.',true);return;}
    } catch(error){notice(error.message,true);return;}
    await new Promise(resolve=>setTimeout(resolve,2000));
  }
  notice('Payment is still being confirmed. Refresh this page in a moment to check again.');
}
function renderAccess() {
  const access = state.access || { status: 'none', remaining_seconds: 0 };
  const active = access.status === 'active' && access.remaining_seconds > 0;
  const paused = access.status === 'paused' && access.remaining_seconds > 0;
  const copy=themeCopy();
  setPortalState(active ? 'active' : paused ? 'paused' : state.context?.machines?.length ? 'ready' : 'offline');
  $('connectionStatus').textContent = active ? copy.active : paused ? copy.paused : copy.ready;
  $('statusIcon').textContent = active ? '✓' : paused ? 'Ⅱ' : '⌁';
  const remaining = $('remainingTime');
  $('creditLabel').textContent = 'REMAINING TIME';
  renderDuration(remaining, access.remaining_seconds);
  if (state.portalTheme === 'lite') {
    $('liteDevice').textContent = [
      state.context?.client_mac && 'MAC: ' + state.context.client_mac.toUpperCase(),
      state.context?.client_ip && 'IP: ' + state.context.client_ip
    ].filter(Boolean).join(' | ');
    $('liteBalance').textContent = 'COINS: ' + money(state.session?.amount_centavos || 0) + ' | POINTS: ' + (Number(state.context?.loyalty?.points) || 0);
  }
  $('commandStatusDetail').textContent = active ? 'You are now online' : paused ? 'Your time is safely paused' : 'Insert coins or redeem a voucher';
  $('expiryText').textContent = active && access.expires_at ? `Expires ${new Date(access.expires_at).toLocaleString()}` : paused ? 'Resume whenever you are ready' : 'Insert coins or redeem a voucher';
  $('pauseButton').disabled = !(active || paused);
  $('pauseLabel').textContent = paused ? 'RESUME INTERNET' : state.portalTheme === 'lite' ? 'PAUSE' : 'PAUSE & DISCONNECT';
}
function escapeHtml(value) { return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[char]); }
function configureStations() {
  const machines = state.context.machines;
  $('machineSelect').innerHTML = machines.map(machine => `<option value="${machine.id}">${escapeHtml(machine.name)}</option>`).join('');
  const requestedId = Number(new URLSearchParams(location.search).get('machine') || 0);
  const requested = machines.find(machine => machine.id === requestedId);
  state.machineId = requested?.id || Number(state.context.selected_machine_id || 0) || machines[0]?.id || null;
  if (state.machineId) $('machineSelect').value = String(state.machineId);
  $('stationPicker').classList.toggle('hidden', machines.length <= 1 || Boolean(requested) || Boolean(state.context.selected_machine_id));
  $('coinButton').disabled = !state.machineId;
  document.body.dataset.stationState = machines.length ? 'online' : 'offline';
  if (!machines.length) { setPortalState('offline'); notice('The coin station is offline. Voucher access is still available.', true); }
}
async function refreshAccess() {
  try { state.access = await api('/api/public/access'); renderAccess(); }
  catch (error) { notice(error.message, true); }
}
async function startCoin() {
  const button = $('coinButton');
  if (button.disabled) return;
  button.disabled = true;
  const label = button.querySelector('strong');
  if (state.portalTheme === 'lite') label.textContent = 'OPENING SLOT…';
  try {
    notice('');
    const session = await api('/api/public/sessions', { method: 'POST', body: JSON.stringify({ machine_id: selectedMachine() }) });
    stopCoinCountdown(); state.session = session; state.lastCoinAmount = Number(session.amount_centavos || 0); renderCoin(session); openModal('coinModal'); playAudio($('insertCoinAudio'),'insert'); if (!startCoinStream()) pollCoin();
  } catch (error) { notice(error.message, true); }
  finally {
    button.disabled = !selectedMachine();
    if (state.portalTheme === 'lite') label.textContent = themeCopy().coin;
  }
}
function stopCoinStream() { if (state.coinStream) state.coinStream.close(); state.coinStream = null; }
function stopCoinCountdown() { clearInterval(state.coinCountdown); state.coinCountdown = null; state.coinDeadline = 0; }
function renderCoinCountdown() {
  if (!state.session || state.session.status !== 'open' || !state.coinDeadline) return;
  const seconds = Math.max(0, Math.ceil((state.coinDeadline - Date.now()) / 1000));
  $('leaseTimer').textContent = clockDuration(seconds);
}
function syncCoinCountdown(session) {
  state.coinDeadline = Date.now() + Math.max(0, Number(session.seconds_left || 0)) * 1000;
  if (!state.coinCountdown) state.coinCountdown = setInterval(renderCoinCountdown, 250);
  renderCoinCountdown();
}
function startCoinStream() {
  stopCoinStream(); if (!state.session || !window.EventSource) return false;
  const id = state.session.id, token = state.session.token;
  const stream = new EventSource(`/api/public/sessions/${id}/stream?token=${encodeURIComponent(token)}`); state.coinStream = stream;
  stream.onmessage = event => {
    if (!state.session || state.session.id !== id) return stopCoinStream();
    try {
      const session = JSON.parse(event.data); session.token = token; state.session = session; renderCoin(session);
      if (session.status !== 'open') { stopCoinCountdown(); stopCoinStream(); clearTimeout(state.timer); pollCoin(); }
    } catch {}
  };
  stream.onerror = () => { if (!state.session || state.session.id !== id) return; stopCoinStream(); clearTimeout(state.timer); state.timer = setTimeout(pollCoin, 500); };
  return true;
}
function renderCoin(session) {
  const amount = Number(session.amount_centavos || 0);
  if (amount > state.lastCoinAmount) playAudio($('coinReceivedAudio'),'coin');
  state.lastCoinAmount = amount;
  $('coinAmount').textContent = money(session.amount_centavos);
  $('coinCredit').textContent = session.credited_seconds > 0 ? `${clockDuration(session.credited_seconds)} internet time` : 'Waiting for a coin pulse';
  if (session.status === 'open') syncCoinCountdown(session); else stopCoinCountdown();
  $('doneButton').disabled = Number(session.amount_centavos) <= 0;
}
async function pollCoin() {
  clearTimeout(state.timer); if (!state.session) return;
  try {
    const session = await api(`/api/public/sessions/${state.session.id}`, { headers: { authorization: `Bearer ${state.session.token}` } });
    session.token = state.session.token; state.session = session; renderCoin(session);
    if (session.status === 'completed') { stopCoinCountdown(); stopCoinStream(); stopInsertAudio(); closeModal('coinModal'); state.session = null; await refreshAccess(); notice('Time added. Internet access is active.'); return; }
    if (session.status !== 'open') { stopCoinCountdown(); stopCoinStream(); stopInsertAudio(); closeModal('coinModal'); state.session = null; await refreshAccess(); return; }
  } catch (error) { stopCoinCountdown(); stopCoinStream(); stopInsertAudio(); closeModal('coinModal'); state.session = null; notice(error.message, true); await refreshAccess(); return; }
  state.timer = setTimeout(pollCoin, 1500);
}
async function completeCoin() {
  if (!state.session) return;
  $('doneButton').disabled = true;
  try {
    const result = await api(`/api/public/sessions/${state.session.id}/complete`, { method: 'POST', headers: { authorization: `Bearer ${state.session.token}` }, body: '{}' });
    state.access = result.access; state.session = null; clearTimeout(state.timer); stopCoinCountdown(); stopCoinStream(); stopInsertAudio(); closeModal('coinModal'); renderAccess(); notice('Time added. Internet access is active.');
  } catch (error) { $('doneButton').disabled = false; notice(error.message, true); }
}
async function cancelCoin() {
  if (!state.session) { stopCoinCountdown(); stopCoinStream(); stopInsertAudio(); return closeModal('coinModal'); }
  try { await api(`/api/public/sessions/${state.session.id}/cancel`, { method: 'POST', headers: { authorization: `Bearer ${state.session.token}` }, body: '{}' }); } catch {}
  clearTimeout(state.timer); stopCoinCountdown(); stopCoinStream(); stopInsertAudio(); state.session = null; closeModal('coinModal');
}
async function pauseOrResume() {
  const action = state.access?.status === 'paused' ? 'resume' : 'pause';
  try { state.access = await api(`/api/public/access/${action}`, { method: 'POST', body: '{}' }); renderAccess(); notice(action === 'pause' ? 'Time paused. You can resume later.' : 'Internet access resumed.'); }
  catch (error) { notice(error.message, true); }
}
async function redeem(event) {
  event.preventDefault(); const input = $('voucherCode'), button = $('redeemButton'), code = input.value.toUpperCase().replace(/\s+/g, '');
  if (!code) { voucherFeedback('Enter your voucher code, then tap Redeem.'); input.focus(); return; }
  button.disabled = true; button.textContent = 'CHECKING…'; notice(''); closeVoucherToast();
  try {
    const result = await api('/api/public/vouchers/redeem', { method: 'POST', body: JSON.stringify({ code }) });
    state.access = result.access; input.value = ''; renderAccess(); const added = duration(result.access?.remaining_seconds || 0); voucherFeedback(`${added} of internet time is now available.`, 'success'); notice('Voucher accepted. Time has been added.');
  } catch (error) { voucherFeedback(error.message || 'Check the code and try again.'); notice(error.message, true); input.select(); }
  finally { button.disabled = false; button.textContent = themeCopy().redeem; }
}
async function init() {
  try {
    state.context = await api('/api/public/context'); if (state.context.device_key) localStorage.setItem('vendo_device_key', state.context.device_key); state.access = state.context.access; applyBranding(state.context.settings); configureStations(); if (state.portalTheme !== 'lite') { renderRates(); renderCampaigns(); } renderAccess();
    renderLoyalty();
    if (state.context.identity_conflict) notice('This browser identity is already active on another device. Disconnect the other device or ask the operator for help.', true);
    else if (state.context.restored_private_mac) notice('Private MAC changed. Your remaining time was restored automatically.');
    if(new URLSearchParams(location.search).has('payment_order')||sessionStorage.getItem('vendo_pending_payment'))resumePaymentReturn();
    state.accessTimer = setInterval(() => { if (state.access?.status === 'active') { state.access.remaining_seconds = Math.max(0, state.access.remaining_seconds - 1); if (!state.access.remaining_seconds) refreshAccess(); renderAccess(); } }, 1000);
  } catch (error) {
    // Branding is already included in a successful context response. Fetch it
    // separately only on the error path, avoiding a duplicate startup request.
    try { applyBranding(await api('/api/public/branding')); } catch {}
    renderAccess(); $('connectionStatus').textContent = 'DISCONNECTED'; $('commandStatusDetail').textContent = 'Connect to this station WiFi and try again'; notice(error.message, true);
  }
}

$('coinButton').addEventListener('click', startCoin);
$('doneButton').addEventListener('click', completeCoin);
$('pauseButton').addEventListener('click', pauseOrResume);
$('ratesButton').addEventListener('click', () => {
  if (state.portalTheme === 'lite' && state.context) renderRates();
  openModal('ratesModal');
});
$('ratesList').addEventListener('click',event=>{const button=event.target.closest('[data-checkout-rate]');if(button)startCheckout(button.dataset.checkoutRate)});
$('campaignShowcase').addEventListener('click',event=>{const link=event.target.closest('[data-campaign-click]');if(link)api('/api/public/ads/click',{method:'POST',body:JSON.stringify({campaign_id:Number(link.dataset.campaignClick)})}).catch(()=>{});});
$('loyaltyBalance').addEventListener('click',async event=>{const button=event.target.closest('.loyalty-redeem');if(!button)return;button.disabled=true;try{const result=await api('/api/public/loyalty/redeem',{method:'POST',body:'{}'});state.access=result.access;state.context.loyalty.points=result.points;renderLoyalty();renderAccess();notice('30 minutes of WiFi added using your reward points.')}catch(error){notice(error.message,true);button.disabled=false;}});
$('voucherForm').addEventListener('submit', redeem);
$('voucherToastClose').addEventListener('click', closeVoucherToast);
$('machineSelect').addEventListener('change', event => { state.machineId = Number(event.target.value); renderRates(); });
document.querySelectorAll('.modal-close').forEach(button => button.addEventListener('click', () => button.closest('.modal').id === 'coinModal' ? cancelCoin() : closeModal(button.closest('.modal').id)));
document.querySelectorAll('.modal').forEach(modal => modal.addEventListener('click', event => { if (event.target === modal) modal.id === 'coinModal' ? cancelCoin() : closeModal(modal.id); }));
document.addEventListener('keydown', event => { if (event.key === 'Escape') { if ($('coinModal').classList.contains('open')) cancelCoin(); else closeModal('ratesModal'); } });
init();
