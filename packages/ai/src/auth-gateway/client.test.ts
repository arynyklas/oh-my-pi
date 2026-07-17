import { describe, expect, it } from "bun:test";
import type { Provider } from "../types";
import { AuthGatewayAdminClient } from "./client";

const openai = "openai" as Provider;
type FetchArgs = Parameters<typeof globalThis.fetch>;

describe("AuthGatewayAdminClient.listUsageReports", () => {
	it("fetches admin gateway usage reports from the global usage endpoint", async () => {
		let requestedUrl = "";
		let requestedAuthorization = "";
		const fetch = Object.assign(
			async (input: FetchArgs[0], init: FetchArgs[1]) => {
				requestedUrl = String(input);
				const headers = new Headers(init?.headers);
				requestedAuthorization = headers.get("authorization") ?? "";
				return Response.json({
					generatedAt: 123,
					reports: [
						{
							provider: openai,
							fetchedAt: 100,
							metadata: { accountId: "acct-1" },
							limits: [
								{
									id: "requests",
									label: "Requests",
									scope: { provider: openai, accountId: "acct-1" },
									amount: { used: 2, limit: 10, unit: "requests" },
								},
							],
						},
					],
				});
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		const client = new AuthGatewayAdminClient({ url: "http://127.0.0.1:4010", token: "secret", fetch });

		const reports = await client.listUsageReports();

		expect(new URL(requestedUrl).pathname).toBe("/v1/usage");
		expect(requestedAuthorization).toBe("Bearer secret");
		expect(reports).toEqual([
			{
				provider: openai,
				fetchedAt: 100,
				metadata: { accountId: "acct-1" },
				limits: [
					{
						id: "requests",
						label: "Requests",
						scope: { provider: openai, accountId: "acct-1" },
						amount: { used: 2, limit: 10, unit: "requests" },
					},
				],
			},
		]);
	});
});

describe("AuthGatewayAdminClient.redeemCredentialReset", () => {
	it("posts the credential id and preserves future reset outcome codes", async () => {
		let requestedUrl = "";
		let requestedMethod = "";
		const fetch = Object.assign(
			async (input: FetchArgs[0], init: FetchArgs[1]) => {
				requestedUrl = String(input);
				requestedMethod = init?.method ?? "";
				return Response.json({
					outcome: {
						ok: false,
						code: "future_reset_state",
						accountId: "acct-1",
						email: "person@example.com",
						creditId: "credit-1",
					},
				});
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		const client = new AuthGatewayAdminClient({ url: "http://127.0.0.1:4010", token: "secret", fetch });

		const outcome = await client.redeemCredentialReset(42);

		expect(new URL(requestedUrl).pathname).toBe("/v1/admin/credentials/42/reset");
		expect(requestedMethod).toBe("POST");
		expect(outcome).toEqual({
			ok: false,
			code: "future_reset_state",
			accountId: "acct-1",
			email: "person@example.com",
			creditId: "credit-1",
		});
	});
});
