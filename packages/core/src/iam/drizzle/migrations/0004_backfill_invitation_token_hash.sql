-- 0003 added admin_invitation.token_hash nullable. An invitation token is a bearer credential
-- for an admin account, so it is now stored only as its SHA-256 hex digest - the same digest
-- hashInvitationToken() computes - and the plaintext column is dropped in 0005. Hashing the
-- existing rows in place keeps every invitation already mailed redeemable: the invitee still
-- presents the plaintext from the link, which hashes to this value.
UPDATE "admin_invitation"
SET "token_hash" = encode(sha256(convert_to("token", 'UTF8')), 'hex')
WHERE "token_hash" IS NULL;
