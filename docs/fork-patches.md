# Carrying the fork as a patch series

The fork is normally maintained as a merge branch (`release/fork`, see the
`omp-fork-release` procedure). `scripts/fork-patches.ts` offers the alternative:
export the fork delta as a curated `.patch` series and replay it onto a fresh
upstream checkout with plain `git apply --3way`.

## Why the series is re-derived, not exported from history

`git format-patch v18.1.16..release/fork` does **not** work. That range is 53
commits, 11 of them merges, and `format-patch` drops merge commits — so the
linearized 42-patch series omits every conflict resolution the past upstream
syncs made. Replaying it onto the base tag fails at patch 1/42 in
`scripts/ci-test-ts.ts`, a file 3 fork commits touch and 3 past merges resolved.

`fork-patches.ts` therefore ignores fork history and re-derives the series from
the fork **delta**: it builds one commit per topic in a throwaway worktree at the
base tag, then exports one diff per topic. Each diff carries `index
<pre>..<post>` blob ids, so `git apply --3way` performs a real three-way merge
against a newer upstream instead of a context-only apply.

Before writing anything, the exporter asserts that the topic series reproduces
the fork tree exactly (modulo excluded paths) and fails if any path drifts.

## Layout

The series lives **in the fork repo**, committed to `fork-patches/`:

```
X:/public/oh-my-pi__custom
  scripts/fork-patches.ts      # the exporter (carried by the series itself)
  docs/fork-patches.md         # this file
  fork-patches/                # the exported series, tracked and committed
  patches/                     # NOT this — upstream's Bun patchedDependencies
```

Two rules make that safe, both enforced by the exporter:

1. `fork-patches/` is in `EXCLUDED_PATHS`, so an export never folds the previous
   export back into itself. Without it the series would grow without bound.
2. `--out` may only point inside the repo at an excluded path. Any other in-repo
   target is refused.

`fork-patches/` is deliberately **not** `patches/`: upstream already owns that
directory for Bun `patchedDependencies` (`@ark%2Fschema`, `puppeteer-core`, wired
from `package.json`). Those are real dependency patches and travel inside the
series like any other tracked file.

Checking out a pristine upstream tag removes the fork-only files, including the
series — recover it from the fork ref in one command (shown under Apply). An
external directory still works if you prefer it: `--out X:/public/omp-patches`.

## Export

```bash
cd X:/public/oh-my-pi__custom
bun scripts/fork-patches.ts plan                    # grouping only, writes nothing
bun scripts/fork-patches.ts export                  # -> fork-patches/
bun scripts/fork-patches.ts export --repo <dir> --base v18.1.16 --head release/fork
```

`--base` defaults to `v<version>` from `packages/natives/package.json` (that
package tracks the plain upstream version) and must be an ancestor of `--head`.
Output is `NNNN-<topic>.patch` plus `series.json`, which records the base/head
commits, each patch's subject, and its file list.

**Order matters: export, then commit.** The exporter requires a clean tree, and
its own output makes the tree dirty — so a second `export` fails until the first
one is committed:

```bash
bun scripts/fork-patches.ts export
git add fork-patches && git commit -m "chore(fork): refresh patch series"
bun scripts/fork-patches.ts export      # clean tree again; works
```

The exclusion is derived from the resolved `--out` for each run, not from a
hardcoded name, so exporting to any in-repo directory (`fork-patches/`,
`docs/series/`, …) keeps that directory out of its own series. `--out` may not
be the repo root.

Topics live in the `TOPICS` table in the script. Order is precedence — a file is
claimed by the first topic that matches, and the trailing `fork-misc` topic
catches anything unclaimed, so the series is always total over the delta. Empty
topics are dropped, so patch numbering shifts only when the table changes.

### What the grouping is and is not

Grouping is **path-first, not hunk-level semantic**. A file belongs entirely to
one topic, so a file touched by several features is labelled by whichever topic
claims it first — `packages/ai/src/auth-storage.ts` carries both auth-gateway
and account-selection work but lands in `account-selection`. Consequences to
accept before relying on this:

- Patches are an **ordered series**, applied `0001`→`NNNN`. They are not
  independently cherry-pickable and dropping one mid-series is not supported.
- Patch titles describe the dominant intent of their file set, not a clean
  feature boundary.
- What the exporter *does* guarantee is totality and fidelity: every delta path
  is claimed exactly once, and the assembled series is verified to reproduce the
  fork tree before any file is written.

A genuinely semantic queue (one reviewable commit per feature, split at hunk
level) has to be curated by hand with interactive rebase — the merge-based
history cannot yield it mechanically. This exporter is the pragmatic middle:
reviewable per-area patches derived automatically, re-derivable in seconds.

### The lockfile is excluded on purpose

`bun.lock` is in `EXCLUDED_PATHS`. Its fork delta is two kinds of change: the
`-fork.N` version strings, and incidental transitive drift from whenever
`bun install` last ran (`@connectrpc/connect` 2.1.2→2.2.0, `@emnapi/runtime`
1.11.2→1.11.3, `lucide-react` 1.41→1.42). None of it is fork intent, and on a
new upstream the lockfile must re-resolve against that upstream's manifests
anyway. So the tree-equivalence check asserts equality over fork-intent paths
and treats the lockfile as generated output — `bun install` is its source of
truth, not a patch.

## Apply

Plain git, no wrapper. Do it in a disposable worktree so a bad run costs
nothing, and drive the order from `series.json` rather than a shell glob (the
directory may hold unrelated files).

Read the patches **from the fork checkout**, and do not copy them into the
target worktree. `git checkout <fork-ref> -- fork-patches/` would stage those
files, which leaves the tree dirty before the first apply and makes the abort
below delete the series you just recovered:

```bash
cd X:/public/oh-my-pi__custom
DIR=$PWD/fork-patches                    # series stays here, in the fork checkout
git fetch upstream 'refs/tags/v*:refs/tags/v*'
git worktree add ../omp-try v<new-upstream> -b release/fork-next
cd ../omp-try

START=$(git rev-parse HEAD)              # clean tree; safe abort point
for p in $(jq -r '.patches[].patch' "$DIR/series.json"); do
  git apply --3way "$DIR/$p" || { echo "conflict in $p"; break; }
done

rm -f bun.lock && bun install            # excluded from the series
bun run check:ts
```

The exporter itself is restored into the new tree by the `fork-tooling` patch as
the series applies, so the new branch can re-export itself at the end of the
sync. The series then gets committed on the new branch by that export.

If the fork checkout is gone and only the git history remains, extract the
series to a scratch directory instead of into the worktree:

```bash
mkdir -p /tmp/series && git -C <repo> archive <fork-ref> fork-patches | tar -x -C /tmp/series --strip-components=1
DIR=/tmp/series
```

**On conflict**, `git apply --3way` leaves ordinary conflict markers in the
tree and `git status` lists the unmerged paths. Resolve them, then
`git add <paths>` — staging is **required** before applying the next patch,
because the following patch's three-way merge reads the index. Then resume the
loop from the patch after the one that failed.

**To abort**, use the recorded start commit — `git checkout -- .` is not enough,
since it neither unstages resolved files nor removes files the patches added:

```bash
git reset --hard "$START"
git clean -fd        # WARNING: deletes untracked files under the worktree
```

If you applied in a disposable worktree, `git worktree remove ../omp-try --force`
discards everything in one step and needs no `clean`.

Verified behaviour, with the series tracked in `fork-patches/`:

- 9 patches exported from `v18.1.16..<fork ref>` (148 delta files; `bun.lock`
  and the 10 `fork-patches/` artifacts excluded).
- All 9 apply to a pristine `v18.1.16` checkout at exit 0.
- After `git checkout <fork ref> -- fork-patches/`, the resulting tree differs
  from the fork tree in `bun.lock` only — including `scripts/fork-patches.ts`
  restored by the `fork-tooling` patch and upstream's `patches/` intact.
- Re-exporting from a commit that already contains the series still yields 9
  patches, proving the exclusion prevents self-absorption.

Running the exporter inside a freshly patched worktree requires `bun install`
first — it imports `@oh-my-pi/pi-natives`, so it fails on a tree with no
`node_modules` (exit 1, native addon resolve error). That is the documented
install step, not a defect in the series.

## Which workflow to use

A merge branch and a patch series cost the same conflict resolution — the fork's
weight is real (≈136 files, ~46k added lines, with `packages/ai/src/auth-storage.ts`
the hottest seam), and neither mechanism reduces it. The series buys
distribution convenience (a reviewable, portable set of customizations) and
costs topic-table curation; the merge branch buys recorded ancestry and
`git merge`'s rename detection. `release/fork` remains the shipping path.
