-- Seeds the limits projection from compliance's limits in the migration that ships the gate, so a
-- limit set before ADR-0055 is enforced from the first request, not from the boot backfill. Every
-- user gets version 0, the version the backfill assumes for a user compliance has not bumped, so
-- the backfill then finds nothing to write. Isolated module tests migrate wallet without
-- compliance or profile: the tables are read only when they exist, and EXECUTE keeps them out of
-- the plan.
DO $$
BEGIN
  IF to_regclass('user_limit') IS NULL THEN
    RETURN;
  END IF;
  EXECUTE format(
    $sql$
      INSERT INTO ledger_user_limit (limit_id, user_id, type, period, amount, currency, changed_at)
      SELECT ul.id, ul.user_id, ul.type, ul.period, ul.amount, %s, ul.updated_at
      FROM user_limit AS ul
      %s
      WHERE ul.type IN ('deposit', 'wager')
        AND ul.period IN ('daily', 'weekly', 'monthly')
        AND ul.amount IS NOT NULL
      ON CONFLICT (limit_id) DO NOTHING
    $sql$,
    CASE WHEN to_regclass('player') IS NULL THEN 'ul.currency' ELSE 'coalesce(ul.currency, p.currency)' END,
    CASE WHEN to_regclass('player') IS NULL THEN '' ELSE 'LEFT JOIN player AS p ON p.user_id = ul.user_id' END
  );
  INSERT INTO ledger_user_limit_version (user_id, version)
  SELECT DISTINCT user_id, 0 FROM ledger_user_limit
  ON CONFLICT (user_id) DO NOTHING;
END $$;
