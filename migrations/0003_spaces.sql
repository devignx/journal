-- Spaces: named containers for entries (journal, philosophy, career, …).
-- Each user has one default space; every entry belongs to exactly one space.
CREATE TABLE IF NOT EXISTS spaces (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,
  name       TEXT NOT NULL COLLATE NOCASE,     -- case-insensitive per user
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, name)
);
CREATE INDEX IF NOT EXISTS idx_spaces_user ON spaces(user_id);

-- Entry ownership by space. DEFAULT 0 is a placeholder the backfill below replaces;
-- the app always sets space_id explicitly on insert.
ALTER TABLE entries ADD COLUMN space_id INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_entries_space ON entries(space_id, timestamp DESC);

-- Give every existing user a default "Journal" space…
INSERT INTO spaces (user_id, name, is_default)
  SELECT id, 'Journal', 1 FROM users;

-- …and move their existing entries into it.
UPDATE entries SET space_id = (
  SELECT s.id FROM spaces s WHERE s.user_id = entries.user_id AND s.is_default = 1
)
WHERE space_id = 0;
