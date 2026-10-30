// A self-signed certificate for the Instacart fixture, built in memory.
// Node can sign but cannot write an X.509 certificate, so this encodes the
// DER by hand. No openssl binary, no file on disk, a fresh key every run.

import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

export interface FixtureCert {
  /** PEM private key for the HTTPS server. */
  key: string;
  /** PEM certificate for the HTTPS server. */
  cert: string;
  /** base64(sha256(SubjectPublicKeyInfo)), the value Chrome's --ignore-certificate-errors-spki-list takes. */
  spki: string;
}

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let rest = n; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
}

const seq = (...parts: Buffer[]): Buffer => tlv(0x30, Buffer.concat(parts));
const set = (...parts: Buffer[]): Buffer => tlv(0x31, Buffer.concat(parts));
const octets = (content: Buffer): Buffer => tlv(0x04, content);
const bits = (content: Buffer): Buffer => tlv(0x03, Buffer.concat([Buffer.from([0]), content]));
const bool = (value: boolean): Buffer => tlv(0x01, Buffer.from([value ? 0xff : 0]));

function integer(value: Buffer): Buffer {
  let body = value;
  while (body.length > 1 && body[0] === 0 && (body[1] ?? 0) < 0x80) body = body.subarray(1);
  if ((body[0] ?? 0) >= 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return tlv(0x02, body);
}

function oid(dotted: string): Buffer {
  const [a = 0, b = 0, ...rest] = dotted.split(".").map(Number);
  const out = [40 * a + b];
  for (const arc of rest) {
    const chunk = [arc & 0x7f];
    for (let n = arc >>> 7; n > 0; n >>>= 7) chunk.unshift((n & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

function time(date: Date): Buffer {
  const iso = date.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  if (date.getUTCFullYear() < 2050) return tlv(0x17, Buffer.from(`${iso.slice(2)}Z`, "ascii"));
  return tlv(0x18, Buffer.from(`${iso}Z`, "ascii"));
}

function name(commonName: string): Buffer {
  return seq(set(seq(oid("2.5.4.3"), tlv(0x0c, Buffer.from(commonName, "utf8")))));
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return critical ? seq(oid(id), bool(true), octets(value)) : seq(oid(id), octets(value));
}

function pem(label: string, der: Buffer): string {
  const body = der.toString("base64").match(/.{1,64}/g)?.join("\n") ?? "";
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----\n`;
}

/** A P-256 leaf for the given host names, valid from yesterday for 30 days. */
export function selfSignedCert(hosts: readonly string[], now: Date = new Date()): FixtureCert {
  const first = hosts[0];
  if (!first) throw new Error("selfSignedCert needs at least one host");
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spkiDer = publicKey.export({ type: "spki", format: "der" });
  const ecdsaSha256 = seq(oid("1.2.840.10045.4.3.2"));
  const day = 24 * 60 * 60 * 1000;
  const sans = seq(...hosts.map((host) => tlv(0x82, Buffer.from(host, "ascii"))));
  const tbs = seq(
    tlv(0xa0, integer(Buffer.from([2]))),
    integer(Buffer.concat([Buffer.from([0x01]), randomBytes(15)])),
    ecdsaSha256,
    name(first),
    seq(time(new Date(now.getTime() - day)), time(new Date(now.getTime() + 30 * day))),
    name(first),
    spkiDer,
    tlv(0xa3, seq(
      extension("2.5.29.17", false, sans),
      extension("2.5.29.19", true, seq()),
      extension("2.5.29.15", true, tlv(0x03, Buffer.from([0x07, 0x80]))),
      extension("2.5.29.37", false, seq(oid("1.3.6.1.5.5.7.3.1"))),
    )),
  );
  const signature = sign("sha256", tbs, privateKey);
  const certDer = seq(tbs, ecdsaSha256, bits(signature));
  return {
    key: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    cert: pem("CERTIFICATE", certDer),
    spki: createHash("sha256").update(spkiDer).digest("base64"),
  };
}
