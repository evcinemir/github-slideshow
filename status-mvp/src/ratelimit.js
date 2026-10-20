// Sabit pencereli, anahtar başına sayaçlı basit hız sınırlayıcı.
export class RateLimiter {
  constructor({ limit, windowMs }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = new Map();
    const timer = setInterval(() => this.prune(), Math.min(windowMs, 60_000));
    timer.unref?.();
  }

  take(key, now = Date.now()) {
    let entry = this.hits.get(key);
    if (!entry || now >= entry.reset) {
      entry = { count: 0, reset: now + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count++;
    return {
      allowed: entry.count <= this.limit,
      limit: this.limit,
      remaining: Math.max(0, this.limit - entry.count),
      resetSec: Math.ceil((entry.reset - now) / 1000),
    };
  }

  prune(now = Date.now()) {
    for (const [k, v] of this.hits) if (now >= v.reset) this.hits.delete(k);
  }
}
