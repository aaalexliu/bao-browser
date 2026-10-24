// Renders an import failure. Does not decide whether the import succeeded.

import type { ImportLoginError } from "../v1/import-login-error";

const KNOWN: Record<string, ImportLoginError> = {
  "keychain prompt was not approved": {
    code: "keychain_denied",
    cause: "You clicked Deny on the Keychain prompt.",
    hint: "Try again and click Allow. Bao does not save that key.",
  },
  "could not decrypt cookies": {
    code: "decrypt_failed",
    cause: "The Safe Storage key did not decrypt these cookies.",
    hint: "Try the import again. The detail line is the scrubbed error, not the cookies.",
  },
  "could not import cookies": {
    code: "inject_failed",
    cause: "Bao could not inject the cookies into the owned browser.",
    hint: "Retry the import. Cookie values are not written into the window.",
  },
  "Chrome cookies database was not found for that profile": {
    code: "no_cookies_for_site",
    cause: "Chrome has no cookie database for that profile.",
    hint: "Sign in to the site in Chrome, or pick another profile.",
  },
  "Chrome has no profiles": {
    code: "no_profiles",
    cause: "Chrome has no profiles.",
    hint: "Open Chrome once so it creates a profile, then retry.",
  },
  "Chrome import is only available on macOS": {
    code: "not_macos",
    cause: "Chrome import only runs on macOS.",
    hint: "Run the import on the Mac that has the Chrome profile.",
  },
  "domain must be a hostname like experian.com": {
    code: "bad_domain",
    cause: "The domain is not a hostname.",
    hint: "Use a host like experian.com, with no path and no scheme.",
  },
  "bad profile": {
    code: "bad_profile",
    cause: "That Chrome profile name is not usable.",
    hint: "Pick one of the profiles listed in the window.",
  },
  "cookies database path is not a Cookies file": {
    code: "cookie_db_locked",
    cause: "Chrome's cookie file could not be copied.",
    hint: "Quit Chrome and retry. A locked database is the usual reason.",
  },
  "import failed": {
    code: "import_failed",
    cause: "The import stopped before any cookies were copied.",
    hint: "Retry. If it fails again, the Mac-side error is the detail, and it must not include cookie values.",
  },
};

function structured(value: unknown): ImportLoginError | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Partial<ImportLoginError>;
  if (typeof row.code !== "string" || typeof row.cause !== "string" || typeof row.hint !== "string") return null;
  if (!row.code || !row.cause || !row.hint) return null;
  return {
    code: row.code,
    cause: row.cause,
    hint: row.hint,
    detail: typeof row.detail === "string" && row.detail ? row.detail : undefined,
  };
}

/** Accepts the structured object, or today's string from `safeImportError`. */
export function importErrorView(error: unknown): ImportLoginError {
  const direct = structured(error);
  if (direct) return direct;
  const text = typeof error === "string" ? error.trim() : "";
  if (text && KNOWN[text]) return KNOWN[text];
  if (text) {
    return {
      code: "import_failed",
      cause: text,
      hint: "Retry the import. Bao does not read a site other than the one you named.",
    };
  }
  return KNOWN["import failed"]!;
}
