import { cookies } from "next/headers";
import { boot, userFromSession, type Principal, type User } from "./registry";

export { when } from "./time";

export async function viewer(): Promise<User | null> {
  await boot();
  const jar = await cookies();
  return userFromSession(jar.get("bao_session")?.value);
}

export async function principal(): Promise<Principal | null> {
  const user = await viewer();
  return user ? { userId: user.id } : null;
}

export function rate(pass: { passed: number; total: number }): string {
  if (!pass.total) return "No runs yet";
  return `${pass.passed}/${pass.total} passed`;
}
