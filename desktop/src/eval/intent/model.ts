// Condense a trail with whatever model key is configured.
// Groq's edge rejects Node's default user agent, so this client sends a browser one.

export interface ModelInfo {
  provider: string;
  model: string;
  available: boolean;
  reason: string;
}

export interface ModelReply {
  text: string;
  tokens: number | null;
}

const GROQ_MODEL = "openai/gpt-oss-120b";
const XAI_MODEL = "grok-4.7";

function grokInfo(env: NodeJS.ProcessEnv): ModelInfo {
  const model = env.BAO_XAI_MODEL || XAI_MODEL;
  return {
    provider: "grok",
    model,
    available: true,
    reason: `XAI_API_KEY set, model ${model}`,
  };
}

export function configuredModel(env: NodeJS.ProcessEnv = process.env): ModelInfo {
  if (env.GROQ_API_KEY) {
    return {
      provider: "groq",
      model: env.BAO_GROQ_MODEL || GROQ_MODEL,
      available: true,
      reason: `GROQ_API_KEY set, model ${env.BAO_GROQ_MODEL || GROQ_MODEL}`,
    };
  }
  if (env.OPENAI_API_KEY) {
    return {
      provider: "openai",
      model: env.BAO_OPENAI_MODEL || "gpt-4.1-mini",
      available: true,
      reason: "OPENAI_API_KEY set",
    };
  }
  if (env.ANTHROPIC_API_KEY) {
    return {
      provider: "anthropic",
      model: env.BAO_ANTHROPIC_MODEL || "claude-sonnet-4-5",
      available: true,
      reason: "ANTHROPIC_API_KEY set",
    };
  }
  if (env.XAI_API_KEY) return grokInfo(env);
  return {
    provider: "none",
    model: "",
    available: false,
    reason: "XAI_API_KEY, GROQ_API_KEY, OPENAI_API_KEY, and ANTHROPIC_API_KEY are unset",
  };
}

/** Vendor fallback after the Cursor account. Grok, then Groq, OpenAI, and Anthropic. */
export function saveModel(env: NodeJS.ProcessEnv = process.env): ModelInfo {
  if (env.XAI_API_KEY) return grokInfo(env);
  return configuredModel(env);
}

export async function complete(prompt: string, env: NodeJS.ProcessEnv = process.env): Promise<ModelReply> {
  return completeFor(configuredModel(env), prompt, env);
}

export async function completeFor(info: ModelInfo, prompt: string, env: NodeJS.ProcessEnv = process.env): Promise<ModelReply> {
  if (!info.available) throw new Error(info.reason);
  if (info.provider === "grok") return chat("https://api.x.ai/v1/chat/completions", env.XAI_API_KEY || "", info.model, prompt);
  if (info.provider === "groq") return chat("https://api.groq.com/openai/v1/chat/completions", env.GROQ_API_KEY || "", info.model, prompt);
  if (info.provider === "openai") return chat("https://api.openai.com/v1/chat/completions", env.OPENAI_API_KEY || "", info.model, prompt);
  return anthropic(env.ANTHROPIC_API_KEY || "", info.model, prompt);
}

async function chat(url: string, key: string, model: string, prompt: string): Promise<ModelReply> {
  let last = "";
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
        "user-agent": "Mozilla/5.0",
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 4096,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    const raw = await res.text();
    if (res.status === 429 || res.status >= 500) {
      last = raw.slice(0, 200);
      await new Promise((resolve) => setTimeout(resolve, 800 * (attempt + 1)));
      continue;
    }
    if (!res.ok) throw new Error(`${url} ${res.status} ${raw.slice(0, 300)}`);
    const data = JSON.parse(raw) as {
      usage?: { total_tokens?: number };
      choices?: { message?: { content?: string; reasoning?: string } }[];
    };
    const message = data.choices?.[0]?.message;
    return {
      text: message?.content?.trim() || message?.reasoning || "",
      tokens: data.usage?.total_tokens ?? null,
    };
  }
  throw new Error(`${url} retries exhausted ${last}`);
}

async function anthropic(key: string, model: string, prompt: string): Promise<ModelReply> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`anthropic ${res.status} ${raw.slice(0, 300)}`);
  const data = JSON.parse(raw) as {
    usage?: { input_tokens?: number; output_tokens?: number };
    content?: { text?: string }[];
  };
  const tokens = data.usage ? (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0) : null;
  return { text: data.content?.map((block) => block.text || "").join("\n") || "", tokens };
}

export function parseDecision(text: string): { keep: string[]; human: { id: string; gate: "login" | "confirm" }[]; secrets: string[] } {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("model did not return JSON");
  const parsed = JSON.parse(text.slice(start, end + 1)) as {
    keep?: unknown;
    human?: unknown;
    secrets?: unknown;
  };
  const keep = Array.isArray(parsed.keep) ? parsed.keep.filter((id): id is string => typeof id === "string") : [];
  const human = Array.isArray(parsed.human)
    ? parsed.human.flatMap((item) => {
      if (!item || typeof item !== "object") return [];
      const row = item as { id?: unknown; gate?: unknown };
      if (typeof row.id !== "string") return [];
      if (row.gate !== "login" && row.gate !== "confirm") return [];
      const gate: "login" | "confirm" = row.gate;
      return [{ id: row.id, gate }];
    })
    : [];
  const secrets = Array.isArray(parsed.secrets) ? parsed.secrets.filter((id): id is string => typeof id === "string") : [];
  return { keep, human, secrets };
}

export function parseFlagMap(text: string): Record<string, boolean> {
  const parsed = extractObject(text);
  const nested = parsed.scores;
  const source = nested && typeof nested === "object" ? nested as Record<string, unknown> : parsed;
  const out: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(source)) {
    if (typeof value === "boolean") out[key] = value;
    else if (value === "true" || value === "false") out[key] = value === "true";
  }
  return out;
}

export function parseCaseJudge(text: string): { summary: boolean; steps: Record<string, boolean> } {
  const parsed = extractObject(text);
  const summary = parsed.summary === true || parsed.summary === "true";
  const steps = parsed.steps && typeof parsed.steps === "object"
    ? parseFlagMap(JSON.stringify(parsed.steps))
    : {};
  return { summary, steps };
}

function extractObject(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("model did not return JSON");
  const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("model JSON is not an object");
  return parsed as Record<string, unknown>;
}
