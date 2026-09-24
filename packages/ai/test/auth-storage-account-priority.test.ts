import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { type AuthCredential, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { UsageLimit, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai/usage";

const SOURCE = "auth-storage-account-priority-test";
/** Real provider id: plan-gated model routing and the Codex ranking strategy are provider-keyed. */
const PROVIDER = "openai-codex";
/** `plan-requirement provider="openai-codex" tier="paid"` in the catalog rules. */
const PLAN_GATED_MODEL = "gpt-5.6-sol";
const PLAN_FREE_MODEL = "gpt-5.3-codex";
const HOUR_MS = 60 * 60 * 1000;

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

/** Codex-shaped usage: a 5h window plus the paid plan type the plan filter reads. */
function usageReport(accountId: string, usedFraction: number): UsageReport {
	const limit: UsageLimit = {
		id: `${PROVIDER}:primary`,
		label: "5h",
		scope: { provider: PROVIDER, windowId: "5h", shared: true },
		window: { id: "5h", label: "5 Hour", durationMs: 5 * HOUR_MS, resetsAt: Date.now() + 4 * HOUR_MS },
		amount: {
			unit: "percent",
			used: usedFraction * 100,
			limit: 100,
			remaining: Math.max(0, 100 - usedFraction * 100),
			usedFraction,
			remainingFraction: Math.max(0, 1 - usedFraction),
		},
		status: "ok",
	};
	return {
		provider: PROVIDER,
		fetchedAt: Date.now(),
		limits: [limit],
		metadata: { accountId, email: `${accountId}@example.com`, planType: "chatgpt_pro" },
	};
}

const cleanups: Array<() => void> = [];

function createStorage(
	opts: {
		defaultAccounts?: Record<string, string>;
		accountPriorities?: Record<string, string[]>;
		/** accountId -> usage; omitted accounts report no usage. */
		usageByAccount?: Map<string, UsageReport>;
	} = {},
): { store: SqliteAuthCredentialStore; storage: AuthStorage } {
	registerOAuthProvider({
		id: PROVIDER,
		name: "Account Priority Unit Provider",
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
	const store = new SqliteAuthCredentialStore(new Database(":memory:"));
	const usageByAccount = opts.usageByAccount;
	const usageProvider: UsageProvider = {
		id: PROVIDER,
		async fetchUsage(params) {
			const accountId = params.credential.accountId;
			return accountId ? (usageByAccount?.get(accountId) ?? null) : null;
		},
	};
	const storage = new AuthStorage(store, {
		usageProviderResolver: provider => (provider === PROVIDER ? usageProvider : undefined),
		defaultAccounts: opts.defaultAccounts,
		accountPriorities: opts.accountPriorities,
	});
	cleanups.push(() => {
		storage.close();
		store.close();
	});
	return { store, storage };
}

async function resolvedCredentialId(
	storage: AuthStorage,
	sessionId: string,
	modelId: string,
): Promise<number | undefined> {
	const result = await storage.resolveApiKeySelection(PROVIDER, sessionId, { modelId });
	return result.ok ? result.credential.credentialId : undefined;
}

describe("AuthStorage account priority", () => {
	afterEach(() => {
		for (const dispose of cleanups.splice(0)) dispose();
		unregisterOAuthProviders(SOURCE);
	});

	// Regression: plan-gated Codex models force usage ranking even when a
	// default is pinned, which silently routed advisor traffic (advisor models
	// are typically plan-gated) to whichever account had cooler quota.
	test("plan-gated model keeps the pinned default instead of the cooler sibling", async () => {
		const usageByAccount = new Map([
			["account-a", usageReport("account-a", 0.05)],
			["account-b", usageReport("account-b", 0.8)],
		]);
		const { store, storage } = createStorage({
			defaultAccounts: { [PROVIDER]: "b@example.com" },
			usageByAccount,
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const bId = store.listAuthCredentials(PROVIDER)[1]!.id;

		expect(await resolvedCredentialId(storage, "plan-free", PLAN_FREE_MODEL)).toBe(bId);
		expect(await resolvedCredentialId(storage, "plan-gated", PLAN_GATED_MODEL)).toBe(bId);
	});

	test("priority list serves its head and walks down the order when an account is blocked", async () => {
		const { store, storage } = createStorage({
			accountPriorities: { [PROVIDER]: ["b@example.com", "a@example.com"] },
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const rows = store.listAuthCredentials(PROVIDER);
		const aId = rows[0]!.id;
		const bId = rows[1]!.id;
		// The head of the priority list is the pinned default.
		expect(storage.getDefaultAccountCredentialId(PROVIDER)).toBe(bId);
		expect(storage.getAccountPriorityCredentialIds(PROVIDER)).toEqual([bId, aId]);

		const session = "priority";
		expect(await resolvedCredentialId(storage, session, PLAN_GATED_MODEL)).toBe(bId);
		await storage.limits.markReached(PROVIDER, session, { credentialId: bId, retryAfterMs: HOUR_MS });
		expect(await resolvedCredentialId(storage, session, PLAN_GATED_MODEL)).toBe(aId);
	});

	test("journals why each account started serving a session", async () => {
		const { store, storage } = createStorage({
			accountPriorities: { [PROVIDER]: ["b@example.com", "a@example.com"] },
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const rows = store.listAuthCredentials(PROVIDER);
		const aId = rows[0]!.id;
		const bId = rows[1]!.id;
		const session = "journal";

		await resolvedCredentialId(storage, session, PLAN_GATED_MODEL);
		await storage.limits.markReached(PROVIDER, session, { credentialId: bId, retryAfterMs: HOUR_MS });
		await resolvedCredentialId(storage, session, PLAN_GATED_MODEL);

		const events = storage.listAccountSelectionEvents({ sessionId: session });
		expect(events.map(event => ({ id: event.credentialId, reason: event.reason }))).toEqual([
			{ id: bId, reason: "pinned-default" },
			{ id: aId, reason: "fallover-blocked" },
		]);
		expect(events[1]?.previousCredentialId).toBe(bId);
		expect(events[1]?.email).toBe("a@example.com");
		// Another session's history is not mixed in.
		expect(storage.listAccountSelectionEvents({ sessionId: "other" })).toHaveLength(0);
	});

	test("changing the order mid-session moves an already-bound session to the new head", async () => {
		const { store, storage } = createStorage({
			accountPriorities: { [PROVIDER]: ["a@example.com", "b@example.com"] },
		});
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const rows = store.listAuthCredentials(PROVIDER);
		const aId = rows[0]!.id;
		const bId = rows[1]!.id;
		const session = "live-edit";

		expect(await resolvedCredentialId(storage, session, PLAN_GATED_MODEL)).toBe(aId);
		storage.setAccountPrioritySelectors(PROVIDER, ["b@example.com", "a@example.com"]);
		expect(await resolvedCredentialId(storage, session, PLAN_GATED_MODEL)).toBe(bId);
		// The edit released the sticky, but the log must still name what the
		// session moved away from rather than reading as a first binding.
		const move = storage.listAccountSelectionEvents({ sessionId: session }).at(-1);
		expect(move).toMatchObject({ credentialId: bId, previousCredentialId: aId, reason: "pinned-default" });
		// Clearing the list unpins entirely: nothing is reported as the default.
		storage.setAccountPrioritySelectors(PROVIDER, undefined);
		expect(storage.getDefaultAccountCredentialId(PROVIDER)).toBeUndefined();
		expect(storage.getAccountPriorityCredentialIds(PROVIDER)).toEqual([]);
	});

	// `/account default <x>` goes through setDefaultAccountSelector, a separate
	// setter from the priority one, and the reported failure was an advisor
	// session that had already bound a credential.
	test("changing the default mid-session rebinds an already-bound advisor session", async () => {
		const { store, storage } = createStorage({ defaultAccounts: { [PROVIDER]: "a@example.com" } });
		await storage.credentials.set(PROVIDER, [oauthCredential("a"), oauthCredential("b")]);
		const rows = store.listAuthCredentials(PROVIDER);
		const aId = rows[0]!.id;
		const bId = rows[1]!.id;
		// Advisors resolve under their own provider-session id.
		const advisorSession = "session-advisor-architect";

		expect(await resolvedCredentialId(storage, advisorSession, PLAN_GATED_MODEL)).toBe(aId);
		storage.setDefaultAccountSelector(PROVIDER, "b@example.com");
		expect(await resolvedCredentialId(storage, advisorSession, PLAN_GATED_MODEL)).toBe(bId);
		expect(storage.listAccountSelectionEvents({ sessionId: advisorSession }).at(-1)).toMatchObject({
			credentialId: bId,
			previousCredentialId: aId,
		});
	});

	test("describeAccountSelector falls back to #<id> when an identity is shared", async () => {
		const { store, storage } = createStorage();
		await storage.credentials.set(PROVIDER, [
			oauthCredential("team", { email: "team@example.com", accountId: "acct-1", orgId: "org-1" }),
			oauthCredential("team2", { email: "team@example.com", accountId: "acct-2", orgId: "org-2" }),
			oauthCredential("solo"),
		]);
		const rows = store.listAuthCredentials(PROVIDER);
		const sharedEmailId = rows[0]!.id;
		const soloId = rows[2]!.id;

		// Shared email, distinct account ids: the unique identity wins over `#<id>`.
		expect(storage.describeAccountSelector(PROVIDER, sharedEmailId)).toBe("acct-1");
		expect(storage.describeAccountSelector(PROVIDER, soloId)).toBe("solo@example.com");
		expect(storage.describeAccountSelector(PROVIDER, 9999)).toBeUndefined();

		// A selector describeAccountSelector produced must resolve back to its row.
		storage.setAccountPrioritySelectors(PROVIDER, [storage.describeAccountSelector(PROVIDER, sharedEmailId)!]);
		expect(storage.getDefaultAccountCredentialId(PROVIDER)).toBe(sharedEmailId);
	});
});
