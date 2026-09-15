import type { Database } from "bun:sqlite";

function tableColumns(db: Database, tableName: string): Set<string> {
  return new Set(
    (db.query(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>)
      .map((column) => column.name),
  );
}

export function migrateMeshPeerRoutes(db: Database): void {
  const workerColumns = tableColumns(db, "mesh_worker_registrations");
  if (!workerColumns.has("route_kind")) {
    db.run(
      "ALTER TABLE mesh_worker_registrations ADD COLUMN route_kind TEXT NOT NULL DEFAULT 'direct'",
    );
  }
  if (!workerColumns.has("relay_url")) {
    db.run("ALTER TABLE mesh_worker_registrations ADD COLUMN relay_url TEXT");
  }
  if (!workerColumns.has("relay_fingerprint")) {
    db.run("ALTER TABLE mesh_worker_registrations ADD COLUMN relay_fingerprint TEXT");
  }

  const grantColumns = tableColumns(db, "mesh_controller_grants");
  if (!grantColumns.has("controller_endpoint")) {
    db.run("ALTER TABLE mesh_controller_grants ADD COLUMN controller_endpoint TEXT");
  }
  if (!grantColumns.has("route_kind")) {
    db.run(
      "ALTER TABLE mesh_controller_grants ADD COLUMN route_kind TEXT NOT NULL DEFAULT 'direct'",
    );
  }
  if (!grantColumns.has("relay_url")) {
    db.run("ALTER TABLE mesh_controller_grants ADD COLUMN relay_url TEXT");
  }
  if (!grantColumns.has("relay_fingerprint")) {
    db.run("ALTER TABLE mesh_controller_grants ADD COLUMN relay_fingerprint TEXT");
  }
}
