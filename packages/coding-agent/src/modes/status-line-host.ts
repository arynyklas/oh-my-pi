import type { StatusLineHost, StatusLineSession } from "@oh-my-pi/pi-tui/status-line/host";
import { settings } from "../config/settings";
import type { AgentSession } from "../session/agent-session";
import { getSessionCompactionBoundaries } from "../session/context-usage-runtime";
import { formatAccountLabelAmong, limitMatchesActiveAccount } from "../slash-commands/helpers/active-oauth-account";
import { resolveActiveRepoContextSync } from "../utils/active-repo-context";
import { GH_COMMAND_TIMEOUT_MS, github } from "../utils/github";
import { calculateTokensPerSecond } from "../utils/token-rate";

/**
 * Session capabilities the host consults beyond the display subset. Every
 * field is optional so display-only sessions (collab guest replicas, test
 * fixtures) still render; a live `AgentSession` satisfies it structurally.
 */
export type StatusLineHostSession = StatusLineSession &
	Partial<
		Pick<AgentSession, "settings" | "modelRegistry" | "sessionId" | "fetchUsageReports" | "getAdvisorAccountBindings">
	>;

/** Application policy and runtime services consumed by the portable status renderer. */
export const statusLineHost: StatusLineHost<StatusLineHostSession> = {
	getSettings: () => ({
		preset: settings.get("statusLine.preset"),
		leftSegments: settings.get("statusLine.leftSegments"),
		rightSegments: settings.get("statusLine.rightSegments"),
		separator: settings.get("statusLine.separator"),
		showHookStatus: settings.get("statusLine.showHookStatus"),
		segmentOptions: settings.getGroup("statusLine").segmentOptions,
		sessionAccent: settings.get("statusLine.sessionAccent"),
		transparent: settings.get("statusLine.transparent"),
		compactThinkingLevel: settings.get("statusLine.compactThinkingLevel"),
		contextLine: settings.get("statusLine.contextLine"),
	}),
	gitEnabled: () => settings.get("git.enabled"),
	codexResetFireworksEnabled: () => settings.get("tui.codexResetFireworks"),
	getSettingsRevision: () => settings.revision,
	getSessionSettingsIdentity: session => session.settings,
	getSessionSettingsRevision: session => session.settings?.revision ?? 0,
	goalStatusInFooter: session => (session.settings ?? settings).get("goal.statusInFooter"),
	activeAccount: (session, provider) =>
		session.modelRegistry?.authStorage?.getOAuthAccountIdentity(provider, session.sessionId),
	/**
	 * `listOAuthAccounts` marks only the session-sticky row `active`, so the
	 * chip stays hidden until the session has really resolved a credential —
	 * unlike `getOAuthAccountIdentity`, which falls back to the first stored
	 * row and would name an account no request has used yet. Fallover is
	 * decided on durable credential ids, not labels: two subscriptions can
	 * share one email, and the one-shot
	 * `AuthStorage.consumeDefaultAccountFallover` notice belongs to the
	 * session's warning, not to a chip that must keep flagging it all session.
	 */
	resolveAccountStatus: session => {
		const provider = session.state.model?.provider ?? session.model?.provider;
		const authStorage = session.modelRegistry?.authStorage;
		if (!provider || !authStorage) return null;
		const stored = authStorage.listOAuthAccounts(provider, session.sessionId);
		const active = stored.find(account => account.active);
		if (!active) return null;
		const label = formatAccountLabelAmong(active, stored);
		if (!label) return null;
		const defaultCredentialId = authStorage.getDefaultAccountCredentialId(provider);
		const fellBack = defaultCredentialId !== undefined && defaultCredentialId !== active.credentialId;
		// Advisors run as their own provider sessions, so each can be stuck to a
		// different credential than the primary (usage fallover hits them
		// independently, and an advisor can be configured on another provider
		// entirely). Every live advisor binding is reported — a match with the
		// primary is the confirmation the chip exists for — but advisors sharing
		// one account collapse into a single chip so a wide roster costs one
		// cell, not one per advisor.
		// Optional invocation: lightweight session doubles in tests need not
		// implement the accessor.
		const advisors: { slug: string; label: string; fellBack: boolean }[] = [];
		for (const binding of session.getAdvisorAccountBindings?.() ?? []) {
			const advisorStored = authStorage.listOAuthAccounts(binding.provider, binding.providerSessionId);
			const advisorAccount = advisorStored.find(account => account.active);
			if (!advisorAccount) continue;
			const advisorLabel = formatAccountLabelAmong(advisorAccount, advisorStored);
			if (!advisorLabel || advisors.some(entry => entry.label === advisorLabel)) continue;
			const advisorDefaultId = authStorage.getDefaultAccountCredentialId(binding.provider);
			advisors.push({
				slug: binding.slug,
				label: advisorLabel,
				fellBack: advisorDefaultId !== undefined && advisorDefaultId !== advisorAccount.credentialId,
			});
		}
		return advisors.length > 0 ? { label, fellBack, advisors } : { label, fellBack };
	},
	canFetchUsageReports: session => typeof session.fetchUsageReports === "function",
	fetchUsageReports: (session, signal) => session.fetchUsageReports?.(signal) ?? Promise.resolve(null),
	resolveActiveRepo: resolveActiveRepoContextSync,
	lookupPullRequest: cwd =>
		github.run(cwd, ["pr", "view", "--json", "number,url"], AbortSignal.timeout(GH_COMMAND_TIMEOUT_MS)),
	calculateTokensPerSecond,
	limitMatchesActiveAccount,
	computeCompactionBoundaries: (session, contextWindow, model) => {
		const source = session.settings;
		return getSessionCompactionBoundaries(
			typeof source?.getGroup === "function" ? source : settings,
			contextWindow,
			model,
		);
	},
};
