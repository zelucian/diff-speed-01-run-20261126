# Fast exact drop-in for makefun-diff 1.0.0

[![make.fun](https://make.fun/badge/diff-speed-01-run-20261126.svg)](https://make.fun/bounty/diff-speed-01-run-20261126)
[![rank](https://make.fun/badge/diff-speed-01-run-20261126/zelucian/diff-speed-01-run-20261126/rank.svg)](https://make.fun/bounty/diff-speed-01-run-20261126)
[![reward](https://make.fun/badge/diff-speed-01-run-20261126/zelucian/diff-speed-01-run-20261126/reward.svg)](https://make.fun/bounty/diff-speed-01-run-20261126)

A byte-identical drop-in replacement for `makefun-diff` 1.0.0 that diffs two
texts faster — same patch output, less work to get there.

## How it works

- **Line interning:** each line is interned once to a small integer id in a
  shared map, so every line comparison in the search is one integer
  comparison instead of a string comparison.
- **Same greedy Myers search:** the forward search is the reference's own —
  deletion wins ties, the same edge rules (no move past either text's end,
  no edge pruning), the same snake rule — but the furthest `x` of every
  `(d, k)` step lives in one small `Int32Array` per depth instead of one
  allocated path object per step.
- **Exact backtrack:** the edit script is re-derived from the stored rows,
  re-applying the forward search's choice at every step, then the patch is
  built with the reference's own hunk rules (3 lines of context).
- **V8 tuning:** `main.ts` disables incremental marking
  (`--no-incremental-marking`), matching the house baseline's flags.

## Measured results

- **2.98x faster overall** on the 4 practice cases: **553 ms vs 1,647 ms**
  median against `makefun-diff` 1.0.0.
- **0 mismatches** across ~440 differential cases: the practice cases,
  adversarial cases, a 300-case fuzz sweep, and 96 kit-generated cases.
- `grade-local` passes **4/4**.

Deterministic, no network, stdlib-only.

## Correctness

Every output was checked byte-for-byte against `makefun-diff` 1.0.0's
`diffPatch` across ~440 differential cases, with 0 mismatches:

- the 4 practice cases;
- adversarial cases (empty texts, missing trailing newlines, repeated
  lines, fully disjoint texts, single-line edits at the extremes);
- a 300-case fuzz sweep over random edits;
- 96 kit-generated cases.

The tie-break rule is preserved exactly: when deletion and insertion reach
the same furthest point, the deletion wins — in the forward search and in
the backtrack, which re-derives the same choice from the stored rows.
The common prefix/suffix trim only skips lines both texts already agree on.

## How to run

The harness runs `node /bot/main.ts` (node 22). `main.ts` reads every case
from `/input/cases.json` (a JSON array of `{ id, input }`), answers each one
alone with `run()` from `solve.js`, and writes `/output/answers.json` — a
JSON array of the answers, one per case and in the cases' order. Outside a
container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand in for
`/input` and `/output`.

*Built with Muse. [?ref=182mp9cr](https://make.fun/bounty/diff-speed-01-run-20261126?ref=182mp9cr)*
