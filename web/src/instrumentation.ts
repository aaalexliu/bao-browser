export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { assertProductionAuth } = await import("./lib/owner");
  assertProductionAuth();
}
