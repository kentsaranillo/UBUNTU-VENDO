'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

test('staff portals isolate records and make financial retries idempotent', async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'vendo-staff-test-'));
  const listener = net.createServer();
  await new Promise(resolve=>listener.listen(0,'127.0.0.1',resolve));
  const port=listener.address().port;
  await new Promise(resolve=>listener.close(resolve));
  const password='Staff-test-password-2026!';
  const file=path.join(temp,'test.db');
  const child=spawn(process.execPath,[path.resolve(__dirname,'../server.js')],{env:{...process.env,HOST:'127.0.0.1',PORT:String(port),DATA_DIR:temp,DB_FILE:file,BACKUP_DIR:path.join(temp,'backups'),ADMIN_PASSWORD:password,PROVISION_KEY:'staff-test-provision-key',ALLOW_TEST_MAC:'1',DISABLE_SYSTEM_POWER:'1'},stdio:'ignore'});
  const base='http://127.0.0.1:'+port;
  let database;
  async function request(url,token,body){
    const response=await fetch(base+url,{method:body?'POST':'GET',headers:{'content-type':'application/json',authorization:'Bearer '+(token||''),'x-test-client-mac':'02:00:00:00:00:99'},body:body?JSON.stringify(body):undefined});
    return {status:response.status,body:await response.json()};
  }
  async function login(username){const r=await request('/api/admin/login','',{username,password});assert.equal(r.status,200);return r.body.token;}
  try{
    let ready=false;
    for(let i=0;i<100;i++){try{if((await fetch(base+'/health')).ok){ready=true;break}}catch{}await new Promise(r=>setTimeout(r,100))}
    assert.ok(ready,'server starts');
    const admin=await login('admin');
    const ids={};
    for(const [username,role] of [['seller.one','seller'],['seller.two','seller'],['collector.one','collector'],['collector.two','collector']]){
      const r=await request('/api/admin/users',admin,{username,role,password});assert.equal(r.status,201);ids[username]=r.body.id;
    }
    const seller=await login('seller.one'),other=await login('seller.two'),collector=await login('collector.one'),collector2=await login('collector.two');
    assert.equal((await request('/api/admin/vouchers',seller)).status,403);
    assert.equal((await request('/api/staff/access',seller)).status,403);
    const context=(await request('/api/staff/context',seller)).body;
    const rate=context.rates[0];
    const issue={rate_id:rate.id,quantity:2,request_key:'issue-test-0000001'};
    const first=await request('/api/staff/issue',seller,issue);
    assert.equal(first.status,201);
    assert.deepEqual((await request('/api/staff/issue',seller,issue)).body,first.body);
    const own=(await request('/api/staff/context',seller)).body.vouchers;
    assert.equal(own.length,2);
    assert.equal((await request('/api/staff/context',other)).body.vouchers.length,0);
    assert.equal((await request('/api/staff/sold',other,{voucher_id:own[0].id,request_key:'sale-test-other-0001'})).status,404);
    await request('/api/staff/sold',seller,{voucher_id:own[0].id,request_key:'sale-test-owned-0001'});
    await request('/api/staff/sold',seller,{voucher_id:own[0].id,request_key:'sale-test-owned-0002'});
    assert.equal((await request('/api/staff/context',seller)).body.totals.sold,1);
    database=new DatabaseSync(file);
    const zone=database.prepare('SELECT id FROM zones LIMIT 1').get().id;
    const station=Number(database.prepare("INSERT INTO machines(hardware_id,name,zone_id,token_hash,cash_on_hand_centavos) VALUES('STAFF-TEST','Assigned station',?,'unused',5000)").run(zone).lastInsertRowid);
    assert.equal((await request('/api/staff/access',admin,{user_id:ids['collector.one'],machine_ids:[station]})).status,200);
    assert.equal((await request('/api/staff/context',collector2)).body.stations.length,0);
    const collect={machine_id:station,expected_amount_centavos:5000,actual_amount_centavos:4900,request_key:'collection-test-0001'};
    assert.equal((await request('/api/staff/collect',collector2,collect)).status,403);
    const receipt=await request('/api/staff/collect',collector,collect);assert.equal(receipt.status,201);
    assert.equal(receipt.body.variance_centavos,-100);
    assert.deepEqual((await request('/api/staff/collect',collector,collect)).body,receipt.body);
    assert.equal(database.prepare('SELECT cash_on_hand_centavos cash FROM machines WHERE id=?').get(station).cash,0);
    assert.equal((await request('/api/staff/context',collector)).body.collections.length,1);
    assert.equal((await request('/api/staff/context',collector2)).body.collections.length,0);
    assert.equal((await request('/api/staff/collect',collector,{...collect,request_key:'collection-stale-0002'})).status,409);
  }finally{
    database?.close();
    child.kill();
    await new Promise(resolve=>child.once('exit',resolve));
    fs.rmSync(temp,{recursive:true,force:true});
  }
});
