/**
 * Per-provider account pinning: the `providers.defaultAccount` /
 * `providers.accountPriority` configuration, the durable selector matching it
 * performs against stored rows, the one-shot default-account fallover notices
 * a blocked pin emits, and the classification of why a session ended up on the
 * account it is using.
 *
 * Separate from {@link AccountPolicies} (upstream's per-account routing
 * priority/reserve): a pin is a user decision expressed as an ordered selector
 * list; its head is the provider's default, and the resolved order outranks
 * live-usage ranking wherever the ranking comparator allows.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { CredentialBlocks } from "./blocks";
import { providerTypeKey } from "./blocks";
import type { CredentialPool, StoredCredential } from "./pool";
import type {
	AccountSelectionEvent,
	AccountSelectionReason,
	AuthCredentialSelectionPolicy,
	DefaultAccountFallover,
	OAuthAccountIdentity,
} from "./types";

/** Bounded history kept for `/account`'s session account-change log. */
const ACCOUNT_SELECTION_JOURNAL_LIMIT = 256;

/** Display slice of an OAuth credential's identity; undefined when it has none. */
export function buildOAuthAccountIdentity(credential: OAuthAccountIdentity): OAuthAccountIdentity | undefined {
	const identity: OAuthAccountIdentity = {};
	if (typeof credential.accountId === "string" && credential.accountId.length > 0) {
		identity.accountId = credential.accountId;
	}
	if (typeof credential.email === "string" && credential.email.length > 0) {
		identity.email = credential.email;
	}
	if (typeof credential.projectId === "string" && credential.projectId.length > 0) {
		identity.projectId = credential.projectId;
	}
	if (typeof credential.orgId === "string" && credential.orgId.length > 0) {
		identity.orgId = credential.orgId;
	}
	if (typeof credential.orgName === "string" && credential.orgName.length > 0) {
		identity.orgName = credential.orgName;
	}
	if (!identity.accountId && !identity.email && !identity.projectId && !identity.orgId) return undefined;
	return identity;
}

/** Context the selection-reason classifier needs about the current request. */
export interface AccountSelectionContext {
	providerKey: string;
	selectionPolicy?: AuthCredentialSelectionPolicy;
	blockScopes?: string | readonly string[];
}

/**
 * Provider account pins: configured default/priority selectors, their live
 * resolution against the credential pool, fallover notices, and the bounded
 * in-process account-selection journal.
 */
export class AccountPins {
	/** Provider id (lowercased) -> configured default-account selector (lowercased, trimmed). */
	#defaultAccountSelectors: Map<string, string> = new Map();
	/** `provider\0selector` tuples whose miss/ambiguity was already logged, to avoid per-request log spam. */
	#defaultAccountLogged: Set<string> = new Set();
	/** Provider id (lowercased) -> ordered account selectors (lowercased, trimmed); head is the pinned default. */
	#accountPrioritySelectors: Map<string, string[]> = new Map();
	/** `provider\0sessionId` -> pending fallover notice, drained once by the session. */
	#pendingDefaultFallovers: Map<string, DefaultAccountFallover> = new Map();
	/** `provider\0sessionId\0usedCredentialId` tuples already announced. */
	#announcedDefaultFallovers: Set<string> = new Set();
	/** Account-selection journal, oldest first, capped at {@link ACCOUNT_SELECTION_JOURNAL_LIMIT}. */
	#accountSelectionEvents: AccountSelectionEvent[] = [];
	#pool: CredentialPool;
	#blocks: CredentialBlocks;

	constructor(
		pool: CredentialPool,
		blocks: CredentialBlocks,
		defaultAccounts: Readonly<Record<string, string>> | undefined,
		accountPriorities: Readonly<Record<string, readonly string[]>> | undefined,
	) {
		this.#pool = pool;
		this.#blocks = blocks;
		if (defaultAccounts) {
			for (const [rawProvider, rawSelector] of Object.entries(defaultAccounts)) {
				const provider = rawProvider.trim().toLowerCase();
				const selector = rawSelector.trim().toLowerCase();
				if (provider.length === 0 || selector.length === 0) continue;
				this.#defaultAccountSelectors.set(provider, selector);
			}
		}
		if (accountPriorities) {
			for (const [rawProvider, rawSelectors] of Object.entries(accountPriorities)) {
				const provider = rawProvider.trim().toLowerCase();
				if (provider.length === 0) continue;
				const selectors = AccountPins.#normalizeAccountPrioritySelectors(rawSelectors);
				if (selectors.length > 0) this.#accountPrioritySelectors.set(provider, selectors);
			}
		}
	}

	/** Trim/lowercase/dedupe a configured priority list, dropping empty entries. */
	static #normalizeAccountPrioritySelectors(selectors: readonly string[]): string[] {
		const normalized: string[] = [];
		for (const raw of selectors) {
			if (typeof raw !== "string") continue;
			const selector = raw.trim().toLowerCase();
			if (selector.length === 0 || normalized.includes(selector)) continue;
			normalized.push(selector);
		}
		return normalized;
	}

	/** Position of `index` in the configured priority order; unranked rows sort last. */
	static priorityRankOf(priorityIndices: readonly number[] | undefined, index: number): number {
		const rank = priorityIndices?.indexOf(index) ?? -1;
		return rank === -1 ? Number.POSITIVE_INFINITY : rank;
	}

	/** Drop pin bookkeeping for a provider whose credential set changed. */
	forgetProvider(provider: string): void {
		const key = provider.toLowerCase();
		for (const logKey of this.#defaultAccountLogged) {
			if (logKey.startsWith(`${key}\0`)) this.#defaultAccountLogged.delete(logKey);
		}
		for (const announceKey of this.#announcedDefaultFallovers) {
			if (announceKey.startsWith(`${provider}\0`)) this.#announcedDefaultFallovers.delete(announceKey);
		}
		for (const pendingKey of this.#pendingDefaultFallovers.keys()) {
			if (pendingKey.startsWith(`${provider}\0`)) this.#pendingDefaultFallovers.delete(pendingKey);
		}
	}

	/** True when `selector` (already lowercased/trimmed) identifies `entry`. */
	#credentialMatchesSelector(entry: StoredCredential, selector: string): boolean {
		if (`#${entry.id}` === selector) return true;
		const credential = entry.credential;
		if (credential.type !== "oauth") return false;
		const candidates = [credential.email, credential.accountId, credential.projectId, credential.enterpriseUrl];
		return candidates.some(value => typeof value === "string" && value.trim().toLowerCase() === selector);
	}

	/**
	 * Index (into `pool.entries(provider)`) the selector resolves to, or
	 * `undefined` when it matches nothing or more than one row. Misses and
	 * ambiguity are logged once per `(provider, selector)` pair.
	 */
	#selectorCredentialIndex(provider: string, selector: string, configKey: string): number | undefined {
		const stored = this.#pool.entries(provider);
		const matches: number[] = [];
		for (let index = 0; index < stored.length; index += 1) {
			if (this.#credentialMatchesSelector(stored[index]!, selector)) matches.push(index);
		}
		if (matches.length === 1) return matches[0];
		const logKey = `${provider.toLowerCase()}\0${selector}`;
		if (matches.length === 0) {
			if (!this.#defaultAccountLogged.has(logKey)) {
				this.#defaultAccountLogged.add(logKey);
				logger.debug(`${configKey} selector matched no stored account`, { provider, selector });
			}
			return undefined;
		}
		if (!this.#defaultAccountLogged.has(logKey)) {
			this.#defaultAccountLogged.add(logKey);
			logger.warn(`Ambiguous ${configKey} selector`, { provider, selector });
		}
		return undefined;
	}

	/**
	 * Credential indices the configured `providers.accountPriority` list
	 * resolves to, in priority order. Unresolvable and duplicate entries are
	 * dropped, so the result is the live preference order among stored rows.
	 */
	priorityCredentialIndices(provider: string): number[] {
		const selectors = this.#accountPrioritySelectors.get(provider.toLowerCase());
		if (!selectors || selectors.length === 0) return [];
		const indices: number[] = [];
		for (const selector of selectors) {
			const index = this.#selectorCredentialIndex(provider, selector, "providers.accountPriority");
			if (index !== undefined && !indices.includes(index)) indices.push(index);
		}
		return indices;
	}

	/**
	 * Index (into `pool.entries(provider)`) of the pinned default account: the
	 * head of `providers.accountPriority` when a priority list is configured,
	 * else the `providers.defaultAccount` selector. `undefined` when nothing is
	 * configured or the selector does not resolve to exactly one stored row.
	 */
	defaultCredentialIndex(provider: string): number | undefined {
		const priorityHead = this.priorityCredentialIndices(provider)[0];
		if (priorityHead !== undefined) return priorityHead;
		const selector = this.#defaultAccountSelectors.get(provider.toLowerCase());
		if (!selector) return undefined;
		return this.#selectorCredentialIndex(provider, selector, "providers.defaultAccount");
	}

	/** Configured default-account selector for `provider`, verbatim, or undefined. */
	getDefaultAccountSelector(provider: string): string | undefined {
		return this.#defaultAccountSelectors.get(provider.toLowerCase());
	}

	/** Durable credential id the configured default resolves to, or undefined. */
	getDefaultAccountCredentialId(provider: string): number | undefined {
		const index = this.defaultCredentialIndex(provider);
		if (index === undefined) return undefined;
		return this.#pool.entries(provider)[index]?.id;
	}

	/** Identity of the configured default OAuth account, for display. Undefined for api_key rows. */
	getDefaultAccountIdentity(provider: string): OAuthAccountIdentity | undefined {
		const index = this.defaultCredentialIndex(provider);
		if (index === undefined) return undefined;
		const credential = this.#pool.entries(provider)[index]?.credential;
		if (credential?.type !== "oauth") return undefined;
		return buildOAuthAccountIdentity(credential);
	}

	/** Configured `providers.accountPriority` selectors for `provider`, in order. */
	getAccountPrioritySelectors(provider: string): readonly string[] {
		return this.#accountPrioritySelectors.get(provider.toLowerCase()) ?? [];
	}

	/** Durable credential ids the configured priority list resolves to, in order. */
	getAccountPriorityCredentialIds(provider: string): readonly number[] {
		const stored = this.#pool.entries(provider);
		return this.priorityCredentialIndices(provider)
			.map(index => stored[index]?.id)
			.filter((id): id is number => id !== undefined);
	}

	/**
	 * Selector string that resolves to exactly `credentialId` for `provider`:
	 * the most portable identity (email → accountId → projectId →
	 * enterpriseUrl) that is unique among stored rows, else the durable
	 * `#<credentialId>` form. Same-email multi-org accounts therefore get an
	 * unambiguous pin instead of a selector `defaultCredentialIndex` would
	 * reject, while single-account setups keep a config value that survives a
	 * re-login into a new row id.
	 */
	describeAccountSelector(provider: string, credentialId: number): string | undefined {
		const stored = this.#pool.entries(provider);
		const entry = stored.find(row => row.id === credentialId);
		if (!entry) return undefined;
		if (entry.credential.type === "oauth") {
			const candidates = [
				entry.credential.email,
				entry.credential.accountId,
				entry.credential.projectId,
				entry.credential.enterpriseUrl,
			];
			for (const candidate of candidates) {
				const trimmed = candidate?.trim();
				if (!trimmed) continue;
				const selector = trimmed.toLowerCase();
				const matches = stored.filter(row => this.#credentialMatchesSelector(row, selector));
				if (matches.length === 1) return trimmed;
			}
		}
		return `#${credentialId}`;
	}

	/** Replace the in-memory default selector; `undefined` clears it. */
	setDefaultAccountSelector(provider: string, selector: string | undefined): boolean {
		const key = provider.toLowerCase();
		const normalized = selector?.trim().toLowerCase();
		if (this.#defaultAccountSelectors.get(key) === normalized) return false;
		if (!normalized) {
			this.#defaultAccountSelectors.delete(key);
		} else {
			this.#defaultAccountSelectors.set(key, normalized);
		}
		this.forgetProvider(provider);
		return true;
	}

	/**
	 * Replace the in-memory account priority order; `undefined`/empty clears it,
	 * which also unpins the head-derived default.
	 */
	setAccountPrioritySelectors(provider: string, selectors: readonly string[] | undefined): boolean {
		const key = provider.toLowerCase();
		const normalized = selectors === undefined ? [] : AccountPins.#normalizeAccountPrioritySelectors(selectors);
		const previous = this.#accountPrioritySelectors.get(key) ?? [];
		if (previous.length === normalized.length && previous.every((entry, at) => entry === normalized[at])) {
			return false;
		}
		if (normalized.length === 0) {
			this.#accountPrioritySelectors.delete(key);
		} else {
			this.#accountPrioritySelectors.set(key, normalized);
		}
		this.forgetProvider(provider);
		return true;
	}

	/**
	 * Note which credential actually served a resolve. When the configured
	 * default has a block relevant to this request and a sibling won, queue a
	 * one-shot fallover notice for `sessionId`. Announced at most once per
	 * (provider, session, winning credential), so a second fallover to a
	 * *different* account is reported again.
	 */
	noteDefaultAccountSelection(
		provider: string,
		sessionId: string | undefined,
		credentialId: number,
		blockScopeOrScopes?: string | readonly string[],
	): void {
		if (sessionId === undefined) return;
		const pendingKey = `${provider}\0${sessionId}`;
		const defaultIndex = this.defaultCredentialIndex(provider);
		if (defaultIndex === undefined) {
			this.#pendingDefaultFallovers.delete(pendingKey);
			return;
		}
		const defaultEntry = this.#pool.entries(provider)[defaultIndex];
		const defaultCredentialId = defaultEntry?.id;
		if (defaultCredentialId === undefined || defaultCredentialId === credentialId) {
			this.#pendingDefaultFallovers.delete(pendingKey);
			return;
		}
		const providerKey = providerTypeKey(provider, defaultEntry.credential.type);
		const retryAtMs = this.#blocks.blockedUntil(provider, providerKey, defaultIndex, blockScopeOrScopes);
		// Resuming or explicitly pinning a sibling is not evidence that the
		// default is unavailable. Only a block relevant to this request is.
		if (retryAtMs === undefined) {
			this.#pendingDefaultFallovers.delete(pendingKey);
			return;
		}
		const announceKey = `${provider}\0${sessionId}\0${credentialId}`;
		if (this.#announcedDefaultFallovers.has(announceKey)) return;
		this.#announcedDefaultFallovers.add(announceKey);
		this.#pendingDefaultFallovers.set(pendingKey, {
			provider,
			defaultCredentialId,
			usedCredentialId: credentialId,
			retryAtMs,
		});
	}

	/** Take the pending fallover notice for `(provider, sessionId)`, if any. Consumes it. */
	consumeDefaultAccountFallover(provider: string, sessionId: string): DefaultAccountFallover | undefined {
		const key = `${provider}\0${sessionId}`;
		const pending = this.#pendingDefaultFallovers.get(key);
		if (pending) this.#pendingDefaultFallovers.delete(key);
		return pending;
	}

	/**
	 * Why `index` ended up serving: the configured priority order it satisfies,
	 * a fallover because a higher-ranked account is blocked, live-usage ranking
	 * when nothing is pinned, or an explicit selection policy. Derived from
	 * current state so every recording site gets the same vocabulary without
	 * threading selection internals through the call stack.
	 */
	classifyAccountSelection(
		provider: string,
		index: number,
		context: AccountSelectionContext,
	): { reason: AccountSelectionReason; detail?: string } {
		if (context.selectionPolicy !== undefined) {
			return { reason: "policy", detail: `${context.selectionPolicy.strategy} selection policy` };
		}
		const priority = this.priorityCredentialIndices(provider);
		const defaultIndex = this.defaultCredentialIndex(provider);
		const order = priority.length > 0 ? priority : defaultIndex !== undefined ? [defaultIndex] : [];
		if (order.length === 0) return { reason: "usage-ranking" };
		const rank = order.indexOf(index);
		if (rank === 0) return { reason: "pinned-default" };
		const skipped = rank === -1 ? order : order.slice(0, rank);
		const blockedSkipped = skipped.filter(candidate =>
			this.#blocks.isBlocked(provider, context.providerKey, candidate, context.blockScopes),
		);
		if (blockedSkipped.length > 0) {
			return {
				reason: "fallover-blocked",
				detail:
					blockedSkipped.length === skipped.length
						? "every higher-priority account is rate-limited"
						: "a higher-priority account is rate-limited",
			};
		}
		if (rank > 0) return { reason: "priority", detail: `priority #${rank + 1}` };
		return { reason: "usage-ranking", detail: "outranked the pinned accounts on plan or quota" };
	}

	/** Append to the bounded in-process account-selection journal. */
	journalAccountSelection(event: AccountSelectionEvent): void {
		this.#accountSelectionEvents.push(event);
		if (this.#accountSelectionEvents.length > ACCOUNT_SELECTION_JOURNAL_LIMIT) {
			this.#accountSelectionEvents.splice(0, this.#accountSelectionEvents.length - ACCOUNT_SELECTION_JOURNAL_LIMIT);
		}
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
		const provider = options?.provider?.toLowerCase();
		const filtered = this.#accountSelectionEvents.filter(
			event =>
				(provider === undefined || event.provider.toLowerCase() === provider) &&
				(options?.sessionId === undefined || event.sessionId === options.sessionId),
		);
		const limit = options?.limit;
		return limit !== undefined && limit >= 0 && filtered.length > limit ? filtered.slice(-limit) : filtered;
	}
}
