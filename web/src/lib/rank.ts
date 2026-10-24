// Plain-text ranker. Title, summary, site, and step text. Embeddings are not required.

export interface RankInput {
  id: string;
  title: string;
  summary: string;
  site: string;
  category: string;
  steps: string[];
  source: "mine" | "team" | "public";
}

export function rankHits<T extends RankInput>(
  items: T[],
  query: string,
  filters: { source?: string; site?: string; category?: string } = {},
): (T & { score: number })[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const ranked: (T & { score: number })[] = [];
  for (const item of items) {
    if (filters.source && item.source !== filters.source) continue;
    if (filters.category && item.category.toLowerCase() !== filters.category.toLowerCase()) continue;
    const site = item.site.toLowerCase();
    if (filters.site && !site.includes(filters.site.toLowerCase())) continue;
    let score = tokens.length ? 0 : 1;
    const title = item.title.toLowerCase();
    const summary = item.summary.toLowerCase();
    const intent = item.steps.join("\n").toLowerCase();
    for (const token of tokens) {
      if (title.includes(token)) score += 10;
      if (summary.includes(token)) score += 6;
      if (site.includes(token)) score += 8;
      if (intent.includes(token)) score += 4;
    }
    if (filters.site && site.includes(filters.site.toLowerCase())) score += 12;
    if (tokens.length && score === 0) continue;
    ranked.push({ ...item, score });
  }
  ranked.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return ranked;
}

export const SEARCH_LIMIT = 5;
