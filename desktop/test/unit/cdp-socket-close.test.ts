import assert from "node:assert/strict";
import { createConnection, createServer, type AddressInfo, type Socket } from "node:net";
import test from "node:test";
import { CdpSocket } from "../../src/cdp-live/socket";
import { scaledMs } from "../runtime";

for (const mode of ["remote-end", "transport-error"] as const) {
  test(`raw CDP rejects pending commands and reports disconnect after ${mode}`, { timeout: scaledMs(5000) }, async () => {
    const server = createServer();
    let peer!: Socket;
    const connected = new Promise<void>(resolve => {
      server.once("connection", socket => { peer = socket; resolve(); });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const socket = createConnection({ host: "127.0.0.1", port: (server.address() as AddressInfo).port });
    await connected;
    const cdp = new CdpSocket(socket);
    try {
      const rejected = assert.rejects(cdp.send("Browser.getVersion"), /cdp closed/);
      if (mode === "remote-end") peer.end();
      else socket.destroy(new Error("fixture transport failure"));
      await cdp.disconnected;
      await rejected;
      assert.equal(cdp.isOpen, false);
      await assert.rejects(cdp.send("Browser.getVersion"), /cdp closed before/);
      cdp.close();
    } finally {
      cdp.close();
      peer.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
}
