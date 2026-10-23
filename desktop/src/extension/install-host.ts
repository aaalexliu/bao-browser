// Per-user native host manifest. Chrome pins allowed_origins to this extension, so a page cannot open the pipe.

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";
import { EXTENSION_ID, NATIVE_HOST_NAME, extensionOrigin } from "./protocol";

export function nativeMessagingDirs(home: string): string[] {
  if (platform() === "darwin") {
    const lib = path.join(home, "Library", "Application Support");
    return [
      path.join(lib, "Google", "Chrome", "NativeMessagingHosts"),
      path.join(lib, "Chromium", "NativeMessagingHosts"),
    ];
  }
  const config = path.join(home, ".config");
  return [
    path.join(config, "google-chrome", "NativeMessagingHosts"),
    path.join(config, "google-chrome-beta", "NativeMessagingHosts"),
    path.join(config, "chromium", "NativeMessagingHosts"),
  ];
}

export function defaultConfigHome(): string {
  return homedir();
}

/**
 * Chrome looks up the host under the user config dir, not under an arbitrary
 * --user-data-dir. A proof that sets HOME also passes that home here, and
 * may pass the profile dir as an extra so both lookup paths are covered.
 */
export function installNativeHost(opts: {
  home: string;
  socketPath: string;
  tokenPath: string;
  hostScript: string;
  nodePath?: string;
  extensionId?: string;
  extraDirs?: string[];
}): { dirs: string[]; wrapper: string } {
  const nodePath = opts.nodePath || process.execPath;
  const extensionId = opts.extensionId || EXTENSION_ID;
  const dir = path.dirname(opts.socketPath);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const wrapper = path.join(dir, "bao-native-host.sh");
  const body = `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(opts.hostScript)} --socket ${shellQuote(opts.socketPath)} --token ${shellQuote(opts.tokenPath)} --extension-id ${shellQuote(extensionId)}\n`;
  writeFileSync(wrapper, body, { mode: 0o755 });
  chmodSync(wrapper, 0o755);
  const manifest = {
    name: NATIVE_HOST_NAME,
    description: "Bao desktop bridge",
    path: wrapper,
    type: "stdio",
    allowed_origins: [extensionOrigin(extensionId)],
  };
  const dirs = [...nativeMessagingDirs(opts.home), ...(opts.extraDirs || [])];
  for (const dest of dirs) {
    mkdirSync(dest, { recursive: true, mode: 0o755 });
    writeFileSync(path.join(dest, `${NATIVE_HOST_NAME}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
  }
  return { dirs, wrapper };
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
