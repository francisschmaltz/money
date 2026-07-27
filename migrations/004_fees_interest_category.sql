BEGIN;

UPDATE transactions
SET category_primary = 'Fees & Interest',
    updated_at = now()
WHERE upper(btrim(coalesce(category_primary, ''))) IN (
        'BANK_FEES',
        'BANK FEES',
        'FEES & INTEREST'
      )
   OR upper(btrim(coalesce(category_detailed, ''))) = 'BANK_FEES'
   OR upper(btrim(coalesce(category_detailed, ''))) LIKE 'BANK\_FEES\_%'
      ESCAPE '\';

UPDATE categorization_overrides
SET category_primary = 'Fees & Interest',
    updated_at = now()
WHERE upper(btrim(coalesce(category_primary, ''))) IN (
  'BANK_FEES',
  'BANK FEES',
  'FEES & INTEREST'
);

COMMIT;
