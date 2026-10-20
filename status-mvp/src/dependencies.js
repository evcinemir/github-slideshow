import { worstState } from './scoring.js';

// Altyapı servislerinin bölge bazlı resmi durumu. Bileşen/grup adları bölge kalıplarıyla eşleştirilir;
// bölgesel bileşeni olmayan servislerde genel gösterge tüm bölgelere uygulanır.
export const DEPENDENCY_REGIONS = {
  europe: { label: 'Avrupa', pattern: '\\beurope\\b|\\beu-[a-z]+-\\d|frankfurt|amsterdam|london|paris|istanbul|madrid|milan|stockholm|dublin|warsaw|\\b(fra|ams|lhr|cdg|ist)\\b' },
  'north-america': { label: 'Kuzey Amerika', pattern: 'north america|\\bus-[a-z]+-\\d|\\bca-central|virginia|ohio|oregon|california|new york|chicago|dallas|toronto|\\b(iad|sfo|lax|ord|dfw|yyz)\\b' },
  'asia-pacific': { label: 'Asya-Pasifik', pattern: '\\basia\\b|pacific|oceania|\\bap-[a-z]+-\\d|tokyo|singapore|sydney|mumbai|seoul|hong kong|\\b(nrt|sin|syd|bom|icn|hkg)\\b' },
};

const INDICATOR_STATE = { none: 'up', minor: 'degraded', maintenance: 'degraded', major: 'down', critical: 'down' };

export function officialByRegion(service, official) {
  if (!official?.ok) return null;
  const out = {};
  let anyRegional = false;
  for (const [key, { pattern }] of Object.entries(DEPENDENCY_REGIONS)) {
    const re = new RegExp(service.official?.regions?.[key] || pattern, 'i');
    const matched = official.components.filter((c) => re.test(`${c.group || ''} ${c.name}`));
    if (matched.length) {
      anyRegional = true;
      out[key] = worstState(matched.map((c) => (c.state === 'maintenance' ? 'degraded' : c.state)));
    }
  }
  const global = INDICATOR_STATE[official.indicator] || 'up';
  for (const key of Object.keys(DEPENDENCY_REGIONS)) {
    // Bölgesel bileşen yoksa (GitHub, npm gibi) genel durum tüm bölgeler için geçerlidir.
    if (!out[key]) out[key] = anyRegional ? 'up' : global;
  }
  return { regions: out, regional: anyRegional, indicator: official.indicator };
}
