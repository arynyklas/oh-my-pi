import { describe, expect, test, vi } from "bun:test";
import {
	AUTH_GATEWAY_TRANSPORT_ERROR,
	type AuthGatewayAclBatchResult,
	type AuthGatewayAclRule,
	AuthGatewayAdminClient,
	AuthGatewayAdminClientError,
	type AuthGatewayAdminClientOptions,
	type AuthGatewayAdminStatus,
	type AuthGatewayAuditEvent,
	type AuthGatewayCredentialSummary,
	type AuthGatewayModelSummary,
	type AuthGatewayPool,
	type AuthGatewayUser,
	type AuthGatewayUserPoolBinding,
} from "@oh-my-pi/pi-ai/auth-gateway";

type TestFetchHandler = (
	input: string | URL | Request,
	init?: RequestInit | BunFetchRequestInit,
) => Response | Promise<Response>;

function makeTestFetch(handler: TestFetchHandler): typeof fetch {
	const fetchImpl = ((input: string | URL | Request, init?: RequestInit | BunFetchRequestInit): Promise<Response> =>
		Promise.resolve(handler(input, init))) as typeof fetch;
	fetchImpl.preconnect = () => {};
	return fetchImpl;
}

interface RecordedRequest {
	method: string;
	path: string;
	authorization: string | null;
	accept: string | null;
	contentType: string | null;
	body: string;
}

interface RecordingServer {
	server: Bun.Server<unknown>;
	url: string;
	records: RecordedRequest[];
}

type ServerHandler = (req: Request, record: RecordedRequest) => Response | Promise<Response>;

async function recordRequest(req: Request): Promise<RecordedRequest> {
	const url = new URL(req.url);
	return {
		method: req.method,
		path: `${url.pathname}${url.search}`,
		authorization: req.headers.get("authorization"),
		accept: req.headers.get("accept"),
		contentType: req.headers.get("content-type"),
		body: await req.text(),
	};
}

function startRecordingServer(handler: ServerHandler): RecordingServer {
	const records: RecordedRequest[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const record = await recordRequest(req);
			records.push(record);
			return handler(req, record);
		},
	});
	return { server, url: `http://${server.hostname}:${server.port}`, records };
}

function jsonResponse(status: number, body: unknown): Response {
	return Response.json(body, { status });
}

function stallingTextResponse(status: number): {
	response: Response;
	rejectText(reason?: unknown): void;
	textStarted: Promise<void>;
} {
	const { promise, reject } = Promise.withResolvers<string>();
	const textStarted = Promise.withResolvers<void>();
	promise.catch(() => undefined);
	const response = new Response(null, { status });
	vi.spyOn(response, "text").mockImplementation(() => {
		textStarted.resolve();
		return promise;
	});
	return { response, rejectText: reject, textStarted: textStarted.promise };
}

const userFixture: AuthGatewayUser = {
	id: 7,
	name: "alice",
	description: "operator",
	owner: "team-a",
	role: "admin",
	enabled: true,
	createdAt: 1,
	updatedAt: 2,
	lastUsedAt: null,
};

const poolFixture: AuthGatewayPool = {
	id: 11,
	name: "primary",
	strategy: "round-robin",
	createdAt: 3,
	updatedAt: 4,
	members: [],
};

const userPoolBindingFixture: AuthGatewayUserPoolBinding = {
	poolId: 11,
	position: 0,
	createdAt: 5,
	pool: poolFixture,
};

const aclRuleFixture: AuthGatewayAclRule = {
	id: 29,
	userId: 7,
	effect: "allow",
	kind: "route",
	pattern: "chat",
	createdAt: 30,
};

const aclBatchResultFixture: AuthGatewayAclBatchResult = {
	rule: aclRuleFixture,
	created: true,
};

const modelSummaryFixture: AuthGatewayModelSummary = {
	id: "model-a",
	provider: "mock",
	api: "mock",
};

const credentialSummaryFixture: AuthGatewayCredentialSummary = {
	id: 13,
	provider: "mock",
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

const auditFixture: AuthGatewayAuditEvent = {
	id: 17,
	requestId: "req_1",
	startedAt: 5,
	completedAt: 6,
	userId: 7,
	userName: "alice",
	tokenId: 19,
	method: "GET",
	path: "/v1/models",
	routeFamily: "models",
	requestedModel: null,
	resolvedProvider: null,
	resolvedModel: null,
	credentialId: null,
	outcome: "success",
	statusCode: 200,
	inputTokens: 0,
	outputTokens: 0,
	cacheReadTokens: 0,
	cacheWriteTokens: 0,
	totalTokens: 0,
	costUsd: 0,
	errorCode: null,
};

const statusFixture: AuthGatewayAdminStatus = {
	ok: true,
	version: "dev-test",
	serverTime: 10,
	principal: {
		kind: "managed",
		userId: 7,
		name: "alice",
		role: "admin",
		tokenId: 19,
	},
	counts: {
		users: 1,
		activeTokens: 1,
		pools: 1,
		credentials: 1,
	},
};

describe("AuthGatewayAdminClient", () => {
	test("joins base paths, injects bearer auth, validates responses, handles 204s, serializes queries, and returns one-time token values", async () => {
		const server = startRecordingServer((_req, record) => {
			if (record.path === "/gateway/root/v1/admin/status") return jsonResponse(200, { status: statusFixture });
			if (record.path === "/gateway/root/v1/users" && record.method === "POST") {
				return jsonResponse(201, { user: userFixture, token: { id: 23, value: "omp_gw_secret", label: null } });
			}
			if (record.path === "/gateway/root/v1/users/7" && record.method === "DELETE")
				return new Response(null, { status: 204 });
			if (record.path === "/gateway/root/v1/audit?userId=7&limit=25&before=999") {
				return jsonResponse(200, { events: [auditFixture], nextBefore: null });
			}
			return jsonResponse(404, { error: { code: "not_found", message: record.path } });
		});
		try {
			const client = new AuthGatewayAdminClient({ url: `${server.url}/gateway/root/`, token: "admin-token" });
			expect(await client.status()).toEqual(statusFixture);
			expect(await client.createUser({ name: "alice", role: "admin" })).toEqual({
				user: userFixture,
				token: { id: 23, value: "omp_gw_secret", label: null },
			});
			expect(await client.deleteUser(7)).toBeUndefined();
			expect(await client.listAudit({ userId: 7, limit: 25, before: 999 })).toEqual({
				events: [auditFixture],
				nextBefore: null,
			});

			expect(server.records.map(record => record.path)).toEqual([
				"/gateway/root/v1/admin/status",
				"/gateway/root/v1/users",
				"/gateway/root/v1/users/7",
				"/gateway/root/v1/audit?userId=7&limit=25&before=999",
			]);
			for (const record of server.records) {
				expect(record.authorization).toBe("Bearer admin-token");
				expect(record.accept).toBe("application/json");
			}
			expect(JSON.parse(server.records[1]?.body ?? "{}")).toEqual({ name: "alice", role: "admin" });
		} finally {
			server.server.stop(true);
		}
	});

	test("rejects response envelopes that do not match the Task 2 ArkType schemas", async () => {
		const server = startRecordingServer(() =>
			jsonResponse(200, { users: [{ id: 1, name: "missing required fields" }] }),
		);
		try {
			const client = new AuthGatewayAdminClient({ url: server.url, token: "admin-token" });
			await expect(client.listUsers()).rejects.toMatchObject({ status: 200, code: "invalid_response" });
		} finally {
			server.server.stop(true);
		}
	});

	test("rejects malformed neutral pool and ordered binding response schemas", async () => {
		const server = startRecordingServer((_req, record) => {
			if (record.path === "/v1/pools") {
				return jsonResponse(200, { pools: [{ ...poolFixture, provider: "mock" }] });
			}
			if (record.path === "/v1/users/7") {
				return jsonResponse(200, {
					user: userFixture,
					tokens: [],
					acl: [],
					poolBindings: [{ ...userPoolBindingFixture, position: "0" }],
				});
			}
			if (record.path === "/v1/users/7/pools") {
				return jsonResponse(200, {
					bindings: [
						{
							...userPoolBindingFixture,
							pool: {
								...poolFixture,
								members: [{ credentialId: 13, position: "0", createdAt: 6 }],
							},
						},
					],
				});
			}
			return jsonResponse(404, { error: { code: "not_found", message: record.path } });
		});
		try {
			const client = new AuthGatewayAdminClient({ url: server.url, token: "admin-token" });
			await expect(client.listPools()).rejects.toMatchObject({ status: 200, code: "invalid_response" });
			await expect(client.getUser(7)).rejects.toMatchObject({ status: 200, code: "invalid_response" });
			await expect(client.setUserPoolOrder(7, [11])).rejects.toMatchObject({
				status: 200,
				code: "invalid_response",
			});
		} finally {
			server.server.stop(true);
		}
	});

	test("maps structured 401, 403, and 409 management errors without retaining raw bodies", async () => {
		const errors = [
			{ status: 401, body: { error: { code: "unauthorized", message: "Unauthorized" } } },
			{ status: 403, body: { error: { code: "forbidden", message: "Management routes require an admin token" } } },
			{
				status: 409,
				body: {
					error: {
						code: "credential_in_use",
						message: "Credential 13 is assigned to pool(s): primary",
						details: { credentialId: 13, pools: [{ id: 11, name: "primary" }] },
					},
				},
			},
		] as const;
		let index = 0;
		const server = startRecordingServer(() => {
			const next = errors[index];
			index += 1;
			if (!next) return jsonResponse(500, { error: { code: "too_many", message: "too many requests" } });
			return jsonResponse(next.status, next.body);
		});
		try {
			const client = new AuthGatewayAdminClient({ url: server.url, token: "admin-token" });
			await expect(client.status()).rejects.toMatchObject({
				status: 401,
				code: "unauthorized",
				message: "Unauthorized",
			});
			await expect(client.status()).rejects.toMatchObject({ status: 403, code: "forbidden" });
			try {
				await client.removeCredential(13);
				throw new Error("expected removeCredential to reject");
			} catch (error) {
				expect(error).toBeInstanceOf(AuthGatewayAdminClientError);
				expect(error).toMatchObject({ status: 409, code: "credential_in_use" });
				expect((error as AuthGatewayAdminClientError).details).toEqual({
					credentialId: 13,
					pools: [{ id: 11, name: "primary" }],
				});
				expect(Object.hasOwn(error as object, "body")).toBe(false);
			}
		} finally {
			server.server.stop(true);
		}
	});

	test("canonicalizes API-key uploads before strict credential schema validation", async () => {
		const server = startRecordingServer((_req, record) => {
			expect(record.path).toBe("/v1/admin/credentials");
			return jsonResponse(200, { credentials: [credentialSummaryFixture] });
		});
		try {
			const client = new AuthGatewayAdminClient({ url: server.url, token: "admin-token" });
			expect(await client.uploadCredential("mock", { type: "api_key", key: "secret-key", source: "login" })).toEqual(
				[credentialSummaryFixture],
			);
			expect(JSON.parse(server.records[0]?.body ?? "{}")).toEqual({
				provider: "mock",
				credential: { type: "api_key", key: "secret-key" },
			});
			expect(server.records[0]?.body).not.toContain("source");
		} finally {
			server.server.stop(true);
		}
	});

	test("combines timeout and caller abort handling", async () => {
		vi.useFakeTimers();
		try {
			const hangingFetch = makeTestFetch((_input, init) => {
				const { promise, reject } = Promise.withResolvers<Response>();
				const signal = init?.signal;
				if (signal?.aborted) {
					reject(signal.reason);
					return promise;
				}
				signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
				return promise;
			});
			const client = new AuthGatewayAdminClient({
				url: "http://127.0.0.1:1",
				token: "admin-token",
				timeoutMs: 20,
				fetch: hangingFetch,
			});
			const timedOut = client.status();
			vi.advanceTimersByTime(20);
			await expect(timedOut).rejects.toMatchObject({
				status: 0,
				code: "timeout",
				message: "Auth-gateway request timed out",
			});

			const reason = new Error("caller stopped");
			const controller = new AbortController();
			controller.abort(reason);
			await expect(client.status(controller.signal)).rejects.toBe(reason);
		} finally {
			vi.useRealTimers();
		}
	});

	test("applies the request timeout while reading a successful JSON response body", async () => {
		vi.useFakeTimers();
		const stalled = stallingTextResponse(200);
		try {
			const client = new AuthGatewayAdminClient({
				url: "http://127.0.0.1:1",
				token: "admin-token",
				timeoutMs: 20,
				fetch: makeTestFetch((_input, init) => {
					const signal = init?.signal;
					if (signal?.aborted) stalled.rejectText(signal.reason);
					else signal?.addEventListener("abort", () => stalled.rejectText(signal.reason), { once: true });
					return stalled.response;
				}),
			});
			const request = client.status();
			await stalled.textStarted;
			vi.advanceTimersByTime(25);
			await expect(request).rejects.toMatchObject({
				status: 0,
				code: "timeout",
				message: "Auth-gateway request timed out",
			});
		} finally {
			stalled.rejectText(new Error("cleanup stalled success body"));
			vi.useRealTimers();
		}
	});

	test("applies timeout and preserves caller abort while reading non-2xx management-error bodies", async () => {
		vi.useFakeTimers();
		const timedOutBody = stallingTextResponse(403);
		const abortedBody = stallingTextResponse(403);
		try {
			const timeoutClient = new AuthGatewayAdminClient({
				url: "http://127.0.0.1:1",
				token: "admin-token",
				timeoutMs: 20,
				fetch: makeTestFetch((_input, init) => {
					const signal = init?.signal;
					if (signal?.aborted) timedOutBody.rejectText(signal.reason);
					else signal?.addEventListener("abort", () => timedOutBody.rejectText(signal.reason), { once: true });
					return timedOutBody.response;
				}),
			});
			const timedOut = timeoutClient.status();
			await timedOutBody.textStarted;
			vi.advanceTimersByTime(25);
			await expect(timedOut).rejects.toMatchObject({
				status: 0,
				code: "timeout",
				message: "Auth-gateway request timed out",
			});

			const reason = new Error("caller stopped during error parsing");
			const controller = new AbortController();
			const abortClient = new AuthGatewayAdminClient({
				url: "http://127.0.0.1:1",
				token: "admin-token",
				timeoutMs: 10_000,
				fetch: makeTestFetch((_input, init) => {
					const signal = init?.signal;
					if (signal?.aborted) abortedBody.rejectText(signal.reason);
					else signal?.addEventListener("abort", () => abortedBody.rejectText(signal.reason), { once: true });
					return abortedBody.response;
				}),
			});
			const aborted = abortClient.status(controller.signal);
			await abortedBody.textStarted;
			controller.abort(reason);
			await expect(aborted).rejects.toBe(reason);
		} finally {
			timedOutBody.rejectText(new Error("cleanup stalled error body"));
			abortedBody.rejectText(new Error("cleanup stalled aborted body"));
			vi.useRealTimers();
		}
	});

	test("rejects non-loopback HTTP before reading the token or credential and before fetch", () => {
		let tokenReads = 0;
		let fetchCalls = 0;
		const options = {
			url: "http://gateway.example.com",
			get token() {
				tokenReads += 1;
				return "admin-token";
			},
			fetch: makeTestFetch(() => {
				fetchCalls += 1;
				return jsonResponse(200, { status: statusFixture });
			}),
		} satisfies AuthGatewayAdminClientOptions;

		expect(() => new AuthGatewayAdminClient(options)).toThrow(AUTH_GATEWAY_TRANSPORT_ERROR);
		expect(tokenReads).toBe(0);
		expect(fetchCalls).toBe(0);
	});

	test("sets redirect:error so 301, 302, 307, and 308 never leak authorization or bodies to a second hop", async () => {
		const secondHop = startRecordingServer(() => jsonResponse(200, { credentials: [credentialSummaryFixture] }));
		try {
			for (const status of [301, 302, 307, 308] as const) {
				const firstHop = startRecordingServer(
					() => new Response(null, { status, headers: { Location: `${secondHop.url}/captured` } }),
				);
				try {
					const client = new AuthGatewayAdminClient({ url: firstHop.url, token: `admin-token-${status}` });
					await expect(
						client.uploadCredential("mock", { type: "api_key", key: `secret-${status}` }),
					).rejects.toMatchObject({
						status: 0,
						code: "network_error",
					});
				} finally {
					firstHop.server.stop(true);
				}
			}
			expect(secondHop.records).toEqual([]);
		} finally {
			secondHop.server.stop(true);
		}
	});

	test("covers model, ACL batch, pool binding, and credential response envelopes used by the remote console", async () => {
		const server = startRecordingServer((_req, record) => {
			if (record.path === "/v1/users/7/pools" && record.method === "PATCH") {
				return jsonResponse(200, { bindings: [userPoolBindingFixture] });
			}
			if (record.path === "/v1/users/7/acl/batch" && record.method === "POST") {
				return jsonResponse(201, { results: [aclBatchResultFixture] });
			}
			if (record.path === "/v1/models") {
				return jsonResponse(200, {
					object: "list",
					data: [{ id: "model-a", object: "model", owned_by: "mock", api: "mock" }],
				});
			}
			if (record.path === "/v1/pools/11/members" && record.method === "PATCH")
				return jsonResponse(200, { pool: poolFixture });
			if (record.path === "/v1/pools/11/users") return jsonResponse(200, { users: [userFixture] });
			if (record.path === "/v1/admin/credentials/13/refresh") {
				return jsonResponse(200, { credential: credentialSummaryFixture });
			}
			return jsonResponse(404, { error: { code: "not_found", message: record.path } });
		});
		try {
			const client = new AuthGatewayAdminClient({ url: server.url, token: "admin-token" });
			expect(await client.setUserPoolOrder(7, [11])).toEqual([userPoolBindingFixture]);
			expect(
				await client.addAclRules(7, {
					rules: [{ effect: "allow", kind: "route", pattern: "chat" }],
				}),
			).toEqual([aclBatchResultFixture]);
			expect(await client.listModels()).toEqual([modelSummaryFixture]);
			expect(await client.setPoolCredentialOrder(11, [13])).toEqual(poolFixture);
			expect(await client.listPoolUsers(11)).toEqual([userFixture]);
			expect(await client.refreshCredential(13)).toEqual(credentialSummaryFixture);
			expect(JSON.parse(server.records[0]?.body ?? "{}")).toEqual({ poolIds: [11] });
			expect(JSON.parse(server.records[1]?.body ?? "{}")).toEqual({
				rules: [{ effect: "allow", kind: "route", pattern: "chat" }],
			});
			expect(JSON.parse(server.records[3]?.body ?? "{}")).toEqual({ credentialIds: [13] });
		} finally {
			server.server.stop(true);
		}
	});
});
