export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertProductionAuth } = await import("./lib/owner");
  assertProductionAuth();
  const { setRelayBoot, installRelayUpgrade } = await import("./lib/relay");
  const { boot } = await import("./lib/registry");
  setRelayBoot(boot);
  installRelayUpgrade();
}
