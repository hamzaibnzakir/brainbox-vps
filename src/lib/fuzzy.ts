/**
 * Small, fast fuzzy matcher for the command palette and server search.
 * Scores consecutive matches, word starts and prefix matches higher.
 */
export interface FuzzyResult {
  score: number;
  indices: number[];
}

export function fuzzyMatch(query: string, text: string): FuzzyResult | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, indices: [] };
  const t = text.toLowerCase();
  // Fast path: substring
  const sub = t.indexOf(q);
  if (sub >= 0) {
    const indices = Array.from({ length: q.length }, (_, i) => sub + i);
    const wordStart = sub === 0 || /[\s\-_/.:]/.test(t[sub - 1]);
    return { score: 1000 - sub * 2 + (wordStart ? 200 : 0) + (sub === 0 ? 300 : 0) - (t.length - q.length) * 0.5, indices };
  }
  let ti = 0;
  let score = 0;
  let prev = -2;
  const indices: number[] = [];
  for (let qi = 0; qi < q.length; qi++) {
    const c = q[qi];
    if (c === " ") continue;
    let found = -1;
    while (ti < t.length) {
      if (t[ti] === c) {
        found = ti;
        ti++;
        break;
      }
      ti++;
    }
    if (found < 0) return null;
    indices.push(found);
    const wordStart = found === 0 || /[\s\-_/.:]/.test(t[found - 1]);
    score += 10 + (found === prev + 1 ? 15 : 0) + (wordStart ? 12 : 0);
    prev = found;
  }
  return { score: score - t.length * 0.2, indices };
}

/** Filter + sort items by fuzzy score over several fields. */
export function fuzzyFilter<T>(items: T[], query: string, fields: (item: T) => string[]): Array<{ item: T; score: number; indices: number[] }> {
  if (!query.trim()) return items.map((item) => ({ item, score: 0, indices: [] }));
  const out: Array<{ item: T; score: number; indices: number[] }> = [];
  for (const item of items) {
    let best: FuzzyResult | null = null;
    fields(item).forEach((f, i) => {
      const r = fuzzyMatch(query, f);
      if (r) {
        const s = { score: r.score - i * 5, indices: i === 0 ? r.indices : [] };
        if (!best || s.score > best.score) best = s;
      }
    });
    if (best) out.push({ item, ...(best as FuzzyResult) });
  }
  return out.sort((a, b) => b.score - a.score);
}
