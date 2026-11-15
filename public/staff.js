'use strict';
const $ = id => document.getElementById(id);
const portalRole = location.pathname === '/collector' ? 'collector' : 'seller';
let token = sessionStorage.getItem('vendo_staff_token') || '';
let context = null;
const requests = new Map();
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money = value => new Intl.NumberFormat('en-PH',{style:'currency',currency:'PHP'}).format(Number(value || 0)/100);
const time = value => {
  const seconds = Math.max(0,Number(value || 0));
  return [Math.floor(seconds/86400),Math.floor(seconds/3600)%24,Math.floor(seconds/60)%60,Math.floor(seconds)%60].map((v,i)=>String(v).padStart(2,'0')+['d','h','m','s'][i]).join(' ');
};
function notice(message,error=false) { $('notice').textContent=message; $('notice').classList.toggle('error',error); }
async function api(path,body) {
  const response = await fetch(path,{cache:'no-store',method:body?'POST':'GET',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:body?JSON.stringify(body):undefined});
  const data = await response.json();
  if (!response.ok) {
    if(response.status===401){token='';sessionStorage.removeItem('vendo_staff_token');location.replace('/admin');}
    if(response.status===403 && path==='/api/staff/context')location.replace('/admin');
    throw new Error(data.error || 'Request failed');
  }
  return data;
}
async function action(path,body) {
  const fingerprint = path+JSON.stringify(body);
  if (!requests.has(fingerprint)) requests.set(fingerprint,crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)),v=>v.toString(16).padStart(2,'0')).join(''));
  const result = await api(path,{...body,request_key:requests.get(fingerprint)});
  requests.delete(fingerprint);
  return result;
}
function stat(label,value){return '<div class="stat"><span>'+escapeHtml(label)+'</span><strong>'+escapeHtml(value)+'</strong></div>';}
function render() {
  const q=$('search').value.toLowerCase();
  $('seller').hidden=context.user.role!=='seller';
  $('collector').hidden=context.user.role!=='collector';
  $('identity').textContent=context.user.username+' · '+context.user.role+(context.seller_code?' · '+context.seller_code:'');
  if(context.user.role==='seller'){
    const totals=context.totals;
    $('stats').innerHTML=stat('Issued',totals.issued)+stat('Unused',totals.unused||0)+stat('Redeemed',totals.used||0)+stat('Recorded sales',money(totals.amount));
    const rates=$('issue').elements.rate_id, selected=rates.value;
    rates.innerHTML=context.rates.map(r=>'<option value="'+r.id+'">'+escapeHtml(r.name)+' · '+money(r.price_centavos)+' · '+time(r.duration_seconds)+'</option>').join('');
    if(context.rates.some(r=>String(r.id)===selected))rates.value=selected;
    $('issue').querySelector('button').disabled=!context.rates.length;
    $('vouchers').innerHTML=context.vouchers.filter(v=>(v.code_value+' '+v.batch_code).toLowerCase().includes(q)).map(v=>'<tr><td><input type="checkbox" data-voucher="'+v.id+'" aria-label="Select '+escapeHtml(v.code_value||v.code_hint)+'" '+(!v.code_value?'disabled':'')+'></td><td><b>'+escapeHtml(v.code_value||v.code_hint)+'</b><small>'+escapeHtml(v.batch_code)+'</small></td><td>'+time(v.duration_seconds)+'</td><td>'+money(v.price_centavos)+'</td><td>'+escapeHtml(v.status)+'</td><td>'+(v.sold_at?'Sold':v.status==='disabled'?'Unavailable':'<button data-sold="'+v.id+'">Mark sold</button>')+'</td></tr>').join('')||'<tr><td colspan="6">No vouchers found.</td></tr>';
    $('selectAll').checked=false; $('print').disabled=true;
  }else{
    const receipts=context.collections;
    $('stats').innerHTML=stat('Assigned stations',context.stations.length)+stat('Cash waiting',money(context.stations.reduce((n,s)=>n+s.cash_on_hand_centavos,0)))+stat('Receipts shown',receipts.length)+stat('Counted cash shown',money(receipts.reduce((n,c)=>n+c.actual_amount_centavos,0)));
    $('stations').innerHTML=context.stations.filter(s=>s.name.toLowerCase().includes(q)).map(s=>'<div class="station"><b>'+escapeHtml(s.name)+'</b><strong>'+money(s.cash_on_hand_centavos)+'</strong><p>System cash balance</p><button data-collect="'+s.id+'">Record collection</button></div>').join('')||'<p>No stations assigned. Ask an Admin to assign your collection route.</p>';
    $('collections').innerHTML=receipts.filter(c=>c.machine_name.toLowerCase().includes(q)).map(c=>'<tr><td>#'+c.id+'<small>'+escapeHtml(c.collected_at)+'</small></td><td>'+escapeHtml(c.machine_name)+'</td><td>'+money(c.system_amount_centavos)+'</td><td>'+money(c.actual_amount_centavos)+'</td><td>'+money(c.variance_centavos)+'</td></tr>').join('')||'<tr><td colspan="5">No collection receipts.</td></tr>';
  }
}
async function refresh(){
  context=await api('/api/staff/context');
  if(context.user.role!==portalRole){location.replace('/'+context.user.role);return;}
  $('workspace').hidden=false;$('logout').hidden=false;render();
}
$('title').textContent=portalRole==='seller'?'Seller portal':'Collector portal';
$('logout').onclick=async()=>{try{await api('/api/admin/logout',{})}finally{sessionStorage.removeItem('vendo_staff_token');localStorage.removeItem('vendo_admin_token');location.replace('/admin')}};
$('refresh').onclick=()=>refresh().catch(e=>notice(e.message,true));
$('search').oninput=()=>{if(context)render()};
$('issue').onsubmit=async event=>{
  event.preventDefault();const button=event.submitter;button.disabled=true;
  try{const data=Object.fromEntries(new FormData(event.target));const r=await action('/api/staff/issue',{rate_id:Number(data.rate_id),quantity:Number(data.quantity)});await refresh();notice('Issued '+r.codes.length+' vouchers in batch '+r.batch);}catch(e){notice(e.message,true)}finally{button.disabled=false}
};
$('vouchers').onclick=async event=>{
  const button=event.target.closest('[data-sold]');if(!button)return;
  if(!confirm('Confirm that payment for this voucher has been received?'))return;
  button.disabled=true;try{await action('/api/staff/sold',{voucher_id:Number(button.dataset.sold)});await refresh();notice('Sale recorded.')}catch(e){notice(e.message,true);button.disabled=false}
};
function updatePrint(){$('print').disabled=!document.querySelector('[data-voucher]:checked')}
$('vouchers').onchange=updatePrint;
$('selectAll').onchange=event=>{document.querySelectorAll('[data-voucher]:not(:disabled)').forEach(e=>e.checked=event.target.checked);updatePrint()};
$('print').onclick=()=>{
  const ids=new Set([...document.querySelectorAll('[data-voucher]:checked')].map(e=>Number(e.dataset.voucher)));
  const items=context.vouchers.filter(v=>ids.has(v.id));
  const win=window.open('','_blank');if(!win)return notice('Allow pop-ups to open print preview.',true);
  const tickets=items.map(v=>'<article><small>KINGSLINK · '+escapeHtml(context.seller_code)+'</small><strong>'+escapeHtml(v.code_value)+'</strong><span>TIME '+time(v.duration_seconds)+'</span><span>'+money(v.price_centavos)+'</span></article>').join('');
  win.document.write('<!doctype html><html><head><title>My vouchers</title><link rel="stylesheet" href="'+location.origin+'/assets/voucher-print.css?v=5"></head><body data-template="economy"><header><button id="print">Print / Save PDF</button></header><main>'+tickets+'</main></body></html>');
  win.document.close();win.document.getElementById('print').onclick=()=>win.print();win.opener=null;
};
$('stations').onclick=event=>{
  const button=event.target.closest('[data-collect]');if(!button)return;
  const station=context.stations.find(s=>s.id===Number(button.dataset.collect));
  const form=$('collect');form.reset();form.elements.machine_id.value=station.id;form.elements.expected_amount_centavos.value=station.cash_on_hand_centavos;
  $('collectionExpected').textContent=station.name+' · Expected '+money(station.cash_on_hand_centavos);form.hidden=false;form.scrollIntoView({behavior:'smooth'});form.elements.amount.focus();
};
$('cancelCollection').onclick=()=>{$('collect').hidden=true};
$('collect').onsubmit=async event=>{
  event.preventDefault();const button=event.submitter;const form=event.target;
  if(!confirm('Save this collection and reset the station cash balance?'))return;
  button.disabled=true;
  try{const fields=Object.fromEntries(new FormData(form));const r=await action('/api/staff/collect',{machine_id:Number(fields.machine_id),expected_amount_centavos:Number(fields.expected_amount_centavos),actual_amount_centavos:Math.round(Number(fields.amount)*100),notes:fields.notes});form.hidden=true;await refresh();notice('Receipt #'+r.id+' saved. Variance '+money(r.variance_centavos));}catch(e){notice(e.message,true)}finally{button.disabled=false}
};
if(token)refresh().catch(e=>notice(e.message,true));
else location.replace('/admin');
