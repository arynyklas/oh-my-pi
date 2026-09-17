#!/usr/bin/env bun
/**
 * Export the fork delta as a curated `.patch` series so the fork can be carried
 * onto a new upstream checkout with plain `git apply --3way` instead of a merge.
 *
 * Why a *curated* series and not `git format-patch` over the fork history:
 * `v18.1.16..release/fork` is 53 commits, 11 of them merges. `format-patch`
 * drops merge commits, so the linearized 42-patch series omits every conflict
 * resolution past upstream syncs made — replaying it onto the base tag dies at
 * patch 1/42 in `scripts/ci-test-ts.ts` (a file 3 fork commits touch and 3 past
 * merges resolved). This script re-derives the series from the fork *delta*
 * instead: one commit per topic, built in a throwaway worktree at the base tag,
 * exported as one diff per topic. The diffs carry `index <pre>..<post>` blob
 * ids, so `git apply --3way` performs a real three-way merge on a newer
 * upstream rather than a context-only apply.
 *
 * Usage:
 *   bun scripts/fork-patches.ts plan                     # show topic grouping, write nothing
 *   bun scripts/fork-patches.ts export                    # -> fork-patches/ (tracked, in-repo)
 *   bun scripts/fork-patches.ts export --out ../omp-patches --repo .
 *
 * Applying is deliberately plain git — see docs/fork-patches.md. The series is
 * normally committed to `fork-patches/` on the fork branch; after checking out a
 * pristine upstream tag, recover it with `git checkout release/fork -- fork-patches/`.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { VcsGitRepo } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { isEnoent } from "@oh-my-pi/pi-utils";

/** A patch in the exported series: one commit, one topic, an ordered path filter. */
export interface Topic {
	/** Slug used for the commit subject and patch filename. */
	name: string;
	/** Commit subject, written as a conventional-commit line. */
	subject: string;
	/**
	 * Repo-relative path prefixes and exact paths owned by this topic. A file is
	 * claimed by the first topic that matches, so earlier topics win. A selector
	 * ending in `/` or `-` matches by prefix; anything else must match exactly.
	 */
	paths: readonly string[];
}

/**
 * Paths excluded from the series entirely.
 *
 * - `bun.lock` is regenerated per sync (`rm -f bun.lock && bun install`);
 *   patching it guarantees a conflict and carries no fork intent.
 * - `fork-patches/` is where the series itself is committed. Excluding it is
 *   what makes tracking the series in the fork repo safe: without this, every
 *   export would fold the previous export back into itself and the patches
 *   would grow without bound.
 *
 * NOTE: this is deliberately NOT `patches/`, which upstream already owns for
 * Bun `patchedDependencies` (see `package.json`). Those are real dependency
 * patches and must stay inside the series like any other tracked file.
 */
export const EXCLUDED_PATHS: readonly string[] = ["bun.lock", "fork-patches/"];

/**
 * Topic order is precedence order. Narrow, feature-specific topics come before
 * the broad per-package buckets, and `fork-misc` catches whatever is left so the
 * series is always total over the delta.
 */
export const TOPICS: readonly Topic[] = [
	{
		name: "fork-release-channel",
		subject: "build(fork): route version, update channel and installers to the fork",
		paths: [
			"package.json",
			"packages/coding-agent/package.json",
			"packages/utils/package.json",
			"packages/coding-agent/src/cli/release-info.ts",
			"packages/coding-agent/src/cli/update-cli.ts",
			"packages/coding-agent/test/release-info.test.ts",
			"packages/coding-agent/test/update-cli.test.ts",
			"packages/coding-agent/test/startup-update-check.test.ts",
			"packages/ai/test/openai-compat-user-agent.test.ts",
			"scripts/install-fork.ps1",
			"scripts/ci-release-publish.test.ts",
			"scripts/ci-test-ts.ts",
			"scripts/ci-test-ts.test.ts",
			"docs/fork-install.md",
		],
	},
	{
		name: "auth-gateway",
		subject: "feat(ai): add the auth gateway, access control and admin surfaces",
		paths: [
			"packages/ai/src/auth-gateway/",
			"packages/ai/src/auth-broker/remote-store.ts",
			"packages/ai/src/auth/sqlite-credential-store.ts",
			"packages/ai/test/auth-gateway-",
			"packages/ai/test/auth-broker-remote-store.test.ts",
			"packages/coding-agent/src/auth-gateway/",
			"packages/coding-agent/src/cli/auth-gateway-cli.ts",
			"packages/coding-agent/src/commands/auth-gateway.ts",
			"packages/coding-agent/src/modes/components/auth-gateway/",
			"packages/coding-agent/test/auth-gateway-",
			"docs/auth-broker-gateway.md",
		],
	},
	{
		name: "account-selection",
		subject: "feat(ai): pin provider accounts by priority and journal selections",
		paths: [
			"packages/ai/src/auth-storage.ts",
			"packages/ai/src/auth-broker/discover.ts",
			"packages/ai/test/auth-storage-",
			"packages/ai/test/discover-default-accounts.test.ts",
			"packages/coding-agent/src/session/auth-storage.ts",
			"packages/coding-agent/src/session/session-advisors.ts",
			"packages/coding-agent/src/slash-commands/helpers/account-priority.ts",
			"packages/coding-agent/src/slash-commands/helpers/active-oauth-account.ts",
			"packages/coding-agent/src/modes/components/account-manager-selector.ts",
			"packages/coding-agent/src/modes/components/oauth-selector.ts",
			"packages/coding-agent/src/modes/components/oauth-authorization-link.ts",
			"packages/coding-agent/test/modes/components/account-manager-selector.test.ts",
		],
	},
	{
		name: "status-line-account",
		subject: "feat(coding-agent): show the serving account in the custom status line",
		paths: [
			"packages/coding-agent/src/modes/components/status-line/",
			"packages/coding-agent/src/modes/theme/symbols.ts",
			"packages/coding-agent/src/modes/theme/theme-class.ts",
			"packages/coding-agent/src/cli/gallery-fixtures/segments.ts",
			"packages/coding-agent/test/status-line-model.test.ts",
			"packages/coding-agent/test/modes/components/status-line/",
		],
	},
	{
		name: "usage-and-stats",
		subject: "feat(stats): extend usage reporting, aggregation and CLI views",
		paths: [
			"packages/stats/",
			"packages/ai/src/usage/",
			"packages/coding-agent/src/cli/usage-cli.ts",
			"packages/coding-agent/src/cli/stats-cli.ts",
			"packages/coding-agent/src/utils/usage-format.ts",
			"packages/coding-agent/src/slash-commands/helpers/usage-report.ts",
			"packages/coding-agent/test/usage-cli.test.ts",
			"packages/coding-agent/test/modes/controllers/usage-command.test.ts",
		],
	},
	{
		name: "model-config",
		subject: "feat(coding-agent): extend model registry, patches and settings schema",
		paths: [
			"packages/coding-agent/src/config/",
			"packages/coding-agent/test/model-registry.test.ts",
			"packages/coding-agent/test/model-registry-command-values.test.ts",
			"docs/settings.md",
		],
	},
	{
		name: "tui-and-modes",
		subject: "feat(coding-agent): fork TUI controllers, selectors and slash commands",
		paths: [
			"packages/coding-agent/src/modes/",
			"packages/coding-agent/src/slash-commands/",
			"packages/coding-agent/src/session/",
			"packages/coding-agent/src/main.ts",
			"packages/coding-agent/src/utils/",
			"packages/coding-agent/test/",
			"packages/tui/",
			"packages/utils/src/",
		],
	},
	{
		// The series carries its own tooling on purpose. Applying needs nothing but
		// `git apply --3way`, so restoring the exporter as part of the series is what
		// lets the *next* export run from the freshly patched branch. The exported
		// series itself is never tracked in the repo — `runExport` refuses to write
		// inside the target checkout.
		name: "fork-tooling",
		subject: "build(fork): carry the patch-series exporter and its docs",
		paths: ["scripts/fork-patches.ts", "docs/fork-patches.md"],
	},
	{
		name: "changelogs",
		subject: "docs(fork): record fork changelog entries",
		paths: [
			"packages/ai/CHANGELOG.md",
			"packages/coding-agent/CHANGELOG.md",
			"packages/stats/CHANGELOG.md",
			"packages/tui/CHANGELOG.md",
		],
	},
	{
		name: "fork-misc",
		subject: "chore(fork): remaining fork deltas",
		paths: [],
	},
];

export interface TopicGroup {
	topic: Topic;
	files: string[];
}

/** One entry of the exported series, as recorded in `series.json`. */
export interface SeriesEntry {
	patch: string;
	topic: string;
	subject: string;
	files: string[];
}

export interface Series {
	base: string;
	baseCommit: string;
	head: string;
	headCommit: string;
	generated: string;
	excluded: readonly string[];
	patches: SeriesEntry[];
}

/**
 * Fatal condition. Throws rather than calling `process.exit()` so `finally`
 * blocks still run — `runExport` registers a temporary worktree that must be
 * removed even when restore/commit/diff fails.
 */
class FatalError extends Error {}

function fail(msg: string): never {
	throw new FatalError(msg);
}

function matchesPath(file: string, selector: string): boolean {
	return selector.endsWith("/") || selector.endsWith("-") ? file.startsWith(selector) : file === selector;
}

/**
 * Repo-relative exclusion prefixes for one run: the static list plus, when the
 * series is written inside the checkout, the actual `--out` directory. Deriving
 * it from the resolved output path is what keeps `--out docs/anywhere` from
 * exporting a series into its own next series.
 */
export function effectiveExclusions(outRelative?: string): readonly string[] {
	if (!outRelative) return EXCLUDED_PATHS;
	const prefix = outRelative.endsWith("/") ? outRelative : `${outRelative}/`;
	return EXCLUDED_PATHS.includes(prefix) ? EXCLUDED_PATHS : [...EXCLUDED_PATHS, prefix];
}

/**
 * Repo-relative, slash-normalized form of `outRoot` when it sits inside
 * `repoRoot`; `undefined` when it is outside (nothing extra to exclude) and
 * `""` when it *is* the repo root (never valid as an output directory).
 */
export function inRepoOutPrefix(repoRoot: string, outRoot: string): string | undefined {
	const rel = path.relative(repoRoot, outRoot).split(path.sep).join("/");
	if (rel.startsWith("..") || path.isAbsolute(rel)) return undefined;
	return rel;
}

/** Resolve the owning topic for one repo-relative path, or `undefined` when excluded. */
export function assignTopic(
	file: string,
	topics: readonly Topic[] = TOPICS,
	excluded: readonly string[] = EXCLUDED_PATHS,
): Topic | undefined {
	if (excluded.some(prefix => matchesPath(file, prefix))) return undefined;
	const owner = topics.find(topic => topic.paths.some(selector => matchesPath(file, selector)));
	return owner ?? topics.at(-1);
}

/**
 * Partition changed files into the series. Groups keep `TOPICS` order and drop
 * empty topics, so patch numbering stays stable as long as the topic table does.
 */
export function groupFiles(
	files: readonly string[],
	topics: readonly Topic[] = TOPICS,
	excluded: readonly string[] = EXCLUDED_PATHS,
): TopicGroup[] {
	const byTopic = new Map<string, string[]>();
	for (const file of [...files].sort()) {
		const topic = assignTopic(file, topics, excluded);
		if (!topic) continue;
		const bucket = byTopic.get(topic.name);
		if (bucket) bucket.push(file);
		else byTopic.set(topic.name, [file]);
	}
	return topics.flatMap(topic => {
		const grouped = byTopic.get(topic.name);
		return grouped ? [{ topic, files: grouped }] : [];
	});
}

export function patchFileName(index: number, topic: string): string {
	return `${String(index + 1).padStart(4, "0")}-${topic}.patch`;
}

/**
 * True when `name` is a filename this exporter could have written: a plain
 * basename (no directory part, no `..`, not absolute) in `NNNN-topic.patch`
 * form. Used to vet names read back from a `series.json` before unlinking them.
 */
export function isExporterPatchName(name: string): boolean {
	if (name !== path.basename(name)) return false;
	return /^\d{4}-[a-z0-9]+(?:-[a-z0-9]+)*\.patch$/.test(name);
}

function openRepo(dir: string): VcsGitRepo {
	const repo = vcs.git(path.resolve(dir));
	if (!repo) fail(`${path.resolve(dir)} is not a git repository`);
	return repo;
}

async function resolveOrFail(repo: VcsGitRepo, ref: string): Promise<string> {
	const sha = await repo.resolveRef(ref);
	if (!sha) fail(`cannot resolve ref: ${ref}`);
	return sha;
}

/**
 * The base tag is the upstream version the fork currently contains. Packages
 * other than coding-agent/utils keep the plain upstream version, so
 * `packages/natives/package.json` names the tag without needing tag discovery.
 */
async function detectBase(repo: VcsGitRepo, repoDir: string, head: string): Promise<string> {
	const manifest = path.join(repoDir, "packages", "natives", "package.json");
	const version = (await Bun.file(manifest).json()) as { version?: string };
	if (!version.version) fail(`no version in ${manifest}; pass --base <ref>`);
	const tag = `v${version.version}`;
	const tagCommit = await repo.resolveRef(tag);
	if (!tagCommit) fail(`detected base ${tag} does not exist; pass --base <ref>`);
	const headCommit = await resolveOrFail(repo, head);
	const merge = await repo.mergeBase(tagCommit, headCommit);
	if (merge !== tagCommit) fail(`detected base ${tag} is not an ancestor of ${head}; pass --base <ref>`);
	return tag;
}

async function requireClean(repo: VcsGitRepo): Promise<void> {
	if (await repo.isDirty()) {
		const status = await repo.statusPorcelain({ untracked: "normal" });
		const lines = status.split("\n").filter(Boolean);
		fail(`working tree is dirty (${lines.length} path(s)); commit or stash first`);
	}
}

async function runPlan(repoDir: string, baseRef: string | undefined, head: string, outDir: string): Promise<void> {
	const repo = openRepo(repoDir);
	const base = baseRef ?? (await detectBase(repo, repoDir, head));
	const exclusions = effectiveExclusions(inRepoOutPrefix(path.resolve(repoDir), path.resolve(outDir)));
	const files = await repo.changedFiles({ base, head });
	const groups = groupFiles(files, TOPICS, exclusions);
	const excluded = files.filter(file => !assignTopic(file, TOPICS, exclusions));
	console.log(`fork delta ${base}..${head}: ${files.length} file(s), ${groups.length} patch(es)`);
	for (const [index, { topic, files: owned }] of groups.entries()) {
		console.log(`  ${patchFileName(index, topic.name)}: ${owned.length} file(s)`);
	}
	if (excluded.length > 0) console.log(`  excluded: ${excluded.join(", ")}`);
}

/**
 * Prepare the output directory without ever deleting it recursively. `--out` is
 * required to be outside the checkout, so a typo (`--out X:/public`) would point
 * at unrelated data — this only removes files the previous `series.json` claims
 * as its own, and refuses to touch a non-empty directory that no manifest owns.
 */
async function prepareOutDir(outRoot: string): Promise<void> {
	let existing: string[];
	try {
		existing = await fs.readdir(outRoot);
	} catch (err) {
		if (!isEnoent(err)) throw err;
		await fs.mkdir(outRoot, { recursive: true });
		return;
	}
	if (existing.length === 0) return;

	let prior: Series | undefined;
	try {
		prior = (await Bun.file(path.join(outRoot, "series.json")).json()) as Series;
	} catch {
		prior = undefined;
	}
	if (!prior?.patches) {
		fail(
			`${outRoot} is not empty and holds no series.json; refusing to write into a directory this exporter does not own`,
		);
	}
	// Only manifest-listed artifacts are replaced; anything else in the directory
	// (a README, a sibling series, unrelated files) is left untouched. Names come
	// from a file on disk, so each is validated as a plain basename in this
	// exporter's own format — a corrupted or foreign manifest must not be able to
	// escape `outRoot` via `../` or an absolute path.
	const claimed = prior.patches
		.map(entry => entry.patch)
		.filter(name => typeof name === "string" && isExporterPatchName(name));
	const owned = ["series.json", ...claimed];
	await Promise.all(owned.map(name => fs.rm(path.join(outRoot, name), { force: true })));
}

async function runExport(repoDir: string, baseRef: string | undefined, head: string, outDir: string): Promise<void> {
	const repo = openRepo(repoDir);
	const repoRoot = path.resolve(repoDir);
	const outRoot = path.resolve(outDir);
	// The series may live inside the checkout it describes, but only at a path this
	// run also excludes from the delta — otherwise the next export folds the
	// previous series back into itself. `inRepoOutPrefix` returns that path when
	// `--out` is inside the repo, and the exclusion is derived from it rather than
	// assumed, so `--out docs/anywhere` is handled too. Outside the repo is fine.
	const outPrefix = inRepoOutPrefix(repoRoot, outRoot);
	const exclusions = effectiveExclusions(outPrefix);
	if (outPrefix === "") {
		fail(`--out ${outRoot} is the checkout root ${repoRoot}; use a subdirectory or a path outside the repo`);
	}
	const base = baseRef ?? (await detectBase(repo, repoDir, head));
	await requireClean(repo);

	const files = await repo.changedFiles({ base, head });
	if (files.length === 0) fail(`no delta between ${base} and ${head}`);
	const groups = groupFiles(files, TOPICS, exclusions);
	const baseCommit = await resolveOrFail(repo, base);
	const headCommit = await resolveOrFail(repo, head);

	const worktree = path.join(os.tmpdir(), `omp-fork-series-${process.pid}`);
	await fs.rm(worktree, { recursive: true, force: true });
	await repo.worktreeAdd(worktree, baseCommit, { detach: true, clone: false });
	try {
		const series = openRepo(worktree);
		const entries: SeriesEntry[] = [];
		const patches: string[] = [];
		let parent = baseCommit;
		for (const [index, { topic, files: owned }] of groups.entries()) {
			await series.restore({ source: headCommit, staged: true, worktree: true, files: owned });
			const commit = await series.commitCreate(topic.subject, { files: owned });
			const diff = await series.diffText({ base: parent, head: commit, binary: true });
			if (!diff.trim()) fail(`topic ${topic.name} produced an empty patch`);
			patches.push(diff);
			entries.push({
				patch: patchFileName(index, topic.name),
				topic: topic.name,
				subject: topic.subject,
				files: owned,
			});
			parent = commit;
		}

		// The series must reproduce the fork tree exactly, modulo excluded paths.
		const drift = (await series.changedFiles({ base: headCommit })).filter(
			file => !exclusions.some(ex => matchesPath(file, ex)),
		);
		if (drift.length > 0) fail(`series does not reproduce ${head}; drifting path(s):\n  ${drift.join("\n  ")}`);

		await prepareOutDir(outRoot);
		await Promise.all(entries.map((entry, index) => Bun.write(path.join(outRoot, entry.patch), patches[index])));
		const manifest: Series = {
			base,
			baseCommit,
			head,
			headCommit,
			generated: new Date().toISOString(),
			excluded: exclusions,
			patches: entries,
		};
		await Bun.write(path.join(outRoot, "series.json"), `${JSON.stringify(manifest, null, "\t")}\n`);

		console.log(`Exported ${entries.length} patch(es) for ${base}..${head} into ${outDir}/`);
		for (const entry of entries) console.log(`  ${entry.patch} (${entry.files.length} file(s))`);
		console.log(`Excluded (regenerate after applying): ${EXCLUDED_PATHS.join(", ")}`);
		console.log("Apply with: git apply --3way <dir>/*.patch   (see docs/fork-patches.md)");
	} finally {
		await repo.worktreeRemove(worktree, true);
		await fs.rm(worktree, { recursive: true, force: true });
	}
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	const command = argv[0];
	let repoDir = ".";
	let base: string | undefined;
	let head = "HEAD";
	let outDir = "fork-patches";
	for (let i = 1; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--repo") repoDir = argv[++i] ?? repoDir;
		else if (arg === "--base") base = argv[++i];
		else if (arg === "--head") head = argv[++i] ?? head;
		else if (arg === "--out") outDir = argv[++i] ?? outDir;
		else fail(`unknown argument: ${arg}`);
	}

	switch (command) {
		case "plan":
			await runPlan(repoDir, base, head, outDir);
			return;
		case "export":
			await runExport(repoDir, base, head, outDir);
			return;
		default:
			console.log("usage: fork-patches.ts <plan|export> [--repo <dir>] [--base <ref>] [--head <ref>] [--out <dir>]");
			process.exitCode = command ? 1 : 0;
	}
}

if (import.meta.main) {
	try {
		await main();
	} catch (err) {
		if (!(err instanceof FatalError)) throw err;
		console.error(`error: ${err.message}`);
		process.exitCode = 1;
	}
}
