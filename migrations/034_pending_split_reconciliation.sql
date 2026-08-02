BEGIN;

ALTER TABLE transactions
  ADD COLUMN split_needs_review boolean NOT NULL DEFAULT false;

CREATE INDEX transactions_split_needs_review_idx
  ON transactions (workspace_id, posted_on DESC, id)
  WHERE split_needs_review = true;

CREATE OR REPLACE FUNCTION guard_transaction_split_parent()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  parent_changed boolean;
  split_count integer;
  split_total bigint;
  all_match_parent_sign boolean;
  largest_split_id text;
  largest_amount_minor bigint;
  adjusted_amount_minor bigint;
  split_before jsonb;
  split_after jsonb;
  can_reconcile boolean;
BEGIN
  SELECT
    count(*)::integer,
    COALESCE(sum(split.amount_minor), 0)::bigint,
    COALESCE(
      bool_and(sign(split.amount_minor) = sign(OLD.amount_minor)),
      true
    ),
    (
      array_agg(
        split.id
        ORDER BY
          abs(split.amount_minor) DESC,
          split.line_index,
          split.id
      )
    )[1],
    (
      array_agg(
        split.amount_minor
        ORDER BY
          abs(split.amount_minor) DESC,
          split.line_index,
          split.id
      )
    )[1],
    jsonb_agg(
      jsonb_build_object(
        'id', split.id,
        'line_index', split.line_index,
        'category', split.category,
        'category_id', split.category_id,
        'amount_minor', split.amount_minor,
        'note', split.note
      )
      ORDER BY split.line_index, split.id
    )
  INTO
    split_count,
    split_total,
    all_match_parent_sign,
    largest_split_id,
    largest_amount_minor,
    split_before
  FROM transaction_splits split
  WHERE split.workspace_id = OLD.workspace_id
    AND split.transaction_id = OLD.id;

  IF split_count = 0 THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    INSERT INTO plan_audit_events (
      id,
      workspace_id,
      event_type,
      subject_type,
      subject_id,
      actor_type,
      actor_id,
      before_value,
      after_value
    )
    VALUES (
      'audit_' || md5(
        OLD.id || clock_timestamp()::text || random()::text
      ),
      OLD.workspace_id,
      'transaction.splits_invalidated',
      'transaction',
      OLD.id,
      'worker',
      'database_guard',
      jsonb_build_object(
        'parent',
        jsonb_build_object(
          'amount_minor', OLD.amount_minor,
          'currency_code', OLD.currency_code,
          'pending', OLD.pending,
          'split_needs_review', OLD.split_needs_review
        ),
        'splits',
        split_before
      ),
      NULL
    );

    DELETE FROM transaction_splits
    WHERE workspace_id = OLD.workspace_id
      AND transaction_id = OLD.id;
    RETURN OLD;
  END IF;

  parent_changed :=
    OLD.amount_minor IS DISTINCT FROM NEW.amount_minor
    OR OLD.currency_code IS DISTINCT FROM NEW.currency_code
    OR OLD.pending IS DISTINCT FROM NEW.pending;

  -- Provider upserts name these columns even when their values did not
  -- change. That is not a split mutation.
  IF NOT parent_changed THEN
    RETURN NEW;
  END IF;

  adjusted_amount_minor :=
    largest_amount_minor + (NEW.amount_minor - OLD.amount_minor);
  can_reconcile :=
    OLD.split_needs_review = false
    AND NEW.split_needs_review = false
    AND split_count >= 2
    AND OLD.amount_minor <> 0
    AND NEW.amount_minor <> 0
    AND OLD.currency_code = NEW.currency_code
    AND sign(OLD.amount_minor) = sign(NEW.amount_minor)
    AND split_total = OLD.amount_minor
    AND all_match_parent_sign
    AND adjusted_amount_minor <> 0
    AND sign(adjusted_amount_minor) = sign(NEW.amount_minor);

  IF can_reconcile THEN
    IF OLD.amount_minor IS DISTINCT FROM NEW.amount_minor THEN
      UPDATE transaction_splits
      SET amount_minor = adjusted_amount_minor,
          updated_at = now()
      WHERE workspace_id = OLD.workspace_id
        AND transaction_id = OLD.id
        AND id = largest_split_id;

      SELECT jsonb_agg(
        jsonb_build_object(
          'id', split.id,
          'line_index', split.line_index,
          'category', split.category,
          'category_id', split.category_id,
          'amount_minor', split.amount_minor,
          'note', split.note
        )
        ORDER BY split.line_index, split.id
      )
      INTO split_after
      FROM transaction_splits split
      WHERE split.workspace_id = OLD.workspace_id
        AND split.transaction_id = OLD.id;

      INSERT INTO plan_audit_events (
        id,
        workspace_id,
        event_type,
        subject_type,
        subject_id,
        actor_type,
        actor_id,
        before_value,
        after_value
      )
      VALUES (
        'audit_' || md5(
          OLD.id || clock_timestamp()::text || random()::text
        ),
        OLD.workspace_id,
        'transaction.splits_reconciled',
        'transaction',
        OLD.id,
        'worker',
        'database_guard',
        jsonb_build_object(
          'parent',
          jsonb_build_object(
            'amount_minor', OLD.amount_minor,
            'currency_code', OLD.currency_code,
            'pending', OLD.pending,
            'split_needs_review', OLD.split_needs_review
          ),
          'splits',
          split_before
        ),
        jsonb_build_object(
          'parent',
          jsonb_build_object(
            'amount_minor', NEW.amount_minor,
            'currency_code', NEW.currency_code,
            'pending', NEW.pending,
            'split_needs_review', false
          ),
          'adjusted_split_id',
          largest_split_id,
          'delta_minor',
          NEW.amount_minor - OLD.amount_minor,
          'splits',
          split_after
        )
      );
    END IF;
    RETURN NEW;
  END IF;

  -- Currency or sign changes make the old line amounts ambiguous. Keep the
  -- exact user-authored split for correction, but quarantine the parent from
  -- posted analytics until it is reviewed.
  NEW.split_needs_review := true;
  INSERT INTO plan_audit_events (
    id,
    workspace_id,
    event_type,
    subject_type,
    subject_id,
    actor_type,
    actor_id,
    before_value,
    after_value
  )
  VALUES (
    'audit_' || md5(
      OLD.id || clock_timestamp()::text || random()::text
    ),
    OLD.workspace_id,
    'transaction.splits_needs_review',
    'transaction',
    OLD.id,
    'worker',
    'database_guard',
    jsonb_build_object(
      'parent',
      jsonb_build_object(
        'amount_minor', OLD.amount_minor,
        'currency_code', OLD.currency_code,
        'pending', OLD.pending,
        'split_needs_review', OLD.split_needs_review
      ),
      'splits',
      split_before
    ),
    jsonb_build_object(
      'parent',
      jsonb_build_object(
        'amount_minor', NEW.amount_minor,
        'currency_code', NEW.currency_code,
        'pending', NEW.pending,
        'split_needs_review', true
      ),
      'reason',
      CASE
        WHEN OLD.split_needs_review OR NEW.split_needs_review
          THEN 'already_needs_review'
        WHEN OLD.currency_code <> NEW.currency_code
          THEN 'currency_changed'
        WHEN OLD.amount_minor = 0 OR NEW.amount_minor = 0
          THEN 'zero_amount'
        WHEN sign(OLD.amount_minor) <> sign(NEW.amount_minor)
          THEN 'sign_changed'
        WHEN split_count < 2
          THEN 'too_few_lines'
        WHEN split_total <> OLD.amount_minor
          THEN 'source_total_mismatch'
        WHEN NOT all_match_parent_sign
          THEN 'source_sign_mismatch'
        ELSE 'adjusted_line_invalid'
      END,
      'splits',
      split_before
    )
  );
  RETURN NEW;
END;
$$;

COMMENT ON COLUMN transactions.split_needs_review IS
  'True when preserved split lines cannot be safely reconciled to provider amount, sign, or currency changes. Posted analytics must exclude these transactions until corrected.';

COMMIT;
