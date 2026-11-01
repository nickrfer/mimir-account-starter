export interface SessionContext {
  userId: string;
  displayName: string;
  workspace: { workspaceId: string; companyName: string; currency: 'BRL' };
  revision: number;
  csrfToken: string;
}
export interface LoginIdentity { userId: string; passwordHash: string; active: boolean }
export interface AuthenticationPort {
  findIdentity(email: string): Promise<LoginIdentity | null>;
  createSession(userId: string, previousHash: string | null, tokenHash: string, csrfToken: string): Promise<SessionContext | null>;
  session(tokenHash: string): Promise<SessionContext | null>;
  revoke(tokenHash: string): Promise<void>;
  close(): Promise<void>;
}
