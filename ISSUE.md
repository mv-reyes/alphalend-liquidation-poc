# [CRITICAL] Zero-LTV collateral is seizable in live liquidations (alphalend position module)

**Severity: Critical (active, measurable exposure on mainnet)**

## TL;DR

`position::liquidate` lets the liquidator choose which collateral market to
seize from, and never checks that the chosen market's `liquidation_threshold`
is non-zero. Markets configured with `liquidation_threshold = 0` contribute
nothing to a position's health, yet their collateral can be seized, plus the
liquidation bonus.

This is not an edge case. Isolated and non-native markets are zero-threshold
by design, they hold real user deposits right now, and any liquidator bot can
name them as the seize target today. Running the PoC against your own
deployment lists the exposed markets.

## Why Critical and not Medium

Three things take this out of theoretical-bug territory:

1. The exposure is live and enumerable. Zero-threshold markets exist on your
   mainnet deployment today and positions are holding collateral in them
   alongside borrows. `--markets` prints the list from your own protocol
   object.
2. The seize math makes this profitable, not cosmetic: the bonus and fee are
   read from the seized market's config (`get_liquidation_bonus_bps`,
   `get_liquidation_fee_bps` on `withdraw_market_id`), so a liquidator is
   paid a bonus on collateral that never backed the debt.
3. No tooling or privileged access is needed. A standard liquidator calling
   `liquidate` with `withdraw_market_id` set to the zero-threshold market is
   the whole exploit.

## Root cause

Two checks guard the seize path, and neither looks at the threshold of the
market being seized:

1. `Position.collaterals` contains `withdraw_market_id` (existence only)
2. `is_liquidatable(position)` (position-level, a cached flag set by
   `refresh`)

Then `remove_token_collateral` pulls the xTokens, checking only balance
sufficiency. The only place `liquidation_threshold` is consulted is the
health computation inside `refresh` (via `market::get_liquidation_value`),
where zero-threshold collateral correctly counts as zero. Correct for health,
irrelevant for seizure. The asset that contributed nothing is the asset that
gets taken.

Evidence: disassembly of the live position module
(`0xd631cd66138909636fc3f73ed75820d0c5b76332d1644608ed1c85ea2b8219b4`),
`liquidate` at lines 1835-2168, `remove_token_collateral` at 1366-1494,
`is_liquidatable` at 2451-2472. `liquidation_threshold` appears only in
struct definitions and Bluefin LP config accessors. Never on the seize path.

## Reproduction

PoC: https://github.com/mv-reyes/alphalend-liquidation-poc

```
git clone https://github.com/mv-reyes/alphalend-liquidation-poc
cd alphalend-liquidation-poc
npm install
node poc.js --guards     # offline: check inventory of the seize path
node poc.js --markets --protocol 0x01d9cf05d65fa3a9bb7163095139120e3c4e414dfbab153a49779a7d14010b93   # live: exposed markets on your deployment
```

`--guards` is fully offline and walks the disassembly. `--markets` queries
your protocol object over GraphQL and lists every market whose
`liquidation_threshold` is zero, i.e. every market whose collateral is
seizable without backing anything.

## Exploit scenario

Concrete numbers, using your current configs:

1. User deposits $10,000 of an isolated-market asset (threshold 0) and
   $1,000 SUI (threshold 75%), borrows $800 USDC.
2. SUI drops. The position goes unhealthy purely on the SUI side.
3. A liquidator repays $100 of USDC debt and sets
   `withdraw_market_id` to the isolated market.
4. The liquidator walks out with $100 plus bonus of an asset that never
   backed the loan. The borrower's SUI, the actual backing, is untouched.
   They lose the collateral they were told was not at risk.

Scale this by the total deposits sitting in zero-threshold markets. That is
the current exposure, and `--markets` measures it.

## Suggested fix

In `position::liquidate`, before computing the seizure, require that the
market named by `withdraw_market_id` has `liquidation_threshold > 0`. Only
collateral that contributed to the health factor should be seizable.

## Disclosure

Reported here first. Happy to answer questions or share additional traces.
I plan to publish a writeup in 30 days; sooner if you prefer to coordinate.
