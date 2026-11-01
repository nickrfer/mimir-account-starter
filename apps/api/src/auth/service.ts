import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import type { AuthenticationPort, SessionContext } from '../ports/authentication.js';
import { AuthError } from './input.js';
import { hashPassword, supportedHash, verifyPassword } from './passwords.js';
import { LoginLimiter } from './limiter.js';

export const sessionHash = (token: string): string => createHash('sha256').update(token).digest('hex');
export class AuthenticationService {
  private constructor(private readonly persistence: AuthenticationPort, private readonly dummy: string,
    private readonly limiter: LoginLimiter) {}
  static async create(persistence: AuthenticationPort, limiter = new LoginLimiter()): Promise<AuthenticationService> {
    return new AuthenticationService(persistence, await hashPassword(randomBytes(32).toString('hex')), limiter);
  }
  async login(email: string, password: string, ip: string, previousToken: string | null): Promise<{ context: SessionContext; token: string }> {
    const release = this.limiter.reserve(email, ip);
    let failed: boolean | null = null;
    try {
      const identity = await this.persistence.findIdentity(email);
      const usable = identity?.active && supportedHash(identity.passwordHash);
      const valid = await verifyPassword(usable ? identity.passwordHash : this.dummy, password);
      if (!identity || !usable || !valid) { failed = true; throw new AuthError(401, 'INVALID_CREDENTIALS', 'Credenciais inválidas'); }
      const token = randomBytes(32).toString('hex'), csrf = randomBytes(32).toString('hex');
      const context = await this.persistence.createSession(identity.userId, previousToken ? sessionHash(previousToken) : null, sessionHash(token), csrf);
      if (!context) { failed = true; throw new AuthError(401, 'INVALID_CREDENTIALS', 'Credenciais inválidas'); }
      failed = false;
      return { context, token };
    } finally { release(failed); }
  }
  async session(token: string | null): Promise<SessionContext> {
    const context = token ? await this.persistence.session(sessionHash(token)) : null;
    if (!context) throw new AuthError(401, 'AUTH_REQUIRED', 'Sessão ausente ou inválida');
    return context;
  }
  async authorizeMutation(token: string | null, csrf: string | undefined): Promise<SessionContext> {
    const context = await this.session(token);
    if (!csrf || !/^[a-f0-9]{64}$/.test(csrf) || !timingSafeEqual(Buffer.from(csrf, 'hex'), Buffer.from(context.csrfToken, 'hex'))) {
      throw new AuthError(403, 'CSRF_INVALID', 'Proteção CSRF inválida');
    }
    return context;
  }
  async logout(token: string | null, csrf: string | undefined): Promise<void> {
    await this.authorizeMutation(token, csrf);
    await this.persistence.revoke(sessionHash(token!));
  }
}
