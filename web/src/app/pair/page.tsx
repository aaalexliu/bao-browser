import { workflowCountLabel } from "@/lib/listing";
import { activePairCode, categoryCounts, listDevices } from "@/lib/registry";
import { principal, when } from "@/lib/viewer";

export const dynamic = "force-dynamic";

export default async function PairPage() {
  const user = await principal();
  if (!user) {
    return (
      <section>
        <h1>Devices</h1>
        <p>Sign in for a pairing code, then type it in the Mac app under Settings &gt; Sync. <a href="/login">Sign in</a></p>
      </section>
    );
  }
  const [pair, devices, categories] = await Promise.all([
    activePairCode(user.userId),
    listDevices(user.userId),
    categoryCounts(user.userId),
  ]);
  return (
    <section>
      <h1>Devices</h1>
      <p>Type this code in the Mac app, under Settings &gt; Sync.</p>
      <div className="card">
        <h2>Pairing code</h2>
        {pair ? <p className="pair" data-testid="pair-code">{pair.code}</p> : <p>No active code.</p>}
        {pair ? <p className="muted">Expires {when(pair.expiresAt)}</p> : null}
        <form action="/api/pair" method="post">
          <button className="primary" type="submit">New code</button>
        </form>
      </div>
      <p className="pair-hint" data-testid="pair-cli">Or from the command line: <span className="mono">bao sync pair CODE --server THIS_ORIGIN --secret SECRET</span>. Paste the invite secret once. The device token stays in that Mac&apos;s sync file.</p>
      <h2>Paired Macs</h2>
      <ul className="devices" data-testid="devices">
        {devices.map((device) => (
          <li className="device" key={device.id} data-testid="device">
            <div>
              <strong>{device.name}</strong>
              <p className="meta" data-testid="device-synced">
                Last synced {device.last_synced_at ? when(device.last_synced_at) : "Not synced yet"}
              </p>
              <p className="meta" data-testid="device-workflows">{workflowCountLabel(device.workflow_count)}</p>
            </div>
            <form action={`/api/devices/${encodeURIComponent(device.id)}/unpair`} method="post">
              <button type="submit" data-testid="unpair">Unpair</button>
            </form>
          </li>
        ))}
      </ul>
      {devices.length ? null : <p>No devices paired yet.</p>}
      <h2>Items by category</h2>
      <ul data-testid="categories">
        {categories.map((row) => (
          <li key={row.category}>{row.category} <strong>{Number(row.count)}</strong></li>
        ))}
      </ul>
      {categories.length ? null : <p>No synced workflows yet.</p>}
    </section>
  );
}
