export const FEES_INTEREST_CATEGORY = "Fees & Interest";

const FEES_INTEREST_PRIMARY_ALIASES = new Set([
  "BANK_FEES",
  "BANK FEES",
  FEES_INTEREST_CATEGORY.toLocaleUpperCase(),
]);

export function canonicalTransactionCategory(
  primaryCategory,
  detailedCategory = null,
) {
  const primary = String(primaryCategory ?? "").trim();
  const detailed = String(detailedCategory ?? "").trim().toLocaleUpperCase();
  if (
    FEES_INTEREST_PRIMARY_ALIASES.has(primary.toLocaleUpperCase()) ||
    detailed === "BANK_FEES" ||
    detailed.startsWith("BANK_FEES_")
  ) {
    return FEES_INTEREST_CATEGORY;
  }
  return primary || null;
}

export function transactionCategoryOptions(observedCategories = []) {
  const labels = new Map([
    [
      FEES_INTEREST_CATEGORY.toLocaleLowerCase(),
      FEES_INTEREST_CATEGORY,
    ],
  ]);
  for (const category of observedCategories) {
    const label = canonicalTransactionCategory(category);
    if (label && !labels.has(label.toLocaleLowerCase())) {
      labels.set(label.toLocaleLowerCase(), label);
    }
  }
  return [...labels.values()]
    .sort((left, right) => left.localeCompare(right))
    .map((label) => ({ label }));
}
