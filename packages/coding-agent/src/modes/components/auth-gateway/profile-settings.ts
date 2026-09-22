import type { AuthGatewayAdminClient } from "@oh-my-pi/pi-ai/auth-gateway";
import {
	type Component,
	type Focusable,
	Input,
	type SelectItem,
	SelectList,
	type SgrMouseEvent,
} from "@oh-my-pi/pi-tui";
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui/utils";
import type { GatewaySettingsHost } from "@oh-my-pi/pi-tui/overlays/settings-selector";
import type {
	AuthGatewayConnectionProfile,
	AuthGatewayProfileStore,
	AuthGatewayTokenSource,
	ResolvedAuthGatewayConnection,
} from "../../../auth-gateway/profiles";
import { getSelectListTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { routeSelectListMouseWithTopBorder } from "@oh-my-pi/pi-tui/chrome/select-list-mouse-routing";

export interface GatewayProfileSettingsContext {
	profileStore: AuthGatewayProfileStore;
	createClient(connection: ResolvedAuthGatewayConnection): AuthGatewayAdminClient;
	requestRender(): void;
}

export interface GatewayProfileSettingsOptions {
	onboarding?: boolean;
	onConnectionReady?: (name: string) => void;
	onCancel?: () => void;
}

/**
 * Adapt the profile editor to the `GatewaySettingsHost` seam pi-tui's settings
 * selector renders its Gateway tab through. The editor reads coding-agent's
 * profile store, so pi-tui only ever sees the panel interface.
 */
export function createGatewaySettingsHost(context: GatewayProfileSettingsContext): GatewaySettingsHost {
	return {
		createPanel: options => new GatewayProfileSettingsComponent(context, options),
	};
}

type TokenSourceMode = "file" | "env" | "command";
type FormStep = "name" | "url" | "source" | "token";
type FormMode = "create" | "edit";

interface ProfileFormState {
	mode: FormMode;
	step: FormStep;
	input: Input;
	name: string;
	url: string;
	sourceMode: TokenSourceMode;
	tokenValue: string;
	originalName: string | null;
	error: string | null;
	busy: boolean;
}

interface DeleteState {
	name: string;
	input: Input;
	error: string | null;
	busy: boolean;
}

const TOKEN_SOURCE_MODES: Record<TokenSourceMode, true> = { file: true, env: true, command: true };

function sanitizeText(value: unknown): string {
	return replaceTabs(String(value)).replace(/[\r\n]+/g, " ");
}

function errorText(error: unknown): string {
	if (error && typeof error === "object" && "code" in error && "message" in error) {
		const coded = error as { code: unknown; message: unknown };
		return `${sanitizeText(coded.code)}: ${sanitizeText(coded.message)}`;
	}
	return error instanceof Error ? sanitizeText(error.message) : sanitizeText(error);
}

function tokenSourceFromMode(mode: TokenSourceMode, value: string): AuthGatewayTokenSource {
	if (mode === "file") return { type: "file" };
	if (mode === "env") return { type: "env", variable: value.trim() };
	return { type: "command", command: value.trim() };
}

function tokenSourceMode(source: AuthGatewayTokenSource): TokenSourceMode {
	return source.type;
}

function tokenSourceEditValue(source: AuthGatewayTokenSource): string {
	if (source.type === "env") return source.variable;
	if (source.type === "command") return source.command;
	return "";
}

function tokenSourceLabel(source: AuthGatewayTokenSource): string {
	if (source.type === "file") return "managed file";
	if (source.type === "env") return `env:${sanitizeText(source.variable)}`;
	return "command";
}

export class GatewayProfileSettingsComponent implements Component, Focusable {
	focused = false;
	#profiles: AuthGatewayConnectionProfile[] = [];
	#activeConnection: string | null = null;
	#loading = true;
	#error: string | null = null;
	#notice: string | null = null;
	#list = new SelectList([], 1, getSelectListTheme(), { overflowSearch: false, minPrimaryColumnWidth: 18 });
	#form: ProfileFormState | null = null;
	#deleteState: DeleteState | null = null;
	#selectedName: string | null = null;
	#useTerminalCursor = false;

	constructor(
		private readonly context: GatewayProfileSettingsContext,
		private readonly options: GatewayProfileSettingsOptions = {},
	) {
		this.#list.onCancel = () => this.options.onCancel?.();
		void this.#loadProfiles();
	}

	setUseTerminalCursor(useTerminalCursor: boolean): void {
		this.#useTerminalCursor = useTerminalCursor;
		this.#form?.input.setUseTerminalCursor(useTerminalCursor);
		this.#deleteState?.input.setUseTerminalCursor(useTerminalCursor);
	}

	invalidate(): void {
		this.#list.invalidate();
		this.#form?.input.invalidate();
		this.#deleteState?.input.invalidate();
	}

	ownsInput(): boolean {
		if (this.#form) return true;
		return this.#deleteState !== null;
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		if (this.#form || this.#deleteState) return;
		routeSelectListMouseWithTopBorder(this.#list, event, Math.max(0, line - 3), col);
	}

	async #loadProfiles(): Promise<void> {
		this.#loading = true;
		this.#error = null;
		try {
			const document = await this.context.profileStore.load();
			this.#profiles = document.connections;
			this.#activeConnection = document.activeConnection;
			if (!this.#selectedName || !document.connections.some(profile => profile.name === this.#selectedName)) {
				this.#selectedName = this.#profiles[0]?.name ?? null;
			}
			this.#rebuildList();
		} catch (error) {
			this.#profiles = [];
			this.#activeConnection = null;
			this.#error = errorText(error);
			this.#rebuildList();
		} finally {
			this.#loading = false;
			this.context.requestRender();
		}
	}

	#rebuildList(): void {
		const items: SelectItem[] = this.#profiles.map(profile => ({
			value: profile.name,
			label: `${this.#activeConnection === profile.name ? "*" : " "} ${sanitizeText(profile.name)}`,
			description: `${sanitizeText(profile.url)} · ${tokenSourceLabel(profile.tokenSource)}`,
		}));
		this.#list = new SelectList(items, Math.max(1, Math.min(items.length, 10)), getSelectListTheme(), {
			overflowSearch: false,
			minPrimaryColumnWidth: 18,
			maxPrimaryColumnWidth: 28,
		});
		const selectedIndex = items.findIndex(item => item.value === this.#selectedName);
		if (selectedIndex >= 0) this.#list.setSelectedIndex(selectedIndex);
		this.#list.onSelectionChange = item => {
			this.#selectedName = item.value;
		};
		this.#list.onCancel = () => this.options.onCancel?.();
	}

	#selectedProfile(): AuthGatewayConnectionProfile | null {
		const selected = this.#list.getSelectedItem();
		if (!selected) return null;
		return this.#profiles.find(profile => profile.name === selected.value) ?? null;
	}

	#clearFeedback(): void {
		this.#error = null;
		this.#notice = null;
	}

	#startCreate(): void {
		this.#clearFeedback();
		this.#form = this.#newForm("create", null);
	}

	#startEdit(): void {
		const selected = this.#selectedProfile();
		if (!selected) return;
		this.#clearFeedback();
		this.#form = this.#newForm("edit", selected);
	}

	#newForm(mode: FormMode, profile: AuthGatewayConnectionProfile | null): ProfileFormState {
		const input = new Input();
		input.focused = this.focused;
		input.setUseTerminalCursor(this.#useTerminalCursor);
		input.prompt = "Name: ";
		input.setValue(profile?.name ?? "");
		input.onSubmit = value => this.#submitFormStep(value);
		input.onEscape = () => {
			input.clear();
			this.#form = null;
		};
		return {
			mode,
			step: "name",
			input,
			name: profile?.name ?? "",
			url: profile?.url ?? "",
			sourceMode: profile ? tokenSourceMode(profile.tokenSource) : "file",
			tokenValue: profile ? tokenSourceEditValue(profile.tokenSource) : "",
			originalName: profile?.name ?? null,
			error: null,
			busy: false,
		};
	}

	#prepareFormInput(form: ProfileFormState): void {
		form.input.clear();
		form.input.focused = this.focused;
		form.input.setUseTerminalCursor(this.#useTerminalCursor);
		form.input.setMask(undefined);
		if (form.step === "name") {
			form.input.prompt = "Name: ";
			form.input.setValue(form.name);
		} else if (form.step === "url") {
			form.input.prompt = "URL: ";
			form.input.setValue(form.url);
		} else if (form.step === "source") {
			form.input.prompt = "Token source (file/env/command): ";
			form.input.setValue(form.mode === "create" ? "" : form.sourceMode);
		} else {
			form.input.prompt = this.#tokenPrompt(form.sourceMode);
			if (form.sourceMode === "file" || form.sourceMode === "command") form.input.setMask("•");
			form.input.setValue(form.tokenValue);
		}
	}

	#tokenPrompt(mode: TokenSourceMode): string {
		if (mode === "file") return "Token: ";
		if (mode === "env") return "Environment variable: ";
		return "Command: ";
	}

	#submitFormStep(value: string): void {
		const form = this.#form;
		if (!form || form.busy) return;
		form.error = null;
		if (form.step === "name") {
			form.name = value;
			form.step = "url";
			this.#prepareFormInput(form);
			return;
		}
		if (form.step === "url") {
			form.url = value;
			form.step = "source";
			this.#prepareFormInput(form);
			return;
		}
		if (form.step === "source") {
			const normalized = value.trim().toLowerCase();
			if (!(normalized in TOKEN_SOURCE_MODES)) {
				form.error = "Token source must be file, env, or command";
				this.context.requestRender();
				return;
			}
			const previousMode = form.sourceMode;
			form.sourceMode = normalized as TokenSourceMode;
			if (form.sourceMode !== previousMode) form.tokenValue = "";
			form.step = "token";
			this.#prepareFormInput(form);
			return;
		}
		form.tokenValue = value;
		void this.#saveForm(form);
	}

	async #saveForm(form: ProfileFormState): Promise<void> {
		form.busy = true;
		form.error = null;
		const fileToken = form.sourceMode === "file" && form.tokenValue.length > 0 ? form.tokenValue : undefined;
		try {
			const persistedProfile = {
				name: form.name,
				url: form.url,
				tokenSource: tokenSourceFromMode(form.sourceMode, form.tokenValue),
			};
			const isSavedCreateRetry =
				form.mode === "create" &&
				form.sourceMode === "file" &&
				form.originalName === form.name &&
				fileToken === undefined;
			if (form.mode === "edit" && form.originalName !== null) {
				await this.context.profileStore.updateAndRename(form.originalName, persistedProfile, fileToken);
				form.originalName = form.name;
			} else if (!isSavedCreateRetry) {
				await this.context.profileStore.upsert(persistedProfile, fileToken);
				form.originalName = form.name;
			}
			if (this.options.onboarding) {
				await this.#testConnection(form.name);
				this.options.onConnectionReady?.(form.name.trim().toLowerCase());
			}
			this.#form = null;
			this.#notice = form.mode === "create" ? "Connection saved" : "Connection updated";
			await this.#loadProfiles();
		} catch (error) {
			form.error = errorText(error);
			form.busy = false;
			this.context.requestRender();
		} finally {
			if (form.step === "token" && form.sourceMode === "file") {
				form.input.clear();
				form.tokenValue = "";
			}
		}
	}

	async #testConnection(name: string): Promise<void> {
		const connection = await this.context.profileStore.resolve(name);
		const status = await this.context.createClient(connection).status();
		this.#notice = `Connection ok: ${sanitizeText(status.version)}`;
	}

	#startDelete(): void {
		const selected = this.#selectedProfile();
		if (!selected) return;
		this.#clearFeedback();
		const input = new Input();
		input.focused = this.focused;
		input.setUseTerminalCursor(this.#useTerminalCursor);
		input.prompt = `Type ${selected.name} to delete: `;
		input.onSubmit = value => {
			void this.#confirmDelete(value);
		};
		input.onEscape = () => {
			input.clear();
			this.#deleteState = null;
		};
		this.#deleteState = { name: selected.name, input, error: null, busy: false };
	}

	async #confirmDelete(value: string): Promise<void> {
		const state = this.#deleteState;
		if (!state || state.busy) return;
		state.error = null;
		if (value !== state.name) {
			state.error = "Connection name did not match";
			this.context.requestRender();
			return;
		}
		state.busy = true;
		this.context.requestRender();
		try {
			await this.context.profileStore.delete(state.name);
			state.input.clear();
			this.#deleteState = null;
			this.#notice = `Deleted ${sanitizeText(state.name)}`;
			await this.#loadProfiles();
		} catch (error) {
			state.error = errorText(error);
			state.busy = false;
			this.context.requestRender();
		}
	}

	async #setActive(): Promise<void> {
		const selected = this.#selectedProfile();
		if (!selected) return;
		this.#clearFeedback();
		try {
			await this.context.profileStore.setActive(selected.name);
			this.#notice = `Active connection: ${sanitizeText(selected.name)}`;
			await this.#loadProfiles();
		} catch (error) {
			this.#error = errorText(error);
			this.context.requestRender();
		}
	}

	async #testSelected(): Promise<void> {
		const selected = this.#selectedProfile();
		if (!selected) return;
		this.#clearFeedback();
		try {
			await this.#testConnection(selected.name);
		} catch (error) {
			this.#error = errorText(error);
		}
		this.context.requestRender();
	}

	handleInput(data: string): void {
		if (this.#form) {
			this.#form.input.handleInput(data);
			return;
		}
		if (this.#deleteState) {
			this.#deleteState.input.handleInput(data);
			return;
		}
		if (data === "a") {
			this.#startCreate();
			return;
		}
		if (data === "e") {
			this.#startEdit();
			return;
		}
		if (data === "d") {
			this.#startDelete();
			return;
		}
		if (data === "s") {
			void this.#setActive();
			return;
		}
		if (data === "t") {
			void this.#testSelected();
			return;
		}
		this.#list.handleInput(data);
	}

	render(width: number): readonly string[] {
		const lines: string[] = [];
		lines.push(theme.bold("Gateway profiles"));
		if (this.options.onboarding) lines.push("Create a gateway connection to continue.");
		if (this.#loading) lines.push("Loading gateway profiles...");
		if (this.#error) lines.push(theme.fg("error", truncateToWidth(this.#error, width)));
		if (this.#notice) lines.push(theme.fg("success", truncateToWidth(this.#notice, width)));
		if (this.#form) return this.#renderForm(width, lines);
		if (this.#deleteState) return this.#renderDelete(width, lines);
		if (!this.#loading && this.#profiles.length === 0 && !this.#error) {
			lines.push("No gateway connections configured.");
		}
		lines.push(...this.#list.render(width));
		lines.push(theme.fg("dim", "a add · e edit · d delete · s set active · t test · Esc close"));
		return lines.map(line => truncateToWidth(line, width));
	}

	#renderForm(width: number, prefix: string[]): readonly string[] {
		const form = this.#form;
		if (!form) return prefix;
		const lines = [...prefix];
		lines.push(form.mode === "create" ? "Add connection" : `Edit ${sanitizeText(form.originalName ?? form.name)}`);
		lines.push(`Name: ${sanitizeText(form.name || "(new)")}`);
		lines.push(`URL: ${sanitizeText(form.url || "(not set)")}`);
		lines.push(`Token source: ${form.sourceMode === "file" ? "managed file" : form.sourceMode}`);
		if (form.error) lines.push(theme.fg("error", truncateToWidth(form.error, width)));
		lines.push(...form.input.render(width));
		if (form.busy) lines.push("Saving...");
		lines.push(theme.fg("dim", "Enter to continue/save · Esc cancel"));
		return lines.map(line => truncateToWidth(line, width));
	}

	#renderDelete(width: number, prefix: string[]): readonly string[] {
		const state = this.#deleteState;
		if (!state) return prefix;
		const lines = [...prefix, `Delete ${sanitizeText(state.name)}`];
		if (state.error) lines.push(theme.fg("error", truncateToWidth(state.error, width)));
		lines.push(...state.input.render(width));
		if (state.busy) lines.push("Deleting...");
		lines.push(theme.fg("dim", "Type the connection name exactly · Esc cancel"));
		return lines.map(line => truncateToWidth(line, width));
	}
}
