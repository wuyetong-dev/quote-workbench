CREATE TABLE IF NOT EXISTS rules_memory (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK(kind IN ('default','price')),
    match_json TEXT NOT NULL,
    value_json TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1)),
    revision INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rules_memory_enabled ON rules_memory(enabled,kind);
CREATE TABLE IF NOT EXISTS rules_memory_audit (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    body_json TEXT NOT NULL,
    changed_at TEXT NOT NULL
);
