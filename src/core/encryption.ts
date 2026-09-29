import crypto from "node:crypto";

export function encrypt(text: string, encryptionKey: string): string {
  const hashedKey = crypto.createHash("sha256").update(encryptionKey).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", hashedKey, iv);
  const encrypted = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `gcm:v1:${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function encryptBuffer(value: Buffer, encryptionKey: string): Buffer {
  const key = crypto.createHash("sha256").update(encryptionKey).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([Buffer.from([1]), iv, cipher.getAuthTag(), encrypted]);
}

export function decryptBuffer(value: Buffer, encryptionKey: string): Buffer {
  try {
    if (value.length < 29 || value[0] !== 1) throw new Error("Malformed encrypted binary value");
    const key = crypto.createHash("sha256").update(encryptionKey).digest();
    const iv = value.subarray(1, 13);
    const tag = value.subarray(13, 29);
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(value.subarray(29)), decipher.final()]);
  } catch {
    throw new Error("Decryption failed");
  }
}

export function decrypt(encryptedText: string, encryptionKey: string): string {
  if (encryptedText.startsWith("gcm:v1:")) {
    try {
      const [, , ivText, tagText, ciphertext] = encryptedText.split(":");
      if (!ivText || !tagText || ciphertext === undefined) throw new Error("Malformed encrypted record");
      const key = crypto.createHash("sha256").update(encryptionKey).digest();
      const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivText, "hex"));
      decipher.setAuthTag(Buffer.from(tagText, "hex"));
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, "hex")), decipher.final()]).toString("utf8");
    } catch {
      throw new Error("Decryption failed");
    }
  }
  const hexRegex = /^[0-9a-fA-F]{32}:[0-9a-fA-F]+$/;
  if (!hexRegex.test(encryptedText)) return encryptedText;
  try {
    const [ivText, ciphertext] = encryptedText.split(":");
    const hashedKey = crypto.createHash("sha256").update(encryptionKey).digest();
    const decipher = crypto.createDecipheriv("aes-256-cbc", hashedKey, Buffer.from(ivText, "hex"));
    return decipher.update(ciphertext, "hex", "utf8") + decipher.final("utf8");
  } catch {
    throw new Error("Decryption failed");
  }
}
import { Buffer } from "node:buffer";

