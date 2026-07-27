import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

function stdoutCommand(value: string): string {
	return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`process.stdout.write(${JSON.stringify(value)})`)}`;
}

function fileCommand(filePath: string): string {
	const script = `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(filePath)}, "utf8"))`;
	return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(script)}`;
}

describe("ModelRegistry command-resolved models.yml values", () => {
	let tempDir = "";
	let authStorage: AuthStorage;
	let modelsPath = "";

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `pi-test-model-command-values-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		modelsPath = path.join(tempDir, "models.json");
		authStorage = await AuthStorage.create(":memory:");
	});

	afterEach(() => {
		authStorage.close();
		if (!tempDir || !fs.existsSync(tempDir)) return;
		try {
			removeSyncWithRetries(tempDir);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
		}
	});

	test("provider apiKey and headers resolve from command stdout", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					anthropic: {
						baseUrl: "https://anthropic-proxy.example.com/v1",
						apiKey: `!${stdoutCommand("cmd-api-key")}`,
						authHeader: true,
						headers: { "X-Api-Key": `!${stdoutCommand("cmd-header")}` },
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath);
		const models = registry.getAll().filter(model => model.provider === "anthropic");

		expect(models.length).toBeGreaterThan(1);
		for (const model of models) {
			expect(model.headers?.Authorization).toBe("Bearer cmd-api-key");
			expect(model.headers?.["X-Api-Key"]).toBe("cmd-header");
		}
		expect(await registry.getApiKey(models[0])).toBe("cmd-api-key");
	});

	test("modelOverrides headers resolve from command stdout", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: `!${stdoutCommand("cmd-api-key")}`,
						authHeader: true,
						models: [{ id: "custom-model", name: "Custom Model" }],
						modelOverrides: {
							"custom-model": { headers: { "X-Model-Key": `!${stdoutCommand("cmd-model-header")}` } },
						},
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("custom-proxy", "custom-model");

		expect(model).toBeDefined();
		expect(model?.headers?.["X-Model-Key"]).toBe("cmd-model-header");
		expect(model?.headers?.Authorization).toBe("Bearer cmd-api-key");
	});

	test("provider refresh rereads a rotated command-backed API key", async () => {
		const tokenPath = path.join(tempDir, "gateway.token");
		fs.writeFileSync(tokenPath, "token-a");
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"gateway-proxy": {
						baseUrl: "https://gateway.example.com",
						apiKey: `!${fileCommand(tokenPath)}`,
						transport: "pi-native",
						discovery: { type: "proxy" },
					},
				},
			}),
		);

		const authorizations: string[] = [];
		const fetchMock: FetchImpl = async (input, init) => {
			const url = String(input);
			if (url !== "https://gateway.example.com/v1/models") return new Response(null, { status: 404 });
			authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
			return Response.json({ data: [{ id: "openai-codex/test-model" }] });
		};
		const registry = new ModelRegistry(authStorage, modelsPath, { fetch: fetchMock });

		await registry.refresh("online");
		expect(authorizations.at(-1)).toBe("Bearer token-a");

		fs.writeFileSync(tokenPath, "token-b");
		await registry.refreshProvider("gateway-proxy", "online");

		expect(authorizations.at(-1)).toBe("Bearer token-b");
		const model = registry.find("gateway-proxy", "openai-codex/test-model");
		expect(model).toBeDefined();
		expect(await registry.getApiKey(model!)).toBe("token-b");
	});

	test("successful command-backed API keys expire in open registries", async () => {
		let now = 1_000;
		const nowSpy = spyOn(Date, "now").mockImplementation(() => now);
		try {
			const tokenPath = path.join(tempDir, "rotating.token");
			fs.writeFileSync(tokenPath, "token-a");
			fs.writeFileSync(
				modelsPath,
				JSON.stringify({
					providers: {
						"gateway-proxy": {
							baseUrl: "https://gateway.example.com",
							apiKey: `!${fileCommand(tokenPath)}`,
							authHeader: true,
							transport: "pi-native",
							models: [{ id: "test-model", api: "openai-completions" }],
						},
					},
				}),
			);

			const registry = new ModelRegistry(authStorage, modelsPath);
			const model = registry.find("gateway-proxy", "test-model");
			expect(model).toBeDefined();
			expect(await registry.getApiKey(model!)).toBe("token-a");
			expect(model?.headers?.Authorization).toBe("Bearer token-a");

			fs.writeFileSync(tokenPath, "token-b");
			expect(await registry.getApiKey(model!)).toBe("token-a");

			now += 30_001;
			expect(await registry.getApiKey(model!)).toBe("token-b");
			expect(model?.headers?.Authorization).toBe("Bearer token-b");
		} finally {
			nowSpy.mockRestore();
		}
	});

	test("successful command-backed provider headers expire in open registries", () => {
		let now = 1_000;
		const nowSpy = spyOn(Date, "now").mockImplementation(() => now);
		try {
			const headerPath = path.join(tempDir, "rotating-header.token");
			fs.writeFileSync(headerPath, "header-a");
			fs.writeFileSync(
				modelsPath,
				JSON.stringify({
					providers: {
						"header-proxy": {
							baseUrl: "https://gateway.example.com",
							auth: "none",
							headers: { "X-Gateway-Key": `!${fileCommand(headerPath)}` },
							models: [{ id: "test-model", api: "openai-completions" }],
						},
					},
				}),
			);

			const registry = new ModelRegistry(authStorage, modelsPath);
			const model = registry.find("header-proxy", "test-model");
			expect(model?.headers?.["X-Gateway-Key"]).toBe("header-a");

			fs.writeFileSync(headerPath, "header-b");
			expect(model?.headers?.["X-Gateway-Key"]).toBe("header-a");

			now += 30_001;
			expect(model?.headers?.["X-Gateway-Key"]).toBe("header-b");
		} finally {
			nowSpy.mockRestore();
		}
	});

	test("pi-native providers replace stale cached Authorization after command-key rotation", async () => {
		const tokenPath = path.join(tempDir, "cached-gateway.token");
		fs.writeFileSync(tokenPath, "token-a");
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"gateway-proxy": {
						baseUrl: "https://gateway.example.com",
						apiKey: `!${fileCommand(tokenPath)}`,
						discovery: { type: "proxy" },
					},
				},
			}),
		);
		const cacheUpdatedAt = Math.floor(fs.statSync(modelsPath).mtimeMs) + 1_000;
		writeModelCache(
			"gateway-proxy",
			cacheUpdatedAt,
			[
				buildModel({
					id: "test-model",
					name: "Test Model",
					api: "openai-completions",
					provider: "gateway-proxy",
					baseUrl: "https://gateway.example.com",
					transport: "pi-native",
					headers: { Authorization: "Bearer token-a" },
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 4_096,
				}),
			],
			true,
			"",
			path.join(tempDir, "models.db"),
		);

		let now = cacheUpdatedAt + 1_000;
		const nowSpy = spyOn(Date, "now").mockImplementation(() => now);
		try {
			const registry = new ModelRegistry(authStorage, modelsPath);
			const model = registry.find("gateway-proxy", "test-model");
			expect(model).toBeDefined();
			expect(model?.headers?.Authorization).toBe("Bearer token-a");

			fs.writeFileSync(tokenPath, "token-b");
			now += 30_001;

			expect(await registry.getApiKey(model!)).toBe("token-b");
			expect(model?.headers?.Authorization).toBe("Bearer token-b");
		} finally {
			nowSpy.mockRestore();
		}
	});

	test("authHeader false removes stale cached Authorization", async () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"gateway-proxy": {
						baseUrl: "https://gateway.example.com",
						apiKey: `!${stdoutCommand("token-b")}`,
						authHeader: false,
						transport: "pi-native",
						discovery: { type: "proxy" },
					},
				},
			}),
		);
		const cacheUpdatedAt = Math.floor(fs.statSync(modelsPath).mtimeMs) + 1_000;
		writeModelCache(
			"gateway-proxy",
			cacheUpdatedAt,
			[
				buildModel({
					id: "test-model",
					name: "Test Model",
					api: "openai-completions",
					provider: "gateway-proxy",
					baseUrl: "https://gateway.example.com",
					transport: "pi-native",
					headers: { Authorization: "Bearer token-a" },
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 128_000,
					maxTokens: 4_096,
				}),
			],
			true,
			"",
			path.join(tempDir, "models.db"),
		);

		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("gateway-proxy", "test-model");
		expect(model).toBeDefined();
		expect(await registry.getApiKey(model!)).toBe("token-b");
		expect(model?.headers?.Authorization).toBeUndefined();
	});

	test("explicit provider Authorization wins over implicit pi-native API key auth", () => {
		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"gateway-proxy": {
						baseUrl: "https://gateway.example.com",
						apiKey: `!${stdoutCommand("token-a")}`,
						headers: { Authorization: "Bearer explicit" },
						transport: "pi-native",
						models: [{ id: "test-model", api: "openai-completions" }],
					},
				},
			}),
		);

		const registry = new ModelRegistry(authStorage, modelsPath);
		const model = registry.find("gateway-proxy", "test-model");
		expect(model).toBeDefined();
		expect(model?.headers?.Authorization).toBe("Bearer explicit");
	});

	test("resolveCommandConfig caches failed executions so they do not retry", async () => {
		const counterFile = path.join(tempDir, "counter.txt");
		fs.writeFileSync(counterFile, "0");

		// Command increments a counter and then fails (exit 1).
		const trackingCommand = `node -e "const fs=require('fs'); fs.writeFileSync('${counterFile.replace(/\\/g, "/")}', String(Number(fs.readFileSync('${counterFile.replace(/\\/g, "/")}', 'utf8')) + 1)); process.exit(1);"`;

		fs.writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"custom-proxy": {
						baseUrl: "https://custom-proxy.example.com/v1",
						api: "openai-completions",
						apiKey: `!${trackingCommand}`,
					},
				},
			}),
		);

		// Init triggers the first command resolution.
		const registry = new ModelRegistry(authStorage, modelsPath);

		const dummyModel: Model<Api> = buildModel({
			id: "foo",
			name: "foo",
			api: "openai-completions",
			provider: "custom-proxy",
			baseUrl: "a",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 4096,
			maxTokens: 1024,
		});

		// Trigger the fallback resolver which also calls resolveConfigValue.
		await registry.getApiKey(dummyModel);

		// Another call to ensure it hits cache multiple times.
		await registry.getApiKey(dummyModel);

		// The command should have only run once.
		expect(fs.readFileSync(counterFile, "utf8")).toBe("1");
	});
});
