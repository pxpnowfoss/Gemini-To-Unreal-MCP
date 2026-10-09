/**
 * Verifies how the Gemini client behaves when the model is overloaded or rate
 * limited: that it rides out transient 503s, honours Retry-After, gives up with
 * an actionable message, and lets the Stop button interrupt a backoff wait.
 *
 * Uses a stubbed fetch, so it needs no API key and costs nothing.
 *
 *   npm run check:retry
 */

const { GeminiClient } = require('../dist/main/geminiClient.js');

let fail = 0, calls = 0;
const realFetch = global.fetch;
global.fetch = async (url, opts) => {
  calls++;
  if (calls <= fail) {
    return new Response(JSON.stringify([{ error: { code: 503, message: 'overloaded', status: 'UNAVAILABLE' } }]),
      { status: 503, statusText: 'Service Unavailable', headers: { 'content-type': 'application/json', 'retry-after': '1' } });
  }
  return new Response(JSON.stringify({ id: 'int_ok', status: 'completed',
    steps: [{ type: 'model_output', content: [{ type: 'text', text: 'done' }] }] }),
    { status: 200, headers: { 'content-type': 'application/json' } });
};

(async () => {
  let pass = 0, failn = 0;
  const t = (label, ok, d) => { console.log((ok ? '  ✓ ' : '  ✕ ') + label + (ok ? '' : ' — ' + d)); ok ? pass++ : failn++; };

  // 1. recovers after transient 503s
  fail = 3; calls = 0;
  const c = new GeminiClient('k');
  const seen = [];
  c.onRetry = (i) => seen.push(i);
  const t0 = Date.now();
  const r = await c.createInteraction({ model: 'm', input: 'hi' });
  t('recovered after 3x 503', r.status === 'completed', 'status=' + r.status);
  t('made 4 attempts total', calls === 4, 'calls=' + calls);
  t('reported 3 retries to the UI', seen.length === 3, JSON.stringify(seen));
  t('honoured Retry-After (~1s each)', seen.every(s => s.waitMs >= 1000 && s.waitMs <= 2100), JSON.stringify(seen.map(s=>s.waitMs)));
  t('took roughly 3s, not 30', Date.now() - t0 < 8000, (Date.now()-t0) + 'ms');

  // 2. gives up with an actionable message (no Retry-After header at all)
  fail = 99; calls = 0;
  try {
    await new GeminiClient('k').createInteraction({ model: 'm', input: 'hi' });
    t('gives up eventually', false, 'did not throw');
  } catch (e) {
    t('gives up after MAX_RETRIES', calls === 6, 'calls=' + calls);
    t('message names the cause + remedy', /overloaded/i.test(e.message) && /different model|again/i.test(e.message), e.message.slice(0,120));
  }

  // 3. A quota-sized Retry-After must fail fast, not park the app for hours.
  {
    let n = 0;
    global.fetch = async () => {
      n++;
      return new Response(JSON.stringify([{ error: { code: 429, message: 'quota exhausted', status: 'RESOURCE_EXHAUSTED' } }]),
        { status: 429, statusText: 'Too Many Requests',
          headers: { 'content-type': 'application/json', 'retry-after': '25789' } });
    };
    const t0 = Date.now();
    try {
      await new GeminiClient('k').createInteraction({ model: 'm', input: 'hi' });
      t('7h Retry-After rejected', false, 'did not throw');
    } catch (e) {
      const dt = Date.now() - t0;
      t('did not wait out a 7h Retry-After', dt < 2000, dt + 'ms');
      t('failed after one attempt', n === 1, 'attempts=' + n);
      t('says hours, not raw seconds', /7h/.test(e.message) && !/25789/.test(e.message), e.message.slice(0, 160));
      t('names it as quota, not busy', /quota/i.test(e.message), e.message.slice(0, 120));
      t('offers a remedy (billing / another project / reset)',
        /billing|another project|daily reset/i.test(e.message), e.message.slice(0, 200));
      t('includes the server detail', /quota exhausted/i.test(e.message), e.message.slice(0, 200));
    }
  }

  // 4. formatDuration readability
  {
    const { formatDuration } = require('../dist/main/geminiClient.js');
    t('formats 45s', formatDuration(45000) === '45s', formatDuration(45000));
    t('formats 5m', formatDuration(300000) === '5m', formatDuration(300000));
    t('formats 7h 10m', formatDuration(25789000) === '7h 10m', formatDuration(25789000));
  }

  // 5. Stop interrupts a backoff wait (503 with no Retry-After -> real backoff)
  calls = 0;
  global.fetch = async () => {
    calls++;
    return new Response(JSON.stringify([{ error: { code: 503, message: 'overloaded' } }]),
      { status: 503, statusText: 'Service Unavailable', headers: { 'content-type': 'application/json' } });
  };
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 300);
  try {
    await new GeminiClient('k').createInteraction({ model: 'm', input: 'hi', signal: ac.signal });
    t('abort interrupts backoff', false, 'did not throw');
  } catch (e) {
    t('abort interrupts backoff', e.name === 'AbortError', 'name=' + e.name);
    t('stopped early (<2 attempts)', calls <= 2, 'calls=' + calls);
  }

  console.log(failn === 0 ? '\nRetry behaviour OK.' : '\n' + failn + ' FAILED');
  process.exitCode = failn ? 1 : 0;
})();
