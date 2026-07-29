BEGIN;

CREATE VIEW transaction_effective_spending_treatments AS
SELECT
  t.workspace_id,
  t.id AS transaction_id,
  COALESCE(
    transaction_override.excluded_from_spending,
    merchant_override.excluded_from_spending,
    original_transaction_override.excluded_from_spending,
    original_merchant_override.excluded_from_spending,
    original_transaction.excluded_from_spending,
    t.excluded_from_spending
  ) AS effective_excluded_from_spending
FROM transactions t
LEFT JOIN transactions original_transaction
  ON original_transaction.workspace_id = t.workspace_id
 AND original_transaction.id = t.original_transaction_id
LEFT JOIN categorization_overrides transaction_override
  ON transaction_override.workspace_id = t.workspace_id
 AND transaction_override.transaction_id = t.id
LEFT JOIN categorization_overrides merchant_override
  ON merchant_override.workspace_id = t.workspace_id
 AND merchant_override.transaction_id IS NULL
 AND merchant_override.normalized_merchant =
   t.normalized_merchant
LEFT JOIN categorization_overrides original_transaction_override
  ON original_transaction_override.workspace_id =
    original_transaction.workspace_id
 AND original_transaction_override.transaction_id =
   original_transaction.id
LEFT JOIN categorization_overrides original_merchant_override
  ON original_merchant_override.workspace_id =
    original_transaction.workspace_id
 AND original_merchant_override.transaction_id IS NULL
 AND original_merchant_override.normalized_merchant =
   original_transaction.normalized_merchant;

COMMENT ON VIEW transaction_effective_spending_treatments IS
  'Effective spending inclusion after transaction, merchant, and original-transaction override precedence.';

COMMIT;
