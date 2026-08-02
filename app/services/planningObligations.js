import { money } from "./analytics.js";

const ACTIVE_OBLIGATION_STATUSES = new Set(["active", "resumed"]);

export function buildPlanningObligations(
  recurringStreams = [],
  {
    currency = "USD",
    asOf = new Date().toISOString().slice(0, 10),
  } = {},
) {
  const asOfOn = dateOnly(asOf);
  if (!asOfOn) throw new TypeError("asOf must be an ISO date.");
  return recurringStreams
    .filter(
      (stream) =>
        stream.stream_type === "bill" &&
        (stream.cash_flow_role ?? stream.effective_cash_flow_role) ===
          "obligation" &&
        ACTIVE_OBLIGATION_STATUSES.has(stream.status),
    )
    .map((stream) => {
      const amountMinor = Number(stream.expected_amount_minor);
      const streamCurrency = stream.currency_code ?? currency;
      const nextDueOn = dateOnly(stream.next_expected_on);
      const lastTransaction = stream.last_transaction ?? null;
      const pendingTransaction = stream.pending_transaction ?? null;
      const lastPaidOn = dateOnly(
        lastTransaction?.posted_on ?? stream.last_seen_on,
      );
      const lastTransactionId =
        lastTransaction?.id ?? stream.transaction_ids?.at(-1) ?? null;
      const lastPaymentAmountMinor = Number(
        lastTransaction?.amount_minor,
      );
      const lastPayment =
        lastPaidOn && lastPaidOn <= asOfOn
          ? {
              status: "paid",
              transaction_id: lastTransactionId,
              paid_on: lastPaidOn,
              amount:
                Number.isSafeInteger(lastPaymentAmountMinor) &&
                lastPaymentAmountMinor !== 0
                  ? money(
                      Math.abs(lastPaymentAmountMinor),
                      lastTransaction?.currency_code ?? streamCurrency,
                    )
                  : null,
            }
          : null;
      const pendingOn = dateOnly(
        pendingTransaction?.posted_on ?? pendingTransaction?.authorized_on,
      );
      const pendingAmountMinor = Number(pendingTransaction?.amount_minor);
      const pendingPayment = pendingTransaction?.id
        ? {
            status: "pending",
            transaction_id: pendingTransaction.id,
            pending_on: pendingOn,
            amount:
              Number.isSafeInteger(pendingAmountMinor) &&
              pendingAmountMinor !== 0
                ? money(
                    Math.abs(pendingAmountMinor),
                    pendingTransaction.currency_code ?? streamCurrency,
                  )
                : null,
          }
        : null;
      return {
        id: stream.id,
        name:
          stream.display_name ??
          stream.service ??
          humanizeServiceFamily(stream.service_family) ??
          "Obligation",
        account_id: stream.account_id ?? null,
        account_name: stream.account_name ?? null,
        expected_amount:
          Number.isSafeInteger(amountMinor) && amountMinor > 0
            ? money(amountMinor, streamCurrency)
            : null,
        cadence: stream.cadence,
        next_due_on: nextDueOn,
        status: pendingPayment
          ? "matched_pending"
          : obligationStatus({
              asOfOn,
              nextDueOn,
              lastPaidOn: lastPayment?.paid_on ?? null,
            }),
        stream_status: stream.status,
        last_payment: lastPayment,
        ...(pendingPayment
          ? { pending_payment: pendingPayment }
          : {}),
      };
    })
    .sort((left, right) => {
      const dueDate = (left.next_due_on ?? "9999-12-31").localeCompare(
        right.next_due_on ?? "9999-12-31",
      );
      return dueDate || left.name.localeCompare(right.name);
    });
}

function obligationStatus({ asOfOn, nextDueOn, lastPaidOn }) {
  if (nextDueOn && nextDueOn < asOfOn) return "overdue";
  const asOfMonth = asOfOn.slice(0, 7);
  if (
    lastPaidOn?.startsWith(asOfMonth) &&
    (!nextDueOn || nextDueOn.slice(0, 7) > asOfMonth)
  ) {
    return "paid";
  }
  return "upcoming";
}

function dateOnly(value) {
  const normalized = String(value ?? "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) return null;
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === normalized
    ? normalized
    : null;
}

function humanizeServiceFamily(value) {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  return normalized
    .split("_")
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ");
}
