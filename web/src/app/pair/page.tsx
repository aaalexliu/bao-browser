import { activePairCode, categoryCounts, listDevices } from "@/lib/registry";
import { principal } from "@/lib/viewer";

export const dynamic = "force-dynamic";

export default async function PairPage() {
  const user = await principal();
  if (!user) {
    return (
      <section>
        <h1>Devices</h1>
        <p>Sign in, then show a pairing code on this page. <a href="/login">Sign in</a></p>
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
      <p>On the Mac, run <span className="mono">bao sync pair CODE --server THIS_ORIGIN</span>. The device token stays in that Mac&apos;s sync file.</p>
      <div className="card">
        <h2>Pairing code</h2>
        {pair ? <p className="pair" data-testid="pair-code">{pair.code}</p> : <p>No active code.</p>}
        {pair ? <p className="muted">Expires {String(pair.expiresAt)}</p> : null}
        <form action="/api/pair" method="post">
          <button className="primary" type="submit">New code</button>
        </form>
      </div>
      <h2>Devices</h2>
      <ul data-testid="devices">
        {devices.map((device) => (
          <li key={device.id}>{device.name} <span className="muted">{String(device.created_at)}</span></li>
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
