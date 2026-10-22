import { notFound } from "next/navigation";
import { HttpError, previewPublication } from "@/lib/registry";
import { plainReplayReason } from "@/lib/review-gate";
import { principal, when } from "@/lib/viewer";

export const dynamic = "force-dynamic";

export default async function PublishPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await principal();
  if (!user) return <p><a href="/login">Sign in</a> to publish.</p>;
  let preview;
  try {
    preview = await previewPublication(user, id);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) notFound();
    throw err;
  }
  return (
    <article data-testid="publish-preview">
      <h1>What goes public</h1>
      <p>A device replays this copy first. Listing then runs it once in a clean browser against its public site. Only that run stamps last green and Verified.</p>
      <div className="chips">
        {preview.verified ? <span className="badge" data-testid="verified">Verified author</span> : <span className="chip">{preview.author}</span>}
        <span className="chip">{preview.reviewed ? "Replay recorded" : "Waiting for a replay"}</span>
      </div>
      <p data-testid="byline">By {preview.author}</p>
      <p data-testid="last-green">Last replayed green: {when(preview.lastGreenAt)}</p>
      <h2>Domains this workflow touches</h2>
      <div className="chips" data-testid="domains">
        {preview.domains.map((domain) => <span className="chip" key={domain}>{domain}</span>)}
        {preview.domains.length ? null : <span className="chip">No network calls</span>}
      </div>
      <p className="mono" data-testid="deeplink">{preview.link}</p>
      <p className="mono" data-testid="import-link">{preview.importLink}</p>
      {preview.gateStep ? (
        <div className="notice" data-testid="blocked-publish">
          <p>Publish is blocked. The clean replay failed on <strong data-testid="gate-step">{preview.gateStep}</strong>.</p>
        </div>
      ) : null}
      <h2>Cleared before listing</h2>
      {preview.changes.length ? (
        <table className="diff">
          <thead>
            <tr><th>Field</th><th>Before</th><th>Public</th><th>Why</th></tr>
          </thead>
          <tbody>
            {preview.changes.map((change, index) => (
              <tr key={`${change.path}-${index}`}>
                <td className="mono">{change.path}</td>
                <td><code>{change.before}</code></td>
                <td><code>{change.after || "removed"}</code></td>
                <td>{change.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : <p>No personal values or secrets were in this copy.</p>}
      <form className="row" action={`/api/workflows/${id}/publish`} method="post">
        <button className="primary" type="submit" data-testid="list-it" disabled={!preview.reviewed || Boolean(preview.gateStep)}>
          {preview.reviewed ? "List it" : "Replay on a device before listing"}
        </button>
        {preview.gateStep ? <span data-testid="gate-reason">{plainReplayReason(preview.gateReason || "")}</span> : null}
        {preview.gateStep ? <button type="submit" data-testid="replay-again">Replay again</button> : null}
      </form>
      {preview.reviewed ? null : (
        <p className="notice">Run <span className="mono">bao sync review {id}</span>. The device replays the redacted copy and only then can this page list it.</p>
      )}
    </article>
  );
}
