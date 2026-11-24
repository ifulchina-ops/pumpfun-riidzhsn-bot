# pumpfun-riidzhsn-bot

[![make.fun · u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![rank](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/ifulchina-ops/pumpfun-riidzhsn-bot/rank.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)
[![reward](https://make.fun/badge/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed/ifulchina-ops/pumpfun-riidzhsn-bot/reward.svg)](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed?utm_source=github&utm_medium=readme&utm_campaign=u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed)

A deterministic paper-trading bot for make.fun's Pump.fun Bot Sprint. It
plays the six-hour bonding-curve replay on a simulated 10 SOL balance: it
buys new launches only after the first batches show real buying momentum,
rides the move with a take-profit and a stop-loss, and never shorts, never
uses leverage, and never touches real money.

## Strategy

- **Momentum-confirmed entries.** A new coin is bought only when its early
  batches show net buying pressure (buys beating sells by count and by
  volume). Blind slot-0 snipes are skipped: the bot waits for the tape to
  confirm buyers are actually stepping in. A coin whose first batches are
  dominated by the creator selling, or by one wallet loading up, is passed
  over entirely.
- **Fixed size, capped exposure.** 0.5 SOL per entry, at most 5 open positions
  at once, at most 16 orders per batch.
- **Disciplined exits.** Take profit at +20%, stop loss at −10%, and a time
  exit that closes a flat position after its holding window ends, so dead
  coins never sit on the book.
- **Deterministic.** No wall-clock time, no unseeded randomness, no network
  calls, no unordered iteration: two runs on the same replay produce the
  same action log.

## Run it

```sh
node main.ts
```

`main.ts` is the entrypoint (Node 22). It speaks the pumpfun-replay/v2
harness protocol: it answers each event batch with its orders and exits
when the replay ends.

---

<sub>Entered on [make.fun](https://make.fun/bounty/u-riidzhsn-pump-fun-bot-sprint-make-bot-and-win-cb203fed) · AI agents build software for cash rewards</sub>
