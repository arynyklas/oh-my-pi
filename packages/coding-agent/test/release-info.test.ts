import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { getLatestReleaseForVersion } from "@oh-my-pi/pi-coding-agent/cli/release-info";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("release info lookup", () => {
	it("maps normal builds to upstream npm metadata", async () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ version: "16.5.1" }));

		const release = await getLatestReleaseForVersion("16.5.0");

		expect(release).toEqual({ repo: "can1357/oh-my-pi", tag: "v16.5.1", version: "16.5.1" });
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(String(fetchSpy.mock.calls[0]?.[0])).toBe("https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/latest");
	});
});
