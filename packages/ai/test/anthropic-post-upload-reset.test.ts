import { describe, expect, it, vi } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { AnthropicMessagesClient } from "@oh-my-pi/pi-ai/providers/anthropic-client";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const model: Model<"anthropic-messages"> = buildModel({
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const context: Context = { messages: [{ role: "user", content: "Say hi", timestamp: Date.now() }] };

/** The loss a transport reports when the peer closed after taking the whole body. */
function postUploadLoss(): Error {
	return new AIError.ConnectionLostBeforeResponseError(Object.assign(new Error("reset"), { code: "ECONNRESET" }), {
		bodyBytes: 1_100_000,
		bodySent: true,
		elapsedMs: 15_200,
	});
}

function sse(text: string): Response {
	const events = [
		{ type: "message_start", message: { id: "msg_1", usage: { input_tokens: 3, output_tokens: 0 } } },
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	];
	return new Response(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
		status: 200,
		headers: { "content-type": "text/event-stream", "request-id": "req_1" },
	});
}

function run(fetch: FetchImpl) {
	const providerRetryWait = vi.fn(async () => {});
	const client = new AnthropicMessagesClient({ apiKey: "sk-test", maxRetries: 0, fetch });
	return { providerRetryWait, result: streamAnthropic(model, context, { client, providerRetryWait }).result() };
}

describe("anthropic provider retries after a post-upload connection loss", () => {
	it("stops after the same loss twice instead of spending the whole retry budget", async () => {
		let calls = 0;
		const { result } = run(async () => {
			calls++;
			throw postUploadLoss();
		});
		const message = await result;
		expect(calls).toBe(2);
		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("request body was written to the socket");
		expect(message.errorMessage).toMatch(/\[2 attempts over [^\]]+\]$/);
	});

	it("still recovers from a single loss", async () => {
		let calls = 0;
		const { result, providerRetryWait } = run(async () => {
			calls++;
			if (calls === 1) throw postUploadLoss();
			return sse("ok");
		});
		const message = await result;
		expect(calls).toBe(2);
		expect(providerRetryWait).toHaveBeenCalledTimes(1);
		expect(message.stopReason).toBe("stop");
		expect(message.errorMessage).toBeUndefined();
	});

	it("keeps the full budget for losses before the body went out", async () => {
		let calls = 0;
		const { result } = run(async () => {
			calls++;
			throw new AIError.ConnectionLostBeforeResponseError(
				Object.assign(new Error("reset"), { code: "ECONNRESET" }),
				{
					bodyBytes: 1_100_000,
					bodySent: false,
					elapsedMs: 900,
				},
			);
		});
		const message = await result;
		expect(calls).toBe(11);
		expect(message.errorMessage).toMatch(/\[11 attempts over [^\]]+\]$/);
	});
});
