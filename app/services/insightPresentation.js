import { formatMinorMoney } from "../currency.js";

const PURE_CONTEXT_TYPES = new Set([
  "performance",
  "holding_value_contribution",
]);

const INVESTMENT_RISK_TYPES = new Set([
  "allocation_change",
  "concentration",
  "fees",
  "holdings_changed",
  "incomplete_history",
  "missing_cost_basis",
  "stale_pricing",
]);

const REVIEW_NOW_TYPES = new Set([
  "irregular",
  "needs_review",
  "new",
  "possible_duplicate",
  "price_increase",
  "resumed",
]);

export function presentInsightForWeb(
  finding,
  { family = finding.family, timeframe = finding.timeframe } = {},
) {
  const typeKey = insightTypeKey(finding);
  const state = finding.state ?? "active";
  const actions = normalizeActions(finding.actions);
  const actionTitle =
    finding.actionTitle ??
    deterministicActionTitle({ ...finding, typeKey, family });
  const detail =
    finding.detail ??
    finding.copy ??
    deterministicActionDetail({ ...finding, typeKey, family }) ??
    finding.explanation ??
    "";
  const solveAction =
    normalizeSolveAction(finding.solveAction) ??
    deterministicSolveAction({ ...finding, typeKey, family }, actions);

  return {
    ...finding,
    family,
    typeKey,
    type: displayType(finding, typeKey),
    state,
    isCurrent:
      finding.isCurrent ?? finding.is_current ?? state === "active",
    actionTitle,
    detail,
    copy: detail,
    timeframe: timeframe ?? insightTimeframeFromFinding(finding, family),
    solveAction,
    lifecycleLabel: lifecycleLabel(state),
    bucket: insightBucket({ ...finding, typeKey, family }),
    isDemoted: PURE_CONTEXT_TYPES.has(typeKey),
    actions,
    generatedAt: finding.generatedAt ?? finding.generated_at ?? null,
  };
}

export function insightBucket(finding) {
  const typeKey = insightTypeKey(finding);
  const family = finding.family;
  if (PURE_CONTEXT_TYPES.has(typeKey)) return "context";
  if (family === "investments" || INVESTMENT_RISK_TYPES.has(typeKey)) {
    return "investment_risk";
  }
  if (typeKey === "spend_less" || typeKey === "expensive") {
    return "spend_less";
  }
  if (typeKey === "better_habits") return "change_habit";
  if (REVIEW_NOW_TYPES.has(typeKey)) return "review_now";
  if (family === "subscriptions") return "review_now";
  return "review_now";
}

export function lifecycleLabel(state) {
  return {
    active: "Active",
    archived: "Archived",
    bad: "Incorrect",
    dismissed: "Ignored",
    resolved: "Resolved",
  }[state] ?? humanize(state);
}

function deterministicActionTitle(finding) {
  const title = String(finding.title ?? "").trim();
  if (isImperative(title)) return title;

  const typeKey = finding.typeKey;
  if (typeKey === "spend_less") {
    const category = capture(title, /^Spending rose in (.+)$/i);
    const merchant = capture(title, /^Spending rose at (.+)$/i);
    if (category) return `Spend less on ${category}`;
    if (merchant) return `Spend less at ${merchant}`;
    return "Cut back on this spending";
  }
  if (typeKey === "better_habits") {
    const merchant = capture(title, /^More frequent spending at (.+)$/i);
    const category = capture(title, /^Similar (.+) purchases clustered$/i);
    if (merchant) return `Make fewer stops at ${merchant}`;
    if (/convenience spending/i.test(title)) {
      return "Cut back on convenience spending";
    }
    if (/fees? or interest/i.test(title)) {
      return "Stop paying avoidable fees";
    }
    if (category) return `Break up repeated ${lowerFirst(category)} spending`;
    return "Change this spending habit";
  }
  if (typeKey === "needs_review") {
    const merchant = capture(title, /^(.+) charge needs a look$/i);
    const category = capture(title, /^One charge drove (.+)$/i);
    if (merchant) return `Review the ${merchant} charge`;
    if (category) return `Review the charge driving ${category}`;
    return "Review this unusual charge";
  }
  if (typeKey === "concentration") {
    const holding = capture(title, /^(.+) is a concentrated position$/i);
    return holding
      ? `Review ${holding} concentration`
      : "Review portfolio concentration";
  }
  if (typeKey === "allocation_change") {
    const holding = capture(title, /^(.+) allocation moved meaningfully$/i);
    return holding
      ? `Review ${holding}’s allocation change`
      : "Review the allocation change";
  }
  if (typeKey === "holdings_changed") return "Review recent holding changes";
  if (typeKey === "fees") return "Review investment fees";
  if (typeKey === "stale_pricing") return "Fix stale investment pricing";
  if (typeKey === "missing_cost_basis") return "Fill in missing cost basis";
  if (typeKey === "incomplete_history") {
    return "Review incomplete investment history";
  }
  if (typeKey === "possible_duplicate") {
    const service =
      finding.metrics?.service ??
      capture(title, /^Possible duplicate (.+) subscriptions$/i);
    return service
      ? `Check whether you need both ${service} subscriptions`
      : "Check these possible duplicate subscriptions";
  }
  if (typeKey === "expensive") {
    const service =
      finding.metrics?.service ??
      capture(title, /^(.+) is an expensive subscription$/i);
    return service
      ? `Decide whether ${service} is worth it`
      : "Decide whether this subscription is worth it";
  }
  if (typeKey === "price_increase") {
    const service =
      finding.metrics?.service ??
      capture(title, /^(.+) price increased$/i);
    return service
      ? `Review ${service}’s price increase`
      : "Review this subscription price increase";
  }
  if (["new", "resumed", "irregular"].includes(typeKey)) {
    const service =
      finding.metrics?.service ??
      capture(title, /^(.+) is (?:new|resumed|irregular)$/i);
    return service
      ? `Confirm the ${service} subscription`
      : "Confirm this subscription";
  }
  if (typeKey === "canceled") {
    const service =
      finding.metrics?.service ??
      capture(title, /^(.+) is canceled$/i);
    return service
      ? `Confirm ${service} was canceled`
      : "Confirm this subscription was canceled";
  }
  return title || "Review this finding";
}

function deterministicActionDetail(finding) {
  const metrics = finding.metrics ?? {};
  const typeKey = finding.typeKey;
  if (typeKey === "spend_less" && metrics.change?.amount_minor != null) {
    const change = formatAbsoluteMoney(metrics.change);
    const current = formatAbsoluteMoney(metrics.current);
    const previous = formatAbsoluteMoney(metrics.previous);
    return `You spent ${change} more in this area than in the prior period: ${current} versus ${previous}.`;
  }
  if (typeKey === "better_habits" && metrics.current_transaction_count != null) {
    const total = formatAbsoluteMoney(metrics.current);
    const count = metrics.current_transaction_count;
    const difference = metrics.transaction_count_change;
    return `${count} purchase${count === 1 ? "" : "s"} totaled ${total}${
      Number.isSafeInteger(difference) && difference !== 0
        ? `, ${Math.abs(difference)} ${difference > 0 ? "more" : "fewer"} than the prior period`
        : ""
    }.`;
  }
  if (typeKey === "concentration" && metrics.allocation_basis_points != null) {
    const allocation = formatBasisPoints(metrics.allocation_basis_points);
    const threshold = formatBasisPoints(
      finding.rule?.threshold_basis_points,
    );
    return `This holding is ${allocation} of the portfolio${
      threshold ? `, above the ${threshold} concentration marker` : ""
    }. This is descriptive, not a trade recommendation.`;
  }
  if (typeKey === "possible_duplicate") {
    const monthly = formatAbsoluteMoney(metrics.combined_monthly);
    const annual = formatAbsoluteMoney(metrics.combined_annual);
    if (monthly && annual) {
      return `The overlapping subscriptions cost about ${monthly} per month, or ${annual} per year.`;
    }
  }
  if (typeKey === "expensive") {
    const monthly = formatAbsoluteMoney(metrics.monthly);
    const annual = formatAbsoluteMoney(metrics.annual);
    if (monthly && annual) {
      return `This subscription costs ${monthly} per month, or ${annual} per year.`;
    }
  }
  if (typeKey === "price_increase") {
    const latest = formatAbsoluteMoney(metrics.latest_amount);
    const previous = formatAbsoluteMoney(metrics.previous_amount);
    const change = formatAbsoluteMoney(metrics.change);
    if (latest && previous && change) {
      return `The latest charge was ${latest}, up ${change} from the recent ${previous} amount.`;
    }
  }
  return finding.explanation ?? null;
}

function deterministicSolveAction(finding, actions) {
  const usefulAction =
    actions.find(
      (action) =>
        action.webUrl &&
        !/\/insights\/?$/.test(new URL(action.webUrl, "https://money.local").pathname),
    ) ??
    actions.find((action) => action.webUrl) ??
    null;
  const webUrl =
    usefulAction?.webUrl ??
    (finding.id
      ? `/insights?finding=${encodeURIComponent(finding.id)}`
      : "/insights");
  return {
    type: "link",
    label: solveLabel(finding.typeKey, finding.family),
    webUrl: sameHostPath(webUrl),
  };
}

function solveLabel(typeKey, family) {
  if (typeKey === "spend_less") return "Review spending";
  if (typeKey === "better_habits") return "Review purchases";
  if (typeKey === "needs_review") return "Review transaction";
  if (family === "investments") return "View portfolio";
  if (family === "subscriptions") return "Review subscriptions";
  return "See what changed";
}

function normalizeActions(actions) {
  if (!Array.isArray(actions)) return [];
  return actions.map((action) => ({
    type: action.type,
    label: action.label ?? humanize(action.type),
    webUrl: action.webUrl ?? action.web_url ?? null,
  }));
}

function normalizeSolveAction(action) {
  if (!action) return null;
  return {
    type: action.type ?? "link",
    label: action.label ?? "Review",
    webUrl: action.webUrl ?? action.web_url ?? "/insights",
  };
}

function sameHostPath(value) {
  try {
    const url = new URL(value, "https://money.local");
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/insights";
  }
}

function insightTypeKey(finding) {
  return String(
    finding.typeKey ?? finding.finding_type ?? finding.type ?? "review",
  )
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function displayType(finding, typeKey) {
  if (finding.typeKey && finding.type) return finding.type;
  return humanize(typeKey);
}

function insightTimeframeFromFinding(finding, family) {
  if (finding.period_start && finding.period_end) {
    return `${compactDate(finding.period_start)}–${compactDate(
      shiftDate(finding.period_end, -1),
    )}`;
  }
  if (family === "investments") return "Last 1 month";
  if (family === "subscriptions") return "Current active subscriptions";
  return "Latest completed period";
}

function compactDate(value) {
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(date);
}

function shiftDate(value, days) {
  const date = new Date(`${String(value).slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return value;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatAbsoluteMoney(value) {
  if (!value || !Number.isSafeInteger(value.amount_minor)) return null;
  return formatMinorMoney({
    ...value,
    amount_minor: Math.abs(value.amount_minor),
  });
}

function formatBasisPoints(value) {
  return Number.isSafeInteger(value)
    ? `${(Math.abs(value) / 100).toFixed(1)}%`
    : null;
}

function isImperative(title) {
  return /^(break|check|confirm|cut|decide|fill|fix|make|reduce|review|spend|stop)\b/i.test(
    title,
  );
}

function capture(value, pattern) {
  return value.match(pattern)?.[1]?.trim() ?? null;
}

function humanize(value) {
  return String(value ?? "")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

function lowerFirst(value) {
  return value ? `${value[0].toLowerCase()}${value.slice(1)}` : value;
}
