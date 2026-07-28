export function effectiveTransactionName(
  transaction,
  fallback = "Transaction",
) {
  for (const value of [
    transaction?.display_name,
    transaction?.merchant_name,
    transaction?.name,
  ]) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return fallback;
}
