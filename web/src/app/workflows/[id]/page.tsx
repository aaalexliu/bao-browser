import { notFound } from "next/navigation";
import { ShareMenu } from "@/app/share-menu";
import { HttpError, listRuns, listVersions, previewPublication, pull } from "@/lib/registry";
import { plainReplayReason } from "@/lib/review-gate";
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
  const [versions, runs, preview] = await Promise.all([
    listVersions(user, id),
    listRuns(user, id),
    previewPublication(user, id),
  ]);
  const doc = workflow.document as { name?: string; inputs?: { name: string; type: string; label?: string; askOnImport?: boolean }[]; steps?: { id: string; label?: string }[] };
  const steps = doc.steps ?? [];
  const drafts = versions.filter((version) => version.kind === "conflict");
  const draftDevices = [...new Set(drafts.map((version) => version.device_name).filter((name): name is string => Boolean(name)))];
  const conflictOn = drafts.length
    ? `Changed on ${workflow.deviceName || "The other Mac"} and ${draftDevices.join(" and ") || "This Mac"}`
    : "";
  const publishEnabled = preview.reviewed && !preview.gateStep;
  const publishWhy = publishEnabled
    ? ""
    : !preview.reviewed
      ? "Replay on a device before listing."
      : (plainReplayReason(String(preview.gateReason || "")) || "The clean replay did not pass.");
  return (
    <article>
      <h1>{doc.name || id}</h1>
      <div className="chips">
        <span className="chip">{workflow.category}</span>
        {workflow.verified ? <span className="badge">Verified author</span> : null}
        <span className="chip">{workflow.visibility}</span>
        {conflictOn ? <span className="badge conflict" data-testid="conflict-badge">Conflict</span> : null}
      </div>
      {conflictOn ? (
        <div className="notice" data-testid="conflict-state">
          <p data-testid="conflict-devices">{conflictOn}</p>
          <form className="row" action={`/api/workflows/${id}/conflict`} method="post">
            <button className="primary" type="submit" name="action" value="keep-mine" data-testid="keep-mine">Keep mine</button>
            <button type="submit" name="action" value="keep-theirs" data-testid="keep-theirs">Keep theirs</button>
            <button type="submit" name="action" value="keep-both" data-testid="keep-both">Keep both as a copy</button>
          </form>
        </div>
      ) : null}
      <p data-testid="last-green">Last replayed green: {when(workflow.lastGreenAt)}</p>
      <p>{rate(workflow.passRate)}</p>
      <div className="chips" data-testid="domains">
        {workflow.domains.map((domain) => <span className="chip" key={domain}>{domain}</span>)}
      </div>
      <ShareMenu
        link={workflow.link}
        publishHref={`/workflows/${id}/publish`}
        publishEnabled={publishEnabled}
        publishWhy={publishWhy}
        fileName={`${id}.json`}
        fileText={JSON.stringify(workflow.document, null, 2)}
        exportEnabled={steps.length > 0}
        exportWhy="This workflow has no steps to export."
      />
      <p className="row">
        <a className="button" href={`/workflows/${id}/publish`}>Preview what goes public</a>
      </p>
      {query.share ? (
        <p className="notice">Share link <a href={`/share/${query.share}`}>/share/{query.share}</a> ({query.permission}). Personal values were cleared from the shared copy.</p>
      ) : null}
      <h2>Steps</h2>
      {workflow.shots.length ? (
        <>
          <ol className="film" data-testid="step-crops">
            {workflow.shots.map((shot) => (
              <li key={shot.stepId}>
                <img src={shot.url} alt="" />
                <span>{steps.find((step) => step.id === shot.stepId)?.label || shot.stepId}</span>
              </li>
            ))}
          </ol>
          <p className="muted" data-testid="crop-caption">The picture is the element crop, with the control outlined.</p>
        </>
      ) : null}
      <ol className="steps">
        {steps.map((step) => <li key={step.id}>{step.label}</li>)}
      </ol>
      <h2>Inputs</h2>
      <form action={`/api/workflows/${id}/inputs`} method="post">
        <ul>
          {(doc.inputs ?? []).map((input) => (
            <li key={input.name}>
              <label>
                <input type="checkbox" name={`ask_${input.name}`} defaultChecked={input.askOnImport === true} />
                {" "}Ask on import · {input.label || input.name} · {input.type}
              </label>
            </li>
          ))}
        </ul>
        <button type="submit">Save import questions</button>
      </form>
      <h2>Versions</h2>
      <ul className="versions" data-testid="version-list">
        {versions.map((version) => (
          <li key={`${version.kind}-${version.version}`} data-kind={version.kind}>
            v{version.version}
            {version.kind === "conflict" ? <> <span className="badge conflict">Conflict</span></> : null}
            {version.heal ? " · heal" : ""}
            {version.device_name ? ` · ${version.device_name}` : ""}
            {` · ${when(version.created_at)}`}
          </li>
        ))}
      </ul>
      <h2>Runs</h2>
      <ul>
        {runs.map((run) => (
          <li key={run.id}>{run.status} · {when(run.at)} · {run.shots.length} element crop{run.shots.length === 1 ? "" : "s"}</li>
        ))}
      </ul>
      {runs.length ? null : <p className="muted">No runs pushed from a device yet.</p>}
    </article>
  );
}
