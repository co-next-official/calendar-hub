// Web Push: message encryption (RFC 8291, aes128gcm) and VAPID auth (RFC 8292).
// WebCrypto only, so it runs on Workers. Encryption is deterministic when a salt
// and application-server key are injected, which the tests use to verify output.
import { base64url } from "../lib/crypto";
import type { Env } from "../env";

const te = new TextEncoder();

export function b64urlToBytes(value: string): Uint8Array {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

export type PushKeys = { p256dh: string; auth: string };

export type EncryptOptions = {
  /** Inject the 16-byte content-encoding salt (tests only). */
  salt?: Uint8Array;
  /** Inject the application-server ECDH key as a JWK + its raw public point (tests only). */
  asPrivateJwk?: JsonWebKey;
  asPublicRaw?: Uint8Array;
};

/** Encrypt `plaintext` for a push subscription per RFC 8291 (single aes128gcm record). */
export async function encryptWebPush(plaintext: string | Uint8Array, sub: PushKeys, opts: EncryptOptions = {}): Promise<Uint8Array> {
  const pt = typeof plaintext === "string" ? te.encode(plaintext) : plaintext;
  const uaPublic = b64urlToBytes(sub.p256dh); // 65-byte uncompressed point
  const authSecret = b64urlToBytes(sub.auth); // 16 bytes

  let asPrivate: CryptoKey;
  let asPublicRaw: Uint8Array;
  if (opts.asPrivateJwk && opts.asPublicRaw) {
    asPrivate = await crypto.subtle.importKey("jwk", opts.asPrivateJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"]);
    asPublicRaw = opts.asPublicRaw;
  } else {
    const kp = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    asPrivate = kp.privateKey;
    asPublicRaw = new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
  }

  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  // workers-types types the ECDH key field oddly; the runtime takes `public`.
  const ecdh = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey } as any, asPrivate, 256));

  // RFC 8291 §3.4: IKM = HKDF(auth, ecdh, "WebPush: info\0" || ua_public || as_public, 32)
  const keyInfo = concat(te.encode("WebPush: info\0"), uaPublic, asPublicRaw);
  const ikm = await hkdf(authSecret, ecdh, keyInfo, 32);

  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);

  const cekKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const record = concat(pt, new Uint8Array([0x02])); // single, last record: delimiter 0x02
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cekKey, record));

  // RFC 8188 header: salt(16) | rs(4, BE) | idlen(1) | keyid(as_public)
  const rs = 4096;
  const header = new Uint8Array(16 + 4 + 1 + asPublicRaw.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs, false);
  header[20] = asPublicRaw.length;
  header.set(asPublicRaw, 21);
  return concat(header, ciphertext);
}

async function importVapidPrivate(pkcs8B64url: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("pkcs8", b64urlToBytes(pkcs8B64url), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

/** One-time setup: generate a VAPID key pair. Returns base64url (public = raw point, private = PKCS8). */
export async function generateVapidKeys(): Promise<{ publicKey: string; privateKey: string }> {
  const kp = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey("raw", kp.publicKey)) as ArrayBuffer);
  const pk8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", kp.privateKey)) as ArrayBuffer);
  return { publicKey: base64url(pub), privateKey: base64url(pk8) };
}

/** VAPID `Authorization: vapid t=<jwt>, k=<public>` header for a push endpoint (RFC 8292). */
export async function vapidAuthHeader(endpoint: string, env: Env, nowMs: number = Date.now()): Promise<string> {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) throw new Error("VAPID keys are not set");
  const aud = new URL(endpoint).origin;
  const header = base64url(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = base64url(te.encode(JSON.stringify({
    aud,
    exp: Math.floor(nowMs / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT || "mailto:admin@example.com",
  })));
  const signingInput = `${header}.${payload}`;
  const key = await importVapidPrivate(env.VAPID_PRIVATE_KEY);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(signingInput)));
  return `vapid t=${signingInput}.${base64url(sig)}, k=${env.VAPID_PUBLIC_KEY}`;
}

export type PushResult = { ok: boolean; status: number; gone: boolean };

/** POST an encrypted payload to a push endpoint. `gone` (404/410) means the subscription should be removed. */
export async function sendWebPush(endpoint: string, sub: PushKeys, payload: string | Uint8Array, env: Env, ttlSeconds = 2419200): Promise<PushResult> {
  const body = await encryptWebPush(payload, sub);
  const auth = await vapidAuthHeader(endpoint, env);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: auth,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttlSeconds),
    },
    body,
  });
  return { ok: res.ok, status: res.status, gone: res.status === 404 || res.status === 410 };
}
