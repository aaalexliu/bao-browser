import { notFound } from "next/navigation";
import { getShare, HttpError } from "@/lib/registry";
import { principal } from "@/lib/viewer";
import { SetupForm } from "../../setup-form";

export const dynamic = "force-dynamic";

export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const user = await principal();
  let share;
  try {
    share = await getShare(token);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) notFound();
    throw err;
  }
  const doc = share.document as { name?: string; steps?: { label?: string }[] };
  return (
    <article>
      <h1>Import</h1>
      <p>{doc.name || share.workflowId}</p>
      <p className="notice">Nothing is saved until you answer these. Personal values were cleared. An email or a file path typed here is dropped, and secrets are not stored.</p>
      <div className="chips" data-testid="domains">
        {share.domains.map((domain) => <span className="chip" key={domain}>{domain}</span>)}
      </div>
      <p className="mono" data-testid="deeplink">{share.link}</p>
      <p className="mono" data-testid="import-link">{share.importLink}</p>
      <section data-testid="import-sheet">
        <h2>Questions</h2>
        {share.permission === "fork" && user ? (
          <SetupForm action={`/api/share/${token}/install`} questions={share.questions} submit="Save" />
        ) : null}
        {share.permission === "fork" && !user ? <p><a href="/login">Sign in</a> to answer these questions. Nothing is saved until you do.</p> : null}
        {share.permission === "view" ? <p>This link is view only. You can see the questions. You cannot save a copy.</p> : null}
        {share.questions.length ? null : <p>This workflow has no import questions.</p>}
      </section>
      <section className="card" data-testid="step-preview">
        <h2>Steps</h2>
        <ol className="preview-steps">
          {(doc.steps ?? []).map((step, index) => (
            <li key={index}><span className="n">{index + 1}</span><span>{step.label}</span></li>
          ))}
        </ol>
      </section>
    </article>
  );
}
