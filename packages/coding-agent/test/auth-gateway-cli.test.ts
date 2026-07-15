import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type {
	AuthGatewayAdminClient,
	AuthGatewayAdminStatus,
	AuthGatewayAuditEvent,
} from "@oh-my-pi/pi-ai/auth-gateway";
import { SqliteAuthGatewayAccessStore } from "@oh-my-pi/pi-ai/auth-gateway";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { writeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { AuthGatewayProfileStore } from "@oh-my-pi/pi-coding-agent/auth-gateway/profiles";
import {
	runAuthGatewayTuiWithDependencies,
	showAuthGatewayConsoleOverlay,
} from "@oh-my-pi/pi-coding-agent/auth-gateway/run-tui";
import {
	type AuthGatewayAction,
	type AuthGatewayCommandArgs,
	type AuthGatewayCommandDependencies,
	buildAuthGatewayModelIndex,
	runAuthGatewayCommand,
} from "@oh-my-pi/pi-coding-agent/cli/auth-gateway-cli";
import AuthGatewayCommand from "@oh-my-pi/pi-coding-agent/commands/auth-gateway";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import type { Component, OverlayHandle, TUI } from "@oh-my-pi/pi-tui";
import { getConfigRootDir, removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

const ORIGINAL_STDOUT_WRITE = process.stdout.write.bind(process.stdout);

function captureStdout(): () => string {
	let captured = "";
	process.stdout.write = ((chunk: string | Uint8Array): boolean => {
		captured += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
		return true;
	}) as typeof process.stdout.write;
	return () => captured;
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

async function expectJsonCommand<T>(cmd: AuthGatewayCommandArgs, deps: AuthGatewayCommandDependencies): Promise<T> {
	const restore = captureStdout();
	try {
		await runAuthGatewayCommand(cmd, deps);
		const lines = restore().trim().split(/\n+/).filter(Boolean);
		expect(lines).toHaveLength(1);
		return JSON.parse(lines[0]!) as T;
	} finally {
		process.stdout.write = ORIGINAL_STDOUT_WRITE;
	}
}

async function expectHumanCommand(cmd: AuthGatewayCommandArgs, deps: AuthGatewayCommandDependencies): Promise<string> {
	const restore = captureStdout();
	try {
		await runAuthGatewayCommand(cmd, deps);
		return restore();
	} finally {
		process.stdout.write = ORIGINAL_STDOUT_WRITE;
	}
}

function createFakeTui(): {
	ui: TUI;
	getOverlay(): Component | undefined;
	hideCalls: Component[];
	focusCalls: Array<Component | null>;
	requestRenderCalls: number[];
	overlayShown: Promise<Component>;
} {
	const overlayShown = Promise.withResolvers<Component>();
	let overlayComponent: Component | undefined;
	const hideCalls: Component[] = [];
	const focusCalls: Array<Component | null> = [];
	const requestRenderCalls: number[] = [];
	const ui = {
		terminal: {
			rows: 24,
			columns: 100,
			hideCursor(): void {},
		},
		showOverlay(component: Component): OverlayHandle {
			overlayComponent = component;
			overlayShown.resolve(component);
			return {
				hide(): void {
					hideCalls.push(component);
					overlayComponent = undefined;
				},
				setHidden(): void {},
				isHidden(): boolean {
					return false;
				},
			};
		},
		setFocus(component: Component | null): void {
			focusCalls.push(component);
		},
		requestRender(): void {
			requestRenderCalls.push(1);
		},
	} as unknown as TUI;
	return {
		ui,
		getOverlay: () => overlayComponent,
		hideCalls,
		focusCalls,
		requestRenderCalls,
		overlayShown: overlayShown.promise,
	};
}

function createReadyGatewayClient(): AuthGatewayAdminClient {
	return {
		status: async () => ({
			ok: true,
			version: "test",
			serverTime: 1,
			principal: { kind: "managed", userId: 1, name: "admin", role: "admin", tokenId: 1 },
			counts: { users: 0, activeTokens: 0, pools: 0, credentials: 0 },
		}),
	} as unknown as AuthGatewayAdminClient;
}

function createHangingGatewayClient(onAbort: () => void): AuthGatewayAdminClient {
	return {
		status: (signal?: AbortSignal) => {
			signal?.addEventListener("abort", onAbort, { once: true });
			return Promise.withResolvers<AuthGatewayAdminStatus>().promise;
		},
	} as unknown as AuthGatewayAdminClient;
}

async function createTempProfileStore(root: string): Promise<AuthGatewayProfileStore> {
	const store = AuthGatewayProfileStore.open({
		documentPath: path.join(root, "auth-gateways.json"),
		tokenDir: path.join(root, "tokens"),
	});
	process.env.OMP_TASK7_GATEWAY_TOKEN = "admin-token";
	await store.upsert({
		name: "prod",
		url: "http://127.0.0.1:4000",
		tokenSource: { type: "env", variable: "OMP_TASK7_GATEWAY_TOKEN" },
	});
	return store;
}

async function expectCommandError(
	cmd: AuthGatewayCommandArgs,
	deps: AuthGatewayCommandDependencies,
	message: string,
): Promise<void> {
	const restore = captureStdout();
	try {
		await expect(runAuthGatewayCommand(cmd, deps)).rejects.toThrow(message);
		expect(restore()).not.toContain("token_hash");
	} finally {
		process.stdout.write = ORIGINAL_STDOUT_WRITE;
	}
}

interface SurplusPositionalCase {
	name: string;
	argv: readonly string[];
	message: string;
}

const SURPLUS_POSITIONAL_CASES: readonly SurplusPositionalCase[] = [
	{
		name: "token garbage",
		argv: ["token", "garbage"],
		message: "Unexpected positional argument(s) for auth-gateway token: garbage",
	},
	{
		name: "status garbage",
		argv: ["status", "garbage"],
		message: "Unexpected positional argument(s) for auth-gateway status: garbage",
	},
	{
		name: "check garbage",
		argv: ["check", "garbage"],
		message: "Unexpected positional argument(s) for auth-gateway check: garbage",
	},
	{
		name: "user list alice",
		argv: ["user", "list", "alice"],
		message: "Unexpected positional argument(s) for auth-gateway user list: alice",
	},
	{
		name: "user create alice bob",
		argv: ["user", "create", "alice", "bob"],
		message: "Unexpected positional argument(s) for auth-gateway user create: bob",
	},
	{
		name: "user reorder-pools alice 1,2 extra",
		argv: ["user", "reorder-pools", "alice", "1,2", "extra"],
		message: "Unexpected positional argument(s) for auth-gateway user reorder-pools: extra",
	},
	{
		name: "pool list primary",
		argv: ["pool", "list", "primary"],
		message: "Unexpected positional argument(s) for auth-gateway pool list: primary",
	},
	{
		name: "audit list extra",
		argv: ["audit", "list", "extra"],
		message: "Unexpected positional argument(s) for auth-gateway audit list: extra",
	},
	{
		name: "tui prod positional",
		argv: ["tui", "prod"],
		message: "Unexpected positional argument(s) for auth-gateway tui: prod",
	},
	{
		name: "user token-revoke alice 1 extra",
		argv: ["user", "token-revoke", "alice", "1", "extra"],
		message: "Unexpected positional argument(s) for auth-gateway user token-revoke: extra",
	},
];

function authGatewayCommandFromPositionals(
	positionals: readonly string[],
): AuthGatewayCommandArgs & { positionals: readonly string[] } {
	const [action, subaction, target, value] = positionals;
	if (!action) throw new Error("test command missing action");
	return {
		action: action as AuthGatewayAction,
		subaction,
		target,
		value,
		positionals,
		flags: { json: true },
	};
}

async function authGatewayCommandFromParser(
	argv: readonly string[],
): Promise<AuthGatewayCommandArgs & { positionals: readonly string[] }> {
	const command = new AuthGatewayCommand([...argv], { bin: "omp", version: "0.0.0-test", commands: new Map() });
	const parsed = await command.parse(AuthGatewayCommand);
	if (!parsed.args.action) throw new Error("test parser command missing action");
	return {
		action: parsed.args.action as AuthGatewayAction,
		subaction: parsed.args.subaction,
		target: parsed.args.target,
		value: parsed.args.value,
		positionals: parsed.argv,
		flags: {
			json: parsed.flags.json,
			bind: parsed.flags.bind,
			regenerate: parsed.flags.regenerate,
			description: parsed.flags.description,
			owner: parsed.flags.owner,
			role: parsed.flags.role,
			label: parsed.flags.label,
			provider: parsed.flags.provider,
			model: parsed.flags.model,
			route: parsed.flags.route,
			strategy: parsed.flags.strategy,
			since: parsed.flags.since,
			limit: parsed.flags.limit,
			user: parsed.flags.user,
			before: parsed.flags.before,
			connection: parsed.flags.connection,
			noAuth: parsed.flags["no-auth"],
			strict: parsed.flags.strict,
		},
	};
}

async function pathExists(filePath: string): Promise<boolean> {
	return fs
		.stat(filePath)
		.then(() => true)
		.catch(() => false);
}

async function expectUnexpectedPositionalBeforeFiles(
	cmd: AuthGatewayCommandArgs,
	deps: AuthGatewayCommandDependencies,
	message: string,
	tokenFile: string,
	dbPath: string,
): Promise<void> {
	await fs.rm(tokenFile, { force: true });
	await fs.rm(dbPath, { force: true });
	const restore = captureStdout();
	try {
		await expect(runAuthGatewayCommand(cmd, deps)).rejects.toThrow(message);
		expect(restore()).toBe("");
	} finally {
		process.stdout.write = ORIGINAL_STDOUT_WRITE;
	}
	expect(await pathExists(tokenFile)).toBe(false);
	expect(await pathExists(dbPath)).toBe(false);
}

function expectExactKeys(value: Record<string, unknown>, keys: string[]): void {
	expect(Object.keys(value).sort()).toEqual([...keys].sort());
}

async function withStore<T>(dbPath: string, fn: (store: SqliteAuthGatewayAccessStore) => T | Promise<T>): Promise<T> {
	const store = await SqliteAuthGatewayAccessStore.open(dbPath);
	try {
		return await fn(store);
	} finally {
		store.close();
	}
}

function userCommand(
	subaction: string,
	target?: string,
	value?: string,
	flags: AuthGatewayCommandArgs["flags"] = {},
): AuthGatewayCommandArgs {
	return { action: "user", subaction, target, value, flags: { json: true, ...flags } };
}

function poolCommand(
	subaction: string,
	target?: string,
	value?: string,
	flags: AuthGatewayCommandArgs["flags"] = {},
): AuthGatewayCommandArgs {
	return { action: "pool", subaction, target, value, flags: { json: true, ...flags } };
}

interface TestInputComponent extends Component {
	handleInput(data: string): void;
}

function requireInputComponent(component: Component | undefined): TestInputComponent {
	const candidate = component as { handleInput?: unknown } | undefined;
	if (typeof candidate?.handleInput !== "function") throw new Error("Expected focused auth-gateway component");
	return component as TestInputComponent;
}

describe("auth-gateway TUI entrypoint", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auth-gateway-tui-entry-"));
		delete process.env.OMP_TASK7_GATEWAY_TOKEN;
	});

	afterEach(async () => {
		delete process.env.OMP_TASK7_GATEWAY_TOKEN;
		vi.restoreAllMocks();
		if (tempDir) await removeWithRetries(tempDir);
	});

	test("parses standalone tui connection flag without treating it as an outer profile", async () => {
		const cmd = await authGatewayCommandFromParser(["tui", "--connection=prod"]);

		expect(cmd.action).toBe("tui");
		expect(cmd.positionals).toEqual(["tui"]);
		expect(cmd.flags.connection).toBe("prod");
	});

	test("dispatches tui action to the standalone runner without retargeting local commands", async () => {
		const runTui = vi.fn(async () => {});

		await runAuthGatewayCommand({ action: "tui", flags: { connection: "prod" } }, { runTui });

		expect(runTui).toHaveBeenCalledTimes(1);
		expect(runTui).toHaveBeenCalledWith({ connection: "prod" });
	});

	test("opens onboarding when no active connection is configured", async () => {
		const harness = createFakeTui();
		const store = AuthGatewayProfileStore.open({
			documentPath: path.join(tempDir, "empty-auth-gateways.json"),
			tokenDir: path.join(tempDir, "empty-tokens"),
		});
		const closed = showAuthGatewayConsoleOverlay({
			ui: harness.ui,
			profileStore: store,
			createClient: () => createReadyGatewayClient(),
			afterClose: () => harness.focusCalls.push(null),
		});

		const onboarding = requireInputComponent(await harness.overlayShown);
		expect(onboarding.constructor.name).toBe("GatewayProfileSettingsComponent");

		onboarding.handleInput("\x1b");
		await closed;
		expect(harness.hideCalls).toHaveLength(1);
		expect(harness.focusCalls.at(-1)).toBeNull();
	});

	test("rejects an unknown requested connection before opening a console", async () => {
		const harness = createFakeTui();
		const store = AuthGatewayProfileStore.open({
			documentPath: path.join(tempDir, "unknown-auth-gateways.json"),
			tokenDir: path.join(tempDir, "unknown-tokens"),
		});

		await expect(
			showAuthGatewayConsoleOverlay({
				ui: harness.ui,
				profileStore: store,
				connection: "prod",
				createClient: () => createReadyGatewayClient(),
			}),
		).rejects.toThrow("Unknown auth-gateway connection: prod");
		expect(harness.getOverlay()).toBeUndefined();
	});

	test("stops the standalone TUI after a normal console close", async () => {
		const harness = createFakeTui();
		const store = await createTempProfileStore(tempDir);
		const start = vi.fn();
		const stop = vi.fn();
		const running = runAuthGatewayTuiWithDependencies({
			ui: harness.ui,
			profileStore: store,
			connection: "prod",
			createClient: () => createReadyGatewayClient(),
			openInBrowser: () => {},
			start,
			stop,
		});

		expect(start).toHaveBeenCalledTimes(1);
		requireInputComponent(await harness.overlayShown).handleInput("\x1b");
		await running;

		expect(stop).toHaveBeenCalledTimes(1);
		expect(harness.hideCalls).toHaveLength(1);
	});

	test("stops the standalone TUI when closed during the initial status load", async () => {
		const harness = createFakeTui();
		const store = await createTempProfileStore(tempDir);
		const start = vi.fn();
		const stop = vi.fn();
		const abortObserved = vi.fn();
		const running = runAuthGatewayTuiWithDependencies({
			ui: harness.ui,
			profileStore: store,
			connection: "prod",
			createClient: () => createHangingGatewayClient(abortObserved),
			openInBrowser: () => {},
			start,
			stop,
		});

		expect(start).toHaveBeenCalledTimes(1);
		requireInputComponent(await harness.overlayShown).handleInput("\x1b");

		let outcome: "closed" | "pending" | "rejected" = "pending";
		let rejection: unknown;
		void running.then(
			() => {
				outcome = "closed";
			},
			error => {
				outcome = "rejected";
				rejection = error;
			},
		);
		await flushMicrotasks();

		if (rejection) throw rejection;

		expect(outcome as string).toBe("closed");
		expect(abortObserved).toHaveBeenCalledTimes(1);
		expect(stop).toHaveBeenCalledTimes(1);
		expect(harness.hideCalls).toHaveLength(1);
		expect(harness.getOverlay()).toBeUndefined();
	});

	test("stops the standalone TUI on startup error", async () => {
		const harness = createFakeTui();
		const store = await createTempProfileStore(tempDir);
		const stop = vi.fn();

		await expect(
			runAuthGatewayTuiWithDependencies({
				ui: harness.ui,
				profileStore: store,
				connection: "prod",
				createClient: () => {
					throw new Error("startup failed");
				},
				openInBrowser: () => {},
				start: () => {},
				stop,
			}),
		).rejects.toThrow("startup failed");

		expect(stop).toHaveBeenCalledTimes(1);
		expect(harness.getOverlay()).toBeUndefined();
	});
});

describe("auth-gateway CLI access management", () => {
	let agentDir = "";
	let dbPath = "";
	let originalAgentDir: string | undefined;
	let fallbackAgentDir = "";
	let deps: AuthGatewayCommandDependencies;
	let tokenFile = "";
	let originalTokenContent: string | null = null;

	beforeEach(async () => {
		process.exitCode = 0;
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		fallbackAgentDir = path.join(getConfigRootDir(), "agent");
		tokenFile = path.join(getConfigRootDir(), "auth-gateway.token");
		originalTokenContent = await Bun.file(tokenFile)
			.text()
			.catch(() => null);
		agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-auth-gateway-cli-"));
		setAgentDir(agentDir);
		dbPath = path.join(agentDir, "auth-gateway.db");
		deps = {
			accessDbPath: dbPath,
			loadBrokerCredentials: async () => [
				{ id: 42, provider: "anthropic", type: "oauth" },
				{ id: 43, provider: "anthropic", type: "api_key" },
				{ id: 7, provider: "openai", type: "api_key" },
			],
		};
	});

	afterEach(async () => {
		process.stdout.write = ORIGINAL_STDOUT_WRITE;
		process.exitCode = 0;
		if (originalTokenContent === null) {
			await fs.rm(tokenFile, { force: true }).catch(() => undefined);
		} else {
			await fs.mkdir(path.dirname(tokenFile), { recursive: true });
			await fs.writeFile(tokenFile, originalTokenContent);
		}

		if (originalAgentDir) {
			setAgentDir(originalAgentDir);
		} else {
			setAgentDir(fallbackAgentDir);
			delete process.env.PI_CODING_AGENT_DIR;
		}
		Bun.gc(true);
		if (agentDir) await removeWithRetries(agentDir);
	});

	test("exposes neutral pool and ACL-specific management command help", () => {
		expect(AuthGatewayCommand.examples.some(example => example.includes("auth-gateway user create"))).toBe(true);
		expect(
			AuthGatewayCommand.examples.some(example => example.includes("auth-gateway pool create primary --strategy=")),
		).toBe(true);
		expect(AuthGatewayCommand.examples.some(example => example.includes("auth-gateway pool add-account"))).toBe(true);
		expect(AuthGatewayCommand.examples.some(example => example.includes("auth-gateway user reorder-pools"))).toBe(
			true,
		);
		expect(AuthGatewayCommand.examples.some(example => example.includes("auth-gateway audit list"))).toBe(true);
		expect(AuthGatewayCommand.examples.some(example => example.includes("auth-gateway pool rename"))).toBe(true);
		expect(AuthGatewayCommand.examples.some(example => example.includes("--before="))).toBe(true);
		expect(AuthGatewayCommand.flags.provider.description).toBe("Provider id for ACL");
		expect(AuthGatewayCommand.flags.model.description).toBe("Model id for ACL");
		expect(AuthGatewayCommand.examples.join("\n")).not.toContain("pool create primary --provider=");
	});

	test("builds the gateway model index from auth-none custom models", async () => {
		const modelsPath = path.join(agentDir, "models.yml");
		await Bun.write(
			modelsPath,
			`providers:
  vllm:
    baseUrl: http://gemma.svc.dmai.internal/v1
    api: openai-completions
    auth: none
    models:
      - id: gemma4:31b
        requestModelId: gemma-4:31b
        name: Gemma 4 31B
        reasoning: false
        input: [text]
        cost:
          input: 0
          output: 0
          cacheRead: 0
          cacheWrite: 0
        contextWindow: 32768
        maxTokens: 32768
`,
		);
		writeModelCache(
			"vllm",
			Date.now(),
			[
				buildModel({
					id: "stale-other-model",
					provider: "vllm",
					api: "openai-completions",
					baseUrl: "http://gemma.svc.dmai.internal/v1",
					name: "Stale other model",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 8192,
					maxTokens: 8192,
				}),
			],
			true,
			"",
			path.join(agentDir, "models.db"),
		);
		const authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
		try {
			const registry = new ModelRegistry(authStorage, modelsPath);
			const index = buildAuthGatewayModelIndex(registry);
			const model = index.resolveModel("vllm/gemma4:31b");
			expect(model?.provider).toBe("vllm");
			expect(model?.id).toBe("gemma4:31b");
			expect(model?.requestModelId).toBe("gemma-4:31b");
			expect(model?.baseUrl).toBe("http://gemma.svc.dmai.internal/v1");
			expect(index.resolveModel("gemma4:31b")).toBe(model);
			expect(index.resolveModel("stale-other-model")).toBeUndefined();
			expect(
				Array.from(index.listModels())
					.filter(listedModel => listedModel.provider === "vllm")
					.map(listedModel => listedModel.id),
			).toEqual(["gemma4:31b"]);
			expect(model ? index.isKeylessModel(model) : false).toBe(true);
		} finally {
			authStorage.close();
		}
	});

	test("rejects surplus positionals from direct dispatch before file side effects", async () => {
		for (const testCase of SURPLUS_POSITIONAL_CASES) {
			await expectUnexpectedPositionalBeforeFiles(
				authGatewayCommandFromPositionals(testCase.argv),
				deps,
				testCase.message,
				tokenFile,
				dbPath,
			);
		}
	});

	test("rejects surplus positionals from parser dispatch before file side effects", async () => {
		for (const testCase of SURPLUS_POSITIONAL_CASES) {
			await expectUnexpectedPositionalBeforeFiles(
				await authGatewayCommandFromParser(testCase.argv),
				deps,
				testCase.message,
				tokenFile,
				dbPath,
			);
		}
	});

	test("prints one-time managed token values in human output only on create, add, and rotate", async () => {
		const created = await expectHumanCommand(
			userCommand("create", "human", undefined, { json: false, label: "initial" }),
			deps,
		);
		const createdMatch = created.match(/^created user human \(#\d+\) token (omp_gw_[^\s]+)\n$/);
		expect(createdMatch).not.toBeNull();
		const initialToken = createdMatch![1]!;

		const added = await expectHumanCommand(
			userCommand("token", "human", undefined, { json: false, label: "second" }),
			deps,
		);
		const addedMatch = added.match(/^created token (omp_gw_[^\s]+) for human\n$/);
		expect(addedMatch).not.toBeNull();
		const addedToken = addedMatch![1]!;

		const rotated = await expectHumanCommand(
			userCommand("token", "human", undefined, { json: false, regenerate: true, label: "rotated" }),
			deps,
		);
		const rotatedMatch = rotated.match(/^rotated token (omp_gw_[^\s]+) for human\n$/);
		expect(rotatedMatch).not.toBeNull();
		const rotatedToken = rotatedMatch![1]!;

		expect(new Set([initialToken, addedToken, rotatedToken]).size).toBe(3);

		const list = await expectHumanCommand(userCommand("list", undefined, undefined, { json: false }), deps);
		const shown = await expectHumanCommand(userCommand("show", "human", undefined, { json: false }), deps);
		const redactedOutput = `${list}${shown}`;
		for (const token of [initialToken, addedToken, rotatedToken]) {
			expect(redactedOutput).not.toContain(token);
		}
		expect(redactedOutput).not.toContain("token_hash");
	});

	test("shows redacted revocation identifiers in human user details without exposing secrets", async () => {
		const created = await expectJsonCommand<{
			user: Record<string, unknown>;
			token: Record<string, unknown>;
		}>(
			userCommand("create", "operator", undefined, {
				description: "secret-project-alpha",
				owner: "private-owner-team",
				label: "initial\toperator\nlabel",
			}),
			deps,
		);
		const tokenId = Number(created.token.id);
		const publicId = String(created.token.publicId);
		const rawToken = String(created.token.value);

		const allow = await expectJsonCommand<{ rule: Record<string, unknown> }>(
			userCommand("allow", "operator", undefined, { provider: "anthropic" }),
			deps,
		);
		const aclRuleId = Number(allow.rule.id);
		const pool = await expectJsonCommand<{ pool: Record<string, unknown> }>(
			poolCommand("create", "primary", undefined, {
				strategy: "failover",
			}),
			deps,
		);
		const poolId = Number(pool.pool.id);
		await expectJsonCommand(poolCommand("add-account", "primary", "42"), deps);
		await expectJsonCommand(userCommand("set-pool", "operator", "primary"), deps);

		const shown = await expectHumanCommand(userCommand("show", "operator", undefined, { json: false }), deps);

		expect(shown).toContain(`user operator (#${created.user.id}) enabled role=user\n`);
		expect(shown).toContain("tokens:\nid\tpublicId\tlabel\tlastUsedAt\trevokedAt\n");
		expect(shown).toContain(`${tokenId}\t${publicId}\tinitial operator label\t-\t-\n`);
		expect(shown).toContain("acl:\nid\teffect\tkind\tpattern\n");
		expect(shown).toContain(`${aclRuleId}\tallow\tprovider\tanthropic\n`);
		expect(shown).toContain("pools:\nposition\tpool\tname\tstrategy\taccounts\n");
		expect(shown).toContain(`0\t${poolId}\tprimary\tfailover\t42\n`);
		expect(shown).not.toContain(rawToken);
		expect(shown).not.toContain("omp_gw_");
		expect(shown).not.toContain("token_hash");
		expect(shown).not.toContain("api_key");
		expect(shown).not.toContain("oauth");
		expect(shown).not.toContain("accessToken");
		expect(shown).not.toContain("refreshToken");
		expect(shown).not.toContain("accountId");
		expect(shown).not.toContain("secret-project-alpha");
		expect(shown).not.toContain("private-owner-team");
	});

	test("pages audit events with --before cursor", async () => {
		const created = await expectJsonCommand<{ user: Record<string, unknown> }>(
			userCommand("create", "auditor"),
			deps,
		);
		const userId = created.user.id as number;
		const [older, newer] = await withStore(dbPath, store => [
			store.recordAudit({
				requestId: "audit-older",
				startedAt: 1_000,
				completedAt: 1_010,
				userId,
				userName: "auditor",
				tokenId: null,
				method: "POST",
				path: "/v1/chat/completions",
				routeFamily: "chat",
				requestedModel: "claude-3-5-sonnet",
				resolvedProvider: "anthropic",
				resolvedModel: "anthropic/claude-3-5-sonnet",
				credentialId: 42,
				outcome: "success",
				statusCode: 200,
				inputTokens: 1,
				outputTokens: 2,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens: 3,
				costUsd: 0.01,
				errorCode: null,
			}),
			store.recordAudit({
				requestId: "audit-newer",
				startedAt: 2_000,
				completedAt: 2_010,
				userId,
				userName: "auditor",
				tokenId: null,
				method: "POST",
				path: "/v1/chat/completions",
				routeFamily: "chat",
				requestedModel: "claude-3-5-sonnet",
				resolvedProvider: "anthropic",
				resolvedModel: "anthropic/claude-3-5-sonnet",
				credentialId: 43,
				outcome: "success",
				statusCode: 200,
				inputTokens: 4,
				outputTokens: 5,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens: 9,
				costUsd: 0.02,
				errorCode: null,
			}),
		]);

		const firstPage = await expectJsonCommand<{ events: Array<Record<string, unknown>>; nextBefore: number | null }>(
			{ action: "audit", subaction: "list", flags: { json: true, user: "auditor", limit: "1" } },
			deps,
		);
		expect(firstPage.events.map(event => event.id)).toEqual([newer.id]);
		expect(firstPage.nextBefore).toBe(newer.id);

		const secondPage = await expectJsonCommand<{ events: Array<Record<string, unknown>>; nextBefore: number | null }>(
			{
				action: "audit",
				subaction: "list",
				flags: { json: true, user: "auditor", limit: "1", before: String(firstPage.nextBefore) },
			},
			deps,
		);
		expect(secondPage.events.map(event => event.id)).toEqual([older.id]);
		expect(secondPage.nextBefore).toBe(older.id);

		const emptyPage = await expectJsonCommand<{ events: Array<Record<string, unknown>>; nextBefore: number | null }>(
			{ action: "audit", subaction: "list", flags: { json: true, user: "auditor", before: String(older.id) } },
			deps,
		);
		expect(emptyPage).toEqual({ events: [], nextBefore: null });

		await expectCommandError(
			{ action: "audit", subaction: "list", flags: { json: true, before: "0" } },
			deps,
			"--before must be a positive integer",
		);
		await expectCommandError(
			{ action: "audit", subaction: "list", flags: { json: true, before: "abc" } },
			deps,
			"--before must be a positive integer",
		);
	});

	test("renames pools without dropping members and supports JSON and human output", async () => {
		const user = await expectJsonCommand<{ user: Record<string, unknown> }>(userCommand("create", "pooluser"), deps);
		const pool = await expectJsonCommand<{ pool: Record<string, unknown> }>(
			poolCommand("create", "primary", undefined, {
				strategy: "round-robin",
			}),
			deps,
		);
		const poolId = pool.pool.id as number;
		await expectJsonCommand(poolCommand("add-account", "primary", "42"), deps);
		await expectJsonCommand(poolCommand("add-account", "primary", "7"), deps);
		await expectJsonCommand(userCommand("set-pool", String(user.user.id), "primary"), deps);

		const renamed = await expectJsonCommand<{ pool: Record<string, unknown> }>(
			poolCommand("rename", "primary", "primary-renamed"),
			deps,
		);
		expect(renamed.pool).toMatchObject({
			id: poolId,
			name: "primary-renamed",
			strategy: "round-robin",
			members: [
				{ credentialId: 42, position: 0 },
				{ credentialId: 7, position: 1 },
			],
		});
		const shownUser = await expectJsonCommand<{ poolBindings: Array<Record<string, unknown>> }>(
			userCommand("show", "pooluser"),
			deps,
		);
		expect(shownUser.poolBindings).toHaveLength(1);
		expect(shownUser.poolBindings[0]).toMatchObject({ poolId, pool: { id: poolId, name: "primary-renamed" } });
		await expectCommandError(poolCommand("show", "primary"), deps, "pool not found");
		await expectCommandError(poolCommand("rename", "primary-renamed"), deps, "Missing new pool name");

		const human = await expectHumanCommand(
			poolCommand("rename", "primary-renamed", "primary-human", { json: false }),
			deps,
		);
		expect(human).toBe(`renamed pool primary-renamed (#${poolId}) to primary-human\n`);
		const finalPool = await expectJsonCommand<{ pool: Record<string, unknown> }>(
			poolCommand("show", "primary-human"),
			deps,
		);
		expect(finalPool.pool).toMatchObject({
			id: poolId,
			name: "primary-human",
			members: [
				{ credentialId: 42, position: 0 },
				{ credentialId: 7, position: 1 },
			],
		});
	});

	test("manages users, tokens, ACLs, pools, usage, audit, and status without exposing secrets", async () => {
		const created = await expectJsonCommand<{
			user: Record<string, unknown>;
			token: Record<string, unknown>;
		}>(
			userCommand("create", "alice", undefined, {
				description: "team account",
				owner: "platform",
				role: "user",
				label: "initial",
			}),
			deps,
		);
		expectExactKeys(created, ["user", "token"]);
		expectExactKeys(created.user, [
			"id",
			"name",
			"description",
			"owner",
			"role",
			"enabled",
			"createdAt",
			"updatedAt",
			"lastUsedAt",
		]);
		expectExactKeys(created.token, [
			"id",
			"userId",
			"publicId",
			"label",
			"createdAt",
			"lastUsedAt",
			"revokedAt",
			"value",
		]);
		expect(created.user).toMatchObject({
			name: "alice",
			description: "team account",
			owner: "platform",
			role: "user",
			enabled: true,
		});
		expect(created.token).toMatchObject({ userId: created.user.id, label: "initial", revokedAt: null });
		expect(String(created.token.value)).toStartWith("omp_gw_");
		expect(JSON.stringify(created)).not.toContain("token_hash");
		const aliceId = created.user.id as number;
		const initialTokenId = created.token.id as number;
		const initialTokenValue = created.token.value as string;

		const admin = await expectJsonCommand<{ user: Record<string, unknown>; token: Record<string, unknown> }>(
			userCommand("create", "admin1", undefined, { role: "admin" }),
			deps,
		);
		expect(admin.user).toMatchObject({ name: "admin1", role: "admin", enabled: true });
		expect(admin.token.value).not.toBe(initialTokenValue);

		const listed = await expectJsonCommand<{ users: Array<Record<string, unknown>> }>(userCommand("list"), deps);
		expectExactKeys(listed, ["users"]);
		expect(listed.users.map(user => user.name)).toEqual(["alice", "admin1"]);
		expect(JSON.stringify(listed)).not.toContain(initialTokenValue);

		const shown = await expectJsonCommand<{
			user: Record<string, unknown>;
			tokens: Array<Record<string, unknown>>;
			acl: unknown[];
			poolBindings: unknown[];
		}>(userCommand("show", "alice"), deps);
		expectExactKeys(shown, ["user", "tokens", "acl", "poolBindings"]);
		expectExactKeys(shown.tokens[0]!, ["id", "userId", "publicId", "label", "createdAt", "lastUsedAt", "revokedAt"]);
		expect(JSON.stringify(shown)).not.toContain(initialTokenValue);
		expect(JSON.stringify(shown)).not.toContain("token_hash");

		const updated = await expectJsonCommand<{ user: Record<string, unknown> }>(
			userCommand("update", String(aliceId), undefined, { description: "", owner: "", role: "admin" }),
			deps,
		);
		expect(updated.user).toMatchObject({ id: aliceId, description: null, owner: null, role: "admin" });

		const disabled = await expectJsonCommand<{ user: Record<string, unknown> }>(
			userCommand("disable", "alice"),
			deps,
		);
		expect(disabled.user).toMatchObject({ id: aliceId, enabled: false });
		const enabled = await expectJsonCommand<{ user: Record<string, unknown> }>(userCommand("enable", "alice"), deps);
		expect(enabled.user).toMatchObject({ id: aliceId, enabled: true });
		await expectJsonCommand(userCommand("update", "alice", undefined, { role: "user" }), deps);

		const addedToken = await expectJsonCommand<{ token: Record<string, unknown> }>(
			userCommand("token", "alice", undefined, { label: "ci" }),
			deps,
		);
		expectExactKeys(addedToken.token, [
			"id",
			"userId",
			"publicId",
			"label",
			"createdAt",
			"lastUsedAt",
			"revokedAt",
			"value",
		]);
		expect(addedToken.token).toMatchObject({ userId: aliceId, label: "ci", revokedAt: null });
		expect(addedToken.token.value).not.toBe(initialTokenValue);

		const rotated = await expectJsonCommand<{ token: Record<string, unknown> }>(
			userCommand("token", "alice", undefined, { regenerate: true, label: "rotated" }),
			deps,
		);
		expect(rotated.token).toMatchObject({ userId: aliceId, label: "rotated", revokedAt: null });
		const rotatedTokenId = Number(rotated.token.id);
		await withStore(dbPath, store => {
			const aliceTokens = store.listUserTokens(aliceId);
			expect(aliceTokens.filter(token => token.revokedAt === null).map(token => token.id)).toEqual([rotatedTokenId]);
			const adminUser = store.getUser("admin1");
			expect(adminUser).toBeDefined();
			const adminTokens = store.listUserTokens(adminUser!.id);
			expect(adminTokens).toHaveLength(1);
			expect(adminTokens[0]!.revokedAt).toBeNull();
		});

		const revoked = await expectJsonCommand<{ revoked: true; tokenId: number }>(
			userCommand("token-revoke", "alice", String(rotatedTokenId)),
			deps,
		);
		expect(revoked).toEqual({ revoked: true, tokenId: rotatedTokenId });
		await expectCommandError(userCommand("token-revoke", "alice", String(initialTokenId)), deps, "token not found");

		const allow = await expectJsonCommand<{ rule: Record<string, unknown>; created: boolean }>(
			userCommand("allow", "alice", undefined, { provider: "anthropic" }),
			deps,
		);
		expectExactKeys(allow, ["rule", "created"]);
		expect(allow).toMatchObject({
			created: true,
			rule: { userId: aliceId, effect: "allow", kind: "provider", pattern: "anthropic" },
		});
		const deny = await expectJsonCommand<{ rule: Record<string, unknown>; created: boolean }>(
			userCommand("deny", "alice", undefined, { model: "anthropic/claude-3-5-sonnet" }),
			deps,
		);
		expect(deny).toMatchObject({
			created: true,
			rule: { effect: "deny", kind: "model", pattern: "anthropic/claude-3-5-sonnet" },
		});
		const deniedRuleId = Number(deny.rule.id);
		const route = await expectJsonCommand<{ rule: Record<string, unknown>; created: boolean }>(
			userCommand("allow", "alice", undefined, { route: "chat" }),
			deps,
		);
		expect(route).toMatchObject({ created: true, rule: { effect: "allow", kind: "route", pattern: "chat" } });
		await expectCommandError(
			userCommand("allow", "alice", undefined, { provider: "anthropic", route: "chat" }),
			deps,
			"Exactly one of --provider, --model, or --route is required",
		);
		await expectCommandError(
			userCommand("deny", "alice"),
			deps,
			"Exactly one of --provider, --model, or --route is required",
		);

		const acl = await expectJsonCommand<{ acl: Array<Record<string, unknown>> }>(userCommand("acl", "alice"), deps);
		expect(acl.acl.map(rule => `${rule.effect}:${rule.kind}:${rule.pattern}`)).toEqual([
			"allow:provider:anthropic",
			"deny:model:anthropic/claude-3-5-sonnet",
			"allow:route:chat",
		]);
		const deletedAcl = await expectJsonCommand<{ deleted: true; ruleId: number }>(
			userCommand("acl-delete", "alice", String(deniedRuleId)),
			deps,
		);
		expect(deletedAcl).toEqual({ deleted: true, ruleId: deniedRuleId });

		await expectCommandError(
			poolCommand("create", "oldprovider", undefined, { provider: "anthropic" }),
			deps,
			"Unsupported option(s) for auth-gateway pool create: --provider",
		);
		await expectCommandError(
			poolCommand("create", "oldmodel", undefined, { model: "anthropic/claude-3-5-sonnet" }),
			deps,
			"Unsupported option(s) for auth-gateway pool create: --model",
		);
		const pool = await expectJsonCommand<{ pool: Record<string, unknown> }>(
			poolCommand("create", "primary", undefined, {
				strategy: "round-robin",
			}),
			deps,
		);
		expectExactKeys(pool.pool, ["id", "name", "strategy", "createdAt", "updatedAt", "members"]);
		expect(pool.pool).toMatchObject({
			name: "primary",
			strategy: "round-robin",
			members: [],
		});
		const poolId = pool.pool.id as number;

		await expectCommandError(
			poolCommand("add-account", "primary", "99"),
			deps,
			"credential id 99 was not found in broker snapshot",
		);
		const member = await expectJsonCommand<{ pool: Record<string, unknown>; created: boolean }>(
			poolCommand("add-account", "primary", "42"),
			deps,
		);
		expect(member).toMatchObject({
			created: true,
			pool: { id: poolId, members: [{ credentialId: 42, position: 0 }] },
		});
		expect(JSON.stringify(member)).not.toContain("api_key");
		expect(JSON.stringify(member)).not.toContain("oauth");

		const mixedProviderMember = await expectJsonCommand<{ pool: Record<string, unknown>; created: boolean }>(
			poolCommand("add-account", "primary", "7"),
			deps,
		);
		expect(mixedProviderMember).toMatchObject({
			created: true,
			pool: {
				id: poolId,
				members: [
					{ credentialId: 42, position: 0 },
					{ credentialId: 7, position: 1 },
				],
			},
		});
		const strategy = await expectJsonCommand<{ pool: Record<string, unknown> }>(
			poolCommand("set-strategy", "primary", "failover"),
			deps,
		);
		expect(strategy.pool).toMatchObject({ id: poolId, strategy: "failover" });
		const poolList = await expectJsonCommand<{ pools: Array<Record<string, unknown>> }>(poolCommand("list"), deps);
		expect(poolList.pools).toHaveLength(1);
		expect(poolList.pools[0]).toMatchObject({ id: poolId, name: "primary" });
		const humanPoolList = await expectHumanCommand(poolCommand("list", undefined, undefined, { json: false }), deps);
		expect(humanPoolList).toBe(`id\tname\tstrategy\taccounts\n${poolId}\tprimary\tfailover\t2 accounts\n`);
		const poolShow = await expectJsonCommand<{ pool: Record<string, unknown> }>(poolCommand("show", "primary"), deps);
		expect(poolShow.pool).toMatchObject({
			id: poolId,
			members: [
				{ credentialId: 42, position: 0 },
				{ credentialId: 7, position: 1 },
			],
		});
		const humanPoolShow = await expectHumanCommand(poolCommand("show", "primary", undefined, { json: false }), deps);
		expect(humanPoolShow).toBe(`pool primary (#${poolId}) strategy=failover accounts=42,7\n`);

		const fallbackPool = await expectJsonCommand<{ pool: Record<string, unknown> }>(
			poolCommand("create", "fallback", undefined, { strategy: "least-used" }),
			deps,
		);
		const fallbackPoolId = fallbackPool.pool.id as number;
		await expectJsonCommand(poolCommand("add-account", "fallback", "43"), deps);
		const setPool = await expectJsonCommand<{
			created: boolean;
			user: Record<string, unknown>;
			pool: Record<string, unknown>;
			binding: Record<string, unknown>;
		}>(userCommand("set-pool", "alice", "primary"), deps);
		expect(setPool).toMatchObject({
			created: true,
			user: { id: aliceId, name: "alice" },
			pool: { id: poolId, name: "primary" },
			binding: { poolId, position: 0 },
		});
		const fallbackBinding = await expectJsonCommand<{
			created: boolean;
			binding: Record<string, unknown>;
		}>(userCommand("set-pool", "alice", "fallback"), deps);
		expect(fallbackBinding).toMatchObject({ created: true, binding: { poolId: fallbackPoolId, position: 1 } });
		const shownWithPool = await expectJsonCommand<{ poolBindings: Array<Record<string, unknown>> }>(
			userCommand("show", "alice"),
			deps,
		);
		expect(shownWithPool.poolBindings).toHaveLength(2);
		expect(shownWithPool.poolBindings.map(binding => [binding.poolId, binding.position])).toEqual([
			[poolId, 0],
			[fallbackPoolId, 1],
		]);
		await expectCommandError(
			userCommand("reorder-pools", "alice", `${poolId},,${fallbackPoolId}`),
			deps,
			"pool order must be comma-separated positive pool ids",
		);
		await expectCommandError(
			userCommand("reorder-pools", "alice", `${poolId},${poolId}`),
			deps,
			"pool order must not contain duplicate pool ids",
		);
		const reordered = await expectJsonCommand<{
			user: Record<string, unknown>;
			bindings: Array<Record<string, unknown>>;
		}>(userCommand("reorder-pools", "alice", `${fallbackPoolId},${poolId}`), deps);
		expect(reordered).toMatchObject({
			user: { id: aliceId, name: "alice" },
			bindings: [
				{ poolId: fallbackPoolId, position: 0, pool: { name: "fallback", strategy: "least-used" } },
				{ poolId, position: 1, pool: { name: "primary", strategy: "failover" } },
			],
		});
		const humanReordered = await expectHumanCommand(
			userCommand("reorder-pools", "alice", `${poolId},${fallbackPoolId}`, { json: false }),
			deps,
		);
		expect(humanReordered).toBe(
			`position\tpool\tname\tstrategy\taccounts\n0\t${poolId}\tprimary\tfailover\t42,7\n1\t${fallbackPoolId}\tfallback\tleast-used\t43\n`,
		);
		const unsetPool = await expectJsonCommand<{
			removed: true;
			user: Record<string, unknown>;
			pool: Record<string, unknown>;
		}>(userCommand("unset-pool", "alice", "primary"), deps);
		expect(unsetPool).toMatchObject({ removed: true, user: { id: aliceId }, pool: { id: poolId } });

		const removedMember = await expectJsonCommand<{
			removed: true;
			credentialId: number;
			pool: Record<string, unknown>;
		}>(poolCommand("remove-account", "primary", "42"), deps);
		expect(removedMember).toMatchObject({
			removed: true,
			credentialId: 42,
			pool: { id: poolId, members: [{ credentialId: 7, position: 0 }] },
		});

		const auditEvent = await withStore(dbPath, store =>
			store.recordAudit({
				requestId: "req-1",
				startedAt: 1234,
				completedAt: 1244,
				userId: aliceId,
				userName: "alice",
				tokenId: null,
				method: "POST",
				path: "/v1/chat/completions",
				routeFamily: "chat",
				requestedModel: "claude-3-5-sonnet",
				resolvedProvider: "anthropic",
				resolvedModel: "anthropic/claude-3-5-sonnet",
				credentialId: 43,
				outcome: "success",
				statusCode: 200,
				inputTokens: 11,
				outputTokens: 13,
				cacheReadTokens: 2,
				cacheWriteTokens: 3,
				totalTokens: 29,
				costUsd: 0.25,
				errorCode: null,
			} satisfies Omit<AuthGatewayAuditEvent, "id">),
		);

		const usage = await expectJsonCommand<{ usage: Record<string, unknown> }>(
			userCommand("usage", "alice", undefined, { since: "1000" }),
			deps,
		);
		expect(usage.usage).toMatchObject({
			userId: aliceId,
			since: 1000,
			totals: {
				requests: 1,
				inputTokens: 11,
				outputTokens: 13,
				cacheReadTokens: 2,
				cacheWriteTokens: 3,
				totalTokens: 29,
				costUsd: 0.25,
			},
			byProviderModel: [
				{
					provider: "anthropic",
					model: "anthropic/claude-3-5-sonnet",
					requests: 1,
					totalTokens: 29,
					costUsd: 0.25,
				},
			],
		});
		expect(usage.usage).toHaveProperty("generatedAt");

		const audit = await expectJsonCommand<{ events: Array<Record<string, unknown>>; nextBefore: number | null }>(
			{ action: "audit", subaction: "list", flags: { json: true, user: "alice", limit: "1" } },
			deps,
		);
		expectExactKeys(audit, ["events", "nextBefore"]);
		expect(audit.events).toHaveLength(1);
		expect(audit.events[0]).toMatchObject({
			id: auditEvent.id,
			userId: aliceId,
			userName: "alice",
			resolvedProvider: "anthropic",
			credentialId: 43,
			totalTokens: 29,
		});
		expect(audit.nextBefore).toBe(auditEvent.id);
		await expectCommandError(
			{ action: "audit", subaction: "list", flags: { json: true, limit: "0" } },
			deps,
			"--limit must be between 1 and 1000",
		);

		const status = await expectJsonCommand<Record<string, unknown>>(
			{ action: "status", flags: { json: true } },
			deps,
		);
		expect(status).toMatchObject({
			accessDb: dbPath,
			managedUserCount: 2,
			activeManagedTokenCount: 1,
			poolCount: 2,
			credentialCount: 3,
		});
		expect(status).toHaveProperty("ready");
		expect(status).toHaveProperty("tokenFile");

		const deletedPool = await expectJsonCommand<{ deleted: true; pool: Record<string, unknown> }>(
			poolCommand("delete", "primary"),
			deps,
		);
		expect(deletedPool).toMatchObject({ deleted: true, pool: { id: poolId, name: "primary" } });
		const deletedUser = await expectJsonCommand<{ deleted: true; user: Record<string, unknown> }>(
			userCommand("delete", "alice"),
			deps,
		);
		expect(deletedUser).toMatchObject({ deleted: true, user: { id: aliceId, name: "alice" } });
	}, 15_000);

	test("preserves legacy gateway token JSON contract and reports zero managed counts before creating a database", async () => {
		const absentDb = path.join(agentDir, "missing-auth-gateway.db");
		const status = await expectJsonCommand<Record<string, unknown>>(
			{ action: "status", flags: { json: true } },
			{ ...deps, accessDbPath: absentDb },
		);
		expect(status).toMatchObject({
			accessDb: absentDb,
			managedUserCount: 0,
			activeManagedTokenCount: 0,
			poolCount: 0,
		});
		expect(
			await fs
				.stat(absentDb)
				.then(() => true)
				.catch(() => false),
		).toBe(false);

		const token = await expectJsonCommand<Record<string, unknown>>({ action: "token", flags: { json: true } }, deps);
		expectExactKeys(token, ["token", "path"]);
		expect(typeof token.token).toBe("string");
		expect(token.path).toBe(path.join(getConfigRootDir(), "auth-gateway.token"));

		const rotated = await expectJsonCommand<Record<string, unknown>>(
			{ action: "token", flags: { json: true, regenerate: true } },
			deps,
		);
		expectExactKeys(rotated, ["token", "path"]);
		expect(rotated.token).not.toBe(token.token);
		expect(rotated.path).toBe(token.path);
	});
});
