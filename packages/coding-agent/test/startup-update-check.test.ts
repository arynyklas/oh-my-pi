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
	it("checks fork GitHub releases for fork builds", async () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json([{ tag_name: "v16.5.0-fork.3", draft: false, prerelease: false }]),
		);

		const newVersion = await checkForNewVersion("16.5.0-fork.2");
		expect(newVersion).toBe("16.5.0-fork.3");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(
			"https://api.github.com/repos/arynyklas/oh-my-pi/releases?per_page=20",
		);
	});
});
