import { buildDefaultAccounts } from "./defaultScenario.js";

const money = (amountMinor, currency = "USD") => ({
  amount_minor: amountMinor,
  currency,
});

const MERCHANTS = Object.freeze([
  "The Unreasonably Long Neighborhood Grocery Cooperative and Community Market",
  "Metropolitan Transportation Authority",
  "North Star Family Dental and Orthodontic Specialists",
  "Cloud Infrastructure Services International",
  "Juniper Street Coffee Roasters",
  "Hearth and Table",
  "Harborview Hardware",
  "Paper Crane Books",
  "Orchard Pharmacy",
  "Lakeside Veterinary Hospital",
  "Cedar Cinema",
  "Atlas Air Lines",
]);

const CATEGORIES = Object.freeze([
  "Groceries",
  "Transportation",
  "Medical / Dental",
  "Server Stuff / Infrastructure",
  "Food & Drink / Coffee",
  "Food & Drink / Restaurants",
  "Home / Repairs",
  "Shopping / Books",
  "Medical / Pharmacy",
  "Pets",
  "Entertainment",
  "Travel",
]);

const UX_STRESS_ACCOUNT = Object.freeze({
  id: "account_stress_long",
  institution_id: "institution_stress_long",
  institution_name:
    "The Extremely Long Named Community Financial Cooperative",
  name: "Joint household expenses and reimbursements checking",
  mask: "0007",
  type: "depository",
  subtype: "checking",
  balance_group: "cash",
  current_balance: money(12_345_678),
  available_balance: money(12_300_000),
  is_liability: false,
  active: true,
  freshness: {
    synced_at: "2026-07-26T18:42:00.000Z",
    status: "fresh",
  },
});

export const UX_STRESS_SPLIT_TRANSACTION_ID =
  "txn_stress_0002";

function dateBefore(today, offset) {
  const date = new Date(`${today}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - offset);
  return date.toISOString().slice(0, 10);
}

export function buildUxStressTransactions({
  today = "2026-07-26",
  count = 280,
} = {}) {
  const accounts = [
    ...buildDefaultAccounts().filter((account) =>
      [
        "account_checking",
        "account_sapphire",
        "account_brokerage",
      ].includes(account.id),
    ),
    uxStressAccount(),
  ].map((account) => ({
    id: account.id,
    name: account.name,
    mask: account.mask,
    institution: account.institution_name,
  }));
  return Array.from({ length: count }, (_, index) => {
    const merchant = MERCHANTS[index % MERCHANTS.length];
    const category = CATEGORIES[index % CATEGORIES.length];
    const account = accounts[index % accounts.length];
    const income = index % 31 === 0;
    const refund = !income && index % 53 === 0;
    const transfer = !income && !refund && index % 41 === 0;
    const pending = index % 37 === 0;
    const amountMinor =
      index === 7
        ? -123_456_789
        : income
          ? 1_250_000 + index * 100
          : refund
            ? 22_500 + index
            : -(1_099 + ((index * 7_919) % 240_000));
    const effectiveCategory = income
      ? "Income"
      : transfer
        ? "Transfer"
        : category;
    const postedOn = dateBefore(
      today,
      count <= 1
        ? 0
        : Math.round((index * 389) / (count - 1)),
    );

    return {
      id: `txn_stress_${String(index + 1).padStart(4, "0")}`,
      date: postedOn,
      posted_on: postedOn,
      merchant,
      description: `${merchant} purchase ${index + 1}`,
      raw_merchant: merchant.toUpperCase(),
      raw_name: `${merchant.toUpperCase()} ${index + 1}`,
      display_name: merchant,
      note:
        index % 17 === 0
          ? "Shared household purchase with an intentionally long note for responsive and search coverage"
          : null,
      note_version: index % 17 === 0 ? 1 : 0,
      note_updated_by: index % 17 === 0 ? "demo-user" : null,
      note_updated_at:
        index % 17 === 0
          ? `${postedOn}T18:30:00.000Z`
          : null,
      category: effectiveCategory,
      category_primary: effectiveCategory,
      raw_category_primary: effectiveCategory,
      account: { ...account },
      amount: money(amountMinor),
      pending,
      excluded_from_spending: transfer,
      tags:
        index % 19 === 0
          ? ["Business", "Reimbursable"]
          : index % 23 === 0
            ? ["Tax"]
            : [],
    };
  });
}

export function uxStressAccount() {
  return {
    ...UX_STRESS_ACCOUNT,
    current_balance: { ...UX_STRESS_ACCOUNT.current_balance },
    available_balance: { ...UX_STRESS_ACCOUNT.available_balance },
    freshness: { ...UX_STRESS_ACCOUNT.freshness },
  };
}
