import type { CurrentUser, WebAppUserRole } from "@pablozaiden/webapp/contracts";
import { getDatabase } from "./database";

function toCurrentUser(row: { id: string; username: string; role: WebAppUserRole }): CurrentUser {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    isOwner: row.role === "owner",
    isAdmin: row.role === "owner" || row.role === "admin",
  };
}

export function listActiveUsers(): CurrentUser[] {
  const rows = getDatabase()
    .query(`
      SELECT id, username, role
      FROM webapp_users
      WHERE disabled_at IS NULL
      ORDER BY created_at ASC
    `)
    .all() as Array<{ id: string; username: string; role: WebAppUserRole }>;
  return rows.map(toCurrentUser);
}
