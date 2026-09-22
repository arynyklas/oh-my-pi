import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthGatewayProfileStore } from "@oh-my-pi/pi-coding-agent/auth-gateway/profiles";
import { resetSettingsForTest, Settings, settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { createPluginSettingsHost } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/settings-host";
import { createGatewaySettingsHost } from "@oh-my-pi/pi-coding-agent/modes/components/auth-gateway/profile-settings";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

beforeAll(async () => {
	await initTheme();
});

let geometryStub: { restore(): void } | undefined;
let tempDir = "";

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-settings-multiselect-"));
	geometryStub = stubStdoutGeometry(120);
});

afterEach(async () => {
	resetSettingsForTest();
	geometryStub?.restore();
	geometryStub = undefined;
	await removeWithRetries(tempDir);
	tempDir = "";
});

function stubStdoutGeometry(cols: number): { restore(): void } {
	const rowsDesc = Object.getOwnPropertyDescriptor(process.stdout, "rows");
	const colsDesc = Object.getOwnPropertyDescriptor(process.stdout, "columns");
	const rows = 40;
	Object.defineProperty(process.stdout, "rows", { configurable: true, get: () => rows, set: () => {} });
	Object.defineProperty(process.stdout, "columns", { configurable: true, get: () => cols, set: () => {} });
	const restoreOne = (key: "rows" | "columns", desc: PropertyDescriptor | undefined) => {
		if (desc) Object.defineProperty(process.stdout, key, desc);
	};
	return {
		restore() {
			restoreOne("rows", rowsDesc);
			restoreOne("columns", colsDesc);
		},
	};
}

function createSelector(): SettingsSelectorComponent {
	return new SettingsSelectorComponent(
		{
			availableThinkingLevels: [],
			thinkingLevel: undefined,
			availableThemes: ["dark"],
			providers: [],
			settings: createSettingsHost(),
			plugins: createPluginSettingsHost(process.cwd()),
			gatewayProfiles: createGatewaySettingsHost({
				profileStore: AuthGatewayProfileStore.open({
					documentPath: path.join(tempDir, "auth-gateways.json"),
					tokenDir: path.join(tempDir, "tokens"),
				}),
				createClient: () => {
					throw new Error("gateway client not used in this test");
				},
				requestRender: () => {},
			}),
		},
		{
			onChange: () => {},
			onCancel: () => {},
		},
	);
}

function optionRow(component: SettingsSelectorComponent, label: string): number {
	const lines = Bun.stripANSI(component.render(120).join("\n")).split("\n");
	const row = lines.findIndex(line => line.includes(label));
	if (row === -1) throw new Error(`Missing settings option: ${label}`);
	return row + 1;
}

function sendMouse(component: SettingsSelectorComponent, button: number, row: number, suffix: "M" | "m"): void {
	component.handleInput(`\x1b[<${button};3;${row}${suffix}`);
}

function clickOption(component: SettingsSelectorComponent, label: string): void {
	const row = optionRow(component, label);
	sendMouse(component, 0, row, "M");
	sendMouse(component, 0, row, "m");
}

describe("settings section sidebar", () => {
	it("does not toggle the selected section's first setting", () => {
		const comp = createSelector();
		for (let i = 0; i < 7; i++) comp.handleInput("\x1b[C");
		expect(settings.get("dev.autoqa")).toBe(true);

		clickOption(comp, "Developer");
		expect(settings.get("dev.autoqa")).toBe(true);

		clickOption(comp, "Developer");
		expect(settings.get("dev.autoqa")).toBe(true);
	});
});
