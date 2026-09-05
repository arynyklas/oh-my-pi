import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { claudeUsageProvider } from "@oh-my-pi/pi-ai/usage/claude";

const PROVIDER = "anthropic";
const PROVIDER_KEY = "anthropic:oauth";
const EMAIL = "recovered@example.com";
const HOUR_MS = 60 * 60_000;

function limit(windowId: "5h" | "7d", usedFraction: number, tier?: string): UsageLimit {
	return {
		id: `anthropic:${windowId}${tier ? `:${tier}` : ""}`,
		label: tier ?? windowId,
		scope: { provider: PROVIDER, windowId, ...(tier ? { tier } : { shared: true }) },
		window: { id: windowId, label: windowId, resetsAt: Date.now() + 40 * HOUR_MS },
		amount: { unit: "percent", usedFraction },
		status: usedFraction >= 1 ? "exhausted" : "ok",
	};
}

function healthyReport(): UsageReport {
	return {
		provider: PROVIDER,
		fetchedAt: Date.now(),
		metadata: { email: EMAIL, accountId: EMAIL },
		limits: [limit("5h", 0), limit("7d", 0.02), limit("7d", 0, "fable")],
	};
}

describe("Claude stale quota block recovery", () => {
	let db: Database;
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;
	let credentialId: number;
	let report: UsageReport | null;
	let deadline: number;
	const usageProvider: UsageProvider = {
		id: PROVIDER,
		async fetchUsage(params) {
			return params.credential.email === EMAIL
				? report
				: { ...healthyReport(), metadata: { email: "sibling@example.com" } };
		},
	};

	beforeEach(async () => {
		db = new Database(":memory:");
		store = new SqliteAuthCredentialStore(db);
		storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === PROVIDER ? usageProvider : undefined),
			defaultAccounts: { [PROVIDER]: EMAIL },
		});
		await storage.set(
			PROVIDER,
			[EMAIL, "sibling@example.com"].map(email => ({
				type: "oauth" as const,
				access: `access-${email}`,
				refresh: `refresh-${email}`,
				expires: Date.now() + HOUR_MS,
				accountId: email,
				email,
			})),
		);
		credentialId = store.listAuthCredentials(PROVIDER)[0]!.id;
		report = healthyReport();
		deadline = Date.now() + 39 * HOUR_MS;
	});

	afterEach(() => {
		vi.restoreAllMocks();
		storage.close();
		store.close();
	});

	function block(scope = "", ageMs = 10 * 60_000): void {
		db.query(
			"INSERT INTO auth_credential_blocks (credential_id, provider_key, block_scope, blocked_until_ms, updated_at) VALUES (?, ?, ?, ?, ?)",
		).run(credentialId, PROVIDER_KEY, scope, deadline, Math.floor((Date.now() - ageMs) / 1000));
	}

	test("usage refresh clears a stale persisted block and restores the default account", async () => {
		block();
		await storage.fetchUsageReports();
		expect(store.getCredentialBlock(credentialId, PROVIDER_KEY, "")).toBeUndefined();
		expect(await storage.getApiKey(PROVIDER, "after-usage", { modelId: "claude-opus-4-8" })).toBe(`access-${EMAIL}`);
		expect(storage.consumeDefaultAccountFallover(PROVIDER, "after-usage")).toBeUndefined();
	});

	test("selection rechecks a stale default without requiring the user to open usage", async () => {
		block();
		expect(await storage.getApiKey(PROVIDER, "fresh-session", { modelId: "claude-opus-4-8" })).toBe(
			`access-${EMAIL}`,
		);
		expect(store.getCredentialBlock(credentialId, PROVIDER_KEY, "")).toBeUndefined();
	});

	test("model usage health rechecks a recovered account instead of reporting depleted", async () => {
		block();
		const health = await storage.getModelUsageHealth(PROVIDER, {
			modelId: "claude-fable-5",
			reserveFraction: 0.1,
		});
		expect(health.accounts.find(account => account.credentialId === credentialId)?.state).toBe("healthy");
	});

	test("cancelling a blocked default does not wait for its shared usage probe", async () => {
		block();
		const entered = Promise.withResolvers<void>();
		const response = Promise.withResolvers<UsageReport | null>();
		vi.spyOn(usageProvider, "fetchUsage").mockImplementation(async () => {
			entered.resolve();
			return response.promise;
		});
		const controller = new AbortController();
		const pending = storage.getApiKey(PROVIDER, "cancelled-probe", { signal: controller.signal }).then(
			() => "selected",
			() => "aborted",
		);
		try {
			await entered.promise;
			controller.abort();
			expect(await Promise.race([pending, scheduler.yield().then(() => "still waiting")])).toBe("aborted");
		} finally {
			response.resolve(report);
			await pending;
			await storage.fetchUsageReports();
		}
	});

	test("a sibling removed during a healing probe cannot replace the default by index", async () => {
		const rows = store.listAuthCredentials(PROVIDER);
		await storage.remove(PROVIDER);
		await storage.set(PROVIDER, [
			rows[1]!.credential,
			rows[0]!.credential,
			{
				...rows[1]!.credential,
				type: "oauth",
				access: "access-third",
				refresh: "refresh-third",
				expires: Date.now() + HOUR_MS,
				email: "third@example.com",
				accountId: "third@example.com",
			},
		]);
		const reordered = store.listAuthCredentials(PROVIDER);
		credentialId = reordered.find(row => row.credential.type === "oauth" && row.credential.email === EMAIL)!.id;
		block();
		const entered = Promise.withResolvers<void>();
		const response = Promise.withResolvers<UsageReport | null>();
		vi.spyOn(usageProvider, "fetchUsage").mockImplementation(async () => {
			entered.resolve();
			return response.promise;
		});
		const pending = storage.getApiKey(PROVIDER, "reindexed-probe", { modelId: "claude-fable-5" });
		await entered.promise;
		await storage.removeCredential(PROVIDER, reordered[0]!.id);
		response.resolve(report);
		expect(await pending).toBe(`access-${EMAIL}`);
	});

	test("a recovered tier does not clear a different exhausted tier", async () => {
		block("tier:fable");
		block("tier:mythos");
		report!.limits.push(limit("7d", 1, "mythos"));
		await storage.fetchUsageReports();
		expect(store.getCredentialBlock(credentialId, PROVIDER_KEY, "tier:fable")).toBeUndefined();
		expect(store.getCredentialBlock(credentialId, PROVIDER_KEY, "tier:mythos")).toBe(deadline);
		expect(await storage.getApiKey(PROVIDER, "fable-recovered", { modelId: "claude-fable-5" })).toBe(
			`access-${EMAIL}`,
		);
		expect(await storage.getApiKey(PROVIDER, "mythos-blocked", { modelId: "claude-mythos-5" })).toBe(
			"access-sibling@example.com",
		);
	});

	test("a healthy tier cannot clear a block while the shared weekly limit is exhausted", async () => {
		block("tier:fable");
		report!.limits[1] = limit("7d", 1);
		await storage.fetchUsageReports();
		expect(store.getCredentialBlock(credentialId, PROVIDER_KEY, "tier:fable")).toBe(deadline);
	});

	test("a recent rate-limit block survives a lagging healthy report", async () => {
		block("", 0);
		await storage.fetchUsageReports();
		expect(store.getCredentialBlock(credentialId, PROVIDER_KEY, "")).toBe(deadline);
	});

	test.each(["exhausted", "uncapped"])(
		"display-only extra usage does not prevent model quota recovery: %s",
		async extraUsage => {
			block();
			report = await claudeUsageProvider.fetchUsage(
				{
					provider: PROVIDER,
					credential: { type: "oauth", accessToken: "test-access", email: EMAIL, accountId: EMAIL },
				},
				{
					fetch: async () =>
						Response.json({
							five_hour: { utilization: 0 },
							seven_day: { utilization: 2 },
							extra_usage: {
								is_enabled: true,
								used_credits: 10000,
								monthly_limit: extraUsage === "exhausted" ? 10000 : null,
								decimal_places: 2,
								currency: "USD",
							},
						}),
				},
			);
			await storage.fetchUsageReports();
			expect(store.getCredentialBlock(credentialId, PROVIDER_KEY, "")).toBeUndefined();
			expect(await storage.getApiKey(PROVIDER, `extra-${extraUsage}`, { modelId: "claude-fable-5" })).toBe(
				`access-${EMAIL}`,
			);
		},
	);

	test.each(["unknown scoped counter", "negative shared utilization"])(
		"malformed endpoint counters cannot authorize global recovery: %s",
		async reason => {
			block();
			report = await claudeUsageProvider.fetchUsage(
				{
					provider: PROVIDER,
					credential: { type: "oauth", accessToken: "test-access", email: EMAIL, accountId: EMAIL },
				},
				{
					fetch: async () =>
						Response.json({
							five_hour: { utilization: reason === "negative shared utilization" ? -1 : 0 },
							seven_day: { utilization: 2 },
							limits: [
								{
									kind: "weekly_scoped",
									percent: reason === "unknown scoped counter" ? null : 0,
									scope: { model: { display_name: "Fable" } },
								},
							],
						}),
				},
			);
			await storage.fetchUsageReports();
			expect(store.getCredentialBlock(credentialId, PROVIDER_KEY, "")).toBe(deadline);
		},
	);

	test.each(["missing weekly", "unknown weekly", "missing tier", "headers only", "failed fetch"])(
		"incomplete quota evidence preserves the block: %s",
		async reason => {
			block("tier:fable");
			if (reason === "missing weekly") report!.limits.splice(1, 1);
			if (reason === "unknown weekly") {
				report!.limits[1]!.amount = { unit: "percent" };
				report!.limits[1]!.status = "unknown";
			}
			if (reason === "missing tier") report!.limits.pop();
			if (reason === "headers only") report!.metadata!.source = "ratelimit-headers";
			if (reason === "failed fetch") report = null;
			await storage.fetchUsageReports();
			expect(store.getCredentialBlock(credentialId, PROVIDER_KEY, "tier:fable")).toBe(deadline);
		},
	);
});
