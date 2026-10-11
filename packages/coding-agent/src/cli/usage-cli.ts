/**
 * Usage CLI command handler.
 *
 * Handles `omp usage` — fetches provider usage reports for every
 * authenticated account and prints a detailed per-account breakdown
 * (limits, windows, reset times, plan metadata). Accounts whose
 * credentials produced no usage report are listed too, so the output
 * always covers the full credential pool.
 */
import {
	type AuthStorage,
	type DisabledCredentialSummary,
	type OAuthAccountIdentity,
	type ResetCreditRedeemOutcome,
	resolveCredentialIdentityKey,
	type UsageHistoryEntry,
	type UsageReport,
} from "@oh-my-pi/pi-ai";
import { AuthBrokerClient, AuthBrokerError } from "@oh-my-pi/pi-ai/auth-broker";
import type { ClientUsageClientSummary } from "@oh-my-pi/pi-ai/usage";
import { formatDuration, formatNumber, getProjectDir, sanitizeText } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { discoverAuthStorage, loadCliExtensionProviders } from "../sdk";
import { formatActiveAccountLabel } from "../slash-commands/helpers/active-oauth-account";
import { resolveAuthBrokerConfig } from "../session/auth-broker-config";
import { resetAccountLockKey } from "../session/codex-auto-reset";
import { checkCodexBalance, type ResetMarker, resetLockPath, withResetFence } from "../session/reset-fence";
import { errorMessage } from "../slash-commands/helpers/parse";
import {
	describeRedeemOutcome,
	formatResetProviderName,
	formatResetUsageAccountLine,
	normalizeResetProvider,
	oneLine,
	parseResetUsageTarget,
	resolveResetUsageTarget,
	toResetUsageAccount,
} from "../slash-commands/helpers/reset-usage";
import {
	collectStoredAccounts,
	collectUnreportedAccounts,
	selectReportableAccounts,
	type UsageAccountIdentity,
} from "../slash-commands/helpers/usage-accounts";
import {
	computeProviderWindowStats,
	formatProviderName,
	formatQualifiedIdentity,
	formatUsageBreakdown,
	isActionableDisable,
	type LimitStatus,
	type ProviderWindowStat,
	STATUS_COLOR,
	type UsagePolicyDiagnosticsOptions,
	type UsageResetExpiryOptions,
} from "../utils/usage-format";

import { cfgRetryUsageReservePct } from "../session/settings";

export * from "../utils/usage-format";

export interface UsageCommandArgs {
	action?: string;
	json?: boolean;
	provider?: string;
	/** `<provider>/<credential id>` saved reset to spend (with the `reset` action). */
	target?: string;
	redact?: boolean;
	/** Show recorded usage-limit history instead of a live snapshot. */
	history?: boolean;
	/** History window in days (with `history` or the `clients` action). */
	days?: number;
	/** CLI `-e <path>` extension paths to load before fetching live reports. */
	extensions?: string[];
	/** Skip extension discovery; only load explicit `extensions`. */
	noExtensions?: boolean;
}

/**
 * Minimal-reveal masks for identity strings (`--redact`).
 *
 * Every mask shows a two-character anchor. When two identities share the
 * anchor, the mask additionally reveals the shortest "middle-out"
 * differentiator — the shortest substring (closest to the string's middle on
 * ties) that no colliding identity contains — as `an*`, `ca*9*`, `ca*nb*`.
 * Prefix growth is deliberately avoided: it leaks the start of the local
 * part (`can.boluk@*`) when a couple of mid-string characters suffice.
 * Duplicate strings (same account on two providers) share a mask.
 */
export function buildRedactionMap(values: Iterable<string>): Map<string, string> {
	const unique = [...new Set(values)];
	const map = new Map<string, string>();
	const byAnchor = new Map<string, string[]>();
	for (const value of unique) {
		const anchor = value.slice(0, 2);
		const list = byAnchor.get(anchor) ?? [];
		list.push(value);
		byAnchor.set(anchor, list);
	}
	for (const value of unique) {
		const anchor = value.slice(0, 2);
		const peers = (byAnchor.get(anchor) ?? []).filter(other => other !== value);
		if (peers.length === 0) {
			map.set(value, `${anchor}*`);
			continue;
		}
		const infix = findDistinguishingInfix(value, peers);
		map.set(value, infix === undefined ? `${anchor}*` : `${anchor}*${infix}*`);
	}
	// Residual collisions (a value whose every substring also occurs in a
	// peer gets the bare anchor mask) fall back to prefix extension.
	const byMask = new Map<string, string[]>();
	for (const value of unique) {
		const mask = map.get(value)!;
		const list = byMask.get(mask) ?? [];
		list.push(value);
		byMask.set(mask, list);
	}
	for (const collided of byMask.values()) {
		if (collided.length < 2) continue;
		for (const value of collided) {
			let length = Math.min(2, value.length);
			while (
				length < value.length &&
				collided.some(other => other !== value && other.startsWith(value.slice(0, length)))
			) {
				length++;
			}
			map.set(value, `${value.slice(0, length)}*`);
		}
	}
	return map;
}

/**
 * Shortest substring of `value` (past the revealed two-char anchor) that no
 * peer contains. Among equal-length candidates, picks the one centered
 * closest to the middle of the string. Returns undefined when every
 * substring also occurs in a peer (e.g. `value` is contained in a peer —
 * that peer's own differentiator keeps the masks distinct).
 */
function findDistinguishingInfix(value: string, peers: string[]): string | undefined {
	const start = Math.min(2, value.length);
	const center = value.length / 2;
	for (let length = 1; length <= value.length - start; length++) {
		let best: { infix: string; distance: number } | undefined;
		for (let pos = start; pos + length <= value.length; pos++) {
			const candidate = value.slice(pos, pos + length);
			if (peers.some(peer => peer.includes(candidate))) continue;
			const distance = Math.abs(pos + length / 2 - center);
			if (!best || distance < best.distance) best = { infix: candidate, distance };
		}
		if (best) return best.infix;
	}
	return undefined;
}

/** Every identity string the output could surface — input for {@link buildRedactionMap}. */
function collectIdentityStrings(
	reports: UsageReport[],
	accounts: UsageAccountIdentity[],
	disabled: DisabledCredentialSummary[] = [],
): string[] {
	const values: string[] = [];
	const add = (value: unknown): void => {
		if (typeof value === "string" && value) values.push(value);
	};
	for (const report of reports) {
		const meta = report.metadata ?? {};
		add(meta.email);
		add(meta.accountId);
		add(meta.projectId);
		add(meta.orgId);
		add(meta.orgName);
		for (const limit of report.limits) {
			add(limit.scope.accountId);
			add(limit.scope.projectId);
			add(limit.scope.orgId);
		}
	}
	for (const account of accounts) {
		add(account.email);
		add(account.accountId);
		add(account.projectId);
		add(account.orgId);
		add(account.orgName);
		add(account.enterpriseUrl);
	}
	for (const summary of disabled) {
		add(summary.email);
		add(summary.accountId);
		add(summary.orgId);
		add(summary.orgName);
	}
	return values;
}

const HISTORY_SPARK_WIDTH = 48;
const SPARK_LEVELS = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"] as const;

interface HistorySeries {
	title: string;
	/** Snapshots ascending by recordedAt (listUsageHistory order). */
	entries: UsageHistoryEntry[];
}

interface HistoryAccount {
	label: string;
	provider: string;
	email?: string;
	accountId?: string;
	recordedAt: number;
	series: Map<string, HistorySeries>;
}

/** Mirror of {@link limitTitle} for history rows (no scope/tier available). */
function historySeriesTitle(entry: UsageHistoryEntry): string {
	const label = entry.label;
	const windowLabel = entry.windowLabel;
	if (!windowLabel) return label;
	if (windowLabel.toLowerCase() === "quota window") return label;
	if (label.toLowerCase().includes(windowLabel.toLowerCase())) return label;
	return `${label} (${windowLabel})`;
}

function historyAccount(entry: UsageHistoryEntry): HistoryAccount {
	return {
		label: entry.email ?? entry.accountId ?? entry.accountKey,
		provider: entry.provider,
		email: entry.email,
		accountId: entry.accountId,
		recordedAt: entry.recordedAt,
		series: new Map(),
	};
}

/** Identity stand-in so same-email accounts get the main view's qualifier. */
function historyIdentityReport(account: HistoryAccount): UsageReport {
	return {
		provider: account.provider,
		fetchedAt: account.recordedAt,
		limits: [],
		metadata: { email: account.email, accountId: account.accountId },
	};
}

function historyStatus(fraction: number | undefined, status: UsageHistoryEntry["status"]): LimitStatus {
	if (status && status !== "unknown") return status;
	if (fraction === undefined) return "unknown";
	if (fraction >= 1) return "exhausted";
	if (fraction >= 0.8) return "warning";
	return "ok";
}

/** Peak-per-bucket sparkline over [sinceMs, nowMs]; empty buckets render dim dots. */
function renderHistorySparkline(entries: UsageHistoryEntry[], sinceMs: number, nowMs: number): string {
	const span = Math.max(1, nowMs - sinceMs);
	// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
	const buckets: Array<number | undefined> = new Array(HISTORY_SPARK_WIDTH).fill(undefined);
	for (const entry of entries) {
		if (entry.usedFraction === undefined) continue;
		const offset = Math.floor(((entry.recordedAt - sinceMs) / span) * HISTORY_SPARK_WIDTH);
		const index = Math.min(HISTORY_SPARK_WIDTH - 1, Math.max(0, offset));
		const prev = buckets[index];
		buckets[index] = prev === undefined ? entry.usedFraction : Math.max(prev, entry.usedFraction);
	}
	return buckets
		.map(fraction => {
			if (fraction === undefined) return chalk.dim("·");
			const clamped = Math.min(Math.max(fraction, 0), 1);
			const level = SPARK_LEVELS[Math.min(SPARK_LEVELS.length - 1, Math.floor(clamped * SPARK_LEVELS.length))];
			return STATUS_COLOR[historyStatus(clamped, undefined)](level);
		})
		.join("");
}

/** Identity strings a history rendering could surface — input for {@link buildRedactionMap}. */
export function collectHistoryIdentityStrings(entries: UsageHistoryEntry[]): string[] {
	const values: string[] = [];
	for (const entry of entries) {
		if (entry.email) values.push(entry.email);
		if (entry.accountId) values.push(entry.accountId);
		values.push(entry.accountKey);
	}
	return values;
}

/**
 * Render recorded usage-limit history: per provider, per account, one
 * peak-per-bucket sparkline per limit window plus latest/peak percentages.
 */
export function formatUsageHistory(
	entries: UsageHistoryEntry[],
	sinceMs: number,
	nowMs: number,
	redaction?: Map<string, string>,
): string {
	const providers = new Map<string, Map<string, HistoryAccount>>();
	for (const entry of entries) {
		let accounts = providers.get(entry.provider);
		if (!accounts) {
			accounts = new Map();
			providers.set(entry.provider, accounts);
		}
		let account = accounts.get(entry.accountKey);
		if (!account) {
			account = historyAccount(entry);
			accounts.set(entry.accountKey, account);
		}
		let series = account.series.get(entry.limitId);
		if (!series) {
			series = { title: historySeriesTitle(entry), entries: [] };
			account.series.set(entry.limitId, series);
		}
		// Labels can change across snapshots (provider renames); latest wins.
		series.title = historySeriesTitle(entry);
		series.entries.push(entry);
	}

	const lines: string[] = [];
	lines.push(
		`${chalk.bold("Usage history")}${chalk.dim(` · last ${formatDuration(nowMs - sinceMs)} · peak per bucket`)}`,
	);

	for (const provider of [...providers.keys()].sort((a, b) => a.localeCompare(b))) {
		const accounts = providers.get(provider) ?? new Map<string, HistoryAccount>();
		lines.push("");
		lines.push(
			`${chalk.bold.cyan(formatProviderName(provider))} ${chalk.dim(`— ${accounts.size} ${accounts.size === 1 ? "account" : "accounts"}`)}`,
		);
		const sortedAccounts = [...accounts.values()].sort((a, b) => a.label.localeCompare(b.label));
		const reports = provider === "openai-codex" ? sortedAccounts.map(historyIdentityReport) : undefined;
		for (const [index, account] of sortedAccounts.entries()) {
			const identity = reports
				? formatQualifiedIdentity(reports[index], reports, account.label, redaction)
				: chalk.bold(redaction?.get(account.label) ?? account.label);
			lines.push(`  ${identity}`);
			const labelWidth = [...account.series.values()].reduce((max, series) => Math.max(max, series.title.length), 0);
			const sortedSeries = [...account.series.values()].sort((a, b) => a.title.localeCompare(b.title));
			for (const series of sortedSeries) {
				const fractions = series.entries
					.map(entry => entry.usedFraction)
					.filter((fraction): fraction is number => fraction !== undefined);
				const latestEntry = series.entries[series.entries.length - 1];
				const latestFraction = fractions.length > 0 ? fractions[fractions.length - 1] : undefined;
				const peakFraction = fractions.length > 0 ? Math.max(...fractions) : undefined;
				const status = historyStatus(latestFraction, latestEntry?.status);
				const details: string[] = [];
				if (latestFraction !== undefined) details.push(`latest ${(latestFraction * 100).toFixed(1)}%`);
				if (peakFraction !== undefined) details.push(`peak ${(peakFraction * 100).toFixed(1)}%`);
				details.push(`${series.entries.length} snapshot${series.entries.length === 1 ? "" : "s"}`);
				lines.push(
					`      ${STATUS_COLOR[status]("●")} ${series.title.padEnd(labelWidth)}  ${renderHistorySparkline(series.entries, sinceMs, nowMs)}  ${chalk.dim(details.join(" · "))}`,
				);
			}
		}
	}

	return lines.join("\n");
}

/**
 * Load extension usage providers and refresh broker credentials, so usage
 * lookups see every provider and account the live session would.
 */
async function loadUsageSources(
	cmd: UsageCommandArgs,
	settings: Settings,
	authStorage: AuthStorage,
): Promise<ModelRegistry> {
	const modelRegistry = new ModelRegistry(authStorage);
	// Extensions contribute usage providers via `registerProvider(name, { usage })`;
	// without loading them their accounts land in `accountsWithoutUsage`.
	await loadCliExtensionProviders(modelRegistry, settings, getProjectDir(), {
		additionalExtensionPaths: cmd.extensions,
		disableExtensionDiscovery: cmd.noExtensions,
		includeAmbientHooks: false,
		discoverModels: false,
	});
	// The broker may serve reports for credentials newer than the local
	// snapshot. Refresh before probing extension providers with local keys
	// and before labeling accounts; offline brokers keep the cached snapshot.
	try {
		await authStorage.credentials.revalidate();
	} catch {
		// Stale identities beat no output.
	}
	return modelRegistry;
}

/** Name the providers that do hold credentials so a mistyped `--provider` id is easy to correct. */
function formatNoProviderCredentials(provider: string, storedAccounts: UsageAccountIdentity[]): string {
	const stored = [...new Set(storedAccounts.map(account => account.provider))].sort();
	const hint =
		stored.length > 0
			? `Providers with stored credentials: ${stored.join(", ")}.`
			: "Run `omp` and use /login to add accounts.";
	return `No credentials stored for provider "${provider}". ${hint}\n`;
}

/** Apply a redaction mask to an optional identity field. */
function maskIdentity(redaction: Map<string, string>, value: string | undefined): string | undefined {
	return value === undefined ? undefined : (redaction.get(value) ?? value);
}

const IDENTITY_METADATA_KEYS = ["email", "accountId", "projectId", "orgId", "orgName"] as const;

/** Mask identity fields in a raw-stripped report for `--redact --json`. */
function redactReportForJson(
	report: Omit<UsageReport, "raw">,
	redaction: Map<string, string>,
): Omit<UsageReport, "raw"> {
	let metadata = report.metadata;
	if (metadata) {
		metadata = { ...metadata };
		for (const key of IDENTITY_METADATA_KEYS) {
			const value = metadata[key];
			if (typeof value === "string") metadata[key] = redaction.get(value) ?? value;
		}
	}
	const limits = report.limits.map(limit => ({
		...limit,
		scope: {
			...limit.scope,
			accountId: maskIdentity(redaction, limit.scope.accountId),
			projectId: maskIdentity(redaction, limit.scope.projectId),
			orgId: maskIdentity(redaction, limit.scope.orgId),
		},
	}));
	return { ...report, metadata, limits };
}

/** Compact token count for burn tables: 1234 → "1.2k", 4_500_000_000 → "4.50B". */
function formatTokenCount(value: number): string {
	if (value >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
	if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
	if (value >= 1e3) return `${(value / 1e3).toFixed(1)}k`;
	return String(Math.round(value));
}

/**
 * Render per-client token burn: one section per install (hostname, short
 * install id, last-seen), one row per (app, provider) aggregate, plus a
 * per-client total. Data comes from broker `/v1/usage/clients` or the local
 * agent DB when this machine hosts the broker.
 */
export function formatClientUsage(clients: ClientUsageClientSummary[], sinceMs: number, nowMs: number): string {
	const lines: string[] = [];
	lines.push(chalk.bold(`Per-client token burn since ${new Date(sinceMs).toISOString().slice(0, 10)}`));
	const headers = ["app", "provider", "requests", "input", "output", "cache r", "cache w", "total", "est cost"];
	for (const client of clients) {
		const label = client.hostname ?? client.installId;
		const idNote = client.hostname ? ` · ${client.installId.slice(0, 8)}` : "";
		const lastSeen = `last seen ${formatDuration(Math.max(0, nowMs - client.lastSeen))} ago`;
		lines.push("");
		lines.push(`${chalk.cyan(label)}${chalk.dim(idNote)} ${chalk.dim(`· ${lastSeen}`)}`);
		if (client.providers.length === 0) {
			lines.push(chalk.dim("  no usage in this window"));
			continue;
		}
		const rows: string[][] = client.providers.map(usage => [
			usage.app ?? "—",
			usage.provider,
			formatNumber(usage.requests),
			formatTokenCount(usage.inputTokens),
			formatTokenCount(usage.outputTokens),
			formatTokenCount(usage.cacheReadTokens),
			formatTokenCount(usage.cacheWriteTokens),
			formatTokenCount(usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens),
			`$${usage.costUsd.toFixed(2)}`,
		]);
		const total = client.providers.reduce(
			(acc, usage) => {
				acc.requests += usage.requests;
				acc.tokens += usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
				acc.costUsd += usage.costUsd;
				return acc;
			},
			{ requests: 0, tokens: 0, costUsd: 0 },
		);
		rows.push([
			"",
			"total",
			formatNumber(total.requests),
			"",
			"",
			"",
			"",
			formatTokenCount(total.tokens),
			`$${total.costUsd.toFixed(2)}`,
		]);
		const widths = headers.map((header, column) => Math.max(header.length, ...rows.map(row => row[column].length)));
		const renderRow = (cells: string[]): string =>
			`  ${cells.map((cell, column) => (column < 2 ? cell.padEnd(widths[column]) : cell.padStart(widths[column]))).join("  ")}`;
		lines.push(chalk.dim(renderRow(headers)));
		for (const [index, row] of rows.entries()) {
			const rendered = renderRow(row);
			lines.push(index === rows.length - 1 ? chalk.bold(rendered) : rendered);
		}
	}
	return lines.join("\n");
}
/** The configured auth broker's client, or undefined when this machine reads its own store. */
async function resolveBrokerClient(): Promise<AuthBrokerClient | undefined> {
	const config = await resolveAuthBrokerConfig();
	return config ? new AuthBrokerClient({ url: config.url, token: config.token }) : undefined;
}

/** One OAuth account as `omp usage accounts` lists it. */
interface OAuthIdentityKeyRow {
	provider: string;
	/** `null` when the credential carries no account identity, so no pool can name it. */
	identityKey: string | null;
	/** Organization or workspace display name, when the provider reports one. */
	orgName?: string;
}

/**
 * Every OAuth account this process sees (after any broker account pool), with
 * the identity key that `task.agentAccountPools`, `sessions.restrict`, and
 * broker account pools match. Only the provider, the key, and the
 * organization's display name leave each credential; tokens never do.
 */
function collectOAuthIdentityKeys(authStorage: AuthStorage, provider: string | undefined): OAuthIdentityKeyRow[] {
	const rows: OAuthIdentityKeyRow[] = [];
	for (const { provider: rowProvider, credential } of authStorage.credentials.list(provider)) {
		if (credential.type !== "oauth") continue;
		const identityKey = resolveCredentialIdentityKey(rowProvider, credential);
		rows.push(
			credential.orgName
				? { provider: rowProvider, identityKey, orgName: credential.orgName }
				: { provider: rowProvider, identityKey },
		);
	}
	return rows;
}

/** Render {@link collectOAuthIdentityKeys} rows grouped under their provider, one key per line. */
function formatOAuthIdentityKeys(rows: readonly OAuthIdentityKeyRow[]): string {
	const width = Math.max(...rows.map(row => row.identityKey?.length ?? 0));
	const lines: string[] = [];
	let provider: string | undefined;
	for (const row of rows) {
		if (row.provider !== provider) {
			provider = row.provider;
			lines.push(chalk.bold(provider));
		}
		if (row.identityKey === null) {
			lines.push(chalk.dim("  (no identity key: no pool can name this account)"));
			continue;
		}
		const orgName = row.orgName ? sanitizeText(row.orgName.replace(/[\r\n\t]+/g, " ")) : undefined;
		lines.push(orgName ? `  ${row.identityKey.padEnd(width)}  ${chalk.dim(orgName)}` : `  ${row.identityKey}`);
	}
	return lines.join("\n");
}

const RESET_COMMAND = "omp usage reset";

function failUsageReset(message: string): void {
	process.stderr.write(chalk.red(`${message}\n`));
	process.exitCode = 1;
}

/**
 * Mask each identity wherever it appears inside free text (`--redact`):
 * its stored spelling or its lowercase form, case-insensitively, in one pass so
 * a mask is never matched again; the longest identity wins an overlap.
 */
function identityTextMasker(redaction: Map<string, string>): (text: string) => string {
	if (redaction.size === 0) return text => text;
	const byLowerCase = new Map([...redaction].map(([value, mask]) => [value.toLowerCase(), mask]));
	const pattern = new RegExp(
		[...new Set([...redaction.keys(), ...byLowerCase.keys()])]
			.sort((a, b) => b.length - a.length)
			.map(value => RegExp.escape(value))
			.join("|"),
		"gi",
	);
	return text => text.replace(pattern, value => redaction.get(value) ?? byLowerCase.get(value.toLowerCase()) ?? value);
}

/**
 * `omp usage reset [<provider>/<credential id>]`: list every stored Codex and
 * Claude account's saved resets, or spend one on the named account. Both run in
 * this process with the store's tokens, so a broker client works like the host.
 */
async function runUsageResetCommand(
	cmd: UsageCommandArgs,
	settings: Settings,
	authStorage: AuthStorage,
): Promise<void> {
	let providers = ["openai-codex", "anthropic"];
	if (cmd.target) {
		const target = parseResetUsageTarget(cmd.target, RESET_COMMAND);
		if ("error" in target) {
			failUsageReset(target.error);
			return;
		}
		if (target.account === "active") {
			failUsageReset(
				`\`${RESET_COMMAND}\` runs outside a session, so no account is active. Name one by the credential id \`${RESET_COMMAND}\` lists.`,
			);
			return;
		}
		providers = [target.provider];
	} else if (cmd.provider) {
		const provider = normalizeResetProvider(cmd.provider);
		if (!provider) {
			failUsageReset(
				"Saved resets exist only for Codex and Claude accounts. Use --provider openai-codex or anthropic.",
			);
			return;
		}
		providers = [provider];
	}
	const modelRegistry = await loadUsageSources(cmd, settings, authStorage);
	const baseUrlResolver = (provider: string) => modelRegistry.getProviderBaseUrl(provider);
	// Codex's listing requests carry no timeout of their own (Claude's discovery
	// bounds each request), so a stalled endpoint cannot hang a script.
	const statuses = (
		await Promise.all(
			providers.map(provider =>
				authStorage.resets.list({
					provider,
					baseUrlResolver,
					signal: provider === "openai-codex" ? AbortSignal.timeout(10_000) : undefined,
				}),
			),
		)
	).flat();
	const redaction = cmd.redact
		? buildRedactionMap(
				statuses.flatMap(status =>
					[status.email, status.accountId, status.orgId, status.orgName].filter(
						(value): value is string => !!value,
					),
				),
			)
		: new Map<string, string>();
	const maskText = identityTextMasker(redaction);
	const maskOptionalText = (text: string | undefined) => (text === undefined ? undefined : maskText(text));
	// Rows are built and judged from the stored statuses; `--redact` then masks only
	// what is printed (identities and provider free text such as credit titles,
	// reasons and errors), so provider, credential and credit ids stay canonical.
	const accounts = statuses.map(status => {
		const account = toResetUsageAccount(status);
		return {
			...account,
			label: maskText(account.label),
			error: maskOptionalText(account.error),
			unavailableReason: maskOptionalText(account.unavailableReason),
		};
	});

	if (!cmd.target) {
		if (cmd.json) {
			const rows = statuses.map((status, index) => {
				const account = accounts[index];
				return {
					provider: status.provider,
					credentialId: status.credentialId,
					email: maskIdentity(redaction, status.email),
					accountId: maskIdentity(redaction, status.accountId),
					orgId: maskIdentity(redaction, status.orgId),
					orgName: maskIdentity(redaction, status.orgName),
					availableCount: account.availableCount,
					redeemableCount: account.redeemableCount,
					nextCreditId: status.nextCreditId,
					soonestExpiry: account.expiresAt,
					unavailableReason: account.unavailableReason,
					error: account.error,
					// Typed credit fields only, so untyped provider text never reaches the output.
					credits: status.credits.map(credit => ({
						id: credit.id,
						title: maskOptionalText(credit.title),
						program: credit.program,
						status: credit.status,
						remainingCount: credit.remainingCount,
						usable: credit.usable,
						requiresLimit: credit.requiresLimit,
						clears: credit.clears,
						blocking: credit.blocking,
						usedFractions: credit.usedFractions,
						grantedAt: credit.grantedAt,
						expiresAt: credit.expiresAt,
					})),
				};
			});
			process.stdout.write(`${JSON.stringify({ generatedAt: Date.now(), accounts: rows }, null, 2)}\n`);
			return;
		}
		if (accounts.length === 0) {
			const names = providers.map(formatResetProviderName).join(" or ");
			process.stderr.write(chalk.yellow(`No ${names} accounts found. Run \`omp\` and use /login to add one.\n`));
			process.exitCode = 1;
			return;
		}
		const lines = ["Saved rate-limit resets:", ...accounts.map(formatResetUsageAccountLine)];
		lines.push("", `Spend one with \`${RESET_COMMAND} <provider>/<credential id>\`.`);
		process.stdout.write(`${lines.join("\n")}\n`);
		return;
	}

	const resolved = resolveResetUsageTarget(accounts, cmd.target, RESET_COMMAND);
	if ("error" in resolved) {
		failUsageReset(resolved.error);
		return;
	}
	const { label, provider, availableCount, target } = resolved.account;
	const who = `${oneLine(label)} (${formatResetProviderName(provider)})`;
	const lockKey = resetAccountLockKey(target);
	if (!lockKey) {
		failUsageReset(
			`${who}: this login stores no account id or email to fence the spend against other omp processes, so nothing was spent. Run \`omp\` and use /login to sign in to it again.`,
		);
		return;
	}
	// The fence a session's automatic spend takes: neither spends while the
	// other's attempt is in flight or within a minute of it.
	const result = await withResetFence<ResetCreditRedeemOutcome | ResetMarker>(
		resetLockPath(lockKey),
		async marker => marker,
		async markedRedeem => {
			if (provider === "openai-codex") {
				const live = await authStorage.resets.list({
					provider,
					baseUrlResolver,
					signal: AbortSignal.timeout(10_000),
				});
				const balance = checkCodexBalance(live, target.credentialId, availableCount);
				if (balance) return { ok: false, code: balance === "spent" ? "offer_changed" : balance, provider };
			}
			const { outcome } = await markedRedeem(async () => {
				try {
					// Bounded like the session executor's redeem: the fence is held until it settles.
					return await authStorage.resets.redeem({ target, baseUrlResolver, signal: AbortSignal.timeout(15_000) });
				} catch (error) {
					// A transport failure can land after the provider applied the reset.
					return { ok: false, code: "network_error", provider, reason: errorMessage(error) };
				}
			});
			return outcome;
		},
	);
	if ("state" in result) {
		const ago = formatDuration(Date.now() - result.atMs);
		failUsageReset(
			result.state === "reset"
				? `${who}: another omp process spent a saved reset on this account ${ago} ago, so this one was not spent. Check \`omp usage\` before spending another.`
				: `${who}: another omp process started spending a saved reset on this account ${ago} ago, so nothing was spent. Try again in a minute.`,
		);
		return;
	}
	const message = oneLine(describeRedeemOutcome({ ...result, reason: maskOptionalText(result.reason) }, label));
	if (result.ok) {
		process.stdout.write(`${message}\n`);
	} else {
		failUsageReset(message);
	}
}

export async function runUsageCommand(cmd: UsageCommandArgs): Promise<void> {
	const settings = await Settings.loadReadOnly();
	const authStorage = await discoverAuthStorage(undefined, { settings });
	try {
		if (cmd.action === "invalidate") {
			const provider = cmd.provider?.toLowerCase();
			if (provider) {
				// Usage providers registered by extensions and broker credentials newer than
				// the cached snapshot count too, so load both before rejecting the id.
				await loadUsageSources(cmd, settings, authStorage);
				const storedAccounts = collectStoredAccounts(authStorage);
				const known =
					authStorage.usage.providerFor(provider) !== undefined ||
					storedAccounts.some(account => account.provider.toLowerCase() === provider);
				if (!known) {
					process.stderr.write(chalk.yellow(formatNoProviderCredentials(provider, storedAccounts)));
					process.exitCode = 1;
					return;
				}
			}
			await authStorage.usage.invalidate(provider);
			if (provider) {
				process.stdout.write(`Invalidated cached usage reports for provider "${provider}".\n`);
			} else {
				process.stdout.write("Invalidated cached usage reports for all providers.\n");
			}
			return;
		}
		if (cmd.action === "accounts") {
			if (cmd.redact) {
				process.stderr.write(
					chalk.red(
						"`omp usage accounts` prints identity keys verbatim for configuration; --redact does not apply.\n",
					),
				);
				process.exitCode = 1;
				return;
			}
			// The listed keys get pasted into task.agentAccountPools, so read the
			// broker's current accounts, not a cached snapshot; offline brokers
			// keep the snapshot.
			try {
				await authStorage.credentials.revalidate();
			} catch {
				// Stale identities beat no output.
			}
			const rows = collectOAuthIdentityKeys(authStorage, cmd.provider?.toLowerCase());
			if (cmd.json) {
				process.stdout.write(`${JSON.stringify({ accounts: rows }, null, 2)}\n`);
				return;
			}
			if (rows.length === 0) {
				const scope = cmd.provider ? ` for provider "${cmd.provider}"` : "";
				process.stderr.write(
					chalk.yellow(`No OAuth accounts found${scope}. Run \`omp\` and use /login to add accounts.\n`),
				);
				process.exitCode = 1;
				return;
			}
			process.stdout.write(`${formatOAuthIdentityKeys(rows)}\n`);
			return;
		}
		if (cmd.action === "reset") {
			await runUsageResetCommand(cmd, settings, authStorage);
			return;
		}
		if (cmd.action === "clients") {
			const days = cmd.days !== undefined && Number.isFinite(cmd.days) && cmd.days > 0 ? cmd.days : 7;
			const nowMs = Date.now();
			const sinceMs = nowMs - days * 86_400_000;
			// Prefer the broker's fleet-wide record; fall back to the local agent
			// DB, which has rows only when this machine hosts the broker.
			const broker = await resolveBrokerClient();
			const clients = broker
				? (await broker.fetchClientUsageSummary({ sinceMs })).clients
				: authStorage.usage.clientSummary(sinceMs).clients;
			if (cmd.json) {
				process.stdout.write(`${JSON.stringify({ generatedAt: nowMs, sinceMs, clients }, null, 2)}\n`);
				return;
			}
			if (clients.length === 0) {
				process.stderr.write(
					chalk.yellow(
						"No per-client usage recorded yet. Broker-connected clients and the auth-gateway report token burn automatically; set OMP_AUTH_BROKER_URL (or run this on the broker host).\n",
					),
				);
				process.exitCode = 1;
				return;
			}
			process.stdout.write(`${formatClientUsage(clients, sinceMs, nowMs)}\n`);
			return;
		}
		if (cmd.history) {
			const days = cmd.days !== undefined && Number.isFinite(cmd.days) && cmd.days > 0 ? cmd.days : 7;
			const nowMs = Date.now();
			const sinceMs = nowMs - days * 86_400_000;
			const provider = cmd.provider?.toLowerCase();
			// The broker host records every upstream usage fetch; a broker client's own store holds none.
			const broker = await resolveBrokerClient();
			const entries = broker
				? (await broker.fetchUsageHistory({ sinceMs, provider })).entries
				: authStorage.usage.history({ sinceMs, provider });
			const redaction = cmd.redact ? buildRedactionMap(collectHistoryIdentityStrings(entries)) : undefined;
			if (cmd.json) {
				const masked = redaction
					? entries.map(entry => ({
							...entry,
							accountKey: redaction.get(entry.accountKey) ?? entry.accountKey,
							email: maskIdentity(redaction, entry.email),
							accountId: maskIdentity(redaction, entry.accountId),
						}))
					: entries;
				process.stdout.write(`${JSON.stringify({ generatedAt: nowMs, sinceMs, entries: masked }, null, 2)}\n`);
				return;
			}
			if (entries.length === 0) {
				const scope = cmd.provider ? ` for provider "${cmd.provider}"` : "";
				process.stderr.write(
					chalk.yellow(
						`No usage history recorded${scope} yet. Snapshots accumulate whenever usage is fetched (TUI footer, /usage, omp usage).\n`,
					),
				);
				process.exitCode = 1;
				return;
			}
			process.stdout.write(`${formatUsageHistory(entries, sinceMs, nowMs, redaction)}\n`);
			return;
		}
		const policyOptions: UsagePolicyDiagnosticsOptions = {
			globalReservePct: cfgRetryUsageReservePct.get(settings),
			getAccountPolicy: (provider, identity) => authStorage.oauth.policy(provider, identity),
		};
		const modelRegistry = await loadUsageSources(cmd, settings, authStorage);
		const reports =
			(await authStorage.usage.reports({
				baseUrlResolver: provider => modelRegistry.getProviderBaseUrl(provider),
			})) ?? [];
		const storedAccounts = collectStoredAccounts(authStorage);
		let accounts = selectReportableAccounts(
			storedAccounts,
			provider => authStorage.usage.providerFor(provider) !== undefined,
			cmd.provider,
		);
		// Tombstones ride alongside the live pool so an auto-disabled account
		// (e.g. an expired Anthropic grant) is loudly visible instead of just
		// missing. Best-effort: a broker predating the endpoint yields [].
		let disabled: DisabledCredentialSummary[] = [];
		try {
			disabled = await authStorage.credentials.listDisabled();
		} catch {
			// Usage output must not fail because tombstone listing did.
		}
		let filteredReports = reports;
		if (cmd.provider) {
			const wanted = cmd.provider.toLowerCase();
			filteredReports = reports.filter(report => report.provider.toLowerCase() === wanted);
			accounts = accounts.filter(account => account.provider.toLowerCase() === wanted);
			disabled = disabled.filter(summary => summary.provider.toLowerCase() === wanted);
		}

		const redaction = cmd.redact
			? buildRedactionMap(collectIdentityStrings(filteredReports, accounts, disabled))
			: undefined;

		if (cmd.json) {
			// Drop the heavy provider-specific `raw` payload — same shape as the
			// broker/gateway `/v1/usage` endpoints.
			let trimmed = filteredReports.map(({ raw: _raw, ...rest }) => rest);
			let unreportedAccounts = collectUnreportedAccounts(filteredReports, accounts);
			if (redaction) {
				trimmed = trimmed.map(report => redactReportForJson(report, redaction));
				unreportedAccounts = unreportedAccounts.map(account => ({
					...account,
					email: maskIdentity(redaction, account.email),
					accountId: maskIdentity(redaction, account.accountId),
					projectId: maskIdentity(redaction, account.projectId),
					enterpriseUrl: maskIdentity(redaction, account.enterpriseUrl),
					orgId: maskIdentity(redaction, account.orgId),
					orgName: maskIdentity(redaction, account.orgName),
				}));
			}
			const capacity: Record<string, ProviderWindowStat[]> = {};
			for (const report of filteredReports) {
				if (capacity[report.provider]) continue;
				const stats = computeProviderWindowStats(filteredReports.filter(peer => peer.provider === report.provider));
				if (stats.length > 0) capacity[report.provider] = stats;
			}
			let disabledForJson = disabled.filter(summary => isActionableDisable(summary, accounts));
			if (redaction) {
				disabledForJson = disabledForJson.map(summary => ({
					...summary,
					email: maskIdentity(redaction, summary.email),
					accountId: maskIdentity(redaction, summary.accountId),
					orgId: maskIdentity(redaction, summary.orgId),
					orgName: maskIdentity(redaction, summary.orgName),
				}));
			}
			const payload = {
				generatedAt: Date.now(),
				reports: trimmed,
				accountsWithoutUsage: unreportedAccounts,
				disabledCredentials: disabledForJson,
				capacity,
			};
			process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
			return;
		}

		if (filteredReports.length === 0 && accounts.length === 0) {
			// An explicit --provider keeps every stored account of that provider, so
			// reaching here with one means none is stored for it. Without one,
			// credentials may exist only for providers without a usage endpoint.
			let message: string;
			if (cmd.provider) {
				message = formatNoProviderCredentials(cmd.provider, storedAccounts);
			} else if (storedAccounts.length > 0) {
				message = "No usage data. Stored credentials are for providers without a usage endpoint.\n";
			} else {
				message = "No credentials found. Run `omp` and use /login to add accounts.\n";
			}
			process.stderr.write(chalk.yellow(message));
			process.exitCode = 1;
			return;
		}

		const defaultAccountLabels = new Map<string, string>();
		for (const provider of new Set([
			...filteredReports.map(report => report.provider),
			...accounts.map(account => account.provider),
		])) {
			const identity = authStorage.getDefaultAccountIdentity(provider);
			if (!identity) continue;
			const maskedIdentity: OAuthAccountIdentity = redaction
				? {
						email: maskIdentity(redaction, identity.email),
						accountId: maskIdentity(redaction, identity.accountId),
						projectId: maskIdentity(redaction, identity.projectId),
						orgId: maskIdentity(redaction, identity.orgId),
						orgName: maskIdentity(redaction, identity.orgName),
					}
				: identity;
			const label = formatActiveAccountLabel(maskedIdentity);
			if (label) defaultAccountLabels.set(provider, label);
		}
		const resetOptions: UsageResetExpiryOptions = {
			settings,
			accounts: provider => authStorage.oauth.accounts(provider),
		};
		process.stdout.write(
			`${formatUsageBreakdown(filteredReports, accounts, Date.now(), redaction, disabled, policyOptions, resetOptions, defaultAccountLabels)}\n`,
		);
	} catch (error) {
		// Broker-backed reads (`clients`, `--history`) fail on an unreachable or
		// pre-endpoint broker; report one line instead of a stack dump.
		if (!(error instanceof AuthBrokerError)) throw error;
		process.stderr.write(`${chalk.red(`Error: auth broker request failed: ${error.message}`)}\n`);
		process.exitCode = 1;
	} finally {
		authStorage.close();
	}
}
