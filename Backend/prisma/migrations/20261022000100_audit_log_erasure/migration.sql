-- The audit log stays append-only, with one exception required for GDPR/CCPA erasure: an update may only
-- anonymise a row (set "userId" and/or "ip" to NULL) and must leave every other column untouched.
-- Without this, ON DELETE SET NULL from "users" was rejected and account deletion could never complete.
CREATE OR REPLACE FUNCTION audit_logs_guard() RETURNS trigger AS $$
BEGIN
  IF NEW."id" = OLD."id"
     AND NEW."action" = OLD."action"
     AND NEW."severity" = OLD."severity"
     AND NEW."metadata" IS NOT DISTINCT FROM OLD."metadata"
     AND NEW."createdAt" = OLD."createdAt"
     AND (NEW."userId" IS NULL OR NEW."userId" = OLD."userId")
     AND (NEW."ip" IS NULL OR NEW."ip" = OLD."ip")
  THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'table audit_logs is append-only (only anonymisation is allowed)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "audit_logs_append_only" ON "audit_logs";
CREATE TRIGGER "audit_logs_append_only" BEFORE UPDATE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_guard();
