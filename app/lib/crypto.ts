import { fromBase64, randomToken, toBase64Url } from "./encoding";
import { getEnvironment } from "@/db/runtime";

function arrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function encryptionKey(): Promise<CryptoKey> {
  const configuredKey = getEnvironment().APP_ENCRYPTION_KEY;
  if (!configuredKey) {
    throw new Error("APP_ENCRYPTION_KEY is not configured.");
  }

  const keyBytes = fromBase64(configuredKey);
  if (keyBytes.byteLength !== 32) {
    throw new Error("APP_ENCRYPTION_KEY must decode to exactly 32 bytes.");
  }

  return crypto.subtle.importKey("raw", arrayBuffer(keyBytes), "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(value: string): Promise<string> {
  const iv = fromBase64(randomToken(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: arrayBuffer(iv) },
    await encryptionKey(),
    new TextEncoder().encode(value),
  );
  return `${toBase64Url(iv)}.${toBase64Url(new Uint8Array(encrypted))}`;
}

export async function decryptSecret(value: string): Promise<string> {
  const [ivValue, encryptedValue] = value.split(".");
  if (!ivValue || !encryptedValue) throw new Error("Stored credential is invalid.");

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: arrayBuffer(fromBase64(ivValue)) },
    await encryptionKey(),
    arrayBuffer(fromBase64(encryptedValue)),
  );
  return new TextDecoder().decode(decrypted);
}
