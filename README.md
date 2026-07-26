# Twelfths

**HSA administration engine: month-by-month eligibility, last-month rule, IIAS substantiation.**

Live: **https://twelfths.levelbrook.com**

## What this is

HSAs look like a savings product and behave like a tax instrument, and most of the interesting
engineering is in that gap.

## Engineering notes

### Limits are a sum of twelfths

Eligibility is tested on the first day of each month, so the
annual limit is a sum of twelfths at whichever tier applied in each month, rather than the annual figure for
whatever tier the member holds in December.

### Last-month rule and testing period

The last-month rule lifts a partial-year member to the full
annual figure and creates a testing period through the end of the following year. Failing it turns the
difference into taxable income plus a 10 percent additional tax, which is modeled.

### Verified against hand calculations

Full-year family plus catch-up, prorated three months self
plus three months family plus six months of catch-up, and the excess-contribution excise all come out exact.

### Plan-year limits are rows, not constants

Limits live in a `plan_years` table because they are
indexed annually. A custodian that hardcodes them ships a bug every January.

### Denials beat auto-approval

An IIAS-certified terminal can still ring up a cosmetic procedure,
so substantiation rules are evaluated together and resolved by precedence rather than returning on the first
match.

## Stack

Node.js, TypeScript, PostgreSQL, 24 tests

Tests: `npm test`

## Running it

```
npm install
npm test
npm start
```

## Honest scope

This is a focused engineering demo, not a production system. The data is synthetic and generated
locally so that the behaviour is reproducible. The reasoning, the arithmetic and the failure modes
are the point; the surface area is deliberately narrow.

## License

MIT
