-- Each '-- statement' section is one SQLite statement, also used by local runtime tests.
-- statement
CREATE TABLE IF NOT EXISTS votes (
  voter_id TEXT PRIMARY KEY,
  choice TEXT NOT NULL CHECK (choice IN ('left', 'right')),
  ip_hash TEXT NOT NULL,
  applied_revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);
-- statement
CREATE INDEX IF NOT EXISTS votes_ip_time ON votes(ip_hash, created_at);
-- statement
CREATE TABLE IF NOT EXISTS totals (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  left_votes INTEGER NOT NULL DEFAULT 0,
  right_votes INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 0
);
-- statement
INSERT OR IGNORE INTO totals(id) VALUES (1);
-- statement
CREATE TRIGGER IF NOT EXISTS votes_ip_limit BEFORE INSERT ON votes
WHEN (SELECT COUNT(*) FROM votes WHERE ip_hash = NEW.ip_hash AND created_at >= unixepoch() - 3600) >= 10
BEGIN
  SELECT RAISE(ABORT, 'ip_hourly_limit');
END;
-- statement
CREATE TRIGGER IF NOT EXISTS votes_add_total AFTER INSERT ON votes
BEGIN
  UPDATE totals SET
    left_votes = left_votes + CASE WHEN NEW.choice = 'left' THEN 1 ELSE 0 END,
    right_votes = right_votes + CASE WHEN NEW.choice = 'right' THEN 1 ELSE 0 END,
    revision = revision + 1
  WHERE id = 1;
END;
-- statement
CREATE TRIGGER IF NOT EXISTS votes_remove_total AFTER DELETE ON votes
BEGIN
  UPDATE totals SET
    left_votes = left_votes - CASE WHEN OLD.choice = 'left' THEN 1 ELSE 0 END,
    right_votes = right_votes - CASE WHEN OLD.choice = 'right' THEN 1 ELSE 0 END,
    revision = revision + 1
  WHERE id = 1;
END;
-- statement
CREATE TRIGGER IF NOT EXISTS votes_immutable BEFORE UPDATE ON votes
BEGIN
  SELECT RAISE(ABORT, 'votes_are_immutable');
END;
