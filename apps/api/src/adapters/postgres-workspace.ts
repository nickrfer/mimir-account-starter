import type pg from 'pg';
import type { WorkspaceActor } from '../ports/workspace.js';
import { ApiError } from '../http/error.js';
export async function authorizeActor(client: pg.PoolClient, actor: WorkspaceActor): Promise<void> {
  const result = await client.query(`SELECT 1 FROM mimir.sessions s JOIN mimir.users u ON u.id=s.user_id
    JOIN mimir.workspaces w ON (w.id,w.owner_id)=(s.workspace_id,s.user_id)
    WHERE s.token_hash=$1 AND s.user_id=$2 AND s.workspace_id=$3 AND u.active
    AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp()`, [actor.tokenHash,actor.userId,actor.workspaceId]);
  if (!result.rowCount) throw new ApiError(401, 'AUTH_REQUIRED', 'Sessão ausente ou inválida');
}
export async function lockWorkspace(client: pg.PoolClient, actor: WorkspaceActor): Promise<number> {
  await authorizeActor(client,actor);
  const result = await client.query<{revision:number}>('SELECT revision FROM mimir.workspaces WHERE id=$1 AND owner_id=$2 FOR UPDATE',[actor.workspaceId,actor.userId]);
  if (!result.rows[0]) throw new ApiError(404,'NOT_FOUND','Objeto não encontrado');
  await authorizeActor(client,actor);
  return result.rows[0].revision;
}
