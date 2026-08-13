import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const VERSION = 'v1';

export class TokenCipher {
  private readonly key: Buffer;

  constructor(secret: string) {
    if (secret.length < 32) throw new Error('TWITCH_TOKEN_ENCRYPTION_KEY must contain at least 32 characters');
    this.key = createHash('sha256').update(secret, 'utf8').digest();
  }

  encrypt(plaintext: string, context: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(context, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ciphertext.toString('base64url')].join('.');
  }

  decrypt(value: string, context: string): string {
    const [version, encodedIv, encodedTag, encodedCiphertext, extra] = value.split('.');
    if (version !== VERSION || !encodedIv || !encodedTag || encodedCiphertext === undefined || extra !== undefined) {
      throw new Error('Stored Twitch credential has an unsupported encryption format');
    }
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(encodedIv, 'base64url'));
      decipher.setAAD(Buffer.from(context, 'utf8'));
      decipher.setAuthTag(Buffer.from(encodedTag, 'base64url'));
      return Buffer.concat([
        decipher.update(Buffer.from(encodedCiphertext, 'base64url')),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      throw new Error('Stored Twitch credential could not be decrypted');
    }
  }
}
