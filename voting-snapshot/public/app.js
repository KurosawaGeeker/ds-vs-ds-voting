const config = window.VOTE_CONFIG;
const state = { snapshot: null, pending: null, token: '', choice: '', widget: null, failures: 0, timer: null, reading: false, voted: false };
const get = id => document.getElementById(id);
let voterId;
try {
  voterId = localStorage.getItem('snapshot-voter-id');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(voterId ?? '')) {
    voterId = crypto.randomUUID();
    localStorage.setItem('snapshot-voter-id', voterId);
  }
} catch {
  voterId = crypto.randomUUID();
  get('vote-state').textContent = '浏览器未保存投票标识，刷新后仍可重试；网络限制依然有效。';
}

function render() {
  if (!state.snapshot) return;
  if (state.pending && state.snapshot.revision >= state.pending.revision) state.pending = null;
  const left = state.snapshot.leftVotes + (state.pending?.choice === 'left' ? 1 : 0);
  const right = state.snapshot.rightVotes + (state.pending?.choice === 'right' ? 1 : 0);
  get('left-count').textContent = left.toLocaleString();
  get('right-count').textContent = right.toLocaleString();
  get('left-bar').style.width = `${left + right ? left / (left + right) * 100 : 50}%`;
  const age = Date.now() - state.snapshot.capturedAt * 1000;
  get('results-state').textContent = age > config.staleAfterMs ? '票数更新延迟，当前显示上次结果。' : '票数定期更新';
}

function schedule() {
  clearTimeout(state.timer);
  if (document.hidden) return;
  const delay = Math.min(config.pollingMs * 2 ** state.failures, 60000);
  state.timer = setTimeout(poll, delay);
}

async function poll() {
  if (state.reading || document.hidden) return;
  state.reading = true;
  try {
    // Stable URL, browser/CDN cache allowed. Never fall back to the dynamic vote API.
    const response = await fetch(config.resultsUrl, { credentials: 'omit', signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('results_failed');
    const snapshot = await response.json();
    if (snapshot.schemaVersion !== 1 || ![snapshot.leftVotes, snapshot.rightVotes, snapshot.revision, snapshot.capturedAt].every(Number.isSafeInteger) ||
      snapshot.leftVotes < 0 || snapshot.rightVotes < 0) throw new Error('invalid_snapshot');
    if (!state.snapshot || snapshot.revision >= state.snapshot.revision) state.snapshot = snapshot;
    state.failures = 0;
    render();
  } catch {
    state.failures = Math.min(state.failures + 1, 3);
    render();
    get('results-state').textContent = state.snapshot ? '暂时无法更新，保留上次票数。' : '暂时无法获取票数，稍后自动重试。';
  } finally {
    state.reading = false;
    schedule();
  }
}

let turnstileLoad;
function loadTurnstile() {
  if (!turnstileLoad) turnstileLoad = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    script.onload = resolve;
    script.onerror = reject;
    document.head.append(script);
  });
  return turnstileLoad;
}

async function choose(choice) {
  if (state.voted) return;
  state.choice = choice;
  state.token = '';
  get('confirm-vote').disabled = true;
  get('challenge-state').textContent = '';
  get('vote-dialog').showModal();
  if (config.localDemo) {
    get('challenge').textContent = '本地演示校验（非真实人机校验）';
    state.token = `demo_${voterId}`;
    get('confirm-vote').disabled = false;
    return;
  }
  if (!config.turnstileSiteKey) {
    get('challenge-state').textContent = '投票暂未开放。';
    return;
  }
  try {
    await loadTurnstile();
    if (state.widget !== null) window.turnstile.remove(state.widget);
    state.widget = window.turnstile.render('#challenge', {
      sitekey: config.turnstileSiteKey, action: 'vote', cData: voterId,
      callback(token) { state.token = token; get('confirm-vote').disabled = false; },
      'expired-callback'() { state.token = ''; get('confirm-vote').disabled = true; },
      'error-callback'() { state.token = ''; get('confirm-vote').disabled = true; get('challenge-state').textContent = '验证失败，请关闭后重试。'; }
    });
  } catch {
    turnstileLoad = undefined;
    get('challenge-state').textContent = '验证暂时不可用，请关闭后重试。';
  }
}

get('confirm-vote').addEventListener('click', async () => {
  get('confirm-vote').disabled = true;
  try {
    const response = await fetch(config.voteUrl, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit',
      body: JSON.stringify({ voterId, choice: state.choice, token: state.token }), signal: AbortSignal.timeout(12000)
    });
    const result = await response.json();
    if (!response.ok || !result.accepted) throw new Error(result.error ?? 'vote_failed');
    state.voted = true;
    if (!result.duplicate && (!state.snapshot || result.revision > state.snapshot.revision)) state.pending = { choice: result.choice, revision: result.revision };
    for (const button of document.querySelectorAll('[data-choice]')) {
      button.disabled = true;
      if (button.dataset.choice === result.choice) button.textContent = '已投票';
    }
    get('vote-state').textContent = '已收到你的投票。';
    get('vote-dialog').close();
    render();
  } catch (error) {
    get('challenge-state').textContent = error.message === 'ip_hourly_limit' ? '当前网络投票过于频繁，请稍后再试。' : '暂时无法投票，请关闭后重试。';
  } finally {
    state.token = '';
    if (state.widget !== null) window.turnstile.reset(state.widget);
  }
});
for (const button of document.querySelectorAll('[data-choice]')) button.addEventListener('click', () => choose(button.dataset.choice));
document.addEventListener('visibilitychange', () => {
  clearTimeout(state.timer);
  if (!document.hidden) { render(); poll(); }
});
poll();
