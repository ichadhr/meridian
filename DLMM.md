# Meteora DLMM — Real Internals

> Created: June 1, 2026 | Status: Living reference document  
> Sources: Official Meteora DLMM docs + `@meteora-ag/dlmm` SDK source code on GitHub  
> Goal: Document how DLMM actually works under the hood, with formulas, so future discussions have an authoritative reference

---

## 1. Sources Used

- **Official Meteora DLMM docs:** https://docs.meteora.ag/overview/products/dlmm/dlmm-formulas
- **SDK source:** https://github.com/MeteoraAg/dlmm-sdk (`@meteora-ag/dlmm`)
- **Key SDK files:**
  - `helpers/weight.ts` — bin math, weight distributions
  - `helpers/fee.ts` — base + variable fee formulas
  - `helpers/strategy.ts` — Spot/Curve/BidAsk implementations
  - `index.ts` — main DLMM class, `processPosition()`, `updateVolatilityAccumulator()`
  - `helpers/rebalance/strategy/balanced.ts` — rebalance logic
  - `constants/index.ts` — `BASIS_POINT_MAX`, `MAX_FEE_RATE`, `FEE_PRECISION`

**When in doubt, the SDK is the source of truth** — docs sometimes lag behind code.

---

## 2. The Mental Model

DLMM is a **discrete-bin concentrated liquidity AMM**:
- Price is divided into discrete bins (not continuous like Uniswap V3)
- Each bin = a price range with constant price inside
- LPs pick a range of bins to provide liquidity to
- Active bin = where current price sits; if active bin is in your range, you earn fees
- Price moves in **discrete jumps** between bins, not continuously

---

## 3. Bin Math (The Core Formula)

**Price ↔ Bin ID:**
```
price = (1 + binStep / 10000) ^ (binId - 8388608)
```

Where:
- `BASIS_POINT_MAX = 10000` (SDK constant)
- `8388608` is the **neutral bin offset** — at this bin_id, price = 1.0
- Higher bin_id = higher price; lower = lower price
- Exponent of 0 = price = 1.0

**SDK code** (`helpers/weight.ts`):
```typescript
export function getPriceOfBinByBinId(binId: number, binStep: number): Decimal {
  const binStepNum = new Decimal(binStep).div(new Decimal(BASIS_POINT_MAX));
  return new Decimal(1).add(new Decimal(binStepNum)).pow(new Decimal(binId));
}
```

**Price → Bin ID** (`index.ts:1190-1197`):
```typescript
public static getBinIdFromPrice(price, binStep, min) {
  const binStepNum = new Decimal(binStep).div(new Decimal(BASIS_POINT_MAX));
  const binId = new Decimal(price)
    .log()
    .dividedBy(new Decimal(1).add(binStepNum).log());
  return (min ? binId.floor() : binId.ceil()).toNumber();
}
```

**With token decimals** (human-readable):
```
adjusted_price = price_per_lamport × 10^(decimals_X - decimals_Y)
```

### bin_step = Price Increment per Bin

| bin_step | % change per bin |
|----------|------------------|
| 10       | 0.1%             |
| 25       | 0.25%            |
| 50       | 0.5%             |
| **100**  | **1.0%**         |
| 200      | 2.0%             |

Meridian's config (`minBinStep: 80, maxBinStep: 125`) = 0.8%-1.25% per bin.

---

## 4. Active Bin Advancement

**The active bin moves when a swap drains all liquidity in the current bin.** It doesn't tick every second or every block — it ticks when a swap actually exhausts the active bin's liquidity.

**The active bin CAN skip multiple bins at once.** A large swap that exceeds liquidity in the current bin continues consuming from the next bin(s), jumping the active bin to wherever the swap ends.

From `index.ts:8989-9001`:
```typescript
const deltaId = Math.abs(vParameter.indexReference - activeId);
const newVolatilityAccumulator = 
  vParameter.volatilityReference + deltaId * BASIS_POINT_MAX;
```

This `deltaId` can be > 1. If the active bin jumps from 1000 to 1003, that adds `3 × 10000 = 30000` to the volatility accumulator. **This is the source of Meridian's `volatility_30m` field** — the screener uses it to size bin ranges.

---

## 5. Strategy Implementations (Spot vs Curve vs BidAsk)

All three are implemented in `helpers/strategy.ts`. They differ in **how they distribute liquidity across your chosen bin range**.

### Spot (Uniform — Meridian's default)
- Every bin gets weight=1
- Liquidity spread evenly
- Best for: stable ranges, no strong directional view

### Curve (Peak at Active Bin)
- Active bin: max weight (2000)
- Farthest bins: min weight (200)
- Linear interpolation
- **Triangle shape** — most liquidity near current price
- Best for: you think price will stay near current level

### BidAsk (Bat-Wing / Inverted)
- Active bin: min weight (200)
- Farthest bins: max weight (2000)
- **Bat-wing shape** — liquidity at the edges of your range
- Best for: you expect big swings and want to earn fees from them

### How Weights Become Amounts

Weights → base-point shares (0-10000 per bin) via distributor functions:
- `calculateSpotDistribution()` — uniform
- `calculateNormalDistribution()` — gaussian (Curve)
- `calculateBidAskDistribution()` — inverted gaussian (BidAsk)

Then `toAmountBothSide()` in `helpers/weightToAmounts.ts` converts to actual token amounts. **Key factor:** for ask-side (token X) bins, the formula divides weight by price — so higher-priced bins get proportionally less X even with equal weight, because each unit of X is worth more at higher prices.

**Meridian currently uses only Spot.** Curve and BidAsk are SDK-supported but unused.

---

## 6. Single-Side Deposit Mechanics (CORRECTED UNDERSTANDING)

**The SDK does NOT auto-swap for single-side deposits.** 

When you call `addLiquidityByStrategy` with `totalXAmount=0, totalYAmount>0`:
- The SDK deposits **only token Y** into **bid-side bins** (bins below active bin)
- No auto-swap happens at the SDK level
- The position ends up as a single-sided Y position

**This is what Meridian does** with `amount_x=0, bins_above=0` enforced. It's using the SDK's native single-side path — pure bid-side liquidity, no pre-swap needed.

**Why "active_bin is pre-fetched" matters:** the SDK needs to know the active bin at the moment of deposit to correctly fill only bid-side bins. If the active bin moves while your tx is being built, the deposit could land in the wrong bins.

**If you wanted dual-sided liquidity (both SOL and base token):** you would pre-swap via Jupiter first, then call `addLiquidityByStrategy` with both `totalXAmount > 0` and `totalYAmount > 0`. Meridian doesn't do this currently.

---

## 7. Fee Mechanics

### Base Fee

**Formula** (`helpers/fee.ts`):
```typescript
baseFeeRate = baseFactor × binStep × 10 × 10^baseFeePowerFactor
```

**As percentage** (`index.ts:2141`):
```typescript
baseFeeRatePercentage = (baseFactor × binStep × 10 × 10^powerFactor) × 100 / FEE_PRECISION
// FEE_PRECISION = 1_000_000_000
```

**Examples:**
- baseFactor=100, binStep=100, powerFactor=0 → 0.01%
- baseFactor=2000, binStep=100, powerFactor=0 → 0.2%
- baseFactor=10000, binStep=100, powerFactor=0 → 1.0%

### Variable (Dynamic) Fee — The Clever Part

```typescript
variableFee = variableFeeControl × (volatilityAccumulator × binStep)² / 100_000_000_000
```

**The fee scales with volatility squared:**
- Calm pool (no recent bin moves) → small variable fee
- Volatile pool (recent bin jumps) → large variable fee
- Volatile pools are riskier → traders pay more → LPs earn more

This is why the same pool shows different fees at different times. Meridian's `fee_active_tvl_ratio` from Meteora API captures the aggregate.

### Volatility Accumulator Decay (`index.ts:9004-9024`)

```typescript
public static updateReference(activeId, vParameter, sParameter, currentTimestamp) {
  const elapsed = currentTimestamp - vParameter.lastUpdateTimestamp;
  if (elapsed >= sParameter.filterPeriod) {
    vParameter.indexReference = activeId;
    if (elapsed < sParameter.decayPeriod) {
      vParameter.volatilityReference = 
        (vParameter.volatilityAccumulator * sParameter.reductionFactor) / BASIS_POINT_MAX;
    } else {
      vParameter.volatilityReference = 0;
    }
  }
}
```

- `filterPeriod` (`t_f`): minimum time before volatility reference resets
- `decayPeriod` (`t_d`): window where volatility decays by `reductionFactor`
- After `t_d`, drops to 0
- Between `t_f` and `t_d`: linear decay

**The variable fee isn't sticky.** If a pool goes calm, the variable fee fades out.

### Total Fee Cap

**Capped at 10%** (`MAX_FEE_RATE = 100,000,000`, divided by `FEE_PRECISION = 1,000,000,000`).

### Fee Accrual

Fees accrue **per-bin, per-liquidity-share**:
- Each bin tracks `feeAmountXPerTokenStored` and `feeAmountYPerTokenStored` (cumulative fees per unit of liquidity)
- When a position is queried (`processPosition()` in `index.ts:8535`), unclaimed fees are computed based on the position's share of each bin's liquidity
- **Fees do NOT auto-compound** — they accumulate in the position until you claim

---

## 8. Meteora Rewards (On Top of Fees)

Up to **2 reward mints per pool** (`rewardInfos[0]` and `rewardInfos[1]`):
- Per-position distribution (proportional to your liquidity share in each bin)
- Claimable via `claimReward2` on-chain instruction
- Wrapped in SDK by `removeLiquidity({ shouldClaimAndClose: true })`
- Stored in `lbPair.rewardInfos` with `mint`, `vault`, `rewardRate`, `rewardPerTokenStored`

**Meridian's `claim_fees` tool likely claims both fees AND rewards in one tx** (since they share the close position flow).

---

## 9. Rebalancing & Compounding

**Rebalance = withdraw all → claim fees+rewards → redeposit centered on current active bin.**

Implemented in `helpers/rebalance/strategy/balanced.ts`:
```typescript
buildRebalanceStrategyParameters(): RebalanceDepositWithdrawParameters {
  // 1. Withdraw at 10000 bps (100%) from current range
  // 2. Redeposit a portion (xWithdrawBps, yWithdrawBps)
  // 3. Add topUpAmountX + topUpAmountY if provided
  // 4. Redistribute with strategy (Spot/BidAsk/Curve) centered on active bin
}
```

**Key: there is no "in-place adjust"** — rebalance is always withdraw + redeposit. This is expensive (gas + IL during the swap window).

**No "compound" SDK method exists.** To compound fees back into the position:
1. `removeLiquidity` with `shouldClaimAndClose=false` → get tokens + fees
2. `addLiquidityByStrategy` → redeposit (now with the fees added)

The rebalance system effectively does this atomically.

---

## 10. baseFactor

Stored in `lbPair.parameters.baseFactor` (u16, 0-65535):
- Set at pool creation
- Multiplied with binStep to give base fee
- For target fees > 0.65%, SDK uses `baseFeePowerFactor` (multiplicative 10^n scaling) to avoid u16 overflow

**Meridian reads it from** `pool.lbPair.parameters?.baseFactor` (correct location).

The valid range is `U16_MAX = 65535`, but in practice values above ~2000 are rare.

---

## 11. Position PnL

**No SDK helper for PnL.** You calculate it manually from `processPosition()` output:

```typescript
{
  totalXAmount, totalYAmount,           // current token amounts
  feeX, feeY,                          // unclaimed fees
  rewardOne, rewardTwo,                // unclaimed rewards
  totalClaimedFeeXAmount, totalClaimedFeeYAmount,  // lifetime claimed
  // ... plus excludeTransferFee variants for Token-2022
}
```

**Unrealized PnL formula:**
```
unrealizedPnL = currentValueSOL + unclaimedFeesSOL + unclaimedRewardsSOL - deployedSOL
```

Where `currentValueSOL = totalXAmount × priceXinSOL + totalYAmount × priceYinSOL`.

**Realized PnL after close:**
```
realizedPnL = withdrawnSOL + claimedFeesSOL + claimedRewardsSOL - deployedSOL
```

Meridian's `recordPerformance` does this manually with `final_value_usd`, `fees_earned_usd`, `initial_value_usd`.

---

## 12. Position Data Structure

Each position has an array of `PositionBinData` (one per bin in your range):

```typescript
interface PositionBinData {
  binId: number;
  price: string;           // price per lamport
  pricePerToken: string;   // human-readable price
  binXAmount: string;      // total X in this bin
  binYAmount: string;      // total Y in this bin
  binLiquidity: string;    // total liquidity supply in bin
  positionLiquidity: string;  // this position's share
  positionXAmount: string;    // this position's X in bin
  positionYAmount: string;    // this position's Y in bin
  positionFeeXAmount: string; // claimable X fees in this bin
  positionFeeYAmount: string; // claimable Y fees in this bin
  positionRewardAmount: string[]; // claimable rewards per reward token
}
```

**One PositionBinData per bin × N bins = significant data per position.** For a 57-bin range, that's 57 entries.

---

## 13. SDK Key Methods

### `initializePositionAndAddLiquidityByStrategy` (`index.ts:3378`)
```typescript
public async initializePositionAndAddLiquidityByStrategy({
  positionPubKey,    // PublicKey — new position keypair's pubkey
  totalXAmount,      // BN — total token X amount
  totalYAmount,      // BN — total token Y amount
  strategy,          // StrategyParameters — { minBinId, maxBinId, strategyType }
  user,              // PublicKey — wallet address
  slippage?,         // number — optional slippage percentage (e.g., 1.5 = 1.5%)
}): Promise<Transaction>
```

### `addLiquidityByStrategy`
```typescript
async addLiquidityByStrategy({
  positionPubKey,    // existing position
  totalXAmount, totalYAmount,
  strategy,
  user, slippage?,
}): Promise<Transaction>
```

Adds to existing position. The bin range must be within existing position bounds (or use `addLiquidityByStrategyChunkable` to auto-expand).

### `removeLiquidity` (`index.ts:4594`)
```typescript
public async removeLiquidity({
  user, position, fromBinId, toBinId,
  bps,                       // basis points of liquidity to remove
  shouldClaimAndClose?,      // claim fees + rewards + close if empty
  skipUnwrapSOL?,
}): Promise<Transaction[]>
```

### `claimFee` / `claimReward`
**No standalone public method.** Fee claiming is embedded in `removeLiquidity` via `claimFee2` and `claimReward2` on-chain instructions. The SDK's `createClaimSwapFeeMethod()` (private) and `removeLiquidity({ shouldClaimAndClose: true })` expose this.

### `closePosition` (`index.ts:4958`)
```typescript
public async closePosition({
  owner, position,  // LbPosition: { publicKey, positionData, version }
}): Promise<Transaction>
```
Closes a position account and reclaims rent. **Does not withdraw liquidity first.** Use `removeLiquidity` with `shouldClaimAndClose=true` for full withdraw+claim+close.

Also: `closePositionIfEmpty()` — only closes if all bins have zero liquidity.

### Rebalance Methods
- `rebalancePosition()` — builds instructions for withdraw + deposit + claim in one operation
- No standalone "compound" method

---

## 14. What This Means for Meridian

| DLMM Concept | Meridian's Handling |
|--------------|---------------------|
| **Bins** | Pre-fetches `active_bin`; computes `bins_below` via linear formula based on volatility |
| **Active bin advancement** | `volatility` field comes from volatilityAccumulator. Higher movement → higher vol → wider range |
| **Strategies** | Uses **Spot only** (default). Curve/BidAsk exist in SDK but Meridian's prompt doesn't use them |
| **Single-side deposits** | `addLiquidityByStrategy` with `amount_x=0, bins_above=0` → only bid bins filled, no pre-swap |
| **Base + variable fee** | `fee_active_tvl_ratio` from Meteora API is the aggregate. Variable fee explains why volatile pools show higher fee/TVL |
| **Volatility accumulator** | Source of Meteora API's `volatility_30m` field. Meridian uses it to size bin ranges |
| **Fee accrual** | `getPositionPnl` reads `processPosition()` output to compute unclaimed fees per bin |
| **Rewards** | `claim_fees` likely claims both fees AND rewards in one tx |

---

## 15. Common Misconceptions (Corrected)

| ❌ Wrong | ✅ Correct |
|----------|-----------|
| SDK auto-swaps half to base token for single-side deposits | SDK deposits only the given token into bid-side bins. No swap. |
| Position rebalancing adjusts in-place | Rebalance = atomic withdraw + claim + redeposit. Always. |
| Fees auto-compound | No. Must manually claim + redeposit. |
| "fee_active_tvl_ratio" is a DLMM protocol concept | It's a Meteora API metric (24h fees / active TVL), not on-chain. |
| Strategies control token X vs Y distribution | Strategies control bin weight distribution. Token allocation follows from weights × price. |

---

## 16. Verification Checklist for Meridian Code

If you want to verify Meridian's DLMM usage against this reference:

1. Does Meridian's `addLiquidityByStrategy` call include `strategyType: StrategyType.Spot` explicitly, or rely on default?
2. Does `bins_below` formula correctly account for the `8388608` neutral offset when computing relative bin positions?
3. Does `getPositionPnl` correctly sum per-bin fees from `PositionBinData[]`?
4. Does `claim_fees` also claim rewards, or just fees?
5. When `bins_above=0` is enforced, does the SDK's strategy builder still try to allocate to ask-side bins?
6. Does the deploy safety check for `volatility > 0` correctly handle the volatilityAccumulator=0 case (i.e., fresh pool, no swaps yet)?

---

## 17. See Also

- `CLAUDE.md` — Meridian architecture overview
- `bd list` — Active issues and known limitations
- `IMPROVE.md` — Improvement plan with tiers
- [Meteora DLMM Docs](https://docs.meteora.ag/overview/products/dlmm)
- [dlmm-sdk GitHub](https://github.com/MeteoraAg/dlmm-sdk)

---

## 18. Change Log

| Date | Change |
|------|--------|
| 2026-06-01 | Initial document. Bin math, strategies, fees, rebalancing, PnL, SDK methods documented with source attribution. |
