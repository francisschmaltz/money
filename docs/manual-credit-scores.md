# Manual credit-score tracking

Money tracks credit scores entered by workspace members. These values are
planning data, not credit reports and not lender or underwriting scores.

## Calculation

- A source belongs to one workspace member and has a label plus optional
  bureau and scoring model.
- An observation is a whole-number score from 300 through 850 on an ISO date.
- `(source_id, observed_on)` is unique. Saving the same date again corrects
  that observation instead of creating a duplicate.
- A person's current average uses the latest observation from every active
  source.
- The household average gives each scored person equal weight. It does not
  flatten every source into one pool.
- Calculations use unrounded person averages and round only displayed scores
  and changes.
- Values older than 90 days remain included and are marked stale.
- History carries each source's latest value forward from its first
  observation until the source's archive date. Archiving removes the source
  from current averages without deleting its earlier contribution.
- Sources with matching bureau/model labels count independently and produce a
  possible-duplicate warning.
- Household history is bounded to 80 points.

## Presets

The page offers American Express, Credit Karma–Equifax, Credit
Karma–TransUnion, Equifax, Experian, TransUnion, myFICO, and custom sources.
Labels, bureaus, and models remain editable because providers can change what
they show.

## REST API

All routes require a signed-in browser session. Mutations also require the
normal CSRF token.

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/credit-scores?period=1y` | Shared household, people, source freshness, and bounded history |
| `POST` | `/api/v1/credit-score-sources` | Create a source owned by the signed-in member |
| `PUT` | `/api/v1/credit-score-sources/:sourceId` | Edit the signed-in member's source |
| `DELETE` | `/api/v1/credit-score-sources/:sourceId` | Archive the signed-in member's source |
| `PUT` | `/api/v1/credit-score-sources/:sourceId/observations/:observedOn` | Add or correct one dated score |

Mutation bodies never choose an owner. The service and repository scope writes
with the authenticated member ID, and another member's source returns an
authorization failure.

## MCP

`get_credit_score_summary` is read-only and accepts:

```json
{"period":"1y"}
```

`period` may be `1m`, `1y`, or `all`; the default is `1y`. The result uses the
`credit_score` finance-card kind and retains the existing 20 KB envelope cap.
It includes manual provenance, bureau/model labels, current observation dates,
stale state, calculation methodology, and no more than 80 historical points.

MCP output replaces member names with `Person 1`, `Person 2`, and so on. It
does not expose emails, member/source IDs, or mutation controls. Its
instructions explicitly forbid turning the tracking average into a lender
score, approval prediction, or quoted interest rate.
