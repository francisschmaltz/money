import { z } from "zod";

import {
  FINANCE_CARD_SCHEMA,
  FINANCE_CARD_VERSION,
  FINANCE_TOOL_KIND_MAP,
  PLANNING_TOOL_KIND_MAP,
} from "./constants.js";
import {
  amountToMinorUnits,
  hasCurrencyPrecision,
  hasPercentagePrecision,
  percentageToBasisPoints,
} from "./units.js";

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATE_TIME_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function validIsoDate(value) {
  if (!ISO_DATE_PATTERN.test(value)) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}

function validIsoDateTime(value) {
  return (
    ISO_DATE_TIME_PATTERN.test(value) &&
    Number.isFinite(new Date(value).getTime())
  );
}

export const isoDateSchema = z
  .string()
  .trim()
  .refine(validIsoDate, "Expected an ISO date in YYYY-MM-DD format.");

export const isoDateOrDateTimeSchema = z
  .string()
  .trim()
  .refine(
    (value) => validIsoDate(value) || validIsoDateTime(value),
    "Expected an ISO date or timestamp.",
  );

const opaqueIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

const cursorSchema = z
  .string()
  .trim()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9+/_=.:-]+$/);

const querySchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));

const categorySchema = z.string().trim().min(1).max(500);
const financeGoalPurposeSchema = z.enum([
  "vacation",
  "home",
  "vehicle",
  "education",
  "emergency",
  "event",
  "purchase",
  "other",
]);
const financeGoalArchiveOutcomeSchema = z.enum([
  "completed",
  "cancelled",
]);

const currencySchema = z
  .string()
  .trim()
  .regex(/^[A-Z]{3}$/);
const MAX_MAJOR_AMOUNT = Number.MAX_SAFE_INTEGER / 1000;
const safeAmountSchema = z
  .number()
  .min(-MAX_MAJOR_AMOUNT)
  .max(MAX_MAJOR_AMOUNT);
const nonnegativeUsdAmountSchema = z
  .number()
  .min(0)
  .max(MAX_MAJOR_AMOUNT)
  .refine(
    (value) => hasCurrencyPrecision(value, "USD"),
    "amount supports at most two decimal places for USD",
  );
const positiveUsdAmountSchema = z
  .number()
  .gt(0)
  .max(MAX_MAJOR_AMOUNT)
  .refine(
    (value) => hasCurrencyPrecision(value, "USD"),
    "amount supports at most two decimal places for USD",
  );
const brokerageChangePercentageSchema = z
  .number()
  .min(-100)
  .max(1_000)
  .refine(
    hasPercentagePrecision,
    "percentage supports at most two decimal places",
  );
const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(160)
  .refine((value) => !/[\u0000-\u001f\u007f]/.test(value));

const boundedLimit = (defaultValue, maximum) =>
  z.number().int().min(1).max(maximum).default(defaultValue);

function dateRangeSchema(shape = {}) {
  return z
    .object({
      start_date: isoDateSchema.optional(),
      end_date: isoDateSchema.optional(),
      ...shape,
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.start_date &&
        value.end_date &&
        value.start_date > value.end_date
      ) {
        context.addIssue({
          code: "custom",
          message: "start_date must not be after end_date.",
          path: ["start_date"],
        });
      }
    });
}

function requireCompleteCustomPeriod(value, context) {
  if (value.period !== "custom") return;
  if (!value.start_date) {
    context.addIssue({
      code: "custom",
      message: "start_date is required for a custom period.",
      path: ["start_date"],
    });
  }
  if (!value.end_date) {
    context.addIssue({
      code: "custom",
      message: "end_date is required for a custom period.",
      path: ["end_date"],
    });
  }
}

export const FINANCE_TOOL_INPUT_SCHEMAS = Object.freeze({
  get_finance_overview: z
    .object({})
    .strict(),

  get_finance_insights: z
    .object({
      section: z
        .enum(["weekly", "investments", "subscriptions", "all"])
        .default("all"),
      as_of: isoDateOrDateTimeSchema.optional(),
      limit_per_section: boundedLimit(10, 25),
    })
    .strict(),

  list_accounts: z
    .object({
      account_type: z
        .enum([
          "depository",
          "credit",
          "loan",
          "investment",
          "other",
          "all",
        ])
        .default("all"),
      institution_id: opaqueIdSchema.optional(),
      balance_group: z
        .enum([
          "cash",
          "taxable_investment",
          "retirement",
          "credit_card",
          "loan",
          "other_asset",
          "other_liability",
          "excluded",
        ])
        .optional(),
      include_closed: z.boolean().default(false),
      limit: boundedLimit(25, 50),
      cursor: cursorSchema.optional(),
    })
    .strict(),

  list_transactions: dateRangeSchema({
    query: querySchema.optional(),
    account_id: opaqueIdSchema.optional(),
    category: categorySchema.optional(),
    status: z.enum(["posted", "pending", "all"]).default("all"),
    min_amount: safeAmountSchema.optional(),
    max_amount: safeAmountSchema.optional(),
    currency: currencySchema.optional(),
    limit: boundedLimit(20, 25),
    cursor: cursorSchema.optional(),
  }).superRefine((value, context) => {
    if (
      value.min_amount !== undefined &&
      value.max_amount !== undefined &&
      value.min_amount > value.max_amount
    ) {
      context.addIssue({
        code: "custom",
        message: "min_amount must not exceed max_amount.",
        path: ["min_amount"],
      });
    }
    if (
      (value.min_amount !== undefined ||
        value.max_amount !== undefined) &&
      !value.currency
    ) {
      context.addIssue({
        code: "custom",
        message: "currency is required with amount filters.",
        path: ["currency"],
      });
    }
    for (const key of ["min_amount", "max_amount"]) {
      if (
        value[key] !== undefined &&
        value.currency &&
        !hasCurrencyPrecision(value[key], value.currency)
      ) {
        context.addIssue({
          code: "custom",
          message: `${key} has too many decimal places for ${value.currency}.`,
          path: [key],
        });
      }
    }
  }),

  get_spending_summary: dateRangeSchema({
    period: z
      .enum(["week", "month", "quarter", "year", "custom"])
      .default("month"),
    group_by: z
      .enum(["category", "merchant", "account"])
      .default("category"),
    account_id: opaqueIdSchema.optional(),
    category: categorySchema.optional(),
    segment_limit: boundedLimit(12, 30),
  }).superRefine(requireCompleteCustomPeriod),

  get_cash_flow: dateRangeSchema({
    period: z
      .enum(["month", "quarter", "year", "custom"])
      .default("month"),
    interval: z.enum(["day", "week", "month"]).default("week"),
    account_id: opaqueIdSchema.optional(),
  }).superRefine(requireCompleteCustomPeriod),

  list_recurring_payments: z
    .object({
      kind: z.enum(["subscriptions", "bills", "all"]).default("all"),
      cadence: z
        .enum([
          "weekly",
          "biweekly",
          "monthly",
          "quarterly",
          "annual",
          "irregular",
          "all",
        ])
        .default("all"),
      status: z
        .enum(["active", "canceled", "paused", "all"])
        .default("active"),
      limit: boundedLimit(20, 30),
      cursor: cursorSchema.optional(),
    })
    .strict(),

  get_net_worth_history: dateRangeSchema({
    interval: z.enum(["day", "week", "month"]).default("week"),
    limit: boundedLimit(52, 80),
  }),

  get_portfolio_summary: z
    .object({
      period: z.enum(["1w", "1m", "3m", "6m", "1y", "all"]).default("1m"),
      retirement_scope: z
        .enum(["include", "exclude", "only"])
        .default("include"),
      account_id: opaqueIdSchema.optional(),
      holdings_limit: boundedLimit(20, 30),
    })
    .strict(),

  get_credit_score_summary: z
    .object({
      period: z.enum(["1w", "1m", "1y", "all"]).default("1y"),
    })
    .strict(),

  get_safe_to_spend: z.object({}).strict(),

  list_finance_goals: z
    .object({
      status: z.enum(["active", "archived", "all"]).optional(),
      purpose: financeGoalPurposeSchema.optional(),
      limit: boundedLimit(8, 8),
      cursor: cursorSchema.optional(),
    })
    .strict(),

  get_finance_goal: z
    .object({
      goal_id: opaqueIdSchema,
    })
    .strict(),

  get_transaction_goal_spending: z
    .object({
      transaction_id: opaqueIdSchema,
    })
    .strict(),

  get_budget_status: z
    .object({
      month_on: isoDateSchema.optional(),
    })
    .strict(),

  model_finance_plan: z
    .object({
      goal_id: opaqueIdSchema.optional(),
      monthly_contribution:
        nonnegativeUsdAmountSchema.default(0),
      biweekly_contribution:
        nonnegativeUsdAmountSchema.default(0),
      one_time_contribution:
        nonnegativeUsdAmountSchema.default(0),
      brokerage_change_percentage:
        brokerageChangePercentageSchema.default(0),
    })
    .strict(),

  create_finance_goal: z
    .object({
      name: z.string().trim().min(1).max(120),
      purpose: financeGoalPurposeSchema.default("other"),
      target_amount: positiveUsdAmountSchema,
      target_on: isoDateSchema.nullable().optional(),
      idempotency_key: idempotencyKeySchema,
    })
    .strict(),

  update_finance_goal: z
    .object({
      goal_id: opaqueIdSchema,
      expected_version: z.number().int().min(1),
      name: z.string().trim().min(1).max(120).optional(),
      purpose: financeGoalPurposeSchema.optional(),
      target_amount: positiveUsdAmountSchema.optional(),
      target_on: isoDateSchema.nullable().optional(),
      idempotency_key: idempotencyKeySchema,
    })
    .strict()
    .refine(
      (value) =>
        value.name !== undefined ||
        value.purpose !== undefined ||
        value.target_amount !== undefined ||
        Object.hasOwn(value, "target_on"),
      "At least one goal field must change.",
    ),

  allocate_finance_goal: z
    .object({
      goal_id: opaqueIdSchema,
      source: z.enum(["cash", "brokerage"]),
      direction: z.enum(["allocate", "release"]).default("allocate"),
      amount: positiveUsdAmountSchema,
      expected_version: z.number().int().min(1),
      idempotency_key: idempotencyKeySchema,
    })
    .strict(),

  set_goal_funding_schedule: z
    .object({
      goal_id: opaqueIdSchema,
      schedule_id: opaqueIdSchema.optional(),
      expected_version: z.number().int().min(1).default(1),
      source: z.enum(["cash", "brokerage"]),
      cadence: z.enum(["monthly", "biweekly_friday"]),
      amount: positiveUsdAmountSchema,
      monthly_day: z.number().int().min(1).max(31).optional(),
      anchor_on: isoDateSchema.optional(),
      status: z.enum(["active", "paused"]).default("active"),
      idempotency_key: idempotencyKeySchema,
    })
    .strict()
    .superRefine((value, context) => {
      if (value.cadence === "monthly" && value.monthly_day == null) {
        context.addIssue({
          code: "custom",
          message: "monthly_day is required for monthly schedules.",
          path: ["monthly_day"],
        });
      }
      if (
        value.cadence === "biweekly_friday" &&
        value.anchor_on == null
      ) {
        context.addIssue({
          code: "custom",
          message: "anchor_on is required for alternate-Friday schedules.",
          path: ["anchor_on"],
        });
      }
      if (
        value.cadence === "biweekly_friday" &&
        value.anchor_on != null &&
        new Date(`${value.anchor_on}T00:00:00.000Z`).getUTCDay() !== 5
      ) {
        context.addIssue({
          code: "custom",
          message: "anchor_on must be a Friday.",
          path: ["anchor_on"],
        });
      }
    }),

  finish_finance_goal: z
    .object({
      goal_id: opaqueIdSchema,
      expected_version: z.number().int().min(1),
      outcome: financeGoalArchiveOutcomeSchema.default("completed"),
      idempotency_key: idempotencyKeySchema,
    })
    .strict(),

  set_category_budget: z
    .object({
      category: categorySchema.optional(),
      category_id: opaqueIdSchema.optional(),
      amount: nonnegativeUsdAmountSchema,
      tracking_mode: z
        .enum(["tracked", "informational"])
        .optional(),
      expected_version: z.number().int().min(0),
      idempotency_key: idempotencyKeySchema,
    })
    .strict()
    .refine((value) => value.category || value.category_id, {
      message: "category_id or category is required",
    }),

  clear_category_budget: z
    .object({
      category_id: opaqueIdSchema,
      confirm_descendants: z.boolean().optional(),
      expected_version: z.number().int().min(0),
      idempotency_key: idempotencyKeySchema,
    })
    .strict(),

  set_budget_income_categories: z
    .object({
      income_category_ids: z.array(opaqueIdSchema).max(25),
      expected_version: z.number().int().min(0),
      idempotency_key: idempotencyKeySchema,
    })
    .strict(),

  split_transaction: z
    .object({
      transaction_id: opaqueIdSchema,
      currency: currencySchema,
      expected_version: z.number().int().min(0),
      lines: z
        .array(
          z
            .object({
              category: categorySchema,
              amount: safeAmountSchema.refine(
                (value) => value !== 0,
                "Split amounts cannot be zero.",
              ),
              note: z.string().trim().max(240).nullable().optional(),
            })
            .strict(),
        )
        .max(50),
      idempotency_key: idempotencyKeySchema,
    })
    .strict()
    .superRefine((value, context) => {
      value.lines.forEach((line, index) => {
        if (!hasCurrencyPrecision(line.amount, value.currency)) {
          context.addIssue({
            code: "custom",
            message: `amount has too many decimal places for ${value.currency}.`,
            path: ["lines", index, "amount"],
          });
        }
      });
    }),

  spend_from_finance_goal: z
    .object({
      transaction_id: opaqueIdSchema,
      goal_id: opaqueIdSchema,
      source: z.enum(["cash", "brokerage"]),
      amount: positiveUsdAmountSchema,
      expected_goal_version: z.number().int().min(1),
      expected_transaction_version: z.number().int().min(0),
      idempotency_key: idempotencyKeySchema,
    })
    .strict(),

  reverse_goal_spend: z
    .object({
      transaction_id: opaqueIdSchema,
      goal_spend_id: opaqueIdSchema,
      expected_goal_version: z.number().int().min(1),
      expected_transaction_version: z.number().int().min(0),
      idempotency_key: idempotencyKeySchema,
    })
    .strict(),
});

const warningOutputSchema = z.union([
  z.string(),
  z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .strict(),
]);

const envelopeOutputBase = {
  schema: z.literal(FINANCE_CARD_SCHEMA),
  version: z.literal(FINANCE_CARD_VERSION),
  generated_at: z.string(),
  data_as_of: z.string(),
  partial: z.boolean(),
  warnings: z.array(warningOutputSchema),
  display: z
    .object({
      title: z.string(),
      subtitle: z.string().optional(),
      web_url: z.string(),
    })
    .strict(),
  data: z.record(z.string(), z.unknown()),
};

export const FINANCE_TOOL_OUTPUT_SCHEMAS = Object.freeze(
  Object.fromEntries(
    Object.entries({
      ...FINANCE_TOOL_KIND_MAP,
      ...PLANNING_TOOL_KIND_MAP,
    }).map(([toolName, kind]) => [
      toolName,
      z
        .object({
          ...envelopeOutputBase,
          kind: z.literal(kind),
        })
        .strict(),
    ]),
  ),
);

export function parseFinanceToolInput(toolName, input = {}) {
  const schema = FINANCE_TOOL_INPUT_SCHEMAS[toolName];
  if (!schema) {
    throw new TypeError(`Unknown finance tool: ${toolName}`);
  }
  return internalToolInput(toolName, schema.parse(input));
}

function internalToolInput(toolName, input) {
  switch (toolName) {
    case "list_transactions": {
      const { min_amount, max_amount, currency, ...rest } = input;
      return {
        ...rest,
        ...(currency ? { currency } : {}),
        ...(min_amount !== undefined
          ? {
              min_amount_minor: amountToMinorUnits(
                min_amount,
                currency,
              ),
            }
          : {}),
        ...(max_amount !== undefined
          ? {
              max_amount_minor: amountToMinorUnits(
                max_amount,
                currency,
              ),
            }
          : {}),
      };
    }
    case "model_finance_plan": {
      const {
        monthly_contribution,
        biweekly_contribution,
        one_time_contribution,
        brokerage_change_percentage,
        ...rest
      } = input;
      return {
        ...rest,
        monthly_contribution_minor: amountToMinorUnits(
          monthly_contribution,
          "USD",
        ),
        biweekly_contribution_minor: amountToMinorUnits(
          biweekly_contribution,
          "USD",
        ),
        one_time_contribution_minor: amountToMinorUnits(
          one_time_contribution,
          "USD",
        ),
        brokerage_change_basis_points: percentageToBasisPoints(
          brokerage_change_percentage,
        ),
      };
    }
    case "create_finance_goal":
    case "update_finance_goal": {
      const { target_amount, ...rest } = input;
      return {
        ...rest,
        ...(target_amount !== undefined
          ? {
              target_amount_minor: amountToMinorUnits(
                target_amount,
                "USD",
              ),
            }
          : {}),
      };
    }
    case "allocate_finance_goal":
    case "set_goal_funding_schedule":
    case "set_category_budget":
    case "spend_from_finance_goal": {
      const { amount, ...rest } = input;
      return {
        ...rest,
        amount_minor: amountToMinorUnits(amount, "USD"),
      };
    }
    case "split_transaction": {
      const { currency, lines, ...rest } = input;
      return {
        ...rest,
        currency,
        lines: lines.map(({ amount, ...line }) => ({
          ...line,
          amount_minor: amountToMinorUnits(amount, currency),
        })),
      };
    }
    default:
      return input;
  }
}
