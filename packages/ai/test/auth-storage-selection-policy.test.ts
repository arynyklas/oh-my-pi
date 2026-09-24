import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, setSystemTime, test, vi } from "bun:test";
import {
	type AuthCredential,
	type AuthCredentialSelectionPolicy,
	AuthStorage,
	type CompletionProbe,
	SqliteAuthCredentialStore,
} from "@oh-my-pi/pi-ai/auth-storage";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { CredentialRankingStrategy, UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";
import { withEnv } from "./helpers";

const SOURCE = "auth-storage-selection-policy-test";
const CUSTOM_PROVIDER = "unit-selection-policy";
const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;

function farExpiry(): number {
	return Date.now() + HOUR_MS;
}

function oauthCredential(label: string, overrides?: Partial<OAuthCredentials>): AuthCredential {
	return {
		type: "oauth",
		access: `access-${label}`,
		refresh: `refresh-${label}`,
		expires: farExpiry(),
		accountId: `account-${label}`,
		email: `${label}@example.com`,
		...overrides,
	};
}

function apiKeyCredential(key: string, source?: "login"): AuthCredential {
	return source ? { type: "api_key", key, source } : { type: "api_key", key };
}

function policy(
	strategy: AuthCredentialSelectionPolicy["strategy"],
	eligibleCredentialIds: readonly number[],
	policyKey = `policy-${strategy}`,
): AuthCredentialSelectionPolicy {
	return { policyKey, eligibleCredentialIds, strategy };
}

function usageLimit(usedFraction: number, resetInMs: number): UsageLimit {
	return {
		id: "unit-selection-policy:primary",
		label: "Primary Window",
		scope: { provider: CUSTOM_PROVIDER, windowId: "1h", shared: true },
		window: { id: "1h", label: "1 Hour", durationMs: HOUR_MS, resetsAt: Date.now() + resetInMs },
		amount: {
			unit: "percent",
			used: usedFraction * 100,
			limit: 100,
			remaining: Math.max(0, 100 - usedFraction * 100),
			usedFraction,
			remainingFraction: Math.max(0, 1 - usedFraction),
		},
		status: usedFraction >= 1 ? "exhausted" : "ok",
	};
}

function usageReport(accountId: string, usedFraction: number): UsageReport {
	return {
		provider: CUSTOM_PROVIDER,
		fetchedAt: Date.now(),
		limits: [usageLimit(usedFraction, WEEK_MS)],
		metadata: { accountId, email: `${accountId}@example.com`, planType: "pro" },
	};
}

describe("AuthStorage credential selection policy", () => {
	let store: SqliteAuthCredentialStore;
	let storage: AuthStorage;
	const usageByAccount = new Map<string, UsageReport>();
	let fetchUsageOverride: UsageProvider["fetchUsage"] | undefined;
	const usageProvider: UsageProvider = {
		id: CUSTOM_PROVIDER,
		async fetchUsage(params, options) {
			if (fetchUsageOverride) return fetchUsageOverride(params, options);
			const accountId = params.credential.accountId;
			return accountId ? (usageByAccount.get(accountId) ?? null) : null;
		},
	};

	beforeEach(async () => {
		store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const rankingStrategy: CredentialRankingStrategy = {
			findWindowLimits(report) {
				return { primary: report.limits[0] };
			},
			windowDefaults: { primaryMs: HOUR_MS, secondaryMs: WEEK_MS },
		};
		storage = new AuthStorage(store, {
			usageProviderResolver: provider => (provider === CUSTOM_PROVIDER ? usageProvider : undefined),
			rankingStrategyResolver: provider => (provider === CUSTOM_PROVIDER ? rankingStrategy : undefined),
		});
		usageByAccount.clear();
		fetchUsageOverride = undefined;
		registerOAuthProvider({
			id: CUSTOM_PROVIDER,
			name: "Selection Policy Unit Provider",
			sourceId: SOURCE,
			async login() {
				return { access: "login", refresh: "login", expires: farExpiry() };
			},
			async refreshToken(credentials) {
				if (credentials.refresh === "refresh-invalid") {
					throw new Error("invalid_grant: refresh token revoked");
				}
				return credentials;
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});
	});

	afterEach(async () => {
		unregisterOAuthProviders(SOURCE);
		storage.close();
		store.close();
		usageByAccount.clear();
		fetchUsageOverride = undefined;
		vi.restoreAllMocks();
	});

	test("ordered allow-list limits OAuth and stored API-key selection and empty pools do not fall through", async () => {
		await storage.credentials.set(CUSTOM_PROVIDER, [
			oauthCredential("oauth-a"),
			oauthCredential("oauth-b"),
			apiKeyCredential("login-key", "login"),
			apiKeyCredential("static-key"),
		]);
		const rows = store.listAuthCredentials(CUSTOM_PROVIDER);
		const oauthA = rows[0]!.id;
		const oauthB = rows[1]!.id;
		const loginKey = rows[2]!.id;
		const staticKey = rows[3]!.id;

		await expect(
			storage.resolveApiKeySelection(CUSTOM_PROVIDER, "oauth-session", {
				selection: policy("failover", [oauthB, oauthA]),
			}),
		).resolves.toEqual({
			ok: true,
			credential: { apiKey: "access-oauth-b", credentialId: oauthB, credentialType: "oauth", source: "oauth" },
		});

		await expect(
			storage.resolveApiKeySelection(CUSTOM_PROVIDER, "login-session", {
				selection: policy("failover", [loginKey]),
			}),
		).resolves.toEqual({
			ok: true,
			credential: { apiKey: "login-key", credentialId: loginKey, credentialType: "api_key", source: "api_key" },
		});

		await expect(
			storage.resolveApiKeySelection(CUSTOM_PROVIDER, "static-session", {
				selection: policy("failover", [staticKey]),
			}),
		).resolves.toEqual({
			ok: true,
			credential: { apiKey: "static-key", credentialId: staticKey, credentialType: "api_key", source: "api_key" },
		});

		await withEnv({ OPENAI_API_KEY: "env-key" }, async () => {
			const emptyStore = new SqliteAuthCredentialStore(new Database(":memory:"));
			const emptyStorage = new AuthStorage(emptyStore);
			try {
				emptyStorage.keys.setRuntime("openai", "runtime-key");
				emptyStorage.keys.setConfig("openai", "config-key");
				await expect(
					emptyStorage.resolveApiKeySelection("openai", "empty", {
						selection: policy("failover", []),
					}),
				).resolves.toEqual({ ok: false, reason: "no_eligible_credential" });
			} finally {
				emptyStorage.close();
				emptyStore.close();
			}
		});
	});

	test("mixed eligible pools try API keys before reporting the pool exhausted", async () => {
		await storage.credentials.set(CUSTOM_PROVIDER, [
			oauthCredential("oauth-first"),
			apiKeyCredential("api-second", "login"),
		]);
		const [oauthRow, apiRow] = store.listAuthCredentials(CUSTOM_PROVIDER);
		if (!oauthRow || !apiRow) throw new Error("expected mixed rows");
		const mixed = policy("failover", [oauthRow.id, apiRow.id], "mixed-pool");

		await expect(
			storage.resolveApiKeySelection(CUSTOM_PROVIDER, "mixed", { selection: mixed }),
		).resolves.toMatchObject({
			ok: true,
			credential: { credentialId: oauthRow.id, credentialType: "oauth" },
		});
		await storage.limits.markReached(CUSTOM_PROVIDER, "mixed", { retryAfterMs: 30_000, selection: mixed });
		await expect(storage.resolveApiKeySelection(CUSTOM_PROVIDER, "mixed", { selection: mixed })).resolves.toEqual({
			ok: true,
			credential: { apiKey: "api-second", credentialId: apiRow.id, credentialType: "api_key", source: "api_key" },
		});
	});

	test("explicit mixed failover honors API-key-before-OAuth pool order", async () => {
		await storage.credentials.set(CUSTOM_PROVIDER, [
			oauthCredential("fallback"),
			apiKeyCredential("api-primary", "login"),
		]);
		const [oauthRow, apiRow] = store.listAuthCredentials(CUSTOM_PROVIDER);
		if (!oauthRow || !apiRow) throw new Error("expected mixed rows");

		await expect(
			storage.resolveApiKeySelection(CUSTOM_PROVIDER, "api-first", {
				selection: policy("failover", [apiRow.id, oauthRow.id], "api-before-oauth"),
			}),
		).resolves.toEqual({
			ok: true,
			credential: { apiKey: "api-primary", credentialId: apiRow.id, credentialType: "api_key", source: "api_key" },
		});
	});

	test("explicit mixed round-robin advances across credential types and keeps session stickiness", async () => {
		await storage.credentials.set(CUSTOM_PROVIDER, [
			oauthCredential("oauth-rr"),
			apiKeyCredential("api-rr", "login"),
		]);
		const [oauthRow, apiRow] = store.listAuthCredentials(CUSTOM_PROVIDER);
		if (!oauthRow || !apiRow) throw new Error("expected mixed rows");
		const mixed = policy("round-robin", [apiRow.id, oauthRow.id], "mixed-rr");

		const rrA = await storage.resolveApiKeySelection(CUSTOM_PROVIDER, "rr-a", { selection: mixed });
		const rrB = await storage.resolveApiKeySelection(CUSTOM_PROVIDER, "rr-b", { selection: mixed });
		const rrAAgain = await storage.resolveApiKeySelection(CUSTOM_PROVIDER, "rr-a", { selection: mixed });

		expect(rrA.ok && rrA.credential.credentialId).toBe(apiRow.id);
		expect(rrB.ok && rrB.credential.credentialId).toBe(oauthRow.id);
		expect(rrAAgain.ok && rrAAgain.credential.credentialId).toBe(apiRow.id);
	});

	test("explicit mixed usage-limit marks cross-type availability", async () => {
		await storage.credentials.set(CUSTOM_PROVIDER, [
			oauthCredential("oauth-limited"),
			apiKeyCredential("api-after-oauth", "login"),
		]);
		const [oauthRow, apiRow] = store.listAuthCredentials(CUSTOM_PROVIDER);
		if (!oauthRow || !apiRow) throw new Error("expected mixed rows");
		const mixed = policy("failover", [oauthRow.id, apiRow.id], "mixed-usage-limit");

		await expect(
			storage.resolveApiKeySelection(CUSTOM_PROVIDER, "mixed-limit", { selection: mixed }),
		).resolves.toMatchObject({
			ok: true,
			credential: { credentialId: oauthRow.id, credentialType: "oauth" },
		});
		await expect(
			storage.limits.markReached(CUSTOM_PROVIDER, "mixed-limit", {
				apiKey: "access-oauth-limited",
				selection: mixed,
			}),
		).resolves.toMatchObject({ switched: true });
		await expect(
			storage.resolveApiKeySelection(CUSTOM_PROVIDER, "mixed-limit", { selection: mixed }),
		).resolves.toEqual({
			ok: true,
			credential: {
				apiKey: "api-after-oauth",
				credentialId: apiRow.id,
				credentialType: "api_key",
				source: "api_key",
			},
		});
	});

	test("least-used keeps an eligible session and reranks only a new or replacement session", async () => {
		const now = Date.now();
		vi.useFakeTimers();
		setSystemTime(new Date(now));
		try {
			await storage.credentials.set(CUSTOM_PROVIDER, [
				oauthCredential("high", { accountId: "high" }),
				oauthCredential("low", { accountId: "low" }),
			]);
			const [highRow, lowRow] = store.listAuthCredentials(CUSTOM_PROVIDER);
			if (!highRow || !lowRow) throw new Error("expected oauth rows");
			usageByAccount.set("high", usageReport("high", 0.9));
			usageByAccount.set("low", usageReport("low", 0.1));
			const leastUsed = policy("least-used", [highRow.id, lowRow.id], "least-sticky");

			await expect(
				storage.resolveApiKeySelection(CUSTOM_PROVIDER, "least-a", { selection: leastUsed }),
			).resolves.toMatchObject({ ok: true, credential: { credentialId: lowRow.id } });

			usageByAccount.set("high", usageReport("high", 0.05));
			usageByAccount.set("low", usageReport("low", 0.95));
			setSystemTime(new Date(now + 7 * 60_000));

			await expect(
				storage.resolveApiKeySelection(CUSTOM_PROVIDER, "least-a", { selection: leastUsed }),
			).resolves.toMatchObject({ ok: true, credential: { credentialId: lowRow.id } });
			await expect(
				storage.resolveApiKeySelection(CUSTOM_PROVIDER, "least-b", { selection: leastUsed }),
			).resolves.toMatchObject({ ok: true, credential: { credentialId: highRow.id } });

			await storage.limits.markReached(CUSTOM_PROVIDER, "least-a", {
				retryAfterMs: 30_000,
				selection: leastUsed,
			});
			await expect(
				storage.resolveApiKeySelection(CUSTOM_PROVIDER, "least-a", { selection: leastUsed }),
			).resolves.toMatchObject({ ok: true, credential: { credentialId: highRow.id } });
		} finally {
			setSystemTime();
			vi.useRealTimers();
		}
	});

	test("least-used falls back to unified pool order when OAuth has no usage signal", async () => {
		fetchUsageOverride = async () => null;
		await storage.credentials.set(CUSTOM_PROVIDER, [
			oauthCredential("no-usage"),
			apiKeyCredential("api-no-usage", "login"),
		]);
		const [oauthRow, apiRow] = store.listAuthCredentials(CUSTOM_PROVIDER);
		if (!oauthRow || !apiRow) throw new Error("expected mixed rows");

		await expect(
			storage.resolveApiKeySelection(CUSTOM_PROVIDER, "least-api-first", {
				selection: policy("least-used", [apiRow.id, oauthRow.id], "least-no-usage-api"),
			}),
		).resolves.toEqual({
			ok: true,
			credential: { apiKey: "api-no-usage", credentialId: apiRow.id, credentialType: "api_key", source: "api_key" },
		});
		await expect(
			storage.resolveApiKeySelection(CUSTOM_PROVIDER, "least-oauth-first", {
				selection: policy("least-used", [oauthRow.id, apiRow.id], "least-no-usage-oauth"),
			}),
		).resolves.toMatchObject({ ok: true, credential: { credentialId: oauthRow.id, credentialType: "oauth" } });
	});

	test("usage-limit blocking follows credential ids across an awaited reload", async () => {
		const now = Date.now();
		vi.useFakeTimers();
		setSystemTime(new Date(now));
		try {
			await storage.credentials.set(CUSTOM_PROVIDER, [
				oauthCredential("stale-a", { accountId: "stale-a" }),
				oauthCredential("stale-b", { accountId: "stale-b" }),
			]);
			const [rowA, rowB] = store.listAuthCredentials(CUSTOM_PROVIDER);
			if (!rowA || !rowB) throw new Error("expected oauth rows");
			const selected = policy("failover", [rowA.id, rowB.id], "stable-id-usage-block");
			await expect(
				storage.resolveApiKeySelection(CUSTOM_PROVIDER, "stable-id", { selection: selected }),
			).resolves.toMatchObject({ ok: true, credential: { credentialId: rowA.id } });
			setSystemTime(new Date(now + 7 * 60_000));

			const usageStarted = Promise.withResolvers<void>();
			const releaseUsage = Promise.withResolvers<void>();
			fetchUsageOverride = async params => {
				if (params.credential.accountId === "stale-a") {
					usageStarted.resolve();
					await releaseUsage.promise;
					return usageReport("stale-a", 1);
				}
				return usageReport(params.credential.accountId ?? "unknown", 0);
			};

			const markPromise = storage.limits.markReached(CUSTOM_PROVIDER, "stable-id", {
				apiKey: "access-stale-a",
				selection: selected,
			});
			await usageStarted.promise;
			store.deleteAuthCredential(rowA.id, "simulated external deletion");
			await storage.credentials.reload();
			releaseUsage.resolve();
			await markPromise;

			expect(storage.blocks.list([rowB.id])).toEqual([]);
			await expect(
				storage.resolveApiKeySelection(CUSTOM_PROVIDER, "stable-id-replacement", {
					selection: policy("failover", [rowB.id], "stable-id-replacement"),
				}),
			).resolves.toMatchObject({ ok: true, credential: { credentialId: rowB.id } });
		} finally {
			setSystemTime();
			vi.useRealTimers();
		}
	});

	test("OAuth access helpers honor selection policy credential ids", async () => {
		await storage.credentials.set(CUSTOM_PROVIDER, [oauthCredential("oauth-a"), oauthCredential("oauth-b")]);
		const [firstRow, secondRow] = store.listAuthCredentials(CUSTOM_PROVIDER);
		if (!firstRow || !secondRow) throw new Error("expected oauth rows");
		const selected = policy("failover", [secondRow.id], "oauth-helper-pool");

		const accesses = await storage.oauth.accessAll(CUSTOM_PROVIDER, { selection: selected });
		expect(accesses.map(access => access.credentialId)).toEqual([secondRow.id]);
		await expect(storage.oauth.accessAt(CUSTOM_PROVIDER, 0, { selection: selected })).resolves.toMatchObject({
			ok: true,
			credentialId: secondRow.id,
			accessToken: "access-oauth-b",
		});
		await expect(storage.oauth.accessAt(CUSTOM_PROVIDER, 1, { selection: selected })).resolves.toBeUndefined();
	});

	test("omitting policy preserves legacy precedence and session stickiness", async () => {
		await storage.credentials.set(CUSTOM_PROVIDER, [oauthCredential("one"), oauthCredential("two")]);
		storage.keys.setRuntime(CUSTOM_PROVIDER, "runtime-key");
		expect(await storage.getApiKey(CUSTOM_PROVIDER, "legacy-runtime")).toBe("runtime-key");
		storage.keys.removeRuntime(CUSTOM_PROVIDER);

		const first = await storage.getApiKey(CUSTOM_PROVIDER, "legacy-sticky");
		const second = await storage.getApiKey(CUSTOM_PROVIDER, "legacy-sticky");
		expect(first).toMatch(/^access-(one|two)$/);
		expect(second).toBe(first);
	});

	test("omitting policy stops at unresolved stored login API keys before env", async () => {
		await withEnv({ OPENAI_API_KEY: "env-key" }, async () => {
			const unresolvedStore = new SqliteAuthCredentialStore(new Database(":memory:"));
			const unresolvedStorage = new AuthStorage(unresolvedStore, { configValueResolver: async () => undefined });
			try {
				await unresolvedStorage.credentials.set("openai", [apiKeyCredential("missing-secret", "login")]);
				await expect(unresolvedStorage.resolveApiKeySelection("openai", "legacy")).resolves.toEqual({
					ok: false,
					reason: "no_credential",
				});
				await expect(unresolvedStorage.getApiKey("openai", "legacy")).resolves.toBeUndefined();
			} finally {
				unresolvedStorage.close();
				unresolvedStore.close();
			}
		});
	});

	test("sticky-session, round-robin, least-used, and failover apply strategy semantics within eligible rows", async () => {
		await storage.credentials.set(CUSTOM_PROVIDER, [
			oauthCredential("low", { accountId: "low" }),
			oauthCredential("high", { accountId: "high" }),
			oauthCredential("outside", { accountId: "outside" }),
		]);
		const [lowRow, highRow, outsideRow] = store.listAuthCredentials(CUSTOM_PROVIDER);
		if (!lowRow || !highRow || !outsideRow) throw new Error("expected seeded rows");
		usageByAccount.set("low", usageReport("low", 0.1));
		usageByAccount.set("high", usageReport("high", 0.9));
		usageByAccount.set("outside", usageReport("outside", 0));

		const sticky = policy("sticky-session", [highRow.id, lowRow.id], "sticky-pool");
		const stickyFirst = await storage.resolveApiKeySelection(CUSTOM_PROVIDER, "sticky", { selection: sticky });
		expect(stickyFirst.ok && stickyFirst.credential.credentialId).toBeOneOf([highRow.id, lowRow.id]);
		await expect(storage.resolveApiKeySelection(CUSTOM_PROVIDER, "sticky", { selection: sticky })).resolves.toEqual(
			stickyFirst,
		);

		const rr = policy("round-robin", [highRow.id, lowRow.id], "rr-pool");
		const rrA = await storage.resolveApiKeySelection(CUSTOM_PROVIDER, "rr-a", { selection: rr });
		const rrB = await storage.resolveApiKeySelection(CUSTOM_PROVIDER, "rr-b", { selection: rr });
		expect(rrA.ok && rrA.credential.credentialId).toBe(highRow.id);
		expect(rrB.ok && rrB.credential.credentialId).toBe(lowRow.id);
		await expect(storage.resolveApiKeySelection(CUSTOM_PROVIDER, "rr-a", { selection: rr })).resolves.toEqual(rrA);

		const leastUsed = await storage.resolveApiKeySelection(CUSTOM_PROVIDER, "least-used", {
			selection: policy("least-used", [highRow.id, lowRow.id], "least-pool"),
		});
		expect(leastUsed.ok && leastUsed.credential.credentialId).toBe(lowRow.id);

		const failover = policy("failover", [highRow.id, lowRow.id], "failover-pool");
		const failoverFirst = await storage.resolveApiKeySelection(CUSTOM_PROVIDER, "failover", { selection: failover });
		expect(failoverFirst.ok && failoverFirst.credential.credentialId).toBe(highRow.id);
		const mark = await storage.limits.markReached(CUSTOM_PROVIDER, "failover", {
			retryAfterMs: 30_000,
			selection: failover,
		});
		expect(mark.switched).toBe(true);
		const failoverSecond = await storage.resolveApiKeySelection(CUSTOM_PROVIDER, "failover", { selection: failover });
		expect(failoverSecond.ok && failoverSecond.credential.credentialId).toBe(lowRow.id);
	});

	test("failover returns to the first configured stored API key after an earlier member unblocks", async () => {
		const now = Date.now();
		vi.useFakeTimers();
		setSystemTime(new Date(now));
		try {
			await storage.credentials.set(CUSTOM_PROVIDER, [
				apiKeyCredential("api-a", "login"),
				apiKeyCredential("api-b", "login"),
			]);
			const [firstRow, secondRow] = store.listAuthCredentials(CUSTOM_PROVIDER);
			if (!firstRow || !secondRow) throw new Error("expected seeded API-key rows");
			const failover = policy("failover", [firstRow.id, secondRow.id], "api-key-failover-pool");

			await expect(
				storage.resolveApiKeySelection(CUSTOM_PROVIDER, "api-failover", { selection: failover }),
			).resolves.toMatchObject({ ok: true, credential: { credentialId: firstRow.id, apiKey: "api-a" } });
			await expect(
				storage.limits.markReached(CUSTOM_PROVIDER, "api-failover", {
					retryAfterMs: 1_000,
					selection: failover,
				}),
			).resolves.toMatchObject({ switched: true });
			await expect(
				storage.resolveApiKeySelection(CUSTOM_PROVIDER, "api-failover", { selection: failover }),
			).resolves.toMatchObject({ ok: true, credential: { credentialId: secondRow.id, apiKey: "api-b" } });

			setSystemTime(new Date(now + 1_001));

			await expect(
				storage.resolveApiKeySelection(CUSTOM_PROVIDER, "api-failover", { selection: failover }),
			).resolves.toMatchObject({ ok: true, credential: { credentialId: firstRow.id, apiKey: "api-a" } });
		} finally {
			setSystemTime();
			vi.useRealTimers();
		}
	});

	test("in-memory stickies keep the recorded credential id after reload reindexes rows", async () => {
		await storage.credentials.set(CUSTOM_PROVIDER, [
			apiKeyCredential("api-a", "login"),
			apiKeyCredential("api-b", "login"),
			apiKeyCredential("api-c", "login"),
		]);
		const [firstRow, secondRow, thirdRow] = store.listAuthCredentials(CUSTOM_PROVIDER);
		if (!firstRow || !secondRow || !thirdRow) throw new Error("expected seeded API-key rows");
		const rr = policy("round-robin", [firstRow.id, secondRow.id, thirdRow.id], "rr-reindex-pool");

		await expect(
			storage.resolveApiKeySelection(CUSTOM_PROVIDER, "rr-reindex", { selection: rr }),
		).resolves.toMatchObject({
			ok: true,
			credential: { credentialId: firstRow.id, apiKey: "api-a" },
		});
		await storage.limits.markReached(CUSTOM_PROVIDER, "rr-reindex", { retryAfterMs: 30_000, selection: rr });
		await expect(
			storage.resolveApiKeySelection(CUSTOM_PROVIDER, "rr-reindex", { selection: rr }),
		).resolves.toMatchObject({
			ok: true,
			credential: { credentialId: secondRow.id, apiKey: "api-b" },
		});

		store.deleteAuthCredential(firstRow.id, "simulated external deletion");
		await storage.credentials.reload();

		await expect(
			storage.resolveApiKeySelection(CUSTOM_PROVIDER, "rr-reindex", { selection: rr }),
		).resolves.toMatchObject({
			ok: true,
			credential: { credentialId: secondRow.id, apiKey: "api-b" },
		});
	});

	test("blocked and invalid selected credentials fail over only within the eligible pool", async () => {
		await storage.credentials.set(CUSTOM_PROVIDER, [
			oauthCredential("first"),
			oauthCredential("second"),
			oauthCredential("outside"),
		]);
		const [firstRow, secondRow, outsideRow] = store.listAuthCredentials(CUSTOM_PROVIDER);
		if (!firstRow || !secondRow || !outsideRow) throw new Error("expected seeded rows");
		const failover = policy("failover", [firstRow.id, secondRow.id], "blocked-pool");

		await expect(
			storage.resolveApiKeySelection(CUSTOM_PROVIDER, "blocked", { selection: failover }),
		).resolves.toMatchObject({
			ok: true,
			credential: { credentialId: firstRow.id },
		});
		await storage.limits.markReached(CUSTOM_PROVIDER, "blocked", { retryAfterMs: 30_000, selection: failover });
		await expect(
			storage.resolveApiKeySelection(CUSTOM_PROVIDER, "blocked", { selection: failover }),
		).resolves.toMatchObject({
			ok: true,
			credential: { credentialId: secondRow.id },
		});
		const blockedBefore = Date.now();
		const finalMark = await storage.limits.markReached(CUSTOM_PROVIDER, "blocked", {
			retryAfterMs: 45_000,
			selection: failover,
		});
		expect(finalMark.switched).toBe(false);
		const allBlocked = await storage.resolveApiKeySelection(CUSTOM_PROVIDER, "blocked", { selection: failover });
		expect(allBlocked.ok).toBe(false);
		if (allBlocked.ok) throw new Error("expected all eligible blocked");
		expect(allBlocked.reason).toBe("all_eligible_blocked");
		expect(allBlocked.retryAtMs).toBeGreaterThanOrEqual(blockedBefore + 30_000 - 5);
		expect(allBlocked.retryAtMs).toBeLessThan(Date.now() + 46_000);
		expect(
			await storage.getApiKey(CUSTOM_PROVIDER, "outside-ok", { selection: policy("failover", [outsideRow.id]) }),
		).toBe("access-outside");

		await storage.credentials.set(CUSTOM_PROVIDER, [
			oauthCredential("invalid", { refresh: "refresh-invalid", expires: Date.now() - HOUR_MS }),
			oauthCredential("valid"),
			oauthCredential("invalid-outside"),
		]);
		const [invalidRow, validRow] = store.listAuthCredentials(CUSTOM_PROVIDER);
		if (!invalidRow || !validRow) throw new Error("expected invalid rows");
		await expect(
			storage.resolveApiKeySelection(CUSTOM_PROVIDER, "invalid", {
				selection: policy("failover", [invalidRow.id, validRow.id], "invalid-pool"),
			}),
		).resolves.toMatchObject({ ok: true, credential: { credentialId: validRow.id, apiKey: "access-valid" } });
	});

	test("checkCredentials only probes credential ids requested by the caller", async () => {
		await storage.credentials.set(CUSTOM_PROVIDER, [
			oauthCredential("check-a"),
			apiKeyCredential("check-b"),
			oauthCredential("check-c"),
		]);
		const rows = store.listAuthCredentials(CUSTOM_PROVIDER);
		const target = rows[1]!;
		const probed: number[] = [];
		const completionProbe: CompletionProbe = async input => {
			probed.push(input.credentialId);
			return { ok: true };
		};

		const results = await storage.health.check({ credentialIds: [target.id], completionProbe });
		expect(results.map(result => result.id)).toEqual([target.id]);
		expect(probed).toEqual([target.id]);
		expect(results[0]?.completion).toEqual({ ok: true });
	});
});
