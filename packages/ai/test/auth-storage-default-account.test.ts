import { Database } from "bun:sqlite";
import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { type AuthCredential, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { CredentialRankingStrategy, UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";

const SOURCE = "auth-storage-default-account-test";
const PROVIDER = "unit-default-account";
const HOUR_MS = 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * HOUR_MS;

function oauthCredential(label: string, overrides?: Partial<OAuthCredentials>): AuthCredential {
	return {
		type: "oauth",
		access: `access-${label}`,
		refresh: `refresh-${label}`,
		expires: Date.now() + HOUR_MS,
		accountId: `account-${label}`,
		email: `${label}@example.com`,
		...overrides,
	};
}

function apiKeyCredential(key: string): AuthCredential {
	return { type: "api_key", key };
}

function usageReport(accountId: string, usedFraction: number): UsageReport {
	const limit: UsageLimit = {
		id: `${PROVIDER}:primary`,
		label: "Primary Window",
		scope: { provider: PROVIDER, windowId: "1h", shared: true },
		window: { id: "1h", label: "1 Hour", durationMs: HOUR_MS, resetsAt: Date.now() + WEEK_MS },
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
	return {
		provider: PROVIDER,
		fetchedAt: Date.now(),
		limits: [limit],
		metadata: { accountId, email: `${accountId}@example.com`, planType: "pro" },
	};
}

const cleanups: Array<() => void> = [];

function createStorage(
	opts: {
		withStrategy?: boolean;
		defaultAccounts?: Record<string, string>;
		usageByAccount?: Map<string, UsageReport>;
	} = {},
): { store: SqliteAuthCredentialStore; storage: AuthStorage } {
	const store = new SqliteAuthCredentialStore(new Database(":memory:"));
	const usageByAccount = opts.usageByAccount ?? new Map<string, UsageReport>();
	const usageProvider: UsageProvider = {
		id: PROVIDER,
		async fetchUsage(params) {
			const accountId = params.credential.accountId;
			return accountId ? (usageByAccount.get(accountId) ?? null) : null;
		},
	};
	const rankingStrategy: CredentialRankingStrategy = {
		findWindowLimits(report) {
			return { primary: report.limits[0] };
		},
		windowDefaults: { primaryMs: HOUR_MS, secondaryMs: WEEK_MS },
	};
	const storage = new AuthStorage(store, {
		usageProviderResolver: provider => (opts.withStrategy && provider === PROVIDER ? usageProvider : undefined),
		rankingStrategyResolver: provider => (opts.withStrategy && provider === PROVIDER ? rankingStrategy : undefined),
		defaultAccounts: opts.defaultAccounts,
	});
	cleanups.push(() => {
		storage.close();
		store.close();
	});
	return { store, storage };
}

async function resolvedCredentialId(storage: AuthStorage, sessionId: string): Promise<number | undefined> {
	const result = await storage.resolveApiKeySelection(PROVIDER, sessionId);
	return result.ok ? result.credential.credentialId : undefined;
}

describe("AuthStorage providers.defaultAccount", () => {
	afterEach(() => {
		for (const dispose of cleanups.splice(0)) dispose();
		unregisterOAuthProviders(SOURCE);
		setSystemTime();
	});

	function registerProvider(): void {
		registerOAuthProvider({
			id: PROVIDER,
			name: "Default Account Unit Provider",
			sourceId: SOURCE,
			async login() {
				return { access: "login", refresh: "login", expires: Date.now() + HOUR_MS };
			},
			async refreshToken(credentials) {
				return credentials;
			},
			getApiKey(credentials) {
				return credentials.access;
			},
		});
	}

	test("configured default pins every session; unset spreads load across accounts", async () => {
		registerProvider();
		// Baseline: no default configured — distinct sessions spread across both accounts.
		{
			const { storage } = createStorage();
			await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
			const seen = new Set<number>();
			for (let i = 0; i < 20; i++) {
				const id = await resolvedCredentialId(storage, `spread-${i}`);
				if (id !== undefined) seen.add(id);
			}
			expect(seen.size).toBe(2);
		}
		// With default = b@example.com — every distinct session resolves to B.
		{
			const { store, storage } = createStorage({ defaultAccounts: { [PROVIDER]: "b@example.com" } });
			await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
			const bId = store.listAuthCredentials(PROVIDER)[1]!.id;
			for (let i = 0; i < 20; i++) {
				expect(await resolvedCredentialId(storage, `pin-${i}`)).toBe(bId);
			}
		}
	});

	test("default suppresses live-usage ranking that would otherwise prefer the lighter sibling", async () => {
		registerProvider();
		const usageByAccount = new Map<string, UsageReport>([
			["account-a", usageReport("account-a", 0.1)],
			["account-b", usageReport("account-b", 0.9)],
		]);
		// Without a default, ranking drains toward the lighter account A.
		{
			const { store, storage } = createStorage({ withStrategy: true, usageByAccount });
			await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
			const aId = store.listAuthCredentials(PROVIDER)[0]!.id;
			expect(await resolvedCredentialId(storage, "rank")).toBe(aId);
		}
		// With default = the heavier account B, ranking is suppressed and B still wins.
		{
			const { store, storage } = createStorage({
				withStrategy: true,
				usageByAccount,
				defaultAccounts: { [PROVIDER]: "b@example.com" },
			});
			await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
			const bId = store.listAuthCredentials(PROVIDER)[1]!.id;
			expect(await resolvedCredentialId(storage, "rank-default")).toBe(bId);
		}
	});

	test("blocked default falls over to a sibling and reports the fallover exactly once", async () => {
		registerProvider();
		const { store, storage } = createStorage({ defaultAccounts: { [PROVIDER]: "a@example.com" } });
		await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const rows = store.listAuthCredentials(PROVIDER);
		const aId = rows[0]!.id;
		const bId = rows[1]!.id;
		const session = "fallover";

		expect(await resolvedCredentialId(storage, session)).toBe(aId);
		expect(storage.consumeDefaultAccountFallover(PROVIDER, session)).toBeUndefined();

		await storage.markUsageLimitReached(PROVIDER, session, { credentialId: aId, retryAfterMs: HOUR_MS });
		expect(await resolvedCredentialId(storage, session)).toBe(bId);

		const fallover = storage.consumeDefaultAccountFallover(PROVIDER, session);
		expect(fallover?.defaultCredentialId).toBe(aId);
		expect(fallover?.usedCredentialId).toBe(bId);
		// Drained once.
		expect(storage.consumeDefaultAccountFallover(PROVIDER, session)).toBeUndefined();
	});

	test("session stays on the sibling after fallover; a fresh session returns to the default", async () => {
		registerProvider();
		setSystemTime(new Date("2025-01-01T00:00:00Z"));
		const { store, storage } = createStorage({ defaultAccounts: { [PROVIDER]: "a@example.com" } });
		await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const rows = store.listAuthCredentials(PROVIDER);
		const aId = rows[0]!.id;
		const bId = rows[1]!.id;
		const session = "sticky";

		expect(await resolvedCredentialId(storage, session)).toBe(aId);
		await storage.markUsageLimitReached(PROVIDER, session, { credentialId: aId, retryAfterMs: 60_000 });
		expect(await resolvedCredentialId(storage, session)).toBe(bId);

		// Advance past the default's block: the same session still stays on the sibling.
		setSystemTime(new Date("2025-01-01T00:05:00Z"));
		expect(await resolvedCredentialId(storage, session)).toBe(bId);
		// A brand-new session routes back to the (now-unblocked) default.
		expect(await resolvedCredentialId(storage, "fresh")).toBe(aId);
	});

	test("ambiguous or unmatched selector behaves exactly like no default", async () => {
		registerProvider();
		// Two accounts share the matched email → ambiguous → no pin.
		{
			const { storage } = createStorage({ defaultAccounts: { [PROVIDER]: "dup@example.com" } });
			await storage.set(PROVIDER, [
				oauthCredential("a", { email: "dup@example.com" }),
				oauthCredential("b", { email: "dup@example.com" }),
			]);
			const seen = new Set<number>();
			for (let i = 0; i < 20; i++) {
				const id = await resolvedCredentialId(storage, `amb-${i}`);
				if (id !== undefined) seen.add(id);
			}
			expect(seen.size).toBe(2);
			expect(storage.getDefaultAccountCredentialId(PROVIDER)).toBeUndefined();
		}
		// Selector matches nothing → no pin, but the raw selector is still reported.
		{
			const { storage } = createStorage({ defaultAccounts: { [PROVIDER]: "nobody@example.com" } });
			await storage.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
			const seen = new Set<number>();
			for (let i = 0; i < 20; i++) {
				const id = await resolvedCredentialId(storage, `miss-${i}`);
				if (id !== undefined) seen.add(id);
			}
			expect(seen.size).toBe(2);
			expect(storage.getDefaultAccountSelector(PROVIDER)).toBe("nobody@example.com");
			expect(storage.getDefaultAccountCredentialId(PROVIDER)).toBeUndefined();
		}
	});

	test("api_key rows pin by #<id> and fall over when the default is blocked", async () => {
		registerProvider();
		const { store, storage } = createStorage();
		await storage.set(PROVIDER, [apiKeyCredential("key-a"), apiKeyCredential("key-b")]);
		const rows = store.listAuthCredentials(PROVIDER);
		const aId = rows[0]!.id;
		const bId = rows[1]!.id;
		storage.setDefaultAccountSelector(PROVIDER, `#${aId}`);
		const session = "api-key";

		expect(await resolvedCredentialId(storage, session)).toBe(aId);
		await storage.markUsageLimitReached(PROVIDER, session, { credentialId: aId, retryAfterMs: HOUR_MS });
		expect(await resolvedCredentialId(storage, session)).toBe(bId);
		expect(storage.consumeDefaultAccountFallover(PROVIDER, session)?.usedCredentialId).toBe(bId);
	});
});
