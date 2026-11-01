import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { hashPassword } from '../../apps/api/dist/auth/passwords.js';
import { exactObject, normalizedEmail, text } from '../../apps/api/dist/auth/input.js';

export async function createOwner(value, databaseUrl = process.env.MIGRATION_DATABASE_URL) {
  const input = exactObject(value, ['email', 'displayName', 'companyName', 'password']);
  const email = normalizedEmail(input.email);
  const displayName = text(input.displayName, 1, 200).normalize('NFC').trim();
  const companyName = text(input.companyName, 1, 200).normalize('NFC').trim();
  if (!displayName || !companyName) throw new Error('Nome vazio');
  const passwordHash = await hashPassword(text(input.password, 15, 1024));
  const userId = randomUUID(), workspaceId = randomUUID();
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('BEGIN');
    await client.query('INSERT INTO mimir.users(id,email,display_name,password_hash) VALUES($1,$2,$3,$4)', [userId,email,displayName,passwordHash]);
    await client.query('INSERT INTO mimir.workspaces(id,owner_id,company_name) VALUES($1,$2,$3)', [workspaceId,userId,companyName]);
    await client.query('COMMIT');
    return { userId, workspaceId };
  } catch (error) { await client.query('ROLLBACK'); throw error; }
  finally { await client.end(); }
}
