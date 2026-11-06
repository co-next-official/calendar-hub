// AES-256-GCM for secrets at rest (Google OAuth tokens). Key: 32 random bytes, base64, in GOOGLE_TOKEN_KEY.
import { base64url } from "./crypto";

function fromB64(value: string): Uint8Array {
  const b64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function importKey(keyB64: string | undefined): Promise<CryptoKey> {
  if (!keyB64) throw new Error("GOOGLE_TOKEN_KEY is not set");
  const raw = fromB64(keyB64.trim());
  if (raw.length !== 32) throw new Error("GOOGLE_TOKEN_KEY must be 32 bytes (base64)");
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function seal(plaintext: string, keyB64: string | undefined): Promise<string> {
  const key = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return `v1.${base64url(iv)}.${base64url(ct)}`;
}

export async function open(sealed: string, keyB64: string | undefined): Promise<string> {
  const [version, iv, ct] = sealed.split(".");
  if (version !== "v1" || !iv || !ct) throw new Error("unknown sealed format");
  const key = await importKey(keyB64);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromB64(iv) }, key, fromB64(ct));
  return new TextDecoder().decode(pt);
}
