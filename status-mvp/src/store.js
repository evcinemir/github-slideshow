import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const MAX_PROBES_PER_REGION = 40;
const REPORT_RETENTION_MS = 48 * 3600_000;

// Basit, tek süreçli kalıcı depo: bellekte tutar, belirli aralıklarla JSON dosyasına yazar.
// MVP ölçeğinde (yüz servis, günde on binlerce bildirim) yeterli; büyüyünce Postgres/Redis'e taşınır.
export class Store {
  constructor(file) {
    this.file = file;
    this.data = {
      probes: {},
      reports: {},
      official: {},
      status: {},
      subscriptions: [],
      discord: [],
    };
    this.dirty = false;
  }

  load() {
    if (!this.file) return this;
    try {
      Object.assign(this.data, JSON.parse(readFileSync(this.file, 'utf8')));
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn(`[store] ${this.file} okunamadı: ${err.message}`);
    }
    return this;
  }

  save() {
    if (!this.file || !this.dirty) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data));
    renameSync(tmp, this.file);
    this.dirty = false;
  }

  autosave(intervalMs = 30_000) {
    const timer = setInterval(() => this.save(), intervalMs);
    timer.unref();
    return timer;
  }

  touch() {
    this.dirty = true;
  }

  addProbe(slug, region, result) {
    const bySvc = (this.data.probes[slug] ||= {});
    const list = (bySvc[region] ||= []);
    list.push(result);
    if (list.length > MAX_PROBES_PER_REGION) list.splice(0, list.length - MAX_PROBES_PER_REGION);
    this.touch();
  }

  probes(slug) {
    return this.data.probes[slug] || {};
  }

  // Bildirimler servis başına zaman sırasıyla tutulur.
  addReport(report) {
    (this.data.reports[report.slug] ||= []).push(report);
    this.touch();
  }

  reportsFor(slug, sinceMs = 0) {
    const list = this.data.reports[slug] || [];
    let i = list.length;
    while (i > 0 && list[i - 1].t >= sinceMs) i--;
    return list.slice(i);
  }

  pruneReports(now = Date.now()) {
    const cutoff = now - REPORT_RETENTION_MS;
    for (const [slug, list] of Object.entries(this.data.reports)) {
      const kept = list.filter((r) => r.t >= cutoff);
      if (kept.length === list.length) continue;
      if (kept.length) this.data.reports[slug] = kept;
      else delete this.data.reports[slug];
      this.touch();
    }
  }

  setOfficial(slug, summary) {
    this.data.official[slug] = summary;
    this.touch();
  }

  official(slug) {
    return this.data.official[slug] || null;
  }

  setStatus(slug, status) {
    this.data.status[slug] = status;
    this.touch();
  }

  status(slug) {
    return this.data.status[slug] || null;
  }
}
