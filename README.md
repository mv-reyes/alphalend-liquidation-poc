# Zero-LTV Collateral Seizable During Liquidation (AlphaLend)

Security research PoC. Affected package (Sui mainnet, live):

```
0xd631cd66138909636fc3f73ed75820d0c5b76332d1644608ed1c85ea2b8219b4
```

## Summary

`position::liquidate` lets the liquidator choose **which** collateral market to
seize from (`withdraw_market_id`), but never checks that the chosen market's
`liquidation_threshold` is non-zero. Collateral in markets configured with
`liquidation_threshold = 0` (isolated / non-native markets) contributes **zero**
to the position's health during `refresh`, yet it can still be seized by a
liquidator, with the liquidation bonus on top.

Borrowers lose assets that never backed their debt and were never expected to
be part of the liquidation pool.

## Root cause

The seizure path performs exactly two validations on the caller-chosen market:

1. the position actually holds collateral in that market
   (`vec_map::contains` on `Position.collaterals`), and
2. the position as a whole is liquidatable (`is_liquidatable`, a cached flag
   set by `refresh`).

Neither `liquidate` nor the `remove_token_collateral` it delegates to ever
reads `liquidation_threshold` for the seize market. The threshold is only
consulted inside `refresh` → `market::get_liquidation_value` when *computing*
health, where a zero-threshold market correctly contributes 0. The bug is
that this zero-contribution collateral remains a valid seizure target:

```
liquidate(position, markets, withdraw_market_id = ZERO_THRESHOLD_MARKET, ...)
  ├─ assert collaterals.contains(withdraw_market_id)        // existence only
  ├─ assert is_liquidatable(position)                       // position-level
  ├─ bonus = market[withdraw_market_id].liquidation_bonus   // config read
  └─ remove_token_collateral(position, withdraw_market_id, amount)
       └─ assert x_token_balance >= amount                  // balance only
```

`evidence/position-liquidate.disasm.txt` is a disassembly of the live
position module; `liquidate` spans lines 1835–2168,
`remove_token_collateral` lines 1366–1494, `is_liquidatable` 2451–2472,
`refresh` 879–1259. `liquidation_threshold` appears only in struct
definitions and Bluefin LP config setters (lines 57, 620, 769), never on the
seizure path.

## Impact

Example: a user deposits $10,000 of an isolated-market asset
(`liquidation_threshold = 0`) and $1,000 SUI (`threshold = 75%`), borrows
$800 USDC. SUI drops; the position becomes unhealthy. A liquidator repays
$100 USDC and names the isolated market as `withdraw_market_id`, seizing
$100 + bonus of an asset that contributed nothing to the health factor and
should never have been at risk. The borrower is left with the SUI that
actually backed the loan untouched, and loses the non-backing asset instead.

## Reproduction

Setup (installs the Sui GraphQL client the chain queries use):

```
npm install
```

Static check inventory (offline, no chain access needed):

```
node poc.js --guards
```

Enumerate live markets and their thresholds:

```
node poc.js --markets --protocol 0x01d9cf05d65fa3a9bb7163095139120e3c4e414dfbab153a49779a7d14010b93
```

Print the seizure plan for a live underwater position:

```
node poc.js --simulate <position object id>
```

The PoC is read-only: it never signs or submits a transaction. End-to-end
confirmation requires a funded liquidator wallet executing the plan printed
by `--simulate` via devInspect.

## Recommendation

Validate in `position::liquidate` that the market named by
`withdraw_market_id` has `liquidation_threshold > 0`, so only collateral that
contributed to the health factor can be seized.

## Disclosure

Reported to the protocol team via their public issue tracker. This repo is
the accompanying PoC.
