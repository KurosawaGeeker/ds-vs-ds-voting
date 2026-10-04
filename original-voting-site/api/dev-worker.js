import voting from './worker.js';

export default {
  async fetch(request, env, ctx) {
    const path = new URL(request.url).pathname;
    let response;
    if (path === '/runtime-config.js') {
      response = new Response(`window.APP_CONFIG = ${JSON.stringify({ api: '/api', payments: true, sitekey: env.TURNSTILE_SITE_KEY })};`, {
        headers: { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' },
      });
    } else if (path.startsWith('/api/')) {
      // All APIs use the isolated dev D1 binding. No production API fallback.
      response = await voting.fetch(request, env, ctx);
    } else {
      response = await env.ASSETS.fetch(request);
      if (response.headers.get('Content-Type')?.includes('text/html')) {
        response = new HTMLRewriter().on('main', { element(element) {
          element.prepend(`<p class="payment-note" role="status">支付测试站 · 测试票数与正式站隔离 · ${env.XORPAY_LIVE_ENABLED === 'true' ? '支付会真实扣款' : '收款渠道待开通'}</p>`, { html: true });
        } }).transform(response);
      }
    }
    const result = new Response(response.body, response);
    result.headers.set('X-Robots-Tag', 'noindex, nofollow');
    result.headers.set('Referrer-Policy', 'no-referrer');
    return result;
  },
};
