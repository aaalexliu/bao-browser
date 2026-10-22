"use client";

import { useState, type FormEvent } from "react";

export function LoginForm() {
  const [email, setEmail] = useState("");
  const [verifyUrl, setVerifyUrl] = useState("");
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError("");
    const res = await fetch("/api/auth/magic", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });
    const body = await res.json() as { verifyUrl?: string; error?: string };
    if (!res.ok) {
      setError(body.error || "Could not send the link");
      return;
    }
    setVerifyUrl(body.verifyUrl || "");
  }

  return (
    <form onSubmit={submit}>
      <label>Email
        <input name="email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
      </label>
      <button className="primary" type="submit">Email me a link</button>
      {error ? <p className="notice">{error}</p> : null}
      {verifyUrl ? (
        <p className="notice">This build returns the link instead of sending mail. <a href={verifyUrl}>Open the sign-in link</a></p>
      ) : null}
    </form>
  );
}
