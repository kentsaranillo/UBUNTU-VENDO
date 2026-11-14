'use strict';
const crypto = require('node:crypto');

module.exports = function createStaffRoutes({ db, adminAuth, json, readBody, nowIso, futureIso, sha, event }) {
  db.exec(`CREATE TABLE IF NOT EXISTS staff_access (
    user_id INTEGER PRIMARY KEY REFERENCES admin_users(id) ON DELETE CASCADE,
    seller_code TEXT UNIQUE, machine_ids TEXT NOT NULL DEFAULT '[]');
    CREATE TABLE IF NOT EXISTS staff_requests (
    user_id INTEGER NOT NULL, request_key TEXT NOT NULL, operation TEXT NOT NULL,
    response_json TEXT NOT NULL, PRIMARY KEY(user_id,request_key));
    CREATE TABLE IF NOT EXISTS staff_voucher_sales (
    voucher_id INTEGER UNIQUE REFERENCES vouchers(id) ON DELETE SET NULL, user_id INTEGER NOT NULL,
    amount_centavos INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS staff_collection_owners (
    collection_id INTEGER PRIMARY KEY REFERENCES collections(id) ON DELETE CASCADE, user_id INTEGER NOT NULL); `);
  function access(user) {
    let row = db.prepare('SELECT * FROM staff_access WHERE user_id=?').get(user.user_id);
    if (!row || (user.role === 'seller' && !row.seller_code)) {
      const code = user.role === 'seller' ? 'SELLER-' + user.user_id + '-' + crypto.randomBytes(4).toString('hex').toUpperCase() : null;
      db.prepare('INSERT INTO staff_access(user_id,seller_code) VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET seller_code=COALESCE(staff_access.seller_code,excluded.seller_code)').run(user.user_id,code);
      row = db.prepare('SELECT * FROM staff_access WHERE user_id=?').get(user.user_id);
    }
    return row;
  }
  function machineIds(user) { return JSON.parse(access(user).machine_ids); }
  function fail(message, status = 400) { throw Object.assign(new Error(message), { status }); }
  function transaction(user, body, operation, work) {
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(body.request_key || '')) fail('A valid request key is required');
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = db.prepare('SELECT * FROM staff_requests WHERE user_id=? AND request_key=?').get(user.user_id, body.request_key);
      if (previous) {
        if (previous.operation !== operation) fail('Request key already used', 409);
        db.exec('COMMIT');
        return JSON.parse(previous.response_json);
      }
      const result = work();
      db.prepare('INSERT INTO staff_requests VALUES(?,?,?,?)').run(user.user_id, body.request_key, operation, JSON.stringify(result));
      db.exec('COMMIT');
      return result;
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return async function staffRoute(req, res, method, pathname) {
    const user = adminAuth(req, res);
    if (!user) return;
    const full = ['owner','admin'].includes(user.role);
    if (pathname === '/api/staff/access') {
      if (!full) return json(res, 403, { error: 'Administrator access required' });
      if (method === 'GET') return json(res, 200, {
        users: db.prepare("SELECT u.id,u.username,u.role,a.seller_code,a.machine_ids FROM admin_users u LEFT JOIN staff_access a ON a.user_id=u.id WHERE u.enabled=1 AND u.role IN ('seller','collector') ORDER BY username").all(),
        machines: db.prepare('SELECT id,name FROM machines WHERE enabled=1 ORDER BY name').all()
      });
      if (method === 'POST') {
        const body = await readBody(req);
        const target = db.prepare("SELECT id,role FROM admin_users WHERE id=? AND enabled=1 AND role IN ('seller','collector')").get(Number(body.user_id));
        if (!target) return json(res, 404, { error: 'Staff account not found' });
        if (!Array.isArray(body.machine_ids)) return json(res,400,{error:'Station assignments must be a list'});
        const ids = [...new Set(body.machine_ids)].map(Number);
        if (ids.some(id => !Number.isInteger(id) || !db.prepare('SELECT 1 FROM machines WHERE id=? AND enabled=1').get(id))) return json(res, 400, { error: 'Select valid stations' });
        const existing = db.prepare('SELECT seller_code FROM staff_access WHERE user_id=?').get(target.id);
        const code = target.role === 'seller' ? String(body.seller_code || existing?.seller_code || 'SELLER-' + target.id + '-' + crypto.randomBytes(4).toString('hex')).trim().toUpperCase() : null;
        if (code && !/^[A-Z0-9_-]{1,30}$/.test(code)) return json(res, 400, { error: 'Use letters, numbers, hyphens or underscores for seller code' });
        if (code && /^SELLER-\d+$/.test(code) && code !== 'SELLER-' + target.id) return json(res,400,{error:'That automatic seller code belongs to another account'});
        if (code && db.prepare('SELECT 1 FROM staff_access WHERE seller_code=? AND user_id<>?').get(code,target.id)) return json(res,409,{error:'Seller code is assigned to another account'});
        db.prepare('INSERT INTO staff_access VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET seller_code=excluded.seller_code,machine_ids=excluded.machine_ids').run(target.id,code,JSON.stringify(ids));
        event('info','staff.access_updated','Staff portal assignments updated',{actor:user.user_id,user_id:target.id,machine_ids:ids,seller_code:code});
        return json(res,200,{ok:true});
      }
      return json(res,405,{error:'Method not allowed'});
    }
    if (!['seller','collector'].includes(user.role)) return json(res,403,{error:'Sign in with a Seller or Collector account'});
    const own = access(user);
    if (method === 'GET' && pathname === '/api/staff/context') {
      if (user.role === 'seller') {
        const vouchers = db.prepare('SELECT v.id,v.code_value,v.code_hint,v.batch_code,v.price_centavos,v.duration_seconds,v.status,v.expires_at,v.created_at,s.created_at sold_at FROM vouchers v LEFT JOIN staff_voucher_sales s ON s.voucher_id=v.id WHERE v.seller_code=? ORDER BY v.id DESC LIMIT 1000').all(own.seller_code);
        const totals = db.prepare('SELECT COUNT(*) issued,SUM(CASE WHEN status=\'unused\' THEN 1 ELSE 0 END) unused,SUM(CASE WHEN status=\'used\' THEN 1 ELSE 0 END) used FROM vouchers WHERE seller_code=?').get(own.seller_code);
        const sales = db.prepare('SELECT COUNT(*) sold,COALESCE(SUM(amount_centavos),0) amount FROM staff_voucher_sales WHERE user_id=?').get(user.user_id);
        return json(res,200,{user:{username:user.username,role:user.role},seller_code:own.seller_code,vouchers,totals:{...totals,...sales},rates:db.prepare('SELECT id,name,price_centavos,duration_seconds FROM rates WHERE enabled=1 ORDER BY price_centavos').all()});
      }
      const ids = machineIds(user);
      const stations = ids.length ? db.prepare(`SELECT id,name,cash_on_hand_centavos,last_seen_at FROM machines WHERE enabled=1 AND id IN (${ids.map(()=>'?').join(',')}) ORDER BY name`).all(...ids) : [];
      const collections = db.prepare('SELECT c.*,m.name machine_name FROM collections c JOIN staff_collection_owners o ON o.collection_id=c.id JOIN machines m ON m.id=c.machine_id WHERE o.user_id=? ORDER BY c.id DESC LIMIT 500').all(user.user_id);
      return json(res,200,{user:{username:user.username,role:user.role},stations,collections});
    }
    if (method !== 'POST') return json(res,404,{error:'Not found'});
    const body = await readBody(req);
    if (pathname === '/api/staff/issue' && user.role === 'seller') {
      const result = transaction(user,body,'issue',()=>{
        const rate = db.prepare('SELECT * FROM rates WHERE id=? AND enabled=1').get(Number(body.rate_id));
        const quantity = Number(body.quantity);
        if (!rate || !Number.isInteger(quantity) || quantity<1 || quantity>100) fail('Choose an enabled rate and 1–100 vouchers');
        db.prepare('INSERT OR IGNORE INTO staff_access(user_id,seller_code) VALUES(?,?)').run(user.user_id,own.seller_code);
        db.prepare('INSERT OR IGNORE INTO sellers(code,name) VALUES(?,?)').run(own.seller_code,user.username);
        const batch = 'S' + crypto.randomBytes(8).toString('hex').toUpperCase();
        const codes = [];
        for (let i=0;i<quantity;i++) {
          const code = crypto.randomBytes(6).toString('hex').toUpperCase();
          db.prepare("INSERT INTO vouchers(code_hash,code_hint,code_value,batch_code,seller_code,duration_seconds,rate_limit,price_centavos,expires_at) VALUES(?,?,?,?,?,?,?,?,?)").run(sha(code),code.slice(0,4)+'…'+code.slice(-3),code,batch,own.seller_code,rate.duration_seconds,rate.rate_limit,rate.price_centavos,rate.expiry_seconds?futureIso(rate.expiry_seconds):null);
          codes.push(code);
        }
        event('info','seller.vouchers_issued','Seller issued vouchers',{user_id:user.user_id,batch,quantity,rate_id:rate.id});
        return {batch,codes};
      });
      return json(res,201,result);
    }
    if (pathname === '/api/staff/sold' && user.role === 'seller') {
      const result = transaction(user,body,'sold',()=>{
        const voucher = db.prepare('SELECT * FROM vouchers WHERE id=? AND seller_code=?').get(Number(body.voucher_id),own.seller_code);
        if (!voucher || voucher.status==='disabled' || (voucher.expires_at && Date.parse(voucher.expires_at)<=Date.now())) fail('Voucher is unavailable or expired',404);
        const sale = db.prepare('INSERT OR IGNORE INTO staff_voucher_sales VALUES(?,?,?,CURRENT_TIMESTAMP)').run(voucher.id,user.user_id,voucher.price_centavos);
        if (sale.changes) event('info','seller.sale_recorded','Seller recorded voucher payment',{user_id:user.user_id,voucher_id:voucher.id,amount_centavos:voucher.price_centavos});
        return {ok:true};
      });
      return json(res,200,result);
    }
    if (pathname === '/api/staff/collect' && user.role === 'collector') {
      const result = transaction(user,body,'collect',()=>{
        const id = Number(body.machine_id), actual = Number(body.actual_amount_centavos);
        if (!machineIds(user).includes(id)) fail('Station is not assigned to you',403);
        if (!Number.isSafeInteger(actual) || actual<0 || actual>100000000) fail('Enter a valid counted amount');
        const station = db.prepare('SELECT * FROM machines WHERE id=? AND enabled=1').get(id);
        if (!station) fail('Station not found',404);
        if (Number(body.expected_amount_centavos)!==station.cash_on_hand_centavos) fail('Station balance changed. Refresh before collecting.',409);
        if (db.prepare("SELECT 1 FROM coin_sessions WHERE machine_id=? AND status='open' AND lease_expires_at>?").get(id,nowIso())) fail('Wait for the active coin session to finish',409);
        const expected = station.cash_on_hand_centavos;
        const row = db.prepare('INSERT INTO collections(machine_id,system_amount_centavos,actual_amount_centavos,variance_centavos,collector,notes) VALUES(?,?,?,?,?,?)').run(id,expected,actual,actual-expected,user.username,String(body.notes||'').slice(0,500));
        db.prepare('INSERT INTO staff_collection_owners VALUES(?,?)').run(row.lastInsertRowid,user.user_id);
        db.prepare('UPDATE machines SET cash_on_hand_centavos=0,updated_at=? WHERE id=?').run(nowIso(),id);
        event('info','cash.collected','Collector recorded cash collection',{machine_id:id,user_id:user.user_id,expected,actual});
        return {id:Number(row.lastInsertRowid),system_amount_centavos:expected,actual_amount_centavos:actual,variance_centavos:actual-expected};
      });
      return json(res,201,result);
    }
    return json(res,403,{error:'This action is not available for your role'});
  };
};
