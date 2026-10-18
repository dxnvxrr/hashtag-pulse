import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function hmacSha256Base64(key: Buffer, input: string): string {
  return createHmac('sha256', key).update(input, 'utf8').digest('base64');
}

export function hmacSha256Hex(key: string | Buffer, input: string): string {
  return createHmac('sha256', key).update(input, 'utf8').digest('hex');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Constant-time comparison that does not leak length via early return timing. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** Random uint32 for PRNG seeds. */
export function randomUint32(): number {
  return randomBytes(4).readUInt32LE(0);
}
