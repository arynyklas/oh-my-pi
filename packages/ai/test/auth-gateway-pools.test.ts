import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { registerCustomApi } from "@oh-my-pi/pi-ai/api-registry";
import type { AuthCredential } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, type MockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/registry/oauth";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import {
	closeGatewayHarness,
	createGatewayHarness,
	type GatewayHarness,
	grantModelAccess,
	jsonHeaders,
	postChat,
	postPiNative,
	readJson,
} from "./auth-gateway-integration-helpers";

const OAUTH_SOURCE = "auth-gateway-pools-test";
const THROWING_API = "auth-gateway-pools-throwing-api";

function throwingTerminalModel(message: string): MockModel {
	const model = createMockModel({ id: "model-a" });
	Object.defineProperty(model, "api", { value: THROWING_API });
	registerCustomApi(
		THROWING_API,
		() => {
			throw Object.assign(new Error(message), { status: 401 });
		},
		OAUTH_SOURCE,
	);
	return model;
}

function farExpiry(): number {
	return Date.now() + 60 * 60_000;
}

function oauthCredential(label: string): AuthCredential {
	return {
		type: "oauth",
		access: label,
		refresh: `refresh-${label}`,
		expires: farExpiry(),
		accountId: `account-${label}`,
		email: `${label}@example.com`,
	};
}

function registerMockOAuthProvider(): void {
	registerOAuthProvider({
		id: "mock",
		name: "Gateway Pool Mock OAuth",
		sourceId: OAUTH_SOURCE,
		async login() {
			return { access: "login", refresh: "login", expires: farExpiry() };
		},
		async refreshToken(credentials: OAuthCredentials) {
			return credentials;
		},
		getApiKey(credentials: OAuthCredentials) {
			return credentials.access;
		},
	});
}

function seededCredentials(): AuthCredential[] {
	return [
		{ type: "api_key", key: "key-a" },
		{ type: "api_key", key: "key-b" },
		{ type: "api_key", key: "outside-key" },
	];
}

async function responseText(response: Response): Promise<string> {
	const body = await readJson(response);
	if (!body || typeof body !== "object" || !("choices" in body)) return "";
	const choices = body.choices;
	if (!Array.isArray(choices)) return "";
	const first = choices[0];
	if (!first || typeof first !== "object" || !("message" in first)) return "";
	const message = first.message;
	if (!message || typeof message !== "object" || !("content" in message)) return "";
	return typeof message.content === "string" ? message.content : "";
}

async function collectStreamText(response: Response): Promise<string> {
	const reader = response.body?.getReader();
	if (!reader) return "";
	const decoder = new TextDecoder();
	let out = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		out += decoder.decode(value, { stream: true });
	}
	return out + decoder.decode();
}

async function addProviderCredential(
	harness: GatewayHarness,
	provider: string,
	key: string,
): Promise<{ id: number; provider: string }> {
	const [row] = await harness.credentialStore.upsertAuthCredential(provider, { type: "api_key", key });
	if (!row) throw new Error(`expected ${provider} credential row`);
	await harness.storage.credentials.reload();
	return row;
}

function grantProviderAccess(
	harness: GatewayHarness,
	userId: number,
	poolId: number,
	provider: string,
	modelPattern = `${provider}/*`,
): void {
	harness.accessStore.addAclRule(userId, { effect: "allow", kind: "route", pattern: "chat" });
	harness.accessStore.addAclRule(userId, { effect: "allow", kind: "route", pattern: "pi-native" });
	harness.accessStore.addAclRule(userId, { effect: "allow", kind: "route", pattern: "models" });
	harness.accessStore.addAclRule(userId, { effect: "allow", kind: "route", pattern: "check" });
	harness.accessStore.addAclRule(userId, { effect: "allow", kind: "provider", pattern: provider });
	harness.accessStore.addAclRule(userId, { effect: "allow", kind: "model", pattern: modelPattern });
	harness.accessStore.bindUserPool(userId, poolId);
}

describe("auth-gateway credential pools", () => {
	let harness: GatewayHarness | undefined;

	afterEach(async () => {
		unregisterOAuthProviders(OAUTH_SOURCE);
		await closeGatewayHarness(harness);
		harness = undefined;
	});

	test("routes mixed-provider pools through the first bound pool with a live request-provider member", async () => {
		const seen: string[] = [];
		const anthropicModel = createMockModel({
			provider: "anthropic",
			id: "claude-test",
			handler: (_ctx, opts) => {
				const key = typeof opts?.apiKey === "string" ? opts.apiKey : "none";
				seen.push(`anthropic:${key}`);
				return { content: [`used:${key}`] };
			},
		});
		const openaiModel = createMockModel({
			provider: "openai",
			id: "gpt-test",
			handler: (_ctx, opts) => {
				const key = typeof opts?.apiKey === "string" ? opts.apiKey : "none";
				seen.push(`openai:${key}`);
				return { content: [`used:${key}`] };
			},
		});
		harness = await createGatewayHarness({ models: [anthropicModel, openaiModel], credentials: [] });
		const anthropicRow = await addProviderCredential(harness, "anthropic", "anthropic-in-pool");
		const openaiRow = await addProviderCredential(harness, "openai", "openai-in-pool");
		await addProviderCredential(harness, "anthropic", "anthropic-outside-pool");
		const user = harness.accessStore.createUser({ name: "mixedpooluser" });
		const pool = harness.accessStore.createPool({ name: "mixedpool" });
		harness.accessStore.addPoolCredential(pool.id, openaiRow.id);
		harness.accessStore.addPoolCredential(pool.id, anthropicRow.id);
		grantProviderAccess(harness, user.user.id, pool.id, "*", "*");

		let response = await postChat(harness.handle.url, user.token.value, "claude-test");
		expect(response.status).toBe(200);
		expect(await responseText(response)).toBe("used:anthropic-in-pool");
		response = await postChat(harness.handle.url, user.token.value, "gpt-test");
		expect(response.status).toBe(200);
		expect(await responseText(response)).toBe("used:openai-in-pool");
		expect(seen).toEqual(["anthropic:anthropic-in-pool", "openai:openai-in-pool"]);
	});

	test("reordering bound pools changes the same-provider winner without excluding shared accounts", async () => {
		const model = createMockModel({
			id: "model-a",
			handler: (_ctx, opts) => ({ content: [`used:${typeof opts?.apiKey === "string" ? opts.apiKey : "none"}`] }),
		});
		harness = await createGatewayHarness({ models: [model], credentials: seededCredentials() });
		const [shared, firstOnly, secondFirst] = harness.credentialStore.listAuthCredentials("mock");
		if (!shared || !firstOnly || !secondFirst) throw new Error("expected credential rows");
		const user = harness.accessStore.createUser({ name: "poolorderuser" });
		const firstPool = harness.accessStore.createPool({ name: "firstpool", strategy: "failover" });
		const secondPool = harness.accessStore.createPool({ name: "secondpool", strategy: "failover" });
		harness.accessStore.addPoolCredential(firstPool.id, shared.id);
		harness.accessStore.addPoolCredential(firstPool.id, firstOnly.id);
		harness.accessStore.addPoolCredential(secondPool.id, secondFirst.id);
		harness.accessStore.addPoolCredential(secondPool.id, shared.id);
		grantProviderAccess(harness, user.user.id, firstPool.id, "mock");
		harness.accessStore.bindUserPool(user.user.id, secondPool.id);

		let response = await postChat(harness.handle.url, user.token.value, "model-a");
		expect(response.status).toBe(200);
		expect(await responseText(response)).toBe("used:key-a");
		harness.accessStore.setUserPoolOrder(user.user.id, [secondPool.id, firstPool.id]);
		response = await postChat(harness.handle.url, user.token.value, "model-a");
		expect(response.status).toBe(200);
		expect(await responseText(response)).toBe("used:outside-key");
	});

	test("falls through an earlier bound pool with no request-provider account", async () => {
		const anthropicModel = createMockModel({
			provider: "anthropic",
			id: "claude-test",
			handler: (_ctx, opts) => ({ content: [`used:${typeof opts?.apiKey === "string" ? opts.apiKey : "none"}`] }),
		});
		harness = await createGatewayHarness({ models: [anthropicModel], credentials: [] });
		const openaiRow = await addProviderCredential(harness, "openai", "openai-only");
		const anthropicRow = await addProviderCredential(harness, "anthropic", "anthropic-fallback");
		const user = harness.accessStore.createUser({ name: "fallbackuser" });
		const firstPool = harness.accessStore.createPool({ name: "openaiholding" });
		const secondPool = harness.accessStore.createPool({ name: "anthropicholding" });
		harness.accessStore.addPoolCredential(firstPool.id, openaiRow.id);
		harness.accessStore.addPoolCredential(secondPool.id, anthropicRow.id);
		grantProviderAccess(harness, user.user.id, firstPool.id, "anthropic");
		harness.accessStore.bindUserPool(user.user.id, secondPool.id);

		const response = await postChat(harness.handle.url, user.token.value, "claude-test");
		expect(response.status).toBe(200);
		expect(await responseText(response)).toBe("used:anthropic-fallback");
	});

	test("round-robin pools advance in member order across new sessions", async () => {
		const seenKeys: string[] = [];
		const model = createMockModel({
			id: "model-a",
			handler: (_ctx, opts) => {
				const key = typeof opts?.apiKey === "string" ? opts.apiKey : "none";
				seenKeys.push(key);
				return { content: [`used:${key}`] };
			},
		});
		harness = await createGatewayHarness({ models: [model], credentials: seededCredentials() });
		const [keyA, keyB] = harness.credentialStore.listAuthCredentials("mock");
		if (!keyA || !keyB) throw new Error("expected credential rows");
		const user = harness.accessStore.createUser({ name: "roundrobin" });
		const pool = harness.accessStore.createPool({
			name: "roundrobinpool",
			strategy: "round-robin",
		});
		harness.accessStore.addPoolCredential(pool.id, keyA.id);
		harness.accessStore.addPoolCredential(pool.id, keyB.id);
		await grantModelAccess(harness.accessStore, user.user.id, pool.id);

		for (const session of ["rr-a", "rr-b", "rr-c"]) {
			const response = await fetch(`${harness.handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: jsonHeaders(user.token.value),
				body: JSON.stringify({
					model: "model-a",
					messages: [{ role: "user", content: "hello" }],
					prompt_cache_key: session,
				}),
			});
			expect(response.status).toBe(200);
		}

		expect(seenKeys).toEqual(["key-a", "key-b", "key-a"]);
	});

	test("round-robin mixed pools advance across OAuth and API-key members", async () => {
		registerMockOAuthProvider();
		const seenKeys: string[] = [];
		const model = createMockModel({
			id: "model-a",
			handler: (_ctx, opts) => {
				const key = typeof opts?.apiKey === "string" ? opts.apiKey : "none";
				seenKeys.push(key);
				return { content: [`used:${key}`] };
			},
		});
		harness = await createGatewayHarness({
			models: [model],
			credentials: [oauthCredential("oauth-a"), { type: "api_key", key: "api-b" }],
		});
		const [oauthRow, apiRow] = harness.credentialStore.listAuthCredentials("mock");
		if (!oauthRow || !apiRow) throw new Error("expected mixed rows");
		const user = harness.accessStore.createUser({ name: "mixedrr" });
		const pool = harness.accessStore.createPool({ name: "mixedrrpool", strategy: "round-robin" });
		harness.accessStore.addPoolCredential(pool.id, apiRow.id);
		harness.accessStore.addPoolCredential(pool.id, oauthRow.id);
		await grantModelAccess(harness.accessStore, user.user.id, pool.id);

		for (const session of ["mixed-rr-a", "mixed-rr-b", "mixed-rr-c"]) {
			const response = await fetch(`${harness.handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: jsonHeaders(user.token.value),
				body: JSON.stringify({
					model: "model-a",
					messages: [{ role: "user", content: "hello" }],
					prompt_cache_key: session,
				}),
			});
			expect(response.status).toBe(200);
		}

		expect(seenKeys).toEqual(["api-b", "oauth-a", "api-b"]);
	});

	test("round-robin policy keys include provider inside one mixed-provider pool", async () => {
		const anthropicModel = createMockModel({
			provider: "anthropic",
			id: "claude-test",
			handler: () => ({ content: ["anthropic"] }),
		});
		const openaiModel = createMockModel({
			provider: "openai",
			id: "gpt-test",
			handler: () => ({ content: ["openai"] }),
		});
		harness = await createGatewayHarness({ models: [anthropicModel, openaiModel], credentials: [] });
		const anthropicRow = await addProviderCredential(harness, "anthropic", "anthropic-rr");
		const openaiRow = await addProviderCredential(harness, "openai", "openai-rr");
		const user = harness.accessStore.createUser({ name: "rrscope" });
		const pool = harness.accessStore.createPool({ name: "rrscopepool", strategy: "round-robin" });
		harness.accessStore.addPoolCredential(pool.id, anthropicRow.id);
		harness.accessStore.addPoolCredential(pool.id, openaiRow.id);
		grantProviderAccess(harness, user.user.id, pool.id, "*", "*");
		const resolveSelection = spyOn(harness.storage, "resolveApiKeySelection");
		try {
			let response = await postChat(harness.handle.url, user.token.value, "claude-test");
			expect(response.status).toBe(200);
			response = await postChat(harness.handle.url, user.token.value, "gpt-test");
			expect(response.status).toBe(200);
			const policyKeys = resolveSelection.mock.calls.map(call => call[2]?.selection?.policyKey);
			expect(policyKeys).toEqual([`gateway-pool:${pool.id}:anthropic`, `gateway-pool:${pool.id}:openai`]);
		} finally {
			resolveSelection.mockRestore();
		}
	});

	test("same-identity OAuth re-login keeps existing pool member usable", async () => {
		registerMockOAuthProvider();
		const seenKeys: string[] = [];
		const model = createMockModel({
			id: "model-a",
			handler: (_ctx, opts) => {
				const key = typeof opts?.apiKey === "string" ? opts.apiKey : "none";
				seenKeys.push(key);
				return { content: [`used:${key}`] };
			},
		});
		const original: AuthCredential = {
			type: "oauth",
			access: "oauth-before",
			refresh: "refresh-before",
			expires: farExpiry(),
			accountId: "stable-account",
			email: "stable.user@example.com",
		};
		harness = await createGatewayHarness({ models: [model], credentials: [original] });
		const [row] = harness.credentialStore.listAuthCredentials("mock");
		if (!row) throw new Error("expected oauth row");
		const user = harness.accessStore.createUser({ name: "sameidentity" });
		const pool = harness.accessStore.createPool({ name: "sameidentitypool", strategy: "failover" });
		harness.accessStore.addPoolCredential(pool.id, row.id);
		await grantModelAccess(harness.accessStore, user.user.id, pool.id);

		expect(await harness.storage.credentials.disable(row.id, "oauth refresh failed: invalid_grant")).toBe(true);
		harness.storage.credentials.upsert("mock", {
			type: "oauth",
			access: "oauth-after",
			refresh: "refresh-after",
			expires: farExpiry(),
			accountId: "stable-account",
			email: "stable.user@example.com",
		});

		expect(harness.accessStore.getPool(pool.id)?.members.map(member => member.credentialId)).toEqual([row.id]);
		const response = await postChat(harness.handle.url, user.token.value);
		expect(response.status).toBe(200);
		expect(await responseText(response)).toBe("used:oauth-after");
		expect(seenKeys).toEqual(["oauth-after"]);
	});

	test("sticky-session pools reuse the same member for the same prompt cache key", async () => {
		const seenKeys: string[] = [];
		const model = createMockModel({
			id: "model-a",
			handler: (_ctx, opts) => {
				const key = typeof opts?.apiKey === "string" ? opts.apiKey : "none";
				seenKeys.push(key);
				return { content: [`used:${key}`] };
			},
		});
		harness = await createGatewayHarness({ models: [model], credentials: seededCredentials() });
		const [keyA, keyB] = harness.credentialStore.listAuthCredentials("mock");
		if (!keyA || !keyB) throw new Error("expected credential rows");
		const user = harness.accessStore.createUser({ name: "stickyuser" });
		const pool = harness.accessStore.createPool({ name: "stickypool", strategy: "sticky-session" });
		harness.accessStore.addPoolCredential(pool.id, keyA.id);
		harness.accessStore.addPoolCredential(pool.id, keyB.id);
		await grantModelAccess(harness.accessStore, user.user.id, pool.id);

		for (let index = 0; index < 2; index += 1) {
			const response = await fetch(`${harness.handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: jsonHeaders(user.token.value),
				body: JSON.stringify({
					model: "model-a",
					messages: [{ role: "user", content: "hello" }],
					prompt_cache_key: "same-sticky-session",
				}),
			});
			expect(response.status).toBe(200);
		}

		expect(seenKeys).toHaveLength(2);
		expect(seenKeys[1]).toBe(seenKeys[0]);
	});

	test("sticky-session credential session scope is stable for the same pool and provider", async () => {
		const model = createMockModel({
			provider: "anthropic",
			id: "claude-test",
			handler: (_ctx, opts) => ({ content: [`used:${typeof opts?.apiKey === "string" ? opts.apiKey : "none"}`] }),
		});
		harness = await createGatewayHarness({ models: [model], credentials: [] });
		const keyA = await addProviderCredential(harness, "anthropic", "sticky-a");
		const keyB = await addProviderCredential(harness, "anthropic", "sticky-b");
		const user = harness.accessStore.createUser({ name: "stickyscope" });
		const pool = harness.accessStore.createPool({ name: "stickyscopepool", strategy: "sticky-session" });
		harness.accessStore.addPoolCredential(pool.id, keyA.id);
		harness.accessStore.addPoolCredential(pool.id, keyB.id);
		grantProviderAccess(harness, user.user.id, pool.id, "anthropic");
		const resolveSelection = spyOn(harness.storage, "resolveApiKeySelection");
		try {
			for (let index = 0; index < 2; index += 1) {
				const response = await fetch(`${harness.handle.url}/v1/chat/completions`, {
					method: "POST",
					headers: jsonHeaders(user.token.value),
					body: JSON.stringify({
						model: "claude-test",
						messages: [{ role: "user", content: "hello" }],
						prompt_cache_key: "same-provider-session",
					}),
				});
				expect(response.status).toBe(200);
			}
			const sessionIds = resolveSelection.mock.calls.map(call => call[1]);
			expect(sessionIds).toEqual([
				`gateway:${user.user.id}:gateway-pool:${pool.id}:anthropic:same-provider-session`,
				`gateway:${user.user.id}:gateway-pool:${pool.id}:anthropic:same-provider-session`,
			]);
		} finally {
			resolveSelection.mockRestore();
		}
	});

	test("least-used API-key pools keep configured order when no usage signal exists", async () => {
		const seenKeys: string[] = [];
		const model = createMockModel({
			id: "model-a",
			handler: (_ctx, opts) => {
				const key = typeof opts?.apiKey === "string" ? opts.apiKey : "none";
				seenKeys.push(key);
				return { content: [`used:${key}`] };
			},
		});
		harness = await createGatewayHarness({ models: [model], credentials: seededCredentials() });
		const [keyA, keyB] = harness.credentialStore.listAuthCredentials("mock");
		if (!keyA || !keyB) throw new Error("expected credential rows");
		const user = harness.accessStore.createUser({ name: "leastapi" });
		const pool = harness.accessStore.createPool({ name: "leastapipool", strategy: "least-used" });
		harness.accessStore.addPoolCredential(pool.id, keyA.id);
		harness.accessStore.addPoolCredential(pool.id, keyB.id);
		await grantModelAccess(harness.accessStore, user.user.id, pool.id);

		for (const session of ["least-a", "least-b"]) {
			const response = await fetch(`${harness.handle.url}/v1/chat/completions`, {
				method: "POST",
				headers: jsonHeaders(user.token.value),
				body: JSON.stringify({
					model: "model-a",
					messages: [{ role: "user", content: "hello" }],
					prompt_cache_key: session,
				}),
			});
			expect(response.status).toBe(200);
		}

		expect(seenKeys).toEqual(["key-a", "key-a"]);
	});

	test("failover pools use configured order and switch only after block", async () => {
		const seenKeys: string[] = [];
		const model = createMockModel({
			id: "model-a",
			handler: (_ctx, opts) => {
				const key = typeof opts?.apiKey === "string" ? opts.apiKey : "none";
				seenKeys.push(key);
				if (key === "key-a" && seenKeys.length > 1) {
					return { throw: Object.assign(new Error("usage limit reached: failover-a"), { status: 429 }) };
				}
				return { content: [`used:${key}`] };
			},
		});
		harness = await createGatewayHarness({ models: [model], credentials: seededCredentials() });
		const [keyA, keyB] = harness.credentialStore.listAuthCredentials("mock");
		if (!keyA || !keyB) throw new Error("expected credential rows");
		const user = harness.accessStore.createUser({ name: "failoverorder" });
		const pool = harness.accessStore.createPool({
			name: "failoverorderpool",
			strategy: "failover",
		});
		harness.accessStore.addPoolCredential(pool.id, keyA.id);
		harness.accessStore.addPoolCredential(pool.id, keyB.id);
		await grantModelAccess(harness.accessStore, user.user.id, pool.id);

		let response = await postChat(harness.handle.url, user.token.value);
		expect(response.status).toBe(200);
		expect(await responseText(response)).toBe("used:key-a");
		response = await fetch(`${harness.handle.url}/v1/chat/completions`, {
			method: "POST",
			headers: jsonHeaders(user.token.value),
			body: JSON.stringify({
				model: "model-a",
				messages: [{ role: "user", content: "hello" }],
				prompt_cache_key: "failover-after-block",
			}),
		});
		expect(response.status).toBe(200);
		expect(await responseText(response)).toBe("used:key-b");
		expect(seenKeys).toEqual(["key-a", "key-a", "key-b"]);
	});

	test("does not retry outside the pool and rewrites exhausted pools to rate-limit errors", async () => {
		const model = createMockModel({
			id: "model-a",
			handler: (_ctx, opts) => {
				const key = typeof opts?.apiKey === "string" ? opts.apiKey : "none";
				if (key === "key-a") {
					const error = Object.assign(new Error("You have hit your ChatGPT usage limit. Try again later."), {
						status: 429,
					});
					return { throw: error };
				}
				return { content: [`used:${key}`] };
			},
		});
		harness = await createGatewayHarness({ models: [model], credentials: seededCredentials() });
		const [keyA, keyB, outside] = harness.credentialStore.listAuthCredentials("mock");
		if (!keyA || !keyB || !outside) throw new Error("expected credential rows");
		const user = harness.accessStore.createUser({ name: "failoveruser" });
		const pool = harness.accessStore.createPool({ name: "failoverpool", strategy: "failover" });
		harness.accessStore.addPoolCredential(pool.id, keyA.id);
		harness.accessStore.addPoolCredential(pool.id, keyB.id);
		await grantModelAccess(harness.accessStore, user.user.id, pool.id);

		let response = await postChat(harness.handle.url, user.token.value);
		expect(response.status).toBe(200);
		expect(await responseText(response)).toBe("used:key-b");

		const exhaustedUser = harness.accessStore.createUser({ name: "exhausted" });
		const exhaustedPool = harness.accessStore.createPool({
			name: "exhaustedpool",
			strategy: "failover",
		});
		harness.accessStore.addPoolCredential(exhaustedPool.id, keyA.id);
		await grantModelAccess(harness.accessStore, exhaustedUser.user.id, exhaustedPool.id);
		response = await postChat(harness.handle.url, exhaustedUser.token.value);
		expect(response.status).toBe(429);
		const text = await response.text();
		expect(text).toContain("No eligible credential is available for this request");
		expect(text).toContain("rate_limit_error");
		expect(text).not.toContain("outside-key");

		const piUser = harness.accessStore.createUser({ name: "piexhausted" });
		const piPool = harness.accessStore.createPool({
			name: "piexhaustedpool",
			strategy: "failover",
		});
		harness.accessStore.addPoolCredential(piPool.id, keyA.id);
		await grantModelAccess(harness.accessStore, piUser.user.id, piPool.id);
		response = await postPiNative(harness.handle.url, piUser.token.value);
		expect(response.status).toBe(429);
		const piText = await response.text();
		expect(piText).toContain("No eligible credential is available for this request");
		expect(piText).toContain("rate_limit_error");
		expect(piText).not.toContain("outside-key");
	});

	test("mixed OAuth usage-limit retries with the next API-key member", async () => {
		registerMockOAuthProvider();
		const seenKeys: string[] = [];
		const model = createMockModel({
			id: "model-a",
			handler: (_ctx, opts) => {
				const key = typeof opts?.apiKey === "string" ? opts.apiKey : "none";
				seenKeys.push(key);
				if (key === "oauth-limited") {
					return { throw: Object.assign(new Error("usage limit reached: oauth-limited"), { status: 429 }) };
				}
				return { content: [`used:${key}`] };
			},
		});
		harness = await createGatewayHarness({
			models: [model],
			credentials: [oauthCredential("oauth-limited"), { type: "api_key", key: "api-healthy" }],
		});
		const [oauthRow, apiRow] = harness.credentialStore.listAuthCredentials("mock");
		if (!oauthRow || !apiRow) throw new Error("expected mixed rows");
		const user = harness.accessStore.createUser({ name: "mixedlimit" });
		const pool = harness.accessStore.createPool({ name: "mixedlimitpool", strategy: "failover" });
		harness.accessStore.addPoolCredential(pool.id, oauthRow.id);
		harness.accessStore.addPoolCredential(pool.id, apiRow.id);
		await grantModelAccess(harness.accessStore, user.user.id, pool.id);

		const response = await postChat(harness.handle.url, user.token.value);
		expect(response.status).toBe(200);
		expect(await responseText(response)).toBe("used:api-healthy");
		expect(seenKeys).toEqual(["oauth-limited", "api-healthy"]);
	});

	test("legacy retry failures keep their upstream error", async () => {
		const usageModel = createMockModel({
			id: "usage-model",
			handler: () => ({
				throw: Object.assign(new Error("usage limit reached: legacy-usage-sentinel"), { status: 429 }),
			}),
		});
		const authModel = createMockModel({
			id: "auth-model",
			handler: () => ({
				throw: Object.assign(new Error("401 invalid_api_key legacy-auth-sentinel"), { status: 401 }),
			}),
		});
		harness = await createGatewayHarness({
			models: [usageModel, authModel],
			credentials: [{ type: "api_key", key: "legacy-key" }],
		});

		let response = await postChat(harness.handle.url, "legacy-token", "usage-model");
		let text = await response.text();
		expect(text).toContain("legacy-usage-sentinel");
		expect(text).not.toContain("No eligible credential is available for this request");

		await closeGatewayHarness(harness);
		harness = await createGatewayHarness({
			models: [usageModel, authModel],
			credentials: [{ type: "api_key", key: "legacy-key" }],
		});
		response = await postChat(harness.handle.url, "legacy-token", "auth-model");
		text = await response.text();
		expect(text).toContain("legacy-auth-sentinel");
		expect(text).not.toContain("No eligible credential is available for this request");
	});

	test("explicit invalidation with no remaining member is 503", async () => {
		const model = createMockModel({
			id: "model-a",
			handler: () => ({
				throw: Object.assign(new Error("401 invalid_api_key selected-sentinel"), { status: 401 }),
			}),
		});
		harness = await createGatewayHarness({
			models: [model],
			credentials: [{ type: "api_key", key: "selected-key" }],
		});
		const [row] = harness.credentialStore.listAuthCredentials("mock");
		if (!row) throw new Error("expected credential row");
		const user = harness.accessStore.createUser({ name: "selectedinvalid" });
		const pool = harness.accessStore.createPool({
			name: "selectedinvalidpool",
			strategy: "failover",
		});
		harness.accessStore.addPoolCredential(pool.id, row.id);
		await grantModelAccess(harness.accessStore, user.user.id, pool.id);

		const response = await postChat(harness.handle.url, user.token.value);
		expect(response.status).toBe(503);
		const body = await readJson(response);
		expect(body).toMatchObject({
			error: {
				type: "no_eligible_credential",
				message: "No eligible credential is available for this request",
			},
		});
	});

	test("format non-streaming thrown terminal auth failures exhaust managed pools", async () => {
		const model = throwingTerminalModel("401 invalid_api_key thrown-selected-sentinel");
		harness = await createGatewayHarness({
			models: [model],
			credentials: [{ type: "api_key", key: "selected-key" }],
		});
		const [row] = harness.credentialStore.listAuthCredentials("mock");
		if (!row) throw new Error("expected credential row");
		const user = harness.accessStore.createUser({ name: "throwninvalid" });
		const pool = harness.accessStore.createPool({
			name: "throwninvalidpool",
			strategy: "failover",
		});
		harness.accessStore.addPoolCredential(pool.id, row.id);
		await grantModelAccess(harness.accessStore, user.user.id, pool.id);

		const response = await postChat(harness.handle.url, user.token.value);
		expect(response.status).toBe(503);
		const text = await response.text();
		const body = JSON.parse(text) as unknown;
		expect(body).toMatchObject({
			error: {
				type: "no_eligible_credential",
				message: "No eligible credential is available for this request",
			},
		});
		expect(text).not.toContain("thrown-selected-sentinel");
		const audit = harness.accessStore.listAudit({ userId: user.user.id, limit: 5 }).events[0];
		expect(audit).toMatchObject({
			outcome: "no_eligible_credential",
			statusCode: 503,
			errorCode: "no_eligible_credential",
		});
	});

	test("pi-native non-streaming terminal auth failures exhaust managed pools", async () => {
		const model = createMockModel({
			id: "model-a",
			handler: () => ({
				throw: Object.assign(new Error("401 invalid_api_key pi-native-selected-sentinel"), { status: 401 }),
			}),
		});
		harness = await createGatewayHarness({
			models: [model],
			credentials: [{ type: "api_key", key: "selected-key" }],
		});
		const [row] = harness.credentialStore.listAuthCredentials("mock");
		if (!row) throw new Error("expected credential row");
		const user = harness.accessStore.createUser({ name: "pinativeinvalid" });
		const pool = harness.accessStore.createPool({
			name: "pinativeinvalidpool",
			strategy: "failover",
		});
		harness.accessStore.addPoolCredential(pool.id, row.id);
		await grantModelAccess(harness.accessStore, user.user.id, pool.id);

		const response = await postPiNative(harness.handle.url, user.token.value);
		expect(response.status).toBe(503);
		const body = await readJson(response);
		expect(body).toMatchObject({
			error: {
				type: "no_eligible_credential",
				message: "No eligible credential is available for this request",
			},
		});
		const audit = harness.accessStore.listAudit({ userId: user.user.id, limit: 5 }).events[0];
		expect(audit).toMatchObject({
			routeFamily: "pi-native",
			outcome: "no_eligible_credential",
			statusCode: 503,
			errorCode: "no_eligible_credential",
		});
	});

	test("stream audit distinguishes no eligible credential from usage limit", async () => {
		const model = createMockModel({
			id: "model-a",
			handler: () => ({
				throw: Object.assign(new Error("401 invalid_api_key selected-stream-sentinel"), { status: 401 }),
			}),
		});
		harness = await createGatewayHarness({
			models: [model],
			credentials: [{ type: "api_key", key: "selected-key" }],
		});
		const [row] = harness.credentialStore.listAuthCredentials("mock");
		if (!row) throw new Error("expected credential row");
		const user = harness.accessStore.createUser({ name: "streaminvalid" });
		const pool = harness.accessStore.createPool({
			name: "streaminvalidpool",
			strategy: "failover",
		});
		harness.accessStore.addPoolCredential(pool.id, row.id);
		await grantModelAccess(harness.accessStore, user.user.id, pool.id);

		const response = await postChat(harness.handle.url, user.token.value, "model-a", true);
		expect(response.status).toBe(200);
		expect(await collectStreamText(response)).toContain("No eligible credential is available for this request");
		const audit = harness.accessStore.listAudit({ userId: user.user.id, limit: 5 }).events[0];
		expect(audit).toMatchObject({
			outcome: "no_eligible_credential",
			statusCode: 503,
			errorCode: "no_eligible_credential",
		});
	});

	test("streaming rejected terminal auth failures emit managed pool exhaustion events", async () => {
		const model = throwingTerminalModel("401 invalid_api_key rejected-stream-sentinel");
		harness = await createGatewayHarness({
			models: [model],
			credentials: [{ type: "api_key", key: "selected-key" }],
		});
		const [row] = harness.credentialStore.listAuthCredentials("mock");
		if (!row) throw new Error("expected credential row");
		const user = harness.accessStore.createUser({ name: "rejectedstreaminvalid" });
		const pool = harness.accessStore.createPool({
			name: "rejectedstreaminvalidpool",
			strategy: "failover",
		});
		harness.accessStore.addPoolCredential(pool.id, row.id);
		await grantModelAccess(harness.accessStore, user.user.id, pool.id);

		const response = await postChat(harness.handle.url, user.token.value, "model-a", true);
		expect(response.status).toBe(200);
		const text = await collectStreamText(response);
		expect(text).toContain("No eligible credential is available for this request");
		expect(text).not.toContain("rejected-stream-sentinel");
		const audit = harness.accessStore.listAudit({ userId: user.user.id, limit: 5 }).events[0];
		expect(audit).toMatchObject({
			outcome: "no_eligible_credential",
			statusCode: 503,
			errorCode: "no_eligible_credential",
		});
	});

	test("pi-native streaming terminal auth failures emit managed pool exhaustion events", async () => {
		const model = createMockModel({
			id: "model-a",
			handler: () => ({
				throw: Object.assign(new Error("401 invalid_api_key pi-native-stream-selected-sentinel"), {
					status: 401,
				}),
			}),
		});
		harness = await createGatewayHarness({
			models: [model],
			credentials: [{ type: "api_key", key: "selected-key" }],
		});
		const [row] = harness.credentialStore.listAuthCredentials("mock");
		if (!row) throw new Error("expected credential row");
		const user = harness.accessStore.createUser({ name: "pinativestreaminvalid" });
		const pool = harness.accessStore.createPool({
			name: "pinativestreaminvalidpool",
			strategy: "failover",
		});
		harness.accessStore.addPoolCredential(pool.id, row.id);
		await grantModelAccess(harness.accessStore, user.user.id, pool.id);

		const response = await fetch(`${harness.handle.url}/v1/pi/stream`, {
			method: "POST",
			headers: jsonHeaders(user.token.value),
			body: JSON.stringify({
				modelId: "model-a",
				stream: true,
				context: { systemPrompt: ["test"], messages: [{ role: "user", content: "hello", timestamp: 0 }] },
			}),
		});
		expect(response.status).toBe(200);
		expect(await collectStreamText(response)).toContain("No eligible credential is available for this request");
		const audit = harness.accessStore.listAudit({ userId: user.user.id, limit: 5 }).events[0];
		expect(audit).toMatchObject({
			routeFamily: "pi-native",
			outcome: "no_eligible_credential",
			statusCode: 503,
			errorCode: "no_eligible_credential",
		});
	});

	test("legacy pi-native terminal auth failures keep their upstream error", async () => {
		const model = createMockModel({
			id: "model-a",
			handler: () => ({
				throw: Object.assign(new Error("401 invalid_api_key legacy-pi-native-sentinel"), { status: 401 }),
			}),
		});
		harness = await createGatewayHarness({
			models: [model],
			credentials: [{ type: "api_key", key: "legacy-key" }],
		});

		const response = await postPiNative(harness.handle.url, "legacy-token");
		const text = await response.text();
		expect(text).toContain("legacy-pi-native-sentinel");
		expect(text).not.toContain("No eligible credential is available for this request");
	});

	test("returns 503 when a bound pool has no live provider-matching members", async () => {
		harness = await createGatewayHarness({ credentials: [{ type: "api_key", key: "other" }] });
		const user = harness.accessStore.createUser({ name: "emptylive" });
		const pool = harness.accessStore.createPool({ name: "emptypool" });
		await grantModelAccess(harness.accessStore, user.user.id, pool.id);
		const response = await postChat(harness.handle.url, user.token.value);
		expect(response.status).toBe(503);
		expect(await response.text()).toContain("no_eligible_credential");
	});
});
