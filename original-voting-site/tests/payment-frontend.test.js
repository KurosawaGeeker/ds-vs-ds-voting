import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../docs/payments.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
function page({ enabled = true, configured = true } = {}) {
  const elements = new Map(), calls = [], storage = new Map([['ds-vs-ds-voter', crypto.randomUUID()]]);
  const element = key => {
    if (!elements.has(key)) elements.set(key, { hidden: true, value: '1', dataset: {}, addEventListener(name, fn) { this[name] = fn; }, showModal() { this.open = true; }, close() { this.open = false; } });
    return elements.get(key);
  };
  const left = element('left'), right = element('right'); left.dataset.boost = 'left'; right.dataset.boost = 'right';
  let fail = true, state = 'pending';
  const localStorage = { getItem: key => storage.get(key), setItem: (k,v) => storage.set(k,v), removeItem: k => storage.delete(k) };
  vm.runInNewContext(source, {
    document: { querySelector: element, querySelectorAll: selector => selector === '[data-boost]' ? [left,right] : [] },
    window: { APP_CONFIG: { payments: enabled }, dispatchEvent() {} },
    localStorage, sessionStorage: localStorage,
    location: { href: 'https://dev.ds-vs-ds.win/' }, Intl, URL, crypto, Event, AbortSignal, console,
    fetch: async (path, options) => {
      if (path.endsWith('/config')) return { ok: true, json: async () => ({ currency: 'CNY', votesPerUnit: 100, minMinor: 100, maxMinor: 10000, configured, environment: 'development' }) };
      const body = JSON.parse(options.body); calls.push(body);
      if (fail) throw Error('network disconnected');
      return { ok: true, json: async () => ({ id: crypto.randomUUID(), choice: body.choice, amountMinor: Number(body.amount)*100, votes: Number(body.amount)*100, grantedVotes: state === 'paid' ? Number(body.amount)*100 : 0, currency: 'CNY', status: state, checkoutUrl: 'https://qr.alipay.com/test-only' }) };
    },
  });
  return { element, calls, succeed(status='pending') { fail=false;state=status; }, submit: () => element('#payment-form').submit({ preventDefault() {} }) };
}
test('failed checkout retries keep the same idempotency ID; changing amount creates a new intent', async () => {
  const p=page();await settle();p.element('left').click();await p.submit();await p.submit();
  assert.equal(p.calls[0].requestId,p.calls[1].requestId);
  p.element('#payment-amount').value='10';p.element('#payment-amount').input();p.succeed();await p.submit();
  assert.notEqual(p.calls[2].requestId,p.calls[1].requestId);
  assert.equal(p.calls[2].amount,'10');assert.equal(p.calls[2].choice,'left');
  assert.equal(p.element('#payment-pending').hidden,false);
  assert.equal(p.element('#payment-continue').hidden,false);
});
test('unconfigured merchant cannot submit; disabled production feature remains hidden',async()=>{
  const mobile=page({configured:false});await settle();mobile.element('right').click();
  assert.equal(mobile.element('#payment-submit').disabled,true);await mobile.submit();assert.equal(mobile.calls.length,0);
  const prod=page({enabled:false});await settle();assert.equal(prod.element('left').hidden,true);
});
test('confirmed and expired orders cannot offer another payment link',async()=>{
  for(const status of ['paid','expired']) { const p=page();await settle();p.element('right').click();p.succeed(status);await p.submit();
    assert.equal(p.element('#payment-continue').hidden,true);assert.equal(p.element('#payment-sync').hidden,true);
  }
});
