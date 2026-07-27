# Action-first insights

Insights exist to help someone decide what to do next. A finding is not useful
just because a number moved.

## Presentation contract

Every finding shown in the web app has four deterministic pieces:

1. An imperative action title.
2. The exact comparison period.
3. A factual explanation using stored metrics.
4. A direct path to review or fix the underlying data.

Examples include `Spend less on Dining`, `Stop paying avoidable fees`,
`Review VTI concentration`, and `Check whether both Apple subscriptions are
needed`.

The detector owns those words and links. LM Studio never invents an amount,
cause, recommendation, or remedy.

## Lifecycle

- **Active** means the finding still exists in the latest detector run and has
  not been acted on.
- **Archive** hides one occurrence but keeps it in history.
- **Mark as bad** records that the stable pattern was not useful. Later
  occurrences inherit that feedback until restored.
- **Delete** removes the detailed occurrence. A minimal action event may remain
  for auditability, but deletion is not used as model feedback.
- Findings that disappear from a later detector run move into history instead
  of being destroyed.

Feedback sent to LM Studio is aggregated by stable finding key, contains no
transaction evidence or amounts, is limited to recent patterns, and is used
only to rank deterministic actions.

## Investment boundary

Money can currently identify portfolio concentration, allocation movement,
fees, stale prices, missing cost basis, incomplete history, and unusual account
events. It cannot determine that a security is fundamentally overvalued,
unsafe, unsuitable, or should be bought or sold.

Those judgments require a separate trusted market-data and risk layer with
security metadata, benchmark exposure, volatility, drawdown, diversification,
fees, duration, credit quality, and the user's time horizon and risk tolerance.
Until that exists, investment actions stay descriptive: review concentration,
review allocation changes, review fees, or fix missing data.

## LM Studio contract

The model receives at most a small set of deterministic candidates plus a
bounded feedback summary. It returns only one to three known finding IDs in
priority order. The server renders the selected findings' existing action
titles, details, periods, and links.

No growing conversation history or giant system prompt is required.
