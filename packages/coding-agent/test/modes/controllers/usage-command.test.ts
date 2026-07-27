import { beforeAll, describe, expect, it, vi } from "bun:test";
import type { UsageReport } from "@oh-my-pi/pi-ai";
import { CommandController } from "@oh-my-pi/pi-coding-agent/modes/controllers/command-controller";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";

interface RenderableBlock {
	render(width: number): string[];
}

function isRenderableBlock(value: unknown): value is RenderableBlock {
	return value !== null && typeof value === "object" && "render" in value && typeof value.render === "function";
}

function renderPresentedBlocks(value: unknown): string {
	const blocks = Array.isArray(value) ? value : [value];
	return blocks
		.filter(isRenderableBlock)
		.flatMap(block => block.render(120))
		.join("\n");
}

function createUsageSessionDouble() {
	return { getUsageReportingModelSelectors: () => [] };
}

describe("CommandController /usage", () => {
	beforeAll(async () => {
		const theme = await getThemeByName("dark");
		if (!theme) throw new Error("Expected dark theme");
		setThemeInstance(theme);
	});

	it("renders bars and free percentage for limits that only report remainingFraction", async () => {
		const present = vi.fn();
		const ctx = {
			session: createUsageSessionDouble(),
			ui: { terminal: { columns: 100 } },
			present,
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: 1_700_000_000_000,
				limits: [
					{
						id: "codex-weekly",
						label: "Weekly",
						scope: { provider: "openai-codex", tier: "pro", accountId: "acct-1" },
						window: { id: "weekly", label: "weekly" },
						amount: { remainingFraction: 0.25, unit: "requests" },
						status: "ok",
					},
				],
				metadata: { email: "user@example.com" },
			},
		];

		await controller.handleUsageCommand(reports);

		expect(present).toHaveBeenCalledTimes(1);
		const firstCall = present.mock.calls[0];
		expect(firstCall).toBeDefined();
		const output = renderPresentedBlocks(firstCall?.[0]);
		expect(output).toContain("25% free");
		expect(output).toContain("█");
		expect(output).not.toContain("··········");
	});

	it("renders Cursor request quotas in the /usage view", async () => {
		const present = vi.fn();
		const ctx = {
			session: createUsageSessionDouble(),
			ui: { terminal: { columns: 100 } },
			present,
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);
		const now = Date.now();
		const reports: UsageReport[] = [
			{
				provider: "cursor",
				fetchedAt: now,
				limits: [
					{
						id: "cursor:requests:gpt-4",
						label: "gpt-4 requests",
						scope: { provider: "cursor", windowId: "monthly" },
						window: { id: "monthly", label: "Monthly", resetsAt: now + 90_000_000 },
						amount: {
							unit: "requests",
							used: 150,
							limit: 500,
							remaining: 350,
							usedFraction: 0.3,
							remainingFraction: 0.7,
						},
						status: "ok",
					},
				],
				metadata: { email: "cursor@example.test" },
			},
		];

		await controller.handleUsageCommand(reports);

		expect(present).toHaveBeenCalledTimes(1);
		const firstCall = present.mock.calls[0];
		expect(firstCall).toBeDefined();
		const output = renderPresentedBlocks(firstCall?.[0]);
		expect(output).toContain("Cursor");
		expect(output).toContain("gpt-4 requests");
		expect(output).toContain("70% free");
		expect(output).toContain("resets in 1d");
	});

	it("renders saved reset expiry lines for future and expired credits", async () => {
		const present = vi.fn();
		const ctx = {
			session: createUsageSessionDouble(),
			ui: { terminal: { columns: 100 } },
			present,
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);
		const now = Date.now();
		const dayMs = 24 * 60 * 60 * 1000;
		const futureIso = new Date(now + 2 * dayMs).toISOString();
		const expiredIso = new Date(now - 2 * dayMs).toISOString();
		const reports: UsageReport[] = [
			{
				provider: "openai-codex",
				fetchedAt: now,
				limits: [],
				metadata: { email: "user@example.com" },
				resetCredits: {
					availableCount: 2,
					credits: [{ expiresAt: futureIso }, { expiresAt: expiredIso }],
				},
			},
		];

		await controller.handleUsageCommand(reports);

		expect(present).toHaveBeenCalledTimes(1);
		const firstCall = present.mock.calls[0];
		expect(firstCall).toBeDefined();
		const output = renderPresentedBlocks(firstCall?.[0]);
		expect(output).toContain("Saved rate-limit resets");
		expect(output).toContain("user@example.com: 2 saved resets");
		expect(output).toContain(`expires in`);
		expect(output).toContain(`(${futureIso.slice(0, 10)})`);
		expect(output).toContain(`expired (${expiredIso.slice(0, 10)})`);
	});

	it("falls back to auth-gateway user usage when provider reports are empty", async () => {
		const present = vi.fn();
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					usage: {
						userId: 3,
						since: 0,
						generatedAt: 1_700_000_000_000,
						totals: {
							requests: 3,
							inputTokens: 24_804,
							outputTokens: 102,
							cacheReadTokens: 0,
							cacheWriteTokens: 40_434,
							totalTokens: 65_340,
							costUsd: 0.227159,
						},
						byProviderModel: [
							{
								provider: "openai-codex",
								model: "gpt-5.6-sol",
								requests: 2,
								totalTokens: 24_854,
								costUsd: 0.12557,
							},
						],
					},
					principal: {
						kind: "managed",
						userId: 3,
						name: "alice",
						role: "user",
						tokenId: 11,
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);
		const getApiKey = vi.fn().mockResolvedValue("managed-token");
		const ctx = {
			session: {
				model: {
					provider: "xllm-gateway",
					id: "gpt-5.6-sol",
					baseUrl: "http://127.0.0.1:4000",
					transport: "pi-native",
				},
				sessionId: "session-1",
				fetchUsageReports: vi.fn().mockResolvedValue([]),
				modelRegistry: {
					authStorage: { getApiKey },
				},
			},
			ui: { terminal: { columns: 100 } },
			present,
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);
		try {
			await controller.handleUsageCommand();

			expect(fetchSpy).toHaveBeenCalledWith("http://127.0.0.1:4000/v1/usage", {
				headers: { Accept: "application/json", Authorization: "Bearer managed-token" },
			});
			expect(present).toHaveBeenCalledTimes(1);
			const firstCall = present.mock.calls[0];
			expect(firstCall).toBeDefined();
			const output = renderPresentedBlocks(firstCall?.[0]);
			expect(output).toContain("Gateway Usage");
			expect(output).toContain("User: alice (user #3)");
			expect(output).toContain("Requests: 3");
			expect(output).toContain("65,340 tokens");
			expect(output).toContain("openai-codex/gpt-5.6-sol");
			expect(ctx.showWarning).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("renders legacy auth-gateway usage totals when principal metadata is omitted", async () => {
		const present = vi.fn();
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					usage: {
						userId: 3,
						since: 0,
						generatedAt: 1700000000000,
						totals: {
							requests: 10,
							inputTokens: 200000,
							outputTokens: 35000,
							cacheReadTokens: 5000,
							cacheWriteTokens: 336,
							totalTokens: 240336,
							costUsd: 0.7162528,
						},
						byProviderModel: [
							{
								provider: "anthropic",
								model: "claude-sonnet-5",
								requests: 2,
								totalTokens: 12345,
								costUsd: 0.12,
							},
						],
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);
		const getApiKey = vi.fn().mockResolvedValue("managed-token");
		const ctx = {
			session: {
				model: {
					provider: "xllm-gateway",
					id: "anthropic/claude-sonnet-5",
					baseUrl: "http://127.0.0.1:4000",
					transport: "pi-native",
				},
				sessionId: "session-1",
				fetchUsageReports: vi.fn().mockResolvedValue([]),
				modelRegistry: { authStorage: { getApiKey } },
			},
			ui: { terminal: { columns: 100 } },
			present,
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);
		try {
			await controller.handleUsageCommand();

			expect(fetchSpy).toHaveBeenCalledWith("http://127.0.0.1:4000/v1/usage", {
				headers: { Accept: "application/json", Authorization: "Bearer managed-token" },
			});
			expect(present).toHaveBeenCalledTimes(1);
			const firstCall = present.mock.calls[0];
			expect(firstCall).toBeDefined();
			const output = renderPresentedBlocks(firstCall?.[0]);
			expect(output).toContain("Gateway Usage");
			expect(output).toContain("Requests: 10");
			expect(output).toContain("240,336 tokens");
			expect(output).toContain("$0.72");
			expect(output).toContain("anthropic/claude-sonnet-5");
			expect(output).toContain("User ID: #3");
			expect(ctx.showWarning).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("enriches legacy auth-gateway usage totals with a matching admin-status principal", async () => {
		const present = vi.fn();
		const usageResponse = {
			usage: {
				userId: 3,
				since: 0,
				generatedAt: 1700000000000,
				totals: {
					requests: 1,
					inputTokens: 10,
					outputTokens: 20,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					totalTokens: 30,
					costUsd: 0.01,
				},
				byProviderModel: [],
			},
		};
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(JSON.stringify(usageResponse), { status: 200 }))
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						status: {
							ok: true,
							version: "test",
							serverTime: 1700000000001,
							principal: { kind: "managed", userId: 3, name: "alice", role: "admin", tokenId: 9 },
							counts: { users: 1, activeTokens: 1, credentials: 0, pools: 0 },
						},
					}),
					{ status: 200 },
				),
			);
		const getApiKey = vi.fn().mockResolvedValue("managed-token");
		const ctx = {
			session: {
				model: {
					provider: "xllm-gateway",
					id: "anthropic/claude-sonnet-5",
					baseUrl: "http://127.0.0.1:4000",
					transport: "pi-native",
				},
				sessionId: "session-1",
				fetchUsageReports: vi.fn().mockResolvedValue([]),
				modelRegistry: { authStorage: { getApiKey } },
			},
			ui: { terminal: { columns: 100 } },
			present,
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);
		try {
			await controller.handleUsageCommand();

			expect(fetchSpy).toHaveBeenCalledWith("http://127.0.0.1:4000/v1/admin/status", {
				headers: { Accept: "application/json", Authorization: "Bearer managed-token" },
			});
			const firstCall = present.mock.calls[0];
			expect(firstCall).toBeDefined();
			const output = renderPresentedBlocks(firstCall?.[0]);
			expect(output).toContain("User: alice (admin #3)");
			expect(output).not.toContain("User ID: #3");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("does not enrich legacy usage totals with a mismatched admin-status principal", async () => {
		const present = vi.fn();
		const usageResponse = {
			usage: {
				userId: 3,
				since: 0,
				generatedAt: 1700000000000,
				totals: {
					requests: 1,
					inputTokens: 10,
					outputTokens: 20,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					totalTokens: 30,
					costUsd: 0.01,
				},
				byProviderModel: [],
			},
		};
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response(JSON.stringify(usageResponse), { status: 200 }))
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						status: {
							ok: true,
							version: "test",
							serverTime: 1700000000001,
							principal: { kind: "managed", userId: 4, name: "bob", role: "admin", tokenId: 9 },
							counts: { users: 2, activeTokens: 2, credentials: 0, pools: 0 },
						},
					}),
					{ status: 200 },
				),
			);
		const getApiKey = vi.fn().mockResolvedValue("managed-token");
		const ctx = {
			session: {
				model: {
					provider: "xllm-gateway",
					id: "anthropic/claude-sonnet-5",
					baseUrl: "http://127.0.0.1:4000",
					transport: "pi-native",
				},
				sessionId: "session-1",
				fetchUsageReports: vi.fn().mockResolvedValue([]),
				modelRegistry: { authStorage: { getApiKey } },
			},
			ui: { terminal: { columns: 100 } },
			present,
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);
		try {
			await controller.handleUsageCommand();

			const firstCall = present.mock.calls[0];
			expect(firstCall).toBeDefined();
			const output = renderPresentedBlocks(firstCall?.[0]);
			expect(output).toContain("User ID: #3");
			expect(output).not.toContain("bob");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("renders auth-gateway self usage alongside connected-account reports", async () => {
		const present = vi.fn();
		const fetchedAt = Date.now();
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					usage: {
						userId: 3,
						since: 0,
						generatedAt: fetchedAt,
						totals: {
							requests: 3,
							inputTokens: 24_804,
							outputTokens: 102,
							cacheReadTokens: 0,
							cacheWriteTokens: 40_434,
							totalTokens: 65_340,
							costUsd: 0.227159,
						},
						byProviderModel: [
							{
								provider: "openai-codex",
								model: "gpt-5.6-sol",
								requests: 2,
								totalTokens: 24_854,
								costUsd: 0.12557,
							},
						],
					},
					principal: {
						kind: "managed",
						userId: 3,
						name: "alice",
						role: "user",
						tokenId: 11,
					},
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);
		const getApiKey = vi.fn().mockResolvedValue("managed-token");
		const getOAuthAccountIdentity = vi.fn();
		const ctx = {
			session: {
				model: {
					provider: "xllm-gateway",
					id: "gpt-5.6-sol",
					baseUrl: "http://127.0.0.1:4000",
					transport: "pi-native",
				},
				sessionId: "session-1",
				getUsageReportingModelSelectors: () => [],
				fetchUsageReports: vi.fn().mockResolvedValue([
					{
						provider: "openai-codex",
						fetchedAt,
						limits: [
							{
								id: "codex-weekly",
								label: "Weekly",
								scope: { provider: "openai-codex", accountId: "acct-1" },
								window: { id: "weekly", label: "weekly" },
								amount: { used: 75, limit: 100, unit: "requests" },
								status: "ok",
							},
						],
						metadata: { email: "connected@example.com" },
					},
				] satisfies UsageReport[]),
				modelRegistry: {
					authStorage: { getApiKey, getOAuthAccountIdentity },
				},
			},
			ui: { terminal: { columns: 100 } },
			present,
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);
		try {
			await controller.handleUsageCommand();

			expect(fetchSpy).toHaveBeenCalledWith("http://127.0.0.1:4000/v1/usage", {
				headers: { Accept: "application/json", Authorization: "Bearer managed-token" },
			});
			expect(present).toHaveBeenCalledTimes(1);
			const firstCall = present.mock.calls[0];
			expect(firstCall).toBeDefined();
			const output = renderPresentedBlocks(firstCall?.[0]);
			expect(output).toContain("Openai Codex");
			expect(output).toContain("connected@example.com");
			expect(output).toContain("Weekly");
			expect(output).toContain("Gateway Usage");
			expect(output).toContain("User: alice (user #3)");
			expect(output).toContain("Requests: 3");
			expect(output).toContain("65,340 tokens");
			expect(output).toContain("openai-codex/gpt-5.6-sol");
			expect(ctx.showWarning).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("renders auth-gateway provider reports when the gateway token is admin-scoped", async () => {
		const present = vi.fn();
		const fetchedAt = Date.now();
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					generatedAt: fetchedAt,
					principal: { kind: "managed", userId: 3, name: "alice", role: "admin", tokenId: 9 },
					reports: [
						{
							provider: "openai-codex",
							fetchedAt,
							limits: [
								{
									id: "codex-weekly",
									label: "Weekly",
									scope: { provider: "openai-codex", accountId: "acct-1" },
									window: { id: "weekly", label: "weekly" },
									amount: { used: 75, limit: 100, unit: "requests" },
									status: "ok",
								},
							],
							metadata: { email: "admin@example.com" },
						},
					],
				}),
				{ status: 200, headers: { "Content-Type": "application/json" } },
			),
		);
		const getApiKey = vi.fn().mockResolvedValue("admin-token");
		const getOAuthAccountIdentity = vi.fn();
		const ctx = {
			session: {
				model: {
					provider: "xllm-gateway",
					id: "openai-codex/gpt-5.5",
					baseUrl: "http://127.0.0.1:4000",
					transport: "pi-native",
				},
				sessionId: "session-1",
				getUsageReportingModelSelectors: () => [],
				fetchUsageReports: vi.fn().mockResolvedValue([]),
				modelRegistry: {
					authStorage: { getApiKey, getOAuthAccountIdentity },
				},
			},
			ui: { terminal: { columns: 100 } },
			present,
			showWarning: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new CommandController(ctx);
		try {
			await controller.handleUsageCommand();

			expect(fetchSpy).toHaveBeenCalledWith("http://127.0.0.1:4000/v1/usage", {
				headers: { Accept: "application/json", Authorization: "Bearer admin-token" },
			});
			expect(present).toHaveBeenCalledTimes(1);
			const firstCall = present.mock.calls[0];
			expect(firstCall).toBeDefined();
			const output = renderPresentedBlocks(firstCall?.[0]);
			expect(output).toContain("Usage");
			expect(output).toContain("User: alice (admin #3)");
			expect(output).toContain("Openai Codex");
			expect(output).toContain("Weekly");
			expect(output).toContain("admin@example.com");
			expect(output).toContain("25% free");
			expect(ctx.showWarning).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});
});
