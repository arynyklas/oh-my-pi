import { type } from "arktype";
import { credentialUploadRequestSchema } from "../auth-broker/wire-schemas";
import type {
	AuthCredential,
	AuthCredentialSnapshotEntry,
	AuthStorage,
	OAuthCredential,
	StoredAuthCredential,
} from "../auth-storage";
import {
	AUTH_GATEWAY_POOL_STRATEGIES,
	AuthGatewayAccessError,
	type AuthGatewayAclRuleInput,
	type AuthGatewayPoolStrategy,
	type AuthGatewayPrincipal,
	type AuthGatewayRole,
} from "./access-control";
import type { AuthGatewayAccessStore } from "./access-store";
import { json } from "./http";
import type {
	AuthGatewayAdminStatus,
	AuthGatewayCredentialInUseDetails,
	AuthGatewayCredentialSummary,
} from "./management-types";

const USER_CREATE_FIELDS: Record<string, true> = { name: true, description: true, owner: true, role: true };
const USER_PATCH_FIELDS: Record<string, true> = { description: true, owner: true, role: true, enabled: true };
const TOKEN_CREATE_FIELDS: Record<string, true> = { label: true };
const ACL_CREATE_FIELDS: Record<string, true> = { effect: true, kind: true, pattern: true };
const ACL_BATCH_FIELDS: Record<string, true> = { rules: true };
const POOL_BIND_FIELDS: Record<string, true> = { poolId: true };
const USER_POOL_ORDER_FIELDS: Record<string, true> = { poolIds: true };
const POOL_CREATE_FIELDS: Record<string, true> = { name: true, strategy: true };
const POOL_PATCH_FIELDS: Record<string, true> = { name: true, strategy: true };
const POOL_MEMBER_FIELDS: Record<string, true> = { credentialId: true };
const POOL_MEMBER_ORDER_FIELDS: Record<string, true> = { credentialIds: true };
const STRATEGIES: Record<AuthGatewayPoolStrategy, true> = Object.fromEntries(
	AUTH_GATEWAY_POOL_STRATEGIES.map(strategy => [strategy, true]),
) as Record<AuthGatewayPoolStrategy, true>;

export async function handleAuthGatewayManagementRequest(
	req: Request,
	pathname: string,
	principal: AuthGatewayPrincipal,
	accessStore: AuthGatewayAccessStore,
	storage: AuthStorage,
	version: string,
): Promise<Response | null> {
	const parts = pathname.split("/").filter(Boolean);
	if (
		parts[0] !== "v1" ||
		(parts[1] !== "users" && parts[1] !== "pools" && parts[1] !== "audit" && parts[1] !== "admin")
	)
		return null;
	if (principal.kind === "no-auth")
		return managementError(403, "management_auth_required", "Management routes require an authenticated admin token");
	if (principal.role !== "admin") return managementError(403, "forbidden", "Management routes require an admin token");

	try {
		if (parts[1] === "admin") return await handleAdmin(req, parts.slice(2), principal, accessStore, storage, version);
		if (parts[1] === "users") return await handleUsers(req, parts.slice(2), accessStore);
		if (parts[1] === "pools") return await handlePools(req, parts.slice(2), accessStore, storage);
		return handleAudit(req, accessStore);
	} catch (error) {
		if (error instanceof ManagementHttpError)
			return managementError(error.status, error.code, error.message, error.details);
		if (error instanceof AuthGatewayAccessError)
			return managementError(errorStatus(error.code), error.code, error.message);
		return managementError(500, "internal_error", "internal error");
	}
}

async function handleAdmin(
	req: Request,
	parts: string[],
	principal: AuthGatewayPrincipal,
	store: AuthGatewayAccessStore,
	storage: AuthStorage,
	version: string,
): Promise<Response> {
	if (parts.length === 1 && parts[0] === "status" && req.method === "GET") {
		const counts = store.counts();
		const status: AuthGatewayAdminStatus = {
			ok: true,
			version,
			serverTime: Date.now(),
			principal: {
				kind: principal.kind,
				userId: principal.userId,
				name: principal.name,
				role: principal.role,
				tokenId: principal.tokenId,
			},
			counts: {
				...counts,
				credentials: storage.listStoredCredentials().length,
			},
		};
		return json(200, { status });
	}
	if (parts[0] !== "credentials") throw new ManagementHttpError(404, "not_found", "management route not found");
	if (parts.length === 1 && req.method === "GET") {
		return json(200, { credentials: storage.listStoredCredentials().map(credentialSummaryFromStored) });
	}
	if (parts.length === 1 && req.method === "POST") {
		const parsed = await readCredentialUploadBody(req);
		try {
			const stored = await storage.upsertCredentialAsync(parsed.provider, parsed.credential);
			return json(200, { credentials: stored.map(credentialSummaryFromStored) });
		} catch {
			return managementError(502, "credential_upload_failed", "Credential upload failed");
		}
	}
	if (parts.length === 3 && parts[2] === "refresh" && req.method === "POST") {
		const credentialId = positiveId(parts[1] ?? "", "credential id");
		const row = storage.listStoredCredentialsByIds([credentialId])[0];
		if (!row) throw new ManagementHttpError(404, "not_found", "credential not found");
		if (row.credential.type === "api_key") {
			throw new ManagementHttpError(400, "credential_not_refreshable", "API-key credentials cannot be refreshed");
		}
		try {
			const refreshed = await storage.refreshCredentialById(credentialId, req.signal);
			return json(200, { credential: credentialSummaryFromSnapshot(refreshed) });
		} catch {
			return managementError(502, "credential_refresh_failed", "Credential refresh failed");
		}
	}
	if (parts.length === 3 && parts[2] === "reset" && req.method === "POST") {
		const credentialId = positiveId(parts[1] ?? "", "credential id");
		const row = storage.listStoredCredentialsByIds([credentialId])[0];
		if (!row) throw new ManagementHttpError(404, "not_found", "credential not found");
		if (row.provider !== "openai-codex" || row.credential.type !== "oauth") {
			throw new ManagementHttpError(
				400,
				"credential_reset_not_supported",
				"Saved resets are only available for OpenAI Codex OAuth credentials",
			);
		}
		try {
			const outcome = await storage.redeemResetCredit({
				target: { credentialId },
				provider: row.provider,
				signal: req.signal,
			});
			return json(200, { outcome });
		} catch {
			return managementError(502, "credential_reset_failed", "Saved reset activation failed");
		}
	}
	if (parts.length === 2 && req.method === "DELETE") {
		const credentialId = positiveId(parts[1] ?? "", "credential id");
		const row = storage.listStoredCredentialsByIds([credentialId])[0];
		if (!row) throw new ManagementHttpError(404, "not_found", "credential not found");
		const pools = store.listCredentialPools(credentialId).map(pool => ({ id: pool.id, name: pool.name }));
		if (pools.length > 0) {
			const names = pools.map(pool => pool.name).join(", ");
			throw new ManagementHttpError(
				409,
				"credential_in_use",
				`Credential ${credentialId} is assigned to pool(s): ${names}`,
				{ credentialId, pools },
			);
		}
		try {
			const removed = await storage.removeCredential(row.provider, credentialId);
			if (!removed) throw new ManagementHttpError(404, "not_found", "credential not found");
			return new Response(null, { status: 204 });
		} catch (error) {
			if (error instanceof ManagementHttpError) throw error;
			return managementError(502, "credential_remove_failed", "Credential removal failed");
		}
	}
	throw new ManagementHttpError(404, "not_found", "management route not found");
}

async function handleUsers(req: Request, parts: string[], store: AuthGatewayAccessStore): Promise<Response> {
	if (parts.length === 0) {
		if (req.method === "GET") return json(200, { users: store.listUsers() });
		if (req.method === "POST") {
			const body = await readObjectBody(req, USER_CREATE_FIELDS);
			const name = requiredString(body, "name");
			const description = optionalString(body, "description");
			const owner = optionalString(body, "owner");
			const role = optionalRole(body.role);
			const created = store.createUser({ name, description, owner, role });
			return json(201, { user: created.user, token: tokenResponse(created.token) });
		}
		throw new ManagementHttpError(404, "not_found", "management route not found");
	}
	const userId = positiveId(parts[0] ?? "", "user id");
	if (parts.length === 1) {
		if (req.method === "GET") {
			const user = store.getUser(userId);
			if (!user) throw new ManagementHttpError(404, "not_found", "user not found");
			return json(200, {
				user,
				tokens: store.listUserTokens(userId),
				acl: store.listAclRules(userId),
				poolBindings: store.listUserPoolBindings(userId),
			});
		}
		if (req.method === "PATCH") {
			const body = await readObjectBody(req, USER_PATCH_FIELDS);
			return json(200, {
				user: store.updateUser(userId, {
					description: optionalNullableString(body, "description"),
					owner: optionalNullableString(body, "owner"),
					role: optionalRole(body.role),
					enabled: optionalBoolean(body, "enabled"),
				}),
			});
		}
		if (req.method === "DELETE") {
			if (!store.deleteUser(userId)) throw new ManagementHttpError(404, "not_found", "user not found");
			return new Response(null, { status: 204 });
		}
	}
	if (parts[1] === "tokens") return handleUserTokens(req, parts.slice(2), store, userId);
	if (parts[1] === "acl") return await handleUserAcl(req, parts.slice(2), store, userId);
	if (parts[1] === "pools") return await handleUserPools(req, parts.slice(2), store, userId);
	if (parts[1] === "usage" && parts.length === 2 && req.method === "GET") {
		const since = readSince(req);
		return json(200, { usage: store.getUserUsage(userId, since) });
	}
	throw new ManagementHttpError(404, "not_found", "management route not found");
}

function handleUserTokens(
	req: Request,
	parts: string[],
	store: AuthGatewayAccessStore,
	userId: number,
): Response | Promise<Response> {
	if (parts.length === 0 && req.method === "POST") {
		return readObjectBody(req, TOKEN_CREATE_FIELDS).then(body =>
			json(201, { token: tokenResponse(store.addUserToken(userId, optionalString(body, "label"))) }),
		);
	}
	if (parts.length === 1 && parts[0] === "rotate" && req.method === "POST") {
		return readOptionalObjectBody(req, TOKEN_CREATE_FIELDS).then(body =>
			json(200, { token: tokenResponse(store.rotateUserTokens(userId, optionalString(body, "label"))) }),
		);
	}
	if (parts.length === 1 && req.method === "DELETE") {
		const tokenId = positiveId(parts[0] ?? "", "token id");
		if (!store.revokeUserToken(userId, tokenId)) throw new ManagementHttpError(404, "not_found", "token not found");
		return new Response(null, { status: 204 });
	}
	throw new ManagementHttpError(404, "not_found", "management route not found");
}

async function handleUserAcl(
	req: Request,
	parts: string[],
	store: AuthGatewayAccessStore,
	userId: number,
): Promise<Response> {
	if (parts.length === 0 && req.method === "GET") return json(200, { acl: store.listAclRules(userId) });
	if (parts.length === 0 && req.method === "POST") {
		const body = await readObjectBody(req, ACL_CREATE_FIELDS);
		const [input] = aclRuleInputs([body]);
		if (!input) throw new ManagementHttpError(400, "invalid_request", "ACL rule is required");
		const result = store.addAclRule(userId, input);
		return json(result.created ? 201 : 200, { rule: result.rule });
	}
	if (parts.length === 1 && parts[0] === "batch" && req.method === "POST") {
		const body = await readObjectBody(req, ACL_BATCH_FIELDS);
		const rules = aclRulesField(body);
		const results = store.addAclRules(userId, rules);
		return json(results.some(result => result.created) ? 201 : 200, { results });
	}
	if (parts.length === 1 && req.method === "DELETE") {
		const ruleId = positiveId(parts[0] ?? "", "rule id");
		if (!store.deleteAclRule(userId, ruleId)) throw new ManagementHttpError(404, "not_found", "ACL rule not found");
		return new Response(null, { status: 204 });
	}
	throw new ManagementHttpError(404, "not_found", "management route not found");
}

async function handleUserPools(
	req: Request,
	parts: string[],
	store: AuthGatewayAccessStore,
	userId: number,
): Promise<Response> {
	if (parts.length === 0 && req.method === "GET") return json(200, { bindings: store.listUserPoolBindings(userId) });
	if (parts.length === 0 && req.method === "POST") {
		const body = await readObjectBody(req, POOL_BIND_FIELDS);
		const result = store.bindUserPool(userId, numericField(body, "poolId"));
		return json(result.created ? 201 : 200, result);
	}
	if (parts.length === 0 && req.method === "PATCH") {
		const body = await readObjectBody(req, USER_POOL_ORDER_FIELDS);
		return json(200, { bindings: store.setUserPoolOrder(userId, numericArrayField(body, "poolIds")) });
	}
	if (parts.length === 1 && req.method === "DELETE") {
		const poolId = positiveId(parts[0] ?? "", "pool id");
		if (!store.unbindUserPool(userId, poolId))
			throw new ManagementHttpError(404, "not_found", "pool binding not found");
		return new Response(null, { status: 204 });
	}
	throw new ManagementHttpError(404, "not_found", "management route not found");
}

async function handlePools(
	req: Request,
	parts: string[],
	store: AuthGatewayAccessStore,
	storage: AuthStorage,
): Promise<Response> {
	if (parts.length === 0) {
		if (req.method === "GET") return json(200, { pools: store.listPools() });
		if (req.method === "POST") {
			const body = await readObjectBody(req, POOL_CREATE_FIELDS);
			return json(201, {
				pool: store.createPool({
					name: requiredString(body, "name"),
					strategy: optionalStrategy(body.strategy),
				}),
			});
		}
	}
	const poolId = positiveId(parts[0] ?? "", "pool id");
	if (parts.length === 1) {
		if (req.method === "GET") {
			const pool = store.getPool(poolId);
			if (!pool) throw new ManagementHttpError(404, "not_found", "pool not found");
			return json(200, { pool });
		}
		if (req.method === "PATCH") {
			const body = await readObjectBody(req, POOL_PATCH_FIELDS);
			return json(200, {
				pool: store.updatePool(poolId, {
					name: optionalString(body, "name"),
					strategy: optionalStrategy(body.strategy),
				}),
			});
		}
		if (req.method === "DELETE") {
			if (!store.deletePool(poolId)) throw new ManagementHttpError(404, "not_found", "pool not found");
			return new Response(null, { status: 204 });
		}
	}
	if (parts[1] === "members") return await handlePoolMembers(req, parts.slice(2), store, storage, poolId);
	if (parts[1] === "users" && parts.length === 2 && req.method === "GET") {
		return json(200, { users: store.listPoolUsers(poolId) });
	}
	throw new ManagementHttpError(404, "not_found", "management route not found");
}

async function handlePoolMembers(
	req: Request,
	parts: string[],
	store: AuthGatewayAccessStore,
	storage: AuthStorage,
	poolId: number,
): Promise<Response> {
	if (parts.length === 0 && req.method === "POST") {
		const body = await readObjectBody(req, POOL_MEMBER_FIELDS);
		const credentialId = numericField(body, "credentialId");
		const pool = store.getPool(poolId);
		if (!pool) throw new ManagementHttpError(404, "not_found", "pool not found");
		requireLiveCredentialsForPool(storage, [credentialId]);
		const result = store.addPoolCredential(poolId, credentialId);
		return json(result.created ? 201 : 200, { pool: result.pool });
	}
	if (parts.length === 0 && req.method === "PATCH") {
		const body = await readObjectBody(req, POOL_MEMBER_ORDER_FIELDS);
		const pool = store.getPool(poolId);
		if (!pool) throw new ManagementHttpError(404, "not_found", "pool not found");
		const credentialIds = numericArrayField(body, "credentialIds");
		requireLiveCredentialsForPool(storage, credentialIds);
		return json(200, { pool: store.setPoolCredentialOrder(poolId, credentialIds) });
	}
	if (parts.length === 1 && req.method === "DELETE") {
		const credentialId = positiveId(parts[0] ?? "", "credential id");
		if (!store.removePoolCredential(poolId, credentialId))
			throw new ManagementHttpError(404, "not_found", "pool member not found");
		return new Response(null, { status: 204 });
	}
	throw new ManagementHttpError(404, "not_found", "management route not found");
}

function handleAudit(req: Request, store: AuthGatewayAccessStore): Response {
	if (req.method !== "GET") throw new ManagementHttpError(404, "not_found", "management route not found");
	const url = new URL(req.url);
	const userIdParam = url.searchParams.get("userId");
	const limitParam = url.searchParams.get("limit");
	const beforeParam = url.searchParams.get("before");
	const userId = userIdParam ? positiveId(userIdParam, "userId") : undefined;
	const limit = limitParam ? boundedLimit(limitParam) : undefined;
	const before = beforeParam ? positiveId(beforeParam, "before") : undefined;
	return json(200, store.listAudit({ userId, limit, before }));
}

function requireLiveCredentialsForPool(storage: AuthStorage, credentialIds: readonly number[]): void {
	const rows = storage.listStoredCredentialsByIds(credentialIds);
	const byId = new Map(rows.map(row => [row.id, row]));
	for (const credentialId of credentialIds) {
		if (!byId.has(credentialId)) {
			throw new ManagementHttpError(400, "invalid_request", "credential must be active");
		}
	}
}

async function readOptionalObjectBody(
	req: Request,
	allowedFields: Record<string, true>,
): Promise<Record<string, unknown>> {
	let raw: string;
	try {
		raw = await req.text();
	} catch {
		throw new ManagementHttpError(400, "invalid_request", "Malformed JSON body");
	}
	if (raw.length === 0) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new ManagementHttpError(400, "invalid_request", "Malformed JSON body");
	}
	return validateObjectBody(parsed, allowedFields);
}

async function readCredentialUploadBody(req: Request): Promise<{ provider: string; credential: AuthCredential }> {
	let parsed: unknown;
	try {
		parsed = await req.json();
	} catch {
		throw new ManagementHttpError(400, "invalid_request", "Invalid credential payload");
	}
	const result = credentialUploadRequestSchema(parsed);
	if (result instanceof type.errors) {
		throw new ManagementHttpError(400, "invalid_request", "Invalid credential payload");
	}
	return result;
}

async function readObjectBody(req: Request, allowedFields: Record<string, true>): Promise<Record<string, unknown>> {
	let parsed: unknown;
	try {
		parsed = await req.json();
	} catch {
		throw new ManagementHttpError(400, "invalid_request", "Malformed JSON body");
	}
	return validateObjectBody(parsed, allowedFields);
}

function validateObjectBody(parsed: unknown, allowedFields: Record<string, true>): Record<string, unknown> {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
		throw new ManagementHttpError(400, "invalid_request", "JSON body must be an object");
	const body = parsed as Record<string, unknown>;
	for (const key of Object.keys(body)) {
		if (!allowedFields[key]) throw new ManagementHttpError(400, "invalid_request", `Unknown field: ${key}`);
	}
	return body;
}

function aclRulesField(body: Record<string, unknown>): AuthGatewayAclRuleInput[] {
	const value = body.rules;
	if (!Array.isArray(value)) throw new ManagementHttpError(400, "invalid_request", "rules must be an array");
	if (value.length < 1 || value.length > 64) {
		throw new ManagementHttpError(400, "invalid_request", "ACL batch must contain 1 to 64 rules");
	}
	return aclRuleInputs(value);
}

function aclRuleInputs(values: readonly unknown[]): AuthGatewayAclRuleInput[] {
	const rules: AuthGatewayAclRuleInput[] = [];
	for (const value of values) {
		const body = validateObjectBody(value, ACL_CREATE_FIELDS);
		const effect = body.effect;
		const kind = body.kind;
		const pattern = requiredString(body, "pattern");
		if (effect !== "allow" && effect !== "deny") {
			throw new ManagementHttpError(400, "invalid_request", "ACL effect must be allow or deny");
		}
		if (kind !== "provider" && kind !== "model" && kind !== "route") {
			throw new ManagementHttpError(400, "invalid_request", "ACL kind must be provider, model, or route");
		}
		rules.push({ effect, kind, pattern });
	}
	return rules;
}

function requiredString(body: Record<string, unknown>, field: string): string {
	const value = body[field];
	if (typeof value !== "string" || value.trim().length === 0)
		throw new ManagementHttpError(400, "invalid_request", `${field} is required`);
	return value;
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
	const value = body[field];
	if (value === undefined) return undefined;
	if (typeof value !== "string") throw new ManagementHttpError(400, "invalid_request", `${field} must be a string`);
	return value;
}

function optionalNullableString(body: Record<string, unknown>, field: string): string | null | undefined {
	const value = body[field];
	if (value === undefined) return undefined;
	if (value === null) return null;
	if (typeof value !== "string")
		throw new ManagementHttpError(400, "invalid_request", `${field} must be a string or null`);
	return value;
}

function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
	const value = body[field];
	if (value === undefined) return undefined;
	if (typeof value !== "boolean") throw new ManagementHttpError(400, "invalid_request", `${field} must be boolean`);
	return value;
}

function optionalRole(value: unknown): AuthGatewayRole | undefined {
	if (value === undefined) return undefined;
	if (value === "user" || value === "admin") return value;
	throw new ManagementHttpError(400, "invalid_request", "role must be user or admin");
}

function optionalStrategy(value: unknown): AuthGatewayPoolStrategy | undefined {
	if (value === undefined) return undefined;
	if (typeof value === "string" && STRATEGIES[value as AuthGatewayPoolStrategy])
		return value as AuthGatewayPoolStrategy;
	throw new ManagementHttpError(400, "invalid_request", "invalid pool strategy");
}

function numericField(body: Record<string, unknown>, field: string): number {
	const value = body[field];
	if (!Number.isInteger(value) || typeof value !== "number" || value <= 0)
		throw new ManagementHttpError(400, "invalid_request", `${field} must be a positive integer`);
	return value;
}

function numericArrayField(body: Record<string, unknown>, field: string): number[] {
	const value = body[field];
	if (!Array.isArray(value)) throw new ManagementHttpError(400, "invalid_request", `${field} must be an array`);
	const ids: number[] = [];
	for (const item of value) {
		if (!Number.isSafeInteger(item) || typeof item !== "number" || item <= 0) {
			throw new ManagementHttpError(400, "invalid_request", `${field} must contain positive integers`);
		}
		ids.push(item);
	}
	return ids;
}

function positiveId(raw: string, label: string): number {
	if (!/^\d+$/.test(raw)) throw new ManagementHttpError(400, "invalid_request", `${label} must be a positive integer`);
	const id = Number(raw);
	if (!Number.isSafeInteger(id) || id <= 0)
		throw new ManagementHttpError(400, "invalid_request", `${label} must be a positive integer`);
	return id;
}

function boundedLimit(raw: string): number {
	const limit = positiveId(raw, "limit");
	if (limit > 1000) throw new ManagementHttpError(400, "invalid_request", "limit must be at most 1000");
	return limit;
}

function readSince(req: Request): number {
	const raw = new URL(req.url).searchParams.get("since");
	if (raw === null) return 0;
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0)
		throw new ManagementHttpError(400, "invalid_request", "since must be a non-negative millisecond timestamp");
	return value;
}

function tokenResponse(token: { id: number; value: string; label: string | null }): Record<string, unknown> {
	return { id: token.id, value: token.value, label: token.label };
}

function errorStatus(code: "invalid_request" | "not_found" | "conflict"): number {
	if (code === "invalid_request") return 400;
	if (code === "not_found") return 404;
	return 409;
}

function managementError(
	status: number,
	code: string,
	message: string,
	details?: AuthGatewayCredentialInUseDetails,
): Response {
	return json(status, { error: details ? { code, message, details } : { code, message } });
}

function credentialSummaryFromStored(row: StoredAuthCredential): AuthGatewayCredentialSummary {
	const identityKey = row.credential.type === "oauth" ? credentialIdentityKey(row.provider, row.credential) : null;
	return credentialSummaryFromCredential(row.id, row.provider, row.credential, identityKey);
}

function credentialSummaryFromSnapshot(entry: AuthCredentialSnapshotEntry): AuthGatewayCredentialSummary {
	return credentialSummaryFromCredential(entry.id, entry.provider, entry.credential, entry.identityKey);
}

function credentialSummaryFromCredential(
	id: number,
	provider: string,
	credential: AuthCredential | AuthCredentialSnapshotEntry["credential"],
	identityKey: string | null,
): AuthGatewayCredentialSummary {
	if (credential.type === "api_key") {
		return {
			id,
			provider,
			type: "api_key",
			identityKey: null,
			email: null,
			accountId: null,
			projectId: null,
			orgId: null,
			orgName: null,
			enterpriseUrl: null,
			apiEndpoint: null,
			expiresAt: null,
		};
	}
	return {
		id,
		provider,
		type: "oauth",
		identityKey,
		email: credential.email ?? null,
		accountId: credential.accountId ?? null,
		projectId: credential.projectId ?? null,
		orgId: credential.orgId ?? null,
		orgName: credential.orgName ?? null,
		enterpriseUrl: credential.enterpriseUrl ?? null,
		apiEndpoint: credential.apiEndpoint ?? null,
		expiresAt: credential.expires,
	};
}

function credentialIdentityKey(provider: string, credential: OAuthCredential): string | null {
	const accountId = credential.accountId?.trim();
	const email = credential.email?.trim().toLowerCase();
	const projectId = credential.projectId?.trim();
	const orgId = credential.orgId?.trim();
	if (provider === "anthropic") {
		const base = email
			? `email:${email}`
			: accountId
				? `account:${accountId}`
				: projectId
					? `project:${projectId}`
					: null;
		const org = orgId ? `org:${orgId}` : null;
		return base ? (org ? `${base}|${org}` : base) : org;
	}
	if (provider === "openai-codex" && email) return `email:${email}`;
	if (accountId) return `account:${accountId}`;
	if (email) return `email:${email}`;
	if (projectId) return `project:${projectId}`;
	return null;
}

class ManagementHttpError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
		readonly details?: AuthGatewayCredentialInUseDetails,
	) {
		super(message);
	}
}
