import { computeStatus, computeComponents, STATE_LABELS } from './scoring.js';
import { regionLabel } from './config.js';

// Bir servisin tüm sinyallerini birleştirip güncel durumu üretir ve durum değişikliklerini
// (kısa titreşimleri eleyerek) bildirim katmanına iletir.
export class Engine {
  constructor({ catalog, store, regions, staleMs, debounceMs = 120_000, onChange = () => {} }) {
    Object.assign(this, { catalog, store, regions, staleMs, debounceMs, onChange });
  }

  evaluate(slug, now = Date.now()) {
    const service = this.catalog.bySlug.get(slug);
    const official = this.store.official(slug);
    const reports = this.store.reportsFor(slug, now - 24 * 3600_000);
    const result = computeStatus({
      probes: this.store.probes(slug),
      regions: this.regions,
      reports,
      official,
      now,
      staleMs: this.staleMs,
      regionLabel,
    });
    if (service?.game) {
      result.components = computeComponents({
        keys: service.game.components,
        official,
        officialMap: service.official?.componentMap,
        reports,
        overall: result.state,
        now,
      });
    }
    return result;
  }

  recompute(slug, now = Date.now()) {
    const result = this.evaluate(slug, now);
    const prev = this.store.status(slug);
    const committed = prev?.state ?? 'unknown';
    const next = {
      state: committed,
      since: prev?.since ?? now,
      confidence: result.confidence,
      updatedAt: now,
      pending: null,
    };

    if (result.state === committed) {
      next.confidence = result.confidence;
    } else {
      const pendingSince = prev?.pending?.state === result.state ? prev.pending.since : now;
      // Yüksek güvenli kararlar ve ilk karar hemen işlenir; diğerleri debounce süresi boyunca sabit kalmalı.
      const settle = committed === 'unknown' || result.confidence >= 0.9 || now - pendingSince >= this.debounceMs;
      if (settle) {
        next.state = result.state;
        next.since = now;
        if (committed !== 'unknown' && result.state !== 'unknown') {
          this.onChange(this.catalog.bySlug.get(slug), { from: committed, to: result.state, result, at: now });
        }
      } else {
        next.pending = { state: result.state, since: pendingSince };
      }
    }
    this.store.setStatus(slug, next);
    return { ...result, committed: next };
  }

  recomputeAll(now = Date.now()) {
    for (const s of this.catalog.services) this.recompute(s.slug, now);
  }

  // Kamuya gösterilen durum: kararlaştırılmış durum + anlık skor ayrıntıları.
  view(slug, now = Date.now()) {
    const live = this.evaluate(slug, now);
    const committed = this.store.status(slug);
    const state = committed?.state ?? live.state;
    return {
      state,
      label: STATE_LABELS[state],
      confidence: state === live.state ? live.confidence : committed?.confidence ?? live.confidence,
      since: committed?.since ?? null,
      reasons: live.reasons,
      regions: live.regions,
      reports: live.reports,
      components: live.components,
      updatedAt: now,
    };
  }
}
