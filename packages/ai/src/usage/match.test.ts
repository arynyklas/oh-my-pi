import { describe, expect, it } from "bun:test";
import type { Provider } from "../types";
import type { UsageReport } from "../usage";
import { matchUsageReportsToIdentities, matchUsageReportToIdentity } from "./match";

const openai = "openai" as Provider;
const anthropic = "anthropic" as Provider;
const openaiCodex = "openai-codex" as Provider;

function report(
	provider: Provider,
	metadata: Record<string, unknown>,
	limitScope: UsageReport["limits"][number]["scope"] = { provider },
): UsageReport {
	return {
		provider,
		fetchedAt: 1,
		metadata,
		limits: [
			{
				id: "window",
				label: "Window",
				scope: limitScope,
				amount: { used: 1, limit: 10, unit: "requests" },
			},
		],
	};
}

describe("matchUsageReportToIdentity", () => {
	it("matches same-provider reports by account id, email, or project id", () => {
		const reports = [
			report(openai, { accountId: "acct-a" }),
			report(openai, { email: "person@example.com" }),
			report(openai, { project_id: "proj-1" }),
			report(anthropic, { accountId: "acct-a" }),
		];

		expect(matchUsageReportToIdentity(reports, { provider: openai, accountId: " ACCT-A " })).toBe(reports[0]);
		expect(matchUsageReportToIdentity(reports, { provider: openai, email: "PERSON@example.com" })).toBe(reports[1]);
		expect(matchUsageReportToIdentity(reports, { provider: openai, projectId: "PROJ-1" })).toBe(reports[2]);
	});

	it("matches account and project ids exposed only on limit scopes", () => {
		const reports = [
			report(openai, {}, { provider: openai, accountId: "acct-scope" }),
			report(openai, {}, { provider: openai, projectId: "proj-scope" }),
		];

		expect(matchUsageReportToIdentity(reports, { provider: openai, accountId: "acct-scope" })).toBe(reports[0]);
		expect(matchUsageReportToIdentity(reports, { provider: openai, projectId: "proj-scope" })).toBe(reports[1]);
	});

	it("prefers account id over a shared email regardless of report order", () => {
		const reports = [
			report(openai, { accountId: "acct-b", email: "shared@example.com" }),
			report(openai, { accountId: "acct-a", email: "other@example.com" }),
		];

		expect(
			matchUsageReportToIdentity(reports, {
				provider: openai,
				accountId: "acct-a",
				email: "shared@example.com",
			}),
		).toBe(reports[1]);
	});

	it("matches Anthropic single reports by email despite differing account ids", () => {
		const reports = [
			report(anthropic, { accountId: "other-org-id", email: "other@example.com" }),
			report(anthropic, { accountId: "org-id", email: "person@example.com" }),
		];

		expect(
			matchUsageReportToIdentity(reports, {
				provider: anthropic,
				accountId: "saved-credential-uuid",
				email: "person@example.com",
			}),
		).toBe(reports[1]);
	});

	it("prefers canonical email before account id for email-identified providers", () => {
		for (const provider of [anthropic, openaiCodex]) {
			const reports = [
				report(provider, { accountId: "saved-credential-id", email: "wrong@example.com" }),
				report(provider, { accountId: "provider-org-id", email: "right@example.com" }),
			];

			expect(
				matchUsageReportToIdentity(reports, {
					provider,
					accountId: "saved-credential-id",
					email: "right@example.com",
				}),
			).toBe(reports[1]);
		}
	});

	it("uses organization before canonical email for multi-subscription accounts", () => {
		const reports = [
			report(anthropic, { orgId: "org-b", email: "shared@example.com", accountId: "member-b" }),
			report(anthropic, { orgId: "org-a", email: "shared@example.com", accountId: "member-a" }),
		];

		expect(
			matchUsageReportToIdentity(reports, {
				provider: anthropic,
				orgId: "org-a",
				email: "shared@example.com",
				accountId: "saved-member-a",
			}),
		).toBe(reports[1]);
		expect(
			matchUsageReportToIdentity(reports, {
				provider: anthropic,
				email: "shared@example.com",
			}),
		).toBeNull();
	});

	it("falls back to the lone same-provider report", () => {
		const reports = [report(anthropic, { accountId: "other" }), report(openai, {})];

		expect(matchUsageReportToIdentity(reports, { provider: openai, accountId: "missing" })).toBe(reports[1]);
	});

	it("refuses ambiguous provider-only matches", () => {
		const reports = [report(openai, {}), report(openai, { accountId: "acct-b" })];

		expect(matchUsageReportToIdentity(reports, { provider: openai, accountId: "acct-a" })).toBeNull();
		expect(matchUsageReportToIdentity(reports, { provider: openai })).toBeNull();
	});
});

describe("matchUsageReportsToIdentities", () => {
	it("does not assign one reported account to every saved same-provider credential", () => {
		const identities = [
			{ provider: openai, accountId: "acct-reported" },
			{ provider: openai, accountId: "acct-unreported" },
		];
		const reports = [report(openai, { accountId: "acct-reported" })];

		const matches = matchUsageReportsToIdentities(reports, identities);

		expect(matches.get(identities[0]!)).toBe(reports[0]);
		expect(matches.has(identities[1]!)).toBe(false);
	});

	it("matches Anthropic usage by email even when report account id is the org id", () => {
		const identities = [
			{ provider: anthropic, accountId: "saved-credential-uuid", email: "person@example.com" },
			{ provider: anthropic, accountId: "other-saved-credential-uuid", email: "other@example.com" },
		];
		const reports = [
			report(anthropic, { accountId: "org-id", email: "person@example.com" }),
			report(anthropic, { accountId: "other-org-id", email: "other@example.com" }),
		];

		const matches = matchUsageReportsToIdentities(reports, identities);

		expect(matches.get(identities[0]!)).toBe(reports[0]);
		expect(matches.get(identities[1]!)).toBe(reports[1]);
	});

	it("maps same-email Anthropic accounts to their own organizations", () => {
		const identities = [
			{ provider: anthropic, orgId: "org-a", email: "shared@example.com", accountId: "saved-a" },
			{ provider: anthropic, orgId: "org-b", email: "shared@example.com", accountId: "saved-b" },
		];
		const reports = [
			report(anthropic, { orgId: "org-b", email: "shared@example.com", accountId: "member-b" }),
			report(anthropic, { orgId: "org-a", email: "shared@example.com", accountId: "member-a" }),
		];

		const matches = matchUsageReportsToIdentities(reports, identities);

		expect(matches.get(identities[0]!)).toBe(reports[1]);
		expect(matches.get(identities[1]!)).toBe(reports[0]);
	});

	it("falls back only when one unclaimed account and one unclaimed report remain for a provider", () => {
		const identities = [
			{ provider: openai, accountId: "acct-known" },
			{ provider: openai, accountId: "acct-unknown" },
		];
		const reports = [report(openai, { accountId: "acct-known" }), report(openai, {})];

		const matches = matchUsageReportsToIdentities(reports, identities);

		expect(matches.get(identities[0]!)).toBe(reports[0]);
		expect(matches.get(identities[1]!)).toBe(reports[1]);
	});

	it("does not fallback-pair unclaimed account and report with contradictory identities", () => {
		const identities = [
			{ provider: openai, accountId: "acct-a" },
			{ provider: openai, accountId: "acct-b" },
		];
		const reports = [report(openai, { accountId: "acct-a" }), report(openai, { accountId: "acct-c" })];

		const matches = matchUsageReportsToIdentities(reports, identities);

		expect(matches.get(identities[0]!)).toBe(reports[0]);
		expect(matches.has(identities[1]!)).toBe(false);
	});
});
