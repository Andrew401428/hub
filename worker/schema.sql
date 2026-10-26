CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS docs_updated_at ON docs (updated_at);
