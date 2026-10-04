-- Requires votes.client_ip (0002). Does not delete or change existing votes.
CREATE INDEX IF NOT EXISTS votes_ip_created_at ON votes(client_ip, created_at);

CREATE TABLE IF NOT EXISTS ip_vote_blocks (
  client_ip TEXT PRIMARY KEY,
  blocked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reason TEXT NOT NULL DEFAULT 'hourly_vote_limit',
  votes_in_hour INTEGER NOT NULL
);

-- The guard and vote insertion run in the same SQLite transaction. RAISE(IGNORE)
-- preserves the block entry while skipping the eleventh vote and its tally trigger.
-- A retry of an existing ballot never consumes quota or creates a new block.
CREATE TRIGGER IF NOT EXISTS vote_ip_guard BEFORE INSERT ON votes
WHEN NEW.client_ip IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM votes WHERE voter_id = NEW.voter_id)
BEGIN
  INSERT OR IGNORE INTO ip_vote_blocks (client_ip, votes_in_hour)
    SELECT NEW.client_ip, COUNT(*) FROM votes
    WHERE client_ip = NEW.client_ip AND created_at > datetime('now', '-1 hour')
    HAVING COUNT(*) >= 10;
  SELECT RAISE(IGNORE) WHERE EXISTS (
    SELECT 1 FROM ip_vote_blocks WHERE client_ip = NEW.client_ip
  );
END;

-- Apply the same policy to already-recorded excessive activity in the last hour.
-- Unknown historical addresses are deliberately excluded; no votes are removed.
INSERT OR IGNORE INTO ip_vote_blocks (client_ip, votes_in_hour)
  SELECT client_ip, COUNT(*) FROM votes
  WHERE client_ip IS NOT NULL AND created_at > datetime('now', '-1 hour')
  GROUP BY client_ip HAVING COUNT(*) > 10;
