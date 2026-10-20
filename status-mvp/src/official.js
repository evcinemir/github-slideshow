// Resmi durum sayfası entegrasyonları. Her adaptör ham cevabı ortak bir özete çevirir:
// { ok, fetchedAt, indicator: none|minor|major|critical|maintenance, description, components[], incidents[], pageUrl }

const COMPONENT_STATE = {
  operational: 'up',
  degraded_performance: 'degraded',
  partial_outage: 'degraded',
  major_outage: 'down',
  under_maintenance: 'maintenance',
};

export function parseStatuspage(summary, { componentGroup } = {}) {
  const groups = new Map((summary.components || []).filter((c) => c.group).map((c) => [c.id, c.name]));
  let components = (summary.components || [])
    .filter((c) => !c.group)
    .map((c) => ({ name: c.name, group: groups.get(c.group_id) || null, state: COMPONENT_STATE[c.status] || 'up' }));
  let indicator = summary.status?.indicator || 'none';
  let description = summary.status?.description || '';

  // Ortak bir sayfayı paylaşan servisler (ör. Epic → Fortnite / Epic Games Store) yalnızca kendi grubunu görür.
  if (componentGroup) {
    const g = componentGroup.toLowerCase();
    components = components.filter((c) => (c.group || '').toLowerCase().includes(g) || c.name.toLowerCase().includes(g));
    const worst = components.reduce((a, c) => Math.max(a, { up: 0, maintenance: 1, degraded: 2, down: 3 }[c.state]), 0);
    indicator = ['none', 'maintenance', 'minor', 'major'][worst];
    description = '';
  }

  const incidents = (summary.incidents || []).map((i) => ({
    title: i.name,
    impact: i.impact,
    status: i.status,
    updatedAt: i.updated_at,
    url: i.shortlink,
    text: i.incident_updates?.[0]?.body || '',
  }));
  const maint = (summary.scheduled_maintenances || [])
    .filter((m) => m.status === 'in_progress')
    .map((m) => ({ title: m.name, impact: 'maintenance', status: m.status, updatedAt: m.updated_at, url: m.shortlink, text: m.incident_updates?.[0]?.body || '' }));
  if (indicator === 'none' && maint.length && !componentGroup) indicator = 'maintenance';
  return { indicator, description, components, incidents: [...incidents, ...maint] };
}

function riotText(list, locale = 'tr_TR') {
  if (!Array.isArray(list)) return '';
  return (list.find((t) => t.locale === locale) || list.find((t) => t.locale === 'en_US') || list[0])?.content || '';
}

// Riot Games (Valorant, LoL) herkese açık durum JSON'u.
export function parseRiot(data) {
  const items = [
    ...(data.incidents || []).map((i) => ({ ...i, kind: 'incident' })),
    ...(data.maintenances || []).map((m) => ({ ...m, kind: 'maintenance' })),
  ];
  const incidents = items.map((i) => {
    const update = i.updates?.[0];
    return {
      title: riotText(i.titles),
      impact: i.kind === 'maintenance' ? 'maintenance' : i.incident_severity || 'warning',
      status: i.maintenance_status || 'active',
      updatedAt: update?.updated_at || i.updated_at || i.created_at,
      text: riotText(update?.translations),
    };
  });
  let indicator = 'none';
  if (incidents.some((i) => i.impact === 'critical')) indicator = 'major';
  else if (incidents.some((i) => i.impact !== 'maintenance' && i.impact !== 'info')) indicator = 'minor';
  else if (incidents.length) indicator = 'maintenance';
  return { indicator, description: incidents[0]?.title || '', components: [], incidents };
}

// AWS Health Dashboard'un herkese açık "current events" listesi (en iyi çaba; biçim zaman zaman değişebiliyor).
export function parseAws(data) {
  const events = Array.isArray(data) ? data : data?.current || [];
  const components = events.map((e) => ({
    name: `${e.service_name || e.service || 'AWS'}${e.region_name || e.region ? ` (${e.region_name || e.region})` : ''}`,
    group: e.region || e.region_name || null,
    state: String(e.status) === '3' ? 'down' : 'degraded',
  }));
  const incidents = events.map((e) => ({
    title: e.summary || e.event_title || 'AWS olayı',
    impact: String(e.status) === '3' ? 'major' : 'minor',
    status: 'active',
    updatedAt: e.date ? new Date(Number(e.date) * 1000).toISOString() : null,
    text: Array.isArray(e.event_log) ? e.event_log.at(-1)?.message || '' : '',
  }));
  const indicator = components.some((c) => c.state === 'down') ? 'major' : components.length ? 'minor' : 'none';
  return { indicator, description: incidents[0]?.title || '', components, incidents };
}

async function fetchJson(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  // AWS bazen UTF-16 (BOM'lu) döner.
  const text = buf[0] === 0xff && buf[1] === 0xfe ? buf.toString('utf16le').slice(1) : buf.toString('utf8').replace(/^﻿/, '');
  return JSON.parse(text);
}

export const ADAPTERS = {
  statuspage: {
    endpoint: (o) => `${o.url.replace(/\/$/, '')}/api/v2/summary.json`,
    parse: (data, o) => parseStatuspage(data, o),
  },
  riot: { endpoint: (o) => o.url, parse: parseRiot },
  aws: { endpoint: (o) => o.url, parse: parseAws },
};

export async function fetchOfficial(service, { timeoutMs = 10_000 } = {}) {
  const o = service.official;
  const adapter = ADAPTERS[o?.type];
  if (!adapter) return null;
  const pageUrl = o.type === 'statuspage' ? o.url : o.pageUrl || o.url;
  try {
    const data = await fetchJson(adapter.endpoint(o), timeoutMs);
    return { ok: true, fetchedAt: Date.now(), pageUrl, ...adapter.parse(data, o) };
  } catch (err) {
    return { ok: false, fetchedAt: Date.now(), pageUrl, error: err.message };
  }
}

export function startOfficialPoller({ catalog, store, engine, intervalMs, concurrency = 4 }) {
  const targets = catalog.services.filter((s) => ADAPTERS[s.official?.type]);
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const queue = [...targets];
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          for (let s = queue.shift(); s; s = queue.shift()) {
            const summary = await fetchOfficial(s);
            const prev = store.official(s.slug);
            // Geçici bir çekme hatasında eski (ama taze) veriyi koru.
            if (!summary.ok && prev?.ok && Date.now() - prev.fetchedAt < 10 * 60_000) continue;
            store.setOfficial(s.slug, summary);
            engine.recompute(s.slug);
          }
        }),
      );
    } finally {
      running = false;
    }
  };
  run();
  const timer = setInterval(run, intervalMs);
  timer.unref();
  return { stop: () => clearInterval(timer), run };
}
