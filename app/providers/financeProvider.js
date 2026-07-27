const REQUIRED_METHODS = [
  "createLinkToken",
  "exchangePublicToken",
  "getAccounts",
  "syncTransactions",
  "getInvestments",
  "getLiabilities",
  "removeItem",
  "verifyWebhook",
];

export function assertFinanceProvider(provider) {
  for (const method of REQUIRED_METHODS) {
    if (typeof provider?.[method] !== "function") {
      throw new TypeError(`Finance provider must implement ${method}()`);
    }
  }
  return provider;
}
