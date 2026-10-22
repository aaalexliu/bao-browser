import { notFound } from "next/navigation";
import { HttpError, listRuns, listVersions, pull } from "@/lib/registry";
import { principal, rate, when } from "@/lib/viewer";

export const dynamic = "force-dynamic";

export default async function WorkflowPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ share?: string; permission?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const user = await principal();
  if (!user) {
    return <p><a href="/login">Sign in</a> to open this workflow.</p>;
  }
  let workflow;
  try {
    workflow = await pull(user, id);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) notFound();
    throw err;
  }
  const [versions, runs] = await Promise.all([listVersions(user, id), listRuns(user, id)]);
  const doc = workflow.document as { name?: string; inputs?: { name: string; type: string; label?: string }[]; steps?: { id: string; label?: string }[] };
  return (
    <article>
      <h1>{doc.name || id}</h1>
      <div className="chips">
        <span className="chip">{workflow.category}</span>
        {workflow.verified ? <span className="badge">Verified author</span> : null}
        <span className="chip">{workflow.visibility}</span>
      </div>
      <p data-testid="last-green">Last replayed green: {when(workflow.lastGreenAt)}</p>
      <p>{rate(workflow.passRate)}</p>
      <div className="chips" data-testid="domains">
        {workflow.domains.map((domain) => <span className="chip" key={domain}>{domain}</span>)}
      </div>
      <p className="mono">{workflow.link}</p>
      <p className="row">
        <a className="button" href={`/workflows/${id}/publish`}>Preview what goes public</a>
      </p>
      {query.share ? (
        <p className="notice">Share link <a href={`/share/${query.share}`}>/share/{query.share}</a> ({query.permission}). Personal values were cleared from the shared copy.</p>
      ) : null}
      <h2>Steps</h2>
      <ol className="film">
        {workflow.shots.map((shot) => (
          <li key={shot.stepId}>
            <img src={shot.url} alt="" />
            <span>{doc.steps?.find((step) => step.id === shot.stepId)?.label || shot.stepId}</span>
          </li>
        ))}
      </ol>
      <p className="muted">Redacted on the device.</p>
      <ol className="steps">
        {(doc.steps ?? []).map((step) => <li key={step.id}>{step.label}</li>)}
      </ol>
      <h2>Inputs</h2>
      <ul>
        {(doc.inputs ?? []).map((input) => (
          <li key={input.name}>{input.label || input.name} · {input.type}</li>
        ))}
      </ul>
      <h2>Share</h2>
      <div className="row">
        <form action={`/api/workflows/${id}/share`} method="post">
          <input type="hidden" name="permission" value="view" />
          <button type="submit">Copy a view link</button>
        </form>
        <form action={`/api/workflows/${id}/share`} method="post">
          <input type="hidden" name="permission" value="fork" />
          <button type="submit">Copy an install link</button>
        </form>
      </div>
      <h2>Versions</h2>
      <ul>
        {versions.map((version) => (
          <li key={version.version}>v{version.version}{version.heal ? " · heal" : ""} · {String(version.created_at)}</li>
        ))}
      </ul>
      <h2>Runs</h2>
      <ul>
        {runs.map((run) => (
          <li key={run.id}>{run.status} · {String(run.at)} · {run.shots.length} redacted shots</li>
        ))}
      </ul>
      {runs.length ? null : <p className="muted">No runs pushed from a device yet. Status only. Screenshots are redacted swatches.</p>}
    </article>
  );
}
