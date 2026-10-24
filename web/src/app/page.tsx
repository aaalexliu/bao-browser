import { listLibrary } from "@/lib/registry";
import { principal, when } from "@/lib/viewer";
import { GalleryCard } from "./ui";

export const dynamic = "force-dynamic";

export default async function LibraryPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; share?: string; permission?: string }>;
}) {
  const query = await searchParams;
  const user = await principal();
  if (!user) {
    return (
      <section>
        <h1>Library</h1>
        <p>Sign in to see the workflows on your account.</p>
        <a className="button primary" href="/login">Sign in</a>
      </section>
    );
  }
  const workflows = await listLibrary(user.userId, query.q || "");
  return (
    <section>
      <h1>Library</h1>
      <form className="search" action="/" method="get">
        <label>Search
          <input name="q" defaultValue={query.q || ""} placeholder="Title, site, or step" />
        </label>
        <button type="submit">Search</button>
      </form>
      {query.share ? (
        <p className="notice">Share link <a href={`/share/${query.share}`}>/share/{query.share}</a> ({query.permission || "view"}). Personal values were cleared.</p>
      ) : null}
      <div className="grid" data-testid="library">
        {workflows.map((workflow) => (
          <GalleryCard
            key={workflow.id}
            href={`/workflows/${workflow.id}`}
            id={workflow.id}
            title={workflow.title}
            summary={workflow.summary || "No steps yet"}
            thumbnail={workflow.thumbnail}
            runs={workflow.passRate.total}
            lastGreen={when(workflow.lastGreenAt)}
            domains={workflow.domains}
            verified={workflow.verified}
          />
        ))}
      </div>
      {workflows.length ? null : <p>Nothing in the library yet. Pair a Mac and run <span className="mono">bao sync</span>.</p>}
    </section>
  );
}
