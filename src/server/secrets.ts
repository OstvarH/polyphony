import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Encrypts API keys at rest with AES-256-GCM. The 32-byte master key lives next to the database
 * in a file only the current user can read. Keys never leave this machine except in requests to
 * the provider they belong to.
 */
export class SecretBox {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('the master key must be 32 bytes');
    this.#key = key;
  }

  static fromHome(home: string): SecretBox {
    const path = join(home, 'master.key');
    if (!existsSync(path)) {
      writeFileSync(path, randomBytes(32).toString('base64'), { mode: 0o600 });
    }
    try {
      chmodSync(path, 0o600);
    } catch {
      // Best effort: Windows has no POSIX modes; the user profile directory is private there.
    }
    return new SecretBox(Buffer.from(readFileSync(path, 'utf8').trim(), 'base64'));
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.#key, iv);
    const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64');
  }

  open(sealed: string): string {
    const raw = Buffer.from(sealed, 'base64');
    const decipher = createDecipheriv('aes-256-gcm', this.#key, raw.subarray(0, 12));
    decipher.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
  }
}

/** "sk-ant-abc...xyz" becomes "sk-a…xyz" for display. */
export function maskSecret(secret: string): string {
  if (secret.length <= 8) return '•'.repeat(secret.length);
  return `${secret.slice(0, 4)}…${secret.slice(-4)}`;
}
