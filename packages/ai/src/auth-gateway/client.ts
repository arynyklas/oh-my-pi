import { type } from "arktype";
import { credentialUploadRequestSchema } from "../auth-broker/wire-schemas";
import type { AuthCredential, ResetCreditRedeemOutcome } from "../auth-storage";
import type { Api } from "../types";
import type { UsageReport } from "../usage";
import type {
	AuthGatewayAclBatchResult,
	AuthGatewayAclRule,
	AuthGatewayPool,
	AuthGatewayUsageSummary,
	AuthGatewayUser,
	AuthGatewayUserPoolBinding,
} from "./access-control";
import { normalizeAuthGatewayAdminUrl } from "./admin-url";
import {
	authGatewayAclBatchResponseSchema,
	authGatewayAclRuleResponseSchema,
	authGatewayAdminStatusResponseSchema,
	authGatewayAuditPageResponseSchema,
	authGatewayCredentialResetResponseSchema,
	authGatewayCredentialResponseSchema,
	authGatewayCredentialsResponseSchema,
	authGatewayIssuedTokenValueSchema,
	authGatewayManagementErrorResponseSchema,
	authGatewayPoolBindResponseSchema,
	authGatewayPoolResponseSchema,
	authGatewayPoolsResponseSchema,
	authGatewayPoolUsersResponseSchema,
	authGatewayTokenResponseSchema,
	authGatewayUsageReportsResponseSchema,
	authGatewayUsageResponseSchema,
	authGatewayUserDetailsResponseSchema,
	authGatewayUserPoolsResponseSchema,
	authGatewayUserResponseSchema,
	authGatewayUserSchema,
	authGatewayUsersResponseSchema,
} from "./management-schemas";
import type {
	AddAclRuleInput,
	AddAclRulesInput,
	AuthGatewayAclBatchResponse,
	AuthGatewayAdminStatus,
	AuthGatewayAdminStatusResponse,
	AuthGatewayAuditPage,
	AuthGatewayCredentialInUseDetails,
	AuthGatewayCredentialResetResponse,
	AuthGatewayCredentialResponse,
	AuthGatewayCredentialSummary,
	AuthGatewayCredentialsResponse,
	AuthGatewayCredentialUploadRequest,
	AuthGatewayIssuedTokenValue,
	AuthGatewayModelSummary,
	AuthGatewayPoolBindResponse,
	AuthGatewayPoolResponse,
	AuthGatewayPoolsResponse,
	AuthGatewayPoolUsersResponse,
	AuthGatewayTokenResponse,
	AuthGatewayUsageReportsResponse,
	AuthGatewayUsageResponse,
	AuthGatewayUserDetails,
	AuthGatewayUserDetailsResponse,
	AuthGatewayUserPoolsResponse,
	AuthGatewayUserResponse,
	AuthGatewayUsersResponse,
	CreatePoolInput,
	CreateUserInput,
	UpdatePoolInput,
	UpdateUserInput,
} from "./management-types";

const DEFAULT_TIMEOUT_MS = 10_000;

type AuthGatewayAdminRequestMethod = "GET" | "POST" | "PATCH" | "DELETE";
type AuthGatewayAdminSchema = (input: unknown) => unknown;

interface AuthGatewayAdminRequestContext {
	response: Response;
	signal: AbortSignal;
	timeoutSignal: AbortSignal;
	callerSignal: AbortSignal | undefined;
	timeoutHandle: NodeJS.Timeout;
	timeoutPromise: Promise<never>;
}

interface AuthGatewayModelListWireResponse {
	object: "list";
	data: Array<{
		id: string;
		object: "model";
		owned_by: string;
		api: Api;
	}>;
}

const authGatewayModelListWireResponseSchema = type({
	"+": "reject",
	object: "'list'",
	data: type({
		"+": "reject",
		id: "string",
		object: "'model'",
		owned_by: "string",
		api: "string",
	}).array(),
});
const authGatewayCreateUserResponseSchema = type({
	"+": "reject",
	user: authGatewayUserSchema,
	token: authGatewayIssuedTokenValueSchema,
});

export interface AuthGatewayAdminClientOptions {
	url: string;
	token: string;
	timeoutMs?: number;
	fetch?: typeof globalThis.fetch;
}

export class AuthGatewayAdminClientError extends Error {
	readonly status: number;
	readonly code: string;
	readonly details?: AuthGatewayCredentialInUseDetails;

	constructor(status: number, code: string, message: string, details?: AuthGatewayCredentialInUseDetails) {
		super(message);
		this.name = "AuthGatewayAdminClientError";
		this.status = status;
		this.code = code;
		this.details = details;
	}
}

function appendQuery(path: string, entries: Array<readonly [string, number | undefined]>): string {
	const query = new URLSearchParams();
	for (const [key, value] of entries) {
		if (value !== undefined) query.set(key, String(value));
	}
	const serialized = query.toString();
	return serialized ? `${path}?${serialized}` : path;
}

function canonicalizeCredential(credential: AuthCredential): AuthCredential {
	if (credential.type === "api_key") return { type: "api_key", key: credential.key };
	return credential;
}

export class AuthGatewayAdminClient {
	readonly #baseUrl: string;
	readonly #token: string;
	readonly #timeoutMs: number;
	readonly #fetch: typeof globalThis.fetch;

	constructor(options: AuthGatewayAdminClientOptions) {
		this.#baseUrl = normalizeAuthGatewayAdminUrl(options.url);
		this.#token = options.token;
		this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
		this.#fetch = options.fetch ?? globalThis.fetch;
	}

	async status(signal?: AbortSignal): Promise<AuthGatewayAdminStatus> {
		return (
			await this.#requestJson<AuthGatewayAdminStatusResponse>(
				"GET",
				"/v1/admin/status",
				authGatewayAdminStatusResponseSchema,
				{ signal },
			)
		).status;
	}

	async listUsers(signal?: AbortSignal): Promise<AuthGatewayUser[]> {
		return (
			await this.#requestJson<AuthGatewayUsersResponse>("GET", "/v1/users", authGatewayUsersResponseSchema, {
				signal,
			})
		).users;
	}

	async createUser(
		input: CreateUserInput,
		signal?: AbortSignal,
	): Promise<{ user: AuthGatewayUser; token: AuthGatewayIssuedTokenValue }> {
		return await this.#requestJson<AuthGatewayUserResponse & AuthGatewayTokenResponse>(
			"POST",
			"/v1/users",
			authGatewayCreateUserResponseSchema,
			{ body: input, signal },
		);
	}

	async getUser(userId: number, signal?: AbortSignal): Promise<AuthGatewayUserDetails> {
		return await this.#requestJson<AuthGatewayUserDetailsResponse>(
			"GET",
			`/v1/users/${userId}`,
			authGatewayUserDetailsResponseSchema,
			{ signal },
		);
	}

	async updateUser(userId: number, input: UpdateUserInput, signal?: AbortSignal): Promise<AuthGatewayUser> {
		return (
			await this.#requestJson<AuthGatewayUserResponse>(
				"PATCH",
				`/v1/users/${userId}`,
				authGatewayUserResponseSchema,
				{
					body: input,
					signal,
				},
			)
		).user;
	}

	async deleteUser(userId: number, signal?: AbortSignal): Promise<void> {
		await this.#requestVoid("DELETE", `/v1/users/${userId}`, signal);
	}

	async addUserToken(userId: number, label?: string, signal?: AbortSignal): Promise<AuthGatewayIssuedTokenValue> {
		return (
			await this.#requestJson<AuthGatewayTokenResponse>(
				"POST",
				`/v1/users/${userId}/tokens`,
				authGatewayTokenResponseSchema,
				{ body: label === undefined ? {} : { label }, signal },
			)
		).token;
	}

	async rotateUserTokens(userId: number, label?: string, signal?: AbortSignal): Promise<AuthGatewayIssuedTokenValue> {
		return (
			await this.#requestJson<AuthGatewayTokenResponse>(
				"POST",
				`/v1/users/${userId}/tokens/rotate`,
				authGatewayTokenResponseSchema,
				{ body: label === undefined ? {} : { label }, signal },
			)
		).token;
	}

	async revokeUserToken(userId: number, tokenId: number, signal?: AbortSignal): Promise<void> {
		await this.#requestVoid("DELETE", `/v1/users/${userId}/tokens/${tokenId}`, signal);
	}

	async addAclRule(userId: number, input: AddAclRuleInput, signal?: AbortSignal): Promise<AuthGatewayAclRule> {
		return (
			await this.#requestJson<{ rule: AuthGatewayAclRule }>(
				"POST",
				`/v1/users/${userId}/acl`,
				authGatewayAclRuleResponseSchema,
				{ body: input, signal },
			)
		).rule;
	}

	async addAclRules(
		userId: number,
		input: AddAclRulesInput,
		signal?: AbortSignal,
	): Promise<AuthGatewayAclBatchResult[]> {
		return (
			await this.#requestJson<AuthGatewayAclBatchResponse>(
				"POST",
				`/v1/users/${userId}/acl/batch`,
				authGatewayAclBatchResponseSchema,
				{ body: input, signal },
			)
		).results;
	}

	async deleteAclRule(userId: number, ruleId: number, signal?: AbortSignal): Promise<void> {
		await this.#requestVoid("DELETE", `/v1/users/${userId}/acl/${ruleId}`, signal);
	}

	async bindUserPool(userId: number, poolId: number, signal?: AbortSignal): Promise<boolean> {
		return (
			await this.#requestJson<AuthGatewayPoolBindResponse>(
				"POST",
				`/v1/users/${userId}/pools`,
				authGatewayPoolBindResponseSchema,
				{ body: { poolId }, signal },
			)
		).created;
	}

	async unbindUserPool(userId: number, poolId: number, signal?: AbortSignal): Promise<void> {
		await this.#requestVoid("DELETE", `/v1/users/${userId}/pools/${poolId}`, signal);
	}

	async setUserPoolOrder(
		userId: number,
		poolIds: readonly number[],
		signal?: AbortSignal,
	): Promise<AuthGatewayUserPoolBinding[]> {
		return (
			await this.#requestJson<AuthGatewayUserPoolsResponse>(
				"PATCH",
				`/v1/users/${userId}/pools`,
				authGatewayUserPoolsResponseSchema,
				{ body: { poolIds: [...poolIds] }, signal },
			)
		).bindings;
	}

	async getUserUsage(userId: number, since?: number, signal?: AbortSignal): Promise<AuthGatewayUsageSummary> {
		return (
			await this.#requestJson<AuthGatewayUsageResponse>(
				"GET",
				appendQuery(`/v1/users/${userId}/usage`, [["since", since]]),
				authGatewayUsageResponseSchema,
				{ signal },
			)
		).usage;
	}

	async listUsageReports(signal?: AbortSignal): Promise<UsageReport[]> {
		return (
			await this.#requestJson<AuthGatewayUsageReportsResponse>(
				"GET",
				"/v1/usage",
				authGatewayUsageReportsResponseSchema,
				{ signal },
			)
		).reports;
	}

	async listPools(signal?: AbortSignal): Promise<AuthGatewayPool[]> {
		return (
			await this.#requestJson<AuthGatewayPoolsResponse>("GET", "/v1/pools", authGatewayPoolsResponseSchema, {
				signal,
			})
		).pools;
	}

	async createPool(input: CreatePoolInput, signal?: AbortSignal): Promise<AuthGatewayPool> {
		return (
			await this.#requestJson<AuthGatewayPoolResponse>("POST", "/v1/pools", authGatewayPoolResponseSchema, {
				body: input,
				signal,
			})
		).pool;
	}

	async getPool(poolId: number, signal?: AbortSignal): Promise<AuthGatewayPool> {
		return (
			await this.#requestJson<AuthGatewayPoolResponse>("GET", `/v1/pools/${poolId}`, authGatewayPoolResponseSchema, {
				signal,
			})
		).pool;
	}

	async updatePool(poolId: number, input: UpdatePoolInput, signal?: AbortSignal): Promise<AuthGatewayPool> {
		return (
			await this.#requestJson<AuthGatewayPoolResponse>(
				"PATCH",
				`/v1/pools/${poolId}`,
				authGatewayPoolResponseSchema,
				{
					body: input,
					signal,
				},
			)
		).pool;
	}

	async deletePool(poolId: number, signal?: AbortSignal): Promise<void> {
		await this.#requestVoid("DELETE", `/v1/pools/${poolId}`, signal);
	}

	async addPoolCredential(poolId: number, credentialId: number, signal?: AbortSignal): Promise<AuthGatewayPool> {
		return (
			await this.#requestJson<AuthGatewayPoolResponse>(
				"POST",
				`/v1/pools/${poolId}/members`,
				authGatewayPoolResponseSchema,
				{ body: { credentialId }, signal },
			)
		).pool;
	}

	async removePoolCredential(poolId: number, credentialId: number, signal?: AbortSignal): Promise<void> {
		await this.#requestVoid("DELETE", `/v1/pools/${poolId}/members/${credentialId}`, signal);
	}

	async setPoolCredentialOrder(
		poolId: number,
		credentialIds: readonly number[],
		signal?: AbortSignal,
	): Promise<AuthGatewayPool> {
		return (
			await this.#requestJson<AuthGatewayPoolResponse>(
				"PATCH",
				`/v1/pools/${poolId}/members`,
				authGatewayPoolResponseSchema,
				{ body: { credentialIds: [...credentialIds] }, signal },
			)
		).pool;
	}

	async listPoolUsers(poolId: number, signal?: AbortSignal): Promise<AuthGatewayUser[]> {
		return (
			await this.#requestJson<AuthGatewayPoolUsersResponse>(
				"GET",
				`/v1/pools/${poolId}/users`,
				authGatewayPoolUsersResponseSchema,
				{ signal },
			)
		).users;
	}

	async listModels(signal?: AbortSignal): Promise<AuthGatewayModelSummary[]> {
		const response = await this.#requestJson<AuthGatewayModelListWireResponse>(
			"GET",
			"/v1/models",
			authGatewayModelListWireResponseSchema,
			{ signal },
		);
		return response.data.map(model => ({
			id: model.id,
			provider: model.owned_by,
			api: model.api,
		}));
	}
	async listCredentials(signal?: AbortSignal): Promise<AuthGatewayCredentialSummary[]> {
		return (
			await this.#requestJson<AuthGatewayCredentialsResponse>(
				"GET",
				"/v1/admin/credentials",
				authGatewayCredentialsResponseSchema,
				{ signal },
			)
		).credentials;
	}

	async uploadCredential(
		provider: string,
		credential: AuthCredential,
		signal?: AbortSignal,
	): Promise<AuthGatewayCredentialSummary[]> {
		const body = { provider, credential: canonicalizeCredential(credential) };
		const validated = credentialUploadRequestSchema(body);
		if (validated instanceof type.errors) {
			throw new AuthGatewayAdminClientError(0, "invalid_request", "Invalid credential payload");
		}
		return (
			await this.#requestJson<AuthGatewayCredentialsResponse>(
				"POST",
				"/v1/admin/credentials",
				authGatewayCredentialsResponseSchema,
				{ body: validated as AuthGatewayCredentialUploadRequest, signal },
			)
		).credentials;
	}

	async refreshCredential(credentialId: number, signal?: AbortSignal): Promise<AuthGatewayCredentialSummary> {
		return (
			await this.#requestJson<AuthGatewayCredentialResponse>(
				"POST",
				`/v1/admin/credentials/${credentialId}/refresh`,
				authGatewayCredentialResponseSchema,
				{ signal },
			)
		).credential;
	}

	async redeemCredentialReset(credentialId: number, signal?: AbortSignal): Promise<ResetCreditRedeemOutcome> {
		return (
			await this.#requestJson<AuthGatewayCredentialResetResponse>(
				"POST",
				`/v1/admin/credentials/${credentialId}/reset`,
				authGatewayCredentialResetResponseSchema,
				{ signal },
			)
		).outcome;
	}

	async removeCredential(credentialId: number, signal?: AbortSignal): Promise<void> {
		await this.#requestVoid("DELETE", `/v1/admin/credentials/${credentialId}`, signal);
	}

	async listAudit(
		query: { userId?: number; limit?: number; before?: number } = {},
		signal?: AbortSignal,
	): Promise<AuthGatewayAuditPage> {
		return await this.#requestJson<AuthGatewayAuditPage>(
			"GET",
			appendQuery("/v1/audit", [
				["userId", query.userId],
				["limit", query.limit],
				["before", query.before],
			]),
			authGatewayAuditPageResponseSchema,
			{ signal },
		);
	}

	async #requestJson<t>(
		method: AuthGatewayAdminRequestMethod,
		path: string,
		schema: AuthGatewayAdminSchema,
		options: { body?: unknown; signal?: AbortSignal } = {},
	): Promise<t> {
		const request = await this.#fetchResponse(method, path, options);
		try {
			const { response } = request;
			if (!response.ok) await this.#throwManagementError(request);
			if (response.status === 204) {
				throw new AuthGatewayAdminClientError(204, "invalid_response", "Invalid auth-gateway response");
			}
			const parsed = await this.#readJson(request);
			const validated = schema(parsed);
			if (validated instanceof type.errors) {
				throw new AuthGatewayAdminClientError(response.status, "invalid_response", "Invalid auth-gateway response");
			}
			return validated as t;
		} finally {
			clearTimeout(request.timeoutHandle);
		}
	}

	async #requestVoid(method: AuthGatewayAdminRequestMethod, path: string, signal?: AbortSignal): Promise<void> {
		const request = await this.#fetchResponse(method, path, { signal });
		try {
			const { response } = request;
			if (!response.ok) await this.#throwManagementError(request);
			if (response.status !== 204) {
				throw new AuthGatewayAdminClientError(response.status, "invalid_response", "Invalid auth-gateway response");
			}
		} finally {
			clearTimeout(request.timeoutHandle);
		}
	}

	async #fetchResponse(
		method: AuthGatewayAdminRequestMethod,
		path: string,
		options: { body?: unknown; signal?: AbortSignal },
	): Promise<AuthGatewayAdminRequestContext> {
		if (options.signal?.aborted) throw options.signal.reason;
		const timeoutController = new AbortController();
		const timeout = Promise.withResolvers<never>();
		timeout.promise.catch(() => undefined);
		const timeoutHandle = setTimeout(() => {
			timeoutController.abort();
			timeout.reject(new AuthGatewayAdminClientError(0, "timeout", "Auth-gateway request timed out"));
		}, this.#timeoutMs);
		const timeoutSignal = timeoutController.signal;
		const signal = options.signal ? AbortSignal.any([options.signal, timeoutSignal]) : timeoutSignal;
		const headers: Record<string, string> = {
			Accept: "application/json",
			Authorization: `Bearer ${this.#token}`,
		};
		let body: string | undefined;
		if (options.body !== undefined) {
			body = JSON.stringify(options.body);
			headers["Content-Type"] = "application/json";
		}
		try {
			const response = await this.#fetch(`${this.#baseUrl}${path}`, {
				method,
				headers,
				body,
				signal,
				redirect: "error",
			});
			return {
				response,
				signal,
				timeoutSignal,
				callerSignal: options.signal,
				timeoutHandle,
				timeoutPromise: timeout.promise,
			};
		} catch {
			clearTimeout(timeoutHandle);
			this.#throwRequestAbortOrTimeout(options.signal, timeoutSignal);
			throw new AuthGatewayAdminClientError(0, "network_error", "Auth-gateway request failed");
		}
	}

	async #throwManagementError(request: AuthGatewayAdminRequestContext): Promise<never> {
		const parsed = await this.#readJson(request);
		const validated = authGatewayManagementErrorResponseSchema(parsed);
		if (validated instanceof type.errors) {
			throw new AuthGatewayAdminClientError(
				request.response.status,
				"invalid_response",
				"Invalid auth-gateway response",
			);
		}
		const body = validated as {
			error: { code: string; message: string; details?: AuthGatewayCredentialInUseDetails };
		};
		throw new AuthGatewayAdminClientError(
			request.response.status,
			body.error.code,
			body.error.message,
			body.error.details,
		);
	}

	async #readJson(request: AuthGatewayAdminRequestContext): Promise<unknown> {
		const abort = Promise.withResolvers<string>();
		const onCallerAbort = () => abort.reject(request.callerSignal?.reason);
		if (request.callerSignal?.aborted) onCallerAbort();
		else request.callerSignal?.addEventListener("abort", onCallerAbort, { once: true });
		let text: string;
		try {
			text = await Promise.race([request.response.text(), abort.promise, request.timeoutPromise]);
		} catch {
			this.#throwRequestAbortOrTimeout(request.callerSignal, request.timeoutSignal);
			throw new AuthGatewayAdminClientError(
				request.response.status,
				"invalid_response",
				"Invalid auth-gateway response",
			);
		} finally {
			request.callerSignal?.removeEventListener("abort", onCallerAbort);
		}
		this.#throwRequestAbortOrTimeout(request.callerSignal, request.timeoutSignal);
		try {
			return JSON.parse(text);
		} catch {
			throw new AuthGatewayAdminClientError(
				request.response.status,
				"invalid_response",
				"Invalid auth-gateway response",
			);
		}
	}

	#throwRequestAbortOrTimeout(callerSignal: AbortSignal | undefined, timeoutSignal: AbortSignal): void {
		if (callerSignal?.aborted) throw callerSignal.reason;
		if (timeoutSignal.aborted) {
			throw new AuthGatewayAdminClientError(0, "timeout", "Auth-gateway request timed out");
		}
	}
}
