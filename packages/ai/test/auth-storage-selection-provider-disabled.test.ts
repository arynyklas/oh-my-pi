import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import * as compatAuth from "@oh-my-pi/pi-catalog/compat/auth";

const PROVIDER = "anthropic";

// The explicit-selection walk is the fork's own entry (an auth gateway's credential pools). A provider
// turned off in its auth rules must stay unreachable through it, not only through the plain cascade.
describe("a provider disabled in its auth rules, with an explicit credential selection", () => {
	let store: SqliteAuthCredentialStore;
	let auth: AuthStorage;

	beforeEach(() => {
		store = new SqliteAuthCredentialStore(new Database(":memory:"));
		auth = new AuthStorage(store);
	});

	afterEach(() => {
		auth.close();
		store.close();
		vi.restoreAllMocks();
	});

	test("resolves no credential from the pool the selection names, and serves it again once re-enabled", async () => {
		await auth.credentials.set(PROVIDER, [{ type: "api_key", key: "sk-pooled" }]);
		const id = store.listAuthCredentials(PROVIDER)[0]!.id;
		const selection = { policyKey: "pool", eligibleCredentialIds: [id], strategy: "failover" } as const;

		const spy = vi
			.spyOn(compatAuth, "providerDisabledReason")
			.mockImplementation(provider => (provider === PROVIDER ? "paused for now" : undefined));
		await expect(auth.resolveApiKeySelection(PROVIDER, "session", { selection })).resolves.toEqual({
			ok: false,
			reason: "no_credential",
		});

		spy.mockRestore();
		await auth.credentials.reload();
		const result = await auth.resolveApiKeySelection(PROVIDER, "session", { selection });
		expect(result.ok).toBe(true);
	});
});
