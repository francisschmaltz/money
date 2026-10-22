BEGIN;

CREATE FUNCTION reconcile_pending_goal_transaction_spends()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  target_parent transactions%ROWTYPE;
  affected_goal_ids text[];
  spend_before jsonb;
  spend_after jsonb;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF OLD.currency_code IS DISTINCT FROM NEW.currency_code
      OR OLD.amount_minor >= 0 OR NEW.amount_minor >= 0
      OR OLD.excluded_from_spending IS DISTINCT FROM NEW.excluded_from_spending
      OR NOT (OLD.amount_minor IS DISTINCT FROM NEW.amount_minor
        OR OLD.pending IS DISTINCT FROM NEW.pending)
    THEN
      RETURN NEW;
    END IF;
    NEW.goal_spend_version := OLD.goal_spend_version + 1;
    target_parent := NEW;
  ELSIF NOT OLD.pending OR OLD.amount_minor >= 0 THEN
    RETURN OLD;
  END IF;

  SELECT array_agg(DISTINCT spend.goal_id),
    jsonb_agg(to_jsonb(spend) ORDER BY spend.line_index, spend.id)
  INTO affected_goal_ids, spend_before
  FROM goal_transaction_spends spend
  WHERE spend.workspace_id = OLD.workspace_id
    AND spend.transaction_id = OLD.id AND spend.status = 'active';

  IF affected_goal_ids IS NULL THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    BEGIN
      SELECT posted.* INTO STRICT target_parent
      FROM transactions posted
      WHERE posted.workspace_id = OLD.workspace_id
        AND posted.account_id = OLD.account_id
        AND posted.provider_pending_transaction_id = OLD.provider_transaction_id
        AND posted.pending = false AND posted.amount_minor < 0
        AND posted.currency_code = OLD.currency_code
        AND posted.excluded_from_spending = OLD.excluded_from_spending
        AND NOT EXISTS (
          SELECT 1 FROM goal_transaction_spends spend
          WHERE spend.workspace_id = posted.workspace_id
            AND spend.transaction_id = posted.id AND spend.status = 'active'
        )
      FOR UPDATE OF posted;
    EXCEPTION WHEN NO_DATA_FOUND OR TOO_MANY_ROWS THEN
      RETURN OLD;
    END;
    UPDATE transactions
    SET goal_spend_version = GREATEST(goal_spend_version, OLD.goal_spend_version) + 1,
      updated_at = now()
    WHERE id = target_parent.id;
  END IF;

  -- Round cumulative shares so the final penny is assigned exactly once.
  WITH shares AS (
    SELECT spend.id, spend.amount_minor,
      sum(spend.amount_minor) OVER (
        ORDER BY spend.line_index, spend.id ROWS UNBOUNDED PRECEDING
      ) AS running_total
    FROM goal_transaction_spends spend
    WHERE spend.workspace_id = OLD.workspace_id
      AND spend.transaction_id = OLD.id AND spend.status = 'active'
  ), amounts AS (
    SELECT id,
      (round(running_total * target_parent.amount_minor::numeric / OLD.amount_minor)
        - round((running_total - amount_minor)
          * target_parent.amount_minor::numeric / OLD.amount_minor))::bigint AS amount_minor
    FROM shares
  ), changed AS (
    UPDATE goal_transaction_spends spend
    SET transaction_id = target_parent.id,
      transaction_provider_id = target_parent.provider_transaction_id,
      amount_minor = CASE WHEN amounts.amount_minor > 0
        THEN amounts.amount_minor ELSE spend.amount_minor END,
      status = CASE WHEN amounts.amount_minor > 0 THEN 'active' ELSE 'invalidated' END,
      ended_reason = CASE WHEN amounts.amount_minor = 0 THEN 'provider_amount_rounded_to_zero' END,
      ended_at = CASE WHEN amounts.amount_minor = 0 THEN now() END,
      updated_by = 'database_guard', updated_at = now()
    FROM amounts WHERE spend.id = amounts.id
    RETURNING spend.*
  )
  SELECT jsonb_agg(to_jsonb(changed) ORDER BY line_index, id)
  INTO spend_after FROM changed;

  UPDATE finance_goals
  SET version = version + 1, updated_by = 'database_guard', updated_at = now()
  WHERE workspace_id = OLD.workspace_id AND id = ANY(affected_goal_ids);

  INSERT INTO plan_audit_events (
    id, workspace_id, event_type, subject_type, subject_id,
    actor_type, actor_id, before_value, after_value
  ) VALUES (
    'audit_' || md5(OLD.id || clock_timestamp()::text || random()::text),
    OLD.workspace_id, 'transaction.goal_spends_reconciled', 'transaction', target_parent.id,
    'worker', 'database_guard',
    jsonb_build_object('transaction_id', OLD.id, 'amount_minor', OLD.amount_minor,
      'pending', OLD.pending, 'goal_spends', spend_before),
    jsonb_build_object('transaction_id', target_parent.id, 'amount_minor', target_parent.amount_minor,
      'pending', target_parent.pending, 'goal_spends', spend_after)
  );
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER b_guard_goal_transaction_spend_parent_change ON transactions;

CREATE TRIGGER a_reconcile_pending_goal_transaction_spends
BEFORE DELETE OR UPDATE OF amount_minor, currency_code, pending, excluded_from_spending
ON transactions FOR EACH ROW
EXECUTE FUNCTION reconcile_pending_goal_transaction_spends();

CREATE TRIGGER b_guard_goal_transaction_spend_parent_change
BEFORE DELETE ON transactions FOR EACH ROW
EXECUTE FUNCTION invalidate_goal_transaction_spends();

CREATE TRIGGER b_guard_goal_transaction_spend_incompatible_update
BEFORE UPDATE OF amount_minor, currency_code, pending, excluded_from_spending
ON transactions FOR EACH ROW
WHEN (OLD.currency_code IS DISTINCT FROM NEW.currency_code
  OR OLD.amount_minor >= 0 OR NEW.amount_minor >= 0
  OR OLD.excluded_from_spending IS DISTINCT FROM NEW.excluded_from_spending)
EXECUTE FUNCTION invalidate_goal_transaction_spends();

COMMIT;
