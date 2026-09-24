import { logger } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import { getOAuthApiKey, getOAuthProvider } from "../registry/oauth";
import type { OAuthCredentials, OAuthProvider } from "../registry/oauth/types";
import type { Provider } from "../types";
import type { CredentialRankingContext, CredentialRankingStrategy, PlanGate, UsageReport } from "../usage";
import type { RankingStrategyResolver } from "../usage/registry";
import { raceSignal } from "./abort";
import type { SessionAffinity } from "./affinity";
import { credentialBlockScopesForRequest, DEFAULT_BLOCK_MS, providerTypeKey, type CredentialBlocks } from "./blocks";
import type { KeyOverrides } from "./cascade";
import type { AccountPolicies } from "./policy";
import { AccountPins } from "./pins";
import { authCredentialEquals, type CredentialPool } from "./pool";
import {
	orderUsageRankedCandidates,
	planPriority,
	type ApiKeyCandidate,
	type ApiKeySelection,
	type OAuthCandidate,
	type OAuthSelection,
	type RankedApiKeyCandidate,
	type RankedOAuthCandidate,
	type UsageRankingResult,
} from "./rank";
import { mergeRefreshedCredential, OAUTH_REFRESH_SKEW_MS, type OAuthRefresher } from "./refresh";
import { eligibleSelectionCredentialIds, eligibleStoredCredentials, findStoredSelectionCredential } from "./selection";
import type { AuthCredentialStore } from "./store";
import type {
	ApiKeyCredential,
	AuthApiKeyOptions,
	AuthApiKeySelectionResult,
	AuthCredential,
	AuthCredentialSelectionPolicy,
	OAuthCredential,
	ResolvedAuthCredential,
	StoredSelectionCredential,
} from "./types";
import type { UsageService } from "./usage";
import {
	isUsageLimitReached,
	normalizeUsageFraction,
	remainingUsageFraction,
	scopedUsageLimits,
	usageResetAtMs,
	windowRequiredDrain,
} from "./usage-report";

/** Temporary block after a transient OAuth refresh failure. */
export const OAUTH_REFRESH_FAILURE_BACKOFF_MS = 5 * 60 * 1000;

/** OAuth bearer and credential chosen for a request, with its durable row id when available. */
export type OAuthResolutionResult = { apiKey: string; credential: OAuthCredential; credentialId?: number };

/** OAuth resolution that completed through a credential-selection mode (durable id guaranteed). */
type ResolvedOAuthSelection = { apiKey: string; credential: OAuthCredential; credentialId: number };

/** How {@link CredentialSelector.resolveOAuthMode} scopes candidate evaluation. */
type OAuthSelectionMode =
	| { kind: "default" }
	| { kind: "target"; credentialId: number }
	| { kind: "live-usage"; attemptedCredentialIds: Set<number> };

/** Options for CredentialSelector.tryOAuth when evaluating one OAuth credential. */
export type TryOAuthOptions = {
	checkUsage: boolean;
	allowBlocked: boolean;
	prefetchedUsage?: UsageReport | null;
	usagePrechecked?: boolean;
	planGate?: PlanGate;
	enforcePlanRequirement?: boolean;
	strategy?: CredentialRankingStrategy;
	rankingContext?: CredentialRankingContext;
	blockScope?: string;
	blockScopes?: readonly string[];
	/** When false, a definitive failure of THIS credential returns undefined instead of falling back to the ranked/round-robin selector (target-only resolution). */
	allowFallback?: boolean;
};

/** Services consulted by CredentialSelector for policy, usage, blocks, refresh, and session affinity. */
export interface CredentialSelectorDeps {
	store: AuthCredentialStore;
	pool: CredentialPool;
	policies: AccountPolicies;
	pins: AccountPins;
	blocks: CredentialBlocks;
	affinity: SessionAffinity;
	usage: UsageService;
	refresher: OAuthRefresher;
	overrides: KeyOverrides;
	strategies: RankingStrategyResolver;
}

/** Picks which stored credential serves a request: ordering, usage ranking, OAuth refresh ladder. */
export class CredentialSelector {
	/** Tracks next credential index per provider:type key for round-robin distribution (non-session use). */
	#providerRoundRobinIndex: Map<string, number> = new Map();
	#deps: CredentialSelectorDeps;

	constructor(deps: CredentialSelectorDeps) {
		this.#deps = deps;
	}

	/** Restart round-robin assignments after a provider's credential set changed. */
	resetRoundRobin(provider: string): void {
		for (const key of this.#providerRoundRobinIndex.keys()) {
			if (key.startsWith(`${provider}:`) || key.includes(`:${provider}:`)) {
				this.#providerRoundRobinIndex.delete(key);
			}
		}
	}

	/**
	 * Returns next index in round-robin sequence for load distribution.
	 * Increments stored counter and wraps at total.
	 */
	#getNextRoundRobinIndex(providerKey: string, total: number): number {
		if (total <= 1) return 0;
		const current = this.#providerRoundRobinIndex.get(providerKey) ?? -1;
		const next = (current + 1) % total;
		this.#providerRoundRobinIndex.set(providerKey, next);
		return next;
	}

	/**
	 * FNV-1a hash for deterministic session-to-credential mapping.
	 * Ensures the same session always starts with the same credential.
	 */
	#getHashedIndex(sessionId: string, total: number): number {
		if (total <= 1) return 0;
		return Bun.hash.xxHash32(sessionId) % total;
	}

	/**
	 * Returns credential indices in priority order for selection.
	 * With sessionId: starts from hashed index (consistent per session).
	 * Without sessionId: starts from round-robin index (load balancing).
	 * Order wraps around so all credentials are tried if earlier ones are blocked.
	 */
	#getCredentialOrder(providerKey: string, sessionId: string | undefined, total: number): number[] {
		if (total <= 1) return [0];
		const start = sessionId
			? this.#getHashedIndex(sessionId, total)
			: this.#getNextRoundRobinIndex(providerKey, total);
		const order: number[] = [];
		for (let i = 0; i < total; i++) {
			order.push((start + i) % total);
		}
		return order;
	}

	/** Round-robin cursor key: policies keep their own cursor per provider:type. */
	#selectionRoundRobinKey(
		provider: string,
		type: AuthCredential["type"],
		selection: AuthCredentialSelectionPolicy | undefined,
	): string {
		const providerKey = providerTypeKey(provider, type);
		return selection ? `${selection.policyKey}:${providerKey}` : providerKey;
	}

	/**
	 * Selects a credential of the specified type for a provider.
	 * Returns the credential, its durable row id, and its index in the pool
	 * array (for updates/removal). Uses deterministic hashing for session
	 * stickiness and skips blocked credentials when possible. With a selection
	 * policy, only eligible rows participate and the policy's own strategy
	 * (sticky-session, round-robin, least-used, failover) decides the walk;
	 * an exhausted policy pool returns undefined instead of a blocked fallback.
	 */
	selectByType<T extends AuthCredential["type"]>(
		provider: string,
		type: T,
		sessionId?: string,
		filter?: (credential: AuthCredential) => boolean,
		selection?: AuthCredentialSelectionPolicy,
	): StoredSelectionCredential<Extract<AuthCredential, { type: T }>> | undefined {
		const credentials = eligibleStoredCredentials(this.#deps.pool, provider, type, selection, filter);

		if (credentials.length === 0) return undefined;

		const providerKey = providerTypeKey(provider, type);
		const sticky = this.#deps.affinity.get(provider, sessionId, selection);
		const stickyPosition =
			sticky?.type === type
				? credentials.findIndex(
						candidate =>
							candidate.index === sticky.index &&
							!this.#deps.blocks.isBlocked(provider, providerKey, sticky.index),
					)
				: -1;
		const shouldKeepSticky = selection?.strategy === "sticky-session" || selection?.strategy === "round-robin";
		if (shouldKeepSticky && stickyPosition >= 0) return credentials[stickyPosition];

		let order: number[];
		if (selection?.strategy === "round-robin") {
			const start = this.#getNextRoundRobinIndex(
				this.#selectionRoundRobinKey(provider, type, selection),
				credentials.length,
			);
			order = Array.from({ length: credentials.length }, (_value, index) => (start + index) % credentials.length);
		} else if (selection?.strategy === "least-used" || selection?.strategy === "failover") {
			order = credentials.map((_credential, index) => index);
		} else {
			order = this.#getCredentialOrder(
				this.#selectionRoundRobinKey(provider, type, selection),
				sessionId,
				credentials.length,
			);
		}

		const fallback = credentials[order[0]];
		for (const idx of order) {
			const candidate = credentials[idx];
			if (candidate && !this.#deps.blocks.isBlocked(provider, providerKey, candidate.index)) {
				return candidate;
			}
		}

		return selection ? undefined : fallback;
	}

	async #rankApiKeySelections(args: {
		providerKey: string;
		provider: string;
		order: number[];
		credentials: ApiKeySelection[];
		options?: AuthApiKeyOptions;
		strategy: CredentialRankingStrategy;
		rankingContext: CredentialRankingContext;
		blockScope?: string;
		/** Scopes a block may live under for this request; reads honour all of them. */
		blockScopes?: readonly string[];
	}): Promise<ApiKeyCandidate[]> {
		const nowMs = Date.now();
		const { strategy } = args;
		const ranked: RankedApiKeyCandidate[] = [];
		const usageTimeout = Math.max(5000, this.#deps.usage.requestTimeoutMs * 1.5);
		const usagePromise: Promise<Array<UsageRankingResult<ApiKeyCredential> | null>> = Promise.all(
			args.order.map(async idx => {
				const selection = args.credentials[idx];
				if (!selection) return null;
				const blockedUntil = this.#deps.blocks.blockedUntil(
					args.provider,
					args.providerKey,
					selection.index,
					args.blockScopes ?? args.blockScope,
				);
				if (blockedUntil !== undefined) {
					return { selection, usage: null, usageChecked: false, blockedUntil };
				}
				const usage = await this.#deps.usage.report(args.provider, selection.credential, {
					...args.options,
					timeoutMs: this.#deps.usage.requestTimeoutMs,
				});
				return {
					selection,
					usage,
					usageChecked: true,
					blockedUntil: undefined,
				};
			}),
		);
		const timeoutSignal = Promise.withResolvers<null>();
		const timer = setTimeout(() => timeoutSignal.resolve(null), usageTimeout);
		timer.unref?.();
		const usageResults = await Promise.race([usagePromise, timeoutSignal.promise]).then(result => {
			clearTimeout(timer);
			if (result) return result;
			return args.order.map(idx => {
				const selection = args.credentials[idx];
				if (!selection) return null;
				const blockedUntil = this.#deps.blocks.blockedUntil(
					args.provider,
					args.providerKey,
					selection.index,
					args.blockScopes ?? args.blockScope,
				);
				return { selection, usage: null, usageChecked: false, blockedUntil };
			});
		});

		for (let orderPos = 0; orderPos < usageResults.length; orderPos += 1) {
			const result = usageResults[orderPos];
			if (!result) continue;
			const { selection, usage, usageChecked } = result;
			let { blockedUntil } = result;
			let blocked = blockedUntil !== undefined;
			const scopedLimits = usage ? scopedUsageLimits(strategy, usage, args.rankingContext) : undefined;
			if (!blocked && scopedLimits && isUsageLimitReached(scopedLimits)) {
				const resetAtMs = usageResetAtMs(scopedLimits, nowMs);
				blockedUntil = resetAtMs ?? Date.now() + DEFAULT_BLOCK_MS;
				this.#deps.blocks.mark(
					args.provider,
					args.providerKey,
					selection.index,
					blockedUntil,
					args.blockScope,
					resetAtMs !== undefined,
				);
				blocked = true;
			}
			const windows = usage ? strategy.findWindowLimits(usage, args.rankingContext) : undefined;
			const primary = windows?.primary;
			const secondary = windows?.secondary;
			const usageMeasured = primary !== undefined || secondary !== undefined;
			const primaryUncapped = primary === undefined && secondary !== undefined;
			ranked.push({
				selection,
				usage,
				usageChecked,
				blocked,
				blockedUntil,
				inReserve: false,
				accountPriority: 0,
				usageMeasured,
				priorityRank: Number.POSITIVE_INFINITY,
				hasPriorityBoost: strategy.hasPriorityBoost?.(primary, primaryUncapped, args.rankingContext) ?? false,
				planPriority: 0,
				secondaryUsed: normalizeUsageFraction(secondary),
				secondaryRequiredDrain: windowRequiredDrain(secondary, nowMs, strategy.windowDefaults.secondaryMs),
				primaryUsed: normalizeUsageFraction(primary),
				primaryRequiredDrain: windowRequiredDrain(primary, nowMs, strategy.windowDefaults.primaryMs),
				orderPos,
			});
		}
		return orderUsageRankedCandidates(ranked, false);
	}

	async selectApiKey(
		provider: string,
		sessionId: string | undefined,
		options: AuthApiKeyOptions | undefined,
		filter?: (credential: ApiKeyCredential) => boolean,
	): Promise<ApiKeySelection | undefined> {
		const credentials = this.#deps.pool
			.entries(provider)
			.map((entry, index) => ({ id: entry.id, credential: entry.credential, index }))
			.filter((entry): entry is ApiKeySelection => {
				if (entry.credential.type !== "api_key") return false;
				return filter?.(entry.credential) ?? true;
			});

		if (credentials.length === 0) return undefined;
		if (credentials.length === 1) return credentials[0];

		const providerKey = providerTypeKey(provider, "api_key");
		const defaultIndex =
			options?.selection === undefined ? this.#deps.pins.defaultCredentialIndex(provider) : undefined;
		const defaultPos = defaultIndex !== undefined ? credentials.findIndex(entry => entry.index === defaultIndex) : -1;
		const hasDefault = defaultPos >= 0;
		const baseOrder = this.#getCredentialOrder(providerKey, sessionId, credentials.length);
		const order = hasDefault ? [defaultPos, ...baseOrder.filter(pos => pos !== defaultPos)] : baseOrder;
		const fallback = credentials[order[0]];
		const strategy = this.#deps.strategies(provider);
		if (!strategy || hasDefault) {
			for (const idx of order) {
				const candidate = credentials[idx];
				if (!this.#deps.blocks.isBlocked(provider, providerKey, candidate.index)) {
					return candidate;
				}
			}
			return fallback;
		}

		const rankingContext: CredentialRankingContext = {
			modelId: options?.modelId,
		};
		const blockScope = strategy.blockScope?.(rankingContext);
		const blockScopes = credentialBlockScopesForRequest(provider, strategy, rankingContext, blockScope);
		const candidates = await this.#rankApiKeySelections({
			providerKey,
			provider,
			order,
			credentials,
			options,
			strategy,
			rankingContext,
			blockScope,
			blockScopes,
		});
		const winner = candidates[0]?.selection;
		if (!winner) return fallback;
		// The ranked candidate list carries the pool-relative selection; re-resolve
		// it onto the id-bearing entry so callers can address the durable row.
		return credentials.find(entry => entry.index === winner.index) ?? fallback;
	}

	async #rankOAuthSelections(args: {
		providerKey: string;
		provider: string;
		order: number[];
		planGate: PlanGate | undefined;
		credentials: OAuthSelection[];
		options?: AuthApiKeyOptions;
		strategy?: CredentialRankingStrategy;
		defaultReservePct?: number;
		rankingContext: CredentialRankingContext;
		blockScope?: string;
		/** Scopes a block may live under for this request; reads honour all of them. */
		blockScopes?: readonly string[];
		/** Credential indices in configured priority order; position 0 is the pinned default. */
		priorityIndices?: readonly number[];
	}): Promise<OAuthCandidate[]> {
		const nowMs = Date.now();
		const { strategy } = args;
		const ranked: RankedOAuthCandidate[] = [];
		// Pre-fetch usage reports in parallel for non-blocked credentials.
		// Wrap with a timeout so slow/429'd fetches don't indefinitely block
		// credential selection — better to pick a credential without usage data
		// than to hang the agent waiting for rate-limited usage endpoints.
		const usageTimeout = Math.max(5000, this.#deps.usage.requestTimeoutMs * 1.5);
		const usagePromise = Promise.all(
			args.order.map(async idx => {
				const selection = args.credentials[idx];
				if (!selection) return null;
				let blockedUntil = this.#deps.blocks.blockedUntil(
					args.provider,
					args.providerKey,
					selection.index,
					args.blockScopes ?? args.blockScope,
				);
				let usage: UsageReport | null = null;
				let usageChecked = false;
				// A block must still fetch a probe report, or it outlives the recovery
				// that report would prove: no report means no reconciliation, so the
				// credential idles until the clock runs out even after quota is
				// restored. The probe is spent for any healable provider rather than
				// only for scoped blocks, because our strategies also vouch for the
				// unscoped block (`blockScope: ""`) a legacy usage limit leaves behind.
				if (blockedUntil !== undefined && this.#deps.blocks.supportsHealing(args.provider)) {
					usage = await this.#deps.usage.report(args.provider, selection.credential, {
						...args.options,
						timeoutMs: this.#deps.usage.requestTimeoutMs,
					});
					usageChecked = true;
					blockedUntil = this.#deps.blocks.blockedUntil(
						args.provider,
						args.providerKey,
						selection.index,
						args.blockScopes ?? args.blockScope,
					);
				}
				if (blockedUntil !== undefined) return { selection, usage, usageChecked, blockedUntil };
				if (!usageChecked) {
					usage = await this.#deps.usage.report(args.provider, selection.credential, {
						...args.options,
						timeoutMs: this.#deps.usage.requestTimeoutMs,
					});
					usageChecked = true;
				}
				return {
					selection,
					usage,
					usageChecked,
					blockedUntil: undefined as number | undefined,
				};
			}),
		);
		const timeoutSignal = Promise.withResolvers<null>();
		// `Bun.sleep` keeps the event loop alive even after Promise.race resolves,
		// which leaks a 7.5–15s timer per credential-selection call. Use an unref'd
		// timer so the timeout doesn't pin the process and clear it on the happy
		// path so memory drops immediately.
		const timer = setTimeout(() => timeoutSignal.resolve(null), usageTimeout);
		timer.unref?.();
		const usageResults = await Promise.race([usagePromise, timeoutSignal.promise]).then(result => {
			clearTimeout(timer);
			return (
				result ??
				args.order.map(idx => {
					const selection = args.credentials[idx];
					return selection
						? {
								selection,
								usage: null,
								usageChecked: false,
								blockedUntil: undefined,
							}
						: null;
				})
			);
		});

		for (let orderPos = 0; orderPos < usageResults.length; orderPos += 1) {
			const result = usageResults[orderPos];
			if (!result) continue;
			const { selection, usage, usageChecked } = result;
			let { blockedUntil } = result;
			let blocked = blockedUntil !== undefined;
			const scopedLimits = usage && strategy ? scopedUsageLimits(strategy, usage, args.rankingContext) : undefined;
			if (!blocked && scopedLimits && isUsageLimitReached(scopedLimits)) {
				const resetAtMs = usageResetAtMs(scopedLimits, nowMs);
				blockedUntil = resetAtMs ?? Date.now() + DEFAULT_BLOCK_MS;
				this.#deps.blocks.mark(
					args.provider,
					args.providerKey,
					selection.index,
					blockedUntil,
					args.blockScope,
					resetAtMs !== undefined,
				);
				blocked = true;
			}
			const windows = usage && strategy ? strategy.findWindowLimits(usage, args.rankingContext) : undefined;
			const primary = windows?.primary;
			const secondary = windows?.secondary;
			const remainingFraction = remainingUsageFraction(strategy, usage, args.rankingContext, nowMs);
			const usageMeasured =
				strategy === undefined ? remainingFraction !== undefined : primary !== undefined || secondary !== undefined;
			const primaryUncapped = primary === undefined && secondary !== undefined;
			const policy = this.#deps.policies.forCredential(args.provider, selection.credential);
			const reservePct = policy?.reservePct ?? args.defaultReservePct;
			const reserveFraction =
				reservePct === undefined || !Number.isFinite(reservePct)
					? undefined
					: Math.max(0, Math.min(1, reservePct / 100));
			ranked.push({
				selection,
				usage,
				usageChecked,
				blocked,
				blockedUntil,
				inReserve:
					reserveFraction !== undefined && remainingFraction !== undefined && remainingFraction <= reserveFraction,
				reserveMeasured: reserveFraction !== undefined && remainingFraction !== undefined,
				accountPriority: policy?.priority === undefined || !Number.isFinite(policy.priority) ? 0 : policy.priority,
				usageMeasured,
				priorityRank: AccountPins.priorityRankOf(args.priorityIndices, selection.index),
				hasPriorityBoost: strategy?.hasPriorityBoost?.(primary, primaryUncapped, args.rankingContext) ?? false,
				planPriority: planPriority(args.planGate, usage),
				secondaryUsed: strategy ? normalizeUsageFraction(secondary) : 0,
				secondaryRequiredDrain:
					strategy === undefined ? 0 : windowRequiredDrain(secondary, nowMs, strategy.windowDefaults.secondaryMs),
				primaryUsed: strategy ? normalizeUsageFraction(primary) : 0,
				primaryRequiredDrain:
					strategy === undefined ? 0 : windowRequiredDrain(primary, nowMs, strategy.windowDefaults.primaryMs),
				orderPos,
			});
		}
		return orderUsageRankedCandidates(ranked, args.planGate !== undefined);
	}

	/**
	 * Resolves an OAuth credential, trying credentials in priority order.
	 *
	 * Resolution ladder — a request in hand always beats "no API key":
	 * 1. strict: unblocked credentials only, usage limits respected, plan
	 *    filter enforced (when any account is confirmed eligible);
	 * 2. plan-fitting last resort: same plan filter, but blocked/exhausted
	 *    accounts are allowed (blocked candidates rank earliest-unblocking
	 *    first) so the caller gets real usage-limit semantics from the wire
	 *    instead of a missing key;
	 * 3. unfiltered last resort: the plan filter matched nothing usable —
	 *    skip it and try every account once; the server is the final arbiter
	 *    of model access.
	 *
	 * Returns both the API key bytes for outbound requests AND the refreshed
	 * {@link OAuthCredential} so callers needing identity metadata (account id,
	 * project id, etc.) do not have to dereference the snapshot themselves.
	 */
	async resolveOAuth(
		provider: string,
		sessionId?: string,
		options?: AuthApiKeyOptions,
	): Promise<OAuthResolutionResult | undefined> {
		await this.#deps.pool.adoptExternalChanges();
		return this.resolveOAuthMode(provider, sessionId, options, { kind: "default" });
	}

	/**
	 * {@link CredentialSelector.resolveOAuth} with an explicit resolution mode.
	 * `target` restricts the ladder to one durable row (exact-account forced
	 * refresh), `live-usage` restricts it to rows a fresh usage report still
	 * vouches for (least-used policy rotation), and records every row it
	 * actually attempted so the caller can distinguish "exhausted" from
	 * "missing".
	 */
	async resolveOAuthMode(
		provider: string,
		sessionId: string | undefined,
		options: AuthApiKeyOptions | undefined,
		mode: OAuthSelectionMode,
	): Promise<ResolvedOAuthSelection | undefined> {
		const selectionPolicy = options?.selection;
		const credentials = eligibleStoredCredentials(this.#deps.pool, provider, "oauth", selectionPolicy);
		// Validate the full stored set, not the policy's slice: an account-policy
		// row outside this principal's pool is still configured and must not read
		// as "matches no stored OAuth account".
		this.#deps.policies.validateFor(
			provider,
			this.#deps.pool
				.credentials(provider)
				.filter((credential): credential is OAuthCredential => credential.type === "oauth"),
		);
		if (credentials.length === 0) return undefined;
		this.#deps.policies.validateUsageCapability(provider, this.#deps.usage.canFetchOAuthUsage(provider));

		const providerKey = providerTypeKey(provider, "oauth");
		const defaultIndex = selectionPolicy === undefined ? this.#deps.pins.defaultCredentialIndex(provider) : undefined;
		const hasDefault = defaultIndex !== undefined && credentials.some(entry => entry.index === defaultIndex);
		// Explicit selection policies (round-robin, least-used, …) own their own
		// ordering; the user's configured priority applies to normal traffic.
		// A bare `providers.defaultAccount` is the one-entry list, so both config
		// shapes reach ranking and ordering through the same vector.
		const configuredPriority =
			selectionPolicy === undefined
				? this.#deps.pins
						.priorityCredentialIndices(provider)
						.filter(index => credentials.some(entry => entry.index === index))
				: [];
		const priorityIndices = configuredPriority.length > 0 ? configuredPriority : hasDefault ? [defaultIndex!] : [];
		const strategy = this.#deps.strategies(provider);
		const rankingContext: CredentialRankingContext = {
			modelId: options?.modelId,
		};
		const blockScope = strategy?.blockScope?.(rankingContext);
		// Reads honour every scope that applies; the scalar above is for args that persist.
		const blockScopes = credentialBlockScopesForRequest(provider, strategy, rankingContext, blockScope);
		const planGate = strategy?.planGate?.(rankingContext);
		const hasPlanRequirement = planGate !== undefined;
		const accountIds = options?.accountIds?.length ? new Set(options.accountIds) : undefined;
		const enforceAccounts =
			accountIds !== undefined &&
			credentials.some(
				({ credential }) => credential.accountId !== undefined && accountIds.has(credential.accountId),
			);
		const hasAccountPolicy = credentials.some(
			({ credential }) => this.#deps.policies.forCredential(provider, credential) !== undefined,
		);
		const hasPriorityPolicy = credentials.some(
			({ credential }) => this.#deps.policies.forCredential(provider, credential)?.priority !== undefined,
		);
		const canFetchPolicyUsage = strategy !== undefined || this.#deps.usage.canFetchOAuthUsage(provider);
		const policyReserveEnabled = hasAccountPolicy && canFetchPolicyUsage;
		const checkUsage =
			(strategy !== undefined || policyReserveEnabled) &&
			(mode.kind === "live-usage" || credentials.length > 1 || hasPlanRequirement);
		const sessionCredential = this.#deps.affinity.get(provider, sessionId, selectionPolicy);
		const sessionPreferredIndex = sessionCredential?.type === "oauth" ? sessionCredential.index : undefined;
		const sessionPreferredCredential =
			sessionPreferredIndex !== undefined
				? credentials.find(entry => entry.index === sessionPreferredIndex)?.credential
				: undefined;
		const sessionPreferredCanRefreshOrUse =
			sessionPreferredCredential !== undefined &&
			(sessionPreferredCredential.refresh.trim().length > 0 ||
				Date.now() + OAUTH_REFRESH_SKEW_MS < sessionPreferredCredential.expires);
		// Skip ranking when the session already has a working preferred credential and its prompt
		// cache may still be warm. Providers without a verified idle boundary retain indefinite
		// stickiness rather than risk switching while their prompt cache remains warm. New sessions
		// (no preference), blocked pins, and sessions idle past the provider's sticky window still
		// rank. A configured default pin is never demoted for warmth reasons: it is a user decision.
		// Legacy pins predating `lastUsedAtMs` count as warm until the next resolve rewrites the row.
		const sessionPreferredLastUsedAtMs =
			sessionCredential?.type === "oauth" ? sessionCredential.lastUsedAtMs : undefined;
		const sessionPreferredIsWarm =
			hasDefault ||
			strategy?.stickyWarmMs === undefined ||
			sessionPreferredLastUsedAtMs === undefined ||
			Date.now() - sessionPreferredLastUsedAtMs < strategy.stickyWarmMs;
		const sessionPreferredIsAvailable =
			sessionPreferredIndex !== undefined &&
			sessionPreferredCanRefreshOrUse &&
			!this.#deps.blocks.isBlocked(provider, providerKey, sessionPreferredIndex, blockScopes);
		const sessionPinIsExplicit = sessionCredential?.type === "oauth" && sessionCredential.explicit === true;
		const shouldKeepOAuthSticky =
			selectionPolicy === undefined ||
			selectionPolicy.strategy === "sticky-session" ||
			selectionPolicy.strategy === "round-robin" ||
			selectionPolicy.strategy === "least-used";
		let order: number[];
		if (selectionPolicy?.strategy === "round-robin") {
			if (sessionPreferredIsAvailable) {
				const stickyPosition = credentials.findIndex(entry => entry.index === sessionPreferredIndex);
				order = [
					stickyPosition,
					...credentials.map((_credential, index) => index).filter(index => index !== stickyPosition),
				].filter(index => index >= 0);
			} else {
				const start = this.#getNextRoundRobinIndex(
					this.#selectionRoundRobinKey(provider, "oauth", selectionPolicy),
					credentials.length,
				);
				order = Array.from({ length: credentials.length }, (_value, index) => (start + index) % credentials.length);
			}
		} else if (selectionPolicy?.strategy === "least-used" || selectionPolicy?.strategy === "failover") {
			order = credentials.map((_credential, index) => index);
		} else if (hasDefault) {
			const baseOrder = this.#getCredentialOrder(
				this.#selectionRoundRobinKey(provider, "oauth", selectionPolicy),
				sessionId,
				credentials.length,
			);
			// Configured order first (head = pinned default), then the rest of the
			// list, then the session-hash order for unranked accounts. The session's
			// current sticky still leads so an announced fallover stays put instead
			// of flapping back to a default that is blocked for this session.
			const priorityPositions = priorityIndices.map(index => credentials.findIndex(entry => entry.index === index));
			const sessionPreferredPos = sessionPreferredIsAvailable
				? credentials.findIndex(entry => entry.index === sessionPreferredIndex)
				: -1;
			const prefix = [sessionPreferredPos, ...priorityPositions].filter(pos => pos >= 0);
			order = [...new Set([...prefix, ...baseOrder])];
		} else {
			order = this.#getCredentialOrder(
				this.#selectionRoundRobinKey(provider, "oauth", selectionPolicy),
				sessionId,
				credentials.length,
			);
		}
		// Accounts configured with an explicit routing priority lead the order
		// even when nothing is pinned, so reserve/priority policies take effect
		// on the non-ranking path too.
		const policyOrder = hasPriorityPolicy
			? [...order].sort((leftIndex, rightIndex) => {
					const leftPriority =
						this.#deps.policies.forCredential(provider, credentials[leftIndex]!.credential)?.priority ?? 0;
					const rightPriority =
						this.#deps.policies.forCredential(provider, credentials[rightIndex]!.credential)?.priority ?? 0;
					return rightPriority - leftPriority || leftIndex - rightIndex;
				})
			: order;

		// A pinned credential only suppresses ranking while it is both usable and prompt-cache warm.
		const sessionPreferredIsSticky = sessionPreferredIsAvailable && sessionPreferredIsWarm;
		const shouldRank =
			hasDefault && !hasPlanRequirement
				? false
				: checkUsage &&
					(selectionPolicy?.strategy === "least-used"
						? !sessionPreferredIsSticky || hasPlanRequirement || (policyReserveEnabled && !sessionPinIsExplicit)
						: selectionPolicy?.strategy === "round-robin" || selectionPolicy?.strategy === "failover"
							? hasPlanRequirement
							: !sessionPreferredIsSticky ||
								hasPlanRequirement ||
								(policyReserveEnabled && !sessionPinIsExplicit));
		// When ranking, seed the pinned credential first in the evaluation order so it wins genuine
		// ties (the ranked comparator falls back to `orderPos`) without overriding a strictly-better
		// sibling — this respects the residual value of a same-account shared static prefix that other
		// workspace traffic may have kept warm, while still rotating away from a clearly-worse account.
		const baseRankingOrder = credentials.map((_credential, index) => index);
		let rankingOrder =
			shouldRank && sessionId && selectionPolicy?.strategy !== "least-used" ? baseRankingOrder : policyOrder;
		const sessionPreferredRankingPos =
			shouldRank && sessionId && sessionPreferredIndex !== undefined && !hasPlanRequirement
				? credentials.findIndex(entry => entry.index === sessionPreferredIndex)
				: -1;
		if (sessionPreferredRankingPos > 0) {
			rankingOrder = [
				sessionPreferredRankingPos,
				...baseRankingOrder.filter(index => index !== sessionPreferredRankingPos),
			];
		}
		let candidates: OAuthCandidate[] = shouldRank
			? await this.#rankOAuthSelections({
					providerKey,
					provider,
					planGate,
					order: rankingOrder,
					credentials,
					options,
					strategy,
					defaultReservePct: policyReserveEnabled ? this.#deps.policies.defaultReservePct : undefined,
					rankingContext,
					blockScope,
					blockScopes,
					priorityIndices,
				})
			: policyOrder
					.map(idx => credentials[idx])
					.filter((selection): selection is NonNullable<typeof selection> => Boolean(selection))
					.map(selection => ({
						selection,
						usage: null,
						usageChecked: false,
					}));
		const preflightFailures = new Set<OAuthCandidate>();

		const sessionPreferredCandidate = candidates.findIndex(
			candidate =>
				!this.#deps.blocks.isBlocked(provider, providerKey, candidate.selection.index, blockScopes) &&
				candidate.selection.index === sessionPreferredIndex,
		);
		const preferredCandidate = sessionPreferredCandidate === -1 ? undefined : candidates[sessionPreferredCandidate];
		const reserveWouldEvictAutomaticPin = (excludePreflightFailures: boolean): boolean =>
			!sessionPinIsExplicit &&
			preferredCandidate?.inReserve === true &&
			candidates.some(
				candidate =>
					candidate !== preferredCandidate &&
					(!excludePreflightFailures || !preflightFailures.has(candidate)) &&
					candidate.reserveMeasured === true &&
					candidate.inReserve === false,
			);
		const reserveWouldEvictBeforePreflight = reserveWouldEvictAutomaticPin(false);
		// A warm automatic pin normally wins. Reserve is the one policy allowed
		// to evict it, and only while a sibling is confirmed outside reserve.
		// An explicit selection policy other than sticky/round-robin/least-used
		// owns the order, so do not hoist the sticky past it.
		if (
			shouldKeepOAuthSticky &&
			!hasPlanRequirement &&
			sessionPreferredCandidate > 0 &&
			(!shouldRank || sessionPinIsExplicit || (sessionPreferredIsWarm && !reserveWouldEvictBeforePreflight))
		) {
			const [preferred] = candidates.splice(sessionPreferredCandidate, 1);
			candidates.unshift(preferred);
		}
		// Step (b) of the auth-retry policy: when `forceRefresh` is set, re-mint
		// the session-preferred credential (or the first candidate when no
		// session preference exists yet) even if its cached token still looks
		// valid — a peer/broker may have rotated it out from under us. A target
		// mode only ever forces the row it addresses.
		const forceRefreshIndex =
			options?.forceRefresh && mode.kind === "target"
				? candidates.find(
						candidate => this.#credentialIdAt(provider, candidate.selection.index) === mode.credentialId,
					)?.selection.index
				: options?.forceRefresh
					? (sessionPreferredIndex ?? candidates[0]?.selection.index)
					: undefined;
		await Promise.all(
			candidates.map(async candidate => {
				const force = forceRefreshIndex !== undefined && candidate.selection.index === forceRefreshIndex;
				const initialCredentialId = this.#credentialIdAt(provider, candidate.selection.index);
				let syncedPeerCredential = false;
				if (initialCredentialId !== undefined) {
					const beforeSync = candidate.selection.credential;
					if (!this.#syncOAuthSelectionFromStore(provider, candidate.selection, initialCredentialId)) return;
					syncedPeerCredential = !authCredentialEquals(beforeSync, candidate.selection.credential);
				}
				const hasFreshAccess = Date.now() + OAUTH_REFRESH_SKEW_MS < candidate.selection.credential.expires;
				if ((!force || syncedPeerCredential) && hasFreshAccess) return;
				const latestCredential = this.#deps.pool.credentials(provider)[candidate.selection.index];
				if (
					!force &&
					latestCredential?.type === "oauth" &&
					Date.now() + OAUTH_REFRESH_SKEW_MS < latestCredential.expires
				) {
					candidate.selection.credential = latestCredential;
					return;
				}
				const credentialId = this.#credentialIdAt(provider, candidate.selection.index);
				try {
					// Hand the refresher a stale clone (expires:0) so its
					// not-yet-expired short-circuit doesn't suppress the forced
					// re-mint; an in-flight peer refresh is still awaited via the
					// per-credential single-flight.
					const refreshTarget = force
						? { ...candidate.selection.credential, expires: 0 }
						: candidate.selection.credential;
					const refreshedCredentials = await this.#deps.refresher.refresh(
						provider,
						refreshTarget,
						credentialId,
						options?.signal,
					);
					const updated = mergeRefreshedCredential(candidate.selection.credential, refreshedCredentials);
					candidate.selection.credential = updated;
					if (credentialId !== undefined) {
						const idx = this.#deps.pool.replaceById(provider, credentialId, updated);
						if (idx !== -1) candidate.selection.index = idx;
					} else {
						const rowId = this.#credentialIdAt(provider, candidate.selection.index);
						if (rowId !== undefined) this.#deps.pool.replaceById(provider, rowId, updated);
					}
				} catch (error) {
					// A failed preflight already exercised the provider refresh path.
					// Do not replay the same refresh token in the final candidate pass.
					const errorMsg = String(error);
					const isDefinitiveFailure = AIError.isDefinitiveOAuthFailure(errorMsg);
					logger.debug("OAuth preflight refresh failed", {
						provider,
						index: candidate.selection.index,
						error: errorMsg,
						isDefinitiveFailure,
					});
					if (isDefinitiveFailure) {
						// A dead grant discovered during preflight must be disabled here too —
						// the final candidate pass below skips every `preflightFailures` entry,
						// so if this branch only blocked the row (like the transient case), the
						// definitive failure would never reach tryOAuth's own disable logic and
						// the row would be retried forever instead of torn down.
						const outcome = await this.#deps.refresher.disableDefinitiveFailure(
							provider,
							credentialId,
							candidate.selection.credential,
							candidate.selection.index,
							errorMsg,
						);
						if (
							outcome !== "disabled" &&
							credentialId !== undefined &&
							this.#syncOAuthSelectionFromStore(provider, candidate.selection, credentialId)
						) {
							// A peer rotated this row (or won the disable CAS) between our
							// snapshot and the refresh; the helper reloaded storage and the row
							// still exists, so it now holds a valid, freshly rotated credential.
							// Re-sync the candidate onto it and leave it eligible so the final
							// pass retries with the live token instead of stranding it (mirrors
							// tryOAuth's peer-rotated re-resolve). If the peer instead
							// deleted/disabled the row, the re-sync fails and we fall through to
							// preflightFailures — leaving a stale index could rebind the candidate
							// to a sibling account with the wrong prefetched usage/plan.
							return;
						}
					} else if (credentialId !== undefined) {
						const latestIndex = this.#deps.pool.entries(provider).findIndex(entry => entry.id === credentialId);
						if (latestIndex !== -1) {
							this.#deps.blocks.mark(
								provider,
								providerKey,
								latestIndex,
								Date.now() + OAUTH_REFRESH_FAILURE_BACKOFF_MS,
								blockScope,
							);
						}
					}
					preflightFailures.add(candidate);
				}
			}),
		);

		const reserveWouldEvictAfterPreflight = reserveWouldEvictAutomaticPin(true);
		if (
			shouldKeepOAuthSticky &&
			!hasPlanRequirement &&
			preferredCandidate !== undefined &&
			!preflightFailures.has(preferredCandidate) &&
			sessionPreferredIsWarm &&
			!sessionPinIsExplicit &&
			!reserveWouldEvictAfterPreflight
		) {
			const preferredIndex = candidates.indexOf(preferredCandidate);
			if (preferredIndex > 0) {
				candidates.splice(preferredIndex, 1);
				candidates.unshift(preferredCandidate);
			}
		}

		// Enforce a tier only when at least one account is confirmed eligible. If
		// every report is unknown or ineligible, preserve trial/grandfathered access
		// by allowing the normal candidate fallback to attempt the request.
		const enforcePlanRequirement =
			hasPlanRequirement && candidates.some(candidate => planGate?.(candidate.usage) === true);
		if (mode.kind === "target") {
			candidates = candidates.filter(
				candidate => this.#credentialIdAt(provider, candidate.selection.index) === mode.credentialId,
			);
		} else if (mode.kind === "live-usage") {
			// Least-used rotation only trusts what a fresh report vouched for: a
			// row with no usage data or a spent meter must not serve this pass.
			candidates = candidates.filter(candidate => {
				const credentialId = this.#credentialIdAt(provider, candidate.selection.index);
				if (credentialId === undefined) return false;
				if (this.#deps.blocks.isBlocked(provider, providerKey, candidate.selection.index, blockScope)) return false;
				if (candidate.usage === null) return false;
				if (planGate && planGate(candidate.usage) === false) return false;
				return true;
			});
		}

		// Plan-gated models rank on every resolve to re-verify account tiers,
		// so the drain-urgency order can flip between two eligible accounts as their
		// usage headroom shifts. Promote the session-preferred credential back to the
		// front while it is unblocked and still plan-eligible (or the requirement is
		// unenforced and the pin is not known-ineligible) so an active session never
		// silently migrates accounts mid-conversation; blocked, exhausted, or
		// known-ineligible pins still fall through to the ranked sibling.
		if (hasPlanRequirement && sessionPreferredCandidate > 0 && !reserveWouldEvictAfterPreflight) {
			const preferred = candidates[sessionPreferredCandidate]!;
			const planEligibility = planGate?.(preferred.usage);
			if (planEligibility === true || (!enforcePlanRequirement && planEligibility !== false)) {
				candidates.splice(sessionPreferredCandidate, 1);
				candidates.unshift(preferred);
			}
		}

		// With an explicit selection policy there is no fallback outside the
		// pool: a blocked eligible row stays blocked rather than admitting a
		// blocked pass (or a non-eligible row) the grant forbids.
		const passes: Array<{
			allowBlocked: boolean;
			enforcePlanRequirement: boolean;
			enforceAccounts: boolean;
		}> = [{ allowBlocked: false, enforcePlanRequirement, enforceAccounts }];
		if (selectionPolicy === undefined) {
			passes.push({ allowBlocked: true, enforcePlanRequirement, enforceAccounts });
			if (enforcePlanRequirement) {
				passes.push({ allowBlocked: true, enforcePlanRequirement: false, enforceAccounts });
			}
		}
		if (enforceAccounts) passes.push({ allowBlocked: true, enforcePlanRequirement: false, enforceAccounts: false });

		for (const pass of passes) {
			for (const candidate of candidates) {
				const candidateId = this.#credentialIdAt(provider, candidate.selection.index);
				if (mode.kind === "live-usage" && candidateId !== undefined) mode.attemptedCredentialIds.add(candidateId);
				if (preflightFailures.has(candidate)) continue;
				const candidateAccountId = candidate.selection.credential.accountId;
				if (pass.enforceAccounts && (candidateAccountId === undefined || !accountIds?.has(candidateAccountId)))
					continue;
				const resolved = await this.tryOAuth(provider, candidate.selection, providerKey, sessionId, options, {
					checkUsage,
					allowBlocked: pass.allowBlocked,
					prefetchedUsage: candidate.usage,
					usagePrechecked: candidate.usageChecked,
					planGate,
					enforcePlanRequirement: pass.enforcePlanRequirement,
					strategy,
					rankingContext,
					blockScope,
					blockScopes,
					allowFallback: mode.kind === "default",
				});
				if (resolved) {
					const credentialId = resolved.credentialId ?? candidateId;
					if (credentialId !== undefined) return { ...resolved, credentialId };
				}
			}
		}
		return undefined;
	}

	/** Durable row id at a pool position, or undefined when the row is gone. */
	#credentialIdAt(provider: string, index: number): number | undefined {
		return this.#deps.pool.entries(provider)[index]?.id;
	}

	#syncOAuthSelectionFromStore(
		provider: string,
		selection: { credential: OAuthCredential; index: number },
		credentialId: number,
	): boolean {
		const latestRows = this.#deps.store.listAuthCredentials(provider);
		this.#deps.pool.replace(
			provider,
			latestRows.map(row => ({ id: row.id, credential: row.credential })),
		);
		const latestIndex = latestRows.findIndex(row => row.id === credentialId);
		if (latestIndex === -1) return false;
		const latest = latestRows[latestIndex];
		if (latest?.credential.type !== "oauth") return false;
		selection.index = latestIndex;
		selection.credential = latest.credential;
		return true;
	}

	async #prepareOAuthCredentialForRequest(
		provider: string,
		selection: { credential: OAuthCredential; index: number },
		options: AuthApiKeyOptions | undefined,
	): Promise<boolean> {
		const stored = this.#deps.pool.entries(provider);
		const selected = stored[selection.index];
		if (selected?.credential.type !== "oauth") return false;

		const prepare = this.#deps.store.prepareForRequest?.bind(this.#deps.store);
		if (prepare) {
			await prepare(selected.id, { signal: options?.signal });
		}
		return this.#syncOAuthSelectionFromStore(provider, selection, selected.id);
	}

	/** Attempts to use a single OAuth credential, checking usage and refreshing token. */
	async tryOAuth(
		provider: Provider,
		selection: OAuthSelection,
		providerKey: string,
		sessionId: string | undefined,
		options: AuthApiKeyOptions | undefined,
		usageOptions: TryOAuthOptions,
	): Promise<OAuthResolutionResult | undefined> {
		const {
			checkUsage,
			allowBlocked,
			prefetchedUsage = null,
			usagePrechecked = false,
			planGate: providedPlanGate,
			enforcePlanRequirement,
			strategy,
			rankingContext,
			blockScope,
			blockScopes,
			allowFallback = true,
		} = usageOptions;
		if (
			!allowBlocked &&
			this.#deps.blocks.isBlocked(provider, providerKey, selection.index, blockScopes ?? blockScope)
		) {
			// Default-account and sticky selection can bypass ranking. Give a
			// healable block the same usage probe before skipping this credential.
			if (!usagePrechecked && this.#deps.blocks.supportsHealing(provider)) {
				const targetId = this.#credentialIdAt(provider, selection.index);
				if (targetId === undefined) return undefined;
				await raceSignal(
					this.#deps.usage.report(provider, selection.credential, {
						...options,
						timeoutMs: this.#deps.usage.requestTimeoutMs,
					}),
					options?.signal,
					"usage fetch aborted",
				);
				if (!this.#syncOAuthSelectionFromStore(provider, selection, targetId)) return undefined;
			}
			if (this.#deps.blocks.isBlocked(provider, providerKey, selection.index, blockScopes ?? blockScope)) {
				return undefined;
			}
		}

		if (!(await this.#prepareOAuthCredentialForRequest(provider, selection, options))) {
			return undefined;
		}
		// Capture the row id once, immediately after #prepareOAuthCredentialForRequest
		// resynced selection.index from the store. A concurrent disable during the
		// usage/refresh awaits below can shift positional indices, so every later
		// refresh / persist / CAS-disable addresses the row by this stable id.
		const credentialId = this.#credentialIdAt(provider, selection.index);

		const planGate = providedPlanGate ?? this.#deps.strategies(provider)?.planGate?.({ modelId: options?.modelId });
		const hasPlanRequirement = planGate !== undefined;
		const applyPlanFilter = enforcePlanRequirement ?? hasPlanRequirement;
		let usage: UsageReport | null = null;
		let usageChecked = false;

		if ((checkUsage && !allowBlocked) || hasPlanRequirement) {
			if (usagePrechecked) {
				usage = prefetchedUsage;
				usageChecked = true;
			} else {
				usage = await this.#deps.usage.report(provider, selection.credential, {
					...options,
					timeoutMs: this.#deps.usage.requestTimeoutMs,
				});
				usageChecked = true;
			}
			if (applyPlanFilter && planGate?.(usage) !== true) {
				return undefined;
			}
			if (checkUsage && !allowBlocked && usage && strategy && rankingContext) {
				const scopedLimits = scopedUsageLimits(strategy, usage, rankingContext);
				if (isUsageLimitReached(scopedLimits)) {
					const resetAtMs = usageResetAtMs(scopedLimits, Date.now());
					this.#deps.blocks.mark(
						provider,
						providerKey,
						selection.index,
						resetAtMs ?? Date.now() + DEFAULT_BLOCK_MS,
						blockScope,
						resetAtMs !== undefined,
					);
					return undefined;
				}
			}
		}

		try {
			let result: { newCredentials: OAuthCredentials; apiKey: string } | null;
			const customProvider = getOAuthProvider(provider);
			if (customProvider) {
				const refreshedCredentials = await this.#deps.refresher.refresh(
					provider,
					selection.credential,
					credentialId,
					options?.signal,
				);
				const apiKey = customProvider.getApiKey
					? customProvider.getApiKey(refreshedCredentials)
					: refreshedCredentials.access;
				result = { newCredentials: refreshedCredentials, apiKey };
			} else {
				// Refresh first through the broker-aware single-flighted machinery
				// so transient failures surface as network errors (5-min temp block)
				// instead of `getOAuthApiKey`'s "expired" precondition error, which
				// the definitive-failure regex below would otherwise classify as
				// auth failure and soft-disable a still-valid credential.
				const refreshedCredentials = await this.#deps.refresher.refresh(
					provider,
					selection.credential,
					credentialId,
					options?.signal,
				);
				const oauthCreds: Record<string, OAuthCredentials> = {
					[provider]: refreshedCredentials,
				};
				result = await getOAuthApiKey(provider as OAuthProvider, oauthCreds);
			}
			if (!result) return undefined;
			const updated = mergeRefreshedCredential(selection.credential, result.newCredentials);
			if (credentialId !== undefined) {
				const idx = this.#deps.pool.replaceById(provider, credentialId, updated);
				if (idx !== -1) selection.index = idx;
			} else {
				const rowId = this.#credentialIdAt(provider, selection.index);
				if (rowId !== undefined) this.#deps.pool.replaceById(provider, rowId, updated);
			}
			if ((checkUsage && !allowBlocked) || hasPlanRequirement) {
				const sameAccount = selection.credential.accountId === updated.accountId;
				if (!usageChecked || !sameAccount) {
					usage = await this.#deps.usage.report(provider, updated, {
						...options,
						timeoutMs: this.#deps.usage.requestTimeoutMs,
					});
					usageChecked = true;
				}
				if (applyPlanFilter && planGate?.(usage) !== true) {
					return undefined;
				}
				if (checkUsage && !allowBlocked && usage && strategy && rankingContext) {
					const scopedLimits = scopedUsageLimits(strategy, usage, rankingContext);
					if (isUsageLimitReached(scopedLimits)) {
						const resetAtMs = usageResetAtMs(scopedLimits, Date.now());
						this.#deps.blocks.mark(
							provider,
							providerKey,
							selection.index,
							resetAtMs ?? Date.now() + DEFAULT_BLOCK_MS,
							blockScope,
							resetAtMs !== undefined,
						);
						return undefined;
					}
				}
			}
			this.#deps.pool.noteBearer(provider, result.apiKey, credentialId);
			this.#deps.affinity.record(provider, sessionId, "oauth", selection.index, {
				selection: options?.selection,
				...this.#deps.pins.classifyAccountSelection(provider, selection.index, {
					providerKey,
					selectionPolicy: options?.selection,
					blockScopes: blockScopes ?? blockScope,
				}),
			});
			if (options?.selection === undefined && credentialId !== undefined) {
				this.#deps.pins.noteDefaultAccountSelection(provider, sessionId, credentialId, blockScopes ?? blockScope);
			}
			return { apiKey: result.apiKey, credential: updated, credentialId };
		} catch (error) {
			const errorMsg = String(error);
			// Only remove credentials for definitive auth failures
			// Keep credentials for transient errors (network, 5xx) and block temporarily
			const isDefinitiveFailure = AIError.isDefinitiveOAuthFailure(errorMsg);

			logger.warn("OAuth token refresh failed", {
				provider,
				index: selection.index,
				error: errorMsg,
				isDefinitiveFailure,
			});

			if (isDefinitiveFailure) {
				const outcome = await this.#deps.refresher.disableDefinitiveFailure(
					provider,
					credentialId,
					selection.credential,
					selection.index,
					errorMsg,
				);
				if (outcome === "peer-rotated") {
					if (allowFallback) return this.resolveOAuth(provider, sessionId, options);
					return undefined;
				}
				if (outcome === "cas-lost") return undefined;
				if (this.#deps.pool.credentials(provider).some(credential => credential.type === "oauth")) {
					if (allowFallback) return this.resolveOAuth(provider, sessionId, options);
				}
			} else {
				// Block temporarily for transient failures (5 minutes)
				this.#deps.blocks.mark(
					provider,
					providerKey,
					selection.index,
					Date.now() + OAUTH_REFRESH_FAILURE_BACKOFF_MS,
				);
			}
		}

		return undefined;
	}

	/**
	 * Resolve one durable row through the selection ladder: API-key rows are
	 * read straight from the pool, OAuth rows through {@link CredentialSelector.resolveOAuthMode}
	 * in `target` mode so a sibling can never answer for them.
	 */
	async resolveExplicitSelectionCredentialId(
		provider: string,
		sessionId: string | undefined,
		credentialId: number,
		options: AuthApiKeyOptions & { selection: AuthCredentialSelectionPolicy },
		blockScope: string | undefined,
	): Promise<ResolvedAuthCredential | undefined> {
		const row = findStoredSelectionCredential(this.#deps.pool, provider, credentialId);
		if (!row) return undefined;
		if (
			this.#deps.blocks.isBlocked(provider, providerTypeKey(provider, row.credential.type), row.index, blockScope)
		) {
			return undefined;
		}
		if (row.credential.type === "api_key") {
			const apiKey = await this.#deps.overrides.resolve(row.credential.key);
			if (!apiKey) return undefined;
			this.#deps.affinity.record(provider, sessionId, "api_key", row.index, {
				selection: options.selection,
				reason: "policy",
			});
			return { apiKey, credentialId: row.id, credentialType: "api_key", source: "api_key" };
		}
		const resolved = await this.resolveOAuthMode(provider, sessionId, options, {
			kind: "target",
			credentialId: row.id,
		});
		return resolved
			? { apiKey: resolved.apiKey, credentialId: resolved.credentialId, credentialType: "oauth", source: "oauth" }
			: undefined;
	}

	/** True when the row a session sticky points at still exists, matches type, and is unblocked. */
	#selectionCredentialIsUnblocked(
		provider: string,
		row: StoredSelectionCredential,
		blockScope: string | undefined,
	): boolean {
		return !this.#deps.blocks.isBlocked(
			provider,
			providerTypeKey(provider, row.credential.type),
			row.index,
			blockScope,
		);
	}

	/** Policy-order ids walked by the strategy: sticky-first, round-robin rotation, or as given. */
	#orderedSelectionCredentialIds(
		provider: string,
		sessionId: string | undefined,
		selection: AuthCredentialSelectionPolicy,
		credentialIds: readonly number[],
		blockScope: string | undefined,
	): number[] {
		if (selection.strategy === "failover" || selection.strategy === "least-used") return [...credentialIds];
		const sticky = this.#deps.affinity.get(provider, sessionId, selection);
		if (sticky && credentialIds.includes(sticky.credentialId)) {
			const stickyRow = findStoredSelectionCredential(this.#deps.pool, provider, sticky.credentialId);
			if (
				stickyRow &&
				stickyRow.credential.type === sticky.type &&
				this.#selectionCredentialIsUnblocked(provider, stickyRow, blockScope)
			) {
				return [sticky.credentialId, ...credentialIds.filter(id => id !== sticky.credentialId)];
			}
		}

		const key = `${selection.policyKey}:${provider}:selected`;
		if (selection.strategy === "round-robin") {
			const start = this.#getNextRoundRobinIndex(key, credentialIds.length);
			return Array.from(
				{ length: credentialIds.length },
				(_value, index) => credentialIds[(start + index) % credentialIds.length]!,
			).filter((id): id is number => id !== undefined);
		}
		const order = this.#getCredentialOrder(key, sessionId, credentialIds.length);
		return order.map(index => credentialIds[index]).filter((id): id is number => id !== undefined);
	}

	/** Earliest unblock deadline across the pool, or undefined when any row is unblocked. */
	#selectionBlockedRetryAtMs(
		provider: string,
		credentialIds: readonly number[],
		blockScope: string | undefined,
	): number | undefined {
		let retryAtMs: number | undefined;
		for (const credentialId of credentialIds) {
			const row = findStoredSelectionCredential(this.#deps.pool, provider, credentialId);
			if (!row) continue;
			const blockedUntil = this.#deps.blocks.blockedUntil(
				provider,
				providerTypeKey(provider, row.credential.type),
				row.index,
				blockScope,
			);
			if (blockedUntil === undefined) return undefined;
			if (retryAtMs === undefined || blockedUntil < retryAtMs) retryAtMs = blockedUntil;
		}
		return retryAtMs;
	}

	/**
	 * Credential-resolution for an explicit {@link AuthCredentialSelectionPolicy}:
	 * walk the pool by strategy, resolving each row on its own terms, and
	 * report exhaustion (no rows vs every row blocked) instead of falling
	 * through the cascade to keys the grant does not include.
	 */
	async resolveApiKeyFromExplicitSelection(
		provider: string,
		sessionId: string | undefined,
		options: AuthApiKeyOptions & { selection: AuthCredentialSelectionPolicy },
	): Promise<AuthApiKeySelectionResult> {
		const selection = options.selection;
		const strategy = this.#deps.strategies(provider);
		const blockScope = strategy?.blockScope?.({ modelId: options.modelId });
		const attemptedCredentialIds = new Set<number>();
		const liveCredentialIds = eligibleSelectionCredentialIds(this.#deps.pool, provider, selection);
		if (liveCredentialIds.length === 0) return { ok: false, reason: "no_eligible_credential" };

		const tryCredential = async (credentialId: number): Promise<ResolvedAuthCredential | undefined> => {
			attemptedCredentialIds.add(credentialId);
			const before = findStoredSelectionCredential(this.#deps.pool, provider, credentialId);
			const resolved = await this.resolveExplicitSelectionCredentialId(
				provider,
				sessionId,
				credentialId,
				options,
				blockScope,
			);
			if (!resolved && before?.credential.type === "oauth") {
				// A refresh may have re-raced the pool (peer upsert after our
				// snapshot); admit rows that appeared during the attempt.
				for (const id of eligibleSelectionCredentialIds(this.#deps.pool, provider, selection)) {
					if (!liveCredentialIds.includes(id)) liveCredentialIds.push(id);
				}
			}
			return resolved;
		};

		if (selection.strategy === "least-used") {
			const sticky = this.#deps.affinity.get(provider, sessionId, selection);
			if (sticky && liveCredentialIds.includes(sticky.credentialId)) {
				const stickyRow = findStoredSelectionCredential(this.#deps.pool, provider, sticky.credentialId);
				if (
					stickyRow &&
					stickyRow.credential.type === sticky.type &&
					this.#selectionCredentialIsUnblocked(provider, stickyRow, blockScope)
				) {
					const resolved = await tryCredential(sticky.credentialId);
					if (resolved) return { ok: true, credential: resolved };
				}
			}
			const oauthResolved = await this.resolveOAuthMode(provider, sessionId, options, {
				kind: "live-usage",
				attemptedCredentialIds,
			});
			if (oauthResolved) {
				return {
					ok: true,
					credential: {
						apiKey: oauthResolved.apiKey,
						credentialId: oauthResolved.credentialId,
						credentialType: "oauth",
						source: "oauth",
					},
				};
			}
			for (const credentialId of liveCredentialIds) {
				if (attemptedCredentialIds.has(credentialId)) continue;
				const resolved = await tryCredential(credentialId);
				if (resolved) return { ok: true, credential: resolved };
			}
		} else {
			for (const credentialId of this.#orderedSelectionCredentialIds(
				provider,
				sessionId,
				selection,
				liveCredentialIds,
				blockScope,
			)) {
				const resolved = await tryCredential(credentialId);
				if (resolved) return { ok: true, credential: resolved };
			}
		}

		const remainingLiveIds = eligibleSelectionCredentialIds(this.#deps.pool, provider, selection);
		if (remainingLiveIds.length === 0) return { ok: false, reason: "no_eligible_credential" };
		const retryAtMs = this.#selectionBlockedRetryAtMs(provider, remainingLiveIds, blockScope);
		if (retryAtMs !== undefined) return { ok: false, reason: "all_eligible_blocked", retryAtMs };
		return { ok: false, reason: "no_eligible_credential" };
	}
}
