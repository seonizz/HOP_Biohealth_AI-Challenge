-- Read-only per-record bearer keys; plaintext is returned only on issuance.
ALTER TABLE records ADD COLUMN access_key_hash TEXT UNIQUE;
