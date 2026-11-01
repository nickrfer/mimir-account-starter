import { hash, verify } from '@node-rs/argon2';
import type { Options } from '@node-rs/argon2';
// Library declares ambient const enums: numeric public values avoid runtime imports under verbatimModuleSyntax.
export const passwordPolicy: Options = { algorithm: 2, version: 1,
  memoryCost: 65536, timeCost: 3, parallelism: 1, outputLen: 32 };
export function hashPassword(password: string): Promise<string> { return hash(password, passwordPolicy); }
export async function verifyPassword(encoded: string, password: string): Promise<boolean> {
  // Only this installation's bounded PHC policy is accepted. Corrupt records cannot request arbitrary work.
  if (!/^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/.test(encoded)) return false;
  try { return await verify(encoded, password); } catch { return false; }
}
export function supportedHash(encoded: string): boolean {
  return /^\$argon2id\$v=19\$m=65536,t=3,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/.test(encoded);
}
