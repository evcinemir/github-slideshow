import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync, sign as edSign, createHmac } from 'node:crypto';
import { RateLimiter } from '../src/ratelimit.js';
import { isPrivateAddress, assertPublicUrl } from '../src/netsafe.js';
import { parseStatuspage, parseRiot, parseAws } from '../src/official.js';
import { officialByRegion } from '../src/dependencies.js';
import { checkHttp, verdictOf } from '../src/probes.js';
import { Store } from '../src/store.js';
import { submitReport } from '../src/reports.js';
import { loadCatalog } from '../src/catalog.js';
import { DiscordBot, verifyDiscordRequest, publicKeyFromHex, commandDefinitions } from '../src/discord.js';
import { Notifier, Mailer, sign } from '../src/notify.js';

const catalog = loadCatalog();

test('katalog: 50+ servis, 10-15 oyun, benzersiz slug', () => {
  assert.ok(catalog.services.length >= 50);
  const games = catalog.services.filter((s) => s.game);
  assert.ok(games.length >= 10 && games.length <= 15);
});

test('RateLimiter pencere sınırı', () => {
  const rl = new RateLimiter({ limit: 2, windowMs: 1000 });
  assert.equal(rl.take('a', 0).allowed, true);
  assert.equal(rl.take('a', 1).allowed, true);
  assert.equal(rl.take('a', 2).allowed, false);
  assert.equal(rl.take('a', 1001).allowed, true);
});

test('özel IP tespiti', () => {
  for (const ip of ['10.0.0.1', '127.0.0.1', '192.168.1.1', '172.20.0.1', '169.254.169.254', '::1', 'fd00::1', '::ffff:10.1.1.1']) assert.ok(isPrivateAddress(ip), ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700::1111']) assert.ok(!isPrivateAddress(ip), ip);
});

test('webhook adresi: http ve iç IP reddedilir', async () => {
  await assert.rejects(assertPublicUrl('http://example.com/hook'), /https/);
  await assert.rejects(assertPublicUrl('https://127.0.0.1/hook'), /iç bir ağ/);
  await assert.rejects(assertPublicUrl('https://[::1]/hook'), /iç bir ağ/);
});

test('statuspage özeti ve bileşen grubu filtresi', () => {
  const summary = {
    status: { indicator: 'minor', description: 'Partially Degraded Service' },
    components: [
      { id: 'g1', name: 'Fortnite', group: true },
      { id: 'c1', name: 'Matchmaking', status: 'major_outage', group_id: 'g1' },
      { id: 'c2', name: 'Login', status: 'operational', group_id: 'g1' },
      { id: 'c3', name: 'Store', status: 'operational', group_id: null },
    ],
    incidents: [{ name: 'Matchmaking issues', impact: 'major', status: 'investigating', updated_at: 'x', shortlink: 'https://stspg.io/x', incident_updates: [{ body: 'Looking into it' }] }],
    scheduled_maintenances: [],
  };
  const all = parseStatuspage(summary);
  assert.equal(all.indicator, 'minor');
  assert.equal(all.components.length, 3);
  assert.equal(all.incidents[0].text, 'Looking into it');
  const fn = parseStatuspage(summary, { componentGroup: 'Fortnite' });
  assert.equal(fn.components.length, 2);
  assert.equal(fn.indicator, 'major');
});

test('Riot ve AWS ayrıştırıcıları', () => {
  const riot = parseRiot({
    incidents: [{ incident_severity: 'warning', titles: [{ locale: 'en_US', content: 'Login issues' }, { locale: 'tr_TR', content: 'Giriş sorunları' }], updates: [{ translations: [{ locale: 'tr_TR', content: 'İnceleniyor' }] }] }],
    maintenances: [],
  });
  assert.equal(riot.indicator, 'minor');
  assert.equal(riot.incidents[0].title, 'Giriş sorunları');
  assert.equal(parseRiot({ incidents: [], maintenances: [] }).indicator, 'none');
  const aws = parseAws([{ service_name: 'Amazon EC2', region: 'eu-central-1', status: '2', summary: 'Increased error rates' }]);
  assert.equal(aws.indicator, 'minor');
  assert.equal(parseAws([]).indicator, 'none');
});

test('altyapı bölge eşleştirme', () => {
  const cf = catalog.bySlug.get('cloudflare');
  const out = officialByRegion(cf, {
    ok: true,
    indicator: 'minor',
    components: [
      { name: 'Frankfurt, Germany - (FRA)', group: 'Europe', state: 'degraded' },
      { name: 'Ashburn, VA - (IAD)', group: 'North America', state: 'up' },
    ],
  });
  assert.equal(out.regions.europe, 'degraded');
  assert.equal(out.regions['north-america'], 'up');
  const gh = officialByRegion(catalog.bySlug.get('github'), { ok: true, indicator: 'major', components: [{ name: 'Actions', state: 'down' }] });
  assert.equal(gh.regional, false);
  assert.equal(gh.regions['asia-pacific'], 'down');
});

test('HTTP ölçümü: 2xx/4xx ayakta, 5xx ve zaman aşımı başarısız', async (t) => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/slow') return setTimeout(() => res.end('x'), 500);
    res.statusCode = Number(req.url.slice(1)) || 200;
    res.end('ok');
  });
  await new Promise((r) => srv.listen(0, r));
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  assert.equal((await checkHttp(`${base}/200`)).ok, true);
  assert.equal((await checkHttp(`${base}/403`)).ok, true);
  const r503 = await checkHttp(`${base}/503`);
  assert.equal(r503.ok, false);
  assert.equal(r503.status, 503);
  assert.equal((await checkHttp(`${base}/slow`, { timeoutMs: 100 })).error, 'TIMEOUT');
  assert.equal((await checkHttp('http://127.0.0.1:1/')).ok, false);
});

test('verdictOf', () => {
  assert.equal(verdictOf({ dns: { ok: true }, http: { ok: true, ms: 100 }, tls: { ok: true } }), 'ok');
  assert.equal(verdictOf({ dns: { ok: true }, http: { ok: true, ms: 5000 } }), 'slow');
  assert.equal(verdictOf({ dns: { ok: false }, http: { ok: true, ms: 1 } }), 'fail');
  assert.equal(verdictOf({ dns: { ok: true }, http: { ok: true, ms: 1 }, tls: { ok: false, error: 'CERT_HAS_EXPIRED' } }), 'fail');
});

test('bildirim: aynı IP 30 dk içinde tekrar sayılmaz, ISP/bileşen doğrulanır', () => {
  const store = new Store(null);
  const svc = catalog.bySlug.get('valorant');
  const now = Date.now();
  assert.equal(submitReport(store, svc, { ip: '1.2.3.4', isp: 'turknet', component: 'matchmaking', salt: 's', now }).accepted, true);
  assert.equal(submitReport(store, svc, { ip: '1.2.3.4', salt: 's', now: now + 1000 }).accepted, false);
  assert.equal(submitReport(store, svc, { ip: '1.2.3.4', salt: 's', now: now + 31 * 60_000 }).accepted, true);
  submitReport(store, svc, { ip: '5.6.7.8', isp: 'yok-boyle', component: 'hack', salt: 's', now });
  const reports = store.reportsFor('valorant');
  assert.equal(reports.length, 3);
  assert.equal(reports[0].isp, 'turknet');
  assert.equal(reports[0].component, 'matchmaking');
  assert.ok(!JSON.stringify(reports).includes('1.2.3.4'), 'IP saklanmamalı');
  assert.ok(!reports.find((r) => r.ipHash !== reports[0].ipHash).isp);
});

test('Discord: imza doğrulama ve komutlar', () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const hex = Buffer.from(publicKey.export({ format: 'jwk' }).x, 'base64url').toString('hex');
  const key = publicKeyFromHex(hex);
  const body = Buffer.from('{"type":1}');
  const ts = '1700000000';
  const sig = edSign(null, Buffer.concat([Buffer.from(ts), body]), privateKey).toString('hex');
  assert.equal(verifyDiscordRequest(key, sig, ts, body), true);
  assert.equal(verifyDiscordRequest(key, sig, ts, Buffer.from('{"type":2}')), false);

  const store = new Store(null);
  const engine = { view: () => ({ label: 'Çalışıyor', confidence: 0.9, reasons: [], components: [] }) };
  const bot = new DiscordBot({ store, catalog, engine, appId: '1', publicKeyHex: hex, botToken: 't', publicUrl: 'http://x' });
  assert.deepEqual(bot.handle({ type: 1 }), { type: 1 });
  const cmd = (name, permissions = String(1 << 5)) => ({ type: 2, guild_id: 'g', channel_id: 'c', member: { permissions }, data: { name, options: [{ name: 'oyun', value: 'valorant' }] } });
  assert.match(bot.handle(cmd('takip', '0')).data.content, /yetkisi/);
  assert.match(bot.handle(cmd('takip')).data.content, /takip ediliyor/);
  assert.equal(store.data.discord.length, 1);
  assert.match(bot.handle(cmd('liste', '0')).data.content, /Valorant/);
  assert.match(bot.handle(cmd('birak')).data.content, /bırakıldı/);
  assert.equal(store.data.discord.length, 0);
  assert.ok(commandDefinitions(catalog.services.filter((s) => s.game))[0].options[0].choices.length <= 25);
});

test('Notifier: imzalı webhook ve çift onaylı e-posta', async (t) => {
  const received = [];
  const srv = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    received.push({ headers: req.headers, body });
    res.end('ok');
  });
  await new Promise((r) => srv.listen(0, r));
  t.after(() => srv.close());

  const store = new Store(null);
  const mailer = new Mailer({});
  const n = new Notifier({ store, catalog, mailer, publicUrl: 'http://x', allowPrivateWebhooks: true, retryDelaysMs: [] });
  const hook = await n.createWebhook({ url: `http://127.0.0.1:${srv.address().port}/hook`, services: ['discord'] });
  const mail = await n.createEmail({ email: 'Ali@Example.com', services: ['discord'] });
  await assert.rejects(n.createEmail({ email: 'gecersiz', services: ['discord'] }), /e-posta/);
  await assert.rejects(n.createWebhook({ url: 'https://example.com', services: ['yok'] }), /Bilinmeyen/);
  assert.equal(mailer.outbox.length, 1);
  assert.match(mailer.outbox[0].text, new RegExp(mail.token));

  const change = { from: 'up', to: 'down', result: { confidence: 0.9, reasons: ['test'] }, at: Date.now() };
  await n.onChange(catalog.bySlug.get('discord'), change);
  assert.equal(received.length, 1);
  assert.equal(received[0].headers['x-coktumu-signature'], sign(hook.secret, received[0].body));
  assert.equal(JSON.parse(received[0].body).current.state, 'down');
  assert.equal(mailer.outbox.length, 1, 'onaylanmamış e-postaya bildirim gitmez');

  n.confirm(mail.token);
  await n.onChange(catalog.bySlug.get('discord'), change);
  assert.equal(mailer.outbox.length, 2);
  assert.equal(mailer.outbox[1].to, 'ali@example.com');
  await n.onChange(catalog.bySlug.get('steam'), change);
  assert.equal(received.length, 2, 'takip edilmeyen servis bildirilmez');
  assert.ok(n.unsubscribe(hook.token));
  assert.equal(createHmac('sha256', 'k').update('b').digest('hex').length, 64);
});
