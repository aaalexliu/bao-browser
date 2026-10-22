import { notFound } from "next/navigation";
import { listingStat } from "@/lib/listing";
import { HttpError, publicWorkflow } from "@/lib/registry";
import { principal, when } from "@/lib/viewer";
import { SetupForm } from "../../setup-form";

export const dynamic = "force-dynamic";

export default async function PublicWorkflowPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ reported?: string }>;
}) {
  const { id } = await params;
  const query = await searchParams;
  const user = await principal();
  let workflow;
  try {
    workflow = await publicWorkflow(id);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) notFound();
    throw err;
  }
  const doc = workflow.document as { steps?: { id?: string; label?: string }[] };
  const steps = doc.steps ?? [];
  const shots = new Map(workflow.shots.map((shot) => [shot.stepId, shot.url]));
  const stat = listingStat(workflow.passRate.total, when(workflow.lastGreenAt), workflow.ciVerified);
  return (
    <article data-testid="workflow" className="listing">
      <header className="listing-hero">
        <div>
          <p className="crumb"><a href="/marketplace">Marketplace</a> <span aria-hidden="true">/</span> {workflow.category}</p>
          <h1>{workflow.name}</h1>
          <p className="lede">{workflow.summary}</p>
          <p className="meta">By {workflow.author}</p>
          <div className="chips">
            <span className="chip">{workflow.category}</span>
            {workflow.verified ? <span className="badge" data-testid="verified">Verified author</span> : null}
            {workflow.ciVerified ? <span className="badge" data-testid="replay-verified">Verified</span> : null}
            <span className="chip" data-testid="listing-stat">{stat}</span>
          </div>
        </div>
        <div className="listing-install">
          <a className="button primary" data-testid="install" href={workflow.importLink}>Install</a>
          <p className="muted">Opens the import sheet on this Mac.</p>
        </div>
      </header>
      <div className="listing-layout">
        <div>
          <h2>Steps</h2>
          <ol className="listing-steps" data-testid="steps">
            {steps.map((step, index) => {
              const src = shots.get(String(step.id || ""));
              const label = step.label || step.id || "Step";
              return (
                <li key={step.id || index}>
                  <span className="n">{index + 1}</span>
                  {src ? <img src={src} alt="" /> : <span className="crop-empty">No crop</span>}
                  <strong>{label}</strong>
                </li>
              );
            })}
          </ol>
          <section data-testid="inputs">
            <h2>Inputs</h2>
            {workflow.questions.length ? (
              <ul className="ask" data-testid="setup-questions">
                {workflow.questions.map((question) => (
                  <li key={question.name}>
                    <strong>{question.label || question.prompt}</strong>
                    <span className="chip">{question.type}</span>
                    {question.prompt && question.prompt !== question.label ? <p className="muted">{question.prompt}</p> : null}
                    {question.hint ? <p className="muted">{question.hint}</p> : null}
                  </li>
                ))}
              </ul>
            ) : <p className="muted" data-testid="setup-questions">This workflow asks for nothing.</p>}
          </section>
          <h2>Versions</h2>
          <ol className="versions" data-testid="versions">
            {workflow.versions.map((version) => (
              <li key={version.version}>v{version.version} · {when(version.created_at)}</li>
            ))}
          </ol>
          <h2>Inputs on this account</h2>
          {user ? (
            <SetupForm action={`/api/marketplace/${workflow.id}/fork`} questions={workflow.questions} submit="Copy to my library" />
          ) : (
            <p><a href="/login">Sign in</a> to copy this into your library.</p>
          )}
        </div>
        <aside className="card listing-side">
          <h2>Sites</h2>
          <div className="chips" data-testid="domains">
            {workflow.domains.map((domain) => <span className="chip" key={domain}>{domain}</span>)}
            {workflow.domains.length ? null : <span className="chip">No network calls</span>}
          </div>
          <h2>Replay</h2>
          <p data-testid="last-green">Last replayed green: {when(workflow.lastGreenAt)}</p>
          <p className="mono" data-testid="import-link">{workflow.importLink}</p>
          <p className="mono" data-testid="deeplink">{workflow.link}</p>
        </aside>
      </div>
      <h2>Report</h2>
      {query.reported ? <p className="notice">Report received.</p> : null}
      <p className="muted">{workflow.reports} report{workflow.reports === 1 ? "" : "s"}</p>
      {user ? (
        <form action={`/api/marketplace/${workflow.id}/report`} method="post">
          <label>What is wrong?
            <input name="reason" required />
          </label>
          <button type="submit">Report</button>
        </form>
      ) : null}
    </article>
  );
}
