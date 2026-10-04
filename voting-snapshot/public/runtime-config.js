// Public configuration only. Site key is public; never place a secret here.
window.VOTE_CONFIG = Object.freeze({
  resultsUrl: 'https://counts.example.com/results.json',
  voteUrl: 'https://api.example.com/vote',
  turnstileSiteKey: '',
  pollingMs: 10000,
  staleAfterMs: 120000,
  localDemo: false
});
