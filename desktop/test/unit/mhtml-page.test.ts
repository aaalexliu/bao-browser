import assert from "node:assert/strict";
import test from "node:test";
import { mhtmlPage } from "../../src/app/mhtml-page";
import { ARCHIVE_PICTURE, sampleArchive } from "../support/mhtml";

function decoded(uri: string): string {
  return Buffer.from(uri.slice(uri.indexOf("base64,") + 7), "base64").toString("utf8");
}

test("an MHTML archive becomes one page that holds its stylesheets, pictures and frames, and names no other part", () => {
  const page = mhtmlPage(Buffer.from(sampleArchive()))!;
  assert.match(page, /<h1>October – Statement<\/h1>/, "quoted-printable UTF-8 reads back as text");
  assert.doesNotMatch(page, /cid:/);
  const sheets = [...page.matchAll(/<link rel="stylesheet" href="(data:text\/css;charset=utf-8;base64,[^"]+)"/g)].map((match) => decoded(match[1]!));
  assert.deepEqual(sheets, ["h1 { color: rgb(0, 200, 5); }", `body { background: url("data:image/png;base64,${ARCHIVE_PICTURE}"); }`]);
  assert.ok(page.includes(`<img src="data:image/png;base64,${ARCHIVE_PICTURE}">`));
  const frame = /<iframe src="(data:text\/html;charset=utf-8;base64,[^"]+)">/.exec(page)?.[1];
  assert.equal(decoded(frame!), "<html><body><p>Frame text</p></body></html>");
});

test("the page keeps a link whose address only starts like a stored part, and drops a <link> to the web", () => {
  const page = mhtmlPage(Buffer.from(sampleArchive()))!;
  assert.ok(page.includes(`<a href="https://broker.example/statements/2026-10">Open</a>`), "the frame's address https://broker.example/ is a prefix of this link");
  assert.doesNotMatch(page, /preconnect|fp\.broker\.example/);
  assert.ok(page.includes(`<img src="https://cdn.broker.example/not-kept.png">`), "a picture the archive does not hold keeps its address for the caller's policy to block");
});

test("a file that is not an archive of a page gives no page", () => {
  assert.equal(mhtmlPage(Buffer.from("From: <Saved by Blink>\r\n")), undefined);
  assert.equal(mhtmlPage(Buffer.from("not an archive")), undefined);
});
