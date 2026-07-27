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
});

const WRITE_METHODS = Object.freeze({
  create_finance_goal: "createFinanceGoal",
  update_finance_goal: "updateFinanceGoal",
  allocate_finance_goal: "allocateFinanceGoal",
  set_goal_funding_schedule: "setGoalFundingSchedule",
  archive_finance_goal: "archiveFinanceGoal",
  set_category_budget: "setCategoryBudget",
  split_transaction: "splitTransaction",
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
      "List shared-household goals, cash and taxable-brokerage earmarks, effective brokerage backing after market changes, progress, schedules, and shortfalls. Brokerage earmarks are virtual and never imply a trade or transfer.",
  },
  get_budget_status: {
    title: "Get monthly budget status",
    description:
      "Compare posted category spending against the independent plan for one calendar month. Refunds reduce spending; transfers and card payments stay excluded; budgets never alter Safe to Spend and never roll over.",
  },
  model_finance_plan: {
    title: "Model finance plan",
    description:
      "Run a deterministic goal-funding and brokerage-change scenario using explicit editable assumptions. This is arithmetic, not investment, tax, or suitability advice.",
  },
  create_finance_goal: {
    title: "Create finance goal",
    description:
      "Create a shared-household USD goal. This changes the family plan but does not move money. Confirm the name, target, and optional date with the user before calling.",
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
  archive_finance_goal: {
    title: "Archive finance goal",
    description:
      "Archive a zero-earmark goal using its optimistic version and pause its active schedules. Release allocations first.",
  },
  set_category_budget: {
    title: "Set category budget",
    description:
      "Set one category for one selected month, or explicitly set a separate future-month default. Budgets are scoreboards and never reserve cash or roll over.",
  },
  split_transaction: {
    title: "Split transaction",
    description:
      "Replace or clear category splits for one posted transaction. Lines must preserve the source sign and sum exactly to the source amount. Provider transaction data remains untouched.",
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
      goals: planningCardValue(
        Array.isArray(result?.goals) ? result.goals : [],
      ),
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
          destructiveHint: toolName === "archive_finance_goal",
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
