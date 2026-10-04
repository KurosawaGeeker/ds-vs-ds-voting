import { createHash, timingSafeEqual } from 'node:crypto';
import QRCode from 'qrcode';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AOID = /^[a-zA-Z0-9_-]{8,128}$/;
const CHECKOUT_HOSTS = ['qr.alipay.com', 'xorpay.com', 'www.xorpay.com'];
class PaymentError extends Error {
  constructor(code, status = 400) { super(code); this.code = code; this.status = status; }
}
const json = (value, status = 200) => Response.json(value, {
  status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});
const success = () => new Response('success', { headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' } });
// XorPay protocol specifies MD5 over raw UTF-8 values in a fixed order.
export const sign = (...values) => createHash('md5').update(values.join(''), 'utf8').digest('hex');
export function minorUnits(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,5})(\.\d{1,2})?$/.test(value)) throw new PaymentError('invalid_amount');
  const [whole, fraction = ''] = value.split('.');
  return Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
}
const decimal = minor => `${Math.floor(minor / 100)}.${String(minor % 100).padStart(2, '0')}`;
function settings(env) {
  const origin = new URL(env.PUBLIC_ORIGIN);
  if (origin.protocol !== 'https:' || origin.origin !== env.PUBLIC_ORIGIN) throw new PaymentError('invalid_origin_config', 503);
  if (!['development', 'production'].includes(env.RUNTIME_ENV)) throw new PaymentError('invalid_environment', 503);
  if (origin.hostname === 'dev.ds-vs-ds.win' && env.RUNTIME_ENV !== 'development') throw new PaymentError('invalid_environment', 503);
  const maxMinor = Number(env.MAX_PAYMENT_MINOR || 10000);
  if (!Number.isSafeInteger(maxMinor) || maxMinor < 100 || maxMinor > 100000) throw new PaymentError('pricing_unavailable', 503);
  return { environment: env.RUNTIME_ENV, origin: origin.origin, provider: 'xorpay', currency: 'CNY', votesPerUnit: 100, minMinor: 100, maxMinor };
}
const configured = env => /^[1-9]\d{0,15}$/.test(env.XORPAY_AID || '') && typeof env.XORPAY_APP_SECRET === 'string' && env.XORPAY_APP_SECRET.length >= 16;
function requireCredentials(env) {
  if (!configured(env)) throw new PaymentError('payments_unavailable', 503);
}
export function quote(env, amount) {
  const s = settings(env), amountMinor = minorUnits(amount);
  if (amountMinor < s.minMinor || amountMinor > s.maxMinor) throw new PaymentError('amount_out_of_range');
  return { currency: 'CNY', amountMinor, votes: amountMinor };
}
async function boundedText(message, limit) {
  if (Number(message.headers.get('Content-Length')) > limit) throw new PaymentError('body_too_large', 413);
  const reader = message.body?.getReader();
  if (!reader) return '';
  const decoder = new TextDecoder();
  let text = '', size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel(); throw new PaymentError('body_too_large', 413); }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}
async function bodyJson(request) {
  if (!request.headers.get('Content-Type')?.startsWith('application/json')) throw new PaymentError('json_required', 415);
  try { return JSON.parse(await boundedText(request, 4096)); }
  catch (error) { if (error instanceof PaymentError) throw error; throw new PaymentError('invalid_json'); }
}
const lookup = (env, id) => env.DB.prepare('SELECT * FROM payment_orders WHERE id = ?').bind(id).first();
function checkoutUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new PaymentError('invalid_checkout', 502); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !CHECKOUT_HOSTS.includes(url.hostname)) throw new PaymentError('invalid_checkout', 502);
  return url.href;
}
async function orderView(env, order) {
  const grant = await env.DB.prepare('SELECT votes FROM payment_grants WHERE order_id = ?').bind(order.id).first();
  const checkout = order.status === 'pending' && order.checkout_url ? checkoutUrl(order.checkout_url) : null;
  const svg = checkout ? await QRCode.toString(checkout, { type: 'svg', errorCorrectionLevel: 'M', margin: 2, width: 240 }) : null;
  return { id: order.id, choice: order.choice, status: order.status, currency: order.currency,
    amountMinor: order.amount_minor, votes: order.votes, grantedVotes: grant?.votes || 0,
    environment: order.environment, checkoutUrl: checkout, qrDataUrl: svg ? `data:image/svg+xml;base64,${btoa(svg)}` : null };
}
function assertOrderScope(env, order) {
  if (order.environment !== settings(env).environment || order.merchant_id !== env.XORPAY_AID || order.currency !== 'CNY') throw new PaymentError('payment_mismatch', 409);
}
async function providerFetch(path, body) {
  const response = await fetch(`https://xorpay.com${path}`, {
    method: body ? 'POST' : 'GET', ...(body ? { body: new URLSearchParams(body) } : {}),
    redirect: 'error', signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new PaymentError('provider_unavailable', 502);
  const raw = await boundedText(response, 65536);
  try { return JSON.parse(raw); } catch { throw new PaymentError('invalid_provider_response', 502); }
}
async function providerStatus(env, order) {
  requireCredentials(env); assertOrderScope(env, order);
  const params = new URLSearchParams({ order_id: order.id, sign: sign(order.id, env.XORPAY_APP_SECRET) });
  const remote = await providerFetch(`/api/query2/${env.XORPAY_AID}?${params}`);
  if (!['not_exist', 'new', 'payed', 'success', 'expire', 'fee_error'].includes(remote?.status)) throw new PaymentError('provider_unavailable', 502);
  return remote.status;
}
async function notify(request, env) {
  requireCredentials(env);
  if (!request.headers.get('Content-Type')?.startsWith('application/x-www-form-urlencoded')) throw new PaymentError('form_required', 415);
  const fields = {};
  for (const [key, value] of new URLSearchParams(await boundedText(request, 65536))) {
    if (Object.hasOwn(fields, key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new PaymentError('invalid_notification');
    fields[key] = value;
  }
  if (!UUID.test(fields.order_id || '') || !AOID.test(fields.aoid || '') || !fields.pay_time || fields.pay_time.length > 64 ||
      !/^[a-f0-9]{32}$/.test(fields.sign || '')) throw new PaymentError('invalid_notification', 403);
  const expected = sign(fields.aoid, fields.order_id, fields.pay_price || '', fields.pay_time, env.XORPAY_APP_SECRET);
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(fields.sign, 'hex'))) throw new PaymentError('invalid_signature', 403);
  const order = await lookup(env, fields.order_id);
  if (!order) throw new PaymentError('unknown_order', 404);
  assertOrderScope(env, order);
  if (minorUnits(fields.pay_price) !== order.amount_minor || (order.provider_order_id && order.provider_order_id !== fields.aoid)) throw new PaymentError('payment_mismatch', 409);
  // Always verify against the merchant-scoped server API, even on callback retries.
  const remote = await providerStatus(env, order);
  if (!['payed', 'success'].includes(remote)) throw new PaymentError(remote === 'fee_error' ? 'provider_fee_error' : 'payment_not_confirmed', 503);
  // Both payment state and credit are committed together. The unique provider ID
  // prevents applying one receipt to two orders, including concurrent callbacks.
  await env.DB.batch([
    env.DB.prepare("UPDATE payment_orders SET provider_order_id=?,status='paid',updated_at=CURRENT_TIMESTAMP WHERE id=? AND (provider_order_id IS NULL OR provider_order_id=?)")
      .bind(fields.aoid, order.id, fields.aoid),
    env.DB.prepare(`INSERT INTO payment_grants(order_id,choice,votes)
      SELECT id,choice,votes FROM payment_orders WHERE id=? AND provider_order_id=? AND status='paid'
      ON CONFLICT(order_id) DO NOTHING`).bind(order.id, fields.aoid),
  ]);
  return success();
}
export async function queryOrder(env, order) {
  const remote = await providerStatus(env, order);
  if (remote === 'expire' && order.status !== 'paid') {
    await env.DB.prepare("UPDATE payment_orders SET status='expired',updated_at=CURRENT_TIMESTAMP WHERE id=? AND status!='paid'").bind(order.id).run();
    order = await lookup(env, order.id);
  }
  // XorPay documents only a status in the query response, not the paid amount.
  // Do not grant from a browser return or a status-only query; wait for its signed
  // amount-bearing notification. XorPay retries unacknowledged notifications.
  return { ...await orderView(env, order), awaitingNotification: ['payed','success'].includes(remote) && order.status !== 'paid' };
}
async function createOrder(request, env, voterId, ip) {
  requireCredentials(env);
  if (env.XORPAY_LIVE_ENABLED !== 'true') throw new PaymentError('payments_unavailable', 503);
  const data = await bodyJson(request);
  if (!['left','right'].includes(data?.choice) || !UUID.test(data?.requestId || '')) throw new PaymentError('invalid_order');
  const q = quote(env, data.amount), s = settings(env);
  await env.DB.prepare(`INSERT INTO payment_orders(id,voter_id,request_id,choice,amount_minor,votes,environment,merchant_id,client_ip)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(voter_id,request_id) DO NOTHING`)
    .bind(crypto.randomUUID(), voterId, data.requestId, data.choice, q.amountMinor, q.votes, s.environment, env.XORPAY_AID, ip).run();
  let order = await env.DB.prepare('SELECT * FROM payment_orders WHERE voter_id=? AND request_id=?').bind(voterId, data.requestId).first();
  assertOrderScope(env, order);
  if (order.choice !== data.choice || order.amount_minor !== q.amountMinor) throw new PaymentError('idempotency_conflict', 409);
  if (order.status === 'paid' || order.status === 'expired' || order.checkout_url) return json(await orderView(env, order), 201);
  const payload = { name: `DS拟人形象投票·${data.choice === 'left' ? '左侧' : '右侧'}·${q.votes}票`, pay_type: 'alipay',
    price: decimal(q.amountMinor), order_id: order.id, notify_url: `${s.origin}/api/payments/notify`, expire: '1800' };
  payload.sign = sign(payload.name, payload.pay_type, payload.price, payload.order_id, payload.notify_url, env.XORPAY_APP_SECRET);
  const remote = await providerFetch(`/api/pay/${env.XORPAY_AID}`, payload);
  if (remote?.status === 'order_payed') return json(await queryOrder(env, order), 201);
  if (remote?.status === 'order_expire') {
    await env.DB.prepare("UPDATE payment_orders SET status='expired' WHERE id=? AND status!='paid'").bind(order.id).run();
    return json(await orderView(env, await lookup(env, order.id)), 201);
  }
  if (remote?.status !== 'ok') {
    const known = ['fee_error','no_contract','no_alipay_contract','app_off','aid_not_exist','sign_error','order_exist','alipay_api_error'];
    const code = known.includes(remote?.status) ? `provider_${remote.status}` : 'provider_unavailable';
    console.error(JSON.stringify({ event: 'payment_provider_rejected', code }));
    throw new PaymentError(code, 503);
  }
  if (!AOID.test(remote.aoid || '')) throw new PaymentError('invalid_provider_response', 502);
  const checkout = checkoutUrl(remote.info?.qr);
  await env.DB.prepare(`UPDATE payment_orders SET provider_order_id=?,checkout_url=?,
    status=CASE WHEN status='created' THEN 'pending' ELSE status END,updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND (provider_order_id IS NULL OR provider_order_id=?)`)
    .bind(remote.aoid, checkout, order.id, remote.aoid).run();
  order = await lookup(env, order.id);
  if (order.provider_order_id !== remote.aoid) throw new PaymentError('payment_mismatch', 409);
  return json(await orderView(env, order), 201);
}
export async function handlePayments(request, env) {
  try {
    const path = new URL(request.url).pathname.replace(/^\/api\/payments/, '');
    // Turning off new sales never discards callbacks for existing orders.
    if (path === '/notify' && request.method === 'POST') return await notify(request, env);
    if (env.PAYMENTS_ENABLED !== 'true' && env.PAYMENT_LEDGER_ENABLED !== 'true') return json({ error: 'payments_unavailable' }, 503);
    const s = settings(env);
    if (path === '/config' && request.method === 'GET') return json({ ...s,
      configured: configured(env) && env.PAYMENTS_ENABLED === 'true' && env.XORPAY_LIVE_ENABLED === 'true' });
    const voterId = request.headers.get('X-Voter-ID') || '', ip = request.headers.get('CF-Connecting-IP');
    if (!UUID.test(voterId) || !ip) throw new PaymentError('invalid_session', 403);
    if (request.method === 'POST' && request.headers.get('Origin') !== s.origin) throw new PaymentError('invalid_origin', 403);
    const limiter = request.method === 'GET' ? env.PAYMENT_READ_LIMIT : env.PAYMENT_WRITE_LIMIT;
    if (!limiter || !(await limiter.limit({ key: ip })).success || !env.PAYMENT_GLOBAL_LIMIT ||
        !(await env.PAYMENT_GLOBAL_LIMIT.limit({ key: 'payments' })).success) return json({ error: 'rate_limited' }, 429);
    if (path === '/orders' && request.method === 'POST') {
      if (env.PAYMENTS_ENABLED !== 'true') throw new PaymentError('payments_unavailable', 503);
      return await createOrder(request, env, voterId, ip);
    }
    const match = path.match(/^\/orders\/([a-f0-9-]{36})(\/sync)?$/i);
    if (!match || (match[2] ? request.method !== 'POST' : request.method !== 'GET')) return json({ error: 'not_found' }, 404);
    const order = await lookup(env, match[1]);
    if (!order || order.voter_id !== voterId) return json({ error: 'not_found' }, 404);
    assertOrderScope(env, order);
    return json(match[2] ? await queryOrder(env, order) : await orderView(env, order));
  } catch (error) {
    if (error instanceof PaymentError) return json({ error: error.code }, error.status);
    console.error(JSON.stringify({ event: 'payment_request_failed', type: error?.name || 'Error' }));
    return json({ error: 'payment_temporarily_unavailable' }, 503);
  }
}
