import {
	ANTHROPIC_OAUTH_GRANT_TTL_MS,
	type AuthAccountPolicy,
	type DisabledCredentialSummary,
	isWithinUsageReserve,
	type OAuthAccountIdentity,
	type OAuthAccountSummary,
} from "@oh-my-pi/pi-ai";
import { resolveUsedFraction, type UsageLimit, type UsageReport, type UsageUnit } from "@oh-my-pi/pi-ai/usage";
import { formatDuration, formatNumber, sanitizeText } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { collapseSharedUsageReports, summarizeUsageResetCredits } from "@oh-my-pi/pi-tui/overlays/usage-display";
import type { Settings } from "../config/settings";
import { reportMatchesStatus } from "../session/claude-auto-reset";
import {
	classifyResetExpiry,
	type ResetExpiryWarning,
	type ResetSpendVerdict,
	resetSpendVerdict,
} from "../session/reset-expiry";
import { formatCodexUsageReportLabel, usageReportIdentity } from "../slash-commands/helpers/active-oauth-account";
import { formatResetProviderName } from "../slash-commands/helpers/reset-usage";
import { collectUnreportedAccounts, type UsageAccountIdentity } from "../slash-commands/helpers/usage-accounts";

const BAR_WIDTH = 28;

function sanitizeUsageText(value: string): string {
	return sanitizeText(value.replace(/[\r\n]+/g, " ").replace(/\t/g, "  "));
}

export interface UsagePolicyDiagnosticsOptions {
	/** Existing global fallback used when an account has no reserve override. */
	globalReservePct: number;
	/** Delegates selector matching to AuthStorage's authoritative policy matcher. */
	getAccountPolicy: (provider: string, identity: OAuthAccountIdentity) => AuthAccountPolicy | undefined;
}

export interface UsageResetExpiryOptions {
	/** Settings that decide whether an expiring saved reset is spent automatically. */
	settings: Settings;
	/** Stored OAuth accounts, as `/usage reset <provider>/<credential id>` addresses them. */
	accounts: (provider: string) => readonly OAuthAccountSummary[];
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
	credits: " credits",
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

function accountIdentityLabel(account: UsageAccountIdentity, redaction?: Map<string, string>): string {
	if (account.type === "api_key") return "API key";
	const base = account.email ?? account.accountId ?? account.projectId ?? account.enterpriseUrl ?? "OAuth account";
	const masked = redaction?.get(base) ?? sanitizeUsageText(base);
	const org = account.orgName ?? account.orgId;
	if (!org || org === base) return masked;
	return `${masked} · ${redaction?.get(org) ?? sanitizeUsageText(org)}`;
}

/** Bold identity plus the dim same-email qualifier and plan the main view shows. */
export function formatQualifiedIdentity(
	report: UsageReport,
	peers: readonly UsageReport[],
	label: string,
	redaction?: Map<string, string>,
): string {
	const identity = sanitizeText((redaction?.get(label) ?? label).replace(/[\r\n\t]+/g, " "));
	const rendered = formatCodexUsageReportLabel(report, peers, label, redaction, true, "inline");
	return `${chalk.bold(identity)}${chalk.dim(rendered.slice(identity.length))}`;
}

/** Account identity as the breakdown shows it: bold label, then the dim organization and plan. */
function formatReportIdentity(
	report: UsageReport,
	peers: readonly UsageReport[],
	index: number,
	redaction?: Map<string, string>,
): string {
	const label = reportAccountLabel(report, index);
	if (report.provider === "openai-codex") return formatQualifiedIdentity(report, peers, label, redaction);
	let identity = chalk.bold(redaction?.get(label) ?? sanitizeUsageText(label));
	const metaOrgName = report.metadata?.orgName;
	const metaOrgId = report.metadata?.orgId;
	const org = typeof metaOrgName === "string" && metaOrgName ? metaOrgName : metaOrgId;
	if (typeof org === "string" && org && org !== label) {
		identity += chalk.dim(` · ${redaction?.get(org) ?? sanitizeUsageText(org)}`);
	}
	const plan = report.metadata?.planType;
	if (typeof plan === "string" && plan.trim()) identity += chalk.dim(` · plan: ${sanitizeUsageText(plan.trim())}`);
	return identity;
}

function formatAccountHeader(
	report: UsageReport,
	peers: readonly UsageReport[],
	index: number,
	nowMs: number,
	redaction?: Map<string, string>,
): string {
	const status = aggregateStatus(report.limits);
	let header = `${STATUS_COLOR[status]("●")} ${formatReportIdentity(report, peers, index, redaction)}`;
	if (report.metadata?.daybreak === true) header += chalk.cyan(" · daybreak");
	const resets = summarizeUsageResetCredits(report.resetCredits, nowMs);
	if (resets && resets.bankedCount > 0) {
		header += chalk.cyan(` · ✦ ${resets.bankedCount} saved reset${resets.bankedCount === 1 ? "" : "s"}`);
		if (resets.redeemableCount !== resets.bankedCount) {
			header += chalk.dim(` · ${resets.redeemableCount} usable now`);
		}
		const expiring = classifyResetExpiry(report, nowMs);
		if (expiring) {
			const text = ` · ▲ ${formatExpiringResets(expiring, nowMs)}`;
			header +=
				expiring.tier === "imminent"
					? chalk.red(text)
					: chalk.yellow(`${text} (${new Date(expiring.expiresAtMs).toISOString().slice(0, 10)})`);
		} else if (resets.soonestExpiry) {
			const expiryMs = Date.parse(resets.soonestExpiry);
			if (expiryMs > nowMs) {
				header += chalk.dim(
					` · soonest expires in ${formatDuration(expiryMs - nowMs)} (${resets.soonestExpiry.slice(0, 10)})`,
				);
			} else {
				header += chalk.dim(` · expired (${resets.soonestExpiry.slice(0, 10)})`);
			}
		}
		if (resets.redeemableCount === 0 && resets.unavailableReason) {
			header += chalk.dim(` · unavailable: ${sanitizeUsageText(resets.unavailableReason)}`);
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
	key: string;
	title: string;
}

/**
 * One row per meter (label and window), not per limit id: Codex ids name a slot, and an
 * account without a 5-hour window reports its 7-day one as `primary`. Most providers put the
 * subscription plan in the tier (see {@link meterForLimit}), so the tier joins the key only for
 * meters a single report repeats per tier (e.g. Antigravity's `Usage (<tier>)` rows).
 */
function meterKey(limit: UsageLimit): string {
	return `${limit.label}|${limit.window?.id ?? limit.scope.windowId ?? ""}`;
}

function createLimitRowKey(reports: UsageReport[]): (limit: UsageLimit) => string {
	const tiered = new Set<string>();
	for (const report of reports) {
		const seen = new Set<string>();
		for (const limit of report.limits) {
			const key = meterKey(limit);
			if (seen.has(key)) tiered.add(key);
			seen.add(key);
		}
	}
	return limit => {
		const key = meterKey(limit);
		return tiered.has(key) ? `${key}|${limit.scope.tier ?? ""}` : key;
	};
}

function collectProviderLimitTemplates(
	reports: UsageReport[],
	rowKey: (limit: UsageLimit) => string,
): ProviderLimitTemplate[] {
	const templates: ProviderLimitTemplate[] = [];
	for (const report of reports) {
		// A row first seen in a later report goes right after its predecessor in that report,
		// so each account keeps its own row order.
		let insertAt = 0;
		for (const limit of report.limits) {
			const key = rowKey(limit);
			const existing = templates.findIndex(template => template.key === key);
			if (existing >= 0) {
				insertAt = existing + 1;
				continue;
			}
			templates.splice(insertAt, 0, { key, title: sanitizeUsageText(limitTitle(limit)) });
			insertAt++;
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
	/** Pre-rendered account policy line shown under the account header. */
	policyLine?: string;
}

export function formatUsageReportLines(report: UsageReport, options: FormatUsageReportLinesOptions = {}): string[] {
	const nowMs = options.nowMs ?? Date.now();
	const providerReports = options.reports ?? [report];
	const limitRowKey = createLimitRowKey(providerReports);
	const templates = collectProviderLimitTemplates(providerReports, limitRowKey);
	// Rows sharing a key can carry different titles (plan tiers), so measure every rendered title.
	const labelWidth = Math.max(
		0,
		...templates.map(template => template.title.length),
		...providerReports.flatMap(peer => peer.limits.map(limit => sanitizeUsageText(limitTitle(limit)).length)),
	);
	const lines: string[] = [];
	if (options.includeNotes !== false) {
		for (const note of report.notes ?? []) lines.push(`  ${chalk.dim(sanitizeUsageText(note))}`);
	}
	lines.push(`  ${formatAccountHeader(report, providerReports, options.index ?? 0, nowMs, options.redaction)}`);
	if (options.policyLine) lines.push(`      ${chalk.dim(options.policyLine)}`);
	if (report.limits.length === 0) {
		lines.push(`      ${chalk.dim("no limits reported")}`);
		return lines;
	}
	const limitsByKey = Map.groupBy(report.limits, limitRowKey);
	for (const template of templates) {
		const limits = limitsByKey.get(template.key);
		if (!limits) {
			lines.push(formatMissingLimitLine(template, labelWidth));
			continue;
		}
		for (const limit of limits) lines.push(...formatLimitLine(limit, labelWidth, nowMs));
	}
	return lines;
}

/** Per-window capacity stat: how much account quota is burned and left. */
export interface ProviderWindowStat {
	/** Compact window label, e.g. "5h", "7d". */
	window: string;
	durationMs?: number;
	/** Meter identity when a provider keeps independent meters in one window. */
	meter?: string;
	/** Accounts reporting a limit in this window. */
	accounts: number;
	/** Sum of each account's binding used fraction - accounts' worth of quota burned. */
	usedAccounts: number;
	/** Accounts' worth of quota still available across reporting accounts. */
	remainingAccounts: number;
}

/**
 * Meter identity for a limit that holds its own quota pool inside a window. A model-scoped
 * allowance is a separate pool from the umbrella window it caps - `claude.ts` marks the Fable
 * weekly cap `tier` without `shared` precisely so it cannot gate Opus or Sonnet requests - and
 * reporting it separately keeps a spent scoped cap visible next to the umbrella remainder.
 * Only Anthropic and Codex use `tier` for such a pool; other providers (Copilot, Devin, Muse Code)
 * put the subscription plan there, which must not split one window per plan. Codex meters that
 * carry no tier fall back to the limit-id slug.
 */
function meterForLimit(report: UsageReport, limit: UsageLimit): string | undefined {
	if (report.provider !== "anthropic" && report.provider !== "openai-codex") return undefined;
	const tier = limit.scope.tier?.trim().toLowerCase();
	if (tier) return tier;
	if (report.provider !== "openai-codex") return undefined;
	const slug = limit.id.toLowerCase().split(":")[1];
	return slug && slug !== "primary" && slug !== "secondary" ? slug : "chat";
}

/**
 * Aggregate one provider's reports into per-window quota capacity stats.
 *
 * Limits are bucketed by window duration (5h, 7d, ...). Within a bucket each
 * account contributes its single highest used fraction. Limits that hold their
 * own pool inside a window keep their own bucket: a model-scoped tier cap, and
 * Codex chat versus Spark, which can share a window duration.
 */
export function computeProviderWindowStats(reports: UsageReport[]): ProviderWindowStat[] {
	const buckets = new Map<string, { window: string; durationMs?: number; meter?: string; fractions: number[] }>();
	for (const report of reports) {
		const accountMax = new Map<string, number>();
		for (const limit of report.limits) {
			const fraction = resolveUsedFraction(limit);
			if (fraction === undefined) continue;
			const durationMs = limit.window?.durationMs;
			const windowKey =
				durationMs !== undefined ? `d:${durationMs}` : (limit.scope.windowId ?? limit.window?.label ?? limit.label);
			const meter = meterForLimit(report, limit);
			const key = meter === undefined ? windowKey : `m:${meter}\0${windowKey}`;
			const previous = accountMax.get(key);
			if (previous === undefined || fraction > previous) accountMax.set(key, fraction);
			if (!buckets.has(key)) {
				const window =
					durationMs !== undefined
						? formatDuration(durationMs)
						: (limit.window?.label ?? limit.scope.windowId ?? limit.label);
				buckets.set(key, { window, durationMs, meter, fractions: [] });
			}
		}
		for (const [key, fraction] of accountMax) buckets.get(key)!.fractions.push(fraction);
	}
	return [...buckets.values()]
		.sort((a, b) => {
			const duration = (a.durationMs ?? Number.POSITIVE_INFINITY) - (b.durationMs ?? Number.POSITIVE_INFINITY);
			return duration !== 0 ? duration : (a.meter ?? "").localeCompare(b.meter ?? "");
		})
		.map(bucket => {
			const usedAccounts = bucket.fractions.reduce((sum, fraction) => sum + fraction, 0);
			return {
				window: bucket.window,
				durationMs: bucket.durationMs,
				...(bucket.meter === undefined ? {} : { meter: bucket.meter }),
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

function accountOAuthIdentity(account: UsageAccountIdentity): OAuthAccountIdentity {
	return {
		email: account.email,
		accountId: account.accountId,
		projectId: account.projectId,
		orgId: account.orgId,
		orgName: account.orgName,
	};
}

function policyEnabledProviders(
	reports: UsageReport[],
	accounts: UsageAccountIdentity[],
	options: UsagePolicyDiagnosticsOptions | undefined,
): Set<string> {
	const providers = new Set<string>();
	if (!options) return providers;
	for (const account of accounts) {
		if (account.type === "oauth" && options.getAccountPolicy(account.provider, accountOAuthIdentity(account))) {
			providers.add(account.provider);
		}
	}
	for (const report of reports) {
		if (options.getAccountPolicy(report.provider, usageReportIdentity(report))) providers.add(report.provider);
	}
	return providers;
}

function formatPolicyLine(
	provider: string,
	identity: OAuthAccountIdentity,
	limits: UsageLimit[] | undefined,
	options: UsagePolicyDiagnosticsOptions,
): string {
	const policy = options.getAccountPolicy(provider, identity);
	const priority = policy?.priority ?? 0;
	const configuredReservePct = policy?.reservePct;
	const inherited = configuredReservePct === undefined;
	const reservePct = Math.max(0, Math.min(100, configuredReservePct ?? options.globalReservePct));
	const reserveLabel = `${reservePct}% ${inherited ? "(global)" : "(override)"}`;
	// `omp usage` has no model/session context, so report the conservative
	// account-wide state from the most-consumed visible window. Actual routing
	// still scopes limits and selection in AuthStorage.
	// Exhaustion follows the same status-first rule as the limit rows and routing's
	// `isUsageLimitReached`: a provider-reported "exhausted" wins over the fraction.
	const exhausted = (limits ?? []).some(limit => resolveStatus(limit) === "exhausted");
	const usedFractions = (limits ?? [])
		.map(resolveUsedFraction)
		.filter((fraction): fraction is number => fraction !== undefined && Number.isFinite(fraction));
	if (usedFractions.length === 0) {
		const unmeasured = exhausted ? "exhausted" : "reserve unknown";
		return `policy: priority ${priority} · reserve ${reserveLabel} · ${unmeasured}`;
	}
	const remainingFraction = Math.max(0, 1 - Math.max(...usedFractions));
	let state = "eligible";
	if (exhausted || remainingFraction <= 0) state = "exhausted";
	else if (isWithinUsageReserve(remainingFraction, reservePct / 100)) state = "inside reserve";
	return `policy: priority ${priority} · reserve ${reserveLabel} · ${state} · ${(remainingFraction * 100).toFixed(1)}% left`;
}

/** `1 expires in 6h`, or `2 expire, soonest in 6h`. */
function formatExpiringResets(warning: ResetExpiryWarning, nowMs: number): string {
	const due = formatDuration(warning.expiresAtMs - nowMs);
	return warning.count === 1 ? `1 expires in ${due}` : `${warning.count} expire, soonest in ${due}`;
}

function formatResetSpendVerdict(verdict: ResetSpendVerdict): string {
	const outcome =
		verdict.kind === "auto"
			? "an open interactive omp session spends it by its last 5 min if eligible then"
			: verdict.kind === "ask"
				? "an open interactive omp session asks before spending it"
				: "not spent automatically";
	return `→ ${outcome}  (${verdict.setting}: ${verdict.mode})${verdict.eligibleNow ? "" : " · not eligible now"}`;
}

/**
 * Saved resets expiring within 24 hours on accounts worth restoring: what the
 * provider's `autoRedeem` setting does with each one, whether it is eligible
 * now, and the `/usage reset` target that spends it now when the provider allows.
 */
function formatResetExpiryBanner(
	expiring: readonly { report: UsageReport; warning: ResetExpiryWarning }[],
	reportsByProvider: ReadonlyMap<string, UsageReport[]>,
	nowMs: number,
	redaction: Map<string, string> | undefined,
	options: UsageResetExpiryOptions,
): string[] {
	const verdicts = expiring.map(({ report, warning }) => resetSpendVerdict(report, warning, options.settings, nowMs));
	const count = expiring.reduce((sum, { warning }) => sum + warning.count, 0);
	const lost = verdicts.every(verdict => verdict.kind === "off");
	const lines = [
		chalk.red.bold(
			`▲ ${count} saved reset${count === 1 ? " expires" : "s expire"} within 24h${lost ? " and will be lost" : ""}`,
		),
	];
	expiring.forEach(({ report, warning }, index) => {
		const peers = reportsByProvider.get(report.provider) ?? [report];
		const identity = formatReportIdentity(report, peers, peers.indexOf(report), redaction);
		const expiry = new Date(warning.expiresAtMs);
		const expiresAt = `${expiry.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${expiry.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" })}`;
		const used = `${limitTitle(warning.limit)} ${Math.round(warning.usedFraction * 100)}% used`;
		lines.push(
			`  ${formatResetProviderName(warning.provider)} · ${identity} · ${formatExpiringResets(warning, nowMs)} (${expiresAt}) · ${used}`,
		);
		lines.push(`    ${chalk.dim(formatResetSpendVerdict(verdicts[index]!))}`);
		if (!warning.usableNow) return;
		// Codex usage reports carry no credential id; the stored account with the same identity has it.
		const stored = options
			.accounts(warning.provider)
			.filter(account => reportMatchesStatus(report, { ...account, provider: warning.provider }));
		const command =
			stored.length === 1 ? `/usage reset ${warning.provider}/${stored[0]!.credentialId}` : "/usage reset";
		lines.push(
			`    ${verdicts[index]!.kind === "off" ? "spend it" : "or now"}:  ${chalk.cyan(command)} ${chalk.dim("in omp")}`,
		);
	});
	return lines;
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
	policyOptions?: UsagePolicyDiagnosticsOptions,
	resetOptions?: UsageResetExpiryOptions,
	defaultAccounts?: ReadonlyMap<string, string>,
): string {
	const displayReports = collapseSharedUsageReports(reports);
	const reportsByProvider = new Map<string, UsageReport[]>();
	for (const report of displayReports) {
		const list = reportsByProvider.get(report.provider) ?? [];
		list.push(report);
		reportsByProvider.set(report.provider, list);
	}
	const unreported = collectUnreportedAccounts(displayReports, accounts);
	const policyProviders = policyEnabledProviders(displayReports, accounts, policyOptions);
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
	const latestFetchedAt = Math.max(0, ...displayReports.map(report => report.fetchedAt ?? 0));
	const headerSuffix = latestFetchedAt ? chalk.dim(` · fetched ${formatDuration(nowMs - latestFetchedAt)} ago`) : "";
	lines.push(`${chalk.bold("Usage")}${headerSuffix}`);
	const expiring = displayReports.flatMap(report => {
		const warning = classifyResetExpiry(report, nowMs);
		return warning?.tier === "imminent" ? [{ report, warning }] : [];
	});
	if (resetOptions && expiring.length > 0) {
		lines.push("", ...formatResetExpiryBanner(expiring, reportsByProvider, nowMs, redaction, resetOptions));
	}

	for (const provider of providers) {
		const providerReports = reportsByProvider.get(provider) ?? [];
		const providerUnreported = unreportedByProvider.get(provider) ?? [];
		const accountCount = providerReports.length + providerUnreported.length;
		lines.push("");
		lines.push(
			`${chalk.bold.cyan(formatProviderName(provider))} ${chalk.dim(`— ${accountCount} ${accountCount === 1 ? "account" : "accounts"}`)}`,
		);
		const defaultAccountLabel = defaultAccounts?.get(provider);
		if (defaultAccountLabel) lines.push(`  ${chalk.dim(`default account: ${defaultAccountLabel}`)}`);
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
					policyLine:
						policyOptions && policyProviders.has(provider)
							? formatPolicyLine(provider, usageReportIdentity(report), report.limits, policyOptions)
							: undefined,
				}),
			);
		});

		for (const account of providerUnreported) {
			const label = accountIdentityLabel(account, redaction);
			lines.push(`  ${chalk.dim("○")} ${chalk.dim(`${label} — no usage data`)}`);
			if (policyOptions && account.type === "oauth" && policyProviders.has(provider)) {
				lines.push(
					`      ${chalk.dim(formatPolicyLine(provider, accountOAuthIdentity(account), undefined, policyOptions))}`,
				);
			}
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
			const parts = stats.map(stat => {
				const meterLabel = stat.meter ? ` (${stat.meter.charAt(0).toUpperCase()}${stat.meter.slice(1)})` : "";
				return `${stat.window}${meterLabel} → ${stat.usedAccounts.toFixed(2)}/${stat.accounts} ${stat.accounts === 1 ? "account" : "accounts"} used (${stat.remainingAccounts.toFixed(2)}× quota left)`;
			});
			lines.push(`  ${chalk.dim(`capacity: ${parts.join(" · ")}`)}`);
		}
	}

	return lines.join("\n");
}
