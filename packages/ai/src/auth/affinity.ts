import { logger } from "@oh-my-pi/pi-utils";
import { getEnvApiKey } from "../stream";
import type { AccountPins } from "./pins";
import { isCredentialIdEligible } from "./selection";
import type { AuthCredential, AccountSelectionReason, OAuthCredential, SessionsApi } from "./types";
import type { AuthCredentialSelectionPolicy } from "./types";
import type { AuthCredentialStore } from "./store";
import type { CredentialPool } from "./pool";
import type { KeyOverrides } from "./cascade";

/** Prefix for persisted session-to-credential affinity. */
export const SESSION_STICKY_CACHE_PREFIX = "session:sticky:";

/** A session's pinned credential (resolved index + durable row id). */
export type SessionCredential = {
	type: AuthCredential["type"];
	index: number;
	credentialId: number;
	lastUsedAtMs?: number;
	/** Set only by the public user-facing pin API; automatic warm affinity leaves it absent. */
	explicit?: true;
};

/** Recording options: policy scope, backdating, and the journal reason. */
export type RecordSessionCredentialOptions = {
	selection?: AuthCredentialSelectionPolicy;
	/** Backdates the sticky (session-file pin restores on resume); defaults to now. */
	lastUsedAtMs?: number;
	/** Cause shown by `/account`'s session log. */
	reason?: AccountSelectionReason;
	/** Human-readable cause detail. */
	detail?: string;
	/** Marks the entry a user pin that ranking and reserve never evict. */
	explicit?: boolean;
};

/** Storage key for one provider's session map, scoped by policy when present. */
function storageKey(provider: string, selection: AuthCredentialSelectionPolicy | undefined): string {
	return selection ? `${provider}\0${selection.policyKey}` : provider;
}

/** Persistent cache key for one session's sticky, scoped by policy when present. */
function stickyCacheKey(
	provider: string,
	sessionId: string,
	selection: AuthCredentialSelectionPolicy | undefined,
): string {
	return selection
		? `${SESSION_STICKY_CACHE_PREFIX}${provider}:policy:${selection.policyKey}:${sessionId}`
		: `${SESSION_STICKY_CACHE_PREFIX}${provider}:${sessionId}`;
}

/** Session → credential affinity (pins), persisted in the store cache. */
export class SessionAffinity implements SessionsApi {
	/** Tracks the last used credential per (provider, policy) for a session. */
	#sessionLastCredential: Map<string, Map<string, SessionCredential>> = new Map();
	/** `storageKey\0sessionId` -> credential a pin/priority edit released, pending the next selection's journal entry. */
	#releasedSessionCredentials: Map<string, number> = new Map();
	#store: AuthCredentialStore;
	#pool: CredentialPool;
	#overrides: KeyOverrides;
	#pins: AccountPins;

	constructor(store: AuthCredentialStore, pool: CredentialPool, overrides: KeyOverrides, pins: AccountPins) {
		this.#store = store;
		this.#pool = pool;
		this.#overrides = overrides;
		this.#pins = pins;
	}

	/**
	 * Drop every session's sticky credential for `provider` (memory + persistent
	 * cache) while keeping rate-limit blocks, round-robin cursors, and the
	 * journal intact — used both by credential-set changes and by pin/priority
	 * edits, which must make bound sessions (the primary AND every advisor
	 * provider-session) re-resolve against the new order instead of riding
	 * their old pin for the rest of the session.
	 */
	clearProvider(provider: string): void {
		// Deleting the visited key mid-iteration is well-defined for Map, so no snapshot.
		for (const [key, sessionMap] of this.#sessionLastCredential) {
			if (key !== provider && !key.startsWith(`${provider}\0`)) continue;
			for (const [sessionId, entry] of sessionMap) {
				this.#releasedSessionCredentials.set(`${key}\0${sessionId}`, entry.credentialId);
			}
			this.#sessionLastCredential.delete(key);
		}
		try {
			this.#store.deleteCachePrefix?.(`${SESSION_STICKY_CACHE_PREFIX}${provider}:`);
		} catch (err) {
			logger.debug("Failed to clear provider session sticky credentials from persistent store cache", { err });
		}
	}

	/** Drop only this in-memory session pin after OAuth selection falls through. */
	forget(provider: string, sessionId: string): void {
		for (const [key, sessionMap] of this.#sessionLastCredential) {
			if (key !== provider && !key.startsWith(`${provider}\0`)) continue;
			sessionMap.delete(sessionId);
		}
	}

	/**
	 * Records which credential was used for a session (for rate-limit switching)
	 * and journals the change when the serving credential actually moved.
	 * `options.lastUsedAtMs` backdates the sticky (session-file pin restores on
	 * resume); it defaults to now for live selections. `options.reason` is the
	 * cause shown by `/account`'s session log. Automatic re-recording of the same
	 * durable row preserves an explicit user pin.
	 */
	record(
		provider: string,
		sessionId: string | undefined,
		type: AuthCredential["type"],
		index: number,
		options: RecordSessionCredentialOptions = {},
	): void {
		if (!sessionId) return;
		const stored = this.#pool.entries(provider)[index];
		const credentialId = stored?.id;
		if (credentialId === undefined) return;
		const selection = options.selection;
		const nowMs = options.lastUsedAtMs ?? Date.now();
		const key = storageKey(provider, selection);
		const sessionMap = this.#sessionLastCredential.get(key) ?? new Map();
		const releaseKey = `${key}\0${sessionId}`;
		// A pin/priority edit releases the sticky before this re-selection, so the
		// prior binding lives in the release map rather than the sticky map.
		const releasedCredentialId = this.#releasedSessionCredentials.get(releaseKey);
		this.#releasedSessionCredentials.delete(releaseKey);
		const previous = sessionMap.get(sessionId);
		const previousCredentialId = previous?.credentialId ?? releasedCredentialId;
		const sameCredential = previous?.credentialId === credentialId && previous.type === type;
		const isExplicit = options.explicit === true || (sameCredential && previous?.explicit === true);
		const sessionCredential: SessionCredential = {
			type,
			index,
			credentialId,
			lastUsedAtMs: nowMs,
			...(isExplicit ? { explicit: true as const } : {}),
		};
		sessionMap.set(sessionId, sessionCredential);
		this.#sessionLastCredential.set(key, sessionMap);
		if (previousCredentialId !== credentialId) {
			this.#pins.journalAccountSelection({
				atMs: Date.now(),
				provider,
				sessionId,
				credentialId,
				previousCredentialId,
				reason: options.reason ?? (previousCredentialId === undefined ? "initial" : "policy"),
				email: stored.credential.type === "oauth" ? stored.credential.email : undefined,
				accountId: stored.credential.type === "oauth" ? stored.credential.accountId : undefined,
				detail: options.detail,
			});
		}

		try {
			const cacheKey = stickyCacheKey(provider, sessionId, selection);
			// Expires in 30 days
			const expiresAtSec = Math.floor(nowMs / 1000) + 30 * 24 * 60 * 60;
			this.#store.setCache(cacheKey, JSON.stringify(sessionCredential), expiresAtSec);
		} catch (err) {
			logger.debug("Failed to write session sticky credential to persistent store cache", { err });
		}
	}

	/** Retrieves the last credential used by a session. */
	get(
		provider: string,
		sessionId: string | undefined,
		selection?: AuthCredentialSelectionPolicy,
	): SessionCredential | undefined {
		if (!sessionId) return undefined;
		const key = storageKey(provider, selection);
		let sessionMap = this.#sessionLastCredential.get(key);
		const live = sessionMap?.get(sessionId);
		if (live) {
			// Another process can add or drop rows mid-session and the pool is an
			// index-ordered snapshot, so re-resolve the pin through its durable row
			// id: a compacted array must not point the session at a different
			// account, and a deleted account must not hand its slot to a sibling.
			const stored = this.#pool.entries(provider);
			const actualIndex = stored.findIndex(entry => entry.id === live.credentialId);
			const actual = actualIndex >= 0 ? stored[actualIndex] : undefined;
			if (
				actual !== undefined &&
				actual.credential.type === live.type &&
				isCredentialIdEligible(actual.id, selection)
			) {
				live.index = actualIndex;
				return live;
			}
			sessionMap?.delete(sessionId);
		}
		try {
			const cacheKey = stickyCacheKey(provider, sessionId, selection);
			const raw = this.#store.getCache(cacheKey);
			if (raw) {
				const val = JSON.parse(raw) as SessionCredential;

				if (!isCredentialIdEligible(val.credentialId, selection)) {
					this.#store.setCache(cacheKey, "", 0);
					return undefined;
				}
				const stored = this.#pool.entries(provider);
				const actualIndex = stored.findIndex(entry => entry.id === val.credentialId);
				if (actualIndex === -1 || stored[actualIndex]?.credential.type !== val.type) {
					this.#store.setCache(cacheKey, "", 0);
					return undefined;
				}
				val.index = actualIndex;

				if (!sessionMap) {
					sessionMap = new Map();
					this.#sessionLastCredential.set(key, sessionMap);
				}
				const sessionVal: SessionCredential = {
					type: val.type,
					index: val.index,
					credentialId: val.credentialId,
					lastUsedAtMs: val.lastUsedAtMs,
					...(val.explicit === true ? { explicit: true } : {}),
				};
				sessionMap.set(sessionId, sessionVal);
				return sessionVal;
			}
		} catch (err) {
			logger.debug("Failed to read session sticky credential from persistent store cache", { err });
		}
		return undefined;
	}

	/** Clears the last credential used by a session for a provider. */
	clear(provider: string, sessionId: string | undefined, selection?: AuthCredentialSelectionPolicy): void {
		if (!sessionId) return;
		const key = storageKey(provider, selection);
		const sessionMap = this.#sessionLastCredential.get(key);
		if (sessionMap) {
			sessionMap.delete(sessionId);
			if (sessionMap.size === 0) {
				this.#sessionLastCredential.delete(key);
			}
		}
		try {
			const cacheKey = stickyCacheKey(provider, sessionId, selection);
			this.#store.setCache(cacheKey, "", 0);
		} catch (err) {
			logger.debug("Failed to clear session sticky credential from persistent store cache", { err });
		}
	}

	activeOAuth(provider: string, sessionId?: string): OAuthCredential | undefined {
		const allCredentials = this.#pool.credentials(provider);
		const oauthCredentials = allCredentials.filter((c): c is OAuthCredential => c.type === "oauth");
		if (oauthCredentials.length === 0) return undefined;

		// Runtime / config overrides bypass OAuth account_uuid attribution — the
		// caller is authenticating with an explicit key, not the broker's OAuth.
		if (this.#overrides.has(provider)) return undefined;

		// Prefer the session-sticky credential when available.
		const sessionPref = this.get(provider, sessionId);
		// If the session has been routed to a stored API key, do not inject OAuth account_uuid.
		if (sessionPref !== undefined && sessionPref.type !== "oauth") return undefined;

		// When no session-sticky credential is recorded yet (first call before any getApiKey,
		// or all stored credentials are unavailable), the request falls through to the env-key
		// path in getApiKey(), which is not OAuth-authenticated, so account_uuid injection
		// would misattribute traffic. Only apply this guard when sessionPref is absent; a
		// recorded OAuth sticky (sessionPref.type === "oauth") must NOT be blocked even if an
		// env key also happens to exist.
		if (!sessionPref && getEnvApiKey(provider)) return undefined;
		// Resolve the sticky index against the full credential list — the index is
		// recorded against the unfiltered provider array (by record /
		// CredentialSelector.tryOAuth), not the OAuth-only subset, so dereferencing it into the
		// filtered array would be off-by-N when any non-OAuth credential precedes the
		// OAuth ones (e.g. [api_key, oauth_A, oauth_B] stored order).
		const stickyCredential = sessionPref?.type === "oauth" ? allCredentials[sessionPref.index] : undefined;
		return stickyCredential?.type === "oauth" ? stickyCredential : oauthCredentials[0];
	}

	/**
	 * Pin one stored OAuth account as this session's preferred credential.
	 *
	 * The durable credential id keeps the pin stable across credential refreshes,
	 * storage reordering, and process restarts. By default this is an explicit
	 * user pin: ranking and account reserve never evict it; hard unavailability
	 * and auth retry may still route around it.
	 *
	 * `options.restoredAtMs` instead restores an automatic affinity recorded by a
	 * persisted session, backdated to its last use, so it keeps the provider's
	 * warm-window semantics: a resume inside the prompt-cache TTL reuses the
	 * account, a stale resume re-ranks.
	 */
	pin(provider: string, sessionId: string, credentialId: number, options?: { restoredAtMs?: number }): boolean {
		if (!sessionId || this.#overrides.has(provider)) {
			return false;
		}
		const stored = this.#pool.entries(provider);
		const index = stored.findIndex(entry => entry.id === credentialId);
		const target = stored[index];
		if (target?.credential.type !== "oauth") return false;
		const restoredAtMs = options?.restoredAtMs;
		this.record(provider, sessionId, "oauth", index, {
			lastUsedAtMs: restoredAtMs,
			explicit: restoredAtMs === undefined,
			reason: "manual-pin",
		});
		return true;
	}

	/**
	 * Copy every stored credential affinity from one live session to another.
	 *
	 * The target receives its own sticky entries, so request resolution, usage
	 * blocking, credential rotation, metadata, and persisted pins all continue
	 * through the target session id without retaining a live dependency on the
	 * source session.
	 */
	inherit(sourceSessionId: string, targetSessionId: string): number {
		if (!sourceSessionId || !targetSessionId || sourceSessionId === targetSessionId) return 0;
		let inherited = 0;
		for (const provider of this.#pool.providers()) {
			const credential = this.get(provider, sourceSessionId);
			if (!credential) continue;
			this.record(provider, targetSessionId, credential.type, credential.index, {
				lastUsedAtMs: credential.lastUsedAtMs,
				explicit: credential.explicit === true,
			});
			inherited += 1;
		}
		return inherited;
	}

	/**
	 * Release a session's sticky credential so its next `KeyCascade.get` call
	 * re-runs native pool ranking. This never blocks or penalizes the released
	 * account; usage-aware routing uses it when another sibling has more
	 * headroom, before considering a model/provider fallback.
	 */
	release(provider: string, sessionId: string): boolean {
		if (!this.get(provider, sessionId)) return false;
		this.clear(provider, sessionId);
		return true;
	}
}
