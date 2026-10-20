import { readFileSync } from 'node:fs';
import path from 'node:path';
import { config } from './config.js';

export const COMPONENT_LABELS = {
  login: 'Giriş',
  matchmaking: 'Eşleştirme',
  store: 'Mağaza',
  community: 'Topluluk',
  downloads: 'İndirme',
};

export const ISPS = {
  turktelekom: 'Türk Telekom',
  superonline: 'Turkcell Superonline',
  turkcell: 'Turkcell (mobil)',
  vodafone: 'Vodafone (mobil)',
  'vodafone-net': 'Vodafone Net',
  'tt-mobil': 'Türk Telekom Mobil',
  turknet: 'TurkNet',
  millenicom: 'Millenicom',
  kablonet: 'Kablonet',
  diger: 'Diğer',
};

export function normalize(text) {
  return String(text)
    .toLocaleLowerCase('tr')
    .replace(/[çğıöşü]/g, (c) => ({ ç: 'c', ğ: 'g', ı: 'i', ö: 'o', ş: 's', ü: 'u' })[c])
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function loadCatalog(file = path.join(config.root, 'data', 'services.json')) {
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  const services = raw.services.map((s) => {
    const host = new URL(s.url).hostname;
    return {
      ...s,
      host,
      search: normalize([s.name, s.slug, host, ...(s.aliases || [])].join(' ')),
    };
  });
  const bySlug = new Map(services.map((s) => [s.slug, s]));
  if (bySlug.size !== services.length) throw new Error('services.json içinde tekrar eden slug var');
  return { categories: raw.categories, services, bySlug };
}
