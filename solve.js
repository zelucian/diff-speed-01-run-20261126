// Faster drop-in for makefun-diff 1.0.0 (make.fun's own line diff).
//
// Same answer, faster route. The reference (jsdiff-style, vendor/makefun-diff)
// spends its time allocating one linked-list path object per (d, k) step of
// Myers's search plus a component per snake. This module instead:
//
//   1. splits each text into its lines with one indexOf scan (each line a
//      slice of its text, newline included) and interns every line to a
//      small integer id in one shared Map, so equal lines in old and new
//      share one id and every line comparison in the search is one integer
//      comparison; the line strings themselves are kept only for the patch
//      output;
//   2. trims the common prefix / suffix on the id arrays;
//   3. runs the same greedy Myers search, with the same tie-break (a
//      deletion wins when deletion and insertion reach the same point), the
//      same edge rules (no move past either text's end, no edge pruning)
//      and the same snake rule, but keeps the furthest x of every (d, k) in
//      one small Int32Array per depth (row d holds 2d + 1 entries, value
//      x + 2, 0 for "no path") instead of one object per step, walking each
//      row with running indices (the two edge diagonals handled apart, so
//      the interior loop needs no range checks). Small per-depth rows stay
//      cache-hot where one flat trace does not;
//   4. backtracks the rows from the first (d, k) that reaches both ends,
//      re-deriving each step's deletion/insertion choice from the stored
//      row exactly as the forward search chose it, so the edit script is
//      the same path the reference's forward search walks;
//   5. builds the patch with the reference's own hunk rules.
//
// Deterministic, no network, stdlib-only. run(input) returns exactly what
// makefun-diff 1.0.0's diffPatch(input) returns.

const KEEP = 0;
const DELETE = 1;
const INSERT = 2;

/** The kept lines a hunk shows before and after each change run. */
const CONTEXT = 3;

/**
 * Split a text into its lines (each with its "\n", the last one without when
 * the text does not end in one), interning each line to an integer id in the
 * shared map and appending the id to `ids` and the line string to `lines`.
 * The empty text has no lines; "\n" has one, an empty line.
 */
function tokenize(text, ids, lines, intern) {
  let start = 0;
  const len = text.length;
  for (;;) {
    const nl = text.indexOf('\n', start);
    if (nl === -1) {
      if (start < len) {
        const line = text.slice(start);
        let id = intern.get(line);
        if (id === undefined) {
          id = intern.size;
          intern.set(line, id);
        }
        ids.push(id);
        lines.push(line);
      }
      return;
    }
    const line = text.slice(start, nl + 1);
    let id = intern.get(line);
    if (id === undefined) {
      id = intern.size;
      intern.set(line, id);
    }
    ids.push(id);
    lines.push(line);
    start = nl + 1;
  }
}

/**
 * Myers's greedy search on the id arrays a (length n) and b (length m).
 * Returns { rows, d }: rows[d] is an Int32Array of length 2d + 1 holding, at
 * index k + d, the furthest x reached on diagonal k after d edits plus 2 (0
 * when diagonal k has no path at depth d); d is the edit distance, the first
 * depth whose furthest point on diagonal n - m reaches both ends.
 */
function myersRows(a, b, n, m) {
  const rows = [];
  // d = 0: the snake from (-1, -1) on diagonal 0.
  let x = -1;
  let y = -1;
  while (x + 1 < n && y + 1 < m && a[x + 1] === b[y + 1]) {
    x++;
    y++;
  }
  let prev = new Int32Array(1);
  prev[0] = x + 2;
  rows.push(prev);
  if (x + 1 >= n && y + 1 >= m) return { rows, d: 0 };

  for (let d = 1; ; d++) {
    const cur = new Int32Array(2 * d + 1);
    // Edge diagonal k = -d: only the insertion candidate, from (d-1, -d+1).
    {
      const insS = prev[0];
      if (insS !== 0 && insS - 2 + d < m) {
        x = insS - 2;
        y = x + d;
        while (x + 1 < n && y + 1 < m && a[x + 1] === b[y + 1]) {
          x++;
          y++;
        }
        cur[0] = x + 2;
        if (x + 1 >= n && y + 1 >= m) {
          rows.push(cur);
          return { rows, d };
        }
      }
    }
    // Interior diagonals: both candidates in range; walk with running indices.
    for (let k = -d + 2, di = 0, ii = 2, oi = 2; k <= d - 2; k += 2, di += 2, ii += 2, oi += 2) {
      const delS = prev[di];
      const insS = prev[ii];
      const canRemove = delS !== 0 && delS - 1 < n;
      const canAdd = insS !== 0 && insS - 2 - k < m;
      if (!canRemove && !canAdd) continue; // cur[oi] stays 0: no path
      // The candidate further into the old text, the deletion on a tie.
      const byDeletion = canRemove ? delS - 1 : -2;
      const byInsertion = canAdd ? insS - 2 : -2;
      x = byDeletion >= byInsertion ? byDeletion : byInsertion;
      y = x - k;
      while (x + 1 < n && y + 1 < m && a[x + 1] === b[y + 1]) {
        x++;
        y++;
      }
      cur[oi] = x + 2;
      if (x + 1 >= n && y + 1 >= m) {
        rows.push(cur);
        return { rows, d };
      }
    }
    // Edge diagonal k = d: only the deletion candidate, from (d-1, d-1).
    {
      const delS = prev[2 * (d - 1)];
      if (delS !== 0 && delS - 1 < n) {
        x = delS - 1;
        y = x - d;
        while (x + 1 < n && y + 1 < m && a[x + 1] === b[y + 1]) {
          x++;
          y++;
        }
        cur[2 * d] = x + 2;
        if (x + 1 >= n && y + 1 >= m) {
          rows.push(cur);
          return { rows, d };
        }
      }
    }
    rows.push(cur);
    prev = cur;
  }
}

/**
 * The edit script's runs [{ kind, count }] for the id arrays a and b,
 * in order. kind is KEEP / DELETE / INSERT. Reproduces the reference's
 * forward path exactly by backtracking the rows.
 */
function editRuns(a, b, n, m) {
  const { rows, d: D } = myersRows(a, b, n, m);
  // Segments collected from the end backwards: [kind, count] pairs.
  const segs = [];
  let x = rows[D][(n - m) + D] - 2;
  let k = n - m;
  for (let d = D; d >= 1; d--) {
    const prev = rows[d - 1];
    const prevLo = -(d - 1);
    const prevHi = d - 1;
    const delS = k - 1 >= prevLo ? prev[(k - 1) + (d - 1)] : 0;
    const insS = k + 1 <= prevHi ? prev[(k + 1) + (d - 1)] : 0;
    const canRemove = delS !== 0 && delS - 1 < n;
    const canAdd = insS !== 0 && insS - 2 - k < m;
    const byDeletion = canRemove ? delS - 1 : -2;
    const byInsertion = canAdd ? insS - 2 : -2;
    // The same choice the forward search made at (d, k).
    const isDeletion = byDeletion >= byInsertion;
    const px = (isDeletion ? delS : insS) - 2;
    const pk = isDeletion ? k - 1 : k + 1;
    // The snake the forward search followed after this edit step.
    const snake = isDeletion ? x - (px + 1) : x - px;
    if (snake > 0) segs.push(KEEP, snake);
    segs.push(isDeletion ? DELETE : INSERT, 1);
    x = px;
    k = pk;
  }
  // The d = 0 snake, from (-1, -1) to the first path's furthest point.
  if (x + 1 > 0) segs.push(KEEP, x + 1);
  // Reverse into forward order, merging runs of one kind.
  const runs = [];
  for (let i = segs.length - 2; i >= 0; i -= 2) {
    const kind = segs[i];
    const count = segs[i + 1];
    const last = runs[runs.length - 1];
    if (last !== undefined && last.kind === kind) last.count += count;
    else runs.push({ kind, count });
  }
  return runs;
}

/** A line as the patch writes it: its op, the line, a newline, and "%" on a line of its own when it had none. */
function written(op, line) {
  return line.endsWith('\n') ? `${op}${line}` : `${op}${line}\n%\n`;
}

/** makefun-diff 1.0.0's answer for one case's input. */
export function run(input) {
  if (input === null || typeof input !== 'object' || typeof input.old !== 'string' || typeof input.new !== 'string') {
    throw new TypeError('makefun-diff: the input is { old, new }, two strings');
  }
  const intern = new Map();
  const aIds = [];
  const bIds = [];
  const aLines = [];
  const bLines = [];
  tokenize(input.old, aIds, aLines, intern);
  tokenize(input.new, bIds, bLines, intern);
  const a = Int32Array.from(aIds);
  const b = Int32Array.from(bIds);
  const n = a.length;
  const m = b.length;
  // The common prefix, then the common suffix of what is left.
  let prefix = 0;
  while (prefix < n && prefix < m && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < n - prefix && suffix < m - prefix && a[n - 1 - suffix] === b[m - 1 - suffix]) suffix++;
  const runs = [];
  if (prefix > 0) runs.push({ kind: KEEP, count: prefix });
  runs.push(...editRuns(a.subarray(prefix, n - suffix), b.subarray(prefix, m - suffix), n - prefix - suffix, m - prefix - suffix));
  if (suffix > 0) runs.push({ kind: KEEP, count: suffix });

  // The change runs: each a stretch of deletions and insertions between two kept lines, at old line o and new line p.
  const changes = [];
  let o = 0;
  let p = 0;
  let deleted = 0;
  let inserted = 0;
  for (const r of runs) {
    if (r.kind === KEEP) {
      o += r.count;
      p += r.count;
      continue;
    }
    let c = changes[changes.length - 1];
    if (c === undefined || c.o + c.dels !== o || c.p + c.ins !== p) {
      c = { o, p, dels: 0, ins: 0 };
      changes.push(c);
    }
    if (r.kind === DELETE) {
      c.dels += r.count;
      o += r.count;
      deleted += r.count;
    } else {
      c.ins += r.count;
      p += r.count;
      inserted += r.count;
    }
  }

  // The hunks: change runs at most 2 * CONTEXT kept lines apart share one.
  const hunks = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    const prev = h !== undefined ? h[h.length - 1] : undefined;
    if (prev !== undefined && c.o - (prev.o + prev.dels) <= 2 * CONTEXT) h.push(c);
    else hunks.push([c]);
  }
  const out = [`makefun-diff/1 old=${n} new=${m} hunks=${hunks.length} deleted=${deleted} inserted=${inserted}\n`];
  for (const h of hunks) {
    const first = h[0];
    const last = h[h.length - 1];
    const oldStart = Math.max(0, first.o - CONTEXT);
    const newStart = first.p - (first.o - oldStart);
    const after = Math.min(CONTEXT, n - (last.o + last.dels));
    const oldEnd = last.o + last.dels + after;
    const newEnd = last.p + last.ins + after;
    out.push(`@ ${oldStart + 1} ${oldEnd - oldStart} ${newStart + 1} ${newEnd - newStart}\n`);
    let at = oldStart;
    for (const c of h) {
      for (; at < c.o; at++) out.push(written('=', aLines[at]));
      for (let i = 0; i < c.dels; i++) out.push(written('-', aLines[c.o + i]));
      for (let i = 0; i < c.ins; i++) out.push(written('+', bLines[c.p + i]));
      at = c.o + c.dels;
    }
    for (; at < oldEnd; at++) out.push(written('=', aLines[at]));
  }
  return out.join('');
}
