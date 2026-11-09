import { createServer, type AddressInfo } from "node:net";

let trap: Promise<number> | undefined;

/**
 * A loopback port for fake Chrome endpoints, held by this process so no real Chrome can own it.
 * A connection means a mock fell through to a real socket, so it fails the test process.
 */
export function trapPort(): Promise<number> {
  trap ??= new Promise((resolve, reject) => {
    const server = createServer((socket) => {
      process.exitCode = 1;
      process.stderr.write("trap port: a test connected to a fake Chrome endpoint; a mock fell through to a real socket\n");
      socket.destroy();
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.unref();
      resolve((server.address() as AddressInfo).port);
    });
  });
  return trap;
}
