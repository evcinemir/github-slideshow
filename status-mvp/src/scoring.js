// Durum skoru: bölge ölçümleri, kullanıcı bildirimleri ve resmi durum sayfasını tek bir
// "Çalışıyor / Sorunlu / Çökmüş" kararına ve bir güven yüzdesine dönüştürür. Saf fonksiyonlar; test edilebilir.

export const STATE_LABELS = {
  up: 'Çalışıyor',
  degraded: 'Sorunlu',
  down: 'Çökmüş',
  unknown: 'Bilinmiyor',
};

const SEVERITY = { up: 0, degraded: 0.5, down: 1 };
const RANK = { unknown: -1, up: 0, maintenance: 0.5, degraded: 1, down: 2 };

export function worstState(states) {
  return states.reduce((a, b) => (RANK[b] > RANK[a] ? b : a), 'up');
}

const BUCKET_MS = 15 * 60_000;

// Bir bölgenin son iki ölçümünden bölge durumu: tek başarısızlık "doğrulanmamış" sayılır ve sorunlu olarak görünür.
export function regionState(results, { now = Date.now(), staleMs = 5 * 60_000 } = {}) {
  const last = results.at(-1);
  if (!last || now - last.t > staleMs) return null;
  const prev = results.at(-2);
  if (last.verdict === 'fail') return prev?.verdict === 'fail' ? 'down' : 'degraded';
  if (last.verdict === 'slow') return 'degraded';
  return 'up';
}

export function reportStats(reports, { now = Date.now() } = {}) {
  let recent = 0;
  let baselineCount = 0;
  let last24h = 0;
  for (const r of reports) {
    const age = now - r.t;
    if (age < 0 || age > 24 * 3600_000) continue;
    last24h++;
    if (age <= BUCKET_MS) recent++;
    else if (age > 3600_000) baselineCount++;
  }
  // Son bir saati hariç tutarak 15 dakikalık ortalama "normal" bildirim sayısı.
  const baseline = baselineCount / ((24 * 3600_000 - 3600_000) / BUCKET_MS);
  const spike = recent >= Math.max(5, 3 * baseline + 3);
  const strong = recent >= Math.max(20, 10 * baseline + 10);
  return { recent, last24h, baseline: Math.round(baseline * 100) / 100, spike, strong };
}

const OFFICIAL_LABELS = {
  none: 'sorun bildirmiyor',
  minor: 'küçük çaplı sorun bildiriyor',
  major: 'büyük çaplı kesinti bildiriyor',
  critical: 'kritik kesinti bildiriyor',
  maintenance: 'planlı bakım bildiriyor',
};

/**
 * @param {object} input
 * @param {Record<string, Array>} input.probes    bölge -> ölçüm listesi (eskiden yeniye)
 * @param {string[]} input.regions                beklenen ölçüm bölgeleri
 * @param {Array} input.reports                   servisin kullanıcı bildirimleri
 * @param {object|null} input.official            normalize edilmiş resmi durum özeti
 */
export function computeStatus({ probes = {}, regions = [], reports = [], official = null, now = Date.now(), staleMs, regionLabel = (r) => r }) {
  const signals = [];
  const reasons = [];

  // 1) Bölge ölçümleri
  const regionStates = {};
  for (const [region, results] of Object.entries(probes)) {
    const st = regionState(results, { now, staleMs });
    if (st) regionStates[region] = st;
  }
  const fresh = Object.keys(regionStates);
  if (fresh.length) {
    const down = fresh.filter((r) => regionStates[r] === 'down');
    const degraded = fresh.filter((r) => regionStates[r] === 'degraded');
    let vote = 'up';
    if (down.length / fresh.length >= 2 / 3) vote = 'down';
    else if (down.length || degraded.length) vote = 'degraded';
    const coverage = Math.min(1, fresh.length / Math.max(regions.length, 1));
    signals.push({ source: 'probes', vote, weight: 0.55 * coverage });
    if (down.length) reasons.push(`${fresh.length} ölçüm noktasından ${down.length} tanesi erişemiyor (${down.map(regionLabel).join(', ')})`);
    if (degraded.length) reasons.push(`${degraded.map(regionLabel).join(', ')} noktasından yavaş ya da kararsız cevap`);
    if (vote === 'up') reasons.push(`${fresh.length} ölçüm noktasının tamamından erişilebiliyor`);
  }

  // 2) Kullanıcı bildirimleri — bildirim olmaması zayıf bir "çalışıyor" kanıtıdır.
  const rs = reportStats(reports, { now });
  if (rs.strong) signals.push({ source: 'reports', vote: 'down', weight: 0.35 });
  else if (rs.spike) signals.push({ source: 'reports', vote: 'degraded', weight: 0.3 });
  else signals.push({ source: 'reports', vote: 'up', weight: 0.1 });
  if (rs.spike) {
    const times = rs.baseline >= 0.25 ? ` (normalin ~${Math.round(rs.recent / rs.baseline)} katı)` : ' (normalde neredeyse hiç bildirim gelmiyor)';
    reasons.push(`Son 15 dakikada ${rs.recent} kullanıcı sorun bildirdi${times}`);
  }

  // 3) Resmi durum sayfası
  let override = null;
  if (official?.ok && official.indicator) {
    const ind = official.indicator;
    const vote = ind === 'none' ? 'up' : ind === 'major' || ind === 'critical' ? 'down' : 'degraded';
    const weight = { none: 0.3, minor: 0.35, major: 0.4, critical: 0.5, maintenance: 0.2 }[ind] ?? 0.3;
    signals.push({ source: 'official', vote, weight });
    if (ind !== 'none') reasons.push(`Resmi durum sayfası ${OFFICIAL_LABELS[ind] || ind}${official.description ? `: "${official.description}"` : ''}`);
    const othersBad = signals.some((s) => s.source !== 'official' && s.vote !== 'up');
    if (ind === 'critical' || (ind === 'major' && othersBad)) override = 'down';
  }

  if (!signals.some((s) => s.source !== 'reports') && !rs.spike) {
    return { state: 'unknown', confidence: 0, score: null, reasons: ['Henüz yeterli ölçüm yok'], regions: regionStates, reports: rs };
  }

  const total = signals.reduce((a, s) => a + s.weight, 0);
  const score = signals.reduce((a, s) => a + s.weight * SEVERITY[s.vote], 0) / total;
  let state = score >= 0.55 ? 'down' : score >= 0.2 ? 'degraded' : 'up';
  if (override && RANK[override] > RANK[state]) state = override;

  // Güven: sinyallerin karara ne kadar yakın oy verdiği (ağırlıklı) × veri kapsamı.
  const agree = signals.reduce((a, s) => a + s.weight * (1 - Math.abs(SEVERITY[s.vote] - SEVERITY[state])), 0) / total;
  const coverage = Math.min(1, total);
  let confidence = 0.35 + 0.6 * agree * (0.5 + 0.5 * coverage);
  if (override) confidence = Math.max(confidence, 0.8);
  confidence = Math.round(Math.min(confidence, 0.99) * 100) / 100;

  return { state, confidence, score: Math.round(score * 100) / 100, reasons, regions: regionStates, reports: rs, signals };
}

// Oyun içi servis kırılımı (giriş / eşleştirme / mağaza): resmi bileşenler + bileşen bazlı kullanıcı bildirimleri.
export function computeComponents({ keys = [], official = null, officialMap = {}, reports = [], overall = 'up', now = Date.now() }) {
  const recent = reports.filter((r) => now - r.t <= BUCKET_MS);
  return keys.map((key) => {
    const out = { key, state: 'up', source: 'varsayılan' };
    const words = officialMap[key] || [key];
    const matched = (official?.components || []).filter((c) => {
      const name = `${c.group || ''} ${c.name}`.toLowerCase();
      return words.some((w) => name.includes(w.toLowerCase()));
    });
    const incidentHit = (official?.incidents || []).some((i) => words.some((w) => `${i.title} ${i.text || ''}`.toLowerCase().includes(w.toLowerCase())));
    if (matched.length) {
      out.state = worstState(matched.map((c) => (c.state === 'maintenance' ? 'degraded' : c.state)));
      out.source = 'resmi';
    }
    if (incidentHit && out.state === 'up') {
      out.state = 'degraded';
      out.source = 'resmi';
    }
    const count = recent.filter((r) => r.component === key).length;
    out.reports = count;
    if (count >= 3 && count >= 0.4 * recent.length) {
      const fromReports = count >= 15 ? 'down' : 'degraded';
      if (RANK[fromReports] > RANK[out.state]) {
        out.state = fromReports;
        out.source = 'bildirimler';
      }
    }
    if (overall === 'down' && out.state === 'up') {
      out.state = 'degraded';
      out.source = 'genel durum';
    }
    return out;
  });
}

// 24 saatlik bildirim grafiği için 15 dakikalık kovalar (en eskiden en yeniye).
export function histogram(reports, { now = Date.now(), hours = 24, bucketMs = BUCKET_MS } = {}) {
  const n = Math.round((hours * 3600_000) / bucketMs);
  const end = (Math.floor(now / bucketMs) + 1) * bucketMs;
  const start = end - n * bucketMs;
  const buckets = Array.from({ length: n }, (_, i) => ({ t: start + i * bucketMs, count: 0 }));
  for (const r of reports) {
    const i = Math.floor((r.t - start) / bucketMs);
    if (i >= 0 && i < n) buckets[i].count++;
  }
  return buckets;
}

export function ispBreakdown(reports, { now = Date.now(), windowMs = 3600_000, labels = {} } = {}) {
  const recent = reports.filter((r) => now - r.t <= windowMs);
  const counts = {};
  for (const r of recent) {
    const k = r.isp || 'bilinmiyor';
    counts[k] = (counts[k] || 0) + 1;
  }
  return Object.entries(counts)
    .map(([isp, count]) => ({ isp, label: labels[isp] || (isp === 'bilinmiyor' ? 'Belirtilmemiş' : isp), count, share: Math.round((count / recent.length) * 100) }))
    .sort((a, b) => b.count - a.count);
}
