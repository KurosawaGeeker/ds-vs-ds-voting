const controls = [...document.querySelectorAll('[data-boost]')];
const dialog = document.querySelector('#payment-dialog');
const form = document.querySelector('#payment-form');
const amount = document.querySelector('#payment-amount');
const status = document.querySelector('#payment-status');
const submit = document.querySelector('#payment-submit');
const pending = document.querySelector('#payment-pending');
const payLink = document.querySelector('#payment-continue');
const syncButton = document.querySelector('#payment-sync');
const newButton = document.querySelector('#payment-new');
const API = `${window.APP_CONFIG?.api || '/api'}/payments`;
const number = new Intl.NumberFormat('zh-CN');
let config, choice, activeOrder, busy = false;
let intent;
const label = side => side === 'left' ? '左侧' : '右侧';
const money = cents => (cents / 100).toFixed(2);

function cents(value) {
  if (!/^(0|[1-9]\d{0,5})(\.\d{1,2})?$/.test(value)) return null;
  const [whole, decimals = ''] = value.split('.');
  return Number(whole) * 100 + Number(decimals.padEnd(2, '0'));
}
function quote() {
  const value = cents(amount.value);
  const valid = Number.isSafeInteger(value) && value >= config.minMinor && value <= config.maxMinor;
  submit.disabled = busy || !valid || !config.configured;
  document.querySelector('#payment-quote').textContent = valid ? `为${label(choice)}增加 ${number.format(value)} 票，支付 ¥${money(value)}` : `请输入 ¥${money(config.minMinor)}–¥${money(config.maxMinor)}`;
}
async function api(path, body) {
  const voter = localStorage.getItem('ds-vs-ds-voter');
  if (!voter) throw new Error('请允许本地存储并刷新页面后重试。');
  const response = await fetch(API + path, {
    method: body ? 'POST' : 'GET', cache: 'no-store', signal: AbortSignal.timeout(20000),
    headers: { 'X-Voter-ID': voter, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok) {
    const messages = { checkout_creation_pending: '订单正在确认，请稍后重试，勿重复付款。', payments_unavailable: '支付尚未开通，请稍后再来。', rate_limited: '操作太频繁，请一分钟后重试。', amount_out_of_range: '金额超出范围，请重新输入。', provider_fee_error: '商户支付服务余额不足，请联系网站管理员。', provider_no_contract: '商户收款尚未签约，请稍后再来。', provider_no_alipay_contract: '商户支付宝收款尚未开通，请稍后再来。', provider_alipay_api_error: '支付宝通道暂不可用，请联系网站管理员。' };
    throw new Error(messages[data.error] || '暂时无法确认订单，请稍后查询；已付款请勿重复支付。');
  }
  return data;
}
function showOrder(order) {
  if (order.currency !== 'CNY' || !['left','right'].includes(order.choice) || !Number.isSafeInteger(order.amountMinor) || !Number.isSafeInteger(order.votes)) throw new Error('订单信息不完整，请稍后查询。');
  activeOrder = order;
  localStorage.setItem('ds-vs-ds-pending-payment', order.id);
  form.hidden = true; pending.hidden = false;
  document.querySelector('#payment-order-summary').textContent = `${label(order.choice)} · ¥${money(order.amountMinor)} · ${number.format(order.votes)} 票`;
  const settled = ['paid','expired'].includes(order.status);
  payLink.hidden = true;
  const qr = document.querySelector('#payment-qr');
  qr.hidden = true;
  if (!settled && order.checkoutUrl) {
    const url = new URL(order.checkoutUrl);
    if (url.protocol !== 'https:' || url.username || url.password || !['qr.alipay.com','xorpay.com','www.xorpay.com'].includes(url.hostname)) throw new Error('付款地址无效，请稍后重试。');
    payLink.href = url.href; payLink.hidden = false;
    if (typeof order.qrDataUrl === 'string' && order.qrDataUrl.startsWith('data:image/svg+xml;base64,')) { qr.src = order.qrDataUrl; qr.hidden = false; }
  }
  syncButton.hidden = settled;
  if (settled) {
    status.textContent = order.status === 'paid' ? `支付已确认，已计入 ${number.format(order.grantedVotes)} 张付费票。` : '订单已过期，请创建新订单。';
    window.dispatchEvent(new Event('payment-updated'));
  } else {
    if (order.awaitingNotification) { payLink.hidden = true; qr.hidden = true; }
    status.textContent = order.awaitingNotification ? '已查到支付成功，正在等待到账通知，请勿重复付款。' : '使用支付宝扫码或打开付款链接，完成后回来查询结果。';
  }
}
function open(side) {
  if (busy) return;
  choice = activeOrder?.choice || side;
  document.querySelector('#payment-title').textContent = `为${label(choice)}刷票`;
  if (!dialog.open) dialog.showModal();
  if (!activeOrder) { form.hidden = false; pending.hidden = true; status.textContent = config.configured ? '' : '当前设备的支付宝支付尚未开通，请稍后再来。'; quote(); }
}
async function sync() {
  if (!activeOrder || busy) return;
  busy = true; syncButton.disabled = true;
  try { showOrder(await api(`/orders/${activeOrder.id}/sync`, {})); }
  catch (error) { status.textContent = error.message; }
  finally { busy = false; syncButton.disabled = false; }
}
async function start() {
  if (!window.APP_CONFIG?.payments) return;
  const response = await fetch(API + '/config', { cache: 'no-store', signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw new Error('支付配置暂时不可用。');
  config = await response.json();
  if (config.currency !== 'CNY' || config.votesPerUnit !== 100 || config.minMinor !== 100 || !Number.isSafeInteger(config.maxMinor)) throw new Error('人民币支付尚未配置。');
  amount.min = '1'; amount.max = money(config.maxMinor);
  document.querySelector('#payment-mode').textContent = config.environment === 'development' ? (config.configured ? '测试站 · 此通道会真实扣款，票数仅计入测试站' : '测试站 · 收款尚未开通') : '支付宝收款 · 人民币结算';
  for (const control of controls) { control.hidden = false; control.addEventListener('click', () => open(control.dataset.boost)); }
  document.querySelector('#payment-close').addEventListener('click', () => dialog.close());
  for (const button of document.querySelectorAll('[data-amount]')) button.addEventListener('click', () => { if (!busy) { amount.value = button.dataset.amount; quote(); } });
  amount.addEventListener('input', quote);
  syncButton.addEventListener('click', () => { void sync(); });
  newButton.addEventListener('click', () => {
    if (busy) return;
    activeOrder = null; intent = null; sessionStorage.removeItem('ds-vs-ds-payment-intent'); localStorage.removeItem('ds-vs-ds-pending-payment'); open(choice);
  });
  form.addEventListener('submit', async event => {
    event.preventDefault(); if (busy || submit.disabled) return;
    const payload = { choice, amount: amount.value };
    const key = JSON.stringify(payload);
    if (!intent || intent.key !== key) intent = { key, requestId: crypto.randomUUID() };
    sessionStorage.setItem('ds-vs-ds-payment-intent', JSON.stringify(intent));
    busy = true; amount.disabled = true; quote(); status.textContent = '正在创建订单…';
    try { showOrder(await api('/orders', { ...payload, requestId: intent.requestId })); }
    catch (error) { status.textContent = error.message; }
    finally { busy = false; amount.disabled = false; quote(); }
  });
  const savedIntent = sessionStorage.getItem('ds-vs-ds-payment-intent');
  if (savedIntent) {
    try { intent = JSON.parse(savedIntent); } catch { sessionStorage.removeItem('ds-vs-ds-payment-intent'); }
  }
  const id = new URL(location.href).searchParams.get('payment') || localStorage.getItem('ds-vs-ds-pending-payment');
  if (id && /^[a-f0-9-]{36}$/i.test(id)) {
    try { const order = await api(`/orders/${id}`); open(order.choice); showOrder(order); await sync(); }
    catch (error) { open('left'); status.textContent = error.message; }
  }
}
void start().catch(error => {
  // Ordinary voting remains usable when payment configuration is unavailable.
  console.warn('Payment setup unavailable');
  status.textContent = error.message;
});
