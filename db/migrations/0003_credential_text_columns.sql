-- Store sealed credentials as text, matching what is actually written.
--
-- `0000` declared these `bytea` while the application writes base64 strings. Postgres accepts
-- that — it stores the bytes of the string — and returns `\x<hex>` on read, so the value that
-- comes back is not the value that went in and the decrypt fails with "authentication failed".
-- Nothing errors; the round trip is simply lossy.
--
-- Text rather than converting the application to Buffers: the payload *is* base64, which is a
-- text encoding, and `SealedSecret` is a record of strings all the way through. Matching the
-- column to the payload removes the cast rather than adding a second one. The ~33% size cost of
-- base64 over raw bytes is immaterial for credential material measured in hundreds of bytes.
--
-- Safe to run: no credential has been stored yet. It would not be safe later, which is why it
-- is happening now — a `bytea` column holding real ciphertext could not be converted without
-- decoding every row first.

ALTER TABLE "runner"."credentials"
    ALTER COLUMN "ciphertext" TYPE text USING encode("ciphertext", 'escape'),
    ALTER COLUMN "wrapped_key" TYPE text USING encode("wrapped_key", 'escape');
