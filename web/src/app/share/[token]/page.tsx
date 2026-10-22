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
      <h1>Set this up</h1>
      <p>{doc.name || share.workflowId}</p>
      <p className="notice">Personal values were cleared from this copy. Secrets are not in it. Answers you type here become defaults on your own workflow, and an email or other personal value is dropped.</p>
      <div className="chips" data-testid="domains">
        {share.domains.map((domain) => <span className="chip" key={domain}>{domain}</span>)}
      </div>
      <p className="mono">{share.link}</p>
      <ol className="steps">
        {(doc.steps ?? []).map((step, index) => <li key={index}>{step.label}</li>)}
      </ol>
      {share.permission === "fork" && user ? (
        <SetupForm action={`/api/share/${token}/install`} questions={share.questions} submit="Install" />
      ) : null}
      {share.permission === "fork" && !user ? <p><a href="/login">Sign in</a> to answer the setup questions and install.</p> : null}
      {share.permission === "view" ? <p>This link is view only. You can see the steps. You cannot install a copy.</p> : null}
    </article>
  );
}
