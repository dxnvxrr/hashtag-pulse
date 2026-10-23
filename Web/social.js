// Leaderboard rules shared by the client and the server tests: regions, generated player names, seasons, points.

/** Leaderboard regions, in display order. GLOBAL is every region together. */
export const REGIONS = [
  { code: 'NA', name: 'North America' },
  { code: 'SA', name: 'South America' },
  { code: 'EU', name: 'Europe' },
  { code: 'AF', name: 'Africa' },
  { code: 'ME', name: 'Middle East' },
  { code: 'AS', name: 'Asia' },
  { code: 'OC', name: 'Oceania' },
];
export const REGION_CODES = REGIONS.map((r) => r.code);

export function regionName(code) {
  return REGIONS.find((r) => r.code === code)?.name ?? 'Global';
}

const SOUTH_AMERICA = new Set(
  'Argentina Asuncion Bahia Belem Boa_Vista Bogota Campo_Grande Caracas Cayenne Cuiaba Eirunepe Fortaleza Guayaquil Guyana La_Paz Lima Maceio Manaus Montevideo Noronha Paramaribo Porto_Velho Punta_Arenas Recife Rio_Branco Santarem Santiago Sao_Paulo Araguaina'.split(' '),
);
const MIDDLE_EAST = new Set('Aden Amman Baghdad Bahrain Beirut Damascus Dubai Gaza Hebron Jerusalem Kuwait Muscat Qatar Riyadh Tehran Tel_Aviv'.split(' '));
const AFRICAN_ISLANDS = new Set('Antananarivo Comoro Mauritius Mayotte Reunion Mahe'.split(' '));

/**
 * Best guess at a player's region from their IANA time zone (no location lookup, nothing leaves the device).
 * Returns null when the zone says nothing useful (UTC, Antarctica); the player can always pick by hand.
 */
export function regionForTimeZone(tz) {
  if (typeof tz !== 'string') return null;
  const [area, place = ''] = tz.split('/');
  const city = place.split('/')[0];
  switch (area) {
    case 'America':
      return SOUTH_AMERICA.has(city) ? 'SA' : 'NA';
    case 'Europe':
      return 'EU';
    case 'Africa':
      return 'AF';
    case 'Asia':
      if (MIDDLE_EAST.has(city)) return 'ME';
      if (city === 'Nicosia' || city === 'Famagusta') return 'EU';
      return 'AS';
    case 'Australia':
      return 'OC';
    case 'Pacific':
      if (city === 'Honolulu') return 'NA';
      if (city === 'Galapagos' || city === 'Easter') return 'SA';
      return 'OC';
    case 'Indian':
      return AFRICAN_ISLANDS.has(city) ? 'AF' : 'AS';
    case 'Atlantic':
      return city === 'Stanley' || city === 'South_Georgia' ? 'SA' : city === 'Bermuda' ? 'NA' : city === 'Cape_Verde' || city === 'St_Helena' ? 'AF' : 'EU';
    case 'Canada':
    case 'US':
      return 'NA';
    case 'Brazil':
    case 'Chile':
      return 'SA';
    default:
      return null;
  }
}

// Generated names: players pick from rerolled suggestions, never free text, so boards need no moderation and
// carry no personal data.
export const NAME_ADJECTIVES = [
  'Amber', 'Arctic', 'Bold', 'Brisk', 'Calm', 'Cobalt', 'Cosmic', 'Crimson', 'Crisp', 'Daring', 'Electric', 'Ember',
  'Frost', 'Gilded', 'Golden', 'Hollow', 'Indigo', 'Ivory', 'Jade', 'Keen', 'Lucky', 'Lunar', 'Neon', 'Nimble',
  'Onyx', 'Polar', 'Quiet', 'Rapid', 'Scarlet', 'Silent', 'Silver', 'Solar', 'Steady', 'Swift', 'Velvet', 'Vivid',
];
export const NAME_NOUNS = [
  'Arrow', 'Atlas', 'Beacon', 'Comet', 'Cipher', 'Echo', 'Falcon', 'Fox', 'Glider', 'Halo', 'Heron', 'Lynx',
  'Meteor', 'Nova', 'Orbit', 'Otter', 'Owl', 'Panther', 'Pulse', 'Quasar', 'Raven', 'Ripple', 'Rocket', 'Sparrow',
  'Spark', 'Sphinx', 'Tiger', 'Vector', 'Viper', 'Wave', 'Wolf', 'Zephyr',
];

/** "Swift Comet 4821" from three uniform random uint32s. */
export function makeHandle(r1, r2, r3) {
  return `${NAME_ADJECTIVES[r1 % NAME_ADJECTIVES.length]} ${NAME_NOUNS[r2 % NAME_NOUNS.length]} ${1000 + (r3 % 9000)}`;
}

export const HANDLE_PATTERN = /^[A-Z][a-z]+ [A-Z][a-z]+ \d{4}$/;

/** Seasons are calendar months in UTC: "2026-10". */
export function seasonId(date) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** First instant of the next season. */
export function seasonEnd(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1));
}

/**
 * Leaderboard points in half-point units (PERFECT 4, CLEAN 3, CLOSE 2), so they stay integers. Shown halved:
 * PERFECT 2, CLEAN 1.5, CLOSE 1, the same values as the Prestige circle.
 */
export function halfPoints({ perfects, cleans, closes }) {
  return perfects * 4 + cleans * 3 + closes * 2;
}

export function fmtPoints(half) {
  const whole = Math.floor(half / 2).toLocaleString('en-US');
  return half % 2 ? `${whole}.5` : whole;
}
