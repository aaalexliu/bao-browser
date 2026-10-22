import { marketplace } from "@/lib/registry";
import { rate, when } from "@/lib/viewer";

export const dynamic = "force-dynamic";

export default async function MarketplacePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; site?: string; category?: string }>;
}) {
  const query = await searchParams;
  const hits = await marketplace(query.q || "", query.site || "", query.category || "");
  const categories = [...new Set(hits.map((hit) => hit.category))].sort();
  return (
    <section>
      <h1>Marketplace</h1>
      <p>Public workflows. A listing appears only after a device replays it and the author confirms the preview.</p>
      <form className="search" action="/marketplace" method="get">
        <label>Search
          <input name="q" defaultValue={query.q || ""} placeholder="Wikipedia, form, fixture" />
        </label>
        <label>Site
          <input name="site" defaultValue={query.site || ""} placeholder="wikipedia.org" />
        </label>
        <label>Category
          <input name="category" defaultValue={query.category || ""} placeholder="Forms" />
        </label>
        <button type="submit">Search</button>
      </form>
      <div className="filters">
        <a className="chip" href="/marketplace">All</a>
        {categories.map((category) => (
          <a className="chip" key={category} href={`/marketplace?category=${encodeURIComponent(category)}`}>{category}</a>
        ))}
      </div>
      <div className="grid" data-testid="marketplace">
        {hits.map((hit) => (
          <a className="card" key={hit.id} href={`/marketplace/${hit.id}`}>
            <h2>{hit.title}</h2>
            <p className="muted">{hit.summary}</p>
            <div className="chips">
              <span className="chip">{hit.category}</span>
              {hit.site ? <span className="chip">{hit.site}</span> : null}
              {hit.verified ? <span className="badge">Verified author</span> : null}
            </div>
            <p className="muted">{hit.author} · {rate(hit.passRate)} · last green {when(hit.lastGreenAt)}</p>
          </a>
        ))}
      </div>
      {hits.length ? null : <p>Nothing public yet. Replay a workflow, then confirm the preview.</p>}
    </section>
  );
}
