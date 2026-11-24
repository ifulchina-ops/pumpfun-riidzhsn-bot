// Momentum-confirmed launch rider for the pumpfun-replay/v2 harness.
//
// Idea: most new pump.fun coins dump within minutes of launch, so blind
// slot-0 sniping loses on almost everything. This bot only buys a coin
// after its own tape confirms buyers are stepping in: within a short
// window after its CreateEvent it needs several trades, more SOL bought
// than sold, at least as many buys as sells, and its curve price up at
// least 2% from creation — and it passes entirely when the creator sells
// anything (the classic rug tell). Winners are ridden to +20%, losers are
// cut at -10% or when the tape flips to distribution, and flat positions
// are closed after a fixed holding window so dead coins never sit on the
// book. One buy per coin, 0.5 SOL per entry, at most 5 open positions.
//
// Everything is deterministic: bigint math only, no clock, no randomness,
// no network, no floats. The same replay always yields the same replies.

import {
  LAMPORTS_PER_SOL,
  runBot,
  type Batch,
  type BotState,
  type BuyInput,
  type OrderInput,
  type SellInput,
} from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ tuning

/** SOL spent per entry (fees included). */
const STAKE_LAMPORTS = LAMPORTS_PER_SOL / 2n;
/** Smallest buy worth sending (the size cap must allow at least this). */
const MIN_BUY_LAMPORTS = LAMPORTS_PER_SOL / 200n;
/** Slots after creation during which a coin may still trigger an entry. */
const OBSERVE_SLOTS = 300;
/** Slots a position may be held before the time exit closes it. */
const HOLD_SLOTS = 1800;
/** Take profit / stop loss, in percent of entry cost. */
const TAKE_PROFIT_PCT = 120n;
const STOP_LOSS_PCT = 90n;
/** Entry needs the curve price up this much (bps) from creation. */
const ENTRY_UP_BPS = 200;
/** Reversal exit needs this batch's sell volume to exceed buy volume by this factor. */
const REVERSAL_SELL_FACTOR = 2n;
/** Slippage tolerance on every order, in bps. */
const SLIPPAGE_BPS = 1000;

// ------------------------------------------------------------------ per-coin book

interface CoinNote {
  creator: string;
  /** Virtual reserves at creation (price reference). */
  createQuote: bigint;
  createToken: bigint;
  createdSlot: number;
  /** Cumulative tape since creation. */
  buys: number;
  sells: number;
  buyVol: bigint;
  sellVol: bigint;
  creatorSold: boolean;
  /** Entry already decided (bought or dropped) — one buy per coin, ever. */
  decided: boolean;
  /** Slot the buy was decided on (for the time exit). */
  buySlot: number;
}

const notes = new Map<string, CoinNote>();

interface BatchTape {
  buys: number;
  sells: number;
  buyVol: bigint;
  sellVol: bigint;
}

/** Current curve price (quote per token) as a fraction, or null when unknown. */
function priceOf(curve: { virtual_quote_reserves: bigint; virtual_token_reserves: bigint }): [bigint, bigint] | null {
  if (curve.virtual_token_reserves <= 0n || curve.virtual_quote_reserves < 0n) return null;
  return [curve.virtual_quote_reserves, curve.virtual_token_reserves];
}

/** Lamports a holding is worth now at the curve's current reserves. */
function holdingValue(tokens: bigint, curve: { virtual_quote_reserves: bigint; virtual_token_reserves: bigint }): bigint | null {
  if (curve.virtual_token_reserves <= 0n) return null;
  return (tokens * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
}

// ------------------------------------------------------------------ the bot

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const { caps } = state.hello;
    const tx = state.txFeeLamports();
    const orders: OrderInput[] = [];
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();

    // --- fold this batch's events into per-coin notes and tape --------
    const tape = new Map<string, BatchTape>();
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        if (!notes.has(e.mint)) {
          notes.set(e.mint, {
            creator: e.creator,
            createQuote: BigInt(e.virtual_quote_reserves),
            createToken: BigInt(e.virtual_token_reserves),
            createdSlot: e.slot,
            buys: 0,
            sells: 0,
            buyVol: 0n,
            sellVol: 0n,
            creatorSold: false,
            decided: false,
            buySlot: -1,
          });
        }
        continue;
      }
      if (e.event === 'CompleteEvent') {
        notes.delete(e.mint);
        continue;
      }
      // TradeEvent
      const t = tape.get(e.mint) ?? { buys: 0, sells: 0, buyVol: 0n, sellVol: 0n };
      const vol = BigInt(e.sol_amount);
      if (e.is_buy) {
        t.buys += 1;
        t.buyVol += vol;
      } else {
        t.sells += 1;
        t.sellVol += vol;
      }
      tape.set(e.mint, t);
      const note = notes.get(e.mint);
      if (note !== undefined) {
        if (e.is_buy) {
          note.buys += 1;
          note.buyVol += vol;
        } else {
          note.sells += 1;
          note.sellVol += vol;
          if (e.user === note.creator) note.creatorSold = true;
        }
      }
    }

    // --- exits first: TP / SL / time / reversal ------------------------
    const pendingSell = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'sell') pendingSell.add(p.order.mint);
    }
    for (const [mint, holding] of state.positions) {
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete || pendingSell.has(mint)) continue;
      const value = holdingValue(holding.token_amount, curve);
      if (value === null) continue;
      const cost = holding.cost_lamports;
      const note = notes.get(mint);
      const age = note !== undefined && note.buySlot >= 0 ? batch.slot - note.buySlot : 0;
      const t = tape.get(mint);
      const distributing =
        t !== undefined && t.sellVol > REVERSAL_SELL_FACTOR * t.buyVol && t.sells > 0;
      const takeProfit = value * 100n >= cost * TAKE_PROFIT_PCT;
      const stopLoss = value * 100n <= cost * STOP_LOSS_PCT;
      const timedOut = age >= HOLD_SLOTS;
      const cutLoser = distributing && value < cost;
      if (takeProfit || stopLoss || timedOut || cutLoser) {
        if (orders.length >= caps.max_orders_per_batch) break;
        const sell: SellInput = {
          side: 'sell',
          mint,
          token_amount: holding.token_amount,
          max_slippage_bps: SLIPPAGE_BPS,
        };
        orders.push(sell);
        pendingSell.add(mint);
      }
    }

    // --- entries: momentum-confirmed launches --------------------------
    const pendingBuy = new Set<string>();
    for (const p of state.pending.values()) {
      if (p.order.side === 'buy') pendingBuy.add(p.order.mint);
    }
    for (const [mint, note] of notes) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (slots <= 0) break;
      if (note.decided || pendingBuy.has(mint)) continue;
      if (state.positions.has(mint)) {
        note.decided = true;
        continue;
      }
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) {
        note.decided = true;
        continue;
      }
      if (batch.slot - note.createdSlot > OBSERVE_SLOTS) {
        note.decided = true;
        continue;
      }
      // Momentum confirmation: enough tape, buyers winning, price up, no creator dump.
      if (note.buys + note.sells < 3) continue;
      if (note.buyVol <= note.sellVol) continue;
      if (note.buys < note.sells) continue;
      if (note.creatorSold) {
        note.decided = true;
        continue;
      }
      const now = priceOf(curve);
      if (now === null) continue;
      if (note.createQuote <= 0n || note.createToken <= 0n) continue;
      // Entry needs price >= create price * (1 + ENTRY_UP_BPS / 10000).
      const up = now[0] * note.createToken * 10000n >= note.createQuote * now[1] * (10000n + BigInt(ENTRY_UP_BPS));
      if (!up) continue;
      // Size cap: buys on this mint this reply may spend at most the cap.
      const cap = state.maxBuyLamports(mint);
      if (cap < MIN_BUY_LAMPORTS) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (free < amount + tx) continue;
      const buy: BuyInput = {
        side: 'buy',
        mint,
        quote_lamports: amount,
        max_slippage_bps: SLIPPAGE_BPS,
      };
      orders.push(buy);
      note.decided = true;
      note.buySlot = batch.slot;
      free -= amount + tx;
      slots -= 1;
      pendingBuy.add(mint);
    }
    return orders;
  },
});
