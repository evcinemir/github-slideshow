import { probeService } from './probes.js';

// Her servisi kendi aralığında, ilk çalıştırmada rastgele kaydırılarak (yük dağıtılsın diye) ve
// sınırlı eşzamanlılıkla ölçer. Sonuçları `sink` fonksiyonuna verir; sunucu yerel depoya yazar, ajan merkeze gönderir.
export function startMonitor({ services, region, intervalMs, timeoutMs, slowMs, concurrency = 8, sink, probe = probeService }) {
  const next = new Map(services.map((s) => [s.slug, Date.now() + Math.random() * Math.min(intervalMs, 30_000)]));
  const inFlight = new Set();
  let stopped = false;

  const tick = () => {
    if (stopped) return;
    const now = Date.now();
    for (const s of services) {
      if (inFlight.size >= concurrency) break;
      if (inFlight.has(s.slug) || next.get(s.slug) > now) continue;
      inFlight.add(s.slug);
      next.set(s.slug, now + intervalMs);
      probe(s, { region, timeoutMs, slowMs })
        .then((result) => sink(s, result))
        .catch((err) => console.warn(`[monitor] ${s.slug}: ${err.message}`))
        .finally(() => inFlight.delete(s.slug));
    }
  };

  const timer = setInterval(tick, 1_000);
  timer.unref?.();
  tick();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
