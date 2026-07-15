import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { AuthCredential } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import {
	closeGatewayHarness,
	createGatewayHarness,
	expectObject,
	type GatewayHarness,
	grantModelAccess,
	jsonHeaders,
	postChat,
	postPiNative,
	readJson,
} from "./auth-gateway-integration-helpers";

function credentials(keys: string[]): AuthCredential[] {
	return keys.map(key => ({ type: "api_key", key }));
}

async function addProviderCredential(
	harness: GatewayHarness,
	provider: string,
	key: string,
): Promise<{ id: number; provider: string }> {
	const [row] = harness.credentialStore.upsertAuthCredentialForProvider(provider, { type: "api_key", key });
	if (!row) throw new Error(`expected ${provider} credential row`);
	await harness.storage.reload();
	return row;
}

function grantProviderRules(
	harness: GatewayHarness,
	userId: number,
	provider: string,
	modelPattern = `${provider}/*`,
): void {
	harness.accessStore.addAclRule(userId, { effect: "allow", kind: "route", pattern: "chat" });
	harness.accessStore.addAclRule(userId, { effect: "allow", kind: "route", pattern: "pi-native" });
	harness.accessStore.addAclRule(userId, { effect: "allow", kind: "route", pattern: "models" });
	harness.accessStore.addAclRule(userId, { effect: "allow", kind: "route", pattern: "check" });
	harness.accessStore.addAclRule(userId, { effect: "allow", kind: "provider", pattern: provider });
	harness.accessStore.addAclRule(userId, { effect: "allow", kind: "model", pattern: modelPattern });
}

describe("auth-gateway managed users", () => {
	let harness: GatewayHarness | undefined;

	afterEach(async () => {
		await closeGatewayHarness(harness);
		harness = undefined;
	});

	test("preserves legacy bearer and no-auth compatibility, including the old 401 shape", async () => {
		harness = await createGatewayHarness({ bearerTokens: ["legacy-token"] });
		let response = await postChat(harness.handle.url, "legacy-token");
		expect(response.status).toBe(200);
		response = await fetch(`${harness.handle.url}/v1/chat/completions`, {
			method: "POST",
			headers: { ...jsonHeaders(), authorization: "bearer   legacy-token" },
			body: JSON.stringify({ model: "model-a", messages: [{ role: "user", content: "hello" }] }),
		});
		expect(response.status).toBe(200);
		expect(harness.models.get("model-a")?.calls).toHaveLength(2);

		response = await postChat(harness.handle.url, "wrong-token");
		expect(response.status).toBe(401);
		expect(await response.text()).toBe(JSON.stringify({ error: "unauthorized" }));

		await closeGatewayHarness(harness);
		harness = await createGatewayHarness({ bearerTokens: [] });
		response = await postChat(harness.handle.url, undefined);
		expect(response.status).toBe(200);
		expect(harness.models.get("model-a")?.calls).toHaveLength(1);

		response = await fetch(`${harness.handle.url}/v1/users`, { headers: jsonHeaders() });
		expect(response.status).toBe(403);
		expect(await readJson(response)).toEqual({
			error: { code: "management_auth_required", message: "Management routes require an authenticated admin token" },
		});
	});

	test("isolates managed users when a token is revoked or a user is disabled", async () => {
		harness = await createGatewayHarness({ credentials: credentials(["key-a", "key-b"]) });
		const alice = harness.accessStore.createUser({ name: "alice" });
		const bob = harness.accessStore.createUser({ name: "bob" });
		const pool = harness.accessStore.createPool({ name: "mockpool" });
		harness.accessStore.addPoolCredential(pool.id, harness.credentialStore.listAuthCredentials("mock")[0]!.id);
		await grantModelAccess(harness.accessStore, alice.user.id, pool.id);
		await grantModelAccess(harness.accessStore, bob.user.id, pool.id);

		let response = await postChat(harness.handle.url, alice.token.value);
		expect(response.status).toBe(200);
		response = await postChat(harness.handle.url, bob.token.value);
		expect(response.status).toBe(200);

		expect(harness.accessStore.revokeUserToken(alice.user.id, alice.token.id)).toBe(true);
		response = await postChat(harness.handle.url, alice.token.value);
		expect(response.status).toBe(401);
		expect(await response.text()).toBe(JSON.stringify({ error: "unauthorized" }));

		response = await postChat(harness.handle.url, bob.token.value);
		expect(response.status).toBe(200);
		harness.accessStore.updateUser(bob.user.id, { enabled: false });
		response = await postChat(harness.handle.url, bob.token.value);
		expect(response.status).toBe(401);
	});

	test("enforces route/provider/model ACLs before upstream and fail-closes missing pools", async () => {
		const modelA = createMockModel({ id: "model-a", handler: () => ({ content: ["a"] }) });
		const modelB = createMockModel({ id: "model-b", handler: () => ({ content: ["b"] }) });
		harness = await createGatewayHarness({ models: [modelA, modelB] });
		const managed = harness.accessStore.createUser({ name: "carol" });

		let response = await postChat(harness.handle.url, managed.token.value);
		expect(response.status).toBe(403);
		expect(await readJson(response)).toEqual({
			error: { message: "Access denied by gateway policy", type: "permission_error" },
		});
		expect(modelA.calls).toHaveLength(0);

		harness.accessStore.addAclRule(managed.user.id, { effect: "allow", kind: "route", pattern: "chat" });
		response = await postChat(harness.handle.url, managed.token.value);
		expect(response.status).toBe(403);
		expect(modelA.calls).toHaveLength(0);

		harness.accessStore.addAclRule(managed.user.id, { effect: "allow", kind: "provider", pattern: "mock" });
		harness.accessStore.addAclRule(managed.user.id, { effect: "allow", kind: "model", pattern: "mock/model-a" });
		response = await postChat(harness.handle.url, managed.token.value);
		expect(response.status).toBe(403);
		expect(modelA.calls).toHaveLength(0);

		const knownHidden = await postChat(harness.handle.url, managed.token.value, "model-b");
		const randomHidden = await postChat(harness.handle.url, managed.token.value, "definitely-random-model");
		expect(knownHidden.status).toBe(403);
		expect(randomHidden.status).toBe(403);
		expect(await knownHidden.text()).toBe(await randomHidden.text());
	});

	test("applies managed ACL and pool checks to pi-native requests", async () => {
		const modelA = createMockModel({ id: "model-a", handler: () => ({ content: ["pi-a"] }) });
		harness = await createGatewayHarness({ models: [modelA], credentials: credentials(["key-a"]) });
		const managed = harness.accessStore.createUser({ name: "pinativeuser" });

		let response = await postPiNative(harness.handle.url, managed.token.value);
		expect(response.status).toBe(403);
		expect(modelA.calls).toHaveLength(0);

		const pool = harness.accessStore.createPool({ name: "pinativepool" });
		harness.accessStore.addPoolCredential(pool.id, harness.credentialStore.listAuthCredentials("mock")[0]!.id);
		await grantModelAccess(harness.accessStore, managed.user.id, pool.id);
		response = await postPiNative(harness.handle.url, managed.token.value);
		expect(response.status).toBe(200);
		expect(modelA.calls).toHaveLength(1);
		response = await postPiNative(harness.handle.url, managed.token.value, "gateway-alias/model-a");
		expect(response.status).toBe(200);
		expect(modelA.calls).toHaveLength(2);
		const events = harness.accessStore.listAudit({ userId: managed.user.id, limit: 10 }).events;
		expect(events.some(event => event.routeFamily === "pi-native" && event.outcome === "success")).toBe(true);
	});

	test("allows managed users to list and call keyless models without pool bindings", async () => {
		const keylessModel = createMockModel({
			provider: "vllm",
			id: "gemma-4:31b",
			handler: (_ctx, opts) => ({ content: [`key:${typeof opts?.apiKey === "string" ? opts.apiKey : "none"}`] }),
		});
		harness = await createGatewayHarness({ models: [keylessModel], credentials: [], keylessProviders: ["vllm"] });
		const managed = harness.accessStore.createUser({ name: "keyless" });
		harness.accessStore.addAclRule(managed.user.id, { effect: "allow", kind: "route", pattern: "models" });
		harness.accessStore.addAclRule(managed.user.id, { effect: "allow", kind: "route", pattern: "chat" });
		harness.accessStore.addAclRule(managed.user.id, { effect: "allow", kind: "route", pattern: "pi-native" });
		harness.accessStore.addAclRule(managed.user.id, { effect: "allow", kind: "provider", pattern: "vllm" });
		harness.accessStore.addAclRule(managed.user.id, { effect: "allow", kind: "model", pattern: "vllm/gemma-4:31b" });

		const modelsResponse = await fetch(`${harness.handle.url}/v1/models`, {
			headers: jsonHeaders(managed.token.value),
		});
		expect(modelsResponse.status).toBe(200);
		const body = expectObject(await readJson(modelsResponse));
		const data = body.data as Array<{ id: string }>;
		expect(data.map(model => model.id)).toEqual(["vllm/gemma-4:31b"]);

		let response = await postChat(harness.handle.url, managed.token.value, "gemma-4:31b");
		expect(response.status).toBe(200);
		response = await postPiNative(harness.handle.url, managed.token.value, "gemma-4:31b");
		expect(response.status).toBe(200);
		expect(keylessModel.calls).toHaveLength(2);
	});

	test("resolves a managed chat request from one ordered binding snapshot", async () => {
		harness = await createGatewayHarness({ credentials: credentials(["key-a"]) });
		const managed = harness.accessStore.createUser({ name: "targeted" });
		const pool = harness.accessStore.createPool({ name: "targetedpool" });
		harness.accessStore.addPoolCredential(pool.id, harness.credentialStore.listAuthCredentials("mock")[0]!.id);
		await grantModelAccess(harness.accessStore, managed.user.id, pool.id);

		const listUserPoolBindings = spyOn(harness.accessStore, "listUserPoolBindings");
		const listStoredCredentials = spyOn(harness.storage, "listStoredCredentials");
		try {
			const response = await postChat(harness.handle.url, managed.token.value);

			expect(response.status).toBe(200);
			expect(harness.models.get("model-a")?.calls).toHaveLength(1);
			expect(listUserPoolBindings).toHaveBeenCalledTimes(1);
			expect(listUserPoolBindings).toHaveBeenCalledWith(managed.user.id);
			expect(listStoredCredentials).toHaveBeenCalledWith("mock");
		} finally {
			listUserPoolBindings.mockRestore();
			listStoredCredentials.mockRestore();
		}
	});

	test("resolves wrapper-prefixed provider-qualified model ids", async () => {
		harness = await createGatewayHarness({ credentials: credentials(["key-a"]) });
		const managed = harness.accessStore.createUser({ name: "wrapped" });
		const pool = harness.accessStore.createPool({ name: "wrappedpool" });
		harness.accessStore.addPoolCredential(pool.id, harness.credentialStore.listAuthCredentials("mock")[0]!.id);
		await grantModelAccess(harness.accessStore, managed.user.id, pool.id);

		const response = await postPiNative(harness.handle.url, managed.token.value, "xllm-gateway/mock/model-a");

		expect(response.status).toBe(200);
		expect(harness.models.get("model-a")?.calls).toHaveLength(1);
	});

	test("/v1/models exposes provider-qualified model ids", async () => {
		const codexModel = createMockModel({ provider: "openai-codex", id: "gpt-5.5" });
		harness = await createGatewayHarness({ models: [codexModel], credentials: [] });
		await addProviderCredential(harness, "openai-codex", "codex-key");

		const response = await fetch(`${harness.handle.url}/v1/models`, { headers: jsonHeaders("legacy-token") });
		expect(response.status).toBe(200);
		const body = expectObject(await readJson(response));
		const data = body.data as Array<{ id: string; object: "model"; owned_by: string; api: string }>;
		expect(data).toEqual([{ id: "openai-codex/gpt-5.5", object: "model", owned_by: "openai-codex", api: "mock" }]);
	});

	test("filters /v1/models by ACL, pool binding, and live matching pool members", async () => {
		const modelA = createMockModel({ id: "model-a" });
		const modelB = createMockModel({ id: "model-b" });
		harness = await createGatewayHarness({ models: [modelA, modelB], credentials: credentials(["key-a"]) });
		const managed = harness.accessStore.createUser({ name: "dana" });
		const pool = harness.accessStore.createPool({ name: "modelapool" });
		harness.accessStore.addPoolCredential(pool.id, harness.credentialStore.listAuthCredentials("mock")[0]!.id);
		harness.accessStore.addAclRule(managed.user.id, { effect: "allow", kind: "route", pattern: "models" });
		harness.accessStore.addAclRule(managed.user.id, { effect: "allow", kind: "model", pattern: "mock/model-a" });
		harness.accessStore.bindUserPool(managed.user.id, pool.id);

		const response = await fetch(`${harness.handle.url}/v1/models`, { headers: jsonHeaders(managed.token.value) });
		expect(response.status).toBe(200);
		const body = expectObject(await readJson(response));
		const data = body.data;
		expect(Array.isArray(data)).toBe(true);
		expect((data as Array<{ id: string }>).map(model => model.id)).toEqual(["mock/model-a"]);
	});

	test("lists managed models from one ordered binding snapshot per request", async () => {
		const modelA = createMockModel({ id: "model-a" });
		const modelB = createMockModel({ id: "model-b" });
		const modelC = createMockModel({ id: "model-c" });
		harness = await createGatewayHarness({ models: [modelA, modelB, modelC], credentials: credentials(["key-a"]) });
		const managed = harness.accessStore.createUser({ name: "modelcache" });
		const pool = harness.accessStore.createPool({ name: "modelcachepool" });
		harness.accessStore.addPoolCredential(pool.id, harness.credentialStore.listAuthCredentials("mock")[0]!.id);
		harness.accessStore.addAclRule(managed.user.id, { effect: "allow", kind: "route", pattern: "models" });
		harness.accessStore.addAclRule(managed.user.id, { effect: "allow", kind: "provider", pattern: "mock" });
		harness.accessStore.addAclRule(managed.user.id, { effect: "allow", kind: "model", pattern: "mock/*" });
		harness.accessStore.bindUserPool(managed.user.id, pool.id);

		const listAclRules = spyOn(harness.accessStore, "listAclRules");
		const listUserPoolBindings = spyOn(harness.accessStore, "listUserPoolBindings");
		const listStoredCredentials = spyOn(harness.storage, "listStoredCredentials");
		try {
			const response = await fetch(`${harness.handle.url}/v1/models`, { headers: jsonHeaders(managed.token.value) });
			expect(response.status).toBe(200);
			const body = expectObject(await readJson(response));
			const data = body.data as Array<{ id: string }>;
			expect(data.map(model => model.id)).toEqual(["mock/model-a", "mock/model-b", "mock/model-c"]);
			expect(listAclRules).toHaveBeenCalledTimes(1);
			expect(listUserPoolBindings).toHaveBeenCalledTimes(1);
			expect(listStoredCredentials).toHaveBeenCalledTimes(1);
			expect(listStoredCredentials).toHaveBeenCalledWith("mock");
		} finally {
			listAclRules.mockRestore();
			listUserPoolBindings.mockRestore();
			listStoredCredentials.mockRestore();
		}
	});

	test("/v1/models uses ordered pool fallback after ACL filtering", async () => {
		const anthropicModel = createMockModel({ provider: "anthropic", id: "claude-test" });
		const openaiModel = createMockModel({ provider: "openai", id: "gpt-test" });
		harness = await createGatewayHarness({ models: [openaiModel, anthropicModel], credentials: [] });
		const openaiRow = await addProviderCredential(harness, "openai", "openai-models");
		const anthropicRow = await addProviderCredential(harness, "anthropic", "anthropic-models");
		const managed = harness.accessStore.createUser({ name: "modelfallback" });
		const firstPool = harness.accessStore.createPool({ name: "modelopenai" });
		const secondPool = harness.accessStore.createPool({ name: "modelanthropic" });
		harness.accessStore.addPoolCredential(firstPool.id, openaiRow.id);
		harness.accessStore.addPoolCredential(secondPool.id, anthropicRow.id);
		grantProviderRules(harness, managed.user.id, "anthropic");
		harness.accessStore.bindUserPool(managed.user.id, firstPool.id);
		harness.accessStore.bindUserPool(managed.user.id, secondPool.id);

		const response = await fetch(`${harness.handle.url}/v1/models`, { headers: jsonHeaders(managed.token.value) });
		expect(response.status).toBe(200);
		const body = expectObject(await readJson(response));
		const data = body.data as Array<{ id: string; owned_by: string }>;
		expect(data.map(model => model.id)).toEqual(["anthropic/claude-test"]);
	});

	test("/v1/credentials/check uses ordered pool fallback and provider-only ACLs for custom providers", async () => {
		harness = await createGatewayHarness({ credentials: [] });
		const anthropicRow = await addProviderCredential(harness, "anthropic", "anthropic-check-secret");
		const customRow = await addProviderCredential(harness, "zz-custom-provider", "custom-check-secret");
		const managed = harness.accessStore.createUser({ name: "checkfallback" });
		const firstPool = harness.accessStore.createPool({ name: "checkanthropic" });
		const secondPool = harness.accessStore.createPool({ name: "checkcustom" });
		harness.accessStore.addPoolCredential(firstPool.id, anthropicRow.id);
		harness.accessStore.addPoolCredential(secondPool.id, customRow.id);
		harness.accessStore.addAclRule(managed.user.id, { effect: "allow", kind: "route", pattern: "check" });
		harness.accessStore.addAclRule(managed.user.id, {
			effect: "allow",
			kind: "provider",
			pattern: "zz-custom-provider",
		});
		harness.accessStore.bindUserPool(managed.user.id, firstPool.id);
		harness.accessStore.bindUserPool(managed.user.id, secondPool.id);

		const response = await fetch(`${harness.handle.url}/v1/credentials/check`, {
			headers: jsonHeaders(managed.token.value),
		});

		expect(response.status).toBe(200);
		const body = expectObject(await readJson(response));
		const credentialsBody = body.credentials as Array<{ member: number; provider: string }>;
		expect(credentialsBody.map(row => ({ member: row.member, provider: row.provider }))).toEqual([
			{ member: 1, provider: "zz-custom-provider" },
		]);
		expect(JSON.stringify(body)).not.toContain("custom-check-secret");
		expect(JSON.stringify(body)).not.toContain("anthropic-check-secret");
	});

	test("/v1/credentials/check honors catalog model deny precedence for bundled providers", async () => {
		harness = await createGatewayHarness({ credentials: [] });
		const anthropicRow = await addProviderCredential(harness, "anthropic", "anthropic-denied-secret");
		const managed = harness.accessStore.createUser({ name: "checkdeny" });
		const pool = harness.accessStore.createPool({ name: "checkdenypool" });
		harness.accessStore.addPoolCredential(pool.id, anthropicRow.id);
		harness.accessStore.addAclRule(managed.user.id, { effect: "allow", kind: "route", pattern: "check" });
		harness.accessStore.addAclRule(managed.user.id, { effect: "allow", kind: "provider", pattern: "anthropic" });
		harness.accessStore.addAclRule(managed.user.id, { effect: "deny", kind: "model", pattern: "anthropic/*" });
		harness.accessStore.bindUserPool(managed.user.id, pool.id);

		const response = await fetch(`${harness.handle.url}/v1/credentials/check`, {
			headers: jsonHeaders(managed.token.value),
		});

		expect(response.status).toBe(200);
		const body = expectObject(await readJson(response));
		expect(body.credentials).toEqual([]);
		expect(JSON.stringify(body)).not.toContain("anthropic-denied-secret");
	});
});
