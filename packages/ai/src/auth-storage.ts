/**
 * Credential storage for API keys and OAuth tokens.
 *
 * {@link AuthStorage} composes the credential modules under `./auth/` over one
 * {@link AuthCredentialStore} and exposes them as namespaces:
 * - `credentials` — stored rows, reload/poll, change and disable events, broker snapshot
 * - `keys` — the provider auth cascade (runtime → config → OAuth → login key → env → stored key)
 * - `oauth` — login, per-account access resolution, account listings, refresh
 * - `sessions` — session → account pins
 * - `usage` — usage reports, header ingestion, history
 * - `health` — model pool health and per-credential auth probes
 * - `limits` — usage-limit marking and credential rotation
 * - `resets` — saved rate-limit resets
 * - `blocks` — persisted rate-limit blocks (auth-broker server seam)
 *
 * Fork additions stay flat on this class (they have no upstream namespace):
 * per-provider default-account/priority pinning with its account-selection
 * journal and fallover notices (`pins`), and the auth-gateway credential-pool
 * selection policy (`keys.resolveApiKeySelection`).
 *
 * @example
 * const auth = await AuthStorage.create(getAgentDbPath());
 * await auth.credentials.reload();
 * const apiKey = await auth.keys.get("anthropic", sessionId, { modelId });
 */
import { logger } from "@oh-my-pi/pi-utils";
import { SessionAffinity } from "./auth/affinity";
import { BlockStoreHealth, CredentialBlocks } from "./auth/blocks";
import { KeyCascade, KeyOverrides } from "./auth/cascade";
import { CredentialHealth } from "./auth/health";
import { OAuthAccounts } from "./auth/oauth";
import { AccountPins } from "./auth/pins";
import { AccountPolicies } from "./auth/policy";
import { CredentialPool } from "./auth/pool";
import { OAuthRefresher } from "./auth/refresh";
import { ResetCredits } from "./auth/resets";
import { RateLimits } from "./auth/rotation";
import { CredentialSelector } from "./auth/select";
import { SqliteAuthCredentialStore } from "./auth/sqlite-credential-store";
import type { AuthCredentialStore } from "./auth/store";
import type {
	AccountSelectionEvent,
	AuthApiKeyOptions,
	AuthApiKeySelectionResult,
	AuthCredential,
	AuthStorageOptions,
	BlocksApi,
	CredentialsApi,
	DefaultAccountFallover,
	HealthApi,
	KeysApi,
	LimitsApi,
	OAuthAccountIdentity,
	OAuthApi,
	ResetsApi,
	SessionsApi,
	StoredAuthCredential,
	UsageApi,
} from "./auth/types";
import { UsageService } from "./auth/usage";
import { DEFAULT_USAGE_REQUEST_TIMEOUT_MS, UsageCache } from "./auth/usage-cache";
import type { UsageLogger } from "./usage";
import { defaultRankingStrategy, defaultUsageProvider } from "./usage/registry";

export { isSqliteBusyError, isSqliteCorruptionError, SqliteAuthCredentialStore } from "./auth/sqlite-credential-store";
export * from "./auth/store";
export * from "./auth/types";
export * from "./auth/login";
export * from "./auth/selection";

/**
 * Credential management over an {@link AuthCredentialStore}: multi-account
 * selection with usage-aware ranking, rate-limit blocks, OAuth refresh, and
 * usage reporting. See the module doc for the namespace layout.
 */
export class AuthStorage {
	/** Stored credential rows, change/disable events, broker snapshot. */
	readonly credentials: CredentialsApi;
	/** Provider auth cascade and key overrides. */
	readonly keys: KeysApi;
	/** OAuth login, account access, listings, refresh. */
	readonly oauth: OAuthApi;
	/** Session → account pins. */
	readonly sessions: SessionsApi;
	/** Usage reports, header ingestion, history. */
	readonly usage: UsageApi;
	/** Model pool health and per-credential probes. */
	readonly health: HealthApi;
	/** Usage-limit marking and credential rotation. */
	readonly limits: LimitsApi;
	/** Saved rate-limit resets. */
	readonly resets: ResetsApi;
	/** Persisted rate-limit blocks (auth-broker server seam). */
	readonly blocks: BlocksApi;
	#pool: CredentialPool;
	#pins: AccountPins;
	#affinity: SessionAffinity;

	constructor(store: AuthCredentialStore, options: AuthStorageOptions = {}) {
		const overrides = new KeyOverrides(options.configValueResolver);
		const policies = new AccountPolicies(options.accountPolicies ?? [], options.defaultReservePct);
		const blockHealth = new BlockStoreHealth(options.sourceLabel);
		const strategies = options.rankingStrategyResolver ?? defaultRankingStrategy;
		const pool = new CredentialPool(store, {
			policies,
			blockHealth,
			onReset: provider => {
				selector.resetRoundRobin(provider);
				affinity.clearProvider(provider);
				pins.forgetProvider(provider);
			},
		});
		const refresher = new OAuthRefresher({ store, pool, policies, override: options.refreshOAuthCredential });
		const usageProviders = options.usageProviderResolver ?? defaultUsageProvider;
		const usageCache = new UsageCache(store, pool, usageProviders);
		const blocks = new CredentialBlocks({ store, pool, health: blockHealth, usageCache, strategies });
		const pins = new AccountPins(pool, blocks, options.defaultAccounts, options.accountPriorities);
		const affinity = new SessionAffinity(store, pool, overrides, pins);
		const usage = new UsageService({
			store,
			pool,
			overrides,
			refresher,
			cache: usageCache,
			blocks,
			affinity,
			strategies,
			usageProviders,
			fetch: options.usageFetch ?? fetch,
			requestTimeoutMs: options.usageRequestTimeoutMs ?? DEFAULT_USAGE_REQUEST_TIMEOUT_MS,
			logger:
				options.usageLogger ??
				({
					debug: (message, meta) => logger.debug(message, meta),
					warn: (message, meta) => logger.warn(message, meta),
				} satisfies UsageLogger),
		});
		const selector = new CredentialSelector({
			store,
			pool,
			policies,
			pins,
			blocks,
			affinity,
			usage,
			refresher,
			overrides,
			strategies,
		});
		const limits = new RateLimits({ store, pool, overrides, blocks, affinity, usage, strategies });
		const keys = new KeyCascade({
			pool,
			overrides,
			selector,
			affinity,
			pins,
			rotate: (provider, sessionId, rotateOptions) => limits.rotate(provider, sessionId, rotateOptions),
			sourceLabel: options.sourceLabel,
		});
		const oauth = new OAuthAccounts({ pool, overrides, policies, selector, affinity, refresher });

		this.#pool = pool;
		this.#pins = pins;
		this.#affinity = affinity;
		this.credentials = pool;
		this.keys = keys;
		this.oauth = oauth;
		this.sessions = affinity;
		this.usage = usage;
		this.health = new CredentialHealth({
			store,
			pool,
			keys,
			policies,
			blocks,
			affinity,
			usage,
			refresher,
			overrides,
			strategies,
		});
		this.limits = limits;
		this.resets = new ResetCredits({ store, pool, oauth, usage, usageCache, blocks });
		this.blocks = blocks;
		if (options.onCredentialDisabled) pool.onDisabled(options.onCredentialDisabled);
	}

	/** Open the SQLite store at `dbPath` and wrap it (standalone use, e.g. the pi-ai CLI). */
	static async create(dbPath: string, options: AuthStorageOptions = {}): Promise<AuthStorage> {
		const store = await SqliteAuthCredentialStore.open(dbPath);
		return new AuthStorage(store, options);
	}

	/** Close the underlying credential store; the instance must not be reused. */
	close(): void {
		this.#pool.close();
	}

	/**
	 * Legacy redirect for callers of the pre-namespace flat API (e.g. repo scripts).
	 * @deprecated Use {@link AuthStorage.keys}`.get`.
	 */
	getApiKey(provider: string, sessionId?: string, options?: AuthApiKeyOptions): Promise<string | undefined> {
		return this.keys.get(provider, sessionId, options);
	}

	/**
	 * Legacy redirect for callers of the pre-namespace flat API (e.g. repo scripts).
	 * @deprecated Use {@link AuthStorage.credentials}`.reload`.
	 */
	reload(): Promise<void> {
		return this.credentials.reload();
	}

	// ── Fork feature: credential-pool selection policy ──────────────────────

	/**
	 * Resolve a bearer together with the durable row and cascade leg that
	 * supplied it. With {@link AuthApiKeyOptions.selection} the walk stays
	 * inside the granted pool and reports exhaustion instead of falling
	 * through the cascade.
	 */
	resolveApiKeySelection(
		provider: string,
		sessionId?: string,
		options?: AuthApiKeyOptions,
	): Promise<AuthApiKeySelectionResult> {
		return this.keys.resolveApiKeySelection(provider, sessionId, options);
	}

	// ── Fork feature: per-provider account pins ─────────────────────────────

	/** Configured default-account selector for `provider`, verbatim, or undefined. */
	getDefaultAccountSelector(provider: string): string | undefined {
		return this.#pins.getDefaultAccountSelector(provider);
	}

	/** Durable credential id the configured default resolves to, or undefined. */
	getDefaultAccountCredentialId(provider: string): number | undefined {
		return this.#pins.getDefaultAccountCredentialId(provider);
	}

	/** Identity of the configured default OAuth account, for display. Undefined for api_key rows. */
	getDefaultAccountIdentity(provider: string): OAuthAccountIdentity | undefined {
		return this.#pins.getDefaultAccountIdentity(provider);
	}

	/**
	 * Replace the in-memory default selector so a `/account default` change
	 * takes effect without restarting. Passing `undefined` clears it. Sessions
	 * already bound to another account — the primary and every advisor
	 * provider-session — release their sticky so the new pin serves the next
	 * request instead of taking effect only on restart.
	 */
	setDefaultAccountSelector(provider: string, selector: string | undefined): void {
		if (this.#pins.setDefaultAccountSelector(provider, selector)) {
			this.#affinity.clearProvider(provider);
		}
	}

	/** Configured `providers.accountPriority` selectors for `provider`, in order. */
	getAccountPrioritySelectors(provider: string): readonly string[] {
		return this.#pins.getAccountPrioritySelectors(provider);
	}

	/** Durable credential ids the configured priority list resolves to, in order. */
	getAccountPriorityCredentialIds(provider: string): readonly number[] {
		return this.#pins.getAccountPriorityCredentialIds(provider);
	}

	/**
	 * Selector string that resolves to exactly `credentialId` for `provider`:
	 * the most portable unique identity, else the durable `#<credentialId>` form.
	 */
	describeAccountSelector(provider: string, credentialId: number): string | undefined {
		return this.#pins.describeAccountSelector(provider, credentialId);
	}

	/**
	 * Replace the in-memory account priority order so an `/account priority`
	 * change takes effect without restarting. Passing `undefined` (or an empty
	 * list) clears it, which also unpins the head-derived default. Like
	 * {@link AuthStorage.setDefaultAccountSelector}, bound sessions release
	 * their sticky so the new order applies to the next request.
	 */
	setAccountPrioritySelectors(provider: string, selectors: readonly string[] | undefined): void {
		if (this.#pins.setAccountPrioritySelectors(provider, selectors)) {
			this.#affinity.clearProvider(provider);
		}
	}

	/** Take the pending fallover notice for `(provider, sessionId)`, if any. Consumes it. */
	consumeDefaultAccountFallover(provider: string, sessionId: string): DefaultAccountFallover | undefined {
		return this.#pins.consumeDefaultAccountFallover(provider, sessionId);
	}

	/**
	 * Account-selection journal for this process, oldest first: which account
	 * started serving a session, and why. Powers `/account`'s session log.
	 */
	listAccountSelectionEvents(options?: {
		provider?: string;
		sessionId?: string;
		limit?: number;
	}): readonly AccountSelectionEvent[] {
		return this.#pins.listAccountSelectionEvents(options);
	}

	// ── Fork feature: durable-row access for the gateway management API ─────

	/** List live stored credential rows by id, preserving first requested order. */
	listStoredCredentialsByIds(ids: readonly number[]): StoredAuthCredential[] {
		return this.#pool.listByIds(ids);
	}

	/**
	 * Upsert a credential through the authoritative writer, refresh the
	 * in-memory snapshot, and return the provider's stored rows.
	 */
	upsertCredentialAsync(provider: string, credential: AuthCredential): Promise<StoredAuthCredential[]> {
		return this.#pool.upsertStored(provider, credential);
	}
}
