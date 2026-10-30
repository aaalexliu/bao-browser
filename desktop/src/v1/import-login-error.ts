// Shape of a failed site-login import, as the window renders it.
// The Mac agent owns detection. It should put these fields on the pending
// import (or on `error` as an object). Cookie values do not belong here.
// `safeImportError` still returns a string; the window maps that string.

export interface ImportLoginError {
  code: string;
  /** What happened, in one sentence. */
  cause: string;
  /** What to do next. */
  hint: string;
  /** Scrubbed raw detail. Optional. Never a cookie value. */
  detail?: string;
}
