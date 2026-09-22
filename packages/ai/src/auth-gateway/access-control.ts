export const AUTH_GATEWAY_ACL_ROUTES = [
	"chat",
	"messages",
	"responses",
	"pi-native",
	"models",
	"usage",
	"check",
	"systemone",
	"images",
	"speech",
	"transcriptions",
	"embeddings",
	"rerank",
	"video",
] as const;
export const AUTH_GATEWAY_BASIC_ROUTES = [
	"chat",
	"messages",
	"responses",
	"pi-native",
	"models",
] as const satisfies readonly AuthGatewayAclRoute[];
export type AuthGatewayAclRoute = (typeof AUTH_GATEWAY_ACL_ROUTES)[number];
export type AuthGatewayRouteFamily = AuthGatewayAclRoute | "management" | "unknown";
export type AuthGatewayRole = "user" | "admin";
export type AuthGatewayAclEffect = "allow" | "deny";
export type AuthGatewayAclKind = "provider" | "model" | "route";
export const AUTH_GATEWAY_POOL_STRATEGIES = ["sticky-session", "least-used", "round-robin", "failover"] as const;
export type AuthGatewayPoolStrategy = (typeof AUTH_GATEWAY_POOL_STRATEGIES)[number];
export type AuthGatewayAuditOutcome =
	| "success"
	| "unauthorized"
	| "denied_by_acl"
	| "invalid_request"
	| "unknown_model"
	| "no_eligible_credential"
	| "usage_limit"
	| "upstream_error"
	| "request_aborted"
	| "not_found"
	| "internal_error";

export interface AuthGatewayUser {
	id: number;
	name: string;
	description: string | null;
	owner: string | null;
	role: AuthGatewayRole;
	enabled: boolean;
	createdAt: number;
	updatedAt: number;
	lastUsedAt: number | null;
}

export interface AuthGatewayToken {
	id: number;
	userId: number;
	publicId: string;
	label: string | null;
	createdAt: number;
	lastUsedAt: number | null;
	revokedAt: number | null;
}

export interface AuthGatewayIssuedToken extends AuthGatewayToken {
	value: string;
}

export interface AuthGatewayAclRule {
	id: number;
	userId: number;
	effect: AuthGatewayAclEffect;
	kind: AuthGatewayAclKind;
	pattern: string;
	createdAt: number;
}

export interface AuthGatewayAclRuleInput {
	effect: AuthGatewayAclEffect;
	kind: AuthGatewayAclKind;
	pattern: string;
}

export interface AuthGatewayAclBatchResult {
	rule: AuthGatewayAclRule;
	created: boolean;
}

export interface AuthGatewayPoolMember {
	credentialId: number;
	position: number;
	createdAt: number;
}

export interface AuthGatewayPool {
	id: number;
	name: string;
	strategy: AuthGatewayPoolStrategy;
	createdAt: number;
	updatedAt: number;
	members: AuthGatewayPoolMember[];
}

export interface AuthGatewayUserPoolBinding {
	poolId: number;
	position: number;
	createdAt: number;
	pool: AuthGatewayPool;
}

export interface AuthGatewayPrincipal {
	kind: "managed" | "legacy" | "no-auth";
	id: number | "legacy-admin" | "no-auth-admin";
	userId: number | null;
	name: string;
	role: AuthGatewayRole;
	tokenId: number | null;
}

export interface AuthGatewayAccessScope {
	route: AuthGatewayAclRoute;
	provider?: string;
	qualifiedModel?: string;
}

export type AuthGatewayAccessDecision =
	| { allowed: true }
	| { allowed: false; reason: "route_denied" | "provider_denied" | "model_denied" | "no_matching_allow" };

export interface AuthGatewayPoolSelection {
	poolId: number;
	strategy: AuthGatewayPoolStrategy;
	credentialIds: number[];
}

export interface AuthGatewayAuditEvent {
	id: number;
	requestId: string;
	startedAt: number;
	completedAt: number;
	userId: number | null;
	userName: string | null;
	tokenId: number | null;
	method: string;
	path: string;
	routeFamily: AuthGatewayRouteFamily;
	requestedModel: string | null;
	resolvedProvider: string | null;
	resolvedModel: string | null;
	credentialId: number | null;
	outcome: AuthGatewayAuditOutcome;
	statusCode: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	costUsd: number;
	errorCode: string | null;
}

export interface AuthGatewayUsageSummary {
	userId: number;
	since: number;
	generatedAt: number;
	totals: {
		requests: number;
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens: number;
		cacheWriteTokens: number;
		totalTokens: number;
		costUsd: number;
	};
	byProviderModel: Array<{
		provider: string;
		model: string;
		requests: number;
		totalTokens: number;
		costUsd: number;
	}>;
}

export type AuthGatewayAccessErrorCode = "invalid_request" | "not_found" | "conflict";

export class AuthGatewayAccessError extends Error {
	readonly code: AuthGatewayAccessErrorCode;

	constructor(code: AuthGatewayAccessErrorCode, message: string) {
		super(message);
		this.name = "AuthGatewayAccessError";
		this.code = code;
	}
}

export const AUTH_GATEWAY_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

const ROUTES: Record<AuthGatewayAclRoute, true> = {
	chat: true,
	messages: true,
	responses: true,
	"pi-native": true,
	models: true,
	usage: true,
	check: true,
	systemone: true,
	images: true,
	speech: true,
	transcriptions: true,
	embeddings: true,
	rerank: true,
	video: true,
};

const STRATEGIES: Record<AuthGatewayPoolStrategy, true> = {
	"sticky-session": true,
	"least-used": true,
	"round-robin": true,
	failover: true,
};

export function normalizeAuthGatewayName(name: string, label: string): string {
	const normalized = name.trim().toLowerCase();
	if (!AUTH_GATEWAY_NAME_PATTERN.test(normalized)) {
		throw new AuthGatewayAccessError("invalid_request", `${label} must match ${AUTH_GATEWAY_NAME_PATTERN.source}`);
	}
	return normalized;
}

export function normalizeAuthGatewayRef(ref: number | string, label: string): { id: number } | { name: string } {
	if (typeof ref === "number") {
		if (!Number.isInteger(ref) || ref <= 0) {
			throw new AuthGatewayAccessError("invalid_request", `${label} id must be a positive integer`);
		}
		return { id: ref };
	}
	const value = ref.trim();
	if (/^\d+$/.test(value)) {
		const id = Number(value);
		if (!Number.isSafeInteger(id) || id <= 0) {
			throw new AuthGatewayAccessError("invalid_request", `${label} id must be a positive integer`);
		}
		return { id };
	}
	return { name: normalizeAuthGatewayName(value, label) };
}

export function normalizeAuthGatewayRole(role: AuthGatewayRole | undefined): AuthGatewayRole {
	if (role === undefined) return "user";
	if (role !== "user" && role !== "admin") {
		throw new AuthGatewayAccessError("invalid_request", "role must be user or admin");
	}
	return role;
}

export function normalizeAuthGatewayPoolStrategy(
	strategy: AuthGatewayPoolStrategy | undefined,
): AuthGatewayPoolStrategy {
	if (strategy === undefined) return "sticky-session";
	if (!(strategy in STRATEGIES)) {
		throw new AuthGatewayAccessError("invalid_request", "invalid pool strategy");
	}
	return strategy;
}

export function normalizeAuthGatewayAclRule(input: {
	effect: AuthGatewayAclEffect;
	kind: AuthGatewayAclKind;
	pattern: string;
}): { effect: AuthGatewayAclEffect; kind: AuthGatewayAclKind; pattern: string } {
	const { effect, kind } = input;
	if (effect !== "allow" && effect !== "deny") {
		throw new AuthGatewayAccessError("invalid_request", "ACL effect must be allow or deny");
	}
	if (kind !== "provider" && kind !== "model" && kind !== "route") {
		throw new AuthGatewayAccessError("invalid_request", "ACL kind must be provider, model, or route");
	}
	const pattern = input.pattern.trim();
	if (kind === "provider") return { effect, kind, pattern: normalizeProviderPattern(pattern) };
	if (kind === "model") return { effect, kind, pattern: normalizeModelPattern(pattern) };
	return { effect, kind, pattern: normalizeRoutePattern(pattern) };
}

export function evaluateAuthGatewayRouteAccess(
	principal: AuthGatewayPrincipal,
	rules: readonly AuthGatewayAclRule[],
	route: AuthGatewayAclRoute,
	requireExplicitAllow: boolean,
): AuthGatewayAccessDecision {
	if (principal.role === "admin" || principal.kind === "legacy" || principal.kind === "no-auth")
		return { allowed: true };
	const routeRules = rules.filter(rule => rule.kind === "route");
	if (routeRules.some(rule => rule.effect === "deny" && (rule.pattern === "*" || rule.pattern === route))) {
		return { allowed: false, reason: "route_denied" };
	}
	if (routeRules.some(rule => rule.effect === "allow" && (rule.pattern === "*" || rule.pattern === route))) {
		return { allowed: true };
	}
	if (routeRules.length > 0 || requireExplicitAllow) {
		return { allowed: false, reason: "route_denied" };
	}
	return { allowed: true };
}

export function evaluateAuthGatewayAccess(
	principal: AuthGatewayPrincipal,
	rules: readonly AuthGatewayAclRule[],
	scope: AuthGatewayAccessScope,
): AuthGatewayAccessDecision {
	if (principal.role === "admin" || principal.kind === "legacy" || principal.kind === "no-auth")
		return { allowed: true };
	const routeDecision = evaluateAuthGatewayRouteAccess(principal, rules, scope.route, false);
	if (!routeDecision.allowed) return routeDecision;

	const provider = scope.provider ?? providerFromQualifiedModel(scope.qualifiedModel);
	const qualifiedModel = scope.qualifiedModel;
	if (provider === undefined && qualifiedModel === undefined) return { allowed: true };

	if (
		provider !== undefined &&
		rules.some(
			rule => rule.kind === "provider" && rule.effect === "deny" && providerPatternMatches(rule.pattern, provider),
		)
	) {
		return { allowed: false, reason: "provider_denied" };
	}
	if (
		qualifiedModel !== undefined &&
		rules.some(
			rule => rule.kind === "model" && rule.effect === "deny" && modelPatternMatches(rule.pattern, qualifiedModel),
		)
	) {
		return { allowed: false, reason: "model_denied" };
	}

	const hasModelAllow =
		qualifiedModel !== undefined
			? rules.some(
					rule =>
						rule.kind === "model" && rule.effect === "allow" && modelPatternMatches(rule.pattern, qualifiedModel),
				)
			: provider !== undefined &&
				rules.some(
					rule =>
						rule.kind === "model" &&
						rule.effect === "allow" &&
						modelPatternCoversProvider(rule.pattern, provider),
				);
	const hasProviderAllow =
		provider !== undefined &&
		rules.some(
			rule => rule.kind === "provider" && rule.effect === "allow" && providerPatternMatches(rule.pattern, provider),
		);
	if (hasModelAllow || hasProviderAllow) return { allowed: true };
	return { allowed: false, reason: "no_matching_allow" };
}

export function resolveAuthGatewayPoolSelection(
	bindings: readonly AuthGatewayUserPoolBinding[],
	eligibleCredentialIds: ReadonlySet<number> | readonly number[],
): AuthGatewayPoolSelection | null {
	const eligible = new Set(eligibleCredentialIds);
	for (const binding of [...bindings].sort((left, right) => left.position - right.position)) {
		const credentialIds = [...binding.pool.members]
			.sort((left, right) => left.position - right.position)
			.map(member => member.credentialId)
			.filter(credentialId => eligible.has(credentialId));
		if (credentialIds.length === 0) continue;
		return {
			poolId: binding.poolId,
			strategy: binding.pool.strategy,
			credentialIds,
		};
	}
	return null;
}

function normalizeProviderPattern(pattern: string): string {
	if (pattern === "*") return pattern;
	if (pattern.length === 0 || pattern.includes("*")) {
		throw new AuthGatewayAccessError("invalid_request", "provider ACL pattern must be an exact provider id or *");
	}
	return pattern;
}

function invalidModelPattern(): AuthGatewayAccessError {
	return new AuthGatewayAccessError(
		"invalid_request",
		"model ACL pattern must be an exact provider/model, provider/*, or *",
	);
}

function normalizeModelPattern(pattern: string): string {
	if (pattern === "*") return pattern;
	// The wildcard form is provider-scoped: the prefix before `/*` is one provider
	// id, so `openrouter/~anthropic/*` is not a legal model-path glob.
	if (pattern.endsWith("/*")) {
		const provider = pattern.slice(0, -2);
		if (provider.length === 0 || provider.includes("*") || provider.includes("/")) throw invalidModelPattern();
		return pattern;
	}
	// The exact form is `<provider>/<modelId>`, and the model id may itself contain
	// slashes (openrouter: `openrouter/~anthropic/claude-fable-latest`), so require
	// a nonempty provider plus a nonempty remainder rather than exactly two segments.
	const segments = pattern.split("/");
	if (pattern.includes("*") || segments.length < 2 || segments.some(segment => segment.length === 0)) {
		throw invalidModelPattern();
	}
	return pattern;
}

function normalizeRoutePattern(pattern: string): string {
	if (pattern === "*") return pattern;
	if (!(pattern in ROUTES)) {
		throw new AuthGatewayAccessError("invalid_request", "route ACL pattern must be a gateway route or *");
	}
	return pattern;
}

function providerPatternMatches(pattern: string, provider: string): boolean {
	return pattern === "*" || pattern === provider;
}

function modelPatternMatches(pattern: string, qualifiedModel: string): boolean {
	if (pattern === "*") return true;
	if (pattern.endsWith("/*")) {
		const providerPrefix = pattern.slice(0, -1);
		return qualifiedModel.startsWith(providerPrefix);
	}
	return pattern === qualifiedModel;
}

function modelPatternCoversProvider(pattern: string, provider: string): boolean {
	return pattern === "*" || pattern === `${provider}/*`;
}

function providerFromQualifiedModel(qualifiedModel: string | undefined): string | undefined {
	if (qualifiedModel === undefined) return undefined;
	const slash = qualifiedModel.indexOf("/");
	return slash > 0 ? qualifiedModel.slice(0, slash) : undefined;
}
