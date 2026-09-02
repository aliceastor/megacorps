// Per-viewer "last opened" times for cards, behind the 對話 tab's unread line
// (design §4.3.6). localStorage only, written when a card closes, capped so
// the map cannot grow without bound. Every read / write is try/catch: private
// mode or a blocked store just means no unread line.

export const CARD_SEEN_KEY = 'megacorps.kanban.card-seen.v1';
export const CARD_SEEN_LIMIT = 200;
export type CardSeenMap = Record<string, number>;

/** Records `at` for cardId and keeps only the `limit` most recently seen cards. */
export function rememberCardSeen(map: CardSeenMap, cardId: string, at: number, limit = CARD_SEEN_LIMIT): CardSeenMap {
  const next: CardSeenMap = { ...map, [cardId]: at };
  const entries = Object.entries(next)
    .filter(([, value]) => Number.isFinite(value) && value > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, Math.max(1, limit));
  return Object.fromEntries(entries);
}

/** Parses a stored map without trusting its shape; anything odd becomes an empty map. */
export function parseCardSeen(raw: string | null | undefined): CardSeenMap {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const out: CardSeenMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'number' && Number.isFinite(value) && value > 0) out[key] = value;
    }
    return out;
  } catch {
    return {};
  }
}

export function readCardSeen(): CardSeenMap {
  if (typeof window === 'undefined') return {};
  try {
    return parseCardSeen(window.localStorage.getItem(CARD_SEEN_KEY));
  } catch {
    return {};
  }
}

export function writeCardSeen(map: CardSeenMap): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CARD_SEEN_KEY, JSON.stringify(map));
  } catch {
    // Per-viewer convenience only; a refused write just loses the unread line.
  }
}
