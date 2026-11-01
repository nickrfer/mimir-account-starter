import { createHash } from 'node:crypto';
import { AuthError } from './input.js';
interface Bucket { failures: number; inFlight: number; until: number }
export class LoginLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private active = 0;
  constructor(private readonly now: () => number = Date.now) {}
  reserve(email: string, ip: string): (failed: boolean | null) => void {
    const now = this.now();
    for (const [key, bucket] of this.buckets) if (bucket.until <= now && bucket.inFlight === 0) this.buckets.delete(key);
    const key = createHash('sha256').update(email).update('\0').update(ip).digest('hex');
    let bucket = this.buckets.get(key);
    if (bucket && bucket.failures + bucket.inFlight >= 5) {
      throw new AuthError(429, 'LOGIN_RATE_LIMITED', 'Limite de login atingido', Math.max(1, Math.ceil((bucket.until - now) / 1000)));
    }
    if (this.active >= 2) throw new AuthError(429, 'LOGIN_BUSY', 'Login temporariamente ocupado', 1);
    if (!bucket) {
      if (this.buckets.size >= 10000) throw new AuthError(429, 'LOGIN_RATE_LIMITED', 'Limite de login atingido', 900);
      bucket = { failures: 0, inFlight: 0, until: now + 900000 }; this.buckets.set(key, bucket);
    }
    bucket.inFlight++; this.active++;
    let released = false;
    return failed => {
      if (released) return;
      released = true;
      this.active--; bucket.inFlight--;
      if (failed === true) bucket.failures++;
      else if (bucket.inFlight === 0 && (failed === false || bucket.failures === 0)) this.buckets.delete(key);
    };
  }
}
