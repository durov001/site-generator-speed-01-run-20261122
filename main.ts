// main.ts — the harness driver for site-generator-speed-01-run-20261122.
//
// The harness runs `node /bot/main.ts` (Node 22): it reads every case from
// /input/cases.json, answers each one alone with run() from solve.js, and writes
// /output/answers.json — a JSON array of the answers, one per case, in the cases'
// order. Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in
// for /input and /output.
//
// V8 tuning, measured on this workload (median of 7 end-to-end runs each):
//   --no-incremental-marking alone: 0.759s
//   --no-incremental-marking --no-opt: 0.679s
// Disabling the optimiser wins because every timed run is a fresh process: the
// build finishes in ~130ms, so TurboFan's compile cost never pays back. Adding
// --no-lazy, --single-threaded, --predictable or --no-concurrent-marking on top
// measured the same or worse, so they stay out. The flags are set before
// solve.js is imported, so all of the build work runs under them.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

setFlagsFromString('--no-incremental-marking --no-opt');

const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

const inputDir = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const outputDir = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const cases = JSON.parse(readFileSync(join(inputDir, 'cases.json'), 'utf8')) as { id: string; input: unknown }[];
const answers = cases.map((c) => run(c.input));
writeFileSync(join(outputDir, 'answers.json'), JSON.stringify(answers));
