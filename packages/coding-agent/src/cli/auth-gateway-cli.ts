/**
 * `omp auth-gateway` command handlers.
 *
 * Boots a forward-proxy server that lets less-trusted clients (the macOS
 * usage widget, robomp containers, …) make provider API calls without ever
 * seeing the access token. The gateway is itself a broker client and
 * resolves credentials through the configured broker (via the same
 * `OMP_AUTH_BROKER_URL` / `auth.broker.url` precedence used elsewhere).
 *
 * Sub-verbs:
 *   - `serve [--bind=…]` — boots the gateway against the configured broker.
 *   - `token` / `token --regenerate` — manages the gateway bearer token file.
 *   - `status` — prints the locally-stored gateway token and bind hint.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
	type Api,
	AuthStorage,
	type CompletionProbe,
	type CompletionProbeInput,
	type CredentialCompletionResult,
	completeSimple,
	type Model,
} from "@oh-my-pi/pi-ai";
import {
	AuthBrokerClient,
	loadAuthBrokerAccountPool,
	RemoteAuthCredentialStore,
	type SnapshotResponse,
} from "@oh-my-pi/pi-ai/auth-broker";
import {
	type AuthGatewayAclEffect,
	type AuthGatewayAclKind,
	type AuthGatewayAclRule,
	type AuthGatewayPool,
	type AuthGatewayPoolStrategy,
	type AuthGatewayRole,
	type AuthGatewayToken,
	type AuthGatewayUser,
	type AuthGatewayUserPoolBinding,
	DEFAULT_AUTH_GATEWAY_BIND,
	SqliteAuthGatewayAccessStore,
	startAuthGateway,
} from "@oh-my-pi/pi-ai/auth-gateway";
import { type GeneratedProvider, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { getConfigRootDir, isEnoent, logger, VERSION } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { runAuthGatewayTui } from "../auth-gateway/run-tui";
import { ModelRegistry } from "../config/model-registry";
import { type AuthBrokerClientConfig, resolveAuthBrokerConfig } from "../session/auth-broker-config";

export type AuthGatewayAction = "serve" | "token" | "status" | "check" | "user" | "pool" | "audit" | "tui";

export interface AuthGatewayCommandArgs {
	action: AuthGatewayAction;
	subaction?: string;
	target?: string;
	value?: string;
	positionals?: readonly string[];
	flags: {
		json?: boolean;
		bind?: string;
		regenerate?: boolean;
		description?: string;
		owner?: string;
		role?: string;
		label?: string;
		provider?: string;
		model?: string;
		route?: string;
		strategy?: string;
		since?: string;
		limit?: string;
		before?: string;
		user?: string;
		connection?: string;
		/**
		 * Disable bearer-token auth on inbound requests. Useful when the gateway
		 * is bound to loopback (the default `127.0.0.1:4000`) and you don't want
		 * to wire token-paste plumbing into every local client.
		 */
		noAuth?: boolean;
		/**
		 * Strict mode for `check` — additionally exercise every credential
		 * against its provider's chat-completion endpoint. The usage probe (run
		 * unconditionally) can pass while the chat endpoint still 401s the same
		 * bearer, so strict mode is the definitive "is this credential
		 * actually usable" signal. Slower and consumes a tiny amount of quota.
		 */
		strict?: boolean;
	};
}

export interface AuthGatewayCommandDependencies {
	accessDbPath?: string;
	loadBrokerCredentials?: () => Promise<Array<{ id: number; provider: string; type: "oauth" | "api_key" }>>;
	runTui?: (options: { connection?: string }) => Promise<void>;
}

export interface AuthGatewayModelIndex {
	resolveModel(modelId: string): Model<Api> | undefined;
	listModels(): Iterable<Model<Api>>;
	isKeylessModel(model: Model<Api>): boolean;
}

export function buildAuthGatewayModelIndex(modelRegistry: ModelRegistry): AuthGatewayModelIndex {
	const modelById = new Map<string, Model<Api>>();
	const models: Model<Api>[] = [];
	const keylessProviders = new Set<string>();
	for (const model of modelRegistry.getAvailable()) {
		const keylessProvider = modelRegistry.isKeylessProvider(model.provider);
		if (keylessProvider && !modelRegistry.isConfiguredModel(model.provider, model.id)) continue;
		models.push(model);
		modelById.set(`${model.provider}/${model.id}`, model);
		if (!modelById.has(model.id)) modelById.set(model.id, model);
		if (keylessProvider) keylessProviders.add(model.provider);
	}
	return {
		resolveModel: (modelId: string) => modelById.get(modelId),
		listModels: () => models,
		isKeylessModel: (model: Model<Api>) => keylessProviders.has(model.provider),
	};
}

const ACTIONS: readonly AuthGatewayAction[] = ["serve", "token", "status", "check", "user", "pool", "audit", "tui"];

const USER_POSITIONAL_COUNTS: Record<string, number> = {
	list: 2,
	create: 3,
	show: 3,
	update: 3,
	enable: 3,
	disable: 3,
	delete: 3,
	token: 3,
	allow: 3,
	deny: 3,
	acl: 3,
	usage: 3,
	"token-revoke": 4,
	"acl-delete": 4,
	"set-pool": 4,
	"unset-pool": 4,
	"reorder-pools": 4,
};

const POOL_POSITIONAL_COUNTS: Record<string, number> = {
	list: 2,
	create: 3,
	show: 3,
	delete: 3,
	rename: 4,
	"set-strategy": 4,
	"add-account": 4,
	"remove-account": 4,
};

const AUDIT_POSITIONAL_COUNTS: Record<string, number> = {
	list: 2,
};

function getTokenFilePath(): string {
	return path.join(getConfigRootDir(), "auth-gateway.token");
}

function getAccessDbPath(deps?: AuthGatewayCommandDependencies): string {
	return deps?.accessDbPath ?? path.join(getConfigRootDir(), "auth-gateway.db");
}

async function readToken(): Promise<string | null> {
	try {
		const raw = await Bun.file(getTokenFilePath()).text();
		const trimmed = raw.trim();
		return trimmed.length > 0 ? trimmed : null;
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
}

async function writeToken(token: string): Promise<void> {
	const file = getTokenFilePath();
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	await fs.writeFile(file, token, { mode: 0o600 });
	try {
		await fs.chmod(file, 0o600);
	} catch {
		// Best-effort (e.g. Windows).
	}
}

/**
 * Atomically create the token file, refusing to clobber an existing one.
 * Returns `true` on success, `false` when the file already existed (so the
 * caller re-reads it instead of racing another concurrent `ensureToken`).
 */
async function createTokenExclusive(token: string): Promise<boolean> {
	const file = getTokenFilePath();
	await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
	try {
		// `wx` = O_CREAT | O_EXCL — fails with EEXIST if the file is already there.
		await fs.writeFile(file, token, { flag: "wx", mode: 0o600 });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw err;
	}
	try {
		await fs.chmod(file, 0o600);
	} catch {
		// Best-effort (e.g. Windows).
	}
	return true;
}

function generateToken(): string {
	return crypto.randomBytes(32).toString("base64url");
}

async function ensureToken(): Promise<string> {
	const existing = await readToken();
	if (existing) return existing;
	const token = generateToken();
	if (await createTokenExclusive(token)) return token;
	// Another concurrent invocation won the create race; read what they wrote.
	const fromRace = await readToken();
	if (fromRace) return fromRace;
	// File existed-then-disappeared between EEXIST and read; last resort, write
	// our generated token unconditionally so callers don't see an empty string.
	await writeToken(token);
	return token;
}

function createBrokerClient(brokerConfig: AuthBrokerClientConfig): AuthBrokerClient {
	return new AuthBrokerClient({ url: brokerConfig.url, token: brokerConfig.token });
}

async function fetchBrokerSnapshot(client: AuthBrokerClient): Promise<SnapshotResponse> {
	const result = await client.fetchSnapshot();
	if (result.status !== 200) throw new Error("Auth broker returned no initial snapshot");
	return result.snapshot;
}

async function loadBrokerCredentials(
	deps?: AuthGatewayCommandDependencies,
): Promise<Array<{ id: number; provider: string; type: "oauth" | "api_key" }>> {
	if (deps?.loadBrokerCredentials) return deps.loadBrokerCredentials();
	const brokerConfig = await resolveAuthBrokerConfig();
	if (!brokerConfig) {
		throw new Error(
			"`omp auth-gateway pool add-account` requires OMP_AUTH_BROKER_URL (or `auth.broker.url`/`auth.broker.token` in config.yml).",
		);
	}
	const snapshot = await fetchBrokerSnapshot(createBrokerClient(brokerConfig));
	return snapshot.credentials.map(entry => ({ id: entry.id, provider: entry.provider, type: entry.credential.type }));
}

/**
 * How often a long-lived `serve` rebuilds its catalog from the registry so
 * models discovered after boot become routable without a restart. `refresh()`
 * reuses the `models.db` cache and only hits the network when a provider's
 * cached row is stale, so a short interval stays cheap.
 */
const CATALOG_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Index resolvable models by the request ids clients may send: the
 * provider-qualified `provider/id` (always) and the bare `id` (first-write-wins
 * fallback for legacy clients). Scoped to providers the gateway holds broker
 * credentials for, since only those are routable.
 */
export function indexModelsByRequestId(
	models: readonly Model<Api>[],
	providersWithCreds: ReadonlySet<string>,
): Map<string, Model<Api>> {
	const modelById = new Map<string, Model<Api>>();
	for (const model of models) {
		if (!providersWithCreds.has(model.provider)) continue;
		modelById.set(`${model.provider}/${model.id}`, model);
		if (!modelById.has(model.id)) modelById.set(model.id, model);
	}
	return modelById;
}

async function runServe(flags: AuthGatewayCommandArgs["flags"], deps?: AuthGatewayCommandDependencies): Promise<void> {
	const brokerConfig = await resolveAuthBrokerConfig();
	if (!brokerConfig) {
		throw new Error(
			"`omp auth-gateway serve` requires OMP_AUTH_BROKER_URL (or `auth.broker.url`/`auth.broker.token` in config.yml). The gateway is itself a broker client.",
		);
	}
	const bind = flags.bind ?? DEFAULT_AUTH_GATEWAY_BIND;
	const gatewayToken = flags.noAuth ? null : await ensureToken();
	let storage: AuthStorage | undefined;
	let accessStore: SqliteAuthGatewayAccessStore | undefined;

	try {
		// Build a broker-backed AuthStorage — same pattern as discoverAuthStorage()
		// in sdk.ts. The gateway never touches local SQLite for provider secrets.
		const accountPool = await loadAuthBrokerAccountPool();
		const client = createBrokerClient(brokerConfig);
		const initialSnapshot = await fetchBrokerSnapshot(client);
		const store = new RemoteAuthCredentialStore({ client, initialSnapshot, accountPool });
		// Refresh + usage both flow through the store's broker hooks automatically —
		// `RemoteAuthCredentialStore.refreshOAuthCredential` and `.fetchUsageReports`.
		storage = new AuthStorage(store, {
			sourceLabel: `broker ${brokerConfig.url}`,
		});
		await storage.reload();
		accessStore = await SqliteAuthGatewayAccessStore.open(getAccessDbPath(deps));

		// Use the same registry contract as the interactive agent: bundled
		// credentialed providers, custom `models.yml` providers, cached
		// discoveries, and explicit `auth: none` self-hosted models.
		const modelRegistry = new ModelRegistry(storage);
		await modelRegistry.refresh("online-if-uncached");
		let modelIndex = buildAuthGatewayModelIndex(modelRegistry);

		const handle = startAuthGateway({
			storage,
			accessStore,
			bind,
			bearerTokens: gatewayToken ? [gatewayToken] : [],
			version: VERSION,
			resolveModel: (modelId: string) => modelIndex.resolveModel(modelId),
			listModels: () => modelIndex.listModels(),
			isKeylessModel: (model: Model<Api>) => modelIndex.isKeylessModel(model),
		});
		process.stdout.write(`auth-gateway listening on ${handle.url}\n`);
		if (gatewayToken) {
			process.stdout.write(`bearer token: ${getTokenFilePath()} (chmod 0600)\n`);
		} else {
			process.stdout.write(`auth: disabled (--no-auth) — any client can call this gateway\n`);
		}
		process.stdout.write(`upstream broker: ${brokerConfig.url}\n`);
		process.stdout.write(`access database: ${getAccessDbPath(deps)}\n`);

		// `serve` is long-lived: rebuild the catalog periodically so models
		// discovered after boot become routable without a restart. A failed refresh
		// keeps serving the previous catalog. `unref()` so the timer never keeps the
		// process alive on its own.
		const catalogRefresh = setInterval(() => {
			void modelRegistry
				.refresh()
				.then(() => {
					modelIndex = buildAuthGatewayModelIndex(modelRegistry);
				})
				.catch(error => {
					logger.warn("auth-gateway catalog refresh failed", {
						error: error instanceof Error ? error.message : String(error),
					});
				});
		}, CATALOG_REFRESH_INTERVAL_MS);
		catalogRefresh.unref();

		const stopped = Promise.withResolvers<void>();
		let shutdownStarted = false;
		const stop = async (signal: NodeJS.Signals): Promise<void> => {
			if (shutdownStarted) return;
			shutdownStarted = true;
			process.stdout.write(`\nReceived ${signal}, shutting down...\n`);
			clearInterval(catalogRefresh);
			let closeError: unknown;
			try {
				await handle.close();
			} catch (error) {
				closeError = error;
			} finally {
				storage?.close();
				storage = undefined;
				accessStore?.close();
				accessStore = undefined;
			}
			if (closeError) {
				stopped.reject(closeError);
			} else {
				stopped.resolve();
			}
		};
		const onSigint = (): void => {
			void stop("SIGINT");
		};
		const onSigterm = (): void => {
			void stop("SIGTERM");
		};
		process.once("SIGINT", onSigint);
		process.once("SIGTERM", onSigterm);

		try {
			await stopped.promise;
		} finally {
			process.off("SIGINT", onSigint);
			process.off("SIGTERM", onSigterm);
		}
	} catch (error) {
		storage?.close();
		accessStore?.close();
		throw error;
	}
}

async function runToken(flags: AuthGatewayCommandArgs["flags"]): Promise<void> {
	if (flags.regenerate) {
		const next = generateToken();
		await writeToken(next);
		if (flags.json) {
			process.stdout.write(`${JSON.stringify({ token: next, path: getTokenFilePath() })}\n`);
		} else {
			process.stdout.write(`${next}\n`);
		}
		return;
	}
	const token = await ensureToken();
	if (flags.json) {
		process.stdout.write(`${JSON.stringify({ token, path: getTokenFilePath() })}\n`);
	} else {
		process.stdout.write(`${token}\n`);
	}
}

async function readAccessCounts(dbPath: string): Promise<{ users: number; activeTokens: number; pools: number }> {
	const exists = await fs
		.stat(dbPath)
		.then(stat => stat.isFile())
		.catch(() => false);
	if (!exists) return { users: 0, activeTokens: 0, pools: 0 };
	const store = await SqliteAuthGatewayAccessStore.open(dbPath);
	try {
		return store.counts();
	} finally {
		store.close();
	}
}

async function runStatus(flags: AuthGatewayCommandArgs["flags"], deps?: AuthGatewayCommandDependencies): Promise<void> {
	const token = await readToken();
	const tokenFile = getTokenFilePath();
	const accessDb = getAccessDbPath(deps);
	const accessCounts = await readAccessCounts(accessDb);
	const accessStatus = {
		accessDb,
		managedUserCount: accessCounts.users,
		activeManagedTokenCount: accessCounts.activeTokens,
		poolCount: accessCounts.pools,
	};
	const tokenPresent = token !== null;

	if (deps?.loadBrokerCredentials) {
		try {
			const credentials = await deps.loadBrokerCredentials();
			const status = {
				ready: tokenPresent,
				reason: tokenPresent ? null : "token_missing",
				tokenFile,
				tokenPresent,
				broker: null,
				brokerConfigured: true,
				brokerAuthenticated: true,
				credentialCount: credentials.length,
				...accessStatus,
			};
			if (flags.json) {
				process.stdout.write(`${JSON.stringify(status)}\n`);
			} else {
				process.stdout.write(
					`${tokenPresent ? chalk.green("ready") : chalk.yellow("not ready")} upstream broker: injected (${credentials.length} credentials)\n`,
				);
				process.stdout.write(
					`access db: ${status.accessDb} (${status.managedUserCount} users, ${status.activeManagedTokenCount} active tokens, ${status.poolCount} pools)\n`,
				);
				process.stdout.write(
					`token: ${tokenPresent ? chalk.green("present") : chalk.red("missing")} at ${status.tokenFile}\n`,
				);
			}
			if (!tokenPresent) process.exitCode = 1;
			return;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const status = {
				ready: false,
				reason: "broker_unavailable",
				tokenFile,
				tokenPresent,
				broker: null,
				brokerConfigured: true,
				brokerAuthenticated: false,
				error: message,
				...accessStatus,
			};
			if (flags.json) {
				process.stdout.write(`${JSON.stringify(status)}\n`);
			} else {
				process.stdout.write(`${chalk.red("FAILED")} upstream broker: ${message}\n`);
				process.stdout.write(
					`access db: ${status.accessDb} (${status.managedUserCount} users, ${status.activeManagedTokenCount} active tokens, ${status.poolCount} pools)\n`,
				);
				process.stdout.write(
					`token: ${status.tokenPresent ? chalk.green("present") : chalk.red("missing")} at ${status.tokenFile}\n`,
				);
			}
			process.exitCode = 1;
			return;
		}
	}

	const brokerConfig = await resolveAuthBrokerConfig();
	if (!brokerConfig) {
		const status = {
			ready: false,
			reason: "not_configured",
			tokenFile,
			tokenPresent,
			broker: null,
			brokerConfigured: false,
			brokerAuthenticated: false,
			...accessStatus,
		};
		if (flags.json) {
			process.stdout.write(`${JSON.stringify(status)}\n`);
		} else {
			process.stdout.write(`${chalk.yellow("No broker configured.")} Set OMP_AUTH_BROKER_URL.\n`);
			process.stdout.write(
				`access db: ${status.accessDb} (${status.managedUserCount} users, ${status.activeManagedTokenCount} active tokens, ${status.poolCount} pools)\n`,
			);
			process.stdout.write(
				`token: ${status.tokenPresent ? chalk.green("present") : chalk.red("missing")} at ${status.tokenFile}\n`,
			);
		}
		process.exitCode = 1;
		return;
	}

	try {
		const snapshot = await fetchBrokerSnapshot(createBrokerClient(brokerConfig));
		const status = {
			ready: tokenPresent,
			reason: tokenPresent ? null : "token_missing",
			tokenFile,
			tokenPresent,
			broker: brokerConfig.url,
			brokerConfigured: true,
			brokerAuthenticated: true,
			credentialCount: snapshot.credentials.length,
			...accessStatus,
		};
		if (flags.json) {
			process.stdout.write(`${JSON.stringify(status)}\n`);
		} else {
			const brokerLine = `upstream broker: ${brokerConfig.url} (${snapshot.credentials.length} credential${
				snapshot.credentials.length === 1 ? "" : "s"
			})`;
			process.stdout.write(`${tokenPresent ? chalk.green("ready") : chalk.yellow("not ready")} ${brokerLine}\n`);
			process.stdout.write(
				`access db: ${status.accessDb} (${status.managedUserCount} users, ${status.activeManagedTokenCount} active tokens, ${status.poolCount} pools)\n`,
			);
			process.stdout.write(
				`token: ${tokenPresent ? chalk.green("present") : chalk.red("missing")} at ${status.tokenFile}\n`,
			);
			if (!tokenPresent) {
				process.stdout.write(
					"Run `omp auth-gateway token` or `omp auth-gateway serve` to create a bearer token.\n",
				);
			}
		}
		if (!tokenPresent) process.exitCode = 1;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const status = {
			ready: false,
			reason: "broker_unavailable",
			tokenFile,
			tokenPresent,
			broker: brokerConfig.url,
			brokerConfigured: true,
			brokerAuthenticated: false,
			error: message,
			...accessStatus,
		};
		if (flags.json) {
			process.stdout.write(`${JSON.stringify(status)}\n`);
		} else {
			process.stdout.write(`${chalk.red("FAILED")} upstream broker: ${brokerConfig.url}: ${message}\n`);
			process.stdout.write(
				`access db: ${status.accessDb} (${status.managedUserCount} users, ${status.activeManagedTokenCount} active tokens, ${status.poolCount} pools)\n`,
			);
			process.stdout.write(
				`token: ${status.tokenPresent ? chalk.green("present") : chalk.red("missing")} at ${status.tokenFile}\n`,
			);
		}
		process.exitCode = 1;
	}
}

async function withAccessStore<T>(
	deps: AuthGatewayCommandDependencies | undefined,
	fn: (store: SqliteAuthGatewayAccessStore) => T | Promise<T>,
): Promise<T> {
	const store = await SqliteAuthGatewayAccessStore.open(getAccessDbPath(deps));
	try {
		return await fn(store);
	} finally {
		store.close();
	}
}

function writeCommandOutput(flags: AuthGatewayCommandArgs["flags"], jsonValue: unknown, human: string): void {
	process.stdout.write(flags.json ? `${JSON.stringify(jsonValue)}\n` : human);
}

function formatHumanCell(value: string): string {
	return value.replaceAll("\t", " ").replace(/[\r\n]/g, " ");
}

function formatBindingAccounts(binding: AuthGatewayUserPoolBinding): string {
	const credentialIds = binding.pool.members.map(member => String(member.credentialId));
	return credentialIds.length > 0 ? credentialIds.join(",") : "-";
}

function formatUserPoolBindingsHuman(bindings: readonly AuthGatewayUserPoolBinding[]): string {
	const rows = bindings.map(binding =>
		[
			String(binding.position),
			String(binding.poolId),
			formatHumanCell(binding.pool.name),
			formatHumanCell(binding.pool.strategy),
			formatHumanCell(formatBindingAccounts(binding)),
		].join("\t"),
	);
	return `position\tpool\tname\tstrategy\taccounts\n${rows.join("\n")}${rows.length ? "\n" : ""}`;
}

function formatUserShowHuman(value: {
	user: AuthGatewayUser;
	tokens: AuthGatewayToken[];
	acl: AuthGatewayAclRule[];
	poolBindings: AuthGatewayUserPoolBinding[];
}): string {
	const lines = [
		`user ${formatHumanCell(value.user.name)} (#${value.user.id}) ${formatHumanCell(
			value.user.enabled ? "enabled" : "disabled",
		)} role=${formatHumanCell(value.user.role)}`,
		"tokens:",
		"id\tpublicId\tlabel\tlastUsedAt\trevokedAt",
		...value.tokens.map(token =>
			[
				String(token.id),
				formatHumanCell(token.publicId),
				token.label === null ? formatHumanCell("-") : formatHumanCell(token.label),
				token.lastUsedAt === null ? formatHumanCell("-") : String(token.lastUsedAt),
				token.revokedAt === null ? formatHumanCell("-") : String(token.revokedAt),
			].join("\t"),
		),
		"acl:",
		"id\teffect\tkind\tpattern",
		...value.acl.map(rule =>
			[
				String(rule.id),
				formatHumanCell(rule.effect),
				formatHumanCell(rule.kind),
				formatHumanCell(rule.pattern),
			].join("\t"),
		),
		"pools:",
		formatUserPoolBindingsHuman(value.poolBindings).trimEnd(),
	];
	return `${lines.join("\n")}\n`;
}

function positionalCountForGroupedCommand(
	group: "user" | "pool" | "audit",
	subaction: string | undefined,
): number | undefined {
	if (!subaction) return undefined;
	if (group === "user") {
		if (!Object.hasOwn(USER_POSITIONAL_COUNTS, subaction)) {
			throw new Error(`Unknown auth-gateway user sub-command: ${subaction}`);
		}
		return USER_POSITIONAL_COUNTS[subaction]!;
	}
	if (group === "pool") {
		if (!Object.hasOwn(POOL_POSITIONAL_COUNTS, subaction)) {
			throw new Error(`Unknown auth-gateway pool sub-command: ${subaction}`);
		}
		return POOL_POSITIONAL_COUNTS[subaction]!;
	}
	if (!Object.hasOwn(AUDIT_POSITIONAL_COUNTS, subaction)) {
		throw new Error(`Unknown auth-gateway audit sub-command: ${subaction}`);
	}
	return AUDIT_POSITIONAL_COUNTS[subaction]!;
}

function expectedAuthGatewayPositionals(cmd: AuthGatewayCommandArgs): number | undefined {
	switch (cmd.action) {
		case "serve":
		case "token":
		case "status":
		case "check":
			return 1;
		case "tui":
			return 1;
		case "user":
			return positionalCountForGroupedCommand("user", cmd.subaction);
		case "pool":
			return positionalCountForGroupedCommand("pool", cmd.subaction);
		case "audit":
			return positionalCountForGroupedCommand("audit", cmd.subaction);
		default: {
			const _exhaustive: never = cmd.action;
			throw new Error(`Unknown auth-gateway action: ${String(_exhaustive)}`);
		}
	}
}

function validateAuthGatewayPositionals(cmd: AuthGatewayCommandArgs): void {
	const expectedCount = expectedAuthGatewayPositionals(cmd);
	if (expectedCount === undefined) return;
	const declared = [cmd.action, cmd.subaction, cmd.target, cmd.value] as const;
	const lastDefinedIndex = declared.findLastIndex(value => value !== undefined);
	const positionals = cmd.positionals ?? declared.slice(0, lastDefinedIndex + 1).map(value => value ?? "");
	const extras = positionals.slice(expectedCount);
	if (extras.length > 0) {
		const label =
			cmd.action === "user" || cmd.action === "pool" || cmd.action === "audit"
				? `${cmd.action} ${cmd.subaction}`
				: cmd.action;
		throw new Error(`Unexpected positional argument(s) for auth-gateway ${label}: ${extras.join(" ")}`);
	}
}

function requireSubaction(cmd: AuthGatewayCommandArgs, group: string): string {
	if (!cmd.subaction) throw new Error(`Missing ${group} sub-command`);
	return cmd.subaction;
}

function requireTarget(cmd: AuthGatewayCommandArgs, label: string): string {
	if (!cmd.target) throw new Error(`Missing ${label}`);
	return cmd.target;
}

function requireValue(cmd: AuthGatewayCommandArgs, label: string): string {
	if (!cmd.value) throw new Error(`Missing ${label}`);
	return cmd.value;
}

function parsePositiveInteger(value: string, label: string): number {
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${label} must be a positive integer`);
	return parsed;
}

function parseLimit(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) throw new Error("--limit must be between 1 and 1000");
	return parsed;
}

function parseBefore(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	return parsePositiveInteger(value, "--before");
}

function parseSince(value: string | undefined): number | undefined {
	if (value === undefined) return undefined;
	const parsed = Number(value);
	if (!Number.isInteger(parsed) || parsed < 0)
		throw new Error("--since must be a non-negative epoch millisecond value");
	return parsed;
}

function parseRole(value: string | undefined): AuthGatewayRole | undefined {
	if (value === undefined) return undefined;
	if (value !== "user" && value !== "admin") throw new Error("--role must be user or admin");
	return value;
}

function parseStrategy(value: string | undefined): AuthGatewayPoolStrategy | undefined {
	if (value === undefined) return undefined;
	if (value !== "sticky-session" && value !== "least-used" && value !== "round-robin" && value !== "failover") {
		throw new Error("--strategy must be sticky-session, least-used, round-robin, or failover");
	}
	return value;
}

function parsePoolIdList(value: string): number[] {
	const parts = value.split(",");
	const poolIds = parts.map(part => {
		const trimmed = part.trim();
		if (trimmed.length === 0) throw new Error("pool order must be comma-separated positive pool ids");
		const parsed = Number(trimmed);
		if (!Number.isInteger(parsed) || parsed <= 0) {
			throw new Error("pool order must be comma-separated positive pool ids");
		}
		return parsed;
	});
	if (new Set(poolIds).size !== poolIds.length) throw new Error("pool order must not contain duplicate pool ids");
	return poolIds;
}

function resolveAclScope(flags: AuthGatewayCommandArgs["flags"]): { kind: AuthGatewayAclKind; pattern: string } {
	const entries: Array<[AuthGatewayAclKind, string | undefined]> = [
		["provider", flags.provider],
		["model", flags.model],
		["route", flags.route],
	];
	const selected = entries.filter((entry): entry is [AuthGatewayAclKind, string] => entry[1] !== undefined);
	if (selected.length !== 1) throw new Error("Exactly one of --provider, --model, or --route is required");
	const [kind, pattern] = selected[0]!;
	return { kind, pattern };
}

function resolveUser(store: SqliteAuthGatewayAccessStore, ref: string): AuthGatewayUser {
	const user = store.getUser(ref);
	if (!user) throw new Error("user not found");
	return user;
}

function resolvePool(store: SqliteAuthGatewayAccessStore, ref: string): AuthGatewayPool {
	const pool = store.getPool(ref);
	if (!pool) throw new Error("pool not found");
	return pool;
}

async function runUserCommand(cmd: AuthGatewayCommandArgs, deps?: AuthGatewayCommandDependencies): Promise<void> {
	const subaction = requireSubaction(cmd, "user");
	const flags = cmd.flags;
	await withAccessStore(deps, async store => {
		if (subaction === "create") {
			const name = requireTarget(cmd, "user name");
			const created = store.createUser({
				name,
				description: flags.description,
				owner: flags.owner,
				role: parseRole(flags.role),
				tokenLabel: flags.label,
			});
			writeCommandOutput(
				flags,
				created,
				`created user ${created.user.name} (#${created.user.id}) token ${created.token.value}\n`,
			);
			return;
		}
		if (subaction === "list") {
			const users = store.listUsers();
			writeCommandOutput(
				flags,
				{ users },
				users
					.map(user => `${user.id}\t${user.name}\t${user.role}\t${user.enabled ? "enabled" : "disabled"}`)
					.join("\n") + (users.length ? "\n" : ""),
			);
			return;
		}

		const ref = requireTarget(cmd, "user name or id");
		const user = resolveUser(store, ref);
		if (subaction === "show") {
			const value = {
				user,
				tokens: store.listUserTokens(user.id),
				acl: store.listAclRules(user.id),
				poolBindings: store.listUserPoolBindings(user.id),
			};
			writeCommandOutput(flags, value, formatUserShowHuman(value));
			return;
		}
		if (subaction === "update") {
			const patch: { description?: string | null; owner?: string | null; role?: AuthGatewayRole } = {};
			if (Object.hasOwn(flags, "description"))
				patch.description = flags.description === "" ? null : flags.description;
			if (Object.hasOwn(flags, "owner")) patch.owner = flags.owner === "" ? null : flags.owner;
			const role = parseRole(flags.role);
			if (role !== undefined) patch.role = role;
			const updated = store.updateUser(user.id, patch);
			writeCommandOutput(flags, { user: updated }, `updated user ${updated.name} (#${updated.id})\n`);
			return;
		}
		if (subaction === "enable" || subaction === "disable") {
			const updated = store.updateUser(user.id, { enabled: subaction === "enable" });
			writeCommandOutput(
				flags,
				{ user: updated },
				`${updated.enabled ? "enabled" : "disabled"} user ${updated.name} (#${updated.id})\n`,
			);
			return;
		}
		if (subaction === "delete") {
			if (!store.deleteUser(user.id)) throw new Error("user not found");
			const value = { deleted: true as const, user: { id: user.id, name: user.name } };
			writeCommandOutput(flags, value, `deleted user ${user.name} (#${user.id})\n`);
			return;
		}
		if (subaction === "token") {
			const token = flags.regenerate
				? store.rotateUserTokens(user.id, flags.label)
				: store.addUserToken(user.id, flags.label);
			writeCommandOutput(
				flags,
				{ token },
				`${flags.regenerate ? "rotated" : "created"} token ${token.value} for ${user.name}\n`,
			);
			return;
		}
		if (subaction === "token-revoke") {
			const tokenId = parsePositiveInteger(requireValue(cmd, "token id"), "token id");
			if (!store.revokeUserToken(user.id, tokenId)) throw new Error("token not found");
			writeCommandOutput(flags, { revoked: true, tokenId }, `revoked token #${tokenId} for ${user.name}\n`);
			return;
		}
		if (subaction === "allow" || subaction === "deny") {
			const scope = resolveAclScope(flags);
			const result = store.addAclRule(user.id, {
				effect: subaction as AuthGatewayAclEffect,
				kind: scope.kind,
				pattern: scope.pattern,
			});
			writeCommandOutput(
				flags,
				result,
				`${result.created ? "created" : "kept"} ${subaction} ${scope.kind}:${scope.pattern} for ${user.name}\n`,
			);
			return;
		}
		if (subaction === "acl") {
			const acl = store.listAclRules(user.id);
			writeCommandOutput(
				flags,
				{ acl },
				acl.map(rule => `${rule.id}\t${rule.effect}\t${rule.kind}\t${rule.pattern}`).join("\n") +
					(acl.length ? "\n" : ""),
			);
			return;
		}
		if (subaction === "acl-delete") {
			const ruleId = parsePositiveInteger(requireValue(cmd, "rule id"), "rule id");
			if (!store.deleteAclRule(user.id, ruleId)) throw new Error("ACL rule not found");
			writeCommandOutput(flags, { deleted: true, ruleId }, `deleted ACL rule #${ruleId} for ${user.name}\n`);
			return;
		}
		if (subaction === "set-pool" || subaction === "unset-pool") {
			const pool = resolvePool(store, requireValue(cmd, "pool name or id"));
			if (subaction === "set-pool") {
				const result = store.bindUserPool(user.id, pool.id);
				writeCommandOutput(
					flags,
					{ created: result.created, user: { id: user.id, name: user.name }, pool, binding: result.binding },
					`${result.created ? "bound" : "kept"} pool ${pool.name} (#${pool.id}) for ${user.name}\n`,
				);
				return;
			}
			if (!store.unbindUserPool(user.id, pool.id)) throw new Error("pool binding not found");
			writeCommandOutput(
				flags,
				{ removed: true, user: { id: user.id, name: user.name }, pool },
				`unbound pool ${pool.name} (#${pool.id}) from ${user.name}\n`,
			);
			return;
		}
		if (subaction === "reorder-pools") {
			const poolIds = parsePoolIdList(requireValue(cmd, "pool id list"));
			const bindings = store.setUserPoolOrder(user.id, poolIds);
			writeCommandOutput(
				flags,
				{ user: { id: user.id, name: user.name }, bindings },
				formatUserPoolBindingsHuman(bindings),
			);
			return;
		}
		if (subaction === "usage") {
			const usage = store.getUserUsage(user.id, parseSince(flags.since));
			writeCommandOutput(
				flags,
				{ usage },
				`usage for ${user.name}: ${usage.totals.requests} requests, ${usage.totals.totalTokens} tokens, $${usage.totals.costUsd}\n`,
			);
			return;
		}
		throw new Error(`Unknown auth-gateway user sub-command: ${subaction}`);
	});
}

async function runPoolCommand(cmd: AuthGatewayCommandArgs, deps?: AuthGatewayCommandDependencies): Promise<void> {
	const subaction = requireSubaction(cmd, "pool");
	const flags = cmd.flags;
	await withAccessStore(deps, async store => {
		if (subaction === "create") {
			const unsupported = [
				flags.provider !== undefined ? "--provider" : null,
				flags.model !== undefined ? "--model" : null,
			].filter((flag): flag is string => flag !== null);
			if (unsupported.length > 0) {
				throw new Error(`Unsupported option(s) for auth-gateway pool create: ${unsupported.join(", ")}`);
			}
			const pool = store.createPool({
				name: requireTarget(cmd, "pool name"),
				strategy: parseStrategy(flags.strategy),
			});
			writeCommandOutput(flags, { pool }, `created pool ${pool.name} (#${pool.id}) strategy=${pool.strategy}\n`);
			return;
		}
		if (subaction === "list") {
			const pools = store.listPools();
			const rows = pools.map(pool => `${pool.id}\t${pool.name}\t${pool.strategy}\t${pool.members.length} accounts`);
			writeCommandOutput(
				flags,
				{ pools },
				`id\tname\tstrategy\taccounts\n${rows.join("\n")}${rows.length ? "\n" : ""}`,
			);
			return;
		}
		const pool = resolvePool(store, requireTarget(cmd, "pool name or id"));
		if (subaction === "show") {
			const accounts = pool.members.map(member => member.credentialId).join(",");
			writeCommandOutput(
				flags,
				{ pool },
				`pool ${pool.name} (#${pool.id}) strategy=${pool.strategy} accounts=${accounts}\n`,
			);
			return;
		}
		if (subaction === "delete") {
			if (!store.deletePool(pool.id)) throw new Error("pool not found");
			writeCommandOutput(
				flags,
				{ deleted: true, pool: { id: pool.id, name: pool.name } },
				`deleted pool ${pool.name} (#${pool.id})\n`,
			);
			return;
		}
		if (subaction === "rename") {
			const newName = requireValue(cmd, "new pool name");
			const updated = store.updatePool(pool.id, { name: newName });
			writeCommandOutput(flags, { pool: updated }, `renamed pool ${pool.name} (#${pool.id}) to ${updated.name}\n`);
			return;
		}
		if (subaction === "set-strategy") {
			const updated = store.updatePool(pool.id, { strategy: parseStrategy(requireValue(cmd, "strategy")) });
			writeCommandOutput(
				flags,
				{ pool: updated },
				`updated pool ${updated.name} (#${updated.id}) strategy=${updated.strategy}\n`,
			);
			return;
		}
		if (subaction === "add-account") {
			const credentialId = parsePositiveInteger(requireValue(cmd, "credential id"), "credential id");
			const credentials = await loadBrokerCredentials(deps);
			const credential = credentials.find(entry => entry.id === credentialId);
			if (!credential) throw new Error(`credential id ${credentialId} was not found in broker snapshot`);
			const result = store.addPoolCredential(pool.id, credentialId);
			writeCommandOutput(
				flags,
				result,
				`${result.created ? "added" : "kept"} credential #${credentialId} (${credential.provider}) in pool ${pool.name} (#${pool.id})\n`,
			);
			return;
		}
		if (subaction === "remove-account") {
			const credentialId = parsePositiveInteger(requireValue(cmd, "credential id"), "credential id");
			if (!store.removePoolCredential(pool.id, credentialId)) throw new Error("pool member not found");
			const updated = resolvePool(store, String(pool.id));
			writeCommandOutput(
				flags,
				{ removed: true, credentialId, pool: updated },
				`removed credential #${credentialId} from pool ${pool.name} (#${pool.id})\n`,
			);
			return;
		}
		throw new Error(`Unknown auth-gateway pool sub-command: ${subaction}`);
	});
}

async function runAuditCommand(cmd: AuthGatewayCommandArgs, deps?: AuthGatewayCommandDependencies): Promise<void> {
	const subaction = requireSubaction(cmd, "audit");
	if (subaction !== "list") throw new Error(`Unknown auth-gateway audit sub-command: ${subaction}`);
	const flags = cmd.flags;
	await withAccessStore(deps, store => {
		const user = flags.user ? resolveUser(store, flags.user) : undefined;
		const result = store.listAudit({
			userId: user?.id,
			limit: parseLimit(flags.limit),
			before: parseBefore(flags.before),
		});
		writeCommandOutput(
			flags,
			result,
			result.events
				.map(
					event =>
						`${event.id}\t${event.userName ?? "-"}\t${event.outcome}\t${event.method} ${event.path}\t${event.totalTokens} tokens`,
				)
				.join("\n") + (result.events.length ? "\n" : ""),
		);
	});
}

export async function runAuthGatewayCommand(
	cmd: AuthGatewayCommandArgs,
	deps?: AuthGatewayCommandDependencies,
): Promise<void> {
	validateAuthGatewayPositionals(cmd);
	switch (cmd.action) {
		case "serve":
			await runServe(cmd.flags, deps);
			return;
		case "token":
			await runToken(cmd.flags);
			return;
		case "status":
			await runStatus(cmd.flags, deps);
			return;
		case "check":
			await runCheck(cmd.flags);
			return;
		case "user":
			await runUserCommand(cmd, deps);
			return;
		case "pool":
			await runPoolCommand(cmd, deps);
			return;
		case "audit":
			await runAuditCommand(cmd, deps);
			return;
		case "tui":
			await (deps?.runTui ?? runAuthGatewayTui)({ connection: cmd.flags.connection });
			return;
		default: {
			const _exhaustive: never = cmd.action;
			throw new Error(`Unknown auth-gateway action: ${String(_exhaustive)}`);
		}
	}
}

/**
 * Providers whose chat endpoint expects a JSON-serialized credential blob
 * (`{ token, projectId, refreshToken, expiresAt, … }`) rather than the raw
 * access token. Mirrors `getOAuthApiKey` in `packages/ai/src/registry/oauth`.
 */
const STRUCTURED_API_KEY_PROVIDERS: ReadonlySet<string> = new Set([
	"github-copilot",
	"google-gemini-cli",
	"google-antigravity",
]);

/**
 * Provider API types that strict-mode chat probes intentionally skip:
 * - `bedrock-converse-stream` resolves credentials from the AWS env/profile, not the broker bearer.
 * - `google-vertex` uses Application Default Credentials; the broker bearer is not the right key.
 * - `cursor-agent` and `pi-native` (gateway forwarding) have transport quirks
 *   that make a bearer-only "ping" a poor signal.
 */
const STRICT_PROBE_SKIPPED_APIS: ReadonlySet<Api> = new Set<Api>([
	"bedrock-converse-stream",
	"google-vertex",
	"cursor-agent",
]);

/** Max chat models to try per credential before reporting failure. */
const STRICT_PROBE_MAX_CANDIDATES = 4;

/** Per-attempt deadline. Each candidate gets its own slice instead of sharing one budget. */
const STRICT_PROBE_PER_ATTEMPT_TIMEOUT_MS = 15_000;

/**
 * Overall per-credential budget passed to {@link AuthStorage.checkCredentials}.
 * Big enough to walk every candidate at the per-attempt cap with a small
 * margin for refresh/network overhead.
 */
const STRICT_PROBE_OVERALL_TIMEOUT_MS = STRICT_PROBE_PER_ATTEMPT_TIMEOUT_MS * (STRICT_PROBE_MAX_CANDIDATES + 1);

/** Match upstream errors that mean "this model is gone, try a different one" so we walk the catalog instead of declaring the credential bad. */
const RETRYABLE_MODEL_ERROR_RE =
	/not[_ -]found|invalid[_ -]model|model[_ -]is[_ -]not[_ -]valid|no longer supported|deprecated|404|decommissioned/i;

/**
 * Rank bundled models for a provider in probe order: cheapest first, then by
 * id for determinism. Filters out non-bearer-auth APIs (Vertex/Bedrock),
 * pi-native transport (would loop through the gateway), and placeholder /
 * router entries with negative/missing cost.
 */
function pickProbeCandidates(provider: string): Model<Api>[] {
	const bundled = getBundledModels(provider as GeneratedProvider);
	if (bundled.length === 0) return [];
	const candidates = bundled.filter(model => {
		if (model.transport === "pi-native") return false;
		if (STRICT_PROBE_SKIPPED_APIS.has(model.api)) return false;
		if (!model.input.includes("text")) return false;
		const totalCost = (model.cost?.input ?? 0) + (model.cost?.output ?? 0);
		if (!Number.isFinite(totalCost) || totalCost < 0) return false;
		if (model.maxTokens !== null && model.maxTokens <= 0) return false;
		return true;
	});
	candidates.sort((a, b) => a.cost.input + a.cost.output - (b.cost.input + b.cost.output) || a.id.localeCompare(b.id));
	return candidates;
}

/**
 * Compose the apiKey bytes a provider's chat endpoint expects, given a
 * post-refresh probe credential. Mirrors `getOAuthApiKey` for the providers
 * that require a structured blob; otherwise returns the raw access token /
 * API key.
 */
function composeProbeApiKey(provider: string, credential: CompletionProbeInput["credential"]): string {
	if (credential.type === "api_key") return credential.apiKey;
	if (!STRUCTURED_API_KEY_PROVIDERS.has(provider)) return credential.accessToken;
	return JSON.stringify({
		token: credential.accessToken,
		enterpriseUrl: credential.enterpriseUrl,
		projectId: credential.projectId,
		refreshToken: credential.refreshToken,
		expiresAt: credential.expiresAt,
		email: credential.email,
		accountId: credential.accountId,
	});
}

async function probeOneModel(
	model: Model<Api>,
	apiKey: string,
	outerSignal: AbortSignal,
): Promise<CredentialCompletionResult> {
	const start = Date.now();
	const attemptTimeoutSignal = AbortSignal.timeout(STRICT_PROBE_PER_ATTEMPT_TIMEOUT_MS);
	const attemptSignal = AbortSignal.any([outerSignal, attemptTimeoutSignal]);
	// `systemPrompt` is mandatory for some providers (Codex 400s "Instructions
	// are required" without it). `disableReasoning` is intentionally NOT set:
	// providers like Fireworks reject the "none" effort it maps to, and we'd
	// rather burn 16 reasoning tokens than misdiagnose a healthy credential.
	const response = await completeSimple(
		model,
		{
			systemPrompt: ["Connectivity check. Reply with the single word 'pong'."],
			messages: [{ role: "user", content: "ping", timestamp: start }],
		},
		{
			apiKey,
			maxTokens: 32,
			signal: attemptSignal,
		},
	);
	const latencyMs = Date.now() - start;
	if (response.stopReason === "error" || response.stopReason === "aborted") {
		return {
			ok: false,
			reason: response.errorMessage ?? `chat probe ended with stopReason=${response.stopReason}`,
			modelId: model.id,
			latencyMs,
		};
	}
	return { ok: true, modelId: model.id, latencyMs };
}

/**
 * Build the {@link CompletionProbe} consumed by
 * {@link AuthStorage.checkCredentials} in `--strict` mode. Walks the cheapest
 * candidates per provider, retrying on "model not found / invalid model"
 * errors so a stale catalog entry doesn't masquerade as a bad credential.
 * Stops as soon as one model returns a successful response (the credential
 * authenticated against at least one model in the catalog).
 */
function createStrictCompletionProbe(): CompletionProbe {
	return async (input: CompletionProbeInput): Promise<CredentialCompletionResult> => {
		const candidates = pickProbeCandidates(input.provider).slice(0, STRICT_PROBE_MAX_CANDIDATES);
		if (candidates.length === 0) {
			return { ok: null, reason: `no bearer-compatible probe model bundled for provider ${input.provider}` };
		}
		const apiKey = composeProbeApiKey(input.provider, input.credential);
		let lastFailure: CredentialCompletionResult | undefined;
		for (const model of candidates) {
			if (input.signal.aborted) {
				return {
					ok: false,
					reason: "aborted",
					modelId: model.id,
				};
			}
			const result = await probeOneModel(model, apiKey, input.signal);
			if (result.ok === true) return result;
			lastFailure = result;
			if (!RETRYABLE_MODEL_ERROR_RE.test(result.reason ?? "")) {
				// Non-model error (401, 403, 5xx, network) — the credential is the
				// issue, not the catalog. Stop walking.
				return result;
			}
		}
		return (
			lastFailure ?? {
				ok: false,
				reason: `all ${candidates.length} probe models failed for provider ${input.provider}`,
			}
		);
	};
}

function formatCompletionStatus(completion: CredentialCompletionResult | undefined): string {
	if (!completion) return "";
	if (completion.ok === true) return chalk.green(" [chat: ok]");
	if (completion.ok === false) return chalk.red(" [chat: FAIL]");
	return chalk.yellow(" [chat: skip]");
}

/**
 * `omp auth-gateway check` — probe each broker-supplied credential and print
 * per-credential auth health. Use this when the gateway is returning 401s and
 * you need to find which row in a multi-account pool is the bad one. The
 * aggregate `/v1/usage` endpoint silently drops failed credentials, so a
 * dedicated diagnostic is the only way to see which credentials failed.
 *
 * Strict mode (`--strict`) additionally exercises each credential against a
 * cheap chat model from its provider's bundled catalog. This catches the case
 * where the usage endpoint reports 200 but the chat endpoint 401s the same
 * bearer (revoked OAuth scope, mislabeled provider row, etc).
 */
async function runCheck(flags: AuthGatewayCommandArgs["flags"]): Promise<void> {
	const brokerConfig = await resolveAuthBrokerConfig();
	if (!brokerConfig) {
		throw new Error(
			"`omp auth-gateway check` requires OMP_AUTH_BROKER_URL (or `auth.broker.url`/`auth.broker.token` in config.yml). It probes the same credentials the gateway would serve.",
		);
	}

	const accountPool = await loadAuthBrokerAccountPool();
	const client = createBrokerClient(brokerConfig);
	const initialSnapshot = await fetchBrokerSnapshot(client);
	const store = new RemoteAuthCredentialStore({
		client,
		initialSnapshot,
		accountPool,
	});
	const storage = new AuthStorage(store, { sourceLabel: `broker ${brokerConfig.url}` });
	try {
		await storage.reload();
		const results = await storage.checkCredentials(
			flags.strict
				? { completionProbe: createStrictCompletionProbe(), completionTimeoutMs: STRICT_PROBE_OVERALL_TIMEOUT_MS }
				: undefined,
		);

		if (flags.json) {
			process.stdout.write(
				`${JSON.stringify({ broker: brokerConfig.url, strict: flags.strict === true, credentials: results }, null, 2)}\n`,
			);
		} else {
			const grouped = new Map<string, typeof results>();
			for (const row of results) {
				const list = grouped.get(row.provider) ?? [];
				list.push(row);
				grouped.set(row.provider, list);
			}
			const providers = [...grouped.keys()].sort();
			process.stdout.write(`broker: ${brokerConfig.url}${flags.strict ? chalk.dim(" [strict]") : ""}\n`);
			for (const provider of providers) {
				const rows = grouped.get(provider) ?? [];
				process.stdout.write(`\n${chalk.bold(provider)} (${rows.length})\n`);
				for (const row of rows) {
					const status =
						row.ok === true
							? chalk.green("ok      ")
							: row.ok === false
								? chalk.red("FAIL    ")
								: chalk.yellow("unknown ");
					const base =
						row.email ?? row.accountId ?? (row.type === "api_key" ? "(api key)" : "(no identity on credential)");
					// Two subscriptions (orgs) can share one email — without the org a
					// failed row can't say which subscription needs re-login.
					const org = row.orgName ?? row.orgId;
					const identity = org && org !== base ? `${base} (${org})` : base;
					const remote = row.remoteRefresh ? chalk.dim(" [remote-refresh]") : "";
					const reasonParts: string[] = [];
					if (row.reason) reasonParts.push(row.reason);
					if (row.completion?.reason) reasonParts.push(`chat: ${row.completion.reason}`);
					const reason = reasonParts.length > 0 ? chalk.dim(` — ${reasonParts.join("; ")}`) : "";
					const chat = formatCompletionStatus(row.completion);
					process.stdout.write(
						`  ${status}${chat} id=${row.id.toString().padStart(3)} ${row.type.padEnd(7)} ${identity}${remote}${reason}\n`,
					);
				}
			}
			const failed = results.filter(row => row.ok === false).length;
			const unverifiable = results.filter(row => row.ok === null).length;
			const passing = results.filter(row => row.ok === true).length;
			const chatFailed = flags.strict ? results.filter(row => row.completion?.ok === false).length : 0;
			const summaryParts = [
				chalk.green(`${passing} ok`),
				chalk.red(`${failed} failed`),
				chalk.yellow(`${unverifiable} unverifiable`),
			];
			if (flags.strict) summaryParts.push(chalk.red(`${chatFailed} chat-failed`));
			summaryParts.push(`${results.length} total`);
			process.stdout.write(`\n${summaryParts.join(", ")}\n`);
			if (failed > 0 || chatFailed > 0) process.exitCode = 1;
		}
	} finally {
		storage.close();
	}
}

export { ACTIONS as AUTH_GATEWAY_ACTIONS };
