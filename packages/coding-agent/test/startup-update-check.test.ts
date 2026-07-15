import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { checkForNewVersion } from "@oh-my-pi/pi-coding-agent/main";

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

describe("startup update check", () => {
	it("checks fork prereleases for auth-gateway beta builds", async () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json([{ tag_name: "auth-gateway-v16.5.0-beta.3", draft: false, prerelease: true }]),
		);

		const newVersion = await checkForNewVersion("16.5.0-authgw.beta.2");
		expect(newVersion).toBe("16.5.0-authgw.beta.3");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
			"https://api.github.com/repos/arynyklas/oh-my-pi/releases?per_page=20",
		);
	});
});
