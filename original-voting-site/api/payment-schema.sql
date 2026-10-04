-- XorPay ledger, applied only to the isolated payment database first.
CREATE TABLE IF NOT EXISTS payment_orders (
  id TEXT PRIMARY KEY,
  voter_id TEXT NOT NULL,
  request_id TEXT NOT NULL,
  choice TEXT NOT NULL CHECK(choice IN ('left', 'right')),
  currency TEXT NOT NULL DEFAULT 'CNY' CHECK(currency = 'CNY'),
  amount_minor INTEGER NOT NULL CHECK(amount_minor BETWEEN 100 AND 100000),
  votes INTEGER NOT NULL CHECK(votes = amount_minor),
  environment TEXT NOT NULL CHECK(environment IN ('development', 'production')),
  merchant_id TEXT NOT NULL,
  provider_order_id TEXT UNIQUE,
  checkout_url TEXT,
  status TEXT NOT NULL DEFAULT 'created' CHECK(status IN ('created','pending','paid','expired')),
  client_ip TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(voter_id, request_id)
);
CREATE TABLE IF NOT EXISTS paid_totals (
  choice TEXT PRIMARY KEY CHECK(choice IN ('left', 'right')),
  total INTEGER NOT NULL DEFAULT 0 CHECK(total >= 0)
);
INSERT OR IGNORE INTO paid_totals(choice,total) VALUES('left',0),('right',0);
CREATE TABLE IF NOT EXISTS payment_grants (
  order_id TEXT PRIMARY KEY REFERENCES payment_orders(id),
  choice TEXT NOT NULL CHECK(choice IN ('left', 'right')),
  votes INTEGER NOT NULL CHECK(votes >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER IF NOT EXISTS paid_vote_insert AFTER INSERT ON payment_grants BEGIN
  UPDATE paid_totals SET total=total+NEW.votes WHERE choice=NEW.choice;
END;
CREATE TRIGGER IF NOT EXISTS paid_vote_update AFTER UPDATE OF votes ON payment_grants BEGIN
  UPDATE paid_totals SET total=total+NEW.votes-OLD.votes WHERE choice=NEW.choice;
END;
