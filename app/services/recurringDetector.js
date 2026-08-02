import { stableId } from "./ids.js";
import { normalizeMerchant } from "../providers/plaidNormalizer.js";
import { shiftDateOnly } from "./analytics.js";
import { effectiveTransactionName } from "./transactionNames.js";

const CADENCES = [
  { name: "weekly", target: 7, tolerance: 2, monthlyFactor: 52 / 12 },
  { name: "biweekly", target: 14, tolerance: 3, monthlyFactor: 26 / 12 },
  { name: "monthly", target: 30.44, tolerance: 5, monthlyFactor: 1 },
  { name: "quarterly", target: 91.3, tolerance: 12, monthlyFactor: 1 / 3 },
  { name: "annual", target: 365.25, tolerance: 35, monthlyFactor: 1 / 12 },
];

const DEFAULT_ALIASES = new Map([
  ["netflix com", "netflix"],
  ["netflix", "netflix"],
  ["disney plus", "disney+"],
  ["disneyplus", "disney+"],
  ["hulu", "hulu"],
  ["spotify usa", "spotify"],
  ["spotify", "spotify"],
  ["google workspace", "google workspace"],
  ["google gsuite", "google workspace"],
  ["squarespace", "squarespace"],
  ["apple services", "apple services"],
  ["apple com bill", "apple services"],
  ["icloud", "icloud"],
]);

const KNOWN_SUBSCRIPTION_FAMILIES = new Set(DEFAULT_ALIASES.values());
const FREQUENT_SPENDING_PATTERN =
  /\b(food|drink|restaurant|fast food|coffee|cafe|delivery|takeout|doordash|uber eats|grubhub|hotel|lodging|travel|gas|fuel|service station|grocery|groceries|supermarket|general merchandise|department store|shopping)\b/i;
const BILL_PATTERN =
  /\b(rent|mortgage|utilities?|electric|electricity|water|sewer|insurance|loan|childcare|medical|phone|internet|wireless|cable|government|tax)\b/i;
const SUBSCRIPTION_PATTERN =
  /\b(subscription|membership|streaming|software|cloud|storage|workspace|hosting|domain|gym)\b/i;

export function detectRecurringStreams(
  transactions,
  {
    aliases = {},
    manualPatterns = [],
    minimumOccurrences = 2,
    now = new Date(),
  } = {},
) {
  const aliasMap = new Map([
    ...DEFAULT_ALIASES,
    ...Object.entries(aliases).map(([source, target]) => [
      normalizeMerchant(source),
      normalizeMerchant(target),
    ]),
  ]);
  const eligible = transactions
    .filter(
      (transaction) =>
        !transaction.pending &&
        transactionCashFlowRole(transaction) !== "transfer" &&
        transaction.amount_minor < 0 &&
        transaction.posted_on &&
        transaction.id,
    )
    .map((transaction) => ({
      ...transaction,
      cash_flow_role: transactionCashFlowRole(transaction),
      serviceFamily: serviceFamily(transaction, aliasMap),
      spendMinor: -transaction.amount_minor,
    }))
    .filter((transaction) => transaction.serviceFamily);

  const manualStreams = buildManualStreams(
    eligible,
    manualPatterns,
    now,
  );
  const manuallyClaimedTransactionIds = new Set(
    manualStreams.flatMap((stream) => stream.transaction_ids),
  );
  const merchantAccounts = groupBy(
    eligible.filter(
      (transaction) =>
        !manuallyClaimedTransactionIds.has(transaction.id),
    ),
    (transaction) =>
      `${transaction.serviceFamily}\0${transaction.account_id ?? "unknown"}`,
  );
  const streams = [...manualStreams];
  for (const group of merchantAccounts.values()) {
    for (const cluster of clusterAmounts(group)) {
      if (cluster.length < minimumOccurrences) continue;
      cluster.sort((a, b) => a.posted_on.localeCompare(b.posted_on));
      const intervals = cluster
        .slice(1)
        .map((transaction, index) =>
          daysBetween(cluster[index].posted_on, transaction.posted_on),
        );
      const cadence = inferCadence(intervals);
      const patternMinimum =
        cadence.name === "annual" ? 2 : cadence.name === "irregular" ? 4 : 3;
      if (cluster.length < Math.max(minimumOccurrences, patternMinimum)) {
        continue;
      }
      if (
        cadence.name === "irregular" &&
        (cluster.length < 4 || coefficientOfVariation(intervals) > 0.35)
      ) {
        continue;
      }

      const amounts = cluster.map((transaction) => transaction.spendMinor);
      const expected = Math.round(median(amounts));
      const amountCv = coefficientOfVariation(amounts);
      if (amountCv > 0.35 && cadence.name !== "irregular") continue;

      const intervalFit =
        cadence.name === "irregular"
          ? 0.5
          : intervals.filter(
              (days) =>
                Math.abs(days - cadence.target) <= cadence.tolerance,
            ).length / intervals.length;
      const amountFit = Math.max(0, 1 - amountCv / 0.35);
      const historyFit = Math.min(1, cluster.length / 6);
      const confidence = Math.round(
        (intervalFit * 0.5 + amountFit * 0.3 + historyFit * 0.2) *
          10_000,
      );
      const first = cluster[0];
      const last = cluster.at(-1);
      const classification = classifyStream(cluster, {
        cadence,
        amountCv,
        intervalFit,
        confidence,
      });
      const identity = [
        first.serviceFamily,
        first.account_id ?? "unknown",
        // A fixed $5 amount band keeps normal small price movement attached
        // to one stream while ensuring genuinely separate charges from the
        // same merchant/account do not collapse onto the same database ID.
        Math.round(expected / 500),
        cadence.name,
      ].join(":");

      streams.push({
        id: stableId("recurring", identity),
        service_family: first.serviceFamily,
        display_name:
          preferredDisplayName(cluster) || titleCase(first.serviceFamily),
        stream_type: classification.type,
        classification_signals: classification.signals,
        cadence: cadence.name,
        account_id: first.account_id ?? null,
        expected_amount_minor: expected,
        min_amount_minor: Math.min(...amounts),
        max_amount_minor: Math.max(...amounts),
        monthly_equivalent_minor: Math.round(
          expected * cadence.monthlyFactor,
        ),
        currency_code: first.currency_code ?? "USD",
        cash_flow_role: last.cash_flow_role,
        first_seen_on: first.posted_on,
        last_seen_on: last.posted_on,
        next_expected_on: nextExpectedDate(last.posted_on, cadence.name),
        confidence_basis_points: Math.max(
          0,
          Math.min(10_000, confidence),
        ),
        status:
          cadence.name === "irregular" ? "irregular" : inferStatus(last, cadence, now),
        transaction_ids: cluster.map((transaction) => transaction.id),
        recent_amounts: cluster.slice(-4).map((transaction) => ({
          transaction_id: transaction.id,
          posted_on: transaction.posted_on,
          amount_minor: transaction.spendMinor,
        })),
      });
    }
  }
  return streams.sort(
    (a, b) =>
      b.monthly_equivalent_minor - a.monthly_equivalent_minor ||
      a.display_name.localeCompare(b.display_name),
  );
}

export class RecurringService {
  #repository;
  #workspaceId;
  #now;

  constructor({
    repository,
    workspaceId = "shared",
    now = () => new Date(),
  }) {
    this.#repository = repository;
    this.#workspaceId = workspaceId;
    this.#now = now;
  }

  async detectAndStore({ workspaceId = this.#workspaceId } = {}) {
    const [transactions, manualPatterns] = await Promise.all([
      this.#repository.getTransactionsForPeriod(
        workspaceId,
        {
          startOn: shiftDateOnly(this.#now(), -399),
          endOn: shiftDateOnly(this.#now(), 1),
          activeAccountsOnly: true,
        },
      ),
      typeof this.#repository.listRecurringPatternRules === "function"
        ? this.#repository.listRecurringPatternRules(workspaceId, {
            activeOnly: true,
          })
        : [],
    ]);
    const streams = detectRecurringStreams(transactions, {
      manualPatterns,
      now: this.#now(),
    });
    await this.#repository.replaceRecurringStreams(workspaceId, streams);
    await this.#repository.rebuildSearchDocuments(workspaceId);
    return streams;
  }
}

function buildManualStreams(transactions, patterns, now) {
  const claimed = new Set();
  const streams = [];
  const activePatterns = [...patterns]
    .filter((pattern) => pattern.active !== false)
    .sort((left, right) =>
      String(right.updated_at ?? "").localeCompare(
        String(left.updated_at ?? ""),
      ),
    );
  for (const pattern of activePatterns) {
    const anchorAmount = Number(pattern.anchor_amount_minor);
    const tolerance = Math.max(200, Math.round(anchorAmount * 0.2));
    const matches = transactions
      .filter((transaction) => {
        if (claimed.has(transaction.id)) return false;
        const normalizedValue =
          pattern.match_field === "normalized_name"
            ? transaction.normalized_name
            : transaction.normalized_merchant;
        return (
          transaction.account_id === pattern.account_id &&
          transaction.currency_code === pattern.currency_code &&
          normalizedValue === pattern.normalized_match_value &&
          Math.abs(transaction.spendMinor - anchorAmount) <= tolerance
        );
      })
      .sort((left, right) =>
        left.posted_on.localeCompare(right.posted_on),
      );
    if (!matches.length) continue;
    for (const transaction of matches) claimed.add(transaction.id);

    const cadence =
      CADENCES.find((entry) => entry.name === pattern.cadence) ??
      CADENCES.find((entry) => entry.name === "monthly");
    const amounts = matches.map((transaction) => transaction.spendMinor);
    const expected = Math.round(median(amounts));
    const first = matches[0];
    const last = matches.at(-1);
    streams.push({
      id: pattern.stream_id,
      service_family: first.serviceFamily,
      display_name:
        preferredDisplayName(matches) ||
        titleCase(first.serviceFamily),
      stream_type: pattern.stream_type,
      classification_signals: {
        manual_pattern: true,
        manual_pattern_rule_id: pattern.id,
        occurrence_count: matches.length,
        classification_confidence_basis_points: 10_000,
      },
      cadence: cadence.name,
      account_id: first.account_id ?? null,
      expected_amount_minor: expected,
      min_amount_minor: Math.min(...amounts),
      max_amount_minor: Math.max(...amounts),
      monthly_equivalent_minor: Math.round(
        expected * cadence.monthlyFactor,
      ),
      currency_code: first.currency_code ?? "USD",
      cash_flow_role: last.cash_flow_role,
      first_seen_on: first.posted_on,
      last_seen_on: last.posted_on,
      next_expected_on: nextExpectedDate(
        last.posted_on,
        cadence.name,
      ),
      confidence_basis_points: 10_000,
      status: inferStatus(last, cadence, now),
      transaction_ids: matches.map((transaction) => transaction.id),
      recent_amounts: matches.slice(-4).map((transaction) => ({
        transaction_id: transaction.id,
        posted_on: transaction.posted_on,
        amount_minor: transaction.spendMinor,
      })),
    });
  }
  return streams;
}

function transactionCashFlowRole(transaction) {
  if (
    ["spending", "obligation", "transfer"].includes(
      transaction.cash_flow_role,
    )
  ) {
    return transaction.cash_flow_role;
  }
  return transaction.excluded_from_spending
    ? "transfer"
    : "spending";
}

function serviceFamily(transaction, aliases) {
  const normalized = normalizeMerchant(
    transaction.normalized_merchant ||
      transaction.merchant_name ||
      transaction.name,
  );
  if (!normalized) return "";
  if (aliases.has(normalized)) return aliases.get(normalized);
  for (const [source, target] of aliases) {
    if (normalized.includes(source)) return target;
  }
  return normalized;
}

function clusterAmounts(transactions) {
  const sorted = [...transactions].sort((a, b) => a.spendMinor - b.spendMinor);
  const clusters = [];
  for (const transaction of sorted) {
    const nearest = clusters
      .map((cluster) => ({
        cluster,
        median: median(cluster.map((entry) => entry.spendMinor)),
      }))
      .filter(
        ({ median: clusterMedian }) =>
          Math.abs(transaction.spendMinor - clusterMedian) <=
          Math.max(200, clusterMedian * 0.2),
      )
      .sort(
        (a, b) =>
          Math.abs(transaction.spendMinor - a.median) -
          Math.abs(transaction.spendMinor - b.median),
      )[0];
    if (nearest) nearest.cluster.push(transaction);
    else clusters.push([transaction]);
  }
  return clusters;
}

function inferCadence(intervals) {
  const typical = median(intervals);
  const match = CADENCES.find(
    (cadence) => Math.abs(typical - cadence.target) <= cadence.tolerance,
  );
  return (
    match ?? {
      name: "irregular",
      target: typical,
      tolerance: Infinity,
      monthlyFactor: typical > 0 ? 30.44 / typical : 1,
    }
  );
}

function classifyStream(
  transactions,
  { cadence, amountCv, intervalFit, confidence },
) {
  const first = transactions[0];
  const classificationText = transactions
    .map(
      (transaction) =>
        `${transaction.category_primary ?? ""} ${transaction.category_detailed ?? ""} ${transaction.merchant_name ?? ""} ${transaction.name ?? ""}`,
    )
    .join(" ")
    .replaceAll("_", " ");
  const hardNegative = FREQUENT_SPENDING_PATTERN.test(classificationText);
  const billSignal = BILL_PATTERN.test(classificationText);
  const subscriptionSignal =
    KNOWN_SUBSCRIPTION_FAMILIES.has(first.serviceFamily) ||
    SUBSCRIPTION_PATTERN.test(classificationText);
  const strongSignal = billSignal || subscriptionSignal;
  const cadenceMinimum = {
    weekly: 6,
    biweekly: 6,
    monthly: 3,
    quarterly: 3,
    annual: 2,
  }[cadence.name];
  const knownEligible =
    !hardNegative &&
    cadenceMinimum != null &&
    transactions.length >= cadenceMinimum &&
    strongSignal;
  const unknownEligible =
    !hardNegative &&
    ["monthly", "quarterly", "annual"].includes(cadence.name) &&
    transactions.length >= 4 &&
    intervalFit >= 0.75 &&
    amountCv <= 0.1 &&
    confidence >= 8_500;
  const type =
    knownEligible || unknownEligible
      ? billSignal
        ? "bill"
        : "subscription"
      : "frequent_spending";
  return {
    type,
    signals: {
      hard_negative: hardNegative,
      bill_signal: billSignal,
      subscription_signal: subscriptionSignal,
      occurrence_count: transactions.length,
      interval_fit_basis_points: Math.round(intervalFit * 10_000),
      amount_variation_basis_points: Math.round(amountCv * 10_000),
      classification_confidence_basis_points:
        type === "frequent_spending"
          ? hardNegative
            ? 10_000
            : cadence.name === "irregular"
              ? 8_500
              : Math.max(5_000, 10_000 - confidence)
          : confidence,
    },
  };
}

function inferStatus(last, cadence, now) {
  const daysSince = daysBetween(last.posted_on, now.toISOString().slice(0, 10));
  return daysSince > cadence.target + cadence.tolerance * 2
    ? "canceled"
    : "active";
}

function nextExpectedDate(lastDate, cadence) {
  if (cadence === "monthly") return addCalendar(lastDate, 1, "month");
  if (cadence === "quarterly") return addCalendar(lastDate, 3, "month");
  if (cadence === "annual") return addCalendar(lastDate, 1, "year");
  if (cadence === "weekly") return shiftDateOnly(lastDate, 7);
  if (cadence === "biweekly") return shiftDateOnly(lastDate, 14);
  return null;
}

function addCalendar(value, count, unit) {
  const date = new Date(`${value}T00:00:00.000Z`);
  if (unit === "month") date.setUTCMonth(date.getUTCMonth() + count);
  else date.setUTCFullYear(date.getUTCFullYear() + count);
  return date.toISOString().slice(0, 10);
}

function preferredDisplayName(transactions) {
  const counts = new Map();
  for (const transaction of transactions) {
    const name = effectiveTransactionName(transaction, "");
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  )[0]?.[0];
}

function groupBy(values, key) {
  const groups = new Map();
  for (const value of values) {
    const groupKey = key(value);
    const group = groups.get(groupKey) ?? [];
    group.push(value);
    groups.set(groupKey, group);
  }
  return groups;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function coefficientOfVariation(values) {
  if (!values.length) return Infinity;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean === 0) return 0;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) ** 2, 0) /
    values.length;
  return Math.sqrt(variance) / Math.abs(mean);
}

function daysBetween(a, b) {
  return Math.round(
    (new Date(`${b}T00:00:00.000Z`) -
      new Date(`${a}T00:00:00.000Z`)) /
      86_400_000,
  );
}

function titleCase(value) {
  return value.replace(/\b\w/g, (character) => character.toUpperCase());
}
