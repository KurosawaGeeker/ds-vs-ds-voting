-- Historical votes remain NULL. Apply once before publishing the updated vote handler.
ALTER TABLE votes ADD COLUMN client_ip TEXT;
