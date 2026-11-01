export interface Account { id: string; name: string; accountType: 'PF' | 'PJ'; active: boolean }
import type { WorkspaceActor as AccountActor } from './workspace.js';
export type { AccountActor };
export interface CreateAccount { name: string; nameKey: string; accountType: 'PF' | 'PJ'; expectedRevision: number }
export interface AccountPage { limit: number; cursor: string | null }
export interface AccountsPort {
  create(actor: AccountActor, command: CreateAccount): Promise<{ account: Account; revision: number }>;
  list(actor: AccountActor, page: AccountPage): Promise<{ items: Account[]; nextCursor: string | null }>;
  close(): Promise<void>;
}
