CREATE TABLE voting_cleanup_20260927 (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cutoff_rowid INTEGER NOT NULL,
  first_kept_rowid INTEGER,
  last_seen_rowid INTEGER,
  original_left INTEGER NOT NULL,
  original_right INTEGER NOT NULL,
  excluded_left INTEGER NOT NULL,
  excluded_right INTEGER NOT NULL,
  kept_left INTEGER NOT NULL,
  kept_right INTEGER NOT NULL,
  cleaned_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO voting_cleanup_20260927 (
  id, cutoff_rowid, first_kept_rowid, last_seen_rowid,
  original_left, original_right, excluded_left, excluded_right,
  kept_left, kept_right
)
SELECT
  1,
  4559229,
  (SELECT MIN(rowid) FROM votes WHERE rowid > 4559229),
  (SELECT MAX(rowid) FROM votes),
  (SELECT total FROM totals WHERE choice = 'left'),
  (SELECT total FROM totals WHERE choice = 'right'),
  (SELECT total FROM totals WHERE choice = 'left') - (SELECT COUNT(*) FROM votes WHERE rowid > 4559229 AND choice = 'left'),
  (SELECT total FROM totals WHERE choice = 'right') - (SELECT COUNT(*) FROM votes WHERE rowid > 4559229 AND choice = 'right'),
  (SELECT COUNT(*) FROM votes WHERE rowid > 4559229 AND choice = 'left'),
  (SELECT COUNT(*) FROM votes WHERE rowid > 4559229 AND choice = 'right');

DROP TRIGGER vote_insert;
DROP TRIGGER vote_delete;

ALTER TABLE votes RENAME TO votes_archive_20260927;
ALTER TABLE totals RENAME TO totals_archive_20260927;

CREATE TABLE votes (
  voter_id TEXT PRIMARY KEY,
  choice TEXT NOT NULL CHECK (choice IN ('left', 'right')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE totals (
  choice TEXT PRIMARY KEY CHECK (choice IN ('left', 'right')),
  total INTEGER NOT NULL DEFAULT 0 CHECK (total >= 0)
);

INSERT INTO totals (choice, total) VALUES ('left', 0), ('right', 0);

CREATE TRIGGER vote_insert AFTER INSERT ON votes BEGIN
  UPDATE totals SET total = total + 1 WHERE choice = NEW.choice;
END;

CREATE TRIGGER vote_delete AFTER DELETE ON votes BEGIN
  UPDATE totals SET total = total - 1 WHERE choice = OLD.choice;
END;

INSERT INTO votes (rowid, voter_id, choice, created_at)
SELECT rowid, voter_id, choice, created_at
FROM votes_archive_20260927
WHERE rowid > 4559229;

CREATE TABLE _voting_cleanup_assertion (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO _voting_cleanup_assertion
SELECT CASE WHEN
  (SELECT total FROM totals WHERE choice = 'left') = (SELECT kept_left FROM voting_cleanup_20260927 WHERE id = 1)
  AND (SELECT total FROM totals WHERE choice = 'right') = (SELECT kept_right FROM voting_cleanup_20260927 WHERE id = 1)
THEN 1 ELSE 0 END;
DROP TABLE _voting_cleanup_assertion;
