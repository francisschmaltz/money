import { dateOnly, shiftDateOnly } from "./analytics.js";

export const CREDIT_SCORE_PRESETS = Object.freeze([
  Object.freeze({
    key: "american_express",
    label: "American Express",
    bureau: "Experian",
    model: "FICO Score 8",
  }),
  Object.freeze({
    key: "credit_karma_equifax",
    label: "Credit Karma–Equifax",
    bureau: "Equifax",
    model: "VantageScore 3.0",
  }),
  Object.freeze({
    key: "credit_karma_transunion",
    label: "Credit Karma–TransUnion",
    bureau: "TransUnion",
    model: "VantageScore 3.0",
  }),
  Object.freeze({
    key: "equifax",
    label: "Equifax",
    bureau: "Equifax",
    model: null,
  }),
  Object.freeze({
    key: "experian",
    label: "Experian",
    bureau: "Experian",
    model: null,
  }),
  Object.freeze({
    key: "transunion",
    label: "TransUnion",
    bureau: "TransUnion",
    model: null,
  }),
  Object.freeze({
    key: "myfico",
    label: "myFICO",
    bureau: null,
    model: "FICO",
  }),
  Object.freeze({
    key: "custom",
    label: "Custom source",
    bureau: null,
    model: null,
  }),
]);

const STALE_AFTER_DAYS = 90;

function normalizedDate(value) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value ?? "").slice(0, 10);
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function scorePeriod(value, currentOn) {
  const name = ["1w", "1m", "1y", "all"].includes(value) ? value : "1y";
  return {
    name,
    label: {
      "1w": "Last week",
      "1m": "Last month",
      "1y": "Last year",
      all: "All history",
    }[name],
    start_on:
      name === "1w"
        ? shiftDateOnly(currentOn, -7)
        : name === "1m"
          ? shiftDateOnly(currentOn, -30)
          : name === "1y"
            ? shiftDateOnly(currentOn, -365)
            : "1970-01-01",
    end_on: shiftDateOnly(currentOn, 1),
  };
}

function sampleHistory(points, maximum = 80) {
  if (points.length <= maximum) return points;
  const lastIndex = points.length - 1;
  const indexes = new Set([0, lastIndex]);
  for (let index = 1; index < maximum - 1; index += 1) {
    indexes.add(Math.round((index * lastIndex) / (maximum - 1)));
  }
  return [...indexes]
    .sort((left, right) => left - right)
    .map((index) => points[index]);
}

function latestAt(observations, onDate) {
  let latest = null;
  for (const observation of observations) {
    if (observation.observed_on > onDate) break;
    latest = observation;
  }
  return latest;
}

function activeAt(source, onDate) {
  return !source.archived_on || onDate < source.archived_on;
}

function personAverageAt(personSources, observationsBySource, onDate) {
  const scores = personSources
    .filter((source) => activeAt(source, onDate))
    .map((source) =>
      latestAt(observationsBySource.get(source.id) ?? [], onDate),
    )
    .filter(Boolean)
    .map((observation) => observation.score);
  return average(scores);
}

function duplicateGroups(sources) {
  const groups = new Map();
  for (const source of sources) {
    if (!source.bureau && !source.model) continue;
    const key = [
      source.bureau?.trim().toLowerCase() ?? "",
      source.model?.trim().toLowerCase() ?? "",
    ].join("|");
    const group = groups.get(key) ?? [];
    group.push(source);
    groups.set(key, group);
  }
  return [...groups.values()].filter((group) => group.length > 1);
}

function normalizeSource(source) {
  return {
    id: String(source.id),
    user_id: String(source.user_id),
    label: String(source.label),
    bureau: source.bureau ? String(source.bureau) : null,
    model:
      (source.model ?? source.scoring_model)
        ? String(source.model ?? source.scoring_model)
        : null,
    archived_on: source.archived_on
      ? normalizedDate(source.archived_on)
      : null,
  };
}

function normalizeObservation(observation) {
  return {
    id: String(observation.id),
    source_id: String(observation.source_id),
    score: Number(observation.score),
    observed_on: normalizedDate(observation.observed_on),
  };
}

function displayName(member, index) {
  const name = String(
    member.display_name ?? member.name ?? "",
  ).trim();
  return name || `Person ${index + 1}`;
}

function privateForMcp(data) {
  const orderedPeople = [...data.people].sort((left, right) =>
    left.person_id.localeCompare(right.person_id),
  );
  const labels = new Map(
    orderedPeople.map((person, index) => [
      person.person_id,
      `Person ${index + 1}`,
    ]),
  );
  return {
    ...data,
    disclosure:
      "Scores are manually supplied, shared with the Money workspace and its MCP, and are not lender or underwriting scores.",
    history: data.history.map((point) => ({
      ...point,
      person_scores: point.person_scores.map(
        ({ person_id: personId, ...score }) => ({
          person_label: labels.get(personId),
          ...score,
        }),
      ),
    })),
    people: orderedPeople.map((person) => ({
      person_label: labels.get(person.person_id),
      average_score: person.average_score,
      latest_observed_on: person.latest_observed_on,
      active_source_count: person.active_source_count,
      scored_source_count: person.scored_source_count,
      stale_source_count: person.stale_source_count,
      possible_duplicate_source_count:
        person.possible_duplicate_source_count,
      sources: person.sources.map((source) => ({
        label: source.label,
        bureau: source.bureau,
        model: source.model,
        score: source.score,
        observed_on: source.observed_on,
        stale: source.stale,
      })),
    })),
    warnings: data.warnings.map((warning) => ({
      code: warning.code,
      message: warning.person_id
        ? warning.message.replace(
            warning.person_name,
            labels.get(warning.person_id),
          )
        : warning.message,
    })),
  };
}

export function buildCreditScoreSummary({
  members = [],
  sources = [],
  observations = [],
  currentOn = dateOnly(new Date()),
  period = "1y",
  currentUserId = null,
  forMcp = false,
} = {}) {
  const normalizedCurrentOn = normalizedDate(currentOn);
  const selectedPeriod = scorePeriod(period, normalizedCurrentOn);
  const normalizedSources = sources.map(normalizeSource);
  const sourceIds = new Set(normalizedSources.map((source) => source.id));
  const normalizedObservations = observations
    .map(normalizeObservation)
    .filter(
      (observation) =>
        sourceIds.has(observation.source_id) &&
        observation.observed_on <= normalizedCurrentOn &&
        Number.isInteger(observation.score) &&
        observation.score >= 300 &&
        observation.score <= 850,
    )
    .sort((left, right) =>
      left.observed_on.localeCompare(right.observed_on) ||
      left.id.localeCompare(right.id),
    );
  const observationsBySource = new Map();
  for (const observation of normalizedObservations) {
    const list = observationsBySource.get(observation.source_id) ?? [];
    list.push(observation);
    observationsBySource.set(observation.source_id, list);
  }

  const memberRows = members.map((member) => ({
    id: String(member.id ?? member.user_id),
    display_name: member.display_name ?? member.name ?? null,
  }));
  for (const source of normalizedSources) {
    if (!memberRows.some((member) => member.id === source.user_id)) {
      memberRows.push({ id: source.user_id, display_name: null });
    }
  }

  const staleBefore = shiftDateOnly(normalizedCurrentOn, -STALE_AFTER_DAYS);
  const warnings = [];
  const people = memberRows.map((member, memberIndex) => {
    const personName = displayName(member, memberIndex);
    const personSources = normalizedSources.filter(
      (source) => source.user_id === member.id,
    );
    const activeSources = personSources.filter((source) =>
      activeAt(source, normalizedCurrentOn),
    );
    const sourcesWithScores = activeSources.map((source) => {
      const sourceObservations =
        observationsBySource.get(source.id) ?? [];
      const latest = latestAt(
        sourceObservations,
        normalizedCurrentOn,
      );
      return {
        source_id: source.id,
        label: source.label,
        bureau: source.bureau,
        model: source.model,
        score: latest?.score ?? null,
        observed_on: latest?.observed_on ?? null,
        stale: Boolean(latest && latest.observed_on < staleBefore),
        observations: sourceObservations
          .toReversed()
          .slice(0, 20)
          .map((observation) => ({
            score: observation.score,
            observed_on: observation.observed_on,
          })),
      };
    });
    const scoredSources = sourcesWithScores.filter(
      (source) => source.score != null,
    );
    const latestObservedOn =
      scoredSources
        .map((source) => source.observed_on)
        .filter(Boolean)
        .sort()
        .at(-1) ?? null;
    const duplicates = duplicateGroups(activeSources);
    if (duplicates.length) {
      warnings.push({
        code: "possible_duplicate_score_sources",
        message: `${personName} has active sources with the same bureau and model. They are counted independently.`,
        person_id: member.id,
        person_name: personName,
      });
    }
    return {
      person_id: member.id,
      person_name: personName,
      can_manage: member.id === currentUserId,
      average_score:
        scoredSources.length
          ? Math.round(average(scoredSources.map((source) => source.score)))
          : null,
      latest_observed_on: latestObservedOn,
      active_source_count: activeSources.length,
      scored_source_count: scoredSources.length,
      stale_source_count: scoredSources.filter((source) => source.stale)
        .length,
      possible_duplicate_source_count: duplicates.reduce(
        (total, group) => total + group.length,
        0,
      ),
      sources: sourcesWithScores,
    };
  });

  const contributorAverages = memberRows
    .map((member) =>
      personAverageAt(
        normalizedSources.filter(
          (source) => source.user_id === member.id,
        ),
        observationsBySource,
        normalizedCurrentOn,
      ),
    )
    .filter((value) => value != null);
  const householdAverage = average(contributorAverages);
  const allObservationDates = normalizedObservations.map(
    (observation) => observation.observed_on,
  );
  const firstObservationOn = allObservationDates[0] ?? null;
  const effectiveStart =
    firstObservationOn == null
      ? null
      : firstObservationOn > selectedPeriod.start_on
        ? firstObservationOn
        : selectedPeriod.start_on;
  const historyDates = new Set();
  if (effectiveStart) historyDates.add(effectiveStart);
  historyDates.add(normalizedCurrentOn);
  for (const observation of normalizedObservations) {
    if (
      effectiveStart &&
      observation.observed_on >= effectiveStart &&
      observation.observed_on <= normalizedCurrentOn
    ) {
      historyDates.add(observation.observed_on);
    }
  }
  for (const source of normalizedSources) {
    if (
      source.archived_on &&
      effectiveStart &&
      source.archived_on >= effectiveStart &&
      source.archived_on <= normalizedCurrentOn
    ) {
      historyDates.add(source.archived_on);
    }
  }
  const historyWithRawAverages = [...historyDates]
    .filter((onDate) => effectiveStart && onDate >= effectiveStart)
    .sort()
    .map((onDate) => {
      const personScores = memberRows.map((member) => ({
        person_id: member.id,
        raw_average: personAverageAt(
          normalizedSources.filter(
            (source) => source.user_id === member.id,
          ),
          observationsBySource,
          onDate,
        ),
      }));
      const averages = personScores
        .map((person) => person.raw_average)
        .filter((value) => value != null);
      const household = average(averages);
      return {
        date: onDate,
        raw_average: household,
        average_score:
          household == null ? null : Math.round(household),
        contributor_count: averages.length,
        person_scores: personScores.map(
          ({ person_id: personId, raw_average: rawAverage }) => ({
            person_id: personId,
            average_score:
              rawAverage == null ? null : Math.round(rawAverage),
          }),
        ),
      };
    });
  const boundedHistoryWithRawAverages = sampleHistory(
    historyWithRawAverages,
    80,
  );
  const firstComparable = boundedHistoryWithRawAverages.find(
    (point) => point.raw_average != null,
  );
  const boundedHistory = boundedHistoryWithRawAverages.map(
    ({ raw_average: _rawAverage, ...point }) => point,
  );
  const change =
    householdAverage != null &&
    firstComparable &&
    boundedHistory.length > 1
      ? Math.round(householdAverage - firstComparable.raw_average)
      : null;
  const staleSourceCount = people.reduce(
    (total, person) => total + person.stale_source_count,
    0,
  );
  if (staleSourceCount) {
    warnings.unshift({
      code: "stale_credit_scores",
      message: `${staleSourceCount} current score source${
        staleSourceCount === 1 ? " is" : "s are"
      } older than 90 days but remain included.`,
    });
  }

  const data = {
    provenance: "manual",
    disclosure:
      "Scores are manually supplied and visible to everyone in the Money workspace and its MCP. The household average is a tracking metric, not a lender or underwriting score.",
    period: selectedPeriod,
    household: {
      average_score:
        householdAverage == null ? null : Math.round(householdAverage),
      change,
      contributor_count: contributorAverages.length,
      member_count: memberRows.length,
      active_source_count: people.reduce(
        (total, person) => total + person.active_source_count,
        0,
      ),
      scored_source_count: people.reduce(
        (total, person) => total + person.scored_source_count,
        0,
      ),
      stale_source_count: staleSourceCount,
    },
    people,
    history: boundedHistory,
    warnings,
    methodology: {
      source_average:
        "Each person is averaged from the latest observation for every active source.",
      household_average:
        "People with scores receive equal weight regardless of source count. Rounding happens only for display.",
      history:
        "Each source carries its latest observation forward from its first entry until archival.",
      staleness:
        "Scores older than 90 days remain included and are marked stale.",
      duplicate_sources:
        "Sources with the same bureau and model count independently and are flagged as possible duplicates.",
      lender_use:
        "This tracking average is not a lender score, approval prediction, or quoted interest rate.",
    },
  };
  return forMcp ? privateForMcp(data) : data;
}
