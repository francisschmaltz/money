import {
  PLANNING_READ_TOOL_KIND_MAP,
  PLANNING_READ_TOOL_NAMES,
  PLANNING_WRITE_TOOL_KIND_MAP,
  PLANNING_WRITE_TOOL_NAMES,
} from "./constants.js";
import {
  createFinanceEnvelope,
  createFinanceErrorEnvelope,
  createFinanceToolResult,
} from "./envelope.js";
import { normalizeFinanceMcpError } from "./errors.js";
import {
  FINANCE_TOOL_INPUT_SCHEMAS,
  FINANCE_TOOL_OUTPUT_SCHEMAS,
  parseFinanceToolInput,
} from "./schemas.js";

const READ_METHODS = Object.freeze({
  get_safe_to_spend: "getSafeToSpend",
  list_finance_goals: "listFinanceGoals",
  get_budget_status: "getBudgetStatus",
  model_finance_plan: "modelFinancePlan",
  get_transaction_goal_spending: "getTransactionGoalSpending",
});

const WRITE_METHODS = Object.freeze({
  create_finance_goal: "createFinanceGoal",
  update_finance_goal: "updateFinanceGoal",
  allocate_finance_goal: "allocateFinanceGoal",
  set_goal_funding_schedule: "setGoalFundingSchedule",
  finish_finance_goal: "finishFinanceGoal",
  set_category_budget: "setCategoryBudget",
  split_transaction: "splitTransaction",
  spend_from_finance_goal: "spendFromFinanceGoal",
  reverse_goal_spend: "reverseGoalSpend",
});

const DEFINITIONS = Object.freeze({
  get_safe_to_spend: {
    title: "Get Safe to Spend",
    description:
      "Get liquid USD checking and savings minus positive current credit-card balances and cash-backed goal earmarks. Brokerage and budgets are deliberately excluded. Use the returned formula and warnings; never hide a negative result.",
  },
  list_finance_goals: {
    title: "List finance goals",
    description:
      "List a bounded page of shared-household goals, funding, attributed actual spending, non-negative remaining plan, positive overage, schedules, and shortfalls. Use status archived or all for finished history, purpose to narrow comparisons, and next_cursor to continue. Purpose insights use the full history independently of the returned page. Brokerage earmarks are virtual and never imply a trade or transfer.",
  },
  get_budget_status: {
    title: "Get monthly budget status",
    description:
      "Compare one calendar month's posted category spending against the standing monthly plan. Planned amounts persist until edited; actuals restart each month. Refunds reduce spending, transfers and card payments stay excluded, and budgets never alter Safe to Spend.",
  },
  model_finance_plan: {
    title: "Model finance plan",
    description:
      "Run a deterministic goal-funding and brokerage-change scenario using explicit editable assumptions. This is arithmetic, not investment, tax, or suitability advice.",
  },
  get_transaction_goal_spending: {
    title: "Get transaction goal spending",
    description:
      "Get one transaction's active goal-spending links, unassigned amount, goal versions, and goal_spend_version. Read this immediately before spending from a goal or reversing goal spending; never guess either optimistic version.",
  },
  create_finance_goal: {
    title: "Create finance goal",
    description:
      "Create a shared-household USD goal with a stable purpose for later plan-versus-actual insights. This changes the family plan but does not move money. Confirm the name, purpose, target, and optional date before calling.",
  },
  update_finance_goal: {
    title: "Update finance goal",
    description:
      "Update an existing shared goal using its optimistic version. This changes planning records only and never moves money.",
  },
  allocate_finance_goal: {
    title: "Allocate finance goal",
    description:
      "Add or release a virtual cash or taxable-brokerage earmark using an idempotency key and optimistic goal version. Cash may make Safe to Spend negative; brokerage may not exceed current unallocated taxable-brokerage value. Never describe this as a transfer or trade.",
  },
  set_goal_funding_schedule: {
    title: "Set goal funding schedule",
    description:
      "Create or edit automatic virtual goal attribution monthly or every other Friday. Monthly days 1–31 clamp to month end. The Friday cadence requires an explicit Friday anchor.",
  },
  finish_finance_goal: {
    title: "Finish finance goal",
    description:
      "Finish an active goal as completed or cancelled using its optimistic version. This freezes the plan, preserves attributed transactions and funding history, removes leftover earmarks from active planning, and pauses schedules. A completed goal may be under, exactly on, or over its target.",
  },
  set_category_budget: {
    title: "Set category budget",
    description:
      "Set a category in the current standing monthly plan using the version returned by get_budget_status (0 for a new category). The amount persists until edited and never reserves cash or alters Safe to Spend.",
  },
  split_transaction: {
    title: "Split transaction",
    description:
      "Replace or clear category splits using the split_version returned by list_transactions (0 when never split). Lines must preserve the source sign and sum exactly to the source amount. Provider transaction data remains untouched.",
  },
  spend_from_finance_goal: {
    title: "Spend from finance goal",
    description:
      "Attribute part of a posted USD outflow to an active finance goal. Spending may exceed its remaining earmark or target; usage can exceed 100%, the remaining plan never becomes negative, and the positive overage is reported as over_by. A source overrun consumes the goal's other funding before it becomes unfunded, so finishing an overused goal cannot create fake Safe to Spend. This is virtual attribution, not a payment, transfer, brokerage sale, or trade. Confirm the transaction, goal, source, and amount, then pass exact current versions.",
  },
  reverse_goal_spend: {
    title: "Reverse goal spending",
    description:
      "Reverse one transaction-to-goal spending link while preserving audit history. The reversal reduces actual spending and restores only unused recorded funding; it cannot manufacture an earmark after overspending. Confirm the exact record, then pass current goal and transaction versions.",
  },
});

function validatePlanningService(planningService) {
  if (!planningService || typeof planningService !== "object") {
    throw new TypeError("planningService is required.");
  }
  for (const method of [
    ...Object.values(READ_METHODS),
    ...Object.values(WRITE_METHODS),
  ]) {
    if (typeof planningService[method] !== "function") {
      throw new TypeError(`planningService.${method} must be a function.`);
    }
  }
}

function writeServiceResult(result) {
  return {
    data: {
      change: planningCardValue(result?.changed ?? {}),
      safe_to_spend: result?.safe_to_spend ?? null,
      audit_event_id: result?.audit_event_id ?? null,
    },
    data_as_of: result?.data_as_of,
    display: {
      title: result?.title ?? "Plan changed",
      web_url: "/plan",
    },
    summary: result?.title ?? "Plan changed.",
  };
}

function planningCardValue(value, inheritedCurrency = "USD") {
  if (Array.isArray(value)) {
    return value.map((item) =>
      planningCardValue(item, inheritedCurrency),
    );
  }
  if (!value || typeof value !== "object") return value;
  if (
    Object.keys(value).length === 2 &&
    Number.isSafeInteger(value.amount_minor) &&
    typeof value.currency === "string"
  ) {
    return value;
  }
  const currency =
    typeof value.currency_code === "string"
      ? value.currency_code
      : inheritedCurrency;
  const normalized = {};
  for (const [key, child] of Object.entries(value)) {
    if (key.endsWith("_minor") && Number.isSafeInteger(child)) {
      normalized[key.replace(/_minor$/, "")] = {
        amount_minor: child,
        currency,
      };
    } else {
      normalized[key] = planningCardValue(child, currency);
    }
  }
  return normalized;
}

function fallbackSummary(kind, envelope) {
  switch (kind) {
    case "safe_to_spend":
      return "Safe to Spend is ready.";
    case "goals":
      return `${envelope.data.goals?.length ?? 0} finance goals returned.`;
    case "budget":
      return "Monthly budget status is ready.";
    case "scenario":
      return "Finance plan scenario is ready.";
    case "plan_change":
      return "The family plan was changed.";
    default:
      return "Finance planning data is ready.";
  }
}

function handler({
  toolName,
  planningService,
  write,
  now,
  baseUrl,
}) {
  const kind = write
    ? PLANNING_WRITE_TOOL_KIND_MAP[toolName]
    : PLANNING_READ_TOOL_KIND_MAP[toolName];
  const method = write ? WRITE_METHODS[toolName] : READ_METHODS[toolName];
  return async (input = {}) => {
    let generatedAt;
    try {
      const parsed = parseFinanceToolInput(toolName, input);
      generatedAt = now();
      const writeActor = {
        type: "openwebui",
        id: "openwebui",
      };
      const result = write
        ? typeof planningService.executeIdempotentWrite === "function"
          ? await planningService.executeIdempotentWrite(
              toolName,
              parsed,
              writeActor,
            )
          : await planningService[method](parsed, writeActor)
        : await planningService[method](parsed);
      const serviceResult = write
        ? writeServiceResult(result)
        : {
            ...result,
            data: planningCardValue(result?.data ?? {}),
          };
      const envelope = createFinanceEnvelope({
        kind,
        serviceResult,
        generatedAt,
        baseUrl,
      });
      return createFinanceToolResult({
        summary: serviceResult.summary,
        fallbackSummary: fallbackSummary(kind, envelope),
        envelope,
      });
    } catch (error) {
      const normalized = normalizeFinanceMcpError(error);
      const errorGeneratedAt = generatedAt ?? now();
      const envelope = createFinanceErrorEnvelope({
        kind,
        error: normalized,
        generatedAt: errorGeneratedAt,
        baseUrl,
      });
      const summary = `${normalized.code}: ${normalized.message}`;
      return createFinanceToolResult({
        summary,
        fallbackSummary: summary,
        envelope,
        isError: true,
      });
    }
  };
}

export function registerPlanningTools(
  server,
  {
    planningService,
    accessScope = "read",
    now = () => new Date(),
    baseUrl = "https://money.example.com",
  } = {},
) {
  if (!server || typeof server.registerTool !== "function") {
    throw new TypeError("An MCP server with registerTool is required.");
  }
  validatePlanningService(planningService);

  for (const toolName of PLANNING_READ_TOOL_NAMES) {
    server.registerTool(
      toolName,
      {
        ...DEFINITIONS[toolName],
        inputSchema: FINANCE_TOOL_INPUT_SCHEMAS[toolName],
        outputSchema: FINANCE_TOOL_OUTPUT_SCHEMAS[toolName],
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      handler({
        toolName,
        planningService,
        write: false,
        now,
        baseUrl,
      }),
    );
  }

  if (accessScope !== "plan:write") return server;

  for (const toolName of PLANNING_WRITE_TOOL_NAMES) {
    server.registerTool(
      toolName,
      {
        ...DEFINITIONS[toolName],
        inputSchema: FINANCE_TOOL_INPUT_SCHEMAS[toolName],
        outputSchema: FINANCE_TOOL_OUTPUT_SCHEMAS[toolName],
        annotations: {
          readOnlyHint: false,
          destructiveHint: toolName === "finish_finance_goal",
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      handler({
        toolName,
        planningService,
        write: true,
        now,
        baseUrl,
      }),
    );
  }
  return server;
}

export { DEFINITIONS as PLANNING_TOOL_DEFINITIONS };
