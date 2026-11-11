import { appendFileSync } from "node:fs";

export default async function reporter(source) {
  const dest = process.env.BAO_TEST_FAILED_FILES;
  if (!dest) return;
  for await (const event of source) {
    if (event.type !== "test:fail" || !event.data) continue;
    appendFileSync(dest, `${JSON.stringify(event.data)}\n`);
  }
}
