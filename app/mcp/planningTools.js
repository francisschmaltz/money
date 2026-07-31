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
import { financeCardValue } from "./units.js";

const READ_METHODS = Object.freeze({
  get_safe_to_spend: "getSafeToSpend",
  list_finance_goals: "listFinanceGoals",
  get_finance_goal: "getFinanceGoal",
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
  clear_category_budget: "clearCategoryBudget",
  set_budget_income_categories: "setBudgetIncomeCategories",
  split_transaction: "splitTransaction",
  spend_from_finance_goal: "spendFromFinanceGoal",
  reverse_goal_spend: "reverseGoalSpend",
});

const DEFINITIONS = Object.freeze({
  get_safe_to_spend: {
    title: "Get Safe to Spend",
    description:
      "Get only the current Safe to Spend amount, calculation factors, bills expected in the next 30 days, alerts, and IDs of cash-backed goals. Subscriptions are excluded; bill dates and amounts are estimates from recurring history. Use get_finance_goal for a contributing goal's details.",
  },
  list_finance_goals: {
    title: "List finance goals",
    description:
      "List a bounded page of compact shared-household goal records for discovery. Use each returned ID with get_finance_goal for funding, spending, schedules, and history.",
  },
  get_finance_goal: {
    title: "Get finance goal",
    description:
      "Get one active or finished goal by ID with its target, funding, attributed spending, remaining plan, overage, schedules, brokerage backing, optimistic version, history, and alerts.",
  },
  get_budget_status: {
    title: "Get monthly budget status",
    description:
      "Return the selected hierarchical budget tree with taxonomy-wide direct and subtree actuals, effective tracking modes, optimistic versions, rolling four-completed-month income, estimated and actual leftover, and plan status. Refunds reduce spending; pending, excluded, and card-payment transactions stay out; provider transfers stay out unless explicitly marked Include in spending. Goal-attributed portions are netted from monthly Plan actuals but remain in transaction and goal history; unbudgeted spending still reduces actual leftover.",
  },
  model_finance_plan: {
    title: "Model finance plan",
    description:
      "Run a deterministic goal-funding and brokerage percentage-change scenario using explicit editable assumptions. This does not model a Safe-to-Spend after-state and is not investment, tax, or suitability advice.",
  },
  get_transaction_goal_spending: {
    title: "Get transaction goal spending",
    description:
      "Get one transaction's effective goal-spending eligibility, active links, unassigned amount, goal versions, and goal_spend_version. A posted USD outflow explicitly marked Include in spending is eligible even when its provider labels it a transfer. Read this immediately before spending from a goal or reversing goal spending; never guess either optimistic version.",
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
      "Add or update a taxonomy category in the current standing monthly plan by category_id, even when it has no transactions. Use the version returned by get_budget_status (0 for a new category), choose tracked or informational, add ancestors before children, and keep direct child allocations within the parent envelope. The amount persists until edited and never reserves cash or alters Safe to Spend.",
  },
  clear_category_budget: {
    title: "Clear category budget",
    description:
      "Remove a category from the current standing budget using the version returned by get_budget_status. If it has selected descendants, inspect them first and pass confirm_descendants=true to cascade. Historical months remain intact.",
  },
  set_budget_income_categories: {
    title: "Set budget income categories",
    description:
      "Replace the category subtrees used to calculate four-completed-month average income and actual monthly income. Income categories cannot also be expense budgets.",
  },
  split_transaction: {
    title: "Split transaction",
    description:
      "Replace or clear category splits using the split_version returned by list_transactions (0 when never split). Lines must preserve the source sign and sum exactly to the source amount. Provider transaction data remains untouched.",
  },
  spend_from_finance_goal: {
    title: "Spend from finance goal",
    description:
      "Attribute part of a posted USD outflow, including a provider-labeled transfer explicitly marked Include in spending, to an active finance goal. The attributed portion stops counting against monthly Plan actuals but remains in transaction and goal history. Spending may exceed its remaining earmark or target; usage can exceed 100%, the remaining plan never becomes negative, and the positive overage is reported as over_by. A source overrun consumes the goal's other funding before it becomes unfunded, so finishing an overused goal cannot create fake Safe to Spend. This is virtual attribution, not a payment, transfer, brokerage sale, or trade. Confirm the transaction, goal, source, and amount, then pass exact current versions.",
  },
  reverse_goal_spend: {
    title: "Reverse goal spending",
    description:
      "Reverse one transaction-to-goal spending link while preserving audit history. The reversal reduces goal actual spending, restores the attributed portion to monthly Plan actuals, and restores only unused recorded funding; it cannot manufacture an earmark after overspending. Confirm the exact record, then pass current goal and transaction versions.",
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
      change: result?.changed ?? {},
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

function goalWarningFlags(goal) {
  return [
    ...(goal?.brokerage_under_backed
      ? ["brokerage_under_backed"]
      : []),
    ...((goal?.over_by?.amount_minor ?? 0) > 0
      ? ["over_target"]
      : []),
    ...((goal?.unfunded_spend?.amount_minor ?? 0) > 0
      ? ["unfunded_spend"]
      : []),
  ];
}

function compactGoal(goal) {
  return {
    id: goal.id,
    name: goal.name,
    purpose: goal.purpose,
    status: goal.status,
    target_on: goal.target_on ?? null,
    progress_basis_points: goal.progress_basis_points ?? 0,
    version: Number(goal.version),
    warning_flags: goalWarningFlags(goal),
  };
}

function safeToSpendServiceResult(serviceResult) {
  const snapshot = serviceResult?.data ?? {};
  const goalIds = (snapshot.goals ?? [])
    .filter(
      (goal) =>
        (goal?.cash_earmarked?.amount_minor ??
          goal?.cash_earmarked_minor ??
          0) > 0,
    )
    .map((goal) => goal.id);
  const boundedGoalIds = goalIds.slice(0, 50);
  return {
    ...serviceResult,
    data: {
      safe_to_spend: snapshot.safe_to_spend,
      status:
        (snapshot.safe_to_spend?.amount_minor ?? 0) < 0
          ? "negative"
          : "available",
      formula: snapshot.formula,
      calculation: {
        factors: [
          "liquid_cash",
          "current_credit_card_balances",
          "expected_bills",
          "cash_backed_goals",
        ],
        expected_bills_through_on:
          snapshot.expected_bills_through_on,
        expected_bill_occurrence_count:
          snapshot.expected_bill_occurrence_count ?? 0,
        excluded_expected_bill_count:
          snapshot.excluded_expected_bill_count ?? 0,
        contributing_goal_count: goalIds.length,
        contributing_goal_ids: boundedGoalIds,
        contributing_goal_ids_truncated:
          goalIds.length > boundedGoalIds.length,
      },
      alerts: snapshot.alerts ?? [],
    },
  };
}

function goalListServiceResult(serviceResult) {
  const data = serviceResult?.data ?? {};
  return {
    ...serviceResult,
    data: {
      goals: (data.goals ?? []).map(compactGoal),
      page_info: data.page_info,
    },
  };
}

function scenarioServiceResult(serviceResult) {
  const data = { ...(serviceResult?.data ?? {}) };
  delete data.safe_to_spend_after;
  return { ...serviceResult, data };
}

function preparePlanningServiceResult(toolName, serviceResult, write) {
  if (write) return writeServiceResult(serviceResult);
  if (toolName === "get_safe_to_spend") {
    return safeToSpendServiceResult(serviceResult);
  }
  if (toolName === "list_finance_goals") {
    return goalListServiceResult(serviceResult);
  }
  if (toolName === "model_finance_plan") {
    return scenarioServiceResult(serviceResult);
  }
  return serviceResult;
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
      const prepared = preparePlanningServiceResult(
        toolName,
        result,
        write,
      );
      const serviceResult = {
        ...prepared,
        data: financeCardValue(prepared?.data ?? {}),
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
          destructiveHint: [
            "finish_finance_goal",
            "clear_category_budget",
          ].includes(toolName),
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
