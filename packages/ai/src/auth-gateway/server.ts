/**
 * omp auth-gateway HTTP server.
 *
 * Accepts any provider-format request (OpenAI chat-completions, Anthropic
 * messages, OpenAI Responses) and dispatches through pi-ai's `streamSimple()`
 * — which handles credential injection, anthropic-beta headers, codex
 * websocket transport, and all the per-provider intricacies. The gateway is
 * pure protocol translation: foreign wire → omp Context → pi-ai stream() →
 * omp events → foreign wire.
 *
 * Endpoints:
 *   GET  /healthz                          → unauth; ok + version
 *   GET  /v1/usage                         → aggregated provider usage (5-min per-credential cache via AuthStorage)
 *   GET  /v1/credentials/check             → per-credential auth probe (diagnose 401s in a multi-account pool)
 *   GET  /v1/models                        → list known models from the registry
 *   POST /v1/chat/completions              → OpenAI chat-completions in/out
 *   POST /v1/messages                      → Anthropic messages in/out
 *   POST /v1/responses                     → OpenAI Responses in/out
 */

import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { type GeneratedProvider, getBundledModels, getBundledProviders } from "@oh-my-pi/pi-catalog/models";
import { extractHttpStatusFromError, extractRetryHint, logger } from "@oh-my-pi/pi-utils";
import type { ApiKeyResolver } from "../auth-retry";
import type { AuthCredentialSelectionPolicy, AuthStorage, ResolvedAuthCredential } from "../auth-storage";
import { isAuthRetryableError } from "../error/auth-classify";
import { classifyGatewayError } from "../error/gateway";
import { isUsageLimitOutcome } from "../error/rate-limit";
import * as anthropicMessages from "../providers/anthropic-messages-server";
import * as openaiChat from "../providers/openai-chat-server";
import * as openaiResponses from "../providers/openai-responses-server";
import * as piNative from "../providers/pi-native-server";
import { completeSimple, streamSimple } from "../stream";
import type {
	Api,
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Context,
	Model,
	SimpleStreamOptions,
	Usage,
} from "../types";
import { deterministicUuid } from "../utils/deterministic-id";
import { parseBind } from "../utils/parse-bind";
import {
	type AuthGatewayAuditOutcome,
	type AuthGatewayPrincipal,
	type AuthGatewayRouteFamily,
	evaluateAuthGatewayAccess,
	evaluateAuthGatewayRouteAccess,
	resolveAuthGatewayPoolSelection,
} from "./access-control";
import {
	captureRequestHeaders,
	corsHeaders,
	gatewayResponseHeaders,
	json,
	readBearerToken,
	resolvePeer,
	timingSafeEqual,
	withCors,
} from "./http";
import { handleAuthGatewayManagementRequest } from "./management";
import type {
	AuthGatewayServerHandle,
	AuthGatewayServerOptions,
	AuthGatewayFormatModule as FormatModule,
	AuthGatewayParsedRequest as ParsedFormatRequest,
} from "./types";
import { DEFAULT_AUTH_GATEWAY_BIND } from "./types";

// ParsedFormatRequest / ParsedFormatOptions / FormatModule come from ./types.

export type ModelResolver = (modelId: string) => Model<Api> | undefined;

export interface AuthGatewayBootOptions extends AuthGatewayServerOptions {
	/** Source of credentials. Caller wires this to a broker-backed AuthStorage. */
	storage: AuthStorage;
	/**
	 * Resolve a client-requested model id to a pi-ai Model. Caller supplies
	 * this from a ModelRegistry (lives in `coding-agent` to avoid an inverse
	 * dependency in `pi-ai`).
	 */
	resolveModel: ModelResolver;
	/** Optional supplier for `/v1/models` listing. Returns the full model array. */
	listModels?: () => Iterable<Model<Api>>;
	/**
	 * True when the resolved model is explicitly configured to run without
	 * provider credentials (for example a self-hosted vLLM endpoint). Managed
	 * users still need route/provider/model ACLs, but no pool credential.
	 */
	isKeylessModel?: (model: Model<Api>) => boolean;
}

// `parseBind` lives in ../utils/parse-bind so the gateway and broker can't
// drift on accepted inputs (e.g. empty hostname, IPv6 brackets).

const FORMAT_ROUTES: Record<string, { module: FormatModule; label: string }> = {
	"/v1/chat/completions": { module: openaiChat, label: "openai-chat" },
	"/v1/messages": { module: anthropicMessages, label: "anthropic-messages" },
	"/v1/responses": { module: openaiResponses, label: "openai-responses" },
};

const GATEWAY_KEYLESS_API_KEY = "N/A";
// (passthrough fast-path removed — it bypassed pi-ai provider logic, in
// particular the Anthropic Claude-Code OAuth system-prompt prefix injection.
// Every request now takes the translate path so credential-specific request
// shaping always applies.)

// Options the caller's wire format may carry but the resolved provider can't
// honour are dropped silently in `buildStreamOptions`. We used to 400 here
// (`Unsupported option: temperature for openai-codex-responses`), but every
// realistic client (llm-git, openai SDK, anthropic SDK) bakes some of these
// defaults in without knowing which model they'll resolve to. Failing loudly
// just turned that into per-call config hell. Silent strip is what the
// upstream provider would do anyway when it ignores extra fields.

/**
 * Derive a stable cache identity from the parts of the request that don't
 * change turn-to-turn within a logical conversation: model id, system prompt,
 * tool definitions, and the first message (the conversation seed). Codex-class
 * backends only cache prefixes when an explicit `prompt_cache_key` is set;
 * without one, two requests with the same prefix but different trailing
 * messages don't coalesce. This bridges Anthropic-style clients (which signal
 * caching via `cache_control` markers rather than an opaque key) to Codex's
 * keyed model so cross-protocol caching "just works".
 *
 * Including the first message scopes the key to one logical conversation:
 * two different chats with the same system prompt no longer share a cache
 * bucket and can't trample each other's prefix-tree entries.
 *
 * Anthropic-backed requests ignore `sessionId`; the key is harmless there.
 */
function deriveSessionId(modelId: string, context: Context): string {
	const parts: string[] = [modelId];
	if (context.systemPrompt && context.systemPrompt.length > 0) {
		parts.push(context.systemPrompt.join("\n\n"));
	}
	if (context.tools && context.tools.length > 0) {
		parts.push(JSON.stringify(context.tools));
	}
	const first = context.messages?.[0];
	if (first) {
		// Strip timestamp / provider metadata so the hash is stable across turns
		// of the same conversation (omp re-stamps every parsed Message). role +
		// content is what's actually on the wire.
		parts.push(JSON.stringify({ role: first.role, content: first.content }));
	}
	const seed = parts.join("\u0000");
	// The 36-char UUID flows through unchanged:
	// `normalizeOpenAIPromptCacheKey` accepts ≤64 chars verbatim.
	return deterministicUuid(seed);
}

function buildStreamOptions(parsed: ParsedFormatRequest, api: Api, signal: AbortSignal): SimpleStreamOptions {
	const opts: SimpleStreamOptions = { signal };
	const { options } = parsed;
	// Codex backend rejects every sampling control with
	// `Unsupported parameter: …` (#3117). Strip the full set for that one
	// provider; everything else is harmless to forward — `streamSimple` ignores
	// what the underlying provider doesn't honour.
	const isCodex = api === "openai-codex-responses";
	if (options.maxOutputTokens !== undefined) opts.maxTokens = options.maxOutputTokens;
	if (options.temperature !== undefined && !isCodex) opts.temperature = options.temperature;
	if (options.topP !== undefined && !isCodex) opts.topP = options.topP;
	if (options.topK !== undefined && !isCodex) opts.topK = options.topK;
	if (options.minP !== undefined && !isCodex) opts.minP = options.minP;
	if (options.stopSequences !== undefined && !isCodex) opts.stopSequences = options.stopSequences;
	if (options.presencePenalty !== undefined && !isCodex) opts.presencePenalty = options.presencePenalty;
	if (options.frequencyPenalty !== undefined && !isCodex) opts.frequencyPenalty = options.frequencyPenalty;
	if (options.repetitionPenalty !== undefined && !isCodex) opts.repetitionPenalty = options.repetitionPenalty;
	if (options.metadata !== undefined) opts.metadata = options.metadata;
	if (options.headers !== undefined) opts.headers = { ...(opts.headers ?? {}), ...options.headers };
	if (options.toolChoice !== undefined) {
		opts.toolChoice =
			typeof options.toolChoice === "object" ? { type: "tool", name: options.toolChoice.name } : options.toolChoice;
	}
	if (options.reasoning !== undefined) opts.reasoning = options.reasoning;
	if (options.disableReasoning !== undefined) opts.disableReasoning = options.disableReasoning;
	if (options.hideThinkingSummary !== undefined) opts.hideThinkingSummary = options.hideThinkingSummary;
	if (options.taskBudget !== undefined) opts.taskBudget = options.taskBudget;
	if (options.serviceTier !== undefined) opts.serviceTier = options.serviceTier;
	if (options.cacheRetention !== undefined) opts.cacheRetention = options.cacheRetention;
	// Client-supplied `prompt_cache_key` wins; otherwise derive a stable
	// key from the model + system + tools so prefix caching engages on
	// Codex-class backends across turns of the same logical conversation.
	const promptCacheKey = options.promptCacheKey ?? deriveSessionId(parsed.modelId, parsed.context);
	opts.promptCacheKey = promptCacheKey;
	opts.sessionId = promptCacheKey;
	if (options.thinkingBudgets) {
		opts.thinkingBudgets = { ...(opts.thinkingBudgets ?? {}), ...options.thinkingBudgets };
	}
	if (options.explicitThinkingBudgetTokens !== undefined) {
		// Mirror Rust's `resolve_thinking_budget`: explicit budget pins onto
		// whichever effort the client requested (or High when unspecified) and
		// ALSO sets the effort so providers that gate on `reasoning` actually
		// surface the budget.
		const effort = options.reasoning ?? Effort.High;
		opts.thinkingBudgets = {
			...(opts.thinkingBudgets ?? {}),
			[effort]: options.explicitThinkingBudgetTokens,
		};
		opts.reasoning ??= effort;
	}
	// Fields that don't yet have a matching pi-ai `SimpleStreamOptions` slot.
	// Surfaced once in debug logs so they show up when wiring a new provider,
	// but NEVER widened into `options.extra` — every consumer would have to
	// re-implement the typed parse to read them back out.
	// TODO(pi-ai): land first-class fields and replace these blocks.
	if (
		options.parallelToolCalls !== undefined ||
		options.previousResponseId !== undefined ||
		options.seed !== undefined ||
		options.logitBias !== undefined ||
		options.user !== undefined ||
		options.responseFormat !== undefined
	) {
		logger.debug("auth-gateway dropped unsupported typed options", {
			api,
			parallelToolCalls: options.parallelToolCalls,
			previousResponseId: options.previousResponseId,
			seed: options.seed,
			hasLogitBias: options.logitBias !== undefined,
			user: options.user,
			hasResponseFormat: options.responseFormat !== undefined,
		});
	}
	return opts;
}

/**
 * Hook fired by {@link streamSimple} when the upstream request fails in a
 * way that's rotatable — today that's HTTP 401 (credential is bad) and
 * usage-limit phrasing matched by {@link isUsageLimitError} (Codex's
 * `usage_limit_reached`, Anthropic's `usage_limit_reached`, Google's
 * `resource_exhausted`, …). The two cases need different storage actions:
 *
 * - **usage-limit** → {@link AuthStorage.markUsageLimitReached}. Marks just
 *   the current session's credential as temporarily blocked (honouring
 *   `retry-after` / `resets_at` hints when present) and returns `true` only
 *   when a sibling credential is still available. Burning the credential
 *   with `invalidateCredentialMatching` here would orphan accounts whose
 *   reset window is several hours away — exactly the bug this helper exists
 *   to avoid.
 * - **auth-failure** → {@link AuthStorage.invalidateCredentialMatching}.
 *   Suspect/delete the row so it doesn't get re-picked next request.
 *
 * In both branches we return the next `getApiKey` result (sticky on the
 * same `sessionId`) so streamSimple can transparently retry the pre-emit
 * failure with a fresh credential. Returning `undefined` aborts the retry
 * and surfaces the original error to the caller.
 */
interface GatewayCredentialResolution {
	apiKey: string;
	credential: ResolvedAuthCredential;
}

interface PoolExhaustionState {
	reason?: "no_eligible_credential" | "all_eligible_blocked";
	retryAtMs?: number;
}

interface PoolExhaustionFailure {
	status: 429 | 503;
	type: "rate_limit_error" | "no_eligible_credential";
	outcome: "usage_limit" | "no_eligible_credential";
	retryAtMs?: number;
}

function describePoolExhaustion(exhaustion: PoolExhaustionState): PoolExhaustionFailure | undefined {
	if (exhaustion.reason === "all_eligible_blocked") {
		return {
			status: 429,
			type: "rate_limit_error",
			outcome: "usage_limit",
			retryAtMs: exhaustion.retryAtMs,
		};
	}
	if (exhaustion.reason === "no_eligible_credential") {
		return { status: 503, type: "no_eligible_credential", outcome: "no_eligible_credential" };
	}
	return undefined;
}

function isTerminalCredentialError(error: unknown): boolean {
	if (isAuthRetryableError(error) || classifyGatewayError(error).type === "authentication_error") return true;
	const message = error instanceof Error ? error.message : typeof error === "string" ? error : undefined;
	return message !== undefined && /(?:^|\b)(?:401|403)\b|\binvalid[-_ ]?api[-_ ]?key\b/i.test(message);
}

async function refreshGatewayApiKeyAfterAuthError(
	storage: AuthStorage,
	model: Model<Api>,
	sessionId: string,
	provider: string,
	oldKey: string,
	error: unknown,
	signal: AbortSignal,
	format: string,
	peer: string,
	selection: AuthCredentialSelectionPolicy | undefined,
	exhaustion: PoolExhaustionState,
	onCredential: (credential: ResolvedAuthCredential) => void,
): Promise<string | undefined> {
	const message = error instanceof Error ? error.message : String(error);
	if (isUsageLimitOutcome(extractHttpStatusFromError(error), message)) {
		const retryAfterMs = extractRetryHint(undefined, message);
		const { switched, retryAtMs } = await storage.markUsageLimitReached(provider, sessionId, {
			retryAfterMs,
			baseUrl: model.baseUrl,
			modelId: model.id,
			apiKey: oldKey,
			signal,
			selection,
		});
		logger.debug("auth-gateway retrying provider request after usage-limit block", {
			format,
			provider,
			peer,
			switched,
			retryAfterMs,
			retryAtMs,
			error: message,
		});
		if (!selection && !switched) return undefined;
		const retryExhaustion = selection ? exhaustion : {};
		const next = await resolveGatewayCredential(storage, model, sessionId, signal, selection, retryExhaustion);
		if (!next) {
			if (selection && exhaustion.reason === undefined) {
				exhaustion.reason = "all_eligible_blocked";
				exhaustion.retryAtMs = retryAtMs;
			} else if (selection && exhaustion.retryAtMs === undefined) {
				exhaustion.retryAtMs = retryAtMs;
			}
			return undefined;
		}
		onCredential(next.credential);
		return next.apiKey;
	}
	await storage.invalidateCredentialMatching(provider, oldKey, { sessionId, signal, selection });
	logger.debug("auth-gateway retrying provider request after credential invalidation", {
		format,
		provider,
		peer,
		error: message,
	});
	const next = await resolveGatewayCredential(
		storage,
		model,
		sessionId,
		signal,
		selection,
		selection ? exhaustion : {},
	);
	if (!next) {
		if (selection && exhaustion.reason === "all_eligible_blocked") {
			exhaustion.reason = "no_eligible_credential";
			exhaustion.retryAtMs = undefined;
		}
		return undefined;
	}
	onCredential(next.credential);
	return next.apiKey;
}

function buildGatewayApiKeyResolver(
	storage: AuthStorage,
	model: Model<Api>,
	sessionId: string,
	initial: GatewayCredentialResolution,
	requestSignal: AbortSignal,
	format: string,
	peer: string,
	selection: AuthCredentialSelectionPolicy | undefined,
	exhaustion: PoolExhaustionState,
	onCredential: (credential: ResolvedAuthCredential) => void,
): ApiKeyResolver {
	let lastKey = initial.apiKey;
	onCredential(initial.credential);
	return async ({ lastChance, error, signal }) => {
		const sig = signal ?? requestSignal;
		if (error === undefined) {
			lastKey = initial.apiKey;
			onCredential(initial.credential);
			return initial.apiKey;
		}
		if (!lastChance) {
			const refreshed = await storage.resolveApiKeySelection(model.provider, sessionId, {
				modelId: model.id,
				signal: sig,
				forceRefresh: true,
				selection,
			});
			if (!refreshed.ok) {
				if (selection) {
					exhaustion.reason =
						refreshed.reason === "all_eligible_blocked" ? "all_eligible_blocked" : "no_eligible_credential";
					exhaustion.retryAtMs = refreshed.retryAtMs;
				}
				return undefined;
			}
			lastKey = refreshed.credential.apiKey;
			onCredential(refreshed.credential);
			return refreshed.credential.apiKey;
		}
		const next = await refreshGatewayApiKeyAfterAuthError(
			storage,
			model,
			sessionId,
			model.provider,
			lastKey,
			error,
			sig,
			format,
			peer,
			selection,
			exhaustion,
			onCredential,
		);
		lastKey = next ?? lastKey;
		return next;
	};
}

interface TerminalCredentialErrorRecoveryOptions {
	storage: AuthStorage;
	model: Model<Api>;
	sessionId: string;
	getApiKey: () => string;
	signal: AbortSignal;
	format: string;
	peer: string;
	selection: AuthCredentialSelectionPolicy | undefined;
	exhaustion: PoolExhaustionState;
	onCredential: (credential: ResolvedAuthCredential) => void;
}

function buildTerminalCredentialErrorRecovery(
	options: TerminalCredentialErrorRecoveryOptions,
): (error: unknown) => Promise<PoolExhaustionFailure | undefined> {
	return async error => {
		if (!isTerminalCredentialError(error)) return undefined;
		await refreshGatewayApiKeyAfterAuthError(
			options.storage,
			options.model,
			options.sessionId,
			options.model.provider,
			options.getApiKey(),
			error,
			options.signal,
			options.format,
			options.peer,
			options.selection,
			options.exhaustion,
			options.onCredential,
		);
		return describePoolExhaustion(options.exhaustion);
	};
}

function qualifiedModelId(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function resolveGatewayModel(opts: AuthGatewayBootOptions, id: string): Model<Api> | undefined {
	const direct = opts.resolveModel(id);
	if (direct) return direct;
	const slash = id.indexOf("/");
	if (slash <= 0 || slash === id.length - 1) return undefined;
	return opts.resolveModel(id.slice(slash + 1));
}

function isManagedRegular(
	principal: AuthGatewayPrincipal,
): principal is AuthGatewayPrincipal & { kind: "managed"; id: number; userId: number } {
	return principal.kind === "managed" && principal.role !== "admin" && principal.userId !== null;
}

function gatewayPermissionDenied(route: { module: FormatModule }): Response {
	return route.module.formatError(403, "permission_error", "Access denied by gateway policy");
}

function poolFailureResponse(
	route: { module: FormatModule },
	status: number,
	type: string,
	message: string,
	retryAtMs?: number,
): Response {
	const response = route.module.formatError(status, type, message);
	if (retryAtMs !== undefined)
		response.headers.set("Retry-After", String(Math.max(1, Math.ceil((retryAtMs - Date.now()) / 1000))));
	return response;
}

function credentialIdsForProvider(storage: AuthStorage, provider: string): Set<number> {
	return new Set(storage.listStoredCredentials(provider).map(row => row.id));
}

const BUNDLED_MODEL_PROVIDERS = new Set<string>(getBundledProviders());

function gatewayPoolScope(poolId: number, provider: string): string {
	return `gateway-pool:${poolId}:${provider}`;
}

function bundledCatalogModelsForProvider(provider: string): readonly Model<Api>[] {
	if (!BUNDLED_MODEL_PROVIDERS.has(provider)) return [];
	return getBundledModels(provider as GeneratedProvider);
}

async function resolveGatewayCredential(
	storage: AuthStorage,
	model: Model<Api>,
	sessionId: string,
	signal: AbortSignal,
	selection: AuthCredentialSelectionPolicy | undefined,
	exhaustion: PoolExhaustionState,
): Promise<GatewayCredentialResolution | undefined> {
	const result = await storage.resolveApiKeySelection(model.provider, sessionId, {
		modelId: model.id,
		signal,
		selection,
	});
	if (!result.ok) {
		if (selection) {
			exhaustion.reason =
				result.reason === "all_eligible_blocked" ? "all_eligible_blocked" : "no_eligible_credential";
			exhaustion.retryAtMs = result.retryAtMs;
		}
		return undefined;
	}
	return { apiKey: result.credential.apiKey, credential: result.credential };
}

function mapInitialCredentialFailure(
	route: { module: FormatModule },
	model: Model<Api>,
	selection: AuthCredentialSelectionPolicy | undefined,
	exhaustion: PoolExhaustionState,
): Response {
	const poolFailure = selection ? describePoolExhaustion(exhaustion) : undefined;
	if (poolFailure) {
		return poolFailureResponse(
			route,
			poolFailure.status,
			poolFailure.type,
			"No eligible credential is available for this request",
			poolFailure.retryAtMs,
		);
	}
	if (selection) {
		return poolFailureResponse(
			route,
			503,
			"no_eligible_credential",
			"No eligible credential is available for this request",
		);
	}
	return route.module.formatError(
		401,
		"authentication_error",
		`No credential available for provider ${model.provider}`,
	);
}

function usageOf(message: AssistantMessage): Usage {
	return message.usage;
}

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function streamPoolFailureMessage(model: Model<Api>, errorMessage: string): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage(),
		stopReason: "error",
		errorMessage,
		timestamp: Date.now(),
		duration: 0,
	};
}

interface AuditRecorder {
	setPrincipal(principal: AuthGatewayPrincipal): void;
	setModel(requestedModel: string | null, provider: string | null, model: string | null): void;
	setCredential(credentialId: number | null): void;
	record(outcome: AuthGatewayAuditOutcome, statusCode: number, usage?: Usage, errorCode?: string | null): void;
}

function createAuditRecorder(
	opts: AuthGatewayBootOptions,
	req: Request,
	pathname: string,
	routeFamily: AuthGatewayRouteFamily,
): AuditRecorder | undefined {
	const store = opts.accessStore;
	if (!store) return undefined;
	const requestId = crypto.randomUUID();
	const startedAt = Date.now();
	let principal: AuthGatewayPrincipal | undefined;
	let requestedModel: string | null = null;
	let resolvedProvider: string | null = null;
	let resolvedModel: string | null = null;
	let credentialId: number | null = null;
	let recorded = false;
	return {
		setPrincipal(next) {
			principal = next;
		},
		setModel(nextRequestedModel, provider, model) {
			requestedModel = nextRequestedModel;
			resolvedProvider = provider;
			resolvedModel = model;
		},
		setCredential(nextCredentialId) {
			credentialId = nextCredentialId;
		},
		record(outcome, statusCode, usage = zeroUsage(), errorCode = null) {
			if (recorded) return;
			recorded = true;
			try {
				store.recordAudit({
					requestId,
					startedAt,
					completedAt: Date.now(),
					userId: principal?.userId ?? null,
					userName: principal?.name ?? null,
					tokenId: principal?.tokenId ?? null,
					method: req.method,
					path: pathname,
					routeFamily,
					requestedModel,
					resolvedProvider,
					resolvedModel,
					credentialId,
					outcome,
					statusCode,
					inputTokens: usage.input,
					outputTokens: usage.output,
					cacheReadTokens: usage.cacheRead,
					cacheWriteTokens: usage.cacheWrite,
					totalTokens: usage.totalTokens,
					costUsd: usage.cost.total,
					errorCode,
				});
			} catch (error) {
				logger.debug("auth-gateway audit write failed", { error: String(error) });
			}
		},
	};
}

function auditOutcomeForStatus(status: number): AuthGatewayAuditOutcome {
	if (status >= 200 && status < 400) return "success";
	if (status === 401) return "unauthorized";
	if (status === 403) return "denied_by_acl";
	if (status === 404) return "not_found";
	if (status === 429) return "usage_limit";
	if (status >= 400 && status < 500) return "invalid_request";
	return "internal_error";
}

function wrapEventsForAudit(
	events: AssistantMessageEventStream,
	audit: AuditRecorder | undefined,
	statusCode: number,
	exhaustion: PoolExhaustionState,
	model: Model<Api>,
	signal?: AbortSignal,
	onTerminalCredentialError?: (error: unknown) => Promise<PoolExhaustionFailure | undefined>,
): AssistantMessageEventStream {
	if (!audit && !onTerminalCredentialError) return events;
	const recorder = audit;
	async function* iter() {
		try {
			for await (const event of events) {
				if (event.type === "done") recorder?.record("success", statusCode, usageOf(event.message));
				if (event.type === "error") {
					let poolFailure = describePoolExhaustion(exhaustion);
					const terminalError = event.error.errorMessage ?? "Upstream request failed";
					if (!poolFailure && isTerminalCredentialError(terminalError)) {
						poolFailure = await onTerminalCredentialError?.(terminalError);
					}
					if (poolFailure) {
						const error = {
							...event.error,
							errorMessage: "No eligible credential is available for this request",
							stopReason: "error" as const,
						};
						recorder?.record(poolFailure.outcome, poolFailure.status, usageOf(event.error), poolFailure.type);
						yield { ...event, error } satisfies AssistantMessageEvent;
						continue;
					}
					recorder?.record(
						event.reason === "aborted" ? "request_aborted" : "upstream_error",
						event.reason === "aborted" ? 499 : 502,
						usageOf(event.error),
						event.reason,
					);
				}
				yield event;
			}
		} catch (error) {
			const aborted = signal?.aborted ?? false;
			let poolFailure = aborted ? undefined : describePoolExhaustion(exhaustion);
			if (!poolFailure && !aborted) {
				poolFailure = await onTerminalCredentialError?.(error);
			}
			if (poolFailure) {
				const message = streamPoolFailureMessage(model, "No eligible credential is available for this request");
				recorder?.record(poolFailure.outcome, poolFailure.status, zeroUsage(), poolFailure.type);
				yield { type: "error", reason: "error", error: message } satisfies AssistantMessageEvent;
				return;
			}
			recorder?.record(
				aborted ? "request_aborted" : "upstream_error",
				aborted ? 499 : 502,
				zeroUsage(),
				aborted ? (error instanceof Error ? error.name : "stream_error") : "stream_error",
			);
			throw error;
		}
	}
	const wrapped = iter() as unknown as AssistantMessageEventStream;
	wrapped.result = async () => {
		const message = await events.result();
		if (message.stopReason === "stop" || message.stopReason === "length" || message.stopReason === "toolUse") {
			recorder?.record("success", statusCode, usageOf(message));
		} else {
			recorder?.record(
				message.stopReason === "aborted" ? "request_aborted" : "upstream_error",
				message.stopReason === "aborted" ? 499 : 502,
				usageOf(message),
				message.stopReason,
			);
		}
		return message;
	};
	return wrapped;
}

function clientClosedResponse(route: { module: FormatModule }): Response {
	return route.module.formatError(499, "request_aborted", "client closed request");
}

function mirrorRequestAbort(req: Request): AbortController {
	const controller = new AbortController();
	if (req.signal.aborted) {
		controller.abort(req.signal.reason);
	} else {
		req.signal.addEventListener("abort", () => controller.abort(req.signal.reason), { once: true });
	}
	return controller;
}

// (handlePassthrough removed — see note above.)

async function handleFormatEndpoint(
	route: { module: FormatModule; label: string },
	bootOpts: AuthGatewayBootOptions,
	req: Request,
	peer: string,
	principal: AuthGatewayPrincipal,
	audit: AuditRecorder | undefined,
	routeFamily: "chat" | "messages" | "responses",
): Promise<Response> {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();
	const controller = mirrorRequestAbort(req);
	if (controller.signal.aborted) return clientClosedResponse(route);

	let body: unknown;
	try {
		body = await req.json();
	} catch (error) {
		if (controller.signal.aborted) return clientClosedResponse(route);
		audit?.record("invalid_request", 400, zeroUsage(), "invalid_json");
		return route.module.formatError(400, "invalid_request_error", `Invalid JSON body: ${String(error)}`);
	}
	if (controller.signal.aborted) return clientClosedResponse(route);

	const modelValue = body && typeof body === "object" && "model" in body ? body.model : undefined;
	const modelId = typeof modelValue === "string" ? modelValue : undefined;
	if (!modelId) {
		audit?.record("invalid_request", 400, zeroUsage(), "missing_model");
		return route.module.formatError(400, "invalid_request_error", "Missing top-level `model` field");
	}

	const model = resolveGatewayModel(bootOpts, modelId);
	if (!model) {
		if (isManagedRegular(principal)) {
			audit?.record("denied_by_acl", 403, zeroUsage(), "denied_by_acl");
			return gatewayPermissionDenied(route);
		}
		audit?.record("unknown_model", 404, zeroUsage(), "unknown_model");
		return route.module.formatError(404, "invalid_request_error", `Unknown model: ${modelId}`);
	}
	audit?.setModel(modelId, model.provider, model.id);

	let parsed: ParsedFormatRequest;
	try {
		parsed = route.module.parseRequest(body, req.headers);
	} catch (error) {
		if (controller.signal.aborted) return clientClosedResponse(route);
		const message = error instanceof Error ? error.message : String(error);
		audit?.record("invalid_request", 400, zeroUsage(), "invalid_request");
		return route.module.formatError(400, "invalid_request_error", message);
	}
	const captured = captureRequestHeaders(req.headers);
	parsed.options.headers = { ...captured, ...(parsed.options.headers ?? {}) };
	if (controller.signal.aborted) return clientClosedResponse(route);

	const keylessModel = bootOpts.isKeylessModel?.(model) ?? false;

	let selection: AuthCredentialSelectionPolicy | undefined;
	let credentialSessionScope = "default";
	if (isManagedRegular(principal) && bootOpts.accessStore) {
		const rules = bootOpts.accessStore.listAclRules(principal.userId);
		const access = evaluateAuthGatewayAccess(principal, rules, {
			route: routeFamily,
			provider: model.provider,
			qualifiedModel: qualifiedModelId(model),
		});
		if (!access.allowed) {
			audit?.record("denied_by_acl", 403, zeroUsage(), "denied_by_acl");
			return gatewayPermissionDenied(route);
		}
		if (!keylessModel) {
			const poolBindings = bootOpts.accessStore.listUserPoolBindings(principal.userId);
			if (poolBindings.length === 0) {
				audit?.record("denied_by_acl", 403, zeroUsage(), "denied_by_acl");
				return gatewayPermissionDenied(route);
			}
			const liveIds = credentialIdsForProvider(bootOpts.storage, model.provider);
			const poolSelection = resolveAuthGatewayPoolSelection(poolBindings, liveIds);
			if (!poolSelection) {
				audit?.record("no_eligible_credential", 503, zeroUsage(), "no_eligible_credential");
				return poolFailureResponse(
					route,
					503,
					"no_eligible_credential",
					"No eligible credential is available for this request",
				);
			}
			credentialSessionScope = gatewayPoolScope(poolSelection.poolId, model.provider);
			selection = {
				policyKey: credentialSessionScope,
				eligibleCredentialIds: poolSelection.credentialIds,
				strategy: poolSelection.strategy,
			};
		}
	}

	const requestSessionId = parsed.options.promptCacheKey ?? deriveSessionId(parsed.modelId, parsed.context);
	const storageSessionId = isManagedRegular(principal)
		? `gateway:${principal.id}:${credentialSessionScope}:${requestSessionId}`
		: requestSessionId;
	parsed.options.promptCacheKey ??= requestSessionId;

	const exhaustion: PoolExhaustionState = {};
	let streamApiKey: SimpleStreamOptions["apiKey"] = GATEWAY_KEYLESS_API_KEY;
	let recoverTerminalCredentialError: ((error: unknown) => Promise<PoolExhaustionFailure | undefined>) | undefined;
	if (!keylessModel) {
		let credential: GatewayCredentialResolution | undefined;
		try {
			credential = await resolveGatewayCredential(
				bootOpts.storage,
				model,
				storageSessionId,
				controller.signal,
				selection,
				exhaustion,
			);
		} catch (error) {
			if (controller.signal.aborted) return clientClosedResponse(route);
			const classified = classifyGatewayError(error);
			logger.warn("auth-gateway getApiKey threw", { provider: model.provider, peer, error: classified.message });
			audit?.record(
				classified.status >= 500 ? "internal_error" : "invalid_request",
				classified.status,
				zeroUsage(),
				classified.type,
			);
			return route.module.formatError(classified.status, classified.type, classified.message);
		}
		if (controller.signal.aborted) return clientClosedResponse(route);
		if (!credential) {
			const response = mapInitialCredentialFailure(route, model, selection, exhaustion);
			const poolFailure = describePoolExhaustion(exhaustion);
			audit?.record(
				poolFailure?.outcome ??
					(response.status === 429
						? "usage_limit"
						: response.status === 503
							? "no_eligible_credential"
							: "unauthorized"),
				response.status,
				zeroUsage(),
				poolFailure?.type ?? "no_credential",
			);
			return response;
		}
		let currentApiKey = credential.apiKey;
		const onCredential = (next: ResolvedAuthCredential): void => {
			currentApiKey = next.apiKey;
			audit?.setCredential(next.credentialId ?? null);
		};
		streamApiKey = buildGatewayApiKeyResolver(
			bootOpts.storage,
			model,
			storageSessionId,
			credential,
			controller.signal,
			route.label,
			peer,
			selection,
			exhaustion,
			onCredential,
		);
		recoverTerminalCredentialError = buildTerminalCredentialErrorRecovery({
			storage: bootOpts.storage,
			model,
			sessionId: storageSessionId,
			getApiKey: () => currentApiKey,
			signal: controller.signal,
			format: route.label,
			peer,
			selection,
			exhaustion,
			onCredential,
		});
	}

	const streamOpts = buildStreamOptions(parsed, model.api, controller.signal);
	streamOpts.apiKey = streamApiKey;

	logger.info("auth-gateway request", {
		requestId,
		format: route.label,
		model: parsed.modelId,
		resolvedProvider: model.provider,
		resolvedModel: model.id,
		stream: parsed.stream,
		peer,
	});

	if (!parsed.stream) {
		try {
			if (controller.signal.aborted) return clientClosedResponse(route);
			const message = await completeSimple(model, parsed.context, streamOpts);
			if (message.stopReason === "aborted" || message.stopReason === "error") {
				const poolFailure = describePoolExhaustion(exhaustion);
				const errorMessage = poolFailure
					? "No eligible credential is available for this request"
					: (message.errorMessage ??
						(message.stopReason === "aborted" ? "Request was aborted" : "Upstream request failed"));
				logger.warn("auth-gateway non-streaming failed", {
					format: route.label,
					reason: message.stopReason,
					error: errorMessage,
					peer,
				});
				if (message.stopReason === "aborted") {
					audit?.record("request_aborted", 499, usageOf(message), "request_aborted");
					return route.module.formatError(499, "request_aborted", errorMessage);
				}
				const terminalPoolFailure = recoverTerminalCredentialError
					? await recoverTerminalCredentialError(errorMessage)
					: undefined;
				if (terminalPoolFailure) {
					audit?.record(
						terminalPoolFailure.outcome,
						terminalPoolFailure.status,
						usageOf(message),
						terminalPoolFailure.type,
					);
					return poolFailureResponse(
						route,
						terminalPoolFailure.status,
						terminalPoolFailure.type,
						"No eligible credential is available for this request",
						terminalPoolFailure.retryAtMs,
					);
				}
				if (poolFailure) {
					audit?.record(poolFailure.outcome, poolFailure.status, usageOf(message), poolFailure.type);
					return poolFailureResponse(
						route,
						poolFailure.status,
						poolFailure.type,
						errorMessage,
						poolFailure.retryAtMs,
					);
				}
				const classified = classifyGatewayError(errorMessage);
				audit?.record("upstream_error", classified.status, usageOf(message), classified.type);
				return route.module.formatError(classified.status, classified.type, errorMessage);
			}
			audit?.record("success", 200, usageOf(message));
			return json(
				200,
				route.module.encodeResponse(message, parsed.modelId),
				gatewayResponseHeaders(model, { requestId, message, startedAt }),
			);
		} catch (error) {
			if (controller.signal.aborted) return clientClosedResponse(route);
			const classified = classifyGatewayError(error);
			logger.warn("auth-gateway non-streaming aborted", {
				format: route.label,
				error: classified.message,
				peer,
			});
			const poolFailure = describePoolExhaustion(exhaustion);
			if (poolFailure) {
				audit?.record(poolFailure.outcome, poolFailure.status, zeroUsage(), poolFailure.type);
				return poolFailureResponse(
					route,
					poolFailure.status,
					poolFailure.type,
					"No eligible credential is available for this request",
					poolFailure.retryAtMs,
				);
			}
			const terminalPoolFailure = recoverTerminalCredentialError
				? await recoverTerminalCredentialError(error)
				: undefined;
			if (terminalPoolFailure) {
				audit?.record(
					terminalPoolFailure.outcome,
					terminalPoolFailure.status,
					zeroUsage(),
					terminalPoolFailure.type,
				);
				return poolFailureResponse(
					route,
					terminalPoolFailure.status,
					terminalPoolFailure.type,
					"No eligible credential is available for this request",
					terminalPoolFailure.retryAtMs,
				);
			}
			audit?.record("upstream_error", classified.status, zeroUsage(), classified.type);
			return route.module.formatError(classified.status, classified.type, classified.message);
		}
	}

	let events: AssistantMessageEventStream;
	try {
		if (controller.signal.aborted) return clientClosedResponse(route);
		events = streamSimple(model, parsed.context, streamOpts);
	} catch (error) {
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway streamSimple threw", { format: route.label, error: classified.message, peer });
		const poolFailure = describePoolExhaustion(exhaustion);
		if (poolFailure) {
			audit?.record(poolFailure.outcome, poolFailure.status, zeroUsage(), poolFailure.type);
			return poolFailureResponse(
				route,
				poolFailure.status,
				poolFailure.type,
				"No eligible credential is available for this request",
				poolFailure.retryAtMs,
			);
		}
		const terminalPoolFailure = recoverTerminalCredentialError
			? await recoverTerminalCredentialError(error)
			: undefined;
		if (terminalPoolFailure) {
			audit?.record(terminalPoolFailure.outcome, terminalPoolFailure.status, zeroUsage(), terminalPoolFailure.type);
			return poolFailureResponse(
				route,
				terminalPoolFailure.status,
				terminalPoolFailure.type,
				"No eligible credential is available for this request",
				terminalPoolFailure.retryAtMs,
			);
		}
		audit?.record("upstream_error", classified.status, zeroUsage(), classified.type);
		return route.module.formatError(classified.status, classified.type, classified.message);
	}
	if (controller.signal.aborted) return clientClosedResponse(route);
	const auditedEvents = wrapEventsForAudit(
		events,
		audit,
		200,
		exhaustion,
		model,
		controller.signal,
		recoverTerminalCredentialError,
	);
	const sseStream = route.module.encodeStream(auditedEvents, parsed.modelId, parsed.options, {
		signal: controller.signal,
		onCancel: reason => {
			audit?.record("request_aborted", 499, zeroUsage(), "request_aborted");
			if (!controller.signal.aborted) {
				controller.abort(reason instanceof Error ? reason : new Error("client closed request"));
			}
		},
	});
	return new Response(sseStream, {
		status: 200,
		headers: {
			...gatewayResponseHeaders(model, { requestId }),
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
}

/**
 * Pi-native fast path: `POST /v1/pi/stream`. Accepts the canonical pi-ai
 * `Context` directly (no wire-format round-trip) and emits a bandwidth-shrunk
 * event stream matching `pi-agent`'s `streamProxy`. Skips the OpenAI /
 * Anthropic / Responses translation layers — those exist to bridge foreign
 * SDKs (llm-git, anthropic-sdk, openai-sdk), and bridging back to pi-native
 * just to bridge forward again is wasted work.
 *
 * Every other gateway concern (bearer auth, model resolve, credential fetch,
 * abort mirroring, codex temperature/topP strip, prefix-cache key derivation,
 * Claude-Code OAuth shaping inside `streamSimple`) still applies — only
 * `parseRequest`/`encodeResponse`/`encodeStream` differ from the format-endpoint
 * path.
 */
async function handlePiNative(
	bootOpts: AuthGatewayBootOptions,
	req: Request,
	peer: string,
	principal: AuthGatewayPrincipal,
	audit: AuditRecorder | undefined,
): Promise<Response> {
	const startedAt = performance.now();
	const requestId = crypto.randomUUID();
	const controller = mirrorRequestAbort(req);
	const aborted = (): Response => {
		audit?.record("request_aborted", 499, zeroUsage(), "request_aborted");
		return piNative.formatError(499, "request_aborted", "client closed request");
	};
	if (controller.signal.aborted) return aborted();

	let body: unknown;
	try {
		body = await req.json();
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		audit?.record("invalid_request", 400, zeroUsage(), "invalid_json");
		return piNative.formatError(400, "invalid_request_error", `Invalid JSON body: ${String(error)}`);
	}
	if (controller.signal.aborted) return aborted();

	let parsed: piNative.PiNativeParsedRequest;
	try {
		parsed = piNative.parseRequest(body, req.headers);
	} catch (error) {
		if (controller.signal.aborted) return aborted();
		audit?.record("invalid_request", 400, zeroUsage(), "invalid_request");
		const message = error instanceof Error ? error.message : String(error);
		return piNative.formatError(400, "invalid_request_error", message);
	}

	const route = { module: piNative as unknown as FormatModule, label: "pi-native" };
	const model = resolveGatewayModel(bootOpts, parsed.modelId);
	if (!model) {
		if (isManagedRegular(principal) && bootOpts.accessStore) {
			audit?.record("denied_by_acl", 403, zeroUsage(), "denied_by_acl");
			return gatewayPermissionDenied(route);
		}
		audit?.record("unknown_model", 404, zeroUsage(), "unknown_model");
		return piNative.formatError(404, "invalid_request_error", `Unknown model: ${parsed.modelId}`);
	}
	audit?.setModel(parsed.modelId, model.provider, model.id);
	const keylessModel = bootOpts.isKeylessModel?.(model) ?? false;
	const requestSessionId = parsed.options.sessionId ?? deriveSessionId(parsed.modelId, parsed.context);
	parsed.options.sessionId ??= requestSessionId;

	let selection: AuthCredentialSelectionPolicy | undefined;
	let credentialSessionScope = "default";
	const exhaustion: PoolExhaustionState = {};
	if (isManagedRegular(principal) && bootOpts.accessStore) {
		const rules = bootOpts.accessStore.listAclRules(principal.userId);
		const access = evaluateAuthGatewayAccess(principal, rules, {
			route: "pi-native",
			provider: model.provider,
			qualifiedModel: qualifiedModelId(model),
		});
		if (!access.allowed) {
			audit?.record("denied_by_acl", 403, zeroUsage(), "denied_by_acl");
			return gatewayPermissionDenied(route);
		}
		if (!keylessModel) {
			const poolBindings = bootOpts.accessStore.listUserPoolBindings(principal.userId);
			if (poolBindings.length === 0) {
				audit?.record("denied_by_acl", 403, zeroUsage(), "denied_by_acl");
				return gatewayPermissionDenied(route);
			}
			const liveIds = credentialIdsForProvider(bootOpts.storage, model.provider);
			const poolSelection = resolveAuthGatewayPoolSelection(poolBindings, liveIds);
			if (!poolSelection) {
				audit?.record("no_eligible_credential", 503, zeroUsage(), "no_eligible_credential");
				return poolFailureResponse(
					route,
					503,
					"no_eligible_credential",
					"No eligible credential is available for this request",
				);
			}
			credentialSessionScope = gatewayPoolScope(poolSelection.poolId, model.provider);
			selection = {
				policyKey: credentialSessionScope,
				eligibleCredentialIds: poolSelection.credentialIds,
				strategy: poolSelection.strategy,
			};
		}
	}

	const credentialSessionId = isManagedRegular(principal)
		? `gateway:${principal.id}:${credentialSessionScope}:${requestSessionId}`
		: requestSessionId;
	let streamApiKey: SimpleStreamOptions["apiKey"] = GATEWAY_KEYLESS_API_KEY;
	let recoverTerminalCredentialError: ((error: unknown) => Promise<PoolExhaustionFailure | undefined>) | undefined;
	if (!keylessModel) {
		let credential: GatewayCredentialResolution | undefined;
		try {
			credential = await resolveGatewayCredential(
				bootOpts.storage,
				model,
				credentialSessionId,
				controller.signal,
				selection,
				exhaustion,
			);
		} catch (error) {
			if (controller.signal.aborted) return aborted();
			const classified = classifyGatewayError(error);
			logger.warn("auth-gateway getApiKey threw", { provider: model.provider, peer, error: classified.message });
			return piNative.formatError(classified.status, classified.type, classified.message);
		}
		if (controller.signal.aborted) return aborted();
		if (!credential) {
			const response = mapInitialCredentialFailure(route, model, selection, exhaustion);
			const poolFailure = describePoolExhaustion(exhaustion);
			audit?.record(
				poolFailure?.outcome ?? auditOutcomeForStatus(response.status),
				response.status,
				zeroUsage(),
				poolFailure?.type ?? (response.status >= 400 ? "credential_unavailable" : null),
			);
			return response;
		}
		let currentApiKey = credential.apiKey;
		const onCredential = (next: ResolvedAuthCredential): void => {
			currentApiKey = next.apiKey;
			audit?.setCredential(next.credentialId ?? null);
		};
		streamApiKey = buildGatewayApiKeyResolver(
			bootOpts.storage,
			model,
			credentialSessionId,
			credential,
			controller.signal,
			"pi-native",
			peer,
			selection,
			exhaustion,
			onCredential,
		);
		recoverTerminalCredentialError = buildTerminalCredentialErrorRecovery({
			storage: bootOpts.storage,
			model,
			sessionId: credentialSessionId,
			getApiKey: () => currentApiKey,
			signal: controller.signal,
			format: "pi-native",
			peer,
			selection,
			exhaustion,
			onCredential,
		});
	}

	const streamOpts: SimpleStreamOptions = { ...parsed.options, apiKey: streamApiKey, signal: controller.signal };
	if (model.api === "openai-codex-responses") {
		delete streamOpts.temperature;
		delete streamOpts.topP;
		delete streamOpts.topK;
		delete streamOpts.minP;
		delete streamOpts.stopSequences;
		delete streamOpts.presencePenalty;
		delete streamOpts.frequencyPenalty;
		delete streamOpts.repetitionPenalty;
	}
	// Merge gateway-captured passthrough headers under the client's own
	// headers — the client's values win when they collide.
	const captured = captureRequestHeaders(req.headers);
	streamOpts.headers = { ...captured, ...(streamOpts.headers ?? {}) };
	streamOpts.sessionId ??= requestSessionId;

	logger.info("auth-gateway request", {
		requestId,
		format: "pi-native",
		model: parsed.modelId,
		resolvedProvider: model.provider,
		resolvedModel: model.id,
		stream: parsed.stream,
		peer,
	});

	if (!parsed.stream) {
		try {
			if (controller.signal.aborted) return aborted();
			const message = await completeSimple(model, parsed.context, streamOpts);
			if (message.stopReason === "aborted" || message.stopReason === "error") {
				const poolFailure = describePoolExhaustion(exhaustion);
				const errorMessage = poolFailure
					? "No eligible credential is available for this request"
					: (message.errorMessage ??
						(message.stopReason === "aborted" ? "Request was aborted" : "Upstream request failed"));
				logger.warn("auth-gateway non-streaming failed", {
					format: "pi-native",
					reason: message.stopReason,
					error: errorMessage,
					peer,
				});
				if (poolFailure) {
					audit?.record(poolFailure.outcome, poolFailure.status, usageOf(message), poolFailure.type);
					return poolFailureResponse(
						route,
						poolFailure.status,
						poolFailure.type,
						"No eligible credential is available for this request",
						poolFailure.retryAtMs,
					);
				}
				if (message.stopReason === "aborted") {
					audit?.record("request_aborted", 499, usageOf(message), "request_aborted");
					return piNative.formatError(499, "request_aborted", errorMessage);
				}
				const terminalPoolFailure = recoverTerminalCredentialError
					? await recoverTerminalCredentialError(errorMessage)
					: undefined;
				if (terminalPoolFailure) {
					audit?.record(
						terminalPoolFailure.outcome,
						terminalPoolFailure.status,
						usageOf(message),
						terminalPoolFailure.type,
					);
					return poolFailureResponse(
						route,
						terminalPoolFailure.status,
						terminalPoolFailure.type,
						"No eligible credential is available for this request",
						terminalPoolFailure.retryAtMs,
					);
				}
				const classified = classifyGatewayError(errorMessage);
				audit?.record("upstream_error", classified.status, usageOf(message), classified.type);
				return piNative.formatError(classified.status, classified.type, errorMessage);
			}
			audit?.record("success", 200, usageOf(message));
			return json(200, { message }, gatewayResponseHeaders(model, { requestId, message, startedAt }));
		} catch (error) {
			if (controller.signal.aborted) return aborted();
			const poolFailure = describePoolExhaustion(exhaustion);
			if (poolFailure) {
				audit?.record(poolFailure.outcome, poolFailure.status, zeroUsage(), poolFailure.type);
				return poolFailureResponse(
					route,
					poolFailure.status,
					poolFailure.type,
					"No eligible credential is available for this request",
					poolFailure.retryAtMs,
				);
			}
			const terminalPoolFailure = recoverTerminalCredentialError
				? await recoverTerminalCredentialError(error)
				: undefined;
			if (terminalPoolFailure) {
				audit?.record(
					terminalPoolFailure.outcome,
					terminalPoolFailure.status,
					zeroUsage(),
					terminalPoolFailure.type,
				);
				return poolFailureResponse(
					route,
					terminalPoolFailure.status,
					terminalPoolFailure.type,
					"No eligible credential is available for this request",
					terminalPoolFailure.retryAtMs,
				);
			}
			const classified = classifyGatewayError(error);
			logger.warn("auth-gateway non-streaming aborted", { format: "pi-native", error: classified.message, peer });
			audit?.record("upstream_error", classified.status, zeroUsage(), classified.type);
			return piNative.formatError(classified.status, classified.type, classified.message);
		}
	}

	let events: AssistantMessageEventStream;
	try {
		if (controller.signal.aborted) return aborted();
		events = streamSimple(model, parsed.context, streamOpts);
	} catch (error) {
		const classified = classifyGatewayError(error);
		logger.warn("auth-gateway streamSimple threw", { format: "pi-native", error: classified.message, peer });
		const poolFailure = describePoolExhaustion(exhaustion);
		if (poolFailure) {
			audit?.record(poolFailure.outcome, poolFailure.status, zeroUsage(), poolFailure.type);
			return poolFailureResponse(
				route,
				poolFailure.status,
				poolFailure.type,
				"No eligible credential is available for this request",
				poolFailure.retryAtMs,
			);
		}
		const terminalPoolFailure = recoverTerminalCredentialError
			? await recoverTerminalCredentialError(error)
			: undefined;
		if (terminalPoolFailure) {
			audit?.record(terminalPoolFailure.outcome, terminalPoolFailure.status, zeroUsage(), terminalPoolFailure.type);
			return poolFailureResponse(
				route,
				terminalPoolFailure.status,
				terminalPoolFailure.type,
				"No eligible credential is available for this request",
				terminalPoolFailure.retryAtMs,
			);
		}
		audit?.record("upstream_error", classified.status, zeroUsage(), classified.type);
		return piNative.formatError(classified.status, classified.type, classified.message);
	}
	if (controller.signal.aborted) return aborted();

	const auditedEvents = wrapEventsForAudit(
		events,
		audit,
		200,
		exhaustion,
		model,
		controller.signal,
		recoverTerminalCredentialError,
	);
	const sseStream = piNative.encodeStream(auditedEvents, parsed.modelId, parsed.options, {
		signal: controller.signal,
		onCancel: reason => {
			audit?.record("request_aborted", 499, zeroUsage(), "request_aborted");
			if (!controller.signal.aborted) {
				controller.abort(reason instanceof Error ? reason : new Error("client closed request"));
			}
		},
	});
	return new Response(sseStream, {
		status: 200,
		headers: {
			...gatewayResponseHeaders(model, { requestId }),
			"Content-Type": "text/event-stream; charset=utf-8",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
			"X-Accel-Buffering": "no",
		},
	});
}

/**
 * Snapshot of `GET /v1/usage` — `fetchUsageReports` already caches reports at
 * a 5-minute per-credential TTL (with jitter, plus last-good fallback on
 * failure) inside `AuthStorage`, so this handler is a thin wrapper that
 * surfaces the same data to HTTP callers (notably the macOS usage widget).
 */
async function handleUsage(
	storage: AuthStorage,
	req: Request,
	principal: AuthGatewayPrincipal,
	accessStore?: AuthGatewayBootOptions["accessStore"],
): Promise<Response> {
	if (isManagedRegular(principal) && accessStore) {
		const rules = accessStore.listAclRules(principal.userId);
		const access = evaluateAuthGatewayRouteAccess(principal, rules, "usage", true);
		if (!access.allowed)
			return json(403, { error: { type: "permission_error", message: "Access denied by gateway policy" } });
		const since = readUsageSince(req);
		if (since instanceof Response) return since;
		return json(200, {
			usage: accessStore.getUserUsage(principal.userId, since),
			principal: {
				kind: principal.kind,
				userId: principal.userId,
				name: principal.name,
				role: principal.role,
				tokenId: principal.tokenId,
			},
		});
	}
	const reports = (await storage.fetchUsageReports?.({ signal: req.signal })) ?? [];
	const trimmed = reports.map(({ raw: _raw, ...rest }) => rest);
	return json(200, {
		generatedAt: Date.now(),
		principal: {
			kind: principal.kind,
			userId: principal.userId,
			name: principal.name,
			role: principal.role,
			tokenId: principal.tokenId,
		},
		reports: trimmed,
	});
}

function readUsageSince(req: Request): number | Response {
	const raw = new URL(req.url).searchParams.get("since");
	if (raw === null) return 0;
	const since = Number(raw);
	if (!Number.isFinite(since) || since < 0) {
		return json(400, {
			error: {
				type: "invalid_request_error",
				message: "since must be a non-negative millisecond timestamp",
			},
		});
	}
	return since;
}

async function handleCredentialsCheck(
	storage: AuthStorage,
	signal: AbortSignal,
	principal: AuthGatewayPrincipal,
	accessStore?: AuthGatewayBootOptions["accessStore"],
): Promise<Response> {
	if (isManagedRegular(principal) && accessStore) {
		const rules = accessStore.listAclRules(principal.userId);
		const access = evaluateAuthGatewayRouteAccess(principal, rules, "check", true);
		if (!access.allowed)
			return json(403, { error: { type: "permission_error", message: "Access denied by gateway policy" } });
		const poolBindings = accessStore.listUserPoolBindings(principal.userId);
		if (poolBindings.length === 0)
			return json(403, { error: { type: "permission_error", message: "Access denied by gateway policy" } });

		const candidateIds: number[] = [];
		for (const binding of poolBindings) {
			for (const member of binding.pool.members) candidateIds.push(member.credentialId);
		}
		const liveIdsByProvider = new Map<string, Set<number>>();
		for (const row of storage.listStoredCredentialsByIds(candidateIds)) {
			const ids = liveIdsByProvider.get(row.provider) ?? new Set<number>();
			ids.add(row.id);
			liveIdsByProvider.set(row.provider, ids);
		}

		const eligible = new Set<number>();
		for (const [provider, liveIds] of liveIdsByProvider) {
			const catalogModels = bundledCatalogModelsForProvider(provider);
			const providerAccess =
				catalogModels.length > 0
					? catalogModels.some(
							model =>
								evaluateAuthGatewayAccess(principal, rules, {
									route: "check",
									provider,
									qualifiedModel: qualifiedModelId(model),
								}).allowed,
						)
					: evaluateAuthGatewayAccess(principal, rules, { route: "check", provider }).allowed;
			if (!providerAccess) continue;
			const poolSelection = resolveAuthGatewayPoolSelection(poolBindings, liveIds);
			if (!poolSelection) continue;
			for (const credentialId of poolSelection.credentialIds) eligible.add(credentialId);
		}

		const credentials = await storage.checkCredentials({ signal, credentialIds: [...eligible] });
		const filtered = credentials
			.slice()
			.sort((a, b) => a.provider.localeCompare(b.provider) || a.type.localeCompare(b.type) || a.id - b.id);
		return json(200, {
			generatedAt: Date.now(),
			credentials: filtered.map((result, index) => {
				const reasonCode =
					result.ok === null
						? "unverifiable"
						: result.ok === false && /usage|limit|quota/i.test(result.reason ?? "")
							? "usage_limit"
							: result.ok === false && /auth|401|403|refresh/i.test(result.reason ?? "")
								? "authentication_failed"
								: result.ok === false
									? "upstream_error"
									: undefined;
				return {
					member: index + 1,
					provider: result.provider,
					type: result.type,
					ok: result.ok,
					...(reasonCode ? { reasonCode } : {}),
				};
			}),
		});
	}
	const credentials = await storage.checkCredentials({ signal });
	return json(200, { generatedAt: Date.now(), credentials });
}

function handleModelsList(opts: AuthGatewayBootOptions, principal: AuthGatewayPrincipal): Response {
	const list = opts.listModels ? Array.from(opts.listModels()) : [];
	let filtered = list;
	if (isManagedRegular(principal) && opts.accessStore) {
		const rules = opts.accessStore.listAclRules(principal.userId);
		const poolBindings = opts.accessStore.listUserPoolBindings(principal.userId);
		const liveIdsByProvider = new Map<string, Set<number>>();
		const liveIdsForProvider = (provider: string): Set<number> => {
			let liveIds = liveIdsByProvider.get(provider);
			if (!liveIds) {
				liveIds = credentialIdsForProvider(opts.storage, provider);
				liveIdsByProvider.set(provider, liveIds);
			}
			return liveIds;
		};
		filtered = list.filter(model => {
			const qualified = qualifiedModelId(model);
			const access = evaluateAuthGatewayAccess(principal, rules, {
				route: "models",
				provider: model.provider,
				qualifiedModel: qualified,
			});
			if (!access.allowed) return false;
			if (opts.isKeylessModel?.(model) ?? false) return true;
			return resolveAuthGatewayPoolSelection(poolBindings, liveIdsForProvider(model.provider)) !== null;
		});
	}
	const seenIds = new Set<string>();
	const data: Array<{ id: string; object: "model"; owned_by: string; api: Api }> = [];
	for (const model of filtered) {
		const id = qualifiedModelId(model);
		if (seenIds.has(id)) continue;
		seenIds.add(id);
		data.push({
			id,
			object: "model" as const,
			owned_by: model.provider,
			api: model.api,
		});
	}
	return json(200, { object: "list", data });
}

function authenticateGatewayRequest(
	req: Request,
	tokens: ReadonlySet<string>,
	accessStore?: AuthGatewayBootOptions["accessStore"],
): AuthGatewayPrincipal | null {
	if (tokens.size === 0) {
		return { kind: "no-auth", id: "no-auth-admin", userId: null, name: "no-auth", role: "admin", tokenId: null };
	}
	const bearer = readBearerToken(req);
	if (!bearer) return null;
	const presented = new TextEncoder().encode(bearer);
	let legacyOk = false;
	for (const token of tokens) {
		if (timingSafeEqual(presented, new TextEncoder().encode(token))) legacyOk = true;
	}
	if (legacyOk)
		return { kind: "legacy", id: "legacy-admin", userId: null, name: "legacy", role: "admin", tokenId: null };
	return accessStore?.authenticateToken(bearer) ?? null;
}

function classifyRoute(pathname: string): AuthGatewayRouteFamily {
	if (pathname === "/v1/chat/completions") return "chat";
	if (pathname === "/v1/messages") return "messages";
	if (pathname === "/v1/responses") return "responses";
	if (pathname === "/v1/pi/stream") return "pi-native";
	if (pathname === "/v1/models") return "models";
	if (pathname === "/v1/usage") return "usage";
	if (pathname === "/v1/credentials/check") return "check";
	if (
		pathname.startsWith("/v1/admin/") ||
		pathname === "/v1/admin" ||
		pathname.startsWith("/v1/users") ||
		pathname.startsWith("/v1/pools") ||
		pathname.startsWith("/v1/audit")
	)
		return "management";
	return "unknown";
}

export function startAuthGateway(opts: AuthGatewayBootOptions): AuthGatewayServerHandle {
	const bind = parseBind(opts.bind ?? DEFAULT_AUTH_GATEWAY_BIND);
	const tokens = new Set<string>(opts.bearerTokens);
	const version = opts.version ?? "dev";

	const server = Bun.serve({
		hostname: bind.hostname,
		port: bind.port,
		fetch: async (req): Promise<Response> => {
			const url = new URL(req.url);
			const pathname = url.pathname;
			const peer = resolvePeer(req);
			if (req.method === "OPTIONS") {
				return new Response(null, { status: 204, headers: corsHeaders(req) });
			}
			try {
				if (req.method === "GET" && pathname === "/healthz") {
					return withCors(json(200, { ok: true, version }), req);
				}
				const routeFamily = classifyRoute(pathname);
				const audit = createAuditRecorder(opts, req, pathname, routeFamily);
				const principal = authenticateGatewayRequest(req, tokens, opts.accessStore);
				if (!principal) {
					logger.info("auth-gateway request unauthorized", { method: req.method, path: pathname, peer });
					audit?.record("unauthorized", 401, zeroUsage(), "unauthorized");
					return withCors(
						routeFamily === "management"
							? json(401, { error: { code: "unauthorized", message: "Unauthorized" } })
							: json(401, { error: "unauthorized" }),
						req,
					);
				}
				audit?.setPrincipal(principal);

				if (opts.accessStore) {
					const management = await handleAuthGatewayManagementRequest(
						req,
						pathname,
						principal,
						opts.accessStore,
						opts.storage,
						version,
					);
					if (management) {
						audit?.record(
							auditOutcomeForStatus(management.status),
							management.status,
							zeroUsage(),
							management.status >= 400 ? "management_error" : null,
						);
						return withCors(management, req);
					}
				}

				if (req.method === "GET" && pathname === "/v1/usage") {
					const response = await handleUsage(opts.storage, req, principal, opts.accessStore);
					audit?.record(auditOutcomeForStatus(response.status), response.status);
					return withCors(response, req);
				}

				if (req.method === "GET" && pathname === "/v1/credentials/check") {
					const response = await handleCredentialsCheck(opts.storage, req.signal, principal, opts.accessStore);
					audit?.record(auditOutcomeForStatus(response.status), response.status);
					return withCors(response, req);
				}

				const formatRoute = FORMAT_ROUTES[pathname];
				if (formatRoute && req.method === "POST") {
					if (routeFamily === "chat" || routeFamily === "messages" || routeFamily === "responses") {
						return withCors(
							await handleFormatEndpoint(formatRoute, opts, req, peer, principal, audit, routeFamily),
							req,
						);
					}
				}

				if (req.method === "POST" && pathname === "/v1/pi/stream") {
					return withCors(await handlePiNative(opts, req, peer, principal, audit), req);
				}

				if (req.method === "GET" && pathname === "/v1/models") {
					const response = handleModelsList(opts, principal);
					audit?.record(auditOutcomeForStatus(response.status), response.status);
					return withCors(response, req);
				}

				const response = json(404, { error: `No route: ${req.method} ${pathname}` });
				audit?.record("not_found", 404, zeroUsage(), "not_found");
				return withCors(response, req);
			} catch (error) {
				logger.error("auth-gateway handler crashed", {
					method: req.method,
					path: pathname,
					peer,
					error: String(error),
				});
				const audit = createAuditRecorder(opts, req, pathname, classifyRoute(pathname));
				audit?.record("internal_error", 500, zeroUsage(), "internal_error");
				return withCors(json(500, { error: "internal error" }), req);
			}
		},
		// Max-out Bun's idle timeout. Long thinking-budget calls can sit idle
		// for minutes before the first token arrives; the default kills them.
		idleTimeout: 255,
	});

	const boundHost = server.hostname ?? bind.hostname;
	const boundPort = server.port ?? bind.port;
	return {
		url: `http://${boundHost}:${boundPort}`,
		port: boundPort,
		hostname: boundHost,
		close: async () => {
			// Graceful drain: `stop()` (default `closeActiveConnections=false`)
			// stops accepting new connections and resolves once in-flight requests
			// finish, rather than force-killing them mid-stream. A forced close
			// aborts active requests, which clients see as a dropped connection
			// (Bun surfaces this as the opaque "socket connection was closed
			// unexpectedly"). The caller bounds how long it waits — under systemd
			// that is `TimeoutStopSec`, after which the process is hard-killed.
			await server.stop();
		},
	};
}
