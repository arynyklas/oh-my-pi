import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import type { AuthGatewayAdminClient, AuthGatewayCredentialSummary } from "@oh-my-pi/pi-ai/auth-gateway";
import type { ResetCreditRedeemOutcome } from "@oh-my-pi/pi-ai/auth-storage";
import type { Provider } from "@oh-my-pi/pi-ai/types";
import type { UsageReport } from "@oh-my-pi/pi-ai/usage";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { AuthGatewayProfileStore, ResolvedAuthGatewayConnection } from "../../../auth-gateway/profiles";
import { formatUsageReportLines } from "../../../utils/usage-format";
import { initTheme } from "../../theme/theme";
import { AuthGatewayConsole } from "./console";

const ANSI_PATTERN = /\x1b\[[0-9;]*m/g;
const openai = "openai" as Provider;
const openaiCodex = "openai-codex" as Provider;
const reportNowMs = Date.now();

const connection: ResolvedAuthGatewayConnection = {
	profile: { name: "local", url: "http://127.0.0.1:4010", tokenSource: { type: "file" } },
	token: "secret",
};

const credential: AuthGatewayCredentialSummary = {
	id: 1,
	provider: openai,
	type: "oauth",
	identityKey: "openai:acct-1",
	email: "person@example.com",
	accountId: "acct-1",
	projectId: null,
	enterpriseUrl: null,
	apiEndpoint: null,
	expiresAt: null,
};

const usageReport: UsageReport = {
	provider: openai,
	fetchedAt: reportNowMs,
	metadata: { accountId: "acct-1", email: "person@example.com" },
	resetCredits: { availableCount: 1, credits: [{ expiresAt: new Date(reportNowMs + 172_800_000).toISOString() }] },
	notes: ["Provider caveat"],
	limits: [
		{
			id: "requests",
			label: "Requests",
			scope: { provider: openai, accountId: "acct-1" },
			amount: { used: 2, limit: 10, unit: "requests" },
			window: { id: "hour", label: "Hour", resetsAt: reportNowMs + 3_600_000 },
			status: "warning",
			notes: ["Limit caveat"],
		},
	],
};

const codexCredential: AuthGatewayCredentialSummary = {
	...credential,
	id: 42,
	provider: openaiCodex,
	identityKey: "email:codex@example.com",
	email: "codex@example.com",
	accountId: "acct-codex",
};

const codexUsageReport: UsageReport = {
	...usageReport,
	provider: openaiCodex,
	metadata: { accountId: "acct-codex", email: "codex@example.com" },
	resetCredits: { availableCount: 2 },
	limits: usageReport.limits.map(limit => ({
		...limit,
		scope: { ...limit.scope, provider: openaiCodex, accountId: "acct-codex" },
	})),
};

function stripAnsi(value: string): string {
	return value.replace(ANSI_PATTERN, "");
}

function semanticLines(value: string): string[] {
	return stripAnsi(value)
		.split("\n")
		.map(line => line.trim().replace(/\s+/g, " "))
		.filter(Boolean);
}

beforeAll(async () => {
	await initTheme();
});

function makeClient(options: {
	credentials?: AuthGatewayCredentialSummary[];
	reports?: UsageReport[];
	usageError?: Error;
	listUsageReports?: () => Promise<UsageReport[]>;
	redeemCredentialReset?: (credentialId: number) => Promise<ResetCreditRedeemOutcome>;
}): AuthGatewayAdminClient {
	const client = {
		status: async () => ({
			ok: true as const,
			version: "test",
			serverTime: 1,
			principal: { kind: "managed" as const, userId: 1, name: "admin", role: "admin" as const, tokenId: 1 },
			counts: { users: 1, activeTokens: 1, pools: 0, credentials: 1 },
		}),
		listCredentials: async () => options.credentials ?? [credential],
		listUsageReports: async () => {
			if (options.listUsageReports) return await options.listUsageReports();
			if (options.usageError) throw options.usageError;
			return options.reports ?? [];
		},
		redeemCredentialReset: async (credentialId: number) => {
			if (options.redeemCredentialReset) return await options.redeemCredentialReset(credentialId);
			throw new Error("reset redemption not configured");
		},
	} satisfies Partial<AuthGatewayAdminClient>;
	return client as unknown as AuthGatewayAdminClient;
}

function createConsole(
	client: AuthGatewayAdminClient,
	requestRender: () => void = () => undefined,
): AuthGatewayConsole {
	return new AuthGatewayConsole({
		connection,
		profileStore: {} as AuthGatewayProfileStore,
		createClient: () => client,
		host: { ui: { requestRender } as TUI, openInBrowser: () => undefined, close: () => undefined },
	});
}

function renderConsole(console: AuthGatewayConsole, width = 220): string {
	return stripAnsi(console.render(width).join("\n"));
}

async function renderAccounts(client: AuthGatewayAdminClient, width = 220): Promise<string> {
	const console = createConsole(client);
	try {
		await console.ready;
		await console.controller.switchTab("accounts");
		return renderConsole(console, width);
	} finally {
		console.dispose();
	}
}

describe("AuthGatewayConsole accounts usage", () => {
	it("renders matched upstream usage reports for the selected account", async () => {
		const text = await renderAccounts(makeClient({ reports: [usageReport] }));

		expect(text).toContain("#1 · openai · oauth · person@example.com");
		expect(text).toContain("Usage");
		expect(text).toContain("Requests");
		expect(text).toContain("2 / 10 requests");
		expect(text).toContain("✦ 1 saved reset");
		expect(text).toContain("Provider caveat");
		expect(text).toContain("Limit caveat");
	});

	it("renders the same usage lines as the native usage formatter", async () => {
		const nowSpy = spyOn(Date, "now").mockReturnValue(reportNowMs);
		try {
			const text = await renderAccounts(makeClient({ reports: [usageReport] }));
			const renderedText = semanticLines(text).join("\n");
			const nativeLines = semanticLines(
				formatUsageReportLines(usageReport, { reports: [usageReport], nowMs: reportNowMs }).join("\n"),
			);

			for (const line of nativeLines) expect(renderedText).toContain(line);
		} finally {
			nowSpy.mockRestore();
		}
	});

	it("keeps saved-reset and limit-reset details visible at normal width", async () => {
		const nowSpy = spyOn(Date, "now").mockReturnValue(reportNowMs);
		try {
			const text = await renderAccounts(makeClient({ reports: [usageReport] }), 140);

			expect(text).toContain("soonest expires in 2d");
			expect(text).toContain("resets in 1h");
		} finally {
			nowSpy.mockRestore();
		}
	});

	it("keeps reset expiry visible at minimum terminal height", async () => {
		const nowSpy = spyOn(Date, "now").mockReturnValue(reportNowMs);
		const originalRows = Object.getOwnPropertyDescriptor(process.stdout, "rows");
		Object.defineProperty(process.stdout, "rows", { configurable: true, value: 14 });
		try {
			const text = await renderAccounts(makeClient({ reports: [usageReport] }), 140);

			expect(text).toContain("soonest expires in 2d");
			expect(text).toContain("resets in 1h");
		} finally {
			if (originalRows) {
				Object.defineProperty(process.stdout, "rows", originalRows);
			} else {
				Reflect.deleteProperty(process.stdout, "rows");
			}
			nowSpy.mockRestore();
		}
	});

	it("keeps accounts visible when usage reports are unavailable", async () => {
		const text = await renderAccounts(makeClient({ usageError: new Error("usage down") }));

		expect(text).toContain("#1 · openai · oauth · person@example.com");
		expect(text).toContain("Usage: unavailable");
		expect(text).toContain("usage down");
	});

	it("preserves last-good account usage when a later usage refresh fails", async () => {
		let failUsage = false;
		const client = makeClient({
			listUsageReports: async () => {
				if (failUsage) throw new Error("usage down");
				return [usageReport];
			},
		});
		const console = createConsole(client);
		try {
			await console.ready;
			await console.controller.switchTab("accounts");

			failUsage = true;
			await console.controller.refresh();
			const text = renderConsole(console);

			expect(text).toContain("Requests");
			expect(text).toContain("2 / 10 requests");
			expect(text).toContain("Usage refresh unavailable");
			expect(text).toContain("usage down");
		} finally {
			console.dispose();
		}
	});

	it("confirms reset spending and refreshes usage after a completed business outcome", async () => {
		let usageLoads = 0;
		let resetCalls = 0;
		const refreshed = Promise.withResolvers<void>();
		const completed = Promise.withResolvers<void>();
		const client = makeClient({
			credentials: [codexCredential],
			listUsageReports: async () => {
				usageLoads += 1;
				if (usageLoads === 2) refreshed.resolve();
				return [codexUsageReport];
			},
			redeemCredentialReset: async credentialId => {
				resetCalls += 1;
				expect(credentialId).toBe(codexCredential.id);
				return {
					ok: false,
					code: "nothing_to_reset",
					accountId: "acct-codex",
					email: "codex@example.com",
				};
			},
		});
		let console: AuthGatewayConsole | undefined;
		console = createConsole(client, () => {
			if (console?.controller.state.errorBanner?.includes("nothing to reset right now")) completed.resolve();
		});
		try {
			await console.ready;
			await console.controller.switchTab("accounts");
			expect(renderConsole(console)).toContain("s spend reset");

			console.handleInput("s");
			expect(renderConsole(console)).toContain("Spend one saved reset");
			expect(resetCalls).toBe(0);

			console.handleInput("\u001b[B");
			console.handleInput("\r");
			await refreshed.promise;
			await completed.promise;

			expect(resetCalls).toBe(1);
			expect(usageLoads).toBe(2);
			expect(renderConsole(console)).toContain(
				"codex@example.com: nothing to reset right now — your limits aren't constrained, so no credit was spent.",
			);
		} finally {
			console.dispose();
		}
	});

	it("shows reset applied after successful activation and refreshed usage", async () => {
		let usageLoads = 0;
		const completed = Promise.withResolvers<void>();
		const refreshedReport: UsageReport = {
			...codexUsageReport,
			resetCredits: { availableCount: 1 },
		};
		const client = makeClient({
			credentials: [codexCredential],
			listUsageReports: async () => {
				usageLoads += 1;
				return [usageLoads === 1 ? codexUsageReport : refreshedReport];
			},
			redeemCredentialReset: async () => ({
				ok: true,
				code: "reset",
				accountId: "acct-codex",
				email: "codex@example.com",
				creditId: "credit-1",
			}),
		});
		let console: AuthGatewayConsole | undefined;
		console = createConsole(client, () => {
			if (console?.controller.state.errorBanner?.includes("Reset applied")) completed.resolve();
		});
		try {
			await console.ready;
			await console.controller.switchTab("accounts");
			console.handleInput("s");
			console.handleInput("\u001b[B");
			console.handleInput("\r");
			await completed.promise;

			const text = renderConsole(console);
			expect(usageLoads).toBe(2);
			expect(text).toContain("Reset applied for codex@example.com — your rate-limit window has been refreshed.");
			expect(text).toContain("✦ 1 saved reset");
		} finally {
			console.dispose();
		}
	});
	it("does not advertise reset activation for ineligible accounts", async () => {
		const text = await renderAccounts(makeClient({ reports: [usageReport] }));

		expect(text).not.toContain("s spend reset");
	});
});
