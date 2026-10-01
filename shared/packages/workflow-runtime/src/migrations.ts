import type Database from "better-sqlite3";

export const WORKFLOW_SCHEMA_VERSION = 12;

const migrations: readonly { version: number; sql: string }[] = [{
  version: 1,
  sql: `
    CREATE TABLE workflow_runs (
      run_id TEXT PRIMARY KEY NOT NULL,
      session_id TEXT NOT NULL,
      target_json TEXT NOT NULL,
      active_target_key TEXT NOT NULL,
      workflow_id TEXT NOT NULL,
      workflow_version TEXT NOT NULL,
      frozen_definition_ref TEXT,
      frozen_definition_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'waiting_approval', 'waiting_decision', 'paused', 'retrying', 'memory_pending', 'completed', 'blocked', 'failed', 'rejected', 'cancelled')),
      current_node TEXT,
      revision_completed INTEGER NOT NULL DEFAULT 0 CHECK (revision_completed >= 0 AND revision_completed <= 10),
      revision_budget INTEGER NOT NULL CHECK (revision_budget >= 1 AND revision_budget <= 10),
      revision_hard_maximum INTEGER NOT NULL DEFAULT 10 CHECK (revision_hard_maximum = 10),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX workflow_runs_one_active_target
      ON workflow_runs(active_target_key)
      WHERE status NOT IN ('completed', 'blocked', 'failed', 'rejected', 'cancelled');

    CREATE TABLE workflow_steps (
      run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
      node_key TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      ui_group TEXT NOT NULL,
      ui_label TEXT NOT NULL,
      group_order INTEGER NOT NULL CHECK (group_order >= 0),
      status TEXT NOT NULL CHECK (status IN ('waiting', 'running', 'completed', 'retrying', 'blocked', 'failed', 'skipped', 'cancelled')),
      input_hash TEXT,
      output_hash TEXT,
      artifact_ref TEXT,
      summary TEXT,
      duration_ms INTEGER CHECK (duration_ms >= 0),
      error_category TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, node_key, attempt)
    );

    CREATE TABLE workflow_approvals (
      run_id TEXT PRIMARY KEY NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
      proposal_id TEXT NOT NULL,
      decision TEXT CHECK (decision IN ('approved', 'rejected')),
      decided_by TEXT,
      decided_at TEXT,
      resume_token_hash TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE workflow_artifacts (
      artifact_ref TEXT PRIMARY KEY NOT NULL,
      run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('frozen-definition', 'plan', 'candidate', 'review', 'memory', 'other')),
      relative_path TEXT NOT NULL UNIQUE,
      sha256 TEXT NOT NULL,
      byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
      status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'quarantined', 'deleted')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE workflow_idempotency (
      scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
      result_ref TEXT,
      completed INTEGER NOT NULL DEFAULT 1 CHECK (completed IN (0, 1)),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (scope, idempotency_key)
    );

    CREATE TABLE workflow_budget_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
      kind TEXT NOT NULL CHECK (kind IN ('initial', 'manual_extension', 'no_progress_recovery')),
      delta INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE workflow_change_sequence (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
      change_kind TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `,
}, {
  version: 2,
  sql: `
    CREATE UNIQUE INDEX workflow_artifacts_run_ref ON workflow_artifacts(run_id, artifact_ref);

    INSERT INTO workflow_change_sequence (run_id, change_kind, created_at)
      SELECT run_id, 'migration-artifact-invariant', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        FROM workflow_runs
        WHERE EXISTS (
          SELECT 1 FROM workflow_steps
            WHERE workflow_steps.run_id = workflow_runs.run_id
              AND workflow_steps.status = 'completed'
              AND (workflow_steps.artifact_ref IS NULL OR NOT EXISTS (
                SELECT 1 FROM workflow_artifacts
                  WHERE workflow_artifacts.run_id = workflow_steps.run_id
                    AND workflow_artifacts.artifact_ref = workflow_steps.artifact_ref
                    AND workflow_artifacts.status = 'ready'
              ))
        );
    UPDATE workflow_runs
      SET status = 'blocked', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE EXISTS (
        SELECT 1 FROM workflow_steps
          WHERE workflow_steps.run_id = workflow_runs.run_id
            AND workflow_steps.status = 'completed'
            AND (workflow_steps.artifact_ref IS NULL OR NOT EXISTS (
              SELECT 1 FROM workflow_artifacts
                WHERE workflow_artifacts.run_id = workflow_steps.run_id
                  AND workflow_artifacts.artifact_ref = workflow_steps.artifact_ref
                  AND workflow_artifacts.status = 'ready'
            ))
      );
    UPDATE workflow_steps
      SET status = CASE
            WHEN status = 'completed' AND (artifact_ref IS NULL OR NOT EXISTS (
              SELECT 1 FROM workflow_artifacts
                WHERE workflow_artifacts.run_id = workflow_steps.run_id
                  AND workflow_artifacts.artifact_ref = workflow_steps.artifact_ref
                  AND workflow_artifacts.status = 'ready'
            )) THEN 'blocked'
            ELSE status
          END,
          artifact_ref = CASE
            WHEN artifact_ref IS NULL OR EXISTS (
              SELECT 1 FROM workflow_artifacts
                WHERE workflow_artifacts.run_id = workflow_steps.run_id
                  AND workflow_artifacts.artifact_ref = workflow_steps.artifact_ref
            ) THEN artifact_ref
            ELSE NULL
          END
      WHERE (status = 'completed' AND (artifact_ref IS NULL OR NOT EXISTS (
          SELECT 1 FROM workflow_artifacts
            WHERE workflow_artifacts.run_id = workflow_steps.run_id
              AND workflow_artifacts.artifact_ref = workflow_steps.artifact_ref
              AND workflow_artifacts.status = 'ready'
        ))) OR (artifact_ref IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM workflow_artifacts
            WHERE workflow_artifacts.run_id = workflow_steps.run_id
              AND workflow_artifacts.artifact_ref = workflow_steps.artifact_ref
        ));

    CREATE TABLE workflow_steps_v2 (
      run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
      node_key TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt > 0),
      ui_group TEXT NOT NULL,
      ui_label TEXT NOT NULL,
      group_order INTEGER NOT NULL CHECK (group_order >= 0),
      status TEXT NOT NULL CHECK (status IN ('waiting', 'running', 'completed', 'retrying', 'blocked', 'failed', 'skipped', 'cancelled')),
      input_hash TEXT,
      output_hash TEXT,
      artifact_ref TEXT,
      summary TEXT,
      output TEXT,
      duration_ms INTEGER CHECK (duration_ms >= 0),
      error_category TEXT,
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, node_key, attempt),
      FOREIGN KEY (run_id, artifact_ref) REFERENCES workflow_artifacts(run_id, artifact_ref)
    );
    INSERT INTO workflow_steps_v2 (run_id, node_key, attempt, ui_group, ui_label, group_order, status, input_hash, output_hash, artifact_ref, summary, output, duration_ms, error_category, error_code, created_at, updated_at)
      SELECT run_id, node_key, attempt, ui_group, ui_label, group_order, status, input_hash, output_hash, artifact_ref, summary, NULL, duration_ms, error_category, error_code, created_at, updated_at FROM workflow_steps;
    DROP TABLE workflow_steps;
    ALTER TABLE workflow_steps_v2 RENAME TO workflow_steps;

    CREATE TRIGGER workflow_steps_completed_artifact_insert
      BEFORE INSERT ON workflow_steps
      WHEN NEW.status = 'completed' AND (NEW.artifact_ref IS NULL OR NOT EXISTS (
        SELECT 1 FROM workflow_artifacts WHERE run_id = NEW.run_id AND artifact_ref = NEW.artifact_ref AND status = 'ready'
      ))
      BEGIN
        SELECT RAISE(ABORT, 'completed workflow step requires a same-run ready artifact');
      END;
    CREATE TRIGGER workflow_steps_completed_artifact_update
      BEFORE UPDATE OF status, artifact_ref, run_id ON workflow_steps
      WHEN NEW.status = 'completed' AND (NEW.artifact_ref IS NULL OR NOT EXISTS (
        SELECT 1 FROM workflow_artifacts WHERE run_id = NEW.run_id AND artifact_ref = NEW.artifact_ref AND status = 'ready'
      ))
      BEGIN
        SELECT RAISE(ABORT, 'completed workflow step requires a same-run ready artifact');
      END;
  `,
}, {
  version: 3,
  sql: `
    INSERT INTO workflow_change_sequence (run_id, change_kind, created_at)
      SELECT run_id, 'migration-artifact-invariant', strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        FROM workflow_runs
        WHERE EXISTS (
          SELECT 1 FROM workflow_steps
            WHERE workflow_steps.run_id = workflow_runs.run_id
              AND workflow_steps.status = 'completed'
              AND (workflow_steps.artifact_ref IS NULL OR NOT EXISTS (
                SELECT 1 FROM workflow_artifacts
                  WHERE workflow_artifacts.run_id = workflow_steps.run_id
                    AND workflow_artifacts.artifact_ref = workflow_steps.artifact_ref
                    AND workflow_artifacts.status = 'ready'
              ))
        );
    UPDATE workflow_runs
      SET status = 'blocked', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE EXISTS (
        SELECT 1 FROM workflow_steps
          WHERE workflow_steps.run_id = workflow_runs.run_id
            AND workflow_steps.status = 'completed'
            AND (workflow_steps.artifact_ref IS NULL OR NOT EXISTS (
              SELECT 1 FROM workflow_artifacts
                WHERE workflow_artifacts.run_id = workflow_steps.run_id
                  AND workflow_artifacts.artifact_ref = workflow_steps.artifact_ref
                  AND workflow_artifacts.status = 'ready'
            ))
      );
    UPDATE workflow_steps
      SET status = CASE
            WHEN status = 'completed' AND (artifact_ref IS NULL OR NOT EXISTS (
              SELECT 1 FROM workflow_artifacts
                WHERE workflow_artifacts.run_id = workflow_steps.run_id
                  AND workflow_artifacts.artifact_ref = workflow_steps.artifact_ref
                  AND workflow_artifacts.status = 'ready'
            )) THEN 'blocked'
            ELSE status
          END,
          artifact_ref = CASE
            WHEN artifact_ref IS NULL OR EXISTS (
              SELECT 1 FROM workflow_artifacts
                WHERE workflow_artifacts.run_id = workflow_steps.run_id
                  AND workflow_artifacts.artifact_ref = workflow_steps.artifact_ref
            ) THEN artifact_ref
            ELSE NULL
          END
      WHERE (status = 'completed' AND (artifact_ref IS NULL OR NOT EXISTS (
          SELECT 1 FROM workflow_artifacts
            WHERE workflow_artifacts.run_id = workflow_steps.run_id
              AND workflow_artifacts.artifact_ref = workflow_steps.artifact_ref
              AND workflow_artifacts.status = 'ready'
        ))) OR (artifact_ref IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM workflow_artifacts
            WHERE workflow_artifacts.run_id = workflow_steps.run_id
              AND workflow_artifacts.artifact_ref = workflow_steps.artifact_ref
        ));

    CREATE TRIGGER workflow_artifacts_completed_step_update
      BEFORE UPDATE OF status ON workflow_artifacts
      WHEN OLD.status = 'ready' AND NEW.status <> 'ready' AND EXISTS (
        SELECT 1 FROM workflow_steps
          WHERE run_id = OLD.run_id
            AND artifact_ref = OLD.artifact_ref
            AND status = 'completed'
      )
      BEGIN
        SELECT RAISE(ABORT, 'ready artifact is referenced by a completed workflow step');
      END;
  `,
}, {
  version: 4,
  sql: `
    CREATE TABLE IF NOT EXISTS workflow_run_controls (
      run_id TEXT PRIMARY KEY NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
      pause_requested INTEGER NOT NULL DEFAULT 0 CHECK (pause_requested IN (0, 1)),
      cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1)),
      updated_at TEXT NOT NULL
    );
  `,
}, {
  version: 5,
  sql: `
    CREATE TABLE IF NOT EXISTS workflow_run_leases (
      run_id TEXT PRIMARY KEY NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
      owner_token TEXT NOT NULL,
      owner_pid INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      updated_at TEXT NOT NULL
    );
  `,
}, {
  version: 6,
  sql: `
    CREATE TABLE IF NOT EXISTS workflow_apply_reconciliations (
      run_id TEXT PRIMARY KEY NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
      proposal_id TEXT NOT NULL,
      candidate_hash TEXT,
      status TEXT NOT NULL CHECK (status IN ('applied', 'conflict')),
      applied_revision TEXT,
      result_ref TEXT NOT NULL,
      conflict_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (
        (status = 'applied' AND candidate_hash IS NOT NULL AND applied_revision IS NOT NULL AND conflict_code IS NULL)
        OR (status = 'conflict' AND applied_revision IS NULL AND conflict_code IS NOT NULL)
      ),
      FOREIGN KEY (run_id, result_ref) REFERENCES workflow_artifacts(run_id, artifact_ref)
    );
  `,
}, {
  version: 7,
  sql: "",
}, {
  version: 8,
  sql: "",
}, {
  version: 9,
  sql: `
    CREATE TABLE IF NOT EXISTS workflow_chapter_write_effects (
      run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
      node_id TEXT NOT NULL CHECK (node_id IN ('write', 'revise')),
      revision_round INTEGER NOT NULL CHECK (revision_round >= 0 AND revision_round <= 10),
      operation TEXT NOT NULL CHECK (operation IN ('create', 'replace')),
      status TEXT NOT NULL CHECK (status IN ('claimed', 'completed', 'conflict')),
      candidate_hash TEXT NOT NULL,
      candidate_ref TEXT NOT NULL,
      reserved_chapter_id TEXT,
      chapter_id TEXT,
      expected_revision TEXT,
      applied_revision TEXT,
      receipt_ref TEXT,
      conflict_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, node_id, revision_round),
      CHECK (
        (operation = 'create' AND reserved_chapter_id IS NOT NULL AND expected_revision IS NULL AND (
          (status IN ('claimed', 'conflict') AND chapter_id IS NULL)
          OR (status = 'completed' AND chapter_id = reserved_chapter_id)
        ))
        OR (operation = 'replace' AND reserved_chapter_id IS NULL AND chapter_id IS NOT NULL AND expected_revision IS NOT NULL)
      ),
      CHECK (
        (status = 'claimed' AND applied_revision IS NULL AND receipt_ref IS NULL AND conflict_code IS NULL)
        OR (status = 'completed' AND chapter_id IS NOT NULL AND applied_revision IS NOT NULL AND receipt_ref IS NOT NULL AND conflict_code IS NULL)
        OR (status = 'conflict' AND applied_revision IS NULL AND receipt_ref IS NULL AND conflict_code IS NOT NULL)
      )
    );
  `,
}, {
  version: 10,
  sql: `
    CREATE TABLE IF NOT EXISTS workflow_conversation_publications (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      publication_id TEXT NOT NULL UNIQUE,
      run_id TEXT NOT NULL REFERENCES workflow_runs(run_id),
      session_id TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      disposition TEXT NOT NULL DEFAULT 'pending' CHECK (disposition IN ('pending', 'delivered', 'superseded'))
    );
    CREATE INDEX IF NOT EXISTS workflow_conversation_publications_pending
      ON workflow_conversation_publications(session_id, disposition, sequence);
  `,
}, {
  version: 11,
  sql: `
    CREATE INDEX IF NOT EXISTS workflow_approvals_proposal_id
      ON workflow_approvals(proposal_id);
  `,
}, {
  version: 12,
  sql: `
    ALTER TABLE workflow_chapter_write_effects RENAME TO workflow_chapter_write_effects_v11;
    CREATE TABLE workflow_chapter_write_effects (
      run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
      node_id TEXT NOT NULL CHECK (node_id IN ('write', 'revise', 'continuity-revise', 'style-revise', 'ai-trace-revise')),
      revision_round INTEGER NOT NULL CHECK (revision_round >= 0 AND revision_round <= 10),
      operation TEXT NOT NULL CHECK (operation IN ('create', 'replace')),
      status TEXT NOT NULL CHECK (status IN ('claimed', 'completed', 'conflict')),
      candidate_hash TEXT NOT NULL,
      candidate_ref TEXT NOT NULL,
      reserved_chapter_id TEXT,
      chapter_id TEXT,
      expected_revision TEXT,
      applied_revision TEXT,
      receipt_ref TEXT,
      conflict_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (run_id, node_id, revision_round),
      CHECK (
        (operation = 'create' AND reserved_chapter_id IS NOT NULL AND expected_revision IS NULL AND (
          (status IN ('claimed', 'conflict') AND chapter_id IS NULL)
          OR (status = 'completed' AND chapter_id = reserved_chapter_id)
        ))
        OR (operation = 'replace' AND reserved_chapter_id IS NULL AND chapter_id IS NOT NULL AND expected_revision IS NOT NULL)
      ),
      CHECK (
        (status = 'claimed' AND applied_revision IS NULL AND receipt_ref IS NULL AND conflict_code IS NULL)
        OR (status = 'completed' AND chapter_id IS NOT NULL AND applied_revision IS NOT NULL AND receipt_ref IS NOT NULL AND conflict_code IS NULL)
        OR (status = 'conflict' AND applied_revision IS NULL AND receipt_ref IS NULL AND conflict_code IS NOT NULL)
      )
    );
    INSERT INTO workflow_chapter_write_effects
      SELECT * FROM workflow_chapter_write_effects_v11;
    DROP TABLE workflow_chapter_write_effects_v11;
  `,
}];

/** Applies each numbered product-table migration exactly once. */
export function migrateWorkflowDatabase(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS workflow_schema_migrations (
      version INTEGER PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const applied = database.prepare("SELECT version FROM workflow_schema_migrations WHERE version = ?");
  const record = database.prepare("INSERT INTO workflow_schema_migrations (version, applied_at) VALUES (?, ?)");
  for (const migration of migrations) {
    if (applied.get(migration.version)) continue;
    database.transaction(() => {
      if (applied.get(migration.version)) return;
      if (migration.version === 7) {
        const columns = database.prepare("PRAGMA table_info(workflow_runs)").all() as Array<{ name: string }>;
        if (!columns.some((column) => column.name === "frozen_request_ref")) database.exec("ALTER TABLE workflow_runs ADD COLUMN frozen_request_ref TEXT");
      } else if (migration.version === 8) {
        const columns = database.prepare("PRAGMA table_info(workflow_steps)").all() as Array<{ name: string }>;
        if (!columns.some((column) => column.name === "output")) database.exec("ALTER TABLE workflow_steps ADD COLUMN output TEXT");
      } else if (migration.version === 9) {
        const columns = database.prepare("PRAGMA table_info(workflow_runs)").all() as Array<{ name: string }>;
        if (!columns.some((column) => column.name === "chapter_write_mode")) {
          database.exec("ALTER TABLE workflow_runs ADD COLUMN chapter_write_mode TEXT NOT NULL DEFAULT 'candidate-only' CHECK (chapter_write_mode IN ('candidate-only', 'direct'))");
        }
        database.exec(migration.sql);
      } else database.exec(migration.sql);
      record.run(migration.version, new Date().toISOString());
    })();
  }
}
