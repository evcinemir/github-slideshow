// DEMO=1 modunda gerçek ağ ölçümü yerine sentetik veri üretir: arayüzü ve API'yi
// internet erişimi olmadan denemek için. Birkaç servisi bilerek sorunlu gösterir.
const SCENARIOS = {
  edevlet: { regions: { istanbul: 'fail', frankfurt: 'fail', 'us-east': 'fail' }, reports: 60, isp: null },
  valorant: { regions: {}, reports: 35, component: 'matchmaking', official: { indicator: 'minor', description: 'Eşleştirme sürelerinde artış', incidents: [{ title: 'Eşleştirme gecikmeleri', impact: 'warning', status: 'active', text: 'Avrupa sunucularında eşleştirme süreleri normalden uzun.' }] } },
  instagram: { regions: { istanbul: 'slow' }, reports: 18, isp: 'turktelekom' },
  cloudflare: { regions: {}, reports: 0, official: { indicator: 'minor', description: 'Minor Service Outage', components: [{ name: 'Frankfurt, Germany - (FRA)', group: 'Europe', state: 'degraded' }, { name: 'Ashburn, VA, United States - (IAD)', group: 'North America', state: 'up' }, { name: 'Singapore - (SIN)', group: 'Asia', state: 'up' }], incidents: [{ title: 'Increased latency in Frankfurt', impact: 'minor', status: 'investigating', text: 'We are investigating increased latency.' }] } },
};

const ISP_KEYS = ['turktelekom', 'superonline', 'turkcell', 'vodafone', 'turknet', 'tt-mobil'];

function fakeProbe(slug, region, verdict, t) {
  const ms = verdict === 'slow' ? 4200 + Math.random() * 1500 : 80 + Math.random() * 400;
  const fail = verdict === 'fail';
  return {
    t,
    region,
    dns: { ok: true, ms: Math.round(5 + Math.random() * 30), addresses: ['203.0.113.10'] },
    http: fail ? { ok: false, ms: 10000, error: 'TIMEOUT' } : { ok: true, status: 200, ms: Math.round(ms) },
    tls: { ok: !fail, authorized: !fail, daysLeft: 74, issuer: 'Demo CA', error: fail ? 'TIMEOUT' : undefined },
    verdict: verdict || 'ok',
  };
}

export function seedDemo({ catalog, store, regions, now = Date.now() }) {
  store.data.reports = {};
  for (const s of catalog.services) {
    const sc = SCENARIOS[s.slug] || {};
    for (const region of regions) {
      for (const dt of [90_000, 0]) store.addProbe(s.slug, region, fakeProbe(s.slug, region, sc.regions?.[region], now - dt));
    }
    // 24 saatlik arka plan bildirimleri + senaryodaki ani artış
    const background = Math.floor(Math.random() * (s.popular ? 30 : 8));
    for (let i = 0; i < background; i++) {
      store.addReport({ slug: s.slug, t: now - 3600_000 - Math.random() * 23 * 3600_000, ipHash: `demo${i}`, isp: ISP_KEYS[i % ISP_KEYS.length] });
    }
    for (let i = 0; i < (sc.reports || 0); i++) {
      const isp = sc.isp && i % 3 ? sc.isp : ISP_KEYS[i % ISP_KEYS.length];
      const r = { slug: s.slug, t: now - Math.random() * 14 * 60_000, ipHash: `spike${i}`, isp };
      if (sc.component && i % 4) r.component = sc.component;
      store.addReport(r);
    }
    if (s.official || sc.official) {
      store.setOfficial(s.slug, { ok: true, fetchedAt: now, pageUrl: s.official?.url, indicator: 'none', description: 'All Systems Operational', components: [], incidents: [], ...sc.official });
    }
  }
  for (const list of Object.values(store.data.reports)) list.sort((a, b) => a.t - b.t);
}

export function startDemoProbes({ catalog, store, engine, regions, intervalMs = 60_000 }) {
  const timer = setInterval(() => {
    const now = Date.now();
    for (const s of catalog.services) {
      for (const region of regions) store.addProbe(s.slug, region, fakeProbe(s.slug, region, SCENARIOS[s.slug]?.regions?.[region], now));
      engine.recompute(s.slug, now);
    }
  }, intervalMs);
  timer.unref();
}
