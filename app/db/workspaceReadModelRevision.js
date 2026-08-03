export class ReadModelSourceUnstableError extends Error {
  constructor() {
    super("Read-model source is changing");
    this.name = "ReadModelSourceUnstableError";
  }
}

function revisionFromResult(result, { allowUnstable = false } = {}) {
  const row = result.rows[0];
  if (row?.source_stable === false && !allowUnstable) {
    throw new ReadModelSourceUnstableError();
  }
  const revision = row?.revision;
  return revision === undefined || revision === null
    ? null
    : String(revision);
}

export async function getWorkspaceReadModelRevision(db, workspaceId) {
  const result = await db.query(
    `
      SELECT
        revision,
        NOT EXISTS (
          SELECT 1
          FROM workspace_read_model_active_syncs active_sync
          WHERE active_sync.workspace_id = revision_row.workspace_id
        ) AS source_stable
      FROM workspace_read_model_revisions revision_row
      WHERE revision_row.workspace_id = $1
    `,
    [workspaceId],
  );
  return revisionFromResult(result);
}

export async function ensureWorkspaceReadModelRevision(
  db,
  workspaceId,
) {
  const current = await getWorkspaceReadModelRevision(db, workspaceId);
  if (current !== null) return current;

  const inserted = await db.query(
    `
      INSERT INTO workspace_read_model_revisions (workspace_id)
      VALUES ($1)
      ON CONFLICT (workspace_id) DO NOTHING
      RETURNING revision
    `,
    [workspaceId],
  );
  const created = revisionFromResult(inserted);
  if (created !== null) return created;

  const concurrent = await getWorkspaceReadModelRevision(db, workspaceId);
  if (concurrent !== null) return concurrent;
  throw new Error(
    `Failed to ensure read-model revision for workspace ${workspaceId}`,
  );
}

export async function bumpWorkspaceReadModelRevision(db, workspaceId) {
  const result = await db.query(
    `
      INSERT INTO workspace_read_model_revisions (
        workspace_id,
        revision,
        updated_at
      )
      VALUES ($1, 1, now())
      ON CONFLICT (workspace_id) DO UPDATE SET
        revision = workspace_read_model_revisions.revision + 1,
        updated_at = now()
      RETURNING revision
    `,
    [workspaceId],
  );
  const revision = revisionFromResult(result, { allowUnstable: true });
  if (revision !== null) return revision;
  throw new Error(
    `Failed to bump read-model revision for workspace ${workspaceId}`,
  );
}

export async function publishWorkspaceReadModelClock(
  db,
  workspaceId,
  clockToken,
) {
  if (
    typeof clockToken !== "string" ||
    !clockToken ||
    clockToken.length > 128
  ) {
    throw new TypeError("Read-model clock token is invalid");
  }
  const result = await db.query(
    `
      INSERT INTO workspace_read_model_revisions (
        workspace_id,
        revision,
        clock_token,
        updated_at
      )
      VALUES ($1, 1, $2, now())
      ON CONFLICT (workspace_id) DO UPDATE SET
        revision = CASE
          WHEN workspace_read_model_revisions.clock_token
            IS DISTINCT FROM EXCLUDED.clock_token
          THEN workspace_read_model_revisions.revision + 1
          ELSE workspace_read_model_revisions.revision
        END,
        clock_token = EXCLUDED.clock_token,
        updated_at = CASE
          WHEN workspace_read_model_revisions.clock_token
            IS DISTINCT FROM EXCLUDED.clock_token
          THEN now()
          ELSE workspace_read_model_revisions.updated_at
        END
      RETURNING revision
    `,
    [workspaceId, clockToken],
  );
  const revision = revisionFromResult(result, { allowUnstable: true });
  if (revision !== null) return revision;
  throw new Error(
    `Failed to publish read-model clock for workspace ${workspaceId}`,
  );
}

export async function markWorkspaceReadModelSourceUnstable(
  db,
  workspaceId,
  connectionId,
) {
  const result = await db.query(
    `
      WITH revision_row AS (
        INSERT INTO workspace_read_model_revisions (workspace_id)
        VALUES ($1)
        ON CONFLICT (workspace_id) DO UPDATE SET
          workspace_id = EXCLUDED.workspace_id
        RETURNING revision
      ), active_sync AS (
        INSERT INTO workspace_read_model_active_syncs (
          workspace_id,
          connection_id
        )
        SELECT $1, $2
        FROM revision_row
        ON CONFLICT (workspace_id, connection_id) DO NOTHING
        RETURNING connection_id
      )
      SELECT revision_row.revision, false AS source_stable
      FROM revision_row
      CROSS JOIN (
        SELECT count(*) AS inserted_count
        FROM active_sync
      ) active_sync_result
    `,
    [workspaceId, connectionId],
  );
  const revision = revisionFromResult(result, { allowUnstable: true });
  if (revision !== null) return revision;
  throw new Error(
    `Failed to mark read-model source unstable for workspace ${workspaceId}`,
  );
}

export async function publishStableWorkspaceReadModelRevision(
  db,
  workspaceId,
  connectionId,
) {
  const result = await db.query(
    `
      WITH settled_sync AS (
        DELETE FROM workspace_read_model_active_syncs
        WHERE workspace_id = $1
          AND connection_id = $2
        RETURNING connection_id
      ), published_revision AS (
        UPDATE workspace_read_model_revisions
        SET revision = workspace_read_model_revisions.revision + 1,
            updated_at = now()
        WHERE workspace_id = $1
          AND EXISTS (SELECT 1 FROM settled_sync)
        RETURNING revision
      )
      SELECT published_revision.revision
      FROM published_revision
      UNION ALL
      SELECT revision_row.revision
      FROM workspace_read_model_revisions revision_row
      WHERE revision_row.workspace_id = $1
        AND NOT EXISTS (SELECT 1 FROM published_revision)
      LIMIT 1
    `,
    [workspaceId, connectionId],
  );
  const revision = revisionFromResult(result, { allowUnstable: true });
  if (revision !== null) return revision;
  throw new Error(
    `Failed to publish stable read-model revision for workspace ${workspaceId}`,
  );
}
