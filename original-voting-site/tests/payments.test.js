import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { handlePayments, minorUnits, quote } from '../api/payments.js';

const origin='https://dev.ds-vs-ds.win', allow={async limit(){return {success:true};}};
const md5=(...values)=>createHash('md5').update(values.join(''),'utf8').digest('hex');
function fixture(t){
 const db=new DatabaseSync(':memory:');
 for(const file of ['schema.sql','payment-schema.sql'])db.exec(readFileSync(new URL(`../api/${file}`,import.meta.url),'utf8'));
 function prepare(sql,params=[]){return {bind(...values){return prepare(sql,values);},all(){return {results:db.prepare(sql).all(...params)};},first(){return db.prepare(sql).get(...params)||null;},run(){return {results:[],...db.prepare(sql).run(...params)};}};}
 const env={PAYMENTS_ENABLED:'true',PAYMENT_LEDGER_ENABLED:'true',XORPAY_LIVE_ENABLED:'true',XORPAY_AID:'12345',XORPAY_APP_SECRET:'synthetic-local-test-secret-only',RUNTIME_ENV:'development',PUBLIC_ORIGIN:origin,PAYMENT_READ_LIMIT:allow,PAYMENT_WRITE_LIMIT:allow,PAYMENT_GLOBAL_LIMIT:allow,DB:{prepare,async batch(statements){db.exec('BEGIN');try{const out=statements.map(s=>s.run());db.exec('COMMIT');return out;}catch(e){db.exec('ROLLBACK');throw e;}}}};
 const voter=crypto.randomUUID(),sent=[];let providerState='payed',createError,maliciousQr=false,down=false;
 t.mock.method(globalThis,'fetch',async(url,options)=>{
  if(down)throw Error('offline');const u=new URL(url);assert.equal(u.origin,'https://xorpay.com');assert.equal(options.redirect,'error');
  if(u.pathname===`/api/pay/${env.XORPAY_AID}`){
   const p=Object.fromEntries(options.body);sent.push(p);
   assert.equal(p.sign,md5(p.name,p.pay_type,p.price,p.order_id,p.notify_url,env.XORPAY_APP_SECRET));
   assert.equal(p.pay_type,'alipay');assert.equal(p.notify_url,origin+'/api/payments/notify');
   return Response.json(createError?{status:createError}:{status:'ok',aoid:p.order_id.replaceAll('-',''),info:{qr:maliciousQr?'https://evil.example/pay':'https://qr.alipay.com/test-only'}});
  }
  assert.equal(u.pathname,`/api/query2/${env.XORPAY_AID}`);
  assert.equal(u.searchParams.get('sign'),md5(u.searchParams.get('order_id'),env.XORPAY_APP_SECRET));
  return Response.json({status:providerState});
 });
 const call=(path,body,owner=voter,source=origin)=>handlePayments(new Request(origin+'/api/payments'+path,{method:body?'POST':'GET',headers:{Origin:source,'CF-Connecting-IP':'192.0.2.8','X-Voter-ID':owner,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})}),env);
 const create=async(extra={})=>{const r=await call('/orders',{choice:'left',amount:'10',requestId:crypto.randomUUID(),...extra});assert.equal(r.status,201);return r.json();};
 const notification=(order,extra={})=>{const f={aoid:order.id.replaceAll('-',''),order_id:order.id,pay_price:(order.amountMinor/100).toFixed(2),pay_time:'2026-10-01 12:00:00',...extra};return new URLSearchParams({...f,sign:md5(f.aoid,f.order_id,f.pay_price,f.pay_time,env.XORPAY_APP_SECRET)});};
 const deliver=body=>handlePayments(new Request(origin+'/api/payments/notify',{method:'POST',body,headers:{'Content-Type':'application/x-www-form-urlencoded'}}),env);
 t.after(()=>db.close());
 return {env,db,voter,call,create,notification,deliver,sent,total:()=>db.prepare("SELECT total FROM paid_totals WHERE choice='left'").get().total,state:s=>providerState=s,creationError:s=>createError=s,badQr:()=>maliciousQr=true,disconnect:()=>down=true};
}

test('XorPay RMB1 quote, exact decimal signing and QR are generated on server',async t=>{
 const f=fixture(t);assert.equal(minorUnits('1.01'),101);assert.deepEqual(quote(f.env,'1'),{currency:'CNY',amountMinor:100,votes:100});
 for(const value of [1,'1e3','-1','0.001','Infinity','01',''])assert.throws(()=>minorUnits(value));
 for(const value of ['0.99','1001'])assert.throws(()=>quote(f.env,value));
 const order=await f.create({amount:'1',votes:999999});assert.equal(order.votes,100);assert.equal(f.sent[0].price,'1.00');assert.equal(f.total(),0);
 assert.match(order.qrDataUrl,/^data:image\/svg\+xml;base64,/);assert.equal(order.checkoutUrl,'https://qr.alipay.com/test-only');
 assert(!JSON.stringify(order).includes(f.env.XORPAY_APP_SECRET));
});
test('retry creates one payable order; reused request ID cannot change amount or candidate',async t=>{
 const f=fixture(t),requestId=crypto.randomUUID();const a=await f.create({requestId}),b=await f.create({requestId});assert.equal(a.id,b.id);assert.equal(f.sent.length,1);
 for(const patch of [{amount:'1'},{choice:'right'}])assert.equal((await f.call('/orders',{requestId,amount:'10',choice:'left',...patch})).status,409);
});
test('signed callback plus authenticated query grants exactly once including concurrent retries',async t=>{
 const f=fixture(t),order=await f.create();const responses=await Promise.all(Array.from({length:12},()=>f.deliver(f.notification(order))));
 for(const r of responses)assert.equal(await r.text(),'success');
 assert.equal(f.total(),1000);assert.equal(f.db.prepare('SELECT count(*) AS n FROM payment_grants').get().n,1);
 assert.equal(f.db.prepare('SELECT sum(total) AS n FROM totals').get().n,0);
 const view=await(await f.call('/orders/'+order.id)).json();assert.equal(view.grantedVotes,1000);assert.equal(view.checkoutUrl,null);
});
test('tampered signature, duplicate fields, wrong amount, unknown order and receipt are rejected',async t=>{
 const f=fixture(t),order=await f.create();
 const tampered=f.notification(order);tampered.set('pay_price','1.00');assert.equal((await f.deliver(tampered)).status,403);
 const duplicate=f.notification(order);duplicate.append('order_id',order.id);assert.equal((await f.deliver(duplicate)).status,400);
 assert.equal((await f.deliver(f.notification(order,{pay_price:'1.00'}))).status,409);
 assert.equal((await f.deliver(f.notification(order,{aoid:'differentreceipt123'}))).status,409);
 assert.equal((await f.deliver(f.notification(order,{order_id:crypto.randomUUID()}))).status,404);
 const unsigned=f.notification(order);unsigned.delete('sign');assert.equal((await f.deliver(unsigned)).status,403);
 assert.equal(f.total(),0);
});
test('callback cannot grant if provider query is unpaid, expired, missing, fee error or offline',async t=>{
 const f=fixture(t),order=await f.create();
 for(const state of ['new','expire','not_exist','fee_error']){f.state(state);assert.equal((await f.deliver(f.notification(order))).status,503);assert.equal(f.total(),0);}
 f.disconnect();assert.equal((await f.deliver(f.notification(order))).status,503);assert.equal(f.total(),0);
});
test('status-only query cannot grant; signed amount callback is authoritative and expiry never undoes a payment',async t=>{
 const f=fixture(t),order=await f.create();let view=await(await f.call('/orders/'+order.id+'/sync',{})).json();assert.equal(view.awaitingNotification,true);assert.equal(f.total(),0);
 await f.deliver(f.notification(order));f.state('expire');view=await(await f.call('/orders/'+order.id+'/sync',{})).json();assert.equal(view.status,'paid');assert.equal(f.total(),1000);
});
test('owner, origin, merchant and environment are bound to an order',async t=>{
 const f=fixture(t),order=await f.create();assert.equal((await f.call('/orders/'+order.id,null,crypto.randomUUID())).status,404);
 assert.equal((await f.call('/orders/'+order.id+'/sync',{},f.voter,'https://evil.example')).status,403);
 f.env.XORPAY_AID='54321';assert.equal((await f.call('/orders/'+order.id)).status,409);f.env.XORPAY_AID='12345';
 f.env.RUNTIME_ENV='production';assert.equal((await f.call('/config')).status,503);
});
test('stopping new sales preserves callback delivery, order reads and totals',async t=>{
 const f=fixture(t),order=await f.create();f.env.PAYMENTS_ENABLED='false';f.env.XORPAY_LIVE_ENABLED='false';
 assert.equal((await f.call('/orders',{choice:'left',amount:'1',requestId:crypto.randomUUID()})).status,503);
 assert.equal((await f.deliver(f.notification(order))).status,200);assert.equal(f.total(),1000);
 assert.equal((await f.call('/orders/'+order.id)).status,200);assert.equal((await(await f.call('/config')).json()).configured,false);
});
test('known XorPay rejection codes are actionable and unexpected checkout hosts fail closed',async t=>{
 const f=fixture(t);f.creationError('fee_error');let r=await f.call('/orders',{choice:'left',amount:'1',requestId:crypto.randomUUID()});assert.equal((await r.json()).error,'provider_fee_error');
 f.creationError(null);f.badQr();r=await f.call('/orders',{choice:'left',amount:'1',requestId:crypto.randomUUID()});assert.equal(r.status,502);assert.equal(f.total(),0);
});
test('oversized callbacks and rate-limited writes do not reach payment APIs',async t=>{
 const f=fixture(t);assert.equal((await f.deliver('x'.repeat(66000))).status,413);
 f.env.PAYMENT_WRITE_LIMIT={async limit(){return {success:false};}};
 assert.equal((await f.call('/orders',{choice:'left',amount:'1',requestId:crypto.randomUUID()})).status,429);assert.equal(f.sent.length,0);
});
