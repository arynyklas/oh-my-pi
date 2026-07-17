import type {
	AddAclRuleInput,
	AuthGatewayAclEffect,
	AuthGatewayAclKind,
	AuthGatewayAclRule,
	AuthGatewayAdminClient,
	AuthGatewayCredentialSummary,
	AuthGatewayPool,
	AuthGatewayPoolStrategy,
	AuthGatewayUserPoolBinding,
	CreatePoolInput,
	CreateUserInput,
	UpdatePoolInput,
	UpdateUserInput,
} from "@oh-my-pi/pi-ai/auth-gateway";
import {
	AUTH_GATEWAY_ACL_ROUTES,
	AUTH_GATEWAY_BASIC_ROUTES,
	AUTH_GATEWAY_POOL_STRATEGIES,
} from "@oh-my-pi/pi-ai/auth-gateway";
import { resolveUsedFraction } from "@oh-my-pi/pi-ai/usage";
import type { Component, Focusable, SelectItem, SgrMouseEvent, TUI } from "@oh-my-pi/pi-tui";
import {
	matchesKey,
	parseSgrMouse,
	replaceTabs,
	TabBar,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@oh-my-pi/pi-tui";
import type { AuthGatewayProfileStore, ResolvedAuthGatewayConnection } from "../../../auth-gateway/profiles";
import { describeRedeemOutcome } from "../../../slash-commands/helpers/reset-usage";
import { copyToClipboard } from "../../../utils/clipboard";
import { formatUsageReportLines } from "../../../utils/usage-format";
import { getTabBarTheme } from "../../shared";
import { theme } from "../../theme/theme";
import { renderOAuthAuthorizationLink } from "../oauth-authorization-link";
import { OAuthSelectorComponent } from "../oauth-selector";
import { bottomBorder, divider, row, topBorder } from "../overlay-box";
import {
	AuthGatewayAccountLoginController,
	type AuthGatewayAccountLoginPromptState,
	uploadAcquiredAuthGatewayCredential,
} from "./account-login";
import {
	type AuthGatewayAccountUsageState,
	AuthGatewayConsoleController,
	type AuthGatewayConsoleTab,
} from "./console-controller";
import {
	type AuthGatewayOneTimeTokenDialog,
	closeOneTimeTokenDialog,
	copyOneTimeTokenDialogValue,
	createOneTimeTokenDialog,
} from "./dialogs";
import { AuthGatewayFlowDialog, type AuthGatewayFlowStep } from "./flow-dialog";

export interface AuthGatewayConsoleHost {
	ui: TUI;
	openInBrowser(url: string): void;
	close(): void;
}

export interface AuthGatewayConsoleOptions {
	connection: ResolvedAuthGatewayConnection;
	profileStore: AuthGatewayProfileStore;
	createClient(connection: ResolvedAuthGatewayConnection): AuthGatewayAdminClient;
	host: AuthGatewayConsoleHost;
}

type ConsoleMode = "list" | "detail";
type PromptKind =
	| "filter"
	| "audit-user-filter"
	| "usage-since"
	| "toggle-user"
	| "delete-user"
	| "create-token"
	| "revoke-token"
	| "rotate-user"
	| "delete-pool"
	| "remove-account"
	| "api-key-provider"
	| "api-key-value"
	| "switch-connection";

interface PromptState {
	kind: PromptKind;
	label: string;
	value: string;
	masked: boolean;
	error: string | null;
	busy: string | null;
	provider?: string;
}

const TABS: Array<{ id: AuthGatewayConsoleTab; label: string; short: string }> = [
	{ id: "overview", label: "Overview", short: "Ovr" },
	{ id: "users", label: "Users", short: "Usr" },
	{ id: "pools", label: "Pools", short: "Pool" },
	{ id: "accounts", label: "Accounts", short: "Acct" },
	{ id: "audit", label: "Audit", short: "Aud" },
];

const FOOTER_PREFIX = "1-5 tabs · ↑/↓ select · / filter · r refresh · ? help";
const LEADING_SGR_MOUSE_EVENT_PATTERN = /^\x1b\[<\d+;\d+;\d+[Mm]/;
const NAME_HELP = "Lowercase letters, digits, _ and -; must start with a letter; 1–64 characters.";
const DESCRIPTION_HELP = "Human-readable purpose; blank leaves it unset.";
const OWNER_HELP = "Operator or team responsible for this user; blank leaves it unset.";
const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const STRATEGY_DESCRIPTIONS: Record<AuthGatewayPoolStrategy, string> = {
	"sticky-session": "sticky-session keeps an eligible session account",
	"least-used": "least-used ranks live OAuth usage for new/replacement sessions",
	"round-robin": "round-robin assigns new sessions per pool/provider",
	failover: "failover follows member order and advances on block/auth/usage failure",
};

export class AuthGatewayConsole implements Component, Focusable {
	focused = false;
	controller: AuthGatewayConsoleController;
	readonly ready: Promise<void>;
	readonly #host: AuthGatewayConsoleHost;
	readonly #profileStore: AuthGatewayProfileStore;
	readonly #createClient: (connection: ResolvedAuthGatewayConnection) => AuthGatewayAdminClient;
	#connection: ResolvedAuthGatewayConnection;
	#client: AuthGatewayAdminClient;
	#tabBar: TabBar;
	#mode: ConsoleMode = "list";
	#prompt: PromptState | null = null;
	#help = false;
	#oneTimeDialog: AuthGatewayOneTimeTokenDialog | null = null;
	#accountLogin: AuthGatewayAccountLoginController | null = null;
	#loginProviderSelector: OAuthSelectorComponent | null = null;
	#flowDialog: AuthGatewayFlowDialog | null = null;
	#loginGeneration = 0;
	#disposed = false;
	#tabRowStart = 0;
	#tabRowCount = 0;
	#bodyRowStart = 0;
	#listItemBodyLineStart = 2;
	#listItemBodyLineCount = 0;
	#listItemBodyColumnEnd = 0;
	#loginProviderBodyLineStart = 0;
	#flowDialogBodyLineStart = 0;
	#useTerminalCursor = false;

	constructor(options: AuthGatewayConsoleOptions) {
		this.#host = options.host;
		this.#profileStore = options.profileStore;
		this.#createClient = options.createClient;
		this.#connection = options.connection;
		this.#client = this.#createClient(options.connection);
		this.controller = this.#createController(options.connection, this.#client);
		this.#tabBar = new TabBar("", TABS, getTabBarTheme());
		this.#tabBar.showHint = false;
		this.#tabBar.onTabChange = tab => {
			void this.#switchTab(tab.id as AuthGatewayConsoleTab);
		};
		this.ready = this.controller.start();
	}

	setUseTerminalCursor(useTerminalCursor: boolean): void {
		this.#useTerminalCursor = useTerminalCursor;
	}

	invalidate(): void {
		this.#tabBar.invalidate();
	}

	dispose(): void {
		this.#disposed = true;
		this.#loginGeneration++;
		this.#accountLogin?.abort();
		this.#accountLogin = null;
		this.#loginProviderSelector?.stopValidation();
		this.#loginProviderSelector = null;
		this.#flowDialog = null;
		this.controller.close();
		if (this.#oneTimeDialog) closeOneTimeTokenDialog(this.#oneTimeDialog);
		this.#oneTimeDialog = null;
		this.#clearPrompt();
	}

	render(width: number): readonly string[] {
		const height = Math.max(14, process.stdout.rows ?? 24);
		const innerWidth = Math.max(1, width - 4);
		this.#tabBar.setTabs(
			TABS.map(tab => ({ ...tab, label: width < 60 ? tab.short : tab.label })),
			this.controller.state.activeTab,
		);
		const tabLines = this.#tabBar.render(innerWidth);
		const fixedRows = 1 + tabLines.length + 1 + 1 + 1 + 1;
		const contentRows = Math.max(6, height - fixedRows);
		const bodyLines = this.#bodyLines(innerWidth, contentRows, width);
		const out: string[] = [];
		out.push(topBorder(width, "Auth Gateway Console"));
		this.#tabRowStart = out.length;
		this.#tabRowCount = tabLines.length;
		for (const line of tabLines) out.push(row(line, width));
		out.push(divider(width));
		this.#bodyRowStart = out.length;
		for (let index = 0; index < contentRows; index++) out.push(row(bodyLines[index] ?? "", width));
		out.push(divider(width));
		const escHint = this.controller.hasActiveFilters() ? "Esc clear filter" : "Esc close";
		out.push(row(theme.fg("dim", `${FOOTER_PREFIX} · ${escHint}`), width));
		out.push(bottomBorder(width));
		return out;
	}

	handleInput(data: string): void {
		const splitMouseInputs = splitLeadingSgrMouseInputs(data);
		if (splitMouseInputs) {
			for (const input of splitMouseInputs) this.handleInput(input);
			return;
		}
		const isMouseInput = data.startsWith("\x1b[<");
		if (this.#oneTimeDialog) {
			if (!isMouseInput) void this.#handleTokenDialogInput(data);
			return;
		}
		if (this.#loginProviderSelector) {
			if (isMouseInput) this.#handleMouse(data);
			else this.#loginProviderSelector.handleInput(data);
			return;
		}
		if (this.#flowDialog) {
			if (isMouseInput) this.#handleMouse(data);
			else this.#flowDialog.handleInput(data);
			return;
		}
		if (this.#accountLogin?.state.prompt) {
			if (!isMouseInput) this.#accountLogin.handleInput(data);
			return;
		}
		if (this.#accountLogin) {
			if (data === "\x1b" || matchesKey(data, "ctrl+c")) this.#cancelAccountLogin();
			return;
		}
		if (this.#help) {
			if (data === "\x1b" || data === "?" || matchesKey(data, "ctrl+c")) this.#help = false;
			return;
		}
		if (this.#prompt) {
			if (!isMouseInput) this.#handlePromptInput(data);
			return;
		}
		if (this.controller.state.modalOpen) {
			if (!isMouseInput && (data === "\x1b" || matchesKey(data, "ctrl+c"))) this.#host.close();
			return;
		}
		if (isMouseInput) {
			this.#handleMouse(data);
			return;
		}
		if (matchesKey(data, "ctrl+c")) {
			this.#host.close();
			return;
		}
		if (data === "\x1b") {
			if (this.#mode === "detail") {
				this.#mode = "list";
				return;
			}
			if (this.controller.clearActiveFilters()) return;
			this.#host.close();
			return;
		}
		if (data >= "1" && data <= "5") {
			const tab = TABS[Number(data) - 1]?.id;
			if (tab) void this.#switchTab(tab);
			return;
		}
		if (data === "s" && this.controller.state.activeTab === "overview") {
			this.#handleAction(data);
			return;
		}
		if (this.#isTabActionKey(data)) {
			this.#handleAction(data);
			return;
		}
		if (this.#tabBar.handleInput(data)) return;
		if (data === "?") {
			this.#help = true;
			return;
		}
		if (data === "/") {
			this.#openPrompt({
				kind: this.controller.state.activeTab === "audit" ? "filter" : "filter",
				label: "Filter: ",
				value: "",
				masked: false,
				error: null,
			});
			return;
		}
		if (data === "r") {
			void this.controller.refresh();
			return;
		}
		if (data === "\x1b[B" || data === "j") {
			this.controller.selectNext();
			return;
		}
		if (data === "\x1b[A") {
			this.controller.selectPrevious();
			return;
		}
		if (data === "k") {
			if (this.controller.state.activeTab === "accounts") this.#startApiKeyPrompt();
			else this.controller.selectPrevious();
			return;
		}
		if (data === "\n" || data === "\r") {
			if (this.#narrowDetailAvailable()) this.#mode = "detail";
			return;
		}
		this.#handleAction(data);
	}

	#isTabActionKey(data: string): boolean {
		const tab = this.controller.state.activeTab;
		if (tab === "users") return "cetdTvRUaxbu[]+-".includes(data);
		if (tab === "pools") return "cedax[]+-".includes(data);
		if (tab === "audit") return "unp".includes(data);
		return false;
	}

	#handleAction(data: string): void {
		const tab = this.controller.state.activeTab;
		if (tab === "overview" && data === "s") {
			this.#openPrompt({
				kind: "switch-connection",
				label: "Connection name: ",
				value: "",
				masked: false,
				error: null,
			});
			return;
		}

		if (tab === "users") {
			this.#handleUserAction(data);
			return;
		}
		if (tab === "pools") {
			this.#handlePoolAction(data);
			return;
		}
		if (tab === "accounts") {
			this.#handleAccountAction(data);
			return;
		}
		if (tab === "audit" && data === "u") {
			this.#openPrompt({
				kind: "audit-user-filter",
				label: "Audit user id (blank clears): ",
				value: "",
				masked: false,
				error: null,
			});
			return;
		}
		if (tab === "audit" && data === "n") {
			void this.controller.nextAuditPage();
			return;
		}
		if (tab === "audit" && data === "p") {
			void this.controller.previousAuditPage();
		}
	}

	#handleUserAction(data: string): void {
		const selected = this.controller.selectedUser();
		if (data === "c") {
			this.#openCreateUserFlow();
			return;
		}
		if (!selected) return;
		if (data === "e") {
			this.#openEditUserFlow();
			return;
		}
		if (data === "t") {
			const warning = selected.enabled ? this.controller.currentUserDisconnectWarning() : null;
			const confirmation = warning
				? ` ${warning}. Type disconnect ${sanitizeCell(selected.name)}: `
				: "Type y to toggle: ";
			this.#openPrompt({
				kind: "toggle-user",
				label: `${selected.enabled ? "Disable" : "Enable"} user.${confirmation}`,
				value: "",
				masked: false,
				error: null,
			});
			return;
		}
		if (data === "d") {
			const warning = this.controller.currentUserDisconnectWarning();
			this.#openPrompt({
				kind: "delete-user",
				label: warning
					? `${warning}. Type disconnect ${sanitizeCell(selected.name)} to delete: `
					: `Type ${sanitizeCell(selected.name)} to delete: `,
				value: "",
				masked: false,
				error: null,
			});
			return;
		}
		if (data === "T") {
			this.#openPrompt({ kind: "create-token", label: "Token label: ", value: "", masked: false, error: null });
			return;
		}
		if (data === "v") {
			const warning = this.controller.currentTokenDisconnectWarning();
			this.#openPrompt({
				kind: "revoke-token",
				label: warning
					? `${warning.message}. Current token ${warning.tokenId} requires ${sanitizeCell(warning.publicId)}. Token id|confirmation: `
					: "Token id|confirmation: ",
				value: "",
				masked: false,
				error: null,
			});
			return;
		}
		if (data === "R") {
			this.#openPrompt({
				kind: "rotate-user",
				label: `Type rotate ${sanitizeCell(selected.name)}: `,
				value: "",
				masked: false,
				error: null,
			});
			return;
		}
		if (data === "U") {
			this.#openPrompt({
				kind: "usage-since",
				label: "Usage since timestamp (blank for all): ",
				value: "",
				masked: false,
				error: null,
			});
			return;
		}
		if (data === "a") {
			this.#openAclEffectDialog();
			return;
		}
		if (data === "x") {
			this.#openDeleteAclRulePicker();
			return;
		}
		if (data === "b") {
			void this.#openBindPoolPicker();
			return;
		}
		if (data === "u") {
			void this.#openUnbindPoolPicker();
			return;
		}
		if (data === "]") {
			this.controller.selectUserPoolBinding(this.controller.state.selectedUserPoolBindingIndex + 1);
			return;
		}
		if (data === "[") {
			this.controller.selectUserPoolBinding(this.controller.state.selectedUserPoolBindingIndex - 1);
			return;
		}
		if (data === "+") {
			void this.controller.moveSelectedUserPoolBinding(1);
			return;
		}
		if (data === "-") {
			void this.controller.moveSelectedUserPoolBinding(-1);
		}
	}

	#handlePoolAction(data: string): void {
		const selected = this.controller.selectedPool();
		if (data === "c") {
			this.#openCreatePoolFlow();
			return;
		}
		if (!selected) return;
		if (data === "e") {
			this.#openEditPoolFlow();
			return;
		}
		if (data === "d") {
			this.#openPrompt({
				kind: "delete-pool",
				label: `Type ${sanitizeCell(selected.name)} to delete: `,
				value: "",
				masked: false,
				error: null,
			});
			return;
		}
		if (data === "a") {
			void this.#openAddPoolAccountPicker();
			return;
		}
		if (data === "x") {
			void this.#openRemovePoolAccountPicker();
			return;
		}
		if (data === "]") {
			this.controller.selectPoolMember(this.controller.state.selectedPoolMemberIndex + 1);
			return;
		}
		if (data === "[") {
			this.controller.selectPoolMember(this.controller.state.selectedPoolMemberIndex - 1);
			return;
		}
		if (data === "+") {
			void this.controller.moveSelectedPoolCredential(1);
			return;
		}
		if (data === "-") {
			void this.controller.moveSelectedPoolCredential(-1);
		}
	}

	#handleAccountAction(data: string): void {
		if (data === "s") {
			this.#openCredentialResetConfirmation();
			return;
		}
		if (data === "d") {
			const selected = this.controller.selectedCredential();
			if (!selected) return;
			this.#openPrompt({
				kind: "remove-account",
				label: `Type ${selected.id} to remove: `,
				value: "",
				masked: false,
				error: null,
			});
			return;
		}
		if (data === "c") {
			const identifiers = this.controller.copySelectedCredentialIdentifiers();
			if (!identifiers) return;
			void copyToClipboard(identifiers)
				.then(() => this.controller.setTransientBanner("Copied account identifiers"))
				.catch(error => this.controller.setTransientBanner(error instanceof Error ? error.message : String(error)));
			return;
		}
		if (data === "o") {
			void this.controller.refreshSelectedCredential();
			return;
		}
		if (data === "l") {
			this.#openLoginProviderSelector();
			return;
		}
		if (data === "k") this.#startApiKeyPrompt();
	}

	#openCredentialResetConfirmation(): void {
		const eligibility = this.controller.selectedCredentialResetEligibility();
		if (!eligibility.eligible) {
			this.controller.setTransientBanner(eligibility.reason);
			return;
		}
		const dialog = this.#createFlowDialog();
		dialog.push({
			id: `redeem-reset-${eligibility.account.id}`,
			kind: "choice",
			title: "Spend one saved reset?",
			items: [
				{ value: "no", label: "No", description: "Keep every saved reset" },
				{ value: "yes", label: "Yes", description: "Spend one saved reset now" },
			],
			help: [
				eligibility.label,
				`${eligibility.availableCount} saved reset${eligibility.availableCount === 1 ? "" : "s"} available`,
				"This is scarce and irreversible.",
			],
			onSelect: (value, activeDialog) => {
				if (value !== "yes") {
					activeDialog.close();
					return;
				}
				void this.#redeemCredentialReset(eligibility.label, activeDialog);
			},
		});
	}

	async #redeemCredentialReset(label: string, dialog: AuthGatewayFlowDialog): Promise<void> {
		dialog.setBusy(`Spending one saved reset for ${label}…`);
		const result = await this.controller.redeemSelectedCredentialReset();
		dialog.setBusy(null);
		if (!result) {
			dialog.setError(this.controller.state.errorBanner ?? "Saved reset activation failed");
			return;
		}
		dialog.close();
		this.controller.setTransientBanner(describeRedeemOutcome(result.outcome, result.label));
	}
	#startApiKeyPrompt(): void {
		this.#openPrompt({ kind: "api-key-provider", label: "Provider id: ", value: "", masked: false, error: null });
	}

	#openLoginProviderSelector(): void {
		this.controller.clearTransientBanner();
		this.#loginProviderSelector?.stopValidation();
		this.#loginProviderSelector = new OAuthSelectorComponent(
			"login",
			undefined,
			providerId => {
				this.#loginProviderSelector?.stopValidation();
				this.#loginProviderSelector = null;
				this.controller.setModalOpen(false);
				void this.#runAccountLogin(providerId);
			},
			() => {
				this.#loginProviderSelector?.stopValidation();
				this.#loginProviderSelector = null;
				this.controller.setModalOpen(false);
			},
		);
		this.controller.setModalOpen(true);
	}

	#createFlowDialog(): AuthGatewayFlowDialog {
		this.controller.clearTransientBanner();
		this.#flowDialog?.close();
		const dialog = new AuthGatewayFlowDialog({
			onClose: () => {
				this.#flowDialog = null;
				this.controller.setModalOpen(false);
			},
			requestRender: () => {
				if (!this.#disposed) this.#host.ui.requestRender();
			},
		});
		this.#flowDialog = dialog;
		this.controller.setModalOpen(true);
		return dialog;
	}

	#handoffFlowToOneTimeToken(): void {
		this.#oneTimeDialog = this.controller.state.oneTimeToken
			? createOneTimeTokenDialog(this.controller.state.oneTimeToken)
			: null;
		this.#flowDialog = null;
		this.controller.setModalOpen(true);
	}

	#openCreateUserFlow(): void {
		const dialog = this.#createFlowDialog();
		const draft: CreateUserInput = { name: "", role: "user" };
		dialog.push(
			this.#userNameStep("Create user name", "", value => {
				draft.name = value.trim();
				dialog.push(
					this.#userDescriptionStep("Create user description", "", value => {
						const description = value.trim();
						if (description) draft.description = description;
						else delete draft.description;
						dialog.push(
							this.#userOwnerStep("Create user owner", "", value => {
								const owner = value.trim();
								if (owner) draft.owner = owner;
								else delete draft.owner;
								dialog.push(
									this.#userRoleStep("Create user role", null, role => {
										draft.role = role;
										dialog.push(this.#reviewCreateUserStep(draft));
									}),
								);
							}),
						);
					}),
				);
			}),
		);
	}

	#openEditUserFlow(): void {
		const selected = this.controller.selectedUser();
		if (!selected) return;
		const dialog = this.#createFlowDialog();
		const draft: UpdateUserInput = {
			description: selected.description,
			owner: selected.owner,
			role: selected.role,
		};
		dialog.push(
			this.#userDescriptionStep("Edit user description", selected.description ?? "", value => {
				draft.description = value.trim() || null;
				dialog.push(
					this.#userOwnerStep("Edit user owner", selected.owner ?? "", owner => {
						draft.owner = owner.trim() || null;
						dialog.push(
							this.#userRoleStep("Edit user role", selected.role, role => {
								draft.role = role;
								dialog.push(this.#reviewEditUserStep(draft));
							}),
						);
					}),
				);
			}),
		);
	}

	#userNameStep(title: string, value: string, onSubmit: (value: string) => void): AuthGatewayFlowStep {
		return {
			id: title.toLowerCase().replaceAll(" ", "-"),
			kind: "input",
			title,
			label: "Name: ",
			value,
			help: [NAME_HELP],
			validate: input => {
				const trimmed = input.trim();
				if (!trimmed) return "Name is required";
				return NAME_PATTERN.test(trimmed) ? null : NAME_HELP;
			},
			onSubmit,
		};
	}

	#userDescriptionStep(title: string, value: string, onSubmit: (value: string) => void): AuthGatewayFlowStep {
		return {
			id: title.toLowerCase().replaceAll(" ", "-"),
			kind: "input",
			title,
			label: "Description: ",
			value,
			help: [DESCRIPTION_HELP],
			onSubmit,
		};
	}

	#userOwnerStep(title: string, value: string, onSubmit: (value: string) => void): AuthGatewayFlowStep {
		return {
			id: title.toLowerCase().replaceAll(" ", "-"),
			kind: "input",
			title,
			label: "Owner: ",
			value,
			help: [OWNER_HELP],
			onSubmit,
		};
	}

	#userRoleStep(
		title: string,
		current: "user" | "admin" | null,
		onSelect: (role: "user" | "admin") => void,
	): AuthGatewayFlowStep {
		return {
			id: title.toLowerCase().replaceAll(" ", "-"),
			kind: "choice",
			title,
			items: [
				{ value: "user", label: "User", description: "ACLs and ordered pool bindings apply" },
				{ value: "admin", label: "Admin", description: "Bypasses ACLs and cannot bind pools" },
			],
			help: current ? [`Current role: ${current}`] : ["Choose the user's management role."],
			initialValue: current ?? undefined,
			onSelect: value => onSelect(value === "admin" ? "admin" : "user"),
		};
	}

	#reviewCreateUserStep(input: CreateUserInput): AuthGatewayFlowStep {
		return {
			id: "review-create-user",
			kind: "choice",
			title: "Review user",
			items: [
				{ value: "save", label: "Save user", description: "Create user and show one-time token" },
				{ value: "back", label: "Back", description: "Return to role" },
			],
			help: this.#userReviewHelp(input),
			onSelect: (value, dialog) => {
				if (value === "back") {
					dialog.pop();
					return;
				}
				void this.#submitCreateUser(dialog, input);
			},
		};
	}

	#reviewEditUserStep(input: UpdateUserInput): AuthGatewayFlowStep {
		return {
			id: "review-edit-user",
			kind: "choice",
			title: "Review user",
			items: [
				{ value: "save", label: "Save changes", description: "Update selected user" },
				{ value: "back", label: "Back", description: "Return to role" },
			],
			help: [
				`Description: ${sanitizeCell(input.description ?? "-")}`,
				`Owner: ${sanitizeCell(input.owner ?? "-")}`,
				`Role: ${input.role ?? "user"}`,
			],
			onSelect: (value, dialog) => {
				if (value === "back") {
					dialog.pop();
					return;
				}
				void this.#submitEditUser(dialog, input);
			},
		};
	}

	#userReviewHelp(input: CreateUserInput): string[] {
		return [
			`Name: ${sanitizeCell(input.name)}`,
			`Description: ${sanitizeCell(input.description ?? "-")}`,
			`Owner: ${sanitizeCell(input.owner ?? "-")}`,
			`Role: ${input.role ?? "user"}`,
		];
	}

	async #submitCreateUser(dialog: AuthGatewayFlowDialog, input: CreateUserInput): Promise<void> {
		dialog.setBusy("Saving user…");
		const ok = await this.controller.createUser({ ...input });
		dialog.setBusy(null);
		if (!ok) {
			dialog.setError(this.controller.state.errorBanner ?? "Failed to create user");
			return;
		}
		this.#handoffFlowToOneTimeToken();
	}

	async #submitEditUser(dialog: AuthGatewayFlowDialog, input: UpdateUserInput): Promise<void> {
		dialog.setBusy("Saving user…");
		const ok = await this.controller.updateSelectedUser({ ...input });
		dialog.setBusy(null);
		if (!ok) {
			dialog.setError(this.controller.state.errorBanner ?? "Failed to update user");
			return;
		}
		dialog.close();
	}

	#openCreatePoolFlow(): void {
		const dialog = this.#createFlowDialog();
		const draft: CreatePoolInput = { name: "" };
		dialog.push(
			this.#poolNameStep("Create pool name", "", value => {
				draft.name = value.trim();
				dialog.push(
					this.#poolStrategyStep("Pool strategy", null, strategy => {
						draft.strategy = strategy;
						dialog.push(this.#reviewCreatePoolStep(draft));
					}),
				);
			}),
		);
	}

	#openEditPoolFlow(): void {
		const selected = this.controller.selectedPool();
		if (!selected) return;
		const dialog = this.#createFlowDialog();
		const draft: UpdatePoolInput = { name: selected.name, strategy: selected.strategy };
		dialog.push(
			this.#poolNameStep("Edit pool name", selected.name, value => {
				draft.name = value.trim();
				dialog.push(
					this.#poolStrategyStep("Pool strategy", selected.strategy, strategy => {
						draft.strategy = strategy;
						dialog.push(this.#reviewEditPoolStep(draft));
					}),
				);
			}),
		);
	}

	#poolNameStep(title: string, value: string, onSubmit: (value: string) => void): AuthGatewayFlowStep {
		return {
			id: title.toLowerCase().replaceAll(" ", "-"),
			kind: "input",
			title,
			label: "Name: ",
			value,
			help: [NAME_HELP],
			validate: input => {
				const trimmed = input.trim();
				if (!trimmed) return "Name is required";
				return NAME_PATTERN.test(trimmed) ? null : NAME_HELP;
			},
			onSubmit,
		};
	}

	#poolStrategyStep(
		title: string,
		current: AuthGatewayPoolStrategy | null,
		onSelect: (strategy: AuthGatewayPoolStrategy) => void,
	): AuthGatewayFlowStep {
		return {
			id: "pool-strategy",
			kind: "choice",
			title,
			items: AUTH_GATEWAY_POOL_STRATEGIES.map(strategy => ({
				value: strategy,
				label: strategy,
				description: STRATEGY_DESCRIPTIONS[strategy],
			})),
			help: current ? [`Current strategy: ${current}`] : ["Choose how accounts are selected for this pool."],
			initialValue: current ?? undefined,
			onSelect: value => onSelect(value as AuthGatewayPoolStrategy),
		};
	}

	#reviewCreatePoolStep(input: CreatePoolInput): AuthGatewayFlowStep {
		return {
			id: "review-create-pool",
			kind: "choice",
			title: "Review pool",
			items: [
				{ value: "save", label: "Save pool", description: "Create pool" },
				{ value: "back", label: "Back", description: "Return to strategy" },
			],
			help: this.#poolReviewHelp(input),
			onSelect: (value, dialog) => {
				if (value === "back") {
					dialog.pop();
					return;
				}
				void this.#submitCreatePool(dialog, input);
			},
		};
	}

	#reviewEditPoolStep(input: UpdatePoolInput): AuthGatewayFlowStep {
		return {
			id: "review-edit-pool",
			kind: "choice",
			title: "Review pool",
			items: [
				{ value: "save", label: "Save pool", description: "Update selected pool" },
				{ value: "back", label: "Back", description: "Return to strategy" },
			],
			help: this.#poolReviewHelp(input),
			onSelect: (value, dialog) => {
				if (value === "back") {
					dialog.pop();
					return;
				}
				void this.#submitEditPool(dialog, input);
			},
		};
	}

	#poolReviewHelp(input: CreatePoolInput | UpdatePoolInput): string[] {
		return [`Name: ${sanitizeCell(input.name ?? "-")}`, `Strategy: ${input.strategy ?? "round-robin"}`];
	}

	async #submitCreatePool(dialog: AuthGatewayFlowDialog, input: CreatePoolInput): Promise<void> {
		dialog.setBusy("Saving pool…");
		const ok = await this.controller.createPool({ ...input });
		dialog.setBusy(null);
		if (!ok) {
			dialog.setError(this.controller.state.errorBanner ?? "Failed to create pool");
			return;
		}
		dialog.close();
	}

	async #submitEditPool(dialog: AuthGatewayFlowDialog, input: UpdatePoolInput): Promise<void> {
		dialog.setBusy("Saving pool…");
		const ok = await this.controller.updateSelectedPool({ ...input });
		dialog.setBusy(null);
		if (!ok) {
			dialog.setError(this.controller.state.errorBanner ?? "Failed to update pool");
			return;
		}
		dialog.close();
	}

	async #openBindPoolPicker(): Promise<void> {
		const selected = this.controller.selectedUser();
		if (!selected) return;
		const dialog = this.#createFlowDialog();
		dialog.push(this.#loadingChoiceStep("Bind pool", "Loading pools…"));
		const [details, pools] = await Promise.all([
			this.controller.loadSelectedUserDetails(),
			this.controller.loadPoolChoices(),
		]);
		if (!details || !pools) {
			dialog.setError(this.controller.state.errorBanner ?? "Failed to load pools");
			return;
		}
		const bound = new Set(details.poolBindings.map(binding => binding.poolId));
		const available = pools.filter(pool => !bound.has(pool.id));
		if (available.length === 0) {
			dialog.close();
			this.controller.setTransientBanner("No pools available to bind");
			return;
		}
		dialog.replace(this.#bindPoolPickerStep(available));
	}

	#bindPoolPickerStep(pools: readonly AuthGatewayPool[]): AuthGatewayFlowStep {
		return {
			id: "bind-pool",
			kind: "choice",
			title: "Bind pool",
			items: pools.map(pool => ({
				value: String(pool.id),
				label: sanitizeCell(pool.name),
				description: `${pool.strategy} · ${pool.members.length} accounts`,
			})),
			help: ["Choose a pool to append to this user's ordered bindings."],
			onSelect: (value, dialog) => {
				void this.#bindPool(Number(value), dialog);
			},
		};
	}

	async #bindPool(poolId: number, dialog: AuthGatewayFlowDialog): Promise<void> {
		dialog.setBusy("Binding pool…");
		const ok = await this.controller.bindSelectedUserPool(poolId);
		dialog.setBusy(null);
		if (!ok) {
			dialog.setError(this.controller.state.errorBanner ?? "Failed to bind pool");
			return;
		}
		dialog.close();
	}

	async #openUnbindPoolPicker(): Promise<void> {
		const dialog = this.#createFlowDialog();
		dialog.push(this.#loadingChoiceStep("Unbind pool", "Loading user pools…"));
		const details = await this.controller.loadSelectedUserDetails();
		if (!details) {
			dialog.setError(this.controller.state.errorBanner ?? "Failed to load user pools");
			return;
		}
		const bindings = [...details.poolBindings].sort((left, right) => left.position - right.position);
		if (bindings.length === 0) {
			dialog.close();
			this.controller.setTransientBanner("No pools are bound to this user");
			return;
		}
		dialog.replace(this.#unbindPoolPickerStep(bindings));
	}

	#unbindPoolPickerStep(bindings: readonly AuthGatewayUserPoolBinding[]): AuthGatewayFlowStep {
		return {
			id: "unbind-pool",
			kind: "choice",
			title: "Unbind pool",
			items: bindings.map(binding => ({
				value: String(binding.poolId),
				label: sanitizeCell(binding.pool.name),
				description: `${binding.position + 1}. ${binding.pool.strategy} · ${binding.pool.members.length} accounts`,
			})),
			help: ["Choose a bound pool to remove."],
			onSelect: (value, dialog) => {
				const binding = bindings.find(item => item.poolId === Number(value));
				if (binding) dialog.push(this.#unbindPoolConfirmStep(binding));
			},
		};
	}

	#unbindPoolConfirmStep(binding: AuthGatewayUserPoolBinding): AuthGatewayFlowStep {
		return {
			id: `unbind-pool-${binding.poolId}`,
			kind: "choice",
			title: `Unbind ${sanitizeCell(binding.pool.name)}?`,
			items: [
				{ value: "no", label: "No", description: "Keep this binding" },
				{ value: "yes", label: "Yes", description: "Remove this binding" },
			],
			help: [`${binding.position + 1}. ${binding.pool.name} · ${binding.pool.strategy}`],
			onSelect: (value, dialog) => {
				if (value !== "yes") {
					dialog.pop();
					return;
				}
				void this.#unbindPool(binding, dialog);
			},
		};
	}

	async #unbindPool(binding: AuthGatewayUserPoolBinding, dialog: AuthGatewayFlowDialog): Promise<void> {
		dialog.setBusy("Unbinding pool…");
		const ok = await this.controller.unbindSelectedUserPool(binding.poolId, "y");
		dialog.setBusy(null);
		if (!ok) {
			dialog.setError(this.controller.state.errorBanner ?? "Failed to unbind pool");
			return;
		}
		dialog.close();
	}

	async #openAddPoolAccountPicker(): Promise<void> {
		const selected = this.controller.selectedPool();
		if (!selected) return;
		const dialog = this.#createFlowDialog();
		dialog.push(this.#loadingChoiceStep("Add pool account", "Loading accounts…"));
		const credentials = await this.controller.loadCredentialChoices();
		if (!credentials) {
			dialog.setError(this.controller.state.errorBanner ?? "Failed to load accounts");
			return;
		}
		const memberIds = new Set(selected.members.map(member => member.credentialId));
		const available = credentials.filter(credential => !memberIds.has(credential.id));
		if (available.length === 0) {
			dialog.close();
			this.controller.setTransientBanner("No accounts available to add");
			return;
		}
		dialog.replace(this.#addPoolAccountPickerStep(available));
	}

	#addPoolAccountPickerStep(credentials: readonly AuthGatewayCredentialSummary[]): AuthGatewayFlowStep {
		return {
			id: "add-pool-account",
			kind: "choice",
			title: "Add pool account",
			items: credentials.map(credential => ({
				value: String(credential.id),
				label: accountSummary(credential),
				description: credentialIdentity(credential),
			})),
			help: ["Choose a redacted live account to add."],
			onSelect: (value, dialog) => {
				void this.#addPoolAccount(Number(value), dialog);
			},
		};
	}

	async #addPoolAccount(credentialId: number, dialog: AuthGatewayFlowDialog): Promise<void> {
		dialog.setBusy("Adding pool account…");
		const ok = await this.controller.addSelectedPoolCredential(credentialId);
		dialog.setBusy(null);
		if (!ok) {
			dialog.setError(this.controller.state.errorBanner ?? "Failed to add pool account");
			return;
		}
		dialog.close();
	}

	async #openRemovePoolAccountPicker(): Promise<void> {
		const selected = this.controller.selectedPool();
		if (!selected) return;
		const dialog = this.#createFlowDialog();
		const members = [...selected.members].sort((left, right) => left.position - right.position);
		if (members.length === 0) {
			dialog.close();
			this.controller.setTransientBanner("No accounts are in this pool");
			return;
		}
		dialog.push(this.#removePoolAccountPickerStep(members.map(member => member.credentialId)));
	}

	#removePoolAccountPickerStep(credentialIds: readonly number[]): AuthGatewayFlowStep {
		return {
			id: "remove-pool-account",
			kind: "choice",
			title: "Remove pool account",
			items: credentialIds.map(credentialId => {
				const credential = this.#credentialById(credentialId);
				return {
					value: String(credentialId),
					label: credential ? accountSummary(credential) : `#${credentialId} · unavailable`,
					description: credential ? credentialIdentity(credential) : "Stored member has no live broker row",
				};
			}),
			help: ["Choose an account to remove from this pool."],
			onSelect: (value, dialog) => {
				dialog.push(this.#removePoolAccountConfirmStep(Number(value)));
			},
		};
	}

	#removePoolAccountConfirmStep(credentialId: number): AuthGatewayFlowStep {
		const credential = this.#credentialById(credentialId);
		const label = credential ? accountSummary(credential) : `#${credentialId} · unavailable`;
		return {
			id: `remove-pool-account-${credentialId}`,
			kind: "choice",
			title: `Remove pool account #${credentialId}?`,
			items: [
				{ value: "no", label: "No", description: "Keep this account" },
				{ value: "yes", label: "Yes", description: "Remove this account" },
			],
			help: [label],
			onSelect: (value, dialog) => {
				if (value !== "yes") {
					dialog.pop();
					return;
				}
				void this.#removePoolAccount(credentialId, dialog);
			},
		};
	}

	async #removePoolAccount(credentialId: number, dialog: AuthGatewayFlowDialog): Promise<void> {
		dialog.setBusy(`Removing pool account #${credentialId}…`);
		const ok = await this.controller.removeSelectedPoolCredential(credentialId, "y");
		dialog.setBusy(null);
		if (!ok) {
			dialog.setError(this.controller.state.errorBanner ?? "Failed to remove pool account");
			return;
		}
		dialog.close();
	}

	#credentialById(credentialId: number): AuthGatewayCredentialSummary | null {
		return this.controller.state.accounts.data.find(credential => credential.id === credentialId) ?? null;
	}

	#loadingChoiceStep(title: string, label: string): AuthGatewayFlowStep {
		return {
			id: `${title.toLowerCase().replaceAll(" ", "-")}-loading`,
			kind: "choice",
			title,
			items: [{ value: "loading", label }],
			help: [label],
			onSelect: () => {},
		};
	}

	#openAclEffectDialog(): void {
		const dialog = this.#createFlowDialog();
		dialog.push(this.#aclEffectStep());
	}

	#aclEffectStep(): AuthGatewayFlowStep {
		return {
			id: "acl-effect",
			kind: "choice",
			title: "Add ACL effect",
			items: [
				{ value: "allow", label: "Allow", description: "Permit matching requests" },
				{ value: "deny", label: "Deny", description: "Block matching requests" },
			],
			help: ["Choose whether matching requests are allowed or denied."],
			onSelect: (value, dialog) => dialog.push(this.#aclKindStep(value as AuthGatewayAclEffect)),
		};
	}

	#aclKindStep(effect: AuthGatewayAclEffect): AuthGatewayFlowStep {
		return {
			id: "acl-kind",
			kind: "choice",
			title: "Add ACL kind",
			items: [
				{ value: "provider", label: "Provider", description: "Match provider ids" },
				{ value: "model", label: "Model", description: "Match provider/model selectors" },
				{ value: "route", label: "Route", description: "Match gateway route families" },
			],
			help: ["Choose what this ACL rule matches."],
			onSelect: (value, dialog) => {
				void this.#openAclPatternStep(effect, value as AuthGatewayAclKind, dialog);
			},
		};
	}

	async #openAclPatternStep(
		effect: AuthGatewayAclEffect,
		kind: AuthGatewayAclKind,
		dialog: AuthGatewayFlowDialog,
	): Promise<void> {
		if (kind === "route") {
			dialog.push(this.#aclRoutePatternStep(effect));
			return;
		}
		dialog.setBusy("Loading ACL suggestions…");
		const suggestions = await this.controller.loadAclSuggestions();
		dialog.setBusy(null);
		if (!suggestions) {
			dialog.setError(this.controller.state.errorBanner ?? "Failed to load ACL suggestions");
			return;
		}
		dialog.push(this.#aclCatalogPatternStep(effect, kind, suggestions));
	}

	#aclCatalogPatternStep(
		effect: AuthGatewayAclEffect,
		kind: "provider" | "model",
		suggestions: { providers: string[]; models: { id: string; provider: string }[] },
	): AuthGatewayFlowStep {
		const items = kind === "provider" ? this.#providerAclItems(suggestions) : this.#modelAclItems(suggestions);
		return {
			id: `acl-${kind}-pattern`,
			kind: "choice",
			title: `Add ACL ${kind} pattern`,
			items,
			help:
				kind === "provider"
					? ["Choose a provider id, wildcard, or custom pattern."]
					: ["Choose a provider wildcard, exact model, or custom pattern."],
			onSelect: (value, dialog) => {
				if (value === "__custom") {
					dialog.push(this.#aclCustomPatternStep(effect, kind));
					return;
				}
				void this.#submitAclRules(dialog, [{ effect, kind, pattern: value }]);
			},
		};
	}

	#providerAclItems(suggestions: { providers: string[]; models: { provider: string }[] }): SelectItem[] {
		const providers = new Set<string>(suggestions.providers);
		for (const model of suggestions.models) providers.add(model.provider);
		return [
			{ value: "*", label: "*", description: "Match every provider" },
			...[...providers].sort().map(provider => ({
				value: provider,
				label: provider,
				description: "Provider id",
			})),
			{ value: "__custom", label: "Custom pattern…", description: "Type a provider pattern" },
		];
	}

	#modelAclItems(suggestions: { models: { id: string; provider: string }[] }): SelectItem[] {
		const providers = [...new Set(suggestions.models.map(model => model.provider))].sort();
		const exact = suggestions.models
			.map(model => `${model.provider}/${model.id}`)
			.sort((left, right) => left.localeCompare(right));
		return [
			{ value: "*", label: "*", description: "Match every model" },
			...providers.map(provider => ({
				value: `${provider}/*`,
				label: `${provider}/*`,
				description: "Provider model wildcard",
			})),
			...exact.map(pattern => ({ value: pattern, label: pattern, description: "Exact model" })),
			{ value: "__custom", label: "Custom pattern…", description: "Type a model pattern" },
		];
	}

	#aclRoutePatternStep(effect: AuthGatewayAclEffect): AuthGatewayFlowStep {
		return {
			id: "acl-route-pattern",
			kind: "choice",
			title: "Add ACL route pattern",
			items: [
				{
					value: "__basic",
					label: "Basic routes",
					description: AUTH_GATEWAY_BASIC_ROUTES.join(", "),
				},
				{ value: "*", label: "All routes (*)", description: "Match every route" },
				...AUTH_GATEWAY_ACL_ROUTES.map(route => ({ value: route, label: route, description: "Route family" })),
			],
			help: ["Choose a canonical route family."],
			onSelect: (value, dialog) => {
				const rules =
					value === "__basic"
						? AUTH_GATEWAY_BASIC_ROUTES.map(pattern => ({ effect, kind: "route" as const, pattern }))
						: [{ effect, kind: "route" as const, pattern: value }];
				void this.#submitAclRules(dialog, rules);
			},
		};
	}

	#aclCustomPatternStep(effect: AuthGatewayAclEffect, kind: "provider" | "model"): AuthGatewayFlowStep {
		return {
			id: `acl-${kind}-custom`,
			kind: "input",
			title: `Add ACL ${kind} pattern`,
			label: `ACL ${kind} pattern: `,
			value: "",
			help: ["Enter a pattern accepted by the auth gateway."],
			validate: value => (value.trim() ? null : "ACL pattern is required"),
			onSubmit: (value, dialog) => {
				void this.#submitAclRules(dialog, [{ effect, kind, pattern: value.trim() }]);
			},
		};
	}

	async #submitAclRules(dialog: AuthGatewayFlowDialog, rules: AddAclRuleInput[]): Promise<void> {
		dialog.setBusy("Adding ACL rules…");
		const ok = await this.controller.addSelectedUserAclRules(rules);
		dialog.setBusy(null);
		if (!ok) {
			dialog.setError(this.controller.state.errorBanner ?? "Invalid ACL input");
			return;
		}
		dialog.close();
	}

	#openDeleteAclRulePicker(): void {
		const selected = this.controller.selectedUser();
		const details = selected ? this.controller.state.userDetails[selected.id] : null;
		if (details) {
			const dialog = this.#createFlowDialog();
			if (details.acl.length === 0) {
				dialog.close();
				this.controller.setTransientBanner("No ACL rules to delete");
				return;
			}
			dialog.push(this.#deleteAclRulePickerStep(details.acl));
			return;
		}
		void this.#openDeleteAclRulePickerAsync();
	}

	async #openDeleteAclRulePickerAsync(): Promise<void> {
		const dialog = this.#createFlowDialog();
		dialog.push(this.#deleteAclRulePickerStep([]));
		dialog.setBusy("Loading ACL rules…");
		const details = await this.controller.loadSelectedUserDetails();
		dialog.setBusy(null);
		if (!details) {
			dialog.setError(this.controller.state.errorBanner ?? "Failed to load ACL rules");
			return;
		}
		if (details.acl.length === 0) {
			dialog.close();
			this.controller.setTransientBanner("No ACL rules to delete");
			return;
		}
		dialog.replace(this.#deleteAclRulePickerStep(details.acl));
	}

	#deleteAclRulePickerStep(rules: readonly AuthGatewayAclRule[]): AuthGatewayFlowStep {
		return {
			id: "delete-acl-picker",
			kind: "choice",
			title: "Delete ACL rule",
			items: rules.map(rule => ({
				value: String(rule.id),
				label: `#${rule.id}`,
				description: `${rule.effect} ${rule.kind} ${rule.pattern}`,
			})),
			help: ["Choose an ACL rule to delete."],
			onSelect: (value, dialog) => {
				const ruleId = Number(value);
				const rule = rules.find(candidate => candidate.id === ruleId);
				if (rule) dialog.push(this.#deleteAclConfirmStep(rule));
			},
		};
	}

	#deleteAclConfirmStep(rule: AuthGatewayAclRule): AuthGatewayFlowStep {
		return {
			id: `delete-acl-${rule.id}`,
			kind: "choice",
			title: `Delete ACL rule #${rule.id}?`,
			items: [
				{ value: "no", label: "No", description: "Keep this ACL rule" },
				{ value: "yes", label: "Yes", description: "Delete this ACL rule" },
			],
			help: [`${rule.effect} ${rule.kind} ${rule.pattern}`],
			onSelect: (value, dialog) => {
				if (value !== "yes") {
					dialog.pop();
					return;
				}
				void this.#deleteAclRule(rule, dialog);
			},
		};
	}

	async #deleteAclRule(rule: AuthGatewayAclRule, dialog: AuthGatewayFlowDialog): Promise<void> {
		dialog.setBusy(`Deleting ACL rule #${rule.id}…`);
		const ok = await this.controller.deleteSelectedUserAcl(rule.id);
		dialog.setBusy(null);
		if (!ok) {
			dialog.setError(this.controller.state.errorBanner ?? "Failed to delete ACL rule");
			return;
		}
		if (this.controller.state.errorBannerSource === "visible-load") {
			dialog.close();
			return;
		}
		const selected = this.controller.selectedUser();
		const rules = selected ? (this.controller.state.userDetails[selected.id]?.acl ?? []) : [];
		if (rules.length === 0) {
			dialog.close();
			this.controller.setTransientBanner(`Deleted ACL rule #${rule.id}`);
			return;
		}
		dialog.pop();
		dialog.replace(this.#deleteAclRulePickerStep(rules));
	}

	#cancelAccountLogin(): void {
		this.#loginGeneration++;
		this.#accountLogin?.abort();
		this.#accountLogin = null;
		this.controller.setModalOpen(false);
	}

	async #switchTab(tab: AuthGatewayConsoleTab): Promise<void> {
		this.#mode = "list";
		this.#loginProviderSelector?.stopValidation();
		this.#loginProviderSelector = null;
		this.#flowDialog?.close();
		this.#clearPrompt();
		await this.controller.switchTab(tab);
	}

	#handlePromptInput(data: string): void {
		const prompt = this.#prompt;
		if (!prompt) return;
		if (prompt.busy) return;
		if (data === "\x1b") {
			this.#clearPrompt();
			return;
		}
		if (data === "\x03") {
			this.#clearPrompt();
			return;
		}
		if (data === "\n" || data === "\r") {
			void this.#submitPrompt(prompt);
			return;
		}
		if (data === "\x7f" || data === "\b") {
			prompt.value = prompt.value.slice(0, -1);
			return;
		}
		if (data === "\x15") {
			prompt.value = "";
			return;
		}
		const printable = printablePromptInput(data);
		if (!printable) return;
		prompt.value += printable;
	}

	async #submitPrompt(prompt: PromptState): Promise<void> {
		if (prompt.busy) return;
		prompt.error = null;
		if (prompt.kind === "filter") {
			if (this.controller.state.activeTab === "audit") this.controller.setAuditTextFilter(prompt.value);
			else this.controller.setFilter(prompt.value);
			this.#clearPrompt();
			return;
		}
		if (prompt.kind === "audit-user-filter") {
			const value = prompt.value.trim();
			if (value === "") {
				await this.controller.setAuditUserFilter(null);
				if (this.#prompt !== prompt) return;
				this.#clearPrompt();
				return;
			}
			const userId = Number(value);
			if (!Number.isInteger(userId) || userId <= 0) {
				prompt.error = "Invalid user id";
				return;
			}
			await this.controller.setAuditUserFilter(userId);
			if (this.#prompt !== prompt) return;
			this.#clearPrompt();
			return;
		}
		if (prompt.kind === "switch-connection") {
			const name = prompt.value.trim();
			if (!name) {
				prompt.error = "Connection name required";
				return;
			}
			prompt.value = "";
			prompt.busy = "Switching connection…";
			if (!this.#disposed) this.#host.ui.requestRender();
			const error = await this.#switchConnection(name);
			if (this.#prompt !== prompt) return;
			if (error === null) {
				this.#clearPrompt();
				return;
			}
			prompt.busy = null;
			prompt.error = error;
			prompt.value = "";
			this.controller.setModalOpen(true);
			if (!this.#disposed) this.#host.ui.requestRender();
			return;
		}
		if (prompt.kind === "usage-since") {
			const value = prompt.value.trim();
			const since = value === "" ? undefined : Number(value);
			const ok = await this.controller.reloadSelectedUserUsage(since);
			if (this.#prompt !== prompt) return;
			if (!ok) {
				prompt.error = "Invalid usage timestamp";
				return;
			}
			this.#clearPrompt();
			return;
		}
		if (prompt.kind === "toggle-user") {
			const selected = this.controller.selectedUser();
			const ok = selected ? await this.controller.setSelectedUserEnabled(!selected.enabled, prompt.value) : false;
			if (this.#prompt !== prompt) return;
			if (!ok) {
				prompt.error = "Confirmation did not match";
				return;
			}
			this.#clearPrompt();
			return;
		}
		if (prompt.kind === "delete-user") {
			const ok = await this.controller.deleteSelectedUser(prompt.value);
			if (this.#prompt !== prompt) return;
			if (!ok) {
				prompt.error = "Confirmation did not match";
				return;
			}
			this.#clearPrompt();
			return;
		}
		if (prompt.kind === "create-token") {
			prompt.busy = "Creating token…";
			const ok = await this.controller.createSelectedUserToken(prompt.value.trim());
			if (this.#prompt !== prompt) return;
			if (!ok) {
				prompt.error = this.controller.state.errorBanner ?? "No selected user";
				prompt.busy = null;
				this.controller.clearTransientBanner();
				return;
			}
			this.#oneTimeDialog = this.controller.state.oneTimeToken
				? createOneTimeTokenDialog(this.controller.state.oneTimeToken)
				: null;
			this.#prompt = null;
			return;
		}
		if (prompt.kind === "revoke-token") {
			const [tokenId, confirmation] = prompt.value.split("|").map(item => item.trim());
			const ok = await this.controller.revokeSelectedUserToken(Number(tokenId), confirmation ?? "");
			if (this.#prompt !== prompt) return;
			if (!ok) {
				prompt.error = "Confirmation did not match";
				return;
			}
			this.#clearPrompt();
			return;
		}
		if (prompt.kind === "rotate-user") {
			prompt.busy = "Rotating tokens…";
			const ok = await this.controller.rotateSelectedUserTokens(prompt.value);
			if (this.#prompt !== prompt) return;
			if (!ok) {
				prompt.error = this.controller.state.errorBanner ?? "Confirmation did not match";
				prompt.busy = null;
				this.controller.clearTransientBanner();
				return;
			}
			this.#oneTimeDialog = this.controller.state.oneTimeToken
				? createOneTimeTokenDialog(this.controller.state.oneTimeToken)
				: null;
			this.#prompt = null;
			return;
		}
		if (prompt.kind === "delete-pool") {
			const ok = await this.controller.deleteSelectedPool(prompt.value);
			if (this.#prompt !== prompt) return;
			if (!ok) {
				prompt.error = "Confirmation did not match";
				return;
			}
			this.#clearPrompt();
			return;
		}
		if (prompt.kind === "remove-account") {
			const ok = await this.controller.removeSelectedCredential(prompt.value);
			if (this.#prompt !== prompt) return;
			if (!ok) prompt.error = this.controller.state.errorBanner ?? "Confirmation did not match";
			else this.#clearPrompt();
			return;
		}
		if (prompt.kind === "api-key-provider") {
			this.#openPrompt({
				kind: "api-key-value",
				label: "API key: ",
				value: "",
				masked: true,
				error: null,
				provider: prompt.value.trim(),
			});
			return;
		}
		if (prompt.kind === "api-key-value") {
			const provider = prompt.provider ?? "";
			const key = prompt.value;
			prompt.value = "";
			await this.controller.uploadApiKey(provider, key);
			if (this.#prompt !== prompt) return;
			this.#clearPrompt();
			return;
		}
	}

	#openPrompt(prompt: Omit<PromptState, "busy">): void {
		this.controller.clearTransientBanner();
		this.#prompt = { ...prompt, busy: null };
		this.controller.setModalOpen(true);
	}

	#clearPrompt(): void {
		if (this.#prompt) this.#prompt.value = "";
		this.#prompt = null;
		this.controller.setModalOpen(false);
	}

	async #runAccountLogin(provider: string): Promise<void> {
		const generation = ++this.#loginGeneration;
		const login = new AuthGatewayAccountLoginController({
			openInBrowser: url => {
				if (!this.#disposed && generation === this.#loginGeneration) this.#host.openInBrowser(url);
			},
			requestRender: () => {
				if (!this.#disposed && generation === this.#loginGeneration) this.#host.ui.requestRender();
			},
		});
		this.#accountLogin = login;
		this.controller.setModalOpen(true);
		const result = await uploadAcquiredAuthGatewayCredential({
			provider,
			client: this.#client,
			controller: login.oauthController,
		});
		if (this.#disposed || generation !== this.#loginGeneration || this.#accountLogin !== login) return;
		this.#accountLogin = null;
		if (result.ok) await this.controller.refresh();
		else this.controller.setTransientBanner(result.message);
		this.controller.setModalOpen(false);
	}

	#createController(
		connection: ResolvedAuthGatewayConnection,
		client: AuthGatewayAdminClient,
	): AuthGatewayConsoleController {
		return new AuthGatewayConsoleController({
			connection,
			client,
			requestRender: () => {
				if (!this.#disposed) this.#host.ui.requestRender();
			},
			onDisconnect: () => this.#host.close(),
		});
	}

	async #switchConnection(name: string): Promise<string | null> {
		let nextConnection: ResolvedAuthGatewayConnection | null = null;
		try {
			nextConnection = await this.#profileStore.resolve(name);
			if (this.#disposed) return null;
			const nextClient = this.#createClient(nextConnection);
			await nextClient.status(new AbortController().signal);
			if (this.#disposed) return null;
			this.#loginGeneration++;
			this.#accountLogin?.abort();
			this.#accountLogin = null;
			this.#loginProviderSelector?.stopValidation();
			this.#loginProviderSelector = null;
			this.#flowDialog?.close();
			this.controller.close();
			this.#connection = nextConnection;
			this.#client = nextClient;
			this.controller = this.#createController(nextConnection, nextClient);
			this.#mode = "list";
			this.#help = false;
			await this.controller.start();
			return null;
		} catch (error) {
			return this.#disposed ? null : this.#switchConnectionError(error, nextConnection);
		}
	}

	#switchConnectionError(error: unknown, nextConnection: ResolvedAuthGatewayConnection | null): string {
		const secrets = [this.#connection.token, nextConnection?.token ?? ""];
		let message = error instanceof Error ? error.message : String(error);
		for (const secret of secrets) {
			if (secret) message = message.split(secret).join("[redacted]");
		}
		return `Switch connection failed: ${sanitizeCell(message)}`;
	}

	async #handleTokenDialogInput(data: string): Promise<void> {
		const dialog = this.#oneTimeDialog;
		if (!dialog) return;
		if (data === "y") await copyOneTimeTokenDialogValue(dialog);
		if (data === "\n" || data === "\r" || data === "\x1b") {
			closeOneTimeTokenDialog(dialog);
			this.#oneTimeDialog = null;
			this.controller.closeOneTimeToken();
		}
	}

	#handleMouse(data: string): void {
		const event = parseSgrMouse(data);
		if (!event) return;
		const innerCol = event.col - 2;
		if (this.#loginProviderSelector) {
			const line = event.row - this.#bodyRowStart - this.#loginProviderBodyLineStart;
			this.#loginProviderSelector.routeMouse(event, line, innerCol);
			return;
		}
		if (this.#flowDialog) {
			const line = event.row - this.#bodyRowStart - this.#flowDialogBodyLineStart;
			this.#flowDialog.routeMouse(event, line, innerCol);
			return;
		}
		const tabLine = event.row - this.#tabRowStart;
		if (tabLine >= 0 && tabLine < this.#tabRowCount && event.leftClick) {
			const tab = this.#tabBar.tabAt(tabLine, innerCol);
			if (tab) void this.#switchTab(tab.id as AuthGatewayConsoleTab);
			return;
		}
		this.#handleBodyMouse(event, innerCol);
	}

	#handleBodyMouse(event: SgrMouseEvent, innerCol: number): void {
		const line = event.row - this.#bodyRowStart;
		if (line < 0 || !event.leftClick) return;
		if (line >= 0) {
			if (this.controller.state.activeTab === "pools" && this.#mode === "detail") {
				const memberIndex = line - 9;
				if (memberIndex >= 0) {
					this.controller.selectPoolMember(memberIndex);
					return;
				}
			}
			if (this.controller.state.activeTab === "overview") return;
			if (this.#listItemBodyLineCount <= 0 || innerCol < 0 || innerCol >= this.#listItemBodyColumnEnd) return;
			const tab = this.controller.state.activeTab;
			const index = line - this.#listItemBodyLineStart;
			if (index < 0 || index >= this.#listItemBodyLineCount) return;
			const target = index;
			while (this.controller.state.selected[tab] < target) {
				const before = this.controller.state.selected[tab];
				this.controller.selectNext();
				if (this.controller.state.selected[tab] === before) break;
			}
			while (this.controller.state.selected[tab] > target) {
				const before = this.controller.state.selected[tab];
				this.controller.selectPrevious();
				if (this.controller.state.selected[tab] === before) break;
			}
		}
	}

	#bodyLines(width: number, rows: number, outerWidth: number): string[] {
		const lines: string[] = [];
		this.#listItemBodyLineStart = 2;
		this.#listItemBodyLineCount = 0;
		this.#listItemBodyColumnEnd = 0;
		this.#loginProviderBodyLineStart = 0;
		this.#flowDialogBodyLineStart = 0;
		const state = this.controller.state;
		lines.push(this.#statusLine(width));
		if (state.errorBanner) lines.push(...wrapFreeform(state.errorBanner, width, "error"));
		if (this.#help) return fitRows([...lines, ...this.#helpLines(width)], rows, width);
		if (this.#oneTimeDialog) return fitRows([...lines, ...this.#tokenDialogLines(width)], rows, width);
		if (this.#loginProviderSelector) {
			this.#loginProviderBodyLineStart = lines.length;
			return fitRows([...lines, ...this.#loginProviderSelector.render(width)], rows, width);
		}
		if (this.#flowDialog) {
			this.#flowDialogBodyLineStart = lines.length;
			return fitRows([...lines, ...this.#flowDialog.render(width)], rows, width);
		}
		if (this.#prompt) return fitRows([...lines, ...this.#promptLines(width)], rows, width);
		if (this.#accountLogin) return fitRows([...lines, ...this.#accountLoginLines(width)], rows, width);
		const content = this.#contentLines(width, outerWidth);
		const listVisible =
			state.activeTab !== "overview" && !(outerWidth >= 60 && outerWidth < 100 && this.#mode === "detail");
		if (listVisible) {
			this.#listItemBodyLineStart = lines.length + 1;
			this.#listItemBodyLineCount = this.#visibleListItemCount();
			this.#listItemBodyColumnEnd = outerWidth >= 100 ? Math.floor(width * 0.45) : width;
		}
		return fitRows([...lines, ...content], rows, width);
	}

	#statusLine(width: number): string {
		const state = this.controller.state;
		const status =
			state.health === "Connected"
				? theme.fg("success", `${theme.status.success} Connected`)
				: state.health === "Stale"
					? theme.fg("warning", `${theme.status.warning} Stale`)
					: theme.fg("error", `${theme.status.error} Error`);
		const filterParts: string[] = [];
		const filterWidth = Math.max(8, Math.floor(width / 4));
		if (
			(state.activeTab === "users" || state.activeTab === "pools" || state.activeTab === "accounts") &&
			state.filter.length > 0
		) {
			filterParts.push(`filter: ${truncateToWidth(sanitizeCell(state.filter), filterWidth)}`);
		}
		if (state.activeTab === "audit") {
			if (state.audit.textFilter.length > 0) {
				filterParts.push(`text: ${truncateToWidth(sanitizeCell(state.audit.textFilter), filterWidth)}`);
			}
			if (state.audit.userFilter !== null) filterParts.push(`user: ${state.audit.userFilter}`);
		}
		const filterDetail = filterParts.length > 0 ? ` · ${filterParts.join(" · ")}` : "";
		const detail = ` ${sanitizeCell(state.connectionName)} · ${state.activeTab}${filterDetail} · ${status}`;
		return truncateToWidth(detail, width);
	}

	#contentLines(width: number, outerWidth: number): string[] {
		if (this.controller.state.activeTab === "overview") return this.#overviewLines(width);
		const list = this.#listLines(Math.max(24, Math.floor(width * 0.45)));
		const detail = this.#detailLines(Math.max(20, width - Math.floor(width * 0.45) - 3));
		if (outerWidth >= 100) return twoColumns(list, detail, width);
		if (outerWidth >= 60) {
			if (this.#mode === "detail")
				return [theme.bold("Detail view"), ...detail, theme.fg("dim", "Esc back to list")];
			return [...list, theme.fg("dim", "Press Enter for details")];
		}
		return list.map(line => truncateToWidth(line, width));
	}

	#overviewLines(width: number): string[] {
		const status = this.controller.state.overview.data;
		if (this.controller.state.overview.status === "loading" && !status) return ["Loading overview..."];
		if (!status) return ["No overview loaded."];
		return [
			theme.bold("Overview"),
			`Version: ${sanitizeCell(status.version)}`,
			`Server time: ${new Date(status.serverTime).toISOString()}`,
			`Principal: ${sanitizeCell(status.principal.name)} (${status.principal.role})`,
			`Counts: users ${status.counts.users} · tokens ${status.counts.activeTokens} · pools ${status.counts.pools} · accounts ${status.counts.credentials}`,
			`Active connection: ${sanitizeCell(this.controller.state.connectionName)}`,
			`Last refresh: ${formatTime(this.controller.state.overview.lastUpdatedAt)}`,
			theme.fg("dim", "r refresh · s switch connection"),
		].map(line => truncateToWidth(line, width));
	}

	#listLines(width: number): string[] {
		const tab = this.controller.state.activeTab;
		if (tab === "users") return this.#usersList(width);
		if (tab === "pools") return this.#poolsList(width);
		if (tab === "accounts") return this.#accountsList(width);
		return this.#auditList(width);
	}

	#visibleListItemCount(): number {
		const tab = this.controller.state.activeTab;
		if (tab === "users") return this.controller.filteredUsers().length;
		if (tab === "pools") return this.controller.filteredPools().length;
		if (tab === "accounts") return this.controller.filteredCredentials().length;
		if (tab === "audit") return this.controller.filteredAuditEvents().length;
		return 0;
	}

	#usersList(width: number): string[] {
		const users = this.controller.filteredUsers();
		if (this.controller.state.users.status === "loading" && users.length === 0) return ["Loading users..."];
		if (users.length === 0) return ["No users found"];
		return [
			theme.bold("Users"),
			...users.map((item, index) =>
				selectedLine(
					index === this.controller.state.selected.users,
					`${item.name} · ${item.role} · ${item.enabled ? "enabled" : "disabled"}`,
					width,
				),
			),
			theme.fg(
				"dim",
				"c create · e edit · t enable/disable · T token · v revoke · a/x ACL · b/u pool · d delete · R rotate",
			),
		];
	}

	#poolsList(width: number): string[] {
		const pools = this.controller.filteredPools();
		if (this.controller.state.pools.status === "loading" && pools.length === 0) return ["Loading pools..."];
		if (pools.length === 0) return ["No pools found"];
		return [
			theme.bold("Pools"),
			...pools.map((item, index) =>
				selectedLine(
					index === this.controller.state.selected.pools,
					`${item.name} · ${item.strategy} · ${item.members.length} accounts`,
					width,
				),
			),
			theme.fg("dim", "c create · e edit · d delete · a/x account · [/]/+/- selected account"),
		];
	}

	#accountsList(width: number): string[] {
		const accounts = this.controller.filteredCredentials();
		if (this.controller.state.accounts.status === "loading" && accounts.length === 0) return ["Loading accounts..."];
		if (accounts.length === 0) return ["No accounts found"];
		const resetEligibility = this.controller.selectedCredentialResetEligibility();
		return [
			theme.bold("Accounts"),
			...accounts.map((item, index) =>
				selectedLine(
					index === this.controller.state.selected.accounts,
					`${accountSummary(item)}${accountUsageListSuffix(this.controller.state.accountUsage[item.id])}`,
					width,
				),
			),
			theme.fg("dim", "l local login · k add API key · c copy identifiers · o refresh OAuth · d remove"),
			...(resetEligibility.eligible ? [theme.fg("dim", "s spend reset (confirmation required)")] : []),
		];
	}

	#auditList(width: number): string[] {
		const events = this.controller.filteredAuditEvents();
		if (this.controller.state.audit.status === "loading" && events.length === 0) return ["Loading audit..."];
		if (events.length === 0) return ["No audit events found"];
		return [
			theme.bold("Audit"),
			...events.map((item, index) =>
				selectedLine(
					index === this.controller.state.selected.audit,
					`${item.requestId} · ${item.method} ${item.path} · ${item.outcome}`,
					width,
				),
			),
			theme.fg("dim", "u user filter · n next page · p previous page · / local text filter · no delete/export"),
		];
	}

	#detailLines(width: number): string[] {
		const tab = this.controller.state.activeTab;
		if (tab === "users") return this.#userDetail(width);
		if (tab === "pools") return this.#poolDetail(width);
		if (tab === "accounts") return this.#accountDetail(width);
		return this.#auditDetail(width);
	}

	#userDetail(width: number): string[] {
		const selected = this.controller.selectedUser();
		if (!selected) return ["No user selected"];
		const details = this.controller.state.userDetails[selected.id];
		const usage = this.controller.state.userUsage[selected.id];
		const lines = [
			theme.bold("Details"),
			`Name: ${sanitizeCell(selected.name)}`,
			`Role: ${selected.role}`,
			`Owner: ${sanitizeCell(selected.owner ?? "-")}`,
			`Description: ${sanitizeCell(selected.description ?? "-")}`,
			`Tokens: ${details?.tokens.length ?? 0}`,
			...(details?.tokens.map(item => `  token ${item.id} · ${sanitizeCell(item.publicId)}`) ?? []),
			`ACL rules: ${details?.acl.length ?? 0}`,
			...(details?.acl.map(item => `  acl ${item.id} · ${item.effect} ${item.kind} ${sanitizeCell(item.pattern)}`) ??
				[]),
			`Pools: ${details?.poolBindings.length ?? 0}`,
			...(details?.poolBindings
				.slice()
				.sort((left, right) => left.position - right.position)
				.map((binding, index) =>
					selectedLine(
						index === this.controller.state.selectedUserPoolBindingIndex,
						`${binding.position + 1}. ${sanitizeCell(binding.pool.name)} · ${binding.pool.strategy} · ${binding.pool.members.length} accounts`,
						width,
					),
				) ?? []),
			`Usage requests: ${usage?.totals.requests ?? 0}`,
		];
		return lines.map(line => truncateToWidth(line, width));
	}

	#poolDetail(width: number): string[] {
		const selected = this.controller.selectedPool();
		if (!selected) return ["No pool selected"];
		const users = this.controller.state.poolUsers[selected.id] ?? [];
		const members = [...selected.members].sort((left, right) => left.position - right.position);
		const lines = [
			theme.bold("Details"),
			`Name: ${sanitizeCell(selected.name)}`,
			`Strategy: ${selected.strategy}`,
			"Accounts:",
			...(members.length === 0
				? ["  none"]
				: members.map((member, index) => {
						const credential = this.#credentialById(member.credentialId);
						const label = credential ? accountSummary(credential) : `#${member.credentialId} · unavailable`;
						return selectedLine(index === this.controller.state.selectedPoolMemberIndex, label, width);
					})),
			`Bound users: ${users.map(item => sanitizeCell(item.name)).join(", ") || "none"}`,
			theme.fg("dim", "[/] select account · +/- move selected account"),
		];
		return lines.map(line => truncateToWidth(line, width));
	}

	#accountDetail(width: number): string[] {
		const selected = this.controller.selectedCredential();
		if (!selected) return ["No account selected"];
		const lines = [
			theme.bold("Details"),
			...this.#accountUsageLines(selected, width),
			`ID: ${selected.id}`,
			`Provider: ${sanitizeCell(selected.provider)}`,
			`Type: ${selected.type}`,
			`Identity: ${sanitizeCell(selected.identityKey ?? selected.email ?? selected.accountId ?? "-")}`,
			selected.type === "api_key" ? "Remove and add a new key to rotate" : "OAuth credentials can be refreshed",
			"Copyable: account id, email, project id, API endpoint",
		];
		return lines.map(line => truncateToWidth(line, width));
	}

	#accountUsageLines(account: AuthGatewayCredentialSummary, width: number): string[] {
		const usage = this.controller.state.accountUsage[account.id];
		if (!usage || this.controller.state.accountUsageReports.status === "loading") return ["Usage: loading"];
		if (usage.kind === "unavailable") return [`Usage: unavailable — ${sanitizeCell(usage.message)}`];
		if (usage.kind === "unreported") return [`Usage: ${sanitizeCell(usage.message)}`];
		const reports = this.controller.state.accountUsageReports;
		const lines = ["Usage"];
		if (reports.stale && reports.error) lines.push(`  Usage refresh unavailable — ${sanitizeCell(reports.error)}`);
		lines.push(
			...formatUsageReportLines(usage.report, {
				reports: reports.data.filter(report => report.provider === usage.report.provider),
			}),
		);
		return wrapAnsiDetailLines(lines, width);
	}

	#auditDetail(width: number): string[] {
		const selected = this.controller.selectedAuditEvent();
		if (!selected) return ["No audit event selected"];
		const lines = [
			theme.bold("Details"),
			`Request: ${sanitizeCell(selected.requestId)}`,
			`User: ${sanitizeCell(selected.userName ?? "-")}`,
			`Path: ${sanitizeCell(selected.path)}`,
			`Outcome: ${selected.outcome}`,
			`Status: ${selected.statusCode}`,
			`Tokens: ${selected.totalTokens}`,
			`Cost: ${selected.costUsd}`,
		];
		return lines.map(line => truncateToWidth(line, width));
	}

	#helpLines(width: number): string[] {
		return [
			theme.bold("Help"),
			"Overview: status, principal, counts, switch connection, refresh",
			"Users: c guided create, e guided edit, t enable/disable, U usage since, T token, v revoke token, a/x ACL, b/u pool pickers, [/] select pool, +/- reorder pools, d delete, R rotate",
			"Pools: c guided create, e guided edit, d delete, a add account picker, x remove account picker, [/] select account, +/- reorder",
			"Accounts: redacted list, c copy identifiers, local login, masked API-key add, OAuth refresh, remove",
			"Audit: newest-first pages, user filter, text filter, detail inspector",
			"Destructive actions require typed confirmation or y/N; self-disconnect uses disconnect <name>.",
		].map(line => truncateToWidth(line, width));
	}

	#promptLines(width: number): string[] {
		const prompt = this.#prompt;
		if (!prompt) return [];
		if (prompt.busy) return [prompt.busy].map(line => truncateToWidth(line, width));
		const value = prompt.masked ? "•".repeat([...prompt.value].length) : sanitizeCell(prompt.value);
		const cursor = this.focused && this.#useTerminalCursor ? "\x1b_pi:c\x07" : "";
		const lines = [
			prompt.error ? theme.fg("error", prompt.error) : "",
			`${prompt.label}${value}${cursor}`,
			theme.fg("dim", "Enter submit · Esc cancel"),
		].filter(line => line.length > 0);
		return lines.map(line => truncateToWidth(line, width));
	}

	#accountLoginLines(width: number): string[] {
		const login = this.#accountLogin;
		if (!login) return [];
		const state = login.state;
		const promptLines = state.prompt ? this.#oauthPromptLines(state.prompt, width) : [];
		const authLines = state.authUrl
			? renderOAuthAuthorizationLink(state.authUrl, state.launchUrl ?? undefined, width)
			: ["Starting provider login..."];
		const lines = [
			truncateToWidth(theme.bold("Account login"), width),
			...authLines,
			...(state.instructions ? [truncateToWidth(sanitizeCell(state.instructions), width)] : []),
			...state.progress.map(line => truncateToWidth(sanitizeCell(line), width)),
			...promptLines,
		];
		return lines.filter(line => line.length > 0);
	}

	#oauthPromptLines(prompt: AuthGatewayAccountLoginPromptState, width: number): string[] {
		const value = prompt.masked ? "•".repeat([...prompt.value].length) : sanitizeCell(prompt.value);
		const placeholder = prompt.placeholder ? ` (${sanitizeCell(prompt.placeholder)})` : "";
		const cursor = this.focused && this.#useTerminalCursor ? "\x1b_pi:c\x07" : "";
		return [
			`${sanitizeCell(prompt.message)}${placeholder}`,
			`${value}${cursor}`,
			theme.fg("dim", "Enter submit · Esc cancel"),
		].map(line => truncateToWidth(line, width));
	}

	#tokenDialogLines(width: number): string[] {
		const dialog = this.#oneTimeDialog;
		if (!dialog) return [];
		return [
			theme.bold("One-time token"),
			"Copy or save this token now. It cannot be reopened.",
			dialog.value,
			dialog.copied ? "Copied" : "y copy · Enter/Esc close",
		].map(line => truncateToWidth(line, width));
	}

	#narrowDetailAvailable(): boolean {
		return this.controller.state.activeTab !== "overview";
	}
}

function splitLeadingSgrMouseInputs(data: string): string[] | null {
	const chunks: string[] = [];
	let remaining = data;
	while (remaining.length > 0) {
		const match = LEADING_SGR_MOUSE_EVENT_PATTERN.exec(remaining);
		if (!match) break;
		chunks.push(match[0]);
		remaining = remaining.slice(match[0].length);
		if (!remaining.startsWith("\x1b[<")) break;
	}
	if (chunks.length === 0 || (chunks.length === 1 && remaining.length === 0)) return null;
	if (remaining.length > 0) chunks.push(remaining);
	return chunks;
}

function sanitizeCell(value: string): string {
	return replaceTabs(value).replace(/[\r\n]/g, " ");
}

function printablePromptInput(data: string): string {
	const withoutPasteEnvelope = data.replaceAll("\x1b[200~", "").replaceAll("\x1b[201~", "");
	if (withoutPasteEnvelope.includes("\x1b")) return "";
	return Array.from(withoutPasteEnvelope)
		.filter(ch => {
			const code = ch.codePointAt(0);
			return code !== undefined && code >= 32 && code !== 0x7f;
		})
		.join("");
}

function accountSummary(account: AuthGatewayCredentialSummary): string {
	return `#${account.id} · ${account.provider} · ${account.type} · ${credentialIdentity(account)}`;
}

function accountUsageListSuffix(usage: AuthGatewayAccountUsageState | undefined): string {
	if (!usage) return "";
	if (usage.kind === "unavailable") return " · usage unavailable";
	if (usage.kind === "unreported") return ` · ${usage.message}`;
	const fractions = usage.report.limits
		.map(resolveUsedFraction)
		.filter((value): value is number => value !== undefined);
	if (fractions.length === 0) return " · usage reported";
	const maxFraction = Math.max(...fractions);
	return ` · usage ${(maxFraction * 100).toFixed(1)}%`;
}

function wrapAnsiDetailLines(lines: string[], width: number): string[] {
	return lines.flatMap(line => Bun.wrapAnsi(line, Math.max(1, width), { trim: false }).split("\n"));
}

function credentialIdentity(account: AuthGatewayCredentialSummary): string {
	return account.email ?? account.accountId ?? account.identityKey ?? "No non-secret identity";
}

function selectedLine(selected: boolean, text: string, width: number): string {
	const prefix = selected ? "> " : "  ";
	const line = truncateToWidth(`${prefix}${sanitizeCell(text)}`, width);
	return selected ? theme.bg("selectedBg", line) : line;
}

function twoColumns(left: string[], right: string[], width: number): string[] {
	const leftWidth = Math.floor(width * 0.45);
	const rightWidth = Math.max(1, width - leftWidth - 3);
	const count = Math.max(left.length, right.length);
	const separator = theme.fg("dim", ` ${theme.boxRound.vertical} `);
	const lines: string[] = [];
	for (let index = 0; index < count; index++) {
		const leftLine = truncateToWidth(left[index] ?? "", leftWidth);
		const padding = " ".repeat(Math.max(0, leftWidth - visibleWidth(leftLine)));
		lines.push(`${leftLine}${padding}${separator}${truncateToWidth(right[index] ?? "", rightWidth)}`);
	}
	return lines;
}

function wrapFreeform(text: string, width: number, color: "error" | "warning" | "success"): string[] {
	return wrapTextWithAnsi(sanitizeCell(text), Math.max(1, width)).map(line => theme.fg(color, line));
}

function fitRows(lines: string[], rows: number, width: number): string[] {
	const fitted = lines.slice(0, rows).map(line => truncateToWidth(line, width));
	while (fitted.length < rows) fitted.push("");
	return fitted;
}

function formatTime(value: number | null): string {
	if (value === null) return "never";
	return new Date(value).toISOString();
}
