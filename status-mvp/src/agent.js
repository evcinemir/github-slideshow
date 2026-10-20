// Uzak ölçüm ajanı: Frankfurt, ABD gibi bölgelerde küçük bir sunucuda çalışır,
// tüm servisleri ölçer ve sonuçları toplu halde merkez sunucuya gönderir.
//
//   REGION=frankfurt SERVER_URL=https://coktumu.example AGENT_TOKEN=... node src/agent.js
import { config } from './config.js';
import { loadCatalog } from './catalog.js';
import { startMonitor } from './monitor.js';

const serverUrl = (process.env.SERVER_URL || '').replace(/\/$/, '');
if (!serverUrl || !config.agentToken) {
  console.error('SERVER_URL ve AGENT_TOKEN ortam değişkenleri gerekli');
  process.exit(1);
}

const catalog = loadCatalog();
let buffer = [];

startMonitor({
  services: catalog.services,
  region: config.region,
  intervalMs: config.probeIntervalMs,
  timeoutMs: config.probeTimeoutMs,
  slowMs: config.slowMs,
  concurrency: config.probeConcurrency,
  sink: (s, result) => buffer.push({ slug: s.slug, result }),
});

async function flush() {
  if (!buffer.length) return;
  const batch = buffer;
  buffer = [];
  try {
    const res = await fetch(`${serverUrl}/internal/probes`, {
      method: 'POST',
      headers: { authorization: `Bearer ${config.agentToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ region: config.region, results: batch }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    console.warn(`[agent] gönderilemedi (${err.message}); ${batch.length} sonuç tekrar denenecek`);
    // Sunucu uzun süre erişilemezse belleği şişirme: yalnızca son sonuçları tut.
    buffer = [...batch, ...buffer].slice(-500);
  }
}

setInterval(flush, 10_000);
console.log(`Ölçüm ajanı çalışıyor: bölge=${config.region}, merkez=${serverUrl}`);
