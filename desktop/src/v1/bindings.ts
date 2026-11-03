export const INPUT_BINDING = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g;
export const ROW_BINDING = /\{\{\s*row\.([A-Za-z][A-Za-z0-9_]*)\s*\}\}/g;
export const ROW_INDEX_BINDING = /\{\{\s*row_index\s*\}\}/g;

export function bindingTokens(text: unknown, names: ReadonlySet<string>, row = false): Set<string> {
  const tokens = new Set<string>();
  if (typeof text !== "string") return tokens;
  for (const match of text.matchAll(INPUT_BINDING)) {
    if (names.has(match[1]!) && !(row && match[1] === "row_index")) tokens.add(match[0]);
  }
  if (row) {
    for (const match of text.matchAll(ROW_BINDING)) tokens.add(match[0]);
    for (const match of text.matchAll(ROW_INDEX_BINDING)) tokens.add(match[0]);
  }
  return tokens;
}

export function onlyBindings(value: unknown, tokens: ReadonlySet<string>): boolean {
  if (typeof value !== "string" || !value) return false;
  let remaining = value;
  for (const token of tokens) remaining = remaining.split(token).join("");
  return remaining === "";
}
