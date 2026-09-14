import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AuthGatewayProfileStore } from "@oh-my-pi/pi-coding-agent/auth-gateway/profiles";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import {
	BUILTIN_SLASH_COMMAND_DEFS,
	executeBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import type { Component, Container, OverlayHandle, TUI } from "@oh-my-pi/pi-tui";
import { removeWithRetries, setAgentDir } from "@oh-my-pi/pi-utils";

interface TestInputComponent extends Component {
	handleInput(data: string): void;
}

function requireInputComponent(component: Component | undefined): TestInputComponent {
	const candidate = component as { handleInput?: unknown } | undefined;
	if (typeof candidate?.handleInput !== "function") throw new Error("Expected auth-gateway overlay component");
	return component as TestInputComponent;
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

function createRuntimeHarness(focusedAgentId?: string): {
	runtime: { ctx: InteractiveModeContext };
	showAuthGatewayConsole: (connection?: string) => void;
	showError: (message: string) => void;
	setText: (text: string) => void;
} {
	const showAuthGatewayConsole = vi.fn();
	const showError = vi.fn();
	const setText = vi.fn();
	const ctx = {
		focusedAgentId,
		editor: { setText } as unknown as InteractiveModeContext["editor"],
		showAuthGatewayConsole,
		showError,
	} as unknown as InteractiveModeContext;
	return { runtime: { ctx }, showAuthGatewayConsole, showError, setText };
}

function createOverlayHarness(activeEditor: Component): {
	ui: TUI;
	getOverlay(): Component | undefined;
	focusCalls: Array<Component | null>;
	overlayShown: Promise<Component>;
} {
	const overlayShown = Promise.withResolvers<Component>();
	let overlayComponent: Component | undefined;
	const focusCalls: Array<Component | null> = [];
	const ui = {
		terminal: {
			rows: 24,
			columns: 100,
			hideCursor(): void {},
		},
		showOverlay(component: Component): OverlayHandle {
			overlayComponent = component;
			overlayShown.resolve(component);
			return {
				hide(): void {
					overlayComponent = undefined;
				},
				setHidden(): void {},
				isHidden(): boolean {
					return false;
				},
			};
		},
		setFocus(component: Component | null): void {
			focusCalls.push(component);
		},
		requestRender(): void {},
	} as unknown as TUI;
	focusCalls.push(activeEditor);
	return { ui, getOverlay: () => overlayComponent, focusCalls, overlayShown: overlayShown.promise };
}

describe("/gateway builtin slash command", () => {
	test("opens the active auth-gateway console", async () => {
		const harness = createRuntimeHarness();

		expect(await executeBuiltinSlashCommand("/gateway", harness.runtime)).toBe(true);

		expect(harness.showAuthGatewayConsole).toHaveBeenCalledWith(undefined);
		expect(harness.setText).toHaveBeenCalledWith("");
		expect(harness.showError).not.toHaveBeenCalled();
	});

	test("opens a named auth-gateway console", async () => {
		const harness = createRuntimeHarness();

		expect(await executeBuiltinSlashCommand("/gateway prod", harness.runtime)).toBe(true);

		expect(harness.showAuthGatewayConsole).toHaveBeenCalledWith("prod");
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	test("rejects extra gateway arguments without opening a console", async () => {
		const harness = createRuntimeHarness();

		expect(await executeBuiltinSlashCommand("/gateway prod extra", harness.runtime)).toBe(true);

		expect(harness.showError).toHaveBeenCalledWith("Usage: /gateway [connection]");
		expect(harness.showAuthGatewayConsole).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	test("keeps main-session-only console opening rejected while a subagent is focused", async () => {
		const harness = createRuntimeHarness("Worker");

		expect(await executeBuiltinSlashCommand("/gateway prod", harness.runtime)).toBe(true);

		expect(harness.showError).toHaveBeenCalledWith("/gateway is only available from the main session");
		expect(harness.showAuthGatewayConsole).not.toHaveBeenCalled();
		expect(harness.setText).toHaveBeenCalledWith("");
	});
});

describe("/account builtin slash command", () => {
	function createAccountHarness() {
		const showAccountManager = vi.fn(async () => {});
		const showStatus = vi.fn();
		const setText = vi.fn();
		const ctx = {
			editor: { setText } as unknown as InteractiveModeContext["editor"],
			showAccountManager,
			showStatus,
		} as unknown as InteractiveModeContext;
		return { runtime: { ctx }, showAccountManager, showStatus, setText };
	}

	test("opens the account manager pane", async () => {
		const harness = createAccountHarness();

		expect(await executeBuiltinSlashCommand("/account", harness.runtime)).toBe(true);

		expect(harness.showAccountManager).toHaveBeenCalledTimes(1);
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	// One runtime row: every nonempty arg hits the same rejection branch. What
	// the removed verbs need beyond that is (a) the line not escaping as a
	// prompt and (b) their absence from published metadata, both below.
	test("refuses arguments instead of opening the pane or leaking a prompt", async () => {
		const harness = createAccountHarness();

		// `true` means consumed: `false` would send the line to the model.
		expect(await executeBuiltinSlashCommand("/account default me@example.com", harness.runtime)).toBe(true);

		expect(harness.showAccountManager).not.toHaveBeenCalled();
		expect(harness.showStatus).toHaveBeenCalledWith(
			"/account takes no arguments — change the default and priority order in the pane.",
		);
		expect(harness.setText).toHaveBeenCalledWith("");
	});

	test("publishes no account subcommands to autocomplete or help", () => {
		const account = BUILTIN_SLASH_COMMAND_DEFS.find(command => command.name === "account");

		expect(account).toBeDefined();
		expect(account?.subcommands).toBeUndefined();
		// Args must stay dispatchable so the rejection above runs at all.
		expect(account?.allowArgs).toBe(true);
	});

	// The ACP/headless surface has no pane, so it would be the one place a
	// removed verb could still be honored — it must refuse without even
	// reaching the provider account lookup.
	test("refuses arguments on the ACP surface without listing accounts", async () => {
		const output = vi.fn(async () => {});
		const listCurrentProviderOAuthAccounts = vi.fn(async () => undefined);
		const runtime = {
			session: { listCurrentProviderOAuthAccounts },
			output,
		} as unknown as SlashCommandRuntime;

		expect(await executeAcpBuiltinSlashCommand("/account priority 2 1", runtime)).toEqual({ consumed: true });

		expect(listCurrentProviderOAuthAccounts).not.toHaveBeenCalled();
		expect(output).toHaveBeenCalledWith(
			"/account takes no arguments — change the default and priority order in the pane.",
		);
	});
});

describe("SelectorController auth-gateway console", () => {
	let tempDir = "";
	let previousAgentDir: string | undefined;
	let server: Bun.Server<undefined> | undefined;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gateway-slash-"));
		previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		setAgentDir(tempDir);
		process.env.OMP_TASK7_GATEWAY_TOKEN = "admin-token";
	});

	afterEach(async () => {
		server?.stop(true);
		server = undefined;
		delete process.env.OMP_TASK7_GATEWAY_TOKEN;
		if (previousAgentDir) {
			setAgentDir(previousAgentDir);
		} else {
			delete process.env.PI_CODING_AGENT_DIR;
		}
		vi.restoreAllMocks();
		if (tempDir) await removeWithRetries(tempDir);
	});

	test("uses the shared console component and restores the active editor when it closes", async () => {
		server = Bun.serve({
			port: 0,
			fetch: () =>
				Response.json({
					status: {
						ok: true,
						version: "test",
						serverTime: 1,
						principal: { kind: "managed", userId: 1, name: "admin", role: "admin", tokenId: 1 },
						counts: { users: 0, activeTokens: 0, pools: 0, credentials: 0 },
					},
				}),
		});
		const store = AuthGatewayProfileStore.open();
		await store.upsert({
			name: "prod",
			url: `http://127.0.0.1:${server.port}`,
			tokenSource: { type: "env", variable: "OMP_TASK7_GATEWAY_TOKEN" },
		});
		const editor = { render: () => [] } as Component;
		const activeEditor = { render: () => ["active editor"] } as Component;
		const overlayHarness = createOverlayHarness(activeEditor);
		const ctx = {
			ui: overlayHarness.ui,
			editor,
			editorContainer: { children: [activeEditor] } as unknown as Container,
			openInBrowser: () => {},
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		const opened = controller.showAuthGatewayConsole("prod");
		const overlay = requireInputComponent(await overlayHarness.overlayShown);
		expect(overlay.constructor.name).toBe("AuthGatewayConsole");

		overlay.handleInput("\x1b");
		await opened;

		expect(overlayHarness.focusCalls.at(-1)).toBe(activeEditor);
		expect(ctx.showError).not.toHaveBeenCalled();
	});

	test("restores the active editor when closed during the initial status load", async () => {
		const pendingStatus = Promise.withResolvers<Response>();
		server = Bun.serve({
			port: 0,
			fetch: () => pendingStatus.promise,
		});
		const store = AuthGatewayProfileStore.open();
		await store.upsert({
			name: "prod",
			url: `http://127.0.0.1:${server.port}`,
			tokenSource: { type: "env", variable: "OMP_TASK7_GATEWAY_TOKEN" },
		});
		const editor = { render: () => [] } as Component;
		const activeEditor = { render: () => ["active editor"] } as Component;
		const overlayHarness = createOverlayHarness(activeEditor);
		const ctx = {
			ui: overlayHarness.ui,
			editor,
			editorContainer: { children: [activeEditor] } as unknown as Container,
			openInBrowser: () => {},
			showError: vi.fn(),
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);

		const opened = controller.showAuthGatewayConsole("prod");
		const overlay = requireInputComponent(await overlayHarness.overlayShown);
		expect(overlay.constructor.name).toBe("AuthGatewayConsole");
		overlay.handleInput("\x1b");
		let outcome: "closed" | "pending" | "rejected" = "pending";
		let rejection: unknown;
		void opened.then(
			() => {
				outcome = "closed";
			},
			error => {
				outcome = "rejected";
				rejection = error;
			},
		);
		await flushMicrotasks();

		if (rejection) throw rejection;
		expect(outcome as string).toBe("closed");
		expect(overlayHarness.focusCalls.at(-1)).toBe(activeEditor);
		expect(ctx.showError).not.toHaveBeenCalled();
	});
});
