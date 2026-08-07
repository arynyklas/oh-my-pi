import { ANTHROPIC_OAUTH_GRANT_TTL_MS, type DisabledCredentialSummary } from "@oh-my-pi/pi-ai";
import { resolveUsedFraction, type UsageLimit, type UsageReport, type UsageUnit } from "@oh-my-pi/pi-ai/usage";
import { formatDuration, formatNumber, sanitizeText } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";

const BAR_WIDTH = 28;

function sanitizeUsageText(value: string): string {
	return sanitizeText(value.replace(/[\r\n]+/g, " ").replace(/\t/g, "  "));
}

/** Identity slice of a stored credential, for "every account" coverage. */
export interface UsageAccountIdentity {
	provider: string;
	type: "api_key" | "oauth";
	email?: string;
	accountId?: string;
	projectId?: string;
	enterpriseUrl?: string;
	/** Organization/workspace the credential is scoped to (Anthropic multi-subscription). */
	orgId?: string;
	orgName?: string;
	/** Epoch ms of the interactive login that minted the OAuth grant (see `OAuthCredentials.authorizedAt`). */
	authorizedAt?: number;
}

export type LimitStatus = NonNullable<UsageLimit["status"]>;

function resolveStatus(limit: UsageLimit): LimitStatus {
	if (limit.status && limit.status !== "unknown") return limit.status;
	const fraction = resolveUsedFraction(limit);
	if (fraction === undefined) return "unknown";
	if (fraction >= 1) return "exhausted";
	if (fraction >= 0.8) return "warning";
	return "ok";
}

export const STATUS_COLOR: Record<LimitStatus, (text: string) => string> = {
	exhausted: chalk.red,
	warning: chalk.yellow,
	ok: chalk.green,
	unknown: chalk.dim,
};

/** Worst-of aggregation: exhausted > warning > ok > unknown. */
function aggregateStatus(limits: UsageLimit[]): LimitStatus {
	const statuses = limits.map(resolveStatus);
	if (statuses.includes("exhausted")) return "exhausted";
	if (statuses.includes("warning")) return "warning";
	if (statuses.includes("ok")) return "ok";
	return "unknown";
}

export function formatProviderName(provider: string): string {
	return sanitizeUsageText(
		provider
			.split(/[-_]/g)
			.map(part => (part ? part[0].toUpperCase() + part.slice(1) : ""))
			.join(" "),
	);
}

function formatUnitValue(value: number, unit: UsageUnit): string {
	if (unit === "usd") return `$${value.toFixed(2)}`;
	return formatNumber(value);
}

const UNIT_SUFFIX: Record<UsageUnit, string> = {
	tokens: " tokens",
	requests: " requests",
	minutes: " min",
	bytes: " bytes",
	percent: "",
	usd: "",
	unknown: "",
};

function describeAmount(limit: UsageLimit): string {
	const amount = limit.amount;
	const parts: string[] = [];
	const absoluteUnit = amount.unit !== "percent" && amount.unit !== "unknown";
	const fraction = resolveUsedFraction(limit);
	if (absoluteUnit && amount.used !== undefined && amount.limit !== undefined) {
		parts.push(
			`${formatUnitValue(amount.used, amount.unit)} / ${formatUnitValue(amount.limit, amount.unit)}${UNIT_SUFFIX[amount.unit]}`,
		);
	} else if (absoluteUnit && amount.remaining !== undefined) {
		parts.push(`${formatUnitValue(amount.remaining, amount.unit)}${UNIT_SUFFIX[amount.unit]} left`);
	} else if (
		absoluteUnit &&
		amount.used !== undefined &&
		Number.isFinite(amount.used) &&
		amount.limit === undefined &&
		amount.remaining === undefined &&
		fraction === undefined
	) {
		parts.push(`${formatUnitValue(amount.used, amount.unit)}${UNIT_SUFFIX[amount.unit]} used`);
	}
	if (fraction !== undefined) {
		parts.push(`${(fraction * 100).toFixed(1)}% used`);
	} else if (amount.remainingFraction !== undefined) {
		parts.push(`${(amount.remainingFraction * 100).toFixed(1)}% left`);
	}
	if (parts.length === 0) parts.push("no data");
	return parts.join(" · ");
}

function renderBar(limit: UsageLimit): string {
	const fraction = resolveUsedFraction(limit);
	if (fraction === undefined) return chalk.dim("·".repeat(BAR_WIDTH));
	const clamped = Math.min(Math.max(fraction, 0), 1);
	const filled = Math.round(clamped * BAR_WIDTH);
	const color = STATUS_COLOR[resolveStatus(limit)];
	return color("█".repeat(filled)) + chalk.dim("░".repeat(BAR_WIDTH - filled));
}

/** Append the window label when the limit label doesn't already carry it. */
function limitTitle(limit: UsageLimit): string {
	let label = limit.label;
	const tier = limit.scope.tier;
	if (tier && !label.toLowerCase().includes(tier.toLowerCase())) label = `${label} (${tier})`;
	const windowLabel = limit.window?.label ?? limit.scope.windowId;
	if (!windowLabel) return label;
	if (windowLabel.toLowerCase() === "quota window") return label;
	if (label.toLowerCase().includes(windowLabel.toLowerCase())) return label;
	return `${label} (${windowLabel})`;
}

function reportAccountLabel(report: UsageReport, index: number): string {
	const meta = report.metadata ?? {};
	for (const key of ["email", "accountId", "projectId"] as const) {
		const value = meta[key];
		if (typeof value === "string" && value) return value;
	}
	for (const limit of report.limits) {
		const scoped = limit.scope.accountId ?? limit.scope.projectId;
		if (scoped) return scoped;
	}
	return `account ${index + 1}`;
}

/** Lowercased identity strings a report can be attributed to. */
function reportIdentifiers(report: UsageReport): Set<string> {
	const ids = new Set<string>();
	const add = (value: unknown): void => {
		if (typeof value === "string" && value) ids.add(value.toLowerCase());
	};
	const meta = report.metadata ?? {};
	add(meta.email);
	add(meta.accountId);
	add(meta.projectId);
	add(meta.orgId);
	for (const limit of report.limits) {
		add(limit.scope.accountId);
		add(limit.scope.projectId);
		add(limit.scope.orgId);
	}
	return ids;
}

/**
 * Stored credentials that no usage report could be attributed to.
 *
 * Conservative on purpose: when a provider's reports carry no identity at
 * all (or the credential is an API key alongside existing reports), we
 * can't attribute, so we don't claim the account is missing.
 */
export function collectUnreportedAccounts(
	reports: UsageReport[],
	accounts: UsageAccountIdentity[],
): UsageAccountIdentity[] {
	const byProvider = new Map<string, UsageReport[]>();
	for (const report of reports) {
		const list = byProvider.get(report.provider) ?? [];
		list.push(report);
		byProvider.set(report.provider, list);
	}
	return accounts.filter(account => {
		const providerReports = byProvider.get(account.provider) ?? [];
		if (providerReports.length === 0) return true;
		if (account.type === "api_key") return false;
		const accountOrg = account.orgId?.toLowerCase();
		const ids = [account.email, account.accountId, account.projectId]
			.filter((value): value is string => typeof value === "string" && value.length > 0)
			.map(value => value.toLowerCase());
		const sameOrgReports: UsageReport[] = [];
		let sawReportOrg = false;
		for (const report of providerReports) {
			const metaOrg = report.metadata?.orgId;
			if (typeof metaOrg === "string" && metaOrg) {
				sawReportOrg = true;
				if (accountOrg !== undefined && metaOrg.toLowerCase() === accountOrg) sameOrgReports.push(report);
			}
		}
		if (accountOrg || sawReportOrg) {
			const candidates = accountOrg
				? sameOrgReports
				: providerReports.filter(report => {
						const metaOrg = report.metadata?.orgId;
						return !(typeof metaOrg === "string" && metaOrg);
					});
			if (candidates.length === 0) return true;
			if (ids.length === 0) return false;
			return !candidates.some(report => {
				const identifiers = reportIdentifiers(report);
				return ids.some(id => identifiers.has(id));
			});
		}
		if (ids.length === 0) return false;
		const reported = new Set<string>();
		let anyIdentified = false;
		for (const report of providerReports) {
			const identifiers = reportIdentifiers(report);
			if (identifiers.size > 0) anyIdentified = true;
			for (const id of identifiers) reported.add(id);
		}
		if (!anyIdentified) return false;
		return !ids.some(id => reported.has(id));
	});
}

function accountIdentityLabel(account: UsageAccountIdentity, redaction?: Map<string, string>): string {
	if (account.type === "api_key") return "API key";
	const base = account.email ?? account.accountId ?? account.projectId ?? account.enterpriseUrl ?? "OAuth account";
	const masked = redaction?.get(base) ?? sanitizeUsageText(base);
	const org = account.orgName ?? account.orgId;
	if (!org || org === base) return masked;
	return `${masked} · ${redaction?.get(org) ?? sanitizeUsageText(org)}`;
}

function formatAccountHeader(
	report: UsageReport,
	index: number,
	nowMs: number,
	redaction?: Map<string, string>,
): string {
	const status = aggregateStatus(report.limits);
	const icon = STATUS_COLOR[status]("●");
	const rawLabel = reportAccountLabel(report, index);
	const label = redaction?.get(rawLabel) ?? sanitizeUsageText(rawLabel);
	let header = `${icon} ${chalk.bold(label)}`;
	const metaOrgName = report.metadata?.orgName;
	const metaOrgId = report.metadata?.orgId;
	const org = typeof metaOrgName === "string" && metaOrgName ? metaOrgName : metaOrgId;
	if (typeof org === "string" && org && org !== rawLabel) {
		header += chalk.dim(` · ${redaction?.get(org) ?? sanitizeUsageText(org)}`);
	}
	const planType = report.metadata?.planType;
	if (typeof planType === "string" && planType) header += chalk.dim(` · plan: ${sanitizeUsageText(planType)}`);
	const savedResets = report.resetCredits?.availableCount ?? 0;
	if (savedResets > 0) {
		header += chalk.cyan(` · ✦ ${savedResets} saved reset${savedResets === 1 ? "" : "s"}`);
		const credits = report.resetCredits?.credits;
		if (credits) {
			const expiries = credits
				.filter(c => c.expiresAt)
				.map(c => ({ date: c.expiresAt!, ms: Date.parse(c.expiresAt!) }))
				.filter(c => !Number.isNaN(c.ms))
				.sort((a, b) => a.ms - b.ms);
			const upcoming = expiries.find(c => c.ms > nowMs);
			if (upcoming) {
				header += chalk.dim(
					` · soonest expires in ${formatDuration(upcoming.ms - nowMs)} (${upcoming.date.slice(0, 10)})`,
				);
			} else {
				const lastExpired = expiries.at(-1);
				if (lastExpired) header += chalk.dim(` · expired (${lastExpired.date.slice(0, 10)})`);
			}
		}
	}
	if (report.fetchedAt && nowMs - report.fetchedAt > 90_000) {
		header += chalk.dim(` · fetched ${formatDuration(nowMs - report.fetchedAt)} ago`);
	}
	return header;
}

function formatLimitLine(limit: UsageLimit, labelWidth: number, nowMs: number): string[] {
	const status = resolveStatus(limit);
	const title = sanitizeUsageText(limitTitle(limit));
	const padded = title.padEnd(labelWidth);
	const details: string[] = [describeAmount(limit)];
	const resetsAt = limit.window?.resetsAt;
	if (resetsAt !== undefined && resetsAt > nowMs) {
		details.push(`${limit.window?.resetLabel ?? "resets"} in ${formatDuration(resetsAt - nowMs)}`);
	}
	const lines = [
		`      ${STATUS_COLOR[status]("●")} ${padded}  ${renderBar(limit)}  ${chalk.dim(details.join(" · "))}`,
	];
	if (limit.notes && limit.notes.length > 0) {
		lines.push(`        ${chalk.dim(limit.notes.map(sanitizeUsageText).join(" · "))}`);
	}
	return lines;
}

interface ProviderLimitTemplate {
	id: string;
	title: string;
}

function collectProviderLimitTemplates(reports: UsageReport[]): ProviderLimitTemplate[] {
	const seen = new Set<string>();
	const templates: ProviderLimitTemplate[] = [];
	for (const report of reports) {
		for (const limit of report.limits) {
			if (seen.has(limit.id)) continue;
			seen.add(limit.id);
			templates.push({ id: limit.id, title: sanitizeUsageText(limitTitle(limit)) });
		}
	}
	return templates;
}

function formatMissingLimitLine(template: ProviderLimitTemplate, labelWidth: number): string {
	const padded = template.title.padEnd(labelWidth);
	return `      ${chalk.dim("○")} ${padded}  ${chalk.dim("·".repeat(BAR_WIDTH))}  ${chalk.dim("not reported")}`;
}

export interface FormatUsageReportLinesOptions {
	reports?: UsageReport[];
	index?: number;
	nowMs?: number;
	redaction?: Map<string, string>;
	includeNotes?: boolean;
}

export function formatUsageReportLines(report: UsageReport, options: FormatUsageReportLinesOptions = {}): string[] {
	const nowMs = options.nowMs ?? Date.now();
	const providerReports = options.reports ?? [report];
	const templates = collectProviderLimitTemplates(providerReports);
	const labelWidth = templates.reduce((max, template) => Math.max(max, template.title.length), 0);
	const lines: string[] = [];
	if (options.includeNotes !== false) {
		for (const note of report.notes ?? []) lines.push(`  ${chalk.dim(sanitizeUsageText(note))}`);
	}
	lines.push(`  ${formatAccountHeader(report, options.index ?? 0, nowMs, options.redaction)}`);
	if (report.limits.length === 0) {
		lines.push(`      ${chalk.dim("no limits reported")}`);
		return lines;
	}
	const limitsById = new Map<string, UsageLimit>();
	for (const limit of report.limits) limitsById.set(limit.id, limit);
	for (const template of templates) {
		const limit = limitsById.get(template.id);
		if (limit) {
			lines.push(...formatLimitLine(limit, labelWidth, nowMs));
		} else {
			lines.push(formatMissingLimitLine(template, labelWidth));
		}
	}
	return lines;
}

/** Per-window capacity stat: how much account quota is burned and left. */
export interface ProviderWindowStat {
	/** Compact window label, e.g. "5h", "7d". */
	window: string;
	durationMs?: number;
	/** Accounts reporting a limit in this window. */
	accounts: number;
	/** Sum of each account's binding used fraction — accounts' worth of quota burned. */
	usedAccounts: number;
	/** Accounts' worth of quota still available across reporting accounts. */
	remainingAccounts: number;
}

/**
 * Aggregate one provider's reports into per-window quota capacity stats.
 *
 * Limits are bucketed by window duration (5h, 7d, ...). Within a bucket each
 * account contributes its single highest used fraction — when an account has
 * several meters on the same window (tiered/metered limits), the most-burned
 * one is what binds.
 */
export function computeProviderWindowStats(reports: UsageReport[]): ProviderWindowStat[] {
	const buckets = new Map<string, { window: string; durationMs?: number; fractions: number[] }>();
	for (const report of reports) {
		const accountMax = new Map<string, number>();
		for (const limit of report.limits) {
			const fraction = resolveUsedFraction(limit);
			if (fraction === undefined) continue;
			const durationMs = limit.window?.durationMs;
			const key =
				durationMs !== undefined
					? `duration:${durationMs}`
					: `label:${limit.window?.label ?? limit.scope.windowId ?? limit.label}`;
			const previous = accountMax.get(key);
			if (previous === undefined || fraction > previous) accountMax.set(key, fraction);
			if (!buckets.has(key)) {
				const window =
					durationMs !== undefined
						? formatDuration(durationMs)
						: (limit.window?.label ?? limit.scope.windowId ?? limit.label);
				buckets.set(key, { window, durationMs, fractions: [] });
			}
		}
		for (const [key, fraction] of accountMax) buckets.get(key)!.fractions.push(fraction);
	}
	return [...buckets.values()]
		.sort((a, b) => (a.durationMs ?? Number.POSITIVE_INFINITY) - (b.durationMs ?? Number.POSITIVE_INFINITY))
		.map(bucket => {
			const usedAccounts = bucket.fractions.reduce((sum, fraction) => sum + fraction, 0);
			return {
				window: bucket.window,
				durationMs: bucket.durationMs,
				accounts: bucket.fractions.length,
				usedAccounts,
				remainingAccounts: Math.max(0, bucket.fractions.length - usedAccounts),
			};
		});
}

/** Re-login warnings render once remaining grant life drops below this. */
const RELOGIN_WARN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Re-login deadline line for providers whose OAuth grants expire a fixed
 * period after the interactive login (today: Anthropic, ~30 days regardless
 * of refresh rotation). Silent until the deadline is under a week out — a
 * nudge before the broker auto-disables the row, not a permanent countdown.
 */
function formatReloginDeadline(
	account: UsageAccountIdentity,
	nowMs: number,
	redaction?: Map<string, string>,
): string | undefined {
	if (account.provider !== "anthropic" || account.type !== "oauth" || !account.authorizedAt) return undefined;
	const remaining = account.authorizedAt + ANTHROPIC_OAUTH_GRANT_TTL_MS - nowMs;
	if (remaining > RELOGIN_WARN_WINDOW_MS) return undefined;
	const label = accountIdentityLabel(account, redaction);
	if (remaining <= 0) {
		return `  ${chalk.red(`⚠ ${label} — grant is past Anthropic's ~30d lifetime; re-login now`)}`;
	}
	return `  ${chalk.yellow(`⚠ ${label} — re-login within ${formatDuration(remaining)} (Anthropic expires OAuth grants ~30d after login)`)}`;
}

/**
 * Tombstones worth a row in `omp usage`: OAuth credentials torn down
 * automatically (refresh failure, upstream invalidation). Rows the user
 * replaced or deleted deliberately are lifecycle noise, not lost capacity.
 */
export function isActionableDisable(
	summary: DisabledCredentialSummary,
	activeAccounts: UsageAccountIdentity[] = [],
): boolean {
	if (summary.type !== "oauth") return false;
	if (/^(replaced by|deleted by user)/i.test(summary.cause)) return false;

	// Hide the tombstone only when a live credential for the same provider IS the
	// same identity — a re-login the broker recorded as a new row. Matching email
	// or accountId proves that; a shared organization alone does not, since two
	// Team members share `orgId` while drawing on separate pools, and hiding a
	// disabled teammate behind an active sibling is exactly the lost capacity
	// these rows exist to surface. So the org-only fallback applies just when no
	// base identifier contradicts it.
	const summaryEmail = summary.email?.toLowerCase();
	const summaryAccountId = summary.accountId?.toLowerCase();
	const summaryOrgId = summary.orgId?.toLowerCase();

	const matchesActive = activeAccounts.some(account => {
		if (account.provider !== summary.provider) return false;

		const accountEmail = account.email?.toLowerCase();
		const accountAccountId = account.accountId?.toLowerCase();
		const accountOrgId = account.orgId?.toLowerCase();

		if (summaryEmail && accountEmail && summaryEmail === accountEmail) return true;
		if (summaryAccountId && accountAccountId && summaryAccountId === accountAccountId) return true;

		if (summaryEmail && accountEmail) return false;
		if (summaryAccountId && accountAccountId) return false;

		return Boolean(summaryOrgId && accountOrgId && summaryOrgId === accountOrgId);
	});

	return !matchesActive;
}

/** Human-sized disable cause: the upstream `error_description` when embedded, else the first clause. */
function shortDisableCause(cause: string): string {
	const description = cause.match(/\\?"error_description\\?"\s*:\s*\\?"([^"\\]+)/)?.[1];
	if (description) return description;
	const stripped = cause.replace(/^oauth refresh failed:\s*/i, "");
	const clause = stripped.split(/[;\n]/, 1)[0] ?? stripped;
	return clause.length > 80 ? `${clause.slice(0, 77)}…` : clause;
}

/** Label for a disabled tombstone, masking each identity part under `--redact`. */
function disabledIdentityLabel(summary: DisabledCredentialSummary, redaction?: Map<string, string>): string {
	const base = summary.email ?? summary.accountId ?? "OAuth account";
	const masked = redaction?.get(base) ?? base;
	const org = summary.orgName ?? summary.orgId;
	if (!org || org === base) return masked;
	return `${masked} · ${redaction?.get(org) ?? org}`;
}

/**
 * Render the full text breakdown: per provider, per account, every limit
 * with a bar, amounts, and reset times; unattributed credentials trail
 * each provider section as "no usage data" rows.
 */
export function formatUsageBreakdown(
	reports: UsageReport[],
	accounts: UsageAccountIdentity[],
	nowMs: number,
	redaction?: Map<string, string>,
	disabled: DisabledCredentialSummary[] = [],
): string {
	const reportsByProvider = new Map<string, UsageReport[]>();
	for (const report of reports) {
		const list = reportsByProvider.get(report.provider) ?? [];
		list.push(report);
		reportsByProvider.set(report.provider, list);
	}
	const unreported = collectUnreportedAccounts(reports, accounts);
	const unreportedByProvider = new Map<string, UsageAccountIdentity[]>();
	for (const account of unreported) {
		const list = unreportedByProvider.get(account.provider) ?? [];
		list.push(account);
		unreportedByProvider.set(account.provider, list);
	}
	const disabledByProvider = new Map<string, DisabledCredentialSummary[]>();
	for (const summary of disabled) {
		if (!isActionableDisable(summary, accounts)) continue;
		const list = disabledByProvider.get(summary.provider) ?? [];
		list.push(summary);
		disabledByProvider.set(summary.provider, list);
	}

	const providers = [
		...new Set([...reportsByProvider.keys(), ...unreportedByProvider.keys(), ...disabledByProvider.keys()]),
	].sort((a, b) => a.localeCompare(b));

	const lines: string[] = [];
	const latestFetchedAt = Math.max(0, ...reports.map(report => report.fetchedAt ?? 0));
	const headerSuffix = latestFetchedAt ? chalk.dim(` · fetched ${formatDuration(nowMs - latestFetchedAt)} ago`) : "";
	lines.push(`${chalk.bold("Usage")}${headerSuffix}`);

	for (const provider of providers) {
		const providerReports = reportsByProvider.get(provider) ?? [];
		const providerUnreported = unreportedByProvider.get(provider) ?? [];
		const accountCount = providerReports.length + providerUnreported.length;
		lines.push("");
		lines.push(
			`${chalk.bold.cyan(formatProviderName(provider))} ${chalk.dim(`— ${accountCount} ${accountCount === 1 ? "account" : "accounts"}`)}`,
		);
		// Provider-wide disclaimers render once per provider, not per limit.
		const providerNotes = [...new Set(providerReports.flatMap(report => report.notes ?? []))];
		for (const note of providerNotes) lines.push(`  ${chalk.dim(sanitizeUsageText(note))}`);

		providerReports.forEach((report, index) => {
			lines.push(
				...formatUsageReportLines(report, {
					reports: providerReports,
					index,
					nowMs,
					redaction,
					includeNotes: false,
				}),
			);
		});

		for (const account of providerUnreported) {
			const label = accountIdentityLabel(account, redaction);
			lines.push(`  ${chalk.dim("○")} ${chalk.dim(`${label} — no usage data`)}`);
		}

		for (const summary of disabledByProvider.get(provider) ?? []) {
			const label = disabledIdentityLabel(summary, redaction);
			const ago = summary.disabledAtMs !== undefined ? ` ${formatDuration(nowMs - summary.disabledAtMs)} ago` : "";
			lines.push(
				`  ${chalk.red(`✗ ${label} — disabled${ago}: ${sanitizeText(shortDisableCause(summary.cause))}`)} ${chalk.dim("(re-login to restore)")}`,
			);
		}

		for (const account of accounts) {
			if (account.provider !== provider) continue;
			const warning = formatReloginDeadline(account, nowMs, redaction);
			if (warning) lines.push(warning);
		}

		const stats = computeProviderWindowStats(providerReports);
		if (stats.length > 0) {
			const parts = stats.map(
				stat =>
					`${stat.window} → ${stat.usedAccounts.toFixed(2)}/${stat.accounts} ${stat.accounts === 1 ? "account" : "accounts"} used (${stat.remainingAccounts.toFixed(2)}× quota left)`,
			);
			lines.push(`  ${chalk.dim(`capacity: ${parts.join(" · ")}`)}`);
		}
	}

	return lines.join("\n");
}
