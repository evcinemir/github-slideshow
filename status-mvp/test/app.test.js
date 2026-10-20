import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { build } from '../src/server.js';

const cfg = { ...config, demo: true, agentToken: 'gizli', api: { freePerHour: 5 }, discord: { appId: '', publicKey: 'a'.repeat(64), botToken: '' } };
let ctx;
let base;

before(async () => {
  ctx = build(cfg);
  await new Promise((r) => ctx.app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${ctx.app.server.address().port}`;
});
after(() => ctx.app.server.close());

test('GET /api/v1/status/:slug ve hız sınırı başlıkları', async () => {
  const now = Date.now();
  ctx.store.addProbe('github', 'istanbul', { t: now, region: 'istanbul', verdict: 'ok', dns: { ok: true, ms: 3 }, http: { ok: true, status: 200, ms: 120 } });
  const res = await fetch(`${base}/api/v1/status/github`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.equal(res.headers.get('x-ratelimit-limit'), '5');
  const body = await res.json();
  assert.equal(body.service.slug, 'github');
  assert.equal(body.regions.length, 3);
  assert.equal(body.regions[0].latencyMs, 120);
  assert.ok(['up', 'degraded', 'down', 'unknown'].includes(body.status.state));
  assert.equal((await fetch(`${base}/api/v1/status/yok-boyle`)).status, 404);
});

test('ücretsiz katman sınırı aşılınca 429', async () => {
  let last;
  for (let i = 0; i < 6; i++) last = await fetch(`${base}/api/v1/problems`);
  assert.equal(last.status, 429);
  assert.ok(last.headers.get('retry-after'));
});

test('kullanıcı bildirimi kaydedilir ve tekrarı reddedilir', async () => {
  const post = () => fetch(`${base}/ui/report`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: 'steam', isp: 'superonline', component: 'login' }) });
  const first = await post();
  assert.equal(first.status, 201);
  assert.equal((await (await post()).json()).accepted, false);
  const svc = await (await fetch(`${base}/ui/service/steam`)).json();
  assert.equal(svc.histogram.length, 96);
  assert.ok(svc.isps.some((i) => i.isp === 'superonline'));
  assert.deepEqual(svc.componentOptions.map((c) => c.key), ['login', 'store', 'community']);
});

test('ajan uç noktası yetki ister ve sonuçları bölgeye yazar', async () => {
  const payload = { region: 'frankfurt', results: [{ slug: 'npm', result: { t: Date.now(), verdict: 'fail', dns: { ok: true }, http: { ok: false, error: 'TIMEOUT' } } }] };
  const send = (auth) => fetch(`${base}/internal/probes`, { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  assert.equal((await send('Bearer yanlis')).status, 401);
  const ok = await send('Bearer gizli');
  assert.deepEqual(await ok.json(), { accepted: 1 });
  assert.equal(ctx.store.probes('npm').frankfurt.at(-1).verdict, 'fail');
});

test('Discord etkileşimleri imzasız istekleri reddeder', async () => {
  const res = await fetch(`${base}/discord/interactions`, { method: 'POST', body: '{"type":1}', headers: { 'x-signature-ed25519': '00', 'x-signature-timestamp': '1' } });
  assert.equal(res.status, 401);
});

test('abonelik doğrulaması ve SPA/statik dosyalar', async () => {
  const bad = await fetch(`${base}/api/v1/subscriptions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ webhook: 'http://10.0.0.1/x', services: ['github'] }) });
  assert.equal(bad.status, 400);
  const email = await fetch(`${base}/api/v1/subscriptions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'dev@example.com', services: ['github'] }) });
  assert.equal(email.status, 202);
  const tok = ctx.notifier.subscriptions.at(-1).token;
  assert.equal((await fetch(`${base}/api/v1/subscriptions/confirm?token=${tok}`)).status, 200);
  assert.equal(ctx.notifier.subscriptions.at(-1).confirmed, true);

  const page = await fetch(`${base}/s/valorant`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(await page.text(), /ÇöktüMü/);
  assert.equal((await fetch(`${base}/..%2fpackage.json`)).status, 404);
  assert.equal((await fetch(`${base}/api/v1/nope`)).status, 404);
});

test('motor: durum değişikliği debounce sonrası tek bildirim üretir', () => {
  const changes = [];
  const { engine, store } = build({ ...cfg, notifyDebounceMs: 120_000 });
  engine.onChange = (s, c) => changes.push(c);
  const t0 = 1_800_000_000_000;
  const probe = (t, verdict) => ({ t, verdict, dns: { ok: true }, http: { ok: verdict !== 'fail', ms: 100 } });
  const all = (t, v) => cfg.regions.forEach((r) => store.addProbe('slack', r, probe(t, v)));
  all(t0 - 1000, 'ok');
  all(t0, 'ok');
  engine.recompute('slack', t0);
  assert.equal(store.status('slack').state, 'up');
  all(t0 + 60_000, 'fail');
  engine.recompute('slack', t0 + 60_000); // tek başarısızlık: sorunlu, henüz bekliyor
  assert.equal(store.status('slack').state, 'up');
  assert.equal(store.status('slack').pending.state, 'degraded');
  all(t0 + 120_000, 'fail');
  engine.recompute('slack', t0 + 120_000);
  all(t0 + 300_000, 'fail');
  engine.recompute('slack', t0 + 300_000);
  assert.equal(store.status('slack').state, 'down');
  assert.equal(changes.length, 1);
  assert.equal(changes[0].from, 'up');
  assert.equal(changes[0].to, 'down');
});
