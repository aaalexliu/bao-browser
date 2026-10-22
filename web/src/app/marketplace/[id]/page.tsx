import { notFound } from "next/navigation";
import { HttpError, publicWorkflow } from "@/lib/registry";
import { principal, rate, when } from "@/lib/viewer";
import { SetupForm } from "../../setup-form";
import { InstallButton } from "../../ui";

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
  const steps = (workflow.document as { steps?: { id?: string; label?: string }[] }).steps ?? [];
  return (
    <article data-testid="workflow">
      <h1>{workflow.name}</h1>
      <p className="muted">{workflow.summary}</p>
      <div className="chips">
        <span className="chip">{workflow.category}</span>
        {workflow.verified ? <span className="badge" data-testid="verified">Verified author</span> : <span className="chip">{workflow.author}</span>}
        {workflow.ciVerified ? <span className="badge" data-testid="replay-verified">Verified</span> : null}
        <span className="chip">{rate(workflow.passRate)}</span>
      </div>
      <p>By {workflow.author}</p>
      <p data-testid="last-green">Last replayed green: {when(workflow.lastGreenAt)}</p>
      <p className="mono" data-testid="deeplink">{workflow.link}</p>
      <p className="mono" data-testid="import-link">{workflow.importLink}</p>
      <h2>Domains</h2>
      <div className="chips" data-testid="domains">
        {workflow.domains.map((domain) => <span className="chip" key={domain}>{domain}</span>)}
        {workflow.domains.length ? null : <span className="chip">No network calls</span>}
      </div>
      <div className="card">
        <h2>Install</h2>
        <p className="muted">Shortcuts-style setup stays on your machine. The button shows the link this Mac opens.</p>
        <InstallButton link={workflow.link} />
      </div>
      <h2>Steps</h2>
      <ol className="film">
        {workflow.shots.map((shot) => (
          <li key={shot.stepId}>
            <img src={shot.url} alt="" />
            <span>{steps.find((step) => step.id === shot.stepId)?.label || shot.stepId}</span>
          </li>
        ))}
      </ol>
      <p className="muted">The first picture is the redacted crop of the first step that is not a secret. Password fields are covered before it leaves the device.</p>
      <ol className="steps">
        {steps.map((step) => <li key={step.id}>{step.label}</li>)}
      </ol>
      <h2>Setup questions</h2>
      <ol className="steps" data-testid="setup-questions">
        {workflow.questions.map((question) => <li key={question.name}>{question.prompt}</li>)}
      </ol>
      <h2>Inputs</h2>
      {user ? (
        <SetupForm action={`/api/marketplace/${workflow.id}/fork`} questions={workflow.questions} submit="Fork to my library" />
      ) : (
        <p><a href="/login">Sign in</a> to fork this and answer the setup questions.</p>
      )}
      <h2>Versions</h2>
      <ul>
        {workflow.versions.map((version) => (
          <li key={version.version}>v{version.version} · {when(version.created_at)}</li>
        ))}
      </ul>
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
