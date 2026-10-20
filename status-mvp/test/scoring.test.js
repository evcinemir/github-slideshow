import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStatus, computeComponents, histogram, ispBreakdown, regionState, reportStats } from '../src/scoring.js';

const NOW = 1_800_000_000_000;
const regions = ['istanbul', 'frankfurt', 'us-east'];
const probe = (verdict, ago = 0) => ({ t: NOW - ago, verdict });
const probesAll = (verdict) => Object.fromEntries(regions.map((r) => [r, [probe(verdict, 90_000), probe(verdict)]]));
const reportsRecent = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ t: NOW - i * 1000, ...extra }));

test('tüm bölgeler erişilebilir ve sinyal yok → çalışıyor, yüksek güven', () => {
  const r = computeStatus({ probes: probesAll('ok'), regions, now: NOW });
  assert.equal(r.state, 'up');
  assert.ok(r.confidence >= 0.85, `güven ${r.confidence}`);
});

test('tüm bölgeler iki ölçümdür erişemiyor → çökmüş', () => {
  const r = computeStatus({ probes: probesAll('fail'), regions, now: NOW });
  assert.equal(r.state, 'down');
  assert.ok(r.confidence >= 0.75, `güven ${r.confidence}`);
  assert.match(r.reasons[0], /3 ölçüm noktasından 3/);
});

test('tek başarısız ölçüm doğrulanmamış sayılır → sorunlu, çökmüş değil', () => {
  const probes = Object.fromEntries(regions.map((r) => [r, [probe('ok', 90_000), probe('fail')]]));
  assert.equal(computeStatus({ probes, regions, now: NOW }).state, 'degraded');
});

test('bir bölge çökük, diğerleri sağlam → sorunlu', () => {
  const probes = probesAll('ok');
  probes.istanbul = [probe('fail', 90_000), probe('fail')];
  assert.equal(computeStatus({ probes, regions, now: NOW }).state, 'degraded');
});

test('ölçümler sağlam ama bildirimlerde güçlü artış → sorunlu', () => {
  const r = computeStatus({ probes: probesAll('ok'), regions, reports: reportsRecent(40), now: NOW });
  assert.equal(r.state, 'degraded');
  assert.ok(r.reasons.some((x) => x.includes('40 kullanıcı')));
});

test('resmi kritik kesinti her zaman çökmüş sayılır', () => {
  const official = { ok: true, indicator: 'critical', description: 'Major Outage' };
  assert.equal(computeStatus({ probes: probesAll('ok'), regions, official, now: NOW }).state, 'down');
});

test('resmi "minor" tek başına sorunlu yapmaz (ör. Cloudflare PoP bakımı)', () => {
  const official = { ok: true, indicator: 'minor' };
  assert.equal(computeStatus({ probes: probesAll('ok'), regions, official, now: NOW }).state, 'up');
});

test('bayat ölçümler yok sayılır → bilinmiyor', () => {
  const probes = { istanbul: [probe('ok', 60 * 60_000)] };
  const r = computeStatus({ probes, regions, now: NOW });
  assert.equal(r.state, 'unknown');
  assert.equal(r.confidence, 0);
});

test('regionState: yavaş cevap sorunlu', () => {
  assert.equal(regionState([probe('slow')], { now: NOW }), 'degraded');
  assert.equal(regionState([], { now: NOW }), null);
});

test('reportStats: taban çizgisi son bir saati hariç tutar', () => {
  const old = Array.from({ length: 92 }, (_, i) => ({ t: NOW - 2 * 3600_000 - i * 60_000 }));
  const s = reportStats([...old, ...reportsRecent(4)], { now: NOW });
  assert.equal(s.recent, 4);
  assert.equal(s.baseline, 1);
  assert.equal(s.spike, false); // 4 < max(5, 3*1+3)
});

test('computeComponents: resmi bileşen ve bileşen bildirimleri', () => {
  const official = { components: [{ name: 'Matchmaking', group: 'Fortnite', state: 'down' }], incidents: [] };
  const out = computeComponents({
    keys: ['login', 'matchmaking', 'store'],
    official,
    officialMap: { matchmaking: ['matchmaking'], store: ['item shop'] },
    reports: reportsRecent(6, { component: 'login' }),
    now: NOW,
  });
  assert.deepEqual(out.map((c) => [c.key, c.state, c.source]), [
    ['login', 'degraded', 'bildirimler'],
    ['matchmaking', 'down', 'resmi'],
    ['store', 'up', 'varsayılan'],
  ]);
});

test('histogram 96 adet 15 dakikalık kova üretir', () => {
  // NOW bir kova sınırına denk geliyor; son kovanın içinde kalan zamanlar kullan.
  const recent = [1, 2, 3].map((i) => ({ t: NOW + i * 1000 }));
  const h = histogram([...recent, { t: NOW - 23 * 3600_000 }], { now: NOW + 60_000 });
  assert.equal(h.length, 96);
  assert.equal(h.at(-1).count, 3);
  assert.equal(h.reduce((a, b) => a + b.count, 0), 4);
});

test('ispBreakdown yüzdeleri ve sıralama', () => {
  const reports = [...reportsRecent(3, { isp: 'turktelekom' }), ...reportsRecent(1, { isp: 'turknet' })];
  const out = ispBreakdown(reports, { now: NOW, labels: { turktelekom: 'Türk Telekom' } });
  assert.deepEqual(out[0], { isp: 'turktelekom', label: 'Türk Telekom', count: 3, share: 75 });
});
