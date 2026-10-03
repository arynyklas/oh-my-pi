import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Settings, settings } from "../../../../src/config/settings";
import { StatusLineComponent } from "@oh-my-pi/pi-tui/status-line/component";
import { statusLineHost } from "@oh-my-pi/pi-coding-agent/modes/status-line-host";
import { loadTheme } from "@oh-my-pi/pi-tui/theme/loader";
import { getThemeByName, setThemeInstance, theme } from "@oh-my-pi/pi-tui/theme";
import {
	cfgStatusLineLeftSegments,
	cfgStatusLinePreset,
	cfgStatusLineSegmentOptions,
} from "../../../../src/modes/settings";
import type { AgentSession } from "../../../../src/session/agent-session";
import { StatusLineTestComponents } from "../../../helpers/status-line";

// The cost assertions below care about how the two costs are rendered, not about
// terminal width. The status line also shows the cwd and git branch, so a long
// checkout path or branch name eats the budget and pushes the cost segment out
// at a realistic 120 columns. Render these two cases wide enough that the
// segment always fits, and let the width-sensitive behavior stay covered by the
// truncation tests that target it directly.
const WIDE_ENOUGH_FOR_COST_SEGMENT = 400;
const statusLines = new StatusLineTestComponents();

function makeSessionWithLastMessage(
	lastMessage: unknown,
	prewalkArmed: boolean = false,
	{
		cost = 0,
		advisorCost = 0,
		usingSubscription = false,
		advisorUsingSubscription = false,
		modelName,
		sessionName = "test-session",
	}: {
		cost?: number;
		advisorCost?: number;
		usingSubscription?: boolean;
		advisorUsingSubscription?: boolean;
		modelName?: string;
		sessionName?: string;
	} = {},
) {
	return {
		messages: lastMessage ? [lastMessage] : [],
		model: { name: modelName, contextWindow: 128000 },
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		getContextUsage: () => ({ tokens: 42, contextWindow: 128000 }),
		state: {
			messages: lastMessage ? [lastMessage] : [],
			model: { name: modelName, contextWindow: 128000 },
		},
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost,
				tokensPerSecond: null,
			}),
			getSessionName: () => sessionName,
		},
		getPrewalkState: () => (prewalkArmed ? { target: { id: "cheap-model", provider: "openai" } } : undefined),
		getAsyncJobSnapshot: () => undefined,
		isAdvisorActive: () => false,
		getAdvisorStatusOverview: () => ({
			configured: advisorCost > 0,
			advisors: advisorCost > 0 ? [{ name: "test", status: "running" as const }] : [],
		}),
		getAdvisorCost: () => advisorCost,
		isAdvisorUsingSubscription: () => advisorUsingSubscription,
		isFastModeActive: () => false,
		configuredThinkingLevel: () => undefined,
		modelRegistry: {
			isUsingOAuth: () => usingSubscription,
		},
	};
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
});

afterAll(() => {
	statusLines.dispose();
});

describe("StatusLineComponent", () => {
	it("fingerprints tool-call arguments containing bigint values", () => {
		const statusLine = statusLines.track(
			new StatusLineComponent(
				makeSessionWithLastMessage({
					role: "assistant",
					timestamp: 1,
					content: [
						{
							type: "toolCall",
							name: "read",
							arguments: { offset: 1n, nested: { limit: 2n } },
						},
					],
				}) as unknown as AgentSession,
				statusLineHost,
			),
		);

		expect(statusLine.getCachedContextBreakdown()).toEqual({ usedTokens: 42, contextWindow: 128000 });
	});

	it("renders Prewalk annotation when prewalk is armed", () => {
		const statusLine = statusLines.track(
			new StatusLineComponent(makeSessionWithLastMessage(null, true) as unknown as AgentSession, statusLineHost),
		);

		// By default preset, 'mode' segment is included in left/right segments.
		// Let's get the border and see if Prewalk is rendered.
		const border = statusLine.getTopBorder(100);
		// SGR codes might be included, so we check if the stripped content contains "Prewalk"
		const stripped = border.content.replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped).toContain("Prewalk");
	});

	it("shows the context window without a percent while usage is unknown", () => {
		const session = makeSessionWithLastMessage(null);
		const known = statusLines.track(new StatusLineComponent(session as unknown as AgentSession, statusLineHost));
		const unknown = statusLines.track(
			new StatusLineComponent(
				{
					...session,
					getContextUsage: () => ({ tokens: 0, contextWindow: 128000, percent: null }),
				} as unknown as AgentSession,
				statusLineHost,
			),
		);

		expect(Bun.stripANSI(known.getTopBorder(120).content)).toMatch(/\d%/);
		const border = Bun.stripANSI(unknown.getTopBorder(120).content);
		expect(border).toContain("128K");
		expect(border).not.toContain("%");
	});

	it("renders primary and advisor costs separately with subscription indicator in Unicode preset", () => {
		const statusLine = statusLines.track(
			new StatusLineComponent(
				makeSessionWithLastMessage(null, false, {
					cost: 2.67,
					advisorCost: 0.41,
					usingSubscription: true,
				}) as unknown as AgentSession,
				statusLineHost,
			),
		);

		const stripped = statusLine.getTopBorder(WIDE_ENOUGH_FOR_COST_SEGMENT).content.replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped).toContain("S2.67 + 👁 $0.41");
	});

	it("renders advisor cost with subscription prefix when advisor is on subscription in Unicode preset", () => {
		const statusLine = statusLines.track(
			new StatusLineComponent(
				makeSessionWithLastMessage(null, false, {
					cost: 2.67,
					advisorCost: 0.41,
					usingSubscription: true,
					advisorUsingSubscription: true,
				}) as unknown as AgentSession,
				statusLineHost,
			),
		);

		const stripped = statusLine.getTopBorder(WIDE_ENOUGH_FOR_COST_SEGMENT).content.replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped).toContain("S2.67 + 👁 0.41");
	});

	it("renders ASCII preset fallback with (adv) for advisor costs", async () => {
		const baseTheme = await getThemeByName("dark");
		if (!baseTheme) throw new Error("theme unavailable");
		const asciiTheme = await loadTheme("dark", { symbolPresetOverride: "ascii" });
		setThemeInstance(asciiTheme);
		try {
			const statusLine = statusLines.track(
				new StatusLineComponent(
					makeSessionWithLastMessage(null, false, {
						cost: 2.67,
						advisorCost: 0.41,
						usingSubscription: true,
						advisorUsingSubscription: true,
					}) as unknown as AgentSession,
					statusLineHost,
				),
			);
			const stripped = statusLine.getTopBorder(WIDE_ENOUGH_FOR_COST_SEGMENT).content.replace(/\x1b\[[0-9;]*m/g, "");
			expect(stripped).toContain("S2.67 + 0.41 (adv)");
		} finally {
			setThemeInstance(baseTheme);
		}
	});

	it("omits advisor cost when the advisor has never been active", () => {
		const statusLine = statusLines.track(
			new StatusLineComponent(
				makeSessionWithLastMessage(null, false, {
					cost: 2.67,
					usingSubscription: true,
				}) as unknown as AgentSession,
				statusLineHost,
			),
		);

		const stripped = statusLine.getTopBorder(WIDE_ENOUGH_FOR_COST_SEGMENT).content.replace(/\x1b\[[0-9;]*m/g, "");
		expect(stripped).toContain("S2.67");
		expect(stripped).not.toContain("(adv)");
	});

	it("renders Nerd Font symbols for subscription and advisor costs", async () => {
		const baseTheme = await getThemeByName("dark");
		if (!baseTheme) throw new Error("theme unavailable");
		const nerdTheme = await loadTheme("dark", { symbolPresetOverride: "nerd" });
		setThemeInstance(nerdTheme);
		try {
			const statusLine = statusLines.track(
				new StatusLineComponent(
					makeSessionWithLastMessage(null, false, {
						cost: 2.67,
						advisorCost: 0.41,
						usingSubscription: true,
						advisorUsingSubscription: true,
					}) as unknown as AgentSession,
					statusLineHost,
				),
			);
			const stripped = statusLine.getTopBorder(WIDE_ENOUGH_FOR_COST_SEGMENT).content.replace(/\x1b\[[0-9;]*m/g, "");
			expect(stripped).toContain("\u{f067a} 2.67 + \uea70 0.41");
		} finally {
			setThemeInstance(baseTheme);
		}
	});

	// The chip is the only place the user can see WHICH account serves the
	// primary model and each advisor, so the component's resolution (session
	// sticky per provider-session, default comparison, custom-preset gate) is
	// the contract under test here — the segment renderer is covered separately.
	it("attributes the serving account for the primary model and every advisor", () => {
		const accounts = [
			{ position: 0, credentialId: 11, email: "primary@example.com", active: true },
			{ position: 1, credentialId: 12, email: "sibling@example.com", active: false },
		];
		const advisorAccounts = [
			{ position: 0, credentialId: 21, email: "codex-default@example.com", active: false },
			{ position: 1, credentialId: 22, email: "codex-sibling@example.com", active: true },
		];
		const session = {
			...makeSessionWithLastMessage(null),
			sessionId: "primary-session",
			modelRegistry: {
				isUsingOAuth: () => true,
				authStorage: {
					oauth: {
						accounts: (provider: string) => (provider === "anthropic" ? accounts : advisorAccounts),
						// Read by the usage-refresh cache key, unrelated to the chip.
						identity: () => undefined,
					},
					// anthropic serves its pinned default; openai-codex fell over to a sibling.
					getDefaultAccountCredentialId: (provider: string) => (provider === "anthropic" ? 11 : 21),
				},
			},
			getAdvisorAccountBindings: () => [
				{ slug: "architect", provider: "openai-codex", providerSessionId: "primary-session-advisor-architect" },
			],
		};
		session.state.model = { name: "Opus", contextWindow: 128000, provider: "anthropic" } as never;

		cfgStatusLinePreset.set(settings, "custom");
		cfgStatusLineLeftSegments.set(settings, ["model"]);
		cfgStatusLineSegmentOptions.set(settings, { model: { showAccount: true } });
		try {
			const custom = statusLines.track(new StatusLineComponent(session as unknown as AgentSession, statusLineHost));
			const stripped = Bun.stripANSI(custom.getTopBorder(WIDE_ENOUGH_FOR_COST_SEGMENT).content);
			expect(stripped).toContain(`${theme.icon.account} primary@example.com`);
			// Advisor chip carries the advisor icon and the fallover glyph, since
			// the advisor is not on its provider's default account.
			expect(stripped).toContain(`${theme.icon.advisor}${theme.icon.accountFallover} codex-sibling@example.com`);
			expect(stripped).not.toContain("sibling@example.com codex-default");

			// The chip is a custom-preset knob: the same option under a built-in
			// preset renders nothing.
			cfgStatusLinePreset.set(settings, "default");
			const builtin = statusLines.track(new StatusLineComponent(session as unknown as AgentSession, statusLineHost));
			const builtinStripped = Bun.stripANSI(builtin.getTopBorder(WIDE_ENOUGH_FOR_COST_SEGMENT).content);
			expect(builtinStripped).not.toContain("primary@example.com");
			expect(builtinStripped).not.toContain("codex-sibling@example.com");
		} finally {
			cfgStatusLinePreset.set(settings, "default");
			cfgStatusLineLeftSegments.set(settings, []);
			cfgStatusLineSegmentOptions.set(settings, {});
		}
	});
});
