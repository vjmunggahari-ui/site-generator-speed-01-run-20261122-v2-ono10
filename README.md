[![bounty](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/vjmunggahari-ui/site-generator-speed-01-run-20261122-v2-ono10/rank.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/vjmunggahari-ui/site-generator-speed-01-run-20261122-v2-ono10/reward.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)

# Fast static site generator

A dependency-free ES module that builds a whole static site — Markdown
sources to HTML pages, tag and index pages, and a build report — byte-for-byte
identical to makefun-site 1.0.0, at about 2.3x the speed of the house
baseline on the practice set.

## Layout

- `solve.js` — the whole build. Exports `run(input)`, which takes one case's
  `{ site, templates, files }` and returns the output object (path → text).
- `main.ts` — the driver (kept from the house entry): reads the cases from
  `$MAKEFUN_INPUT_DIR/cases.json`, answers each one alone with `run()`, and
  writes `$MAKEFUN_OUTPUT_DIR/answers.json`. It sets V8
  `--no-incremental-marking` before importing `solve.js`, as the baseline does.
- `package.json` — `{ "type": "module" }`.

## How it is fast

The reference spends ~97% of its build time rendering Markdown, so the work
went there first; everything else is small by comparison.

- **Fused single-pass inline scan.** Escapes, code spans, strong, emphasis
  and links are handled in one left-to-right pass. A native regex finds the
  next special character; the plain run before it goes out as one slice.
  There is no token list and no per-character loop.
- **Range-based Markdown.** The block scanner works on line ranges of the
  body string — no `split('\n')`, no per-line slices, no paragraph join.
  Paragraphs whose lines need no trimming render straight from the body
  range; only the ~14% that need trimming take the join path. Nested
  constructs recurse over sub-ranges of the same string, never copies.
- **Front matter without split/join.** The closing `---` is found by scanning
  line boundaries with `indexOf`; the body is sliced out, never split and
  re-joined.
- **Memoized cards.** Each source's card object is built once per run and
  shared across the page, index, tag and recent lists that use it.
- **Constant-template cache.** Templates whose output is fixed for the whole
  run (they reference only `site`/`tags`/`recent`, or loop variables bound
  over those) are analysed once, rendered once, and reused on every page —
  with a depth guard so the 8-deep include cap can never change the output.
- **Cached link resolution.** A link target resolves to the same href for a
  whole source, so it is resolved once per source; the source directory's
  segment stack is split once, not once per link.

## Measured speed (local, Node v24.22.1)

Practice set (3 cases), 9 timed rounds, interleaved with the house baseline:

| case | v2 median | v2 trimmed mean | baseline median |
| ---- | --------: | --------------: | --------------: |
| g-0001 | 65.8 ms | 64.6 ms | 121.2 ms |
| g-0002 | 89.6 ms | 87.4 ms | 241.3 ms |
| g-0003 | 107.4 ms | 109.2 ms | 244.6 ms |
| **total** | **262.8 ms** | **261.2 ms** | **607.0 ms** |

v2 is **2.31x faster** than the baseline (trimmed means 261.2 ms vs
612.4 ms). The baseline's submitted median on the server was 1,810,000 µs;
v2's local total is 2.31x lower, so it should land clearly below that.

## Correctness

- Practice set: 3/3 cases byte-identical to the kit's expected output.
- Differential fuzz against the kit oracle (makefun-site 1.0.0) on freshly
  generated cases: 108/108 identical (36 + 72 cases, 36 seeds). The fuzz
  caught one real bug — the quoted-string refusal rule (closing quote must
  be the value's last character; stray quotes and bad escapes have their own
  messages) — which was fixed and re-verified to 72/72, plus a 50-case
  black-box probe of every front-matter value type (date, tags, draft,
  layout, slug, quoted title/summary) with 0 differences.
- Verified under grader-like conditions: read-only repo copy, run as an
  unprivileged user from another directory, `MAKEFUN_OUTPUT_DIR` set, exit 0,
  byte-identical output on two runs.

## License

MIT — see `LICENSE`.
