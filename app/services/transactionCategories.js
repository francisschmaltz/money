export const FEES_INTEREST_CATEGORY = "Fees & Interest";

const FEES_INTEREST_PRIMARY_ALIASES = new Set([
  "BANK_FEES",
  "BANK FEES",
  FEES_INTEREST_CATEGORY.toLocaleUpperCase(),
]);

const PRIMARY_CATEGORY_LABELS = new Map([
  ["BANK_FEES", FEES_INTEREST_CATEGORY],
  ["ENTERTAINMENT", "Entertainment"],
  ["FOOD_AND_DRINK", "Food & Drink"],
  ["GENERAL_MERCHANDISE", "Shopping"],
  ["GENERAL_SERVICES", "Services"],
  ["GOVERNMENT_AND_NON_PROFIT", "Government & Nonprofit"],
  ["HOME_IMPROVEMENT", "Home"],
  ["INCOME", "Income"],
  ["LOAN_PAYMENTS", "Loan Payments"],
  ["MEDICAL", "Medical"],
  ["PERSONAL_CARE", "Personal Care"],
  ["RENT_AND_UTILITIES", "Housing & Utilities"],
  ["TRANSFER_IN", "Transfers"],
  ["TRANSFER_OUT", "Transfers"],
  ["TRANSPORTATION", "Transportation"],
  ["TRAVEL", "Travel"],
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

export function transactionCategoryLabel(
  primaryCategory,
  detailedCategory = null,
) {
  const category = canonicalTransactionCategory(
    primaryCategory,
    detailedCategory,
  );
  if (!category) return "Uncategorized";

  const primaryKey = providerCategoryKey(category);
  const detailedKey = providerCategoryKey(detailedCategory);
  if (primaryKey === "FOOD_AND_DRINK") {
    return detailedKey.includes("GROCER")
      ? "Groceries"
      : detailedKey
        ? "Dining"
        : PRIMARY_CATEGORY_LABELS.get(primaryKey);
  }
  if (primaryKey === "RENT_AND_UTILITIES") {
    return detailedKey.includes("RENT")
      ? "Housing"
      : detailedKey
        ? "Utilities"
        : PRIMARY_CATEGORY_LABELS.get(primaryKey);
  }
  return (
    PRIMARY_CATEGORY_LABELS.get(primaryKey) ??
    humanizeProviderCategory(category)
  );
}

export function transactionCategoryOptions(observedCategories = []) {
  const categories = new Map([
    [
      FEES_INTEREST_CATEGORY.toLocaleLowerCase(),
      FEES_INTEREST_CATEGORY,
    ],
  ]);
  for (const category of observedCategories) {
    const value = canonicalTransactionCategory(category);
    if (value && !categories.has(value.toLocaleLowerCase())) {
      categories.set(value.toLocaleLowerCase(), value);
    }
  }
  return [...categories.values()]
    .map((value) => ({
      value,
      label: transactionCategoryLabel(value),
    }))
    .sort((left, right) => {
      const leftIsOther =
        left.label.trim().toLocaleLowerCase() === "other";
      const rightIsOther =
        right.label.trim().toLocaleLowerCase() === "other";
      if (leftIsOther !== rightIsOther) {
        return leftIsOther ? 1 : -1;
      }
      return left.label.localeCompare(right.label);
    });
}

function providerCategoryKey(value) {
  return String(value ?? "")
    .trim()
    .toLocaleUpperCase()
    .replaceAll("&", "AND")
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function humanizeProviderCategory(value) {
  const text = String(value).trim();
  if (!text || (!text.includes("_") && text !== text.toLocaleUpperCase())) {
    return text;
  }
  return text
    .toLocaleLowerCase()
    .replaceAll("_", " ")
    .replace(/\band\b/g, "&")
    .replace(/\b\w/g, (letter) => letter.toLocaleUpperCase());
}
