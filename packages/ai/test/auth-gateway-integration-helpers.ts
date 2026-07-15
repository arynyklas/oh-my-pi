import { expect } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import {
	type AuthGatewayServerHandle,
	SqliteAuthGatewayAccessStore,
	startAuthGateway,
} from "@oh-my-pi/pi-ai/auth-gateway";
import { type AuthCredential, AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth-storage";
import { createMockModel, type MockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import { removeWithRetries } from "../../utils/src/temp";

export interface GatewayHarness {
	tempDir: string;
	credentialStore: SqliteAuthCredentialStore;
	storage: AuthStorage;
	accessStore: SqliteAuthGatewayAccessStore;
	models: Map<string, MockModel>;
	handle: AuthGatewayServerHandle;
}

export interface GatewayHarnessOptions {
	bearerTokens?: string[];
	models?: MockModel[];
	credentials?: AuthCredential[];
	keylessProviders?: string[];
}

export function jsonHeaders(token?: string): Record<string, string> {
	return {
		"content-type": "application/json",
		...(token ? { authorization: `Bearer ${token}` } : {}),
	};
}

export async function createGatewayHarness(options: GatewayHarnessOptions = {}): Promise<GatewayHarness> {
	registerMockApi();
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-auth-gateway-step4-"));
	const credentialStore = await SqliteAuthCredentialStore.open(path.join(tempDir, "credentials.db"));
	credentialStore.replaceAuthCredentialsForProvider(
		"mock",
		options.credentials ?? [{ type: "api_key", key: "key-a" }],
	);
	const storage = new AuthStorage(credentialStore);
	await storage.reload();
	const accessStore = await SqliteAuthGatewayAccessStore.open(path.join(tempDir, "access.db"));
	const models = new Map<string, MockModel>();
	const modelById = new Map<string, MockModel>();
	for (const model of options.models ?? [
		createMockModel({
			provider: "mock",
			id: "model-a",
			handler: (_ctx, opts) => ({ content: [`key:${typeof opts?.apiKey === "string" ? opts.apiKey : "none"}`] }),
		}),
	]) {
		models.set(model.id, model);
		modelById.set(`${model.provider}/${model.id}`, model);
		if (!modelById.has(model.id)) modelById.set(model.id, model);
	}
	const handle = startAuthGateway({
		bind: "127.0.0.1:0",
		bearerTokens: options.bearerTokens ?? ["legacy-token"],
		accessStore,
		storage,
		resolveModel: id => modelById.get(id)?.model as Model<Api> | undefined,
		listModels: () => Array.from(modelById.values()).map(model => model.model),
		isKeylessModel: model => options.keylessProviders?.includes(model.provider) ?? false,
	});
	return { tempDir, credentialStore, storage, accessStore, models, handle };
}

export async function closeGatewayHarness(harness: GatewayHarness | undefined): Promise<void> {
	if (!harness) return;
	await harness.handle.close();
	await Bun.sleep(25);
	harness.storage.close();
	harness.accessStore.close();
	clearCustomApis();
	Bun.gc(true);
	await Bun.sleep(100);
	await removeWithRetries(harness.tempDir);
}

export async function readJson(response: Response): Promise<unknown> {
	return response.json() as Promise<unknown>;
}

export function expectObject(value: unknown): Record<string, unknown> {
	expect(value).toBeObject();
	return value as Record<string, unknown>;
}

export async function postChat(
	baseUrl: string,
	token: string | undefined,
	model = "model-a",
	stream = false,
): Promise<Response> {
	return fetch(`${baseUrl}/v1/chat/completions`, {
		method: "POST",
		headers: jsonHeaders(token),
		body: JSON.stringify({ model, stream, messages: [{ role: "user", content: "hello" }] }),
	});
}

export async function postPiNative(baseUrl: string, token: string | undefined, model = "model-a"): Promise<Response> {
	return fetch(`${baseUrl}/v1/pi/stream`, {
		method: "POST",
		headers: jsonHeaders(token),
		body: JSON.stringify({
			modelId: model,
			stream: false,
			context: { systemPrompt: ["test"], messages: [{ role: "user", content: "hello", timestamp: 0 }] },
		}),
	});
}

export async function grantModelAccess(
	store: SqliteAuthGatewayAccessStore,
	userId: number,
	poolId: number,
	model = "mock/model-a",
): Promise<void> {
	store.addAclRule(userId, { effect: "allow", kind: "route", pattern: "chat" });
	store.addAclRule(userId, { effect: "allow", kind: "route", pattern: "pi-native" });
	store.addAclRule(userId, { effect: "allow", kind: "route", pattern: "models" });
	store.addAclRule(userId, { effect: "allow", kind: "route", pattern: "usage" });
	store.addAclRule(userId, { effect: "allow", kind: "route", pattern: "check" });
	store.addAclRule(userId, { effect: "allow", kind: "provider", pattern: "mock" });
	store.addAclRule(userId, { effect: "allow", kind: "model", pattern: model });
	store.bindUserPool(userId, poolId);
}
