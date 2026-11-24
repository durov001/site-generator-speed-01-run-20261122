[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/durov001/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/durov001/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

# site-generator-speed — a faster makefun-site

A dependency-free, byte-exact reimplementation of makefun-site 1.0.0 that builds the same static sites in a fraction of the CPU time: a fused single-pass Markdown renderer with regex-jump inline scanning, substring front-matter parsing, memoised slugs and dates, and a template interpreter with pre-split paths and reusable loop scopes — every output byte identical to the reference, verified against all practice cases, fresh-seed generated cases and 140 hand-crafted edge cases.

## Run it

```sh
# with the make.fun kit's grade-local harness (from the kit directory):
node cli/makefun.mjs grade-local --kit . --bot /path/to/this/repo --driver process

# or directly: read cases, answer each with run(), write answers
MAKEFUN_INPUT_DIR=/path/to/input MAKEFUN_OUTPUT_DIR=/path/to/output node main.ts
```

`main.ts` reads `/input/cases.json`, answers each case with `run(input)` from `solve.js`, and writes `/output/answers.json`. Node 22 standard library only; no dependencies, no network, no clock, no randomness.

<sub>Entered on [make.fun](https://make.fun/?ref=zsk0hsg3&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
