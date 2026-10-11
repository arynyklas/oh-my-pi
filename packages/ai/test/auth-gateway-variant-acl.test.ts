import { afterEach, describe, expect, test } from "bun:test";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import {
	closeGatewayHarness,
	createGatewayHarness,
	type GatewayHarness,
	grantModelAccess,
	postChat,
	postPiNative,
} from "./auth-gateway-integration-helpers";

describe("auth-gateway model ACLs on routing variants", () => {
	let harness: GatewayHarness | undefined;

	afterEach(async () => {
		await closeGatewayHarness(harness);
		harness = undefined;
	});

	test("a deny rule on a model also denies the routing variants cloned from it", async () => {
		// A variant (`<id>:nitro` on OpenRouter) is served under its own id, so an
		// exact deny on the base id would not match it without base attribution.
		const variant = createMockModel({
			provider: "mock",
			id: "model-a:nitro",
			handler: () => ({ content: ["fast"] }),
		});
		harness = await createGatewayHarness({ variants: [{ model: variant, base: "mock/model-a" }] });
		const [row] = harness.credentialStore.listAuthCredentials("mock");
		if (!row) throw new Error("expected credential row");
		const pool = harness.accessStore.createPool({ name: "variantpool" });
		harness.accessStore.addPoolCredential(pool.id, row.id);
		const user = harness.accessStore.createUser({ name: "variantuser" });
		// Provider-wide allow: only the model deny rule can stand between the user and the variant.
		await grantModelAccess(harness.accessStore, user.user.id, pool.id);

		expect((await postChat(harness.handle.url, user.token.value, "model-a:nitro")).status).toBe(200);

		harness.accessStore.addAclRule(user.user.id, { effect: "deny", kind: "model", pattern: "mock/model-a" });

		expect((await postChat(harness.handle.url, user.token.value, "model-a:nitro")).status).toBe(403);
		expect((await postPiNative(harness.handle.url, user.token.value, "model-a:nitro")).status).toBe(403);
		expect((await postChat(harness.handle.url, user.token.value, "model-a")).status).toBe(403);
	});
});
