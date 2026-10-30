import { LoginForm } from "./login-form";

export const dynamic = "force-dynamic";

export default function LoginPage() {
  return (
    <section>
      <h1>Sign in</h1>
      <p>Use the owner email and the invite secret. On a local build, the GitHub stub still signs in.</p>
      <div className="card">
        <LoginForm />
        <p><a href="/api/auth/github">Continue with GitHub</a></p>
      </div>
    </section>
  );
}
