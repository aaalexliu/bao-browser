/** A small archive in the shape Chrome's `Page.captureSnapshot` writes: a page, two stylesheets, a picture and a frame. */
export const ARCHIVE_PICTURE = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

export function sampleArchive(): string {
  const boundary = "----MultipartBoundary--x1y2z3----";
  const part = (headers: string[], body: string) => [`--${boundary}`, ...headers, "", body].join("\r\n");
  return [
    "From: <Saved by Blink>",
    "Snapshot-Content-Location: https://broker.example/statements",
    "Subject: Statements",
    "MIME-Version: 1.0",
    "Content-Type: multipart/related;",
    "\ttype=\"text/html\";",
    `\tboundary="${boundary}"`,
    "",
    "",
    part(["Content-Type: text/html", "Content-ID: <frame-MAIN@mhtml.blink>", "Content-Transfer-Encoding: quoted-printable", "Content-Location: https://broker.example/statements"], [
      "<!DOCTYPE html><html><head><meta charset=3D\"UTF-8\"><link rel=3D\"preconnect\" href=3D\"https://fp.broker.exa=",
      "mple/\"><link rel=3D\"stylesheet\" href=3D\"cid:css-1@mhtml.blink\" /><link rel=3D\"stylesheet\" href=3D\"https:/=",
      "/cdn.broker.example/app.css?v=3D1&amp;m=3D2\"></head><body><div data-bao-overlay=3D\"\"></div>",
      "<h1>October =E2=80=93 Statement</h1><a href=3D\"https://broker.example/statements/2026-10\">Open</a>",
      "<img src=3D\"https://cdn.broker.example/logo.png\"><iframe src=3D\"cid:frame-CHILD@mhtml.blink\"></iframe>",
      "<img src=3D\"https://cdn.broker.example/not-kept.png\"></body></html>",
    ].join("\r\n")),
    part(["Content-Type: text/css", "Content-Transfer-Encoding: quoted-printable", "Content-Location: cid:css-1@mhtml.blink"], "h1 { color: rgb(0, 200, 5); }"),
    part(["Content-Type: text/css", "Content-Transfer-Encoding: quoted-printable", "Content-Location: https://cdn.broker.example/app.css?v=1&m=2"],
      "body { background: url(\"https://cdn.broker.example/logo.png\"); }"),
    part(["Content-Type: image/png", "Content-Transfer-Encoding: base64", "Content-Location: https://cdn.broker.example/logo.png"], ARCHIVE_PICTURE),
    part(["Content-Type: text/html", "Content-ID: <frame-CHILD@mhtml.blink>", "Content-Transfer-Encoding: quoted-printable", "Content-Location: https://broker.example/"],
      "<html><body><p>Frame text</p></body></html>"),
    `--${boundary}--`,
    "",
  ].join("\r\n");
}
