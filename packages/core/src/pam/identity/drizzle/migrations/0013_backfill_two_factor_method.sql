-- 0012 added two_factor_method nullable, so every account enrolled before it kept NULL -
-- the value the column otherwise reserves for an account with no second factor. `app` was
-- the only method the platform could enrol into, so that is what those rows are. Left NULL
-- they would read as enabled with no active method, and their step-up codes would route to
-- the TOTP endpoint or the pushed-code one by accident rather than by enrolment.
UPDATE "user" SET "two_factor_method" = 'app' WHERE "two_factor_enabled" = true;
