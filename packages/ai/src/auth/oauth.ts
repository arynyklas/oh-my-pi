import * as AIError from "../error";
import type { OAuthProviderId } from "../registry/oauth/types";
import { providerTypeKey } from "./blocks";
import type { SessionAffinity } from "./affinity";
import type { KeyOverrides } from "./cascade";
import { acquireAuthCredential } from "./login";
import { buildOAuthAccountIdentity } from "./pins";
import type { AccountPolicies } from "./policy";
import type { CredentialPool } from "./pool";
import type { OAuthRefresher } from "./refresh";
import { isCredentialIdEligible } from "./selection";
import type { CredentialSelector } from "./select";
import type {
	AuthAccountPolicy,
	AuthApiKeyOptions,
	AuthCredentialSnapshotEntry,
	AuthCredentialSelectionPolicy,
	OAuthAccess,
	OAuthAccessResolution,
	OAuthAccountIdentity,
	OAuthAccountSummary,
	OAuthApi,
	OAuthCredential,
	OAuthLoginController,
	OAuthLoginIdentity,
	StoredOAuthRefreshOptions,
	StoredOAuthRefreshResult,
} from "./types";

type StoredOAuthSelection = {
	credentialId: number;
	credential: OAuthCredential;
	index: number;
};

/** Dependencies used by the OAuth account operations. */
export interface OAuthAccountsDeps {
	pool: CredentialPool;
	overrides: KeyOverrides;
	policies: AccountPolicies;
	selector: CredentialSelector;
	affinity: SessionAffinity;
	refresher: OAuthRefresher;
}

/** OAuth login, per-account access resolution, and account listings. */
export class OAuthAccounts implements OAuthApi {
	#deps: OAuthAccountsDeps;

	constructor(deps: OAuthAccountsDeps) {
		this.#deps = deps;
	}

	/**
	 * Login to an OAuth provider. Resolves with the stored credential's
	 * identity slice (or `undefined` when nothing was stored) so callers can
	 * surface which account — and for Anthropic, which organization — the
	 * login registered.
	 */
	async login(provider: OAuthProviderId, ctrl: OAuthLoginController): Promise<OAuthLoginIdentity | undefined> {
		const acquired = await acquireAuthCredential(provider, ctrl);
		// The helper reports a cancelled flow as `null` so callers that resume a
		// login wizard can stay silent. `login()` persists, so it must not report
		// a cancellation as "no credential entered": an aborted flow rejects,
		// leaving storage untouched, while an empty prompt still resolves.
		if (!acquired) {
			if (ctrl.signal?.aborted) throw new AIError.LoginCancelledError();
			return undefined;
		}
		if (acquired.credential.type === "api_key") {
			await this.#deps.pool.upsertStored(acquired.provider, { ...acquired.credential, source: "login" });
			return { type: "api_key" };
		}
		// Stamp the interactive-login instant: providers with an absolute grant
		// lifetime (Anthropic) need it to surface re-login deadlines, and token
		// refreshes only ever merge over this credential without clearing it.
		const newCredential: OAuthCredential = { ...acquired.credential, authorizedAt: Date.now() };
		// Use pool.upsertOAuth to upsert the new credential.
		// Any legacy api_key rows from older versions will be cleaned up so they do not
		// shadow the new OAuth row, while preserving other active OAuth credentials.
		await this.#deps.pool.upsertOAuth(acquired.provider, newCredential);
		return {
			type: "oauth",
			email: newCredential.email,
			accountId: newCredential.accountId,
			orgId: newCredential.orgId,
			orgName: newCredential.orgName,
		};
	}

	/**
	 * Resolve the OAuth credential for `provider`, refreshing through the same
	 * pipeline as API-key resolution but returning the refreshed
	 * {@link OAuthAccess} (raw access token + identity metadata) instead of
	 * the API-key bytes.
	 *
	 * Use this when the caller needs to inject identity headers alongside the
	 * bearer (Codex `chatgpt-account-id`, Google `project`, GitHub
	 * `enterpriseUrl`). For pure "give me the bytes for `Authorization`"
	 * scenarios, prefer API-key resolution.
	 *
	 * Returns `undefined` when no OAuth credential is available, the
	 * credential fails to refresh, or runtime/config overrides have replaced
	 * OAuth with an explicit API key.
	 */
	async access(provider: string, sessionId?: string, options?: AuthApiKeyOptions): Promise<OAuthAccess | undefined> {
		// Runtime / config overrides intentionally short-circuit OAuth unless a
		// credential-id selection policy explicitly restricts resolution to stored rows.
		if (!options?.selection && this.#deps.overrides.has(provider)) {
			return undefined;
		}
		const resolved = await this.#deps.selector.resolveOAuth(provider, sessionId, options);
		if (!resolved) return undefined;
		const { credential, credentialId } = resolved;
		return {
			accessToken: credential.access,
			credentialId,
			accountId: credential.accountId,
			email: credential.email,
			projectId: credential.projectId,
			enterpriseUrl: credential.enterpriseUrl,
			apiEndpoint: credential.apiEndpoint,
			orgId: credential.orgId,
			orgName: credential.orgName,
		};
	}

	/**
	 * Stored OAuth credentials for `provider` in stable order, paired with their
	 * full-list index and row id. With a selection policy only eligible rows
	 * appear, and the array position addresses the restricted list.
	 */
	#getStoredOAuthSelections(provider: string, selection?: AuthCredentialSelectionPolicy): StoredOAuthSelection[] {
		return this.#deps.pool
			.entries(provider)
			.map((entry, index) => ({
				credentialId: entry.id,
				credential: entry.credential,
				index,
			}))
			.filter(
				(entry): entry is StoredOAuthSelection =>
					entry.credential.type === "oauth" && isCredentialIdEligible(entry.credentialId, selection),
			);
	}

	/** Refresh one stored OAuth selection and shape it as an {@link OAuthAccessResolution}. */
	async #resolveStoredOAuthAccess(
		provider: string,
		selection: StoredOAuthSelection,
		providerKey: string,
		options: AuthApiKeyOptions | undefined,
	): Promise<OAuthAccessResolution> {
		try {
			const resolved = await this.#deps.selector.tryOAuth(
				provider,
				{ credential: selection.credential, index: selection.index },
				providerKey,
				undefined,
				options,
				{ checkUsage: false, allowBlocked: true, allowFallback: false },
			);
			if (!resolved) {
				return {
					ok: false,
					credentialId: selection.credentialId,
					accountId: selection.credential.accountId,
					email: selection.credential.email,
					projectId: selection.credential.projectId,
					enterpriseUrl: selection.credential.enterpriseUrl,
					orgId: selection.credential.orgId,
					orgName: selection.credential.orgName,
					error: "OAuth access unavailable",
				};
			}
			const { credential } = resolved;
			return {
				ok: true,
				credentialId: selection.credentialId,
				accessToken: credential.access,
				accountId: credential.accountId,
				email: credential.email,
				projectId: credential.projectId,
				enterpriseUrl: credential.enterpriseUrl,
				orgId: credential.orgId,
				orgName: credential.orgName,
			};
		} catch (error) {
			return {
				ok: false,
				credentialId: selection.credentialId,
				accountId: selection.credential.accountId,
				email: selection.credential.email,
				projectId: selection.credential.projectId,
				enterpriseUrl: selection.credential.enterpriseUrl,
				orgId: selection.credential.orgId,
				orgName: selection.credential.orgName,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/**
	 * Read-only list of stored OAuth accounts for `provider` in stable storage
	 * order, WITHOUT refreshing any token. The array position (0-based) is the
	 * selector displayed by a "pick the Nth account" UI as `position + 1`.
	 *
	 * When `sessionId` is supplied, the session-sticky OAuth credential is marked
	 * `active`. No account is active before that session has resolved or pinned a
	 * credential.
	 */
	accounts(provider: string, sessionId?: string): OAuthAccountSummary[] {
		if (this.#deps.overrides.has(provider)) {
			return [];
		}
		const sessionCredential = this.#deps.affinity.get(provider, sessionId);
		const activeCredentialId =
			sessionCredential?.type === "oauth"
				? this.#deps.pool.entries(provider)[sessionCredential.index]?.id
				: undefined;
		return this.#getStoredOAuthSelections(provider).map((selection, position) => ({
			position,
			credentialId: selection.credentialId,
			accountId: selection.credential.accountId,
			email: selection.credential.email,
			projectId: selection.credential.projectId,
			enterpriseUrl: selection.credential.enterpriseUrl,
			orgId: selection.credential.orgId,
			orgName: selection.credential.orgName,
			active: selection.credentialId === activeCredentialId,
		}));
	}

	/**
	 * Resolve every stored OAuth credential for `provider` independently.
	 *
	 * Refreshes credentials through the same broker/local path as
	 * {@link OAuthAccounts.access}, but does not rank, round-robin, or
	 * stop after the first usable account. Intended for diagnostics that must
	 * exercise each stored account exactly once.
	 */
	async accessAll(provider: string, options?: AuthApiKeyOptions): Promise<OAuthAccessResolution[]> {
		if (!options?.selection && this.#deps.overrides.has(provider)) {
			return [];
		}
		const providerKey = providerTypeKey(provider, "oauth");
		return Promise.all(
			this.#getStoredOAuthSelections(provider, options?.selection).map(selection =>
				this.#resolveStoredOAuthAccess(provider, selection, providerKey, options),
			),
		);
	}

	/**
	 * Resolve one stored OAuth credential by its durable storage row id.
	 *
	 * Unlike the normal session resolver, this method never ranks, rotates, or
	 * falls back to sibling credentials. A forced refresh re-mints only the
	 * requested row, preserving exact-account affinity for operations whose
	 * provenance and policy boundary are tied to one workspace.
	 *
	 * Returns `undefined` when the row does not exist for `provider` or an
	 * explicit runtime/config API-key override suppresses OAuth.
	 */
	async accessById(
		provider: string,
		credentialId: number,
		options?: AuthApiKeyOptions,
	): Promise<OAuthAccessResolution | undefined> {
		if (!options?.selection && this.#deps.overrides.has(provider)) {
			return undefined;
		}
		const selection = this.#getStoredOAuthSelections(provider, options?.selection).find(
			candidate => candidate.credentialId === credentialId,
		);
		if (!selection) return undefined;
		const providerKey = providerTypeKey(provider, "oauth");
		return this.#resolveStoredOAuthAccess(provider, selection, providerKey, options);
	}

	/**
	 * Resolve the stored OAuth account at `position` (0-based, in
	 * {@link OAuthAccounts.accounts} order) without refreshing any other row.
	 * Fork feature used by multi-account selection UIs; an
	 * {@link AuthCredentialSelectionPolicy} restricts both the list the position
	 * indexes into and the resolution itself.
	 */
	async accessAt(
		provider: string,
		position: number,
		options?: AuthApiKeyOptions,
	): Promise<OAuthAccessResolution | undefined> {
		if (!options?.selection && this.#deps.overrides.has(provider)) {
			return undefined;
		}
		const selection = this.#getStoredOAuthSelections(provider, options?.selection)[position];
		if (!selection) return undefined;
		const providerKey = providerTypeKey(provider, "oauth");
		return this.#resolveStoredOAuthAccess(provider, selection, providerKey, options);
	}

	/**
	 * Get the OAuth account identity for a provider, preferring the credential that
	 * is session-sticky for `sessionId`. This is a read-only lookup for display and
	 * metadata paths; it does not refresh tokens, rank usage, or advance selection.
	 */
	identity(provider: string, sessionId?: string): OAuthAccountIdentity | undefined {
		const preferred = this.#deps.affinity.activeOAuth(provider, sessionId);
		if (!preferred) return undefined;
		return buildOAuthAccountIdentity(preferred);
	}

	/**
	 * Return the configured account policy matching an OAuth identity.
	 *
	 * This is a read-only diagnostics surface: it performs the same conjunctive
	 * selector match as routing and never refreshes, ranks, or mutates credentials.
	 */
	policy(provider: string, identity: OAuthAccountIdentity): AuthAccountPolicy | undefined {
		return this.#deps.policies.find(provider, identity);
	}

	/** Force-refresh one stored credential by its durable row id. */
	refresh(id: number, signal?: AbortSignal): Promise<AuthCredentialSnapshotEntry> {
		return this.#deps.refresher.refreshById(id, signal);
	}

	/** Refresh one stored OAuth credential through the durable ownership path. */
	refreshStored<T extends OAuthCredential = OAuthCredential>(
		provider: string,
		options: StoredOAuthRefreshOptions<T>,
	): Promise<StoredOAuthRefreshResult<T>> {
		return this.#deps.refresher.refreshStored(provider, options);
	}
}
