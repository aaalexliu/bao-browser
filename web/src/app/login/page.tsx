import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <section>
      <h1>Sign in</h1>
      <p>Use an email link, or the GitHub stub on this build.</p>
      <div className="card">
        <LoginForm />
        <p><a href="/api/auth/github">Continue with GitHub</a></p>
      </div>
    </section>
  );
}
