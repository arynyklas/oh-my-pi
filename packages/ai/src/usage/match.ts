import type { UsageReport } from "../usage";

const EMAIL_CANONICAL_PROVIDERS = new Set(["anthropic", "openai-codex"]);

export interface UsageReportIdentity {
	provider: string;
	accountId?: string | null;
	email?: string | null;
	projectId?: string | null;
}

export interface UsageReportMatchOptions {
	allowProviderFallback?: boolean;
}

/**
 * Match a provider usage report to a specific credential/account identity.
 *
 * The aggregate usage endpoint returns one or more reports per provider. A report
 * may identify the account through metadata or through limit scopes. The single
 * report helper preserves the broker's historical lone-provider fallback by
 * default; account-list UIs should use {@link matchUsageReportsToIdentities} so
 * one reported account is never assigned to several saved rows.
 */
export function matchUsageReportToIdentity(
	reports: readonly UsageReport[],
	identity: UsageReportIdentity,
	options: UsageReportMatchOptions = {},
): UsageReport | null {
	const candidates = reports.filter(report => report.provider === identity.provider);
	if (candidates.length === 0) return null;
	if (candidates.length === 1 && options.allowProviderFallback !== false) return candidates[0]!;
	return matchExactUsageReportCandidate(candidates, identity);
}

export function matchUsageReportsToIdentities<T extends UsageReportIdentity>(
	reports: readonly UsageReport[],
	identities: readonly T[],
): Map<T, UsageReport> {
	const matches = new Map<T, UsageReport>();
	const claimed = new Set<UsageReport>();
	for (const identity of identities) {
		const candidates = reports.filter(report => report.provider === identity.provider && !claimed.has(report));
		const match = matchExactUsageReportCandidate(candidates, identity);
		if (!match) continue;
		matches.set(identity, match);
		claimed.add(match);
	}

	const providers = new Set([
		...reports.map(report => report.provider),
		...identities.map(identity => identity.provider),
	]);
	for (const provider of providers) {
		const remainingReports = reports.filter(report => report.provider === provider && !claimed.has(report));
		const remainingIdentities = identities.filter(
			identity => identity.provider === provider && !matches.has(identity),
		);
		if (remainingReports.length === 1 && remainingIdentities.length === 1) {
			const report = remainingReports[0]!;
			const identity = remainingIdentities[0]!;
			if (!usageReportHasAttribution(report) || !identityHasAttribution(identity)) {
				matches.set(identity, report);
				claimed.add(report);
			}
		}
	}
	return matches;
}

function matchExactUsageReportCandidate(
	candidates: readonly UsageReport[],
	identity: UsageReportIdentity,
): UsageReport | null {
	const accountId = normalizeIdentity(identity.accountId);
	const email = normalizeIdentity(identity.email);
	const projectId = normalizeIdentity(identity.projectId);
	const emailIsCanonical = EMAIL_CANONICAL_PROVIDERS.has(identity.provider);
	if (email && emailIsCanonical) {
		const match = candidates.find(
			report => normalizedReportEmails(report).includes(email) && !reportHasProjectConflict(report, projectId),
		);
		if (match) return match;
	}
	if (accountId) {
		const match = candidates.find(report => normalizedReportAccountIds(report).includes(accountId));
		if (match) return match;
	}
	if (projectId) {
		const match = candidates.find(
			report =>
				normalizedReportProjectIds(report).includes(projectId) && !reportHasAccountConflict(report, accountId),
		);
		if (match) return match;
	}
	if (email && !emailIsCanonical) {
		const match = candidates.find(
			report =>
				normalizedReportEmails(report).includes(email) &&
				!reportHasAccountConflict(report, accountId) &&
				!reportHasProjectConflict(report, projectId),
		);
		if (match) return match;
	}
	return null;
}

export function findMatchingUsageReportIndex(reports: readonly UsageReport[], overlay: UsageReport): number {
	const candidates = reports
		.map((report, index) => ({ report, index }))
		.filter(candidate => candidate.report.provider === overlay.provider);
	if (candidates.length === 0) return -1;
	if (candidates.length === 1) return candidates[0]!.index;
	const metadata = (overlay.metadata ?? {}) as Record<string, unknown>;
	const match = matchExactUsageReportCandidate(
		candidates.map(candidate => candidate.report),
		{
			provider: overlay.provider,
			accountId: readMetadataString(metadata, "accountId"),
			email: readMetadataString(metadata, "email"),
			projectId: readMetadataString(metadata, "projectId"),
		},
	);
	if (!match) return -1;
	return candidates.find(candidate => candidate.report === match)?.index ?? -1;
}

function reportHasAccountConflict(report: UsageReport, accountId: string | undefined): boolean {
	const accountIds = normalizedReportAccountIds(report);
	return accountId !== undefined && accountIds.length > 0 && !accountIds.includes(accountId);
}

function reportHasProjectConflict(report: UsageReport, projectId: string | undefined): boolean {
	const projectIds = normalizedReportProjectIds(report);
	return projectId !== undefined && projectIds.length > 0 && !projectIds.includes(projectId);
}

function normalizedReportAccountIds(report: UsageReport): string[] {
	const metadata = (report.metadata ?? {}) as Record<string, unknown>;
	return uniqueDefined([
		normalizeIdentity(readMetadataString(metadata, "accountId")),
		normalizeIdentity(readMetadataString(metadata, "account_id")),
		...report.limits.map(limit => normalizeIdentity(limit.scope.accountId)),
	]);
}

function normalizedReportProjectIds(report: UsageReport): string[] {
	const metadata = (report.metadata ?? {}) as Record<string, unknown>;
	return uniqueDefined([
		normalizeIdentity(readMetadataString(metadata, "projectId")),
		normalizeIdentity(readMetadataString(metadata, "project_id")),
		...report.limits.map(limit => normalizeIdentity(limit.scope.projectId)),
	]);
}

function normalizedReportEmails(report: UsageReport): string[] {
	const metadata = (report.metadata ?? {}) as Record<string, unknown>;
	return uniqueDefined([normalizeIdentity(readMetadataString(metadata, "email"))]);
}

function uniqueDefined(values: Array<string | undefined>): string[] {
	return [...new Set(values.filter((value): value is string => value !== undefined))];
}

function usageReportHasAttribution(report: UsageReport): boolean {
	const metadata = (report.metadata ?? {}) as Record<string, unknown>;
	if (readMetadataString(metadata, "accountId") ?? readMetadataString(metadata, "account_id")) return true;
	if (readMetadataString(metadata, "email")) return true;
	if (readMetadataString(metadata, "projectId") ?? readMetadataString(metadata, "project_id")) return true;
	for (const limit of report.limits) {
		if (normalizeIdentity(limit.scope.accountId) || normalizeIdentity(limit.scope.projectId)) return true;
	}
	return false;
}

function identityHasAttribution(identity: UsageReportIdentity): boolean {
	return (
		normalizeIdentity(identity.accountId) !== undefined ||
		normalizeIdentity(identity.email) !== undefined ||
		normalizeIdentity(identity.projectId) !== undefined
	);
}

function normalizeIdentity(value: string | null | undefined): string | undefined {
	const trimmed = value?.trim();
	return trimmed ? trimmed.toLowerCase() : undefined;
}

function readMetadataString(metadata: Record<string, unknown>, key: string): string | undefined {
	const value = metadata[key];
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
