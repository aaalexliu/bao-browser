import { cursorPrintHeal, readCursorAccount } from "./cursor-account";
import { llmHealFromEnv, unavailableHeal, type HealProvider, type HealSource } from "./heal";

export async function healFromSource(
  source: HealSource | undefined,
  fallback: () => HealProvider | Promise<HealProvider>,
  secrets: string[] = [],
): Promise<HealProvider> {
  if (!source) return fallback();
  if (source.kind === "none") return unavailableHeal();
  if (source.kind === "api-key") {
    return llmHealFromEnv({
      ...process.env,
      OPENAI_API_KEY: source.provider === "openai" ? source.key : undefined,
      ANTHROPIC_API_KEY: source.provider === "anthropic" ? source.key : undefined,
    }, fetch, secrets);
  }
  await readCursorAccount();
  return cursorPrintHeal(process.env, secrets);
}
