import { describe, expect, it } from "vitest";
import { base64url } from "../src/lib/crypto";
import { b64urlToBytes, encryptWebPush, generateVapidKeys, vapidAuthHeader } from "../src/reminders/push";
import type { Env } from "../src/env";

const te = new TextEncoder();
const td = new TextDecoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

// Independent UA-side decrypt (RFC 8291) used only to verify the encryptor round-trips.
async function decryptAsUa(body: Uint8Array, uaPrivate: CryptoKey, uaPublic: Uint8Array, authSecret: Uint8Array) {
  const salt = body.slice(0, 16);
  const idlen = body[20]!;
  const asPublic = body.slice(21, 21 + idlen);
  const ciphertext = body.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey } as any, uaPrivate, 256));
  const ikm = await hkdf(authSecret, ecdh, concat(te.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const cekKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const record = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, cekKey, ciphertext));
  let end = record.length; // strip trailing zero padding then the 0x02 delimiter
  while (end > 0 && record[end - 1] === 0x00) end--;
  expect(record[end - 1]).toBe(0x02);
  return { text: td.decode(record.slice(0, end - 1)), salt, asPublic };
}

async function makeUa() {
  const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  return { kp, pub, authSecret, sub: { p256dh: base64url(pub), auth: base64url(authSecret) } };
}

describe("encryptWebPush", () => {
  it("round-trips: the receiver decrypts exactly what was encrypted", async () => {
    const ua = await makeUa();
    const msg = "When I grow up, I want to be a watermelon";
    const body = await encryptWebPush(msg, ua.sub);
    const { text } = await decryptAsUa(body, ua.kp.privateKey, ua.pub, ua.authSecret);
    expect(text).toBe(msg);
  });

  it("writes a well-formed aes128gcm header (salt, keyid = application-server public key)", async () => {
    const ua = await makeUa();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const body = await encryptWebPush("hi", ua.sub, { salt });
    expect(Array.from(body.slice(0, 16))).toEqual(Array.from(salt)); // injected salt lands first
    expect(new DataView(body.buffer, body.byteOffset).getUint32(16, false)).toBe(4096); // record size
    expect(body[20]).toBe(65); // keyid length = uncompressed P-256 point
    const { text } = await decryptAsUa(body, ua.kp.privateKey, ua.pub, ua.authSecret);
    expect(text).toBe("hi");
  });

  it("produces a fresh ephemeral key (different ciphertext) each call", async () => {
    const ua = await makeUa();
    const a = await encryptWebPush("x", ua.sub);
    const b = await encryptWebPush("x", ua.sub);
    expect(base64url(a)).not.toBe(base64url(b));
  });
});

describe("VAPID auth", () => {
  it("signs a JWT that verifies against the generated public key", async () => {
    const { publicKey, privateKey } = await generateVapidKeys();
    const env = { VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey, VAPID_SUBJECT: "mailto:test@example.com" } as Env;
    const now = 1_793_000_000_000;
    const header = await vapidAuthHeader("https://push.example.com/send/abc?x=1", env, now);

    const m = /^vapid t=([^,]+), k=(.+)$/.exec(header);
    expect(m).not.toBeNull();
    const [, jwt, k] = m!;
    expect(k).toBe(publicKey);

    const [h, p, s] = jwt!.split(".");
    const pub = await crypto.subtle.importKey("raw", b64urlToBytes(publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, pub, b64urlToBytes(s!), te.encode(`${h}.${p}`));
    expect(valid).toBe(true);

    const payload = JSON.parse(td.decode(b64urlToBytes(p!)));
    expect(payload.aud).toBe("https://push.example.com");
    expect(payload.sub).toBe("mailto:test@example.com");
    expect(payload.exp).toBe(Math.floor(now / 1000) + 12 * 3600);
  });
});
