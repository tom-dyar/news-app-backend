-- Log of pipeline runs, used to rate-limit who can start one (atomic claim, see src/runs.ts).
CREATE TABLE agent_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at  INTEGER NOT NULL, -- unix seconds
  source      TEXT    NOT NULL
);

CREATE INDEX idx_agent_runs_started ON agent_runs (started_at DESC);
