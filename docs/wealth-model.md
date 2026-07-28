# Wealth totals and account groups

Money uses three totals because one generic “assets minus liabilities” number
hides the difference between money available soon and long-term wealth.

## Totals

All aggregate totals use the workspace base currency, currently USD.
Non-USD accounts and assets remain visible but are excluded from these totals
until currency conversion exists.

```text
Cash Balance
  = checking
  + savings
  + cash-management accounts
  + taxable/personal brokerage accounts

Short-Term Worth
  = Cash Balance
  - credit-card balances

Net Worth
  = Short-Term Worth
  + retirement accounts
  + other financial assets
  + manually valued assets
  - personal, auto, mortgage, student, and other loans
  - other liabilities
```

`Cash Balance` is the user’s practical short-term pool, not a claim that a
brokerage position settles like checking cash. `Short-Term Worth` shows that
pool after revolving debt. `Net Worth` is the complete balance sheet.

The API also returns every component independently:

- `cash_balance`
- `taxable_investments`
- `credit_card_liabilities`
- `short_term_worth`
- `retirement_assets`
- `loan_liabilities`
- `other_financial_assets`
- `other_financial_liabilities`
- `manual_asset_value`
- `assets`
- `liabilities`
- `net_worth`

## Account groups

Plaid accounts receive an inferred group:

| Group | Typical accounts | Included in |
| --- | --- | --- |
| `cash` | Checking, savings, cash management | Cash Balance |
| `taxable_investment` | Personal brokerage | Cash Balance |
| `retirement` | 401(k), IRA, Roth IRA, 403(b), pension | Net Worth |
| `credit_card` | Revolving credit cards | Short-Term Worth and Net Worth |
| `loan` | Personal, auto, mortgage, student loans | Net Worth |
| `other_asset` | Other positive financial accounts | Net Worth |
| `other_liability` | Other debts | Net Worth |
| `excluded` | Accounts intentionally omitted | No aggregate |

Admins can override an inferred group in Settings. Plaid sync never overwrites
that choice. An override changes presentation and future calculations; it does
not rewrite provider data.

Unknown balances stay unknown. Money does not turn missing data into zero.

## Credit

The Credit view reports balance owed, reported limits, available credit, and
weighted utilization for accounts in the `credit_card` group. Negative card
balances are overpayments and count as zero usage. Cards with missing balances
or non-positive limits remain visible but do not borrow another card’s limit
for the utilization calculation.

Daily account snapshots store the credit limit observed on that date. Older
snapshots without a captured limit keep utilization unknown; current limits
are never copied backward to manufacture history.

## Investments

Portfolio views accept three scopes:

- `all`: every connected investment account.
- `trading`: excludes retirement accounts. The label is intentionally plain
  language; the underlying accounts remain classified as taxable/personal
  brokerage accounts.
- `retirement`: retirement accounts only.

The MCP `get_portfolio_summary` equivalent is
`retirement_scope: include|exclude|only`.

Contributions and withdrawals stay separate from estimated performance in
every scope.

When Plaid reports vested equity facts, portfolio totals, holdings, allocation,
and concentration use only the vested portion. A separate `future_equity`
object carries positive unvested value at the institution's reported price.
It is informational and does not change dashboard, net-worth, or account
balance calculations.

Vesting-aware portfolio history starts with the first snapshot that can split
every currently observed equity holding. Estimated return stays hidden across
vesting changes that cannot be separated cleanly from market performance.

## Manual assets

Admins can add assets that Plaid cannot represent, including homes, vehicles,
other real estate, businesses, collectibles, and a general “other” type.

Each asset stores:

- A name and asset type.
- Signed integer minor units plus ISO currency.
- A valuation date.
- Optional notes.
- An active/archive state.

Every value change appends a valuation record. Archiving is recoverable and
keeps valuation history; it removes the asset from current totals and search.
Manual assets affect Net Worth and asset value only. They never inflate Cash
Balance, Short-Term Worth, portfolio performance, spending, or cash flow.

Daily snapshots carry the latest manual valuation forward so net-worth history
does not drop a house to zero between appraisal dates.
