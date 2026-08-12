import type { UsageLimit, UsageReport } from "@oh-my-pi/pi-ai";
import { getOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { DefaultAccountFallover, OAuthAccountIdentity, OAuthAccountSummary } from "../../session/auth-storage";
import { formatDuration } from "./format";

function normalizeIdentityValue(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim().toLowerCase() : undefined;
}

/**
 * Session marker label for an active OAuth identity: the base identifier
 * (email → accountId → projectId) suffixed with the organization when present
 * and distinct. Same-email Anthropic multi-org accounts share the base, so the
 * org suffix is the only field that tells the session's quota pool apart —
 * mirrors the account-list rows (`formatUsageReportAccount`) and login success.
 * Returns `undefined` when no identifier is recoverable.
 */
export function formatActiveAccountLabel(identity: OAuthAccountIdentity | undefined): string | undefined {
	if (!identity) return undefined;
	const base = identity.email || identity.accountId || identity.projectId;
	if (!base) return undefined;
	const org = identity.orgName || identity.orgId;
	return org && org !== base ? `${base} (${org})` : base;
}

/**
 * True when a single usage-limit column belongs to the given OAuth identity.
 *
 * Single definition of the matching rules for both `/usage` renderers:
 * - `orgId`     ↔ report metadata `orgId` — a GATE that QUALIFIES the base
 *   identity, never a replacement for it. Mismatched org presence or
 *   different orgs never match: two subscriptions (orgs) can share one
 *   email, so an org-scoped identity matches only its own org's reports and
 *   an org-less legacy identity never claims an org-attributed report via
 *   the shared email. A SHARED org still requires the base-identity match
 *   below — Anthropic Team seats have per-user pools yet share the org id
 *   in report metadata. Only an org-only identity (no base identifiers
 *   recovered at all) matches on the org alone. When neither side carries
 *   an org, the base fallback applies unchanged (providers without orgs
 *   keep their former behavior).
 * - `accountId` ↔ report metadata `accountId`/`account_id` or `limit.scope.accountId`
 * - `email`     ↔ report metadata `email`
 * - `projectId` ↔ report metadata `projectId` or `limit.scope.projectId`
 *   (Google-style providers key usage on the GCP project, not an account id)
 */
export function limitMatchesActiveAccount(
	report: UsageReport,
	limit: UsageLimit,
	identity: OAuthAccountIdentity | undefined,
): boolean {
	if (!identity) return false;
	const metadata = report.metadata ?? {};
	const activeAccountId = normalizeIdentityValue(identity.accountId);
	const activeEmail = normalizeIdentityValue(identity.email);
	const activeProjectId = normalizeIdentityValue(identity.projectId);
	const activeOrgId = normalizeIdentityValue(identity.orgId);
	const reportOrgId = normalizeIdentityValue(metadata.orgId);
	// Org gate (see doc comment above): different/mismatched-presence orgs
	// never match; a shared org falls through to the base checks unless the
	// identity is org-only.
	if (activeOrgId || reportOrgId) {
		if (activeOrgId !== reportOrgId) return false;
		if (!activeAccountId && !activeEmail && !activeProjectId) return true;
	}
	if (activeAccountId) {
		const reportAccountId = normalizeIdentityValue(metadata.accountId) ?? normalizeIdentityValue(metadata.account_id);
		if (reportAccountId === activeAccountId) return true;
		if (normalizeIdentityValue(limit.scope.accountId) === activeAccountId) return true;
	}
	if (activeEmail && normalizeIdentityValue(metadata.email) === activeEmail) return true;
	if (activeProjectId) {
		if (normalizeIdentityValue(metadata.projectId) === activeProjectId) return true;
		if (normalizeIdentityValue(limit.scope.projectId) === activeProjectId) return true;
	}
	return false;
}

/** True when any limit column in `report` belongs to the given OAuth identity. */
export function reportMatchesActiveAccount(report: UsageReport, identity: OAuthAccountIdentity | undefined): boolean {
	if (!identity) return false;
	return report.limits.some(limit => limitMatchesActiveAccount(report, limit, identity));
}

/**
 * One-line warning shown when a session falls over from its configured default
 * account to a sibling. Resolves both credential ids to display labels via the
 * provider's stored OAuth accounts, falling back to `account #<id>` when an id
 * no longer resolves (e.g. logged out mid-session).
 */
export function formatDefaultAccountFalloverNotice(
	fallover: DefaultAccountFallover,
	accounts: readonly OAuthAccountSummary[],
): string {
	const label = (credentialId: number): string => {
		const account = accounts.find(candidate => candidate.credentialId === credentialId);
		if (!account) return `account #${credentialId}`;
		const enterpriseUrl = account.enterpriseUrl?.trim();
		return (formatActiveAccountLabel(account) ?? enterpriseUrl) || `account #${credentialId}`;
	};
	const provider = getOAuthProviders().find(candidate => candidate.id === fallover.provider);
	const providerName = provider?.name ?? fallover.provider;
	const now = Date.now();
	const untilClause =
		fallover.retryAtMs !== undefined && fallover.retryAtMs > now
			? ` until in ${formatDuration(fallover.retryAtMs - now)}`
			: "";
	return `${providerName}: default account ${label(fallover.defaultCredentialId)} is out of quota${untilClause} — using ${label(fallover.usedCredentialId)} for the rest of this session.`;
}
