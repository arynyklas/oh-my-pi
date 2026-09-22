import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthGatewayAdminClient, AuthGatewayAdminStatus } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthGatewayAdminClientError } from "@oh-my-pi/pi-ai/auth-gateway";
import { AuthGatewayProfileStore } from "@oh-my-pi/pi-coding-agent/auth-gateway/profiles";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createSettingsHost } from "@oh-my-pi/pi-coding-agent/config/settings-ui";
import { createPluginSettingsHost } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/settings-host";
import {
	createGatewaySettingsHost,
	GatewayProfileSettingsComponent,
	type GatewayProfileSettingsContext,
} from "@oh-my-pi/pi-coding-agent/modes/components/auth-gateway/profile-settings";
import { SettingsSelectorComponent } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const CURSOR_MARKER = "\x1b_pi:c\x07";

const TRANSPORT_ERROR =
	"Remote auth-gateway connections must use https:// (plain http:// is allowed only for localhost)";
const SECRET = "pasted-managed-token-secret";

const STATUS: AuthGatewayAdminStatus = {
	ok: true,
	version: "test-version",
	serverTime: 1_700_000_000_000,
	principal: { kind: "managed", userId: 1, name: "admin", role: "admin", tokenId: 7 },
	counts: { users: 1, activeTokens: 2, pools: 3, credentials: 4 },
};

let root = "";
let documentPath = "";
let tokenDir = "";
let statusCalls = 0;
let nextStatusError: Error | undefined;
let readyConnections: string[] = [];
let renderRequests = 0;

class FakeGatewayClient {
	async status(): Promise<AuthGatewayAdminStatus> {
		statusCalls++;
		if (nextStatusError) throw nextStatusError;
		return STATUS;
	}
}

beforeEach(async () => {
	await initTheme();
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gateway-profile-settings-"));
	documentPath = path.join(root, "auth-gateways.json");
	tokenDir = path.join(root, "tokens");
	statusCalls = 0;
	nextStatusError = undefined;
	readyConnections = [];
	renderRequests = 0;
});

afterEach(async () => {
	mock.restore();
	resetSettingsForTest();
	await removeWithRetries(root);
});

function openStore(): AuthGatewayProfileStore {
	return AuthGatewayProfileStore.open({ documentPath, tokenDir });
}

function context(store = openStore()): GatewayProfileSettingsContext {
	return {
		profileStore: store,
		createClient: () => new FakeGatewayClient() as unknown as AuthGatewayAdminClient,
		requestRender: () => {
			renderRequests++;
		},
	};
}

async function waitUntil(condition: () => boolean, state: () => string = () => ""): Promise<void> {
	for (let i = 0; i < 2000; i++) {
		if (condition()) return;
		await new Promise<void>(resolve => setImmediate(resolve));
	}
	expect(condition(), state()).toBe(true);
}

async function flushProfileSettings(): Promise<void> {
	await waitUntil(() => renderRequests > 0);
}

function text(component: { render(width: number): readonly string[] }, width = 120): string {
	return component
		.render(width)
		.map(line => Bun.stripANSI(line.replaceAll(CURSOR_MARKER, "")))
		.join("\n");
}

function typeAndSubmit(component: { handleInput(data: string): void }, value: string): void {
	for (const char of value) component.handleInput(char);
	component.handleInput("\n");
}

function failMetadataCommitForProfileName(name: string): void {
	const originalRename = fs.rename;
	spyOn(fs, "rename").mockImplementation(async (oldPath, newPath) => {
		if (newPath === documentPath) {
			const content = await fs.readFile(oldPath, "utf-8");
			if (content.includes(`"name": "${name}"`)) throw new Error("metadata commit failed\nwith newline");
		}
		await originalRename(oldPath, newPath);
	});
}

async function createFileConnection(
	component: GatewayProfileSettingsComponent,
	name: string,
	url: string,
	token: string,
): Promise<void> {
	await waitUntil(
		() => !text(component).includes("Loading gateway profiles..."),
		() => text(component),
	);
	component.handleInput("a");
	typeAndSubmit(component, name);
	typeAndSubmit(component, url);
	typeAndSubmit(component, "file");
	for (const char of token) component.handleInput(char);
	expect(text(component)).toContain("••••");
	expect(text(component)).not.toContain(token);
	component.handleInput("\n");
	await waitUntil(
		() => !text(component).includes("Saving...") && !text(component).includes("Loading gateway profiles..."),
		() => text(component),
	);
	await flushProfileSettings();
}

describe("GatewayProfileSettingsComponent", () => {
	it("lists profiles, marks the active one, switches active selection, tests status, and deletes by typed name", async () => {
		const component = new GatewayProfileSettingsComponent(context());
		await flushProfileSettings();

		await createFileConnection(component, "prod", "https://gateway.example.com/omp", SECRET);
		await createFileConnection(component, "staging", "https://staging.example.com", "staging-token");

		let rendered = text(component);
		expect(rendered).toContain("Gateway profiles");
		expect(rendered).toContain("* prod");
		expect(rendered).toContain("staging");
		expect(rendered).toContain("managed file");
		expect(rendered).not.toContain(SECRET);
		expect(rendered).not.toContain("Open Console");
		expect(rendered).not.toContain("Users");
		expect(rendered).not.toContain("Pools");
		expect(rendered).not.toContain("Accounts");

		component.handleInput("\x1b[B");
		component.handleInput("s");
		await waitUntil(
			() => text(component).includes("* staging"),
			() => text(component),
		);
		rendered = text(component);
		expect(rendered).toContain("* staging");

		component.handleInput("t");
		await waitUntil(
			() => statusCalls === 1 && text(component).includes("Connection ok: test-version"),
			() => text(component),
		);
		expect(statusCalls).toBe(1);
		expect(text(component)).toContain("Connection ok: test-version");

		component.handleInput("d");
		typeAndSubmit(component, "staging");
		await waitUntil(
			() => !text(component).includes("Deleting...") && text(component).includes("* prod"),
			() => text(component),
		);
		rendered = text(component);
		expect(rendered).not.toContain("staging.example.com");
		expect(rendered).toContain("* prod");
	});

	it("clears a failed connection test as soon as the retry begins", async () => {
		const component = new GatewayProfileSettingsComponent(context());
		await flushProfileSettings();
		await createFileConnection(component, "prod", "https://gateway.example.com/omp", SECRET);
		nextStatusError = new Error("status failed");

		component.handleInput("t");
		await waitUntil(
			() => statusCalls === 1 && text(component).includes("status failed"),
			() => text(component),
		);
		expect(text(component)).toContain("status failed");

		nextStatusError = undefined;
		component.handleInput("t");

		expect(text(component)).not.toContain("status failed");
		await waitUntil(
			() => statusCalls === 2 && text(component).includes("Connection ok: test-version"),
			() => text(component),
		);
		expect(text(component)).toContain("Connection ok: test-version");
	});

	it("does not render list-level errors inside create edit or delete flows", async () => {
		for (const entry of [
			{ key: "a", title: "Add connection" },
			{ key: "e", title: "Edit prod" },
			{ key: "d", title: "Delete prod" },
		]) {
			const store = openStore();
			await store.upsert(
				{ name: "prod", url: "https://gateway.example.com", tokenSource: { type: "file" } },
				SECRET,
			);
			const component = new GatewayProfileSettingsComponent(context(store));
			await flushProfileSettings();
			await waitUntil(
				() => !text(component).includes("Loading gateway profiles..."),
				() => text(component),
			);
			spyOn(store, "setActive").mockImplementation(async () => {
				throw new Error("set active failed");
			});
			component.handleInput("s");
			await waitUntil(
				() => text(component).includes("set active failed"),
				() => text(component),
			);

			component.handleInput(entry.key);

			const rendered = text(component);
			expect(rendered).toContain(entry.title);
			expect(rendered).not.toContain("set active failed");
			mock.restore();
		}
	});

	it("clears a wrong delete confirmation while a valid retry is pending", async () => {
		const store = openStore();
		await store.upsert({ name: "prod", url: "https://gateway.example.com", tokenSource: { type: "file" } }, SECRET);
		const component = new GatewayProfileSettingsComponent(context(store));
		await flushProfileSettings();
		const deleteGate = Promise.withResolvers<void>();
		const originalDelete = store.delete.bind(store);
		const deleteSpy = spyOn(store, "delete").mockImplementation(async name => {
			await deleteGate.promise;
			return await originalDelete(name);
		});
		component.handleInput("d");
		typeAndSubmit(component, "wrong");
		expect(text(component)).toContain("Connection name did not match");
		component.handleInput("\x15");
		typeAndSubmit(component, "prod");

		expect(text(component)).toContain("Deleting...");
		expect(text(component)).not.toContain("Connection name did not match");
		expect(deleteSpy).toHaveBeenCalledWith("prod");
		deleteGate.resolve();
		await waitUntil(
			() =>
				!text(component).includes("Deleting...") && text(component).includes("No gateway connections configured."),
			() => text(component),
		);
	});

	it("preserves the managed token file when editing file-backed metadata with a blank token field", async () => {
		const store = openStore();
		const component = new GatewayProfileSettingsComponent(context(store));
		await flushProfileSettings();
		await createFileConnection(component, "prod", "https://gateway.example.com", SECRET);

		component.handleInput("e");
		component.handleInput("\n");
		component.handleInput("\x15");
		typeAndSubmit(component, "https://gateway.example.com/new-path");
		component.handleInput("\n");
		component.handleInput("\n");
		await waitUntil(
			() =>
				text(component).includes("Connection updated") &&
				text(component).includes("https://gateway.example.com/new-path"),
			() => text(component),
		);

		const profile = await store.get("prod");
		expect(profile?.url).toBe("https://gateway.example.com/new-path");
		const resolved = await store.resolve("prod");
		expect(resolved.token).toBe(SECRET);
		expect(text(component)).not.toContain(SECRET);
	});

	it("preserves env token source details when editing URL-only metadata", async () => {
		const store = openStore();
		await store.upsert({
			name: "prod",
			url: "https://gateway.example.com",
			tokenSource: { type: "env", variable: "OMP_GATEWAY_TOKEN" },
		});
		const component = new GatewayProfileSettingsComponent(context(store));
		await flushProfileSettings();

		component.handleInput("e");
		component.handleInput("\n");
		component.handleInput("\x15");
		typeAndSubmit(component, "https://gateway.example.com/new-path");
		component.handleInput("\n");
		component.handleInput("\n");
		await waitUntil(
			() =>
				text(component).includes("Connection updated") &&
				text(component).includes("https://gateway.example.com/new-path"),
			() => text(component),
		);

		const profile = await store.get("prod");
		expect(profile?.url).toBe("https://gateway.example.com/new-path");
		expect(profile?.tokenSource).toEqual({ type: "env", variable: "OMP_GATEWAY_TOKEN" });
		expect(text(component)).toContain("env:OMP_GATEWAY_TOKEN");
	});

	it("preserves masked command token source details when editing name-only metadata", async () => {
		const store = openStore();
		const command = "printf command-token-secret";
		await store.upsert({
			name: "cmd",
			url: "https://gateway.example.com",
			tokenSource: { type: "command", command },
		});
		const component = new GatewayProfileSettingsComponent(context(store));
		await flushProfileSettings();

		component.handleInput("e");
		component.handleInput("\x15");
		typeAndSubmit(component, "cmd-prod");
		component.handleInput("\n");
		component.handleInput("\n");
		let rendered = text(component);
		expect(rendered).toContain("••••");
		expect(rendered).not.toContain(command);
		expect(rendered).not.toContain("command-token-secret");
		component.handleInput("\n");
		await waitUntil(
			() => !text(component).includes("Saving...") && text(component).includes("* cmd-prod"),
			() => text(component),
		);

		const renamed = await store.get("cmd-prod");
		expect(renamed?.tokenSource).toEqual({ type: "command", command });
		expect(await store.get("cmd")).toBeNull();
		rendered = text(component);
		expect(rendered).toContain("command");
		expect(rendered).not.toContain(command);
		expect(rendered).not.toContain("command-token-secret");
	});

	it("does not partially rename an env-backed connection when metadata validation fails", async () => {
		const store = openStore();
		await store.upsert({
			name: "prod",
			url: "https://gateway.example.com",
			tokenSource: { type: "env", variable: "OMP_GATEWAY_TOKEN" },
		});
		const component = new GatewayProfileSettingsComponent(context(store));
		await flushProfileSettings();

		component.handleInput("e");
		component.handleInput("\x15");
		typeAndSubmit(component, "beta");
		component.handleInput("\x15");
		typeAndSubmit(component, "http://gateway.example.com");
		component.handleInput("\n");
		component.handleInput("\n");
		await waitUntil(
			() => text(component).includes(TRANSPORT_ERROR) && !text(component).includes("Saving..."),
			() => text(component),
		);

		const original = await store.get("prod");
		expect(original?.url).toBe("https://gateway.example.com");
		expect(original?.tokenSource).toEqual({ type: "env", variable: "OMP_GATEWAY_TOKEN" });
		expect(await store.get("beta")).toBeNull();
	});

	it("does not partially edit and rename a file-backed connection when renamed metadata commit fails", async () => {
		const store = openStore();
		await store.upsert({ name: "prod", url: "https://gateway.example.com", tokenSource: { type: "file" } }, SECRET);
		const component = new GatewayProfileSettingsComponent(context(store));
		await flushProfileSettings();
		failMetadataCommitForProfileName("beta");

		component.handleInput("e");
		component.handleInput("\x15");
		typeAndSubmit(component, "beta");
		component.handleInput("\x15");
		typeAndSubmit(component, "https://beta.example.com/api");
		component.handleInput("\x15");
		typeAndSubmit(component, "env");
		typeAndSubmit(component, "OMP_GATEWAY_TOKEN");
		await waitUntil(
			() =>
				text(component).includes("metadata commit failed with newline") && !text(component).includes("Saving..."),
			() => text(component),
		);

		const rendered = text(component);
		expect(rendered).not.toContain("\nwith newline");
		expect(rendered).not.toContain(SECRET);
		const original = await store.get("prod");
		expect(original?.url).toBe("https://gateway.example.com");
		expect(original?.tokenSource).toEqual({ type: "file" });
		expect(await fs.readFile(path.join(tokenDir, "prod.token"), "utf-8")).toBe(SECRET);
		expect(await store.get("beta")).toBeNull();
	});

	it("edits names, URLs, and env/command token modes without rendering command text", async () => {
		const component = new GatewayProfileSettingsComponent(context());
		await flushProfileSettings();
		await createFileConnection(component, "prod", "https://gateway.example.com", SECRET);

		component.handleInput("e");
		component.handleInput("\x15");
		typeAndSubmit(component, "beta");
		component.handleInput("\x15");
		typeAndSubmit(component, "https://beta.example.com/api");
		component.handleInput("\x15");
		typeAndSubmit(component, "env");
		typeAndSubmit(component, "OMP_GATEWAY_TOKEN");
		await waitUntil(
			() => !text(component).includes("Saving...") && text(component).includes("* beta"),
			() => text(component),
		);

		let rendered = text(component);
		expect(rendered).toContain("* beta");
		expect(rendered).toContain("env:OMP_GATEWAY_TOKEN");
		expect(rendered).toContain("https://beta.example.com/api");
		expect(rendered).not.toContain(SECRET);

		await createFileConnection(component, "cmd", "https://cmd.example.com", "cmd-token");
		component.handleInput("\x1b[A");
		component.handleInput("e");
		component.handleInput("\n");
		component.handleInput("\n");
		component.handleInput("\x15");
		typeAndSubmit(component, "command");
		typeAndSubmit(component, "printf secret-token-from-command");
		await waitUntil(
			() => !text(component).includes("Saving...") && text(component).includes("command"),
			() => text(component),
		);

		rendered = text(component);
		expect(rendered).toContain("command");
		expect(rendered).not.toContain("printf secret-token-from-command");
		expect(rendered).not.toContain("secret-token-from-command");
	});

	it("masks command token-source entry during create and edit", async () => {
		const command = "printf command-token-secret";
		const component = new GatewayProfileSettingsComponent(context());
		await flushProfileSettings();

		component.handleInput("a");
		typeAndSubmit(component, "cmd");
		typeAndSubmit(component, "https://cmd.example.com");
		typeAndSubmit(component, "command");
		for (const char of command) component.handleInput(char);
		let rendered = text(component);
		expect(rendered).toContain("••••");
		expect(rendered).not.toContain(command);
		expect(rendered).not.toContain("command-token-secret");
		component.handleInput("\n");
		await waitUntil(
			() => !text(component).includes("Saving...") && text(component).includes("command"),
			() => text(component),
		);

		rendered = text(component);
		expect(rendered).toContain("command");
		expect(rendered).not.toContain(command);
		expect(rendered).not.toContain("command-token-secret");

		component.handleInput("e");
		component.handleInput("\n");
		component.handleInput("\n");
		component.handleInput("\n");
		rendered = text(component);
		expect(rendered).not.toContain(command);
		expect(rendered).not.toContain("command-token-secret");
		const replacementCommand = "printf replacement-command-token";
		for (const char of replacementCommand) component.handleInput(char);
		rendered = text(component);
		expect(rendered).toContain("••••");
		expect(rendered).not.toContain(replacementCommand);
		expect(rendered).not.toContain("replacement-command-token");
		component.handleInput("\n");
		await waitUntil(
			() => !text(component).includes("Saving...") && text(component).includes("Connection updated"),
			() => text(component),
		);

		rendered = text(component);
		expect(rendered).toContain("command");
		expect(rendered).not.toContain(command);
		expect(rendered).not.toContain("command-token-secret");
	});

	it("keeps an invalid transport error in the form without resolving or rendering the token", async () => {
		const component = new GatewayProfileSettingsComponent(context());
		await flushProfileSettings();

		component.handleInput("a");
		typeAndSubmit(component, "remote");
		typeAndSubmit(component, "http://gateway.example.com");
		typeAndSubmit(component, "file");
		for (const char of SECRET) component.handleInput(char);
		component.handleInput("\n");
		await flushProfileSettings();

		const rendered = text(component);
		expect(rendered).toContain(TRANSPORT_ERROR);
		expect(rendered).not.toContain(SECRET);
		expect(rendered).toContain("Token");
	});

	it("renders malformed profile-store errors and does not replace them with live controls", async () => {
		await fs.mkdir(path.dirname(documentPath), { recursive: true });
		await fs.writeFile(documentPath, "{not-json");

		const component = new GatewayProfileSettingsComponent(context());
		await waitUntil(() => !text(component).includes("Loading gateway profiles..."));

		const rendered = text(component);
		expect(rendered).toContain("Invalid auth-gateway profiles document JSON");
		expect(rendered).not.toContain("Open Console");
		expect(rendered).not.toContain("Users");
		expect(rendered).not.toContain("Pools");
		expect(rendered).not.toContain("Accounts");
	});

	it("onboarding calls onConnectionReady only after authenticated status succeeds", async () => {
		nextStatusError = new AuthGatewayAdminClientError(401, "unauthorized", "Unauthorized\nwith newline");
		const component = new GatewayProfileSettingsComponent(context(), {
			onboarding: true,
			onConnectionReady: name => readyConnections.push(name),
		});
		await flushProfileSettings();

		await createFileConnection(component, "prod", "https://gateway.example.com", SECRET);
		expect(statusCalls).toBe(1);
		expect(readyConnections).toEqual([]);
		const rendered = text(component);
		expect(rendered).toContain("unauthorized: Unauthorized with newline");
		expect(rendered).not.toContain("Unauthorized\nwith newline");

		nextStatusError = undefined;
		component.handleInput("\n");
		await waitUntil(
			() => statusCalls === 2,
			() => text(component),
		);
		expect(statusCalls).toBe(2);
		expect(readyConnections).toEqual(["prod"]);
	});
});

describe("SettingsSelectorComponent gateway tab", () => {
	it("places the Gateway tab before Plugins without adding live console controls", async () => {
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark"],
				providers: [],
				settings: createSettingsHost(),
				plugins: createPluginSettingsHost(process.cwd()),
				gatewayProfiles: createGatewaySettingsHost(context()),
			},
			{ onChange: () => {}, onCancel: () => {} },
		);
		const rendered = text(selector, 240);
		const gatewayIndex = rendered.indexOf("Gateway");
		const pluginsIndex = rendered.indexOf("Plugins");
		expect(gatewayIndex).toBeGreaterThanOrEqual(0);
		expect(pluginsIndex).toBeGreaterThan(gatewayIndex);

		for (let i = 0; i < 10; i++) selector.handleInput("\x1b[C");
		const gateway = text(selector, 240);
		expect(gateway).toContain("Gateway profiles");
		expect(gateway).not.toContain("Open Console");
		expect(gateway).not.toContain("Users");
		expect(gateway).not.toContain("Pools");
		expect(gateway).not.toContain("Accounts");
	});

	it("closes settings from the top-level Gateway profile list on Escape and Ctrl-C", async () => {
		const store = openStore();
		await store.upsert({ name: "prod", url: "https://gateway.example.com", tokenSource: { type: "file" } }, SECRET);
		let cancels = 0;
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark"],
				providers: [],
				settings: createSettingsHost(),
				plugins: createPluginSettingsHost(process.cwd()),
				gatewayProfiles: createGatewaySettingsHost(context(store)),
			},
			{ onChange: () => {}, onCancel: () => cancels++ },
		);
		for (let i = 0; i < 10; i++) selector.handleInput("\x1b[C");
		await waitUntil(
			() => text(selector, 240).includes("prod"),
			() => text(selector, 240),
		);

		selector.handleInput("\x1b");
		expect(cancels).toBe(1);

		selector.handleInput("\x03");
		expect(cancels).toBe(2);
	});

	it("keeps Gateway create, edit, and delete Escape local without closing settings", async () => {
		const store = openStore();
		await store.upsert({ name: "prod", url: "https://gateway.example.com", tokenSource: { type: "file" } }, SECRET);
		let cancels = 0;
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark"],
				providers: [],
				settings: createSettingsHost(),
				plugins: createPluginSettingsHost(process.cwd()),
				gatewayProfiles: createGatewaySettingsHost(context(store)),
			},
			{ onChange: () => {}, onCancel: () => cancels++ },
		);
		for (let i = 0; i < 10; i++) selector.handleInput("\x1b[C");
		await waitUntil(
			() => text(selector, 240).includes("prod"),
			() => text(selector, 240),
		);

		selector.handleInput("a");
		expect(text(selector, 240)).toContain("Add connection");
		selector.handleInput("\x1b");
		expect(cancels).toBe(0);
		expect(text(selector, 240)).not.toContain("Add connection");
		expect(text(selector, 240)).toContain("Gateway profiles");

		selector.handleInput("e");
		expect(text(selector, 240)).toContain("Edit prod");
		selector.handleInput("\x1b");
		expect(cancels).toBe(0);
		expect(text(selector, 240)).not.toContain("Edit prod");
		expect(text(selector, 240)).toContain("prod");

		selector.handleInput("d");
		expect(text(selector, 240)).toContain("Delete prod");
		selector.handleInput("\x1b");
		expect(cancels).toBe(0);
		expect(text(selector, 240)).not.toContain("Delete prod");
		expect(text(selector, 240)).toContain("prod");
	});

	it("routes Gateway form navigation keys to the form while top-level Gateway still switches tabs", async () => {
		const store = openStore();
		const selector = new SettingsSelectorComponent(
			{
				availableThinkingLevels: [],
				thinkingLevel: undefined,
				availableThemes: ["dark"],
				providers: [],
				settings: createSettingsHost(),
				plugins: createPluginSettingsHost(process.cwd()),
				gatewayProfiles: createGatewaySettingsHost(context(store)),
			},
			{ onChange: () => {}, onCancel: () => {} },
		);
		for (let i = 0; i < 10; i++) selector.handleInput("\x1b[C");
		await waitUntil(
			() => text(selector, 240).includes("Gateway profiles"),
			() => text(selector, 240),
		);

		selector.handleInput("a");
		typeAndSubmit(selector, "prod");
		typeAndSubmit(selector, "https://gateway.example.com");
		typeAndSubmit(selector, "file");
		for (const char of "se") selector.handleInput(char);
		selector.handleInput("\x1b[D");
		selector.handleInput("\x1b[C");
		selector.handleInput("\t");
		expect(text(selector, 240)).toContain("Add connection");
		for (const char of "cret") selector.handleInput(char);
		selector.handleInput("\n");
		await waitUntil(
			() => !text(selector, 240).includes("Saving...") && text(selector, 240).includes("* prod"),
			() => text(selector, 240),
		);

		const resolved = await store.resolve("prod");
		expect(resolved.token).toBe("secret");

		selector.handleInput("\t");
		expect(text(selector, 240)).not.toContain("a add · e edit · d delete · s set active · t test");
	});
});
