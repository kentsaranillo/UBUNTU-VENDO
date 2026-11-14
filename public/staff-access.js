'use strict';
(async function staffAccessPanel(){
  const token=localStorage.getItem('vendo_admin_token');
  if(!token)return;
  async function request(method,body){
    const response=await fetch('/api/staff/access',{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body?JSON.stringify(body):undefined});
    const result=await response.json();if(!response.ok)throw new Error(result.error);return result;
  }
  let data;
  try{data=await request('GET')}catch{return}
  const panel=document.createElement('section');panel.className='panel section-gap';
  panel.innerHTML='<h2>Seller and collector portal access</h2><p>Create Seller or Collector accounts above, then assign their portal access here.</p><p><a href="/seller" target="_blank" rel="noopener">Seller portal</a> · <a href="/collector" target="_blank" rel="noopener">Collector portal</a></p><form><label>Staff account<select name="user_id" required></select></label><label id="staffSellerCode">Seller code<input name="seller_code" maxlength="30"><small>Link an existing seller code to show that seller’s voucher stock. Default codes are assigned automatically.</small></label><fieldset><legend>Assigned collection stations</legend><div class="staff-stations"></div></fieldset><button class="button primary compact">Save assignments</button><button type="button" class="button secondary compact" id="reloadStaff">Reload accounts</button></form><p role="status" class="muted"></p>';
  document.getElementById('accessControlPanel').append(panel);
  const form=panel.querySelector('form'),select=form.elements.user_id,message=panel.querySelector('[role=status]'),stations=panel.querySelector('.staff-stations'),fieldset=panel.querySelector('fieldset');
  function selected(){
    const user=data.users.find(u=>u.id===Number(select.value));
    form.querySelector('[type=submit],button:not([type])').disabled=!user;
    panel.querySelector('#staffSellerCode').hidden=user?.role!=='seller';
    fieldset.hidden=user?.role!=='collector';
    form.elements.seller_code.value=user?.seller_code||'';
    const ids=JSON.parse(user?.machine_ids||'[]');
    stations.querySelectorAll('input').forEach(input=>input.checked=ids.includes(Number(input.value)));
  }
  function render(){
    select.replaceChildren(...data.users.map(user=>new Option(user.username+' · '+user.role,user.id)));
    stations.replaceChildren();
    data.machines.forEach(machine=>{const label=document.createElement('label');label.className='check-row';const input=document.createElement('input');input.type='checkbox';input.value=machine.id;label.append(input,document.createTextNode(machine.name));stations.append(label)});
    selected();
  }
  select.onchange=selected;
  form.onsubmit=async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;try{await request('POST',{user_id:Number(select.value),seller_code:form.elements.seller_code.value,machine_ids:[...stations.querySelectorAll('input:checked')].map(e=>Number(e.value))});message.textContent='Portal assignments saved.';data=await request('GET');const id=select.value;render();select.value=id;selected();}catch(error){message.textContent=error.message}finally{button.disabled=false}};
  panel.querySelector('#reloadStaff').onclick=async()=>{try{data=await request('GET');render();message.textContent='Accounts reloaded.'}catch(error){message.textContent=error.message}};
  render();
})();
