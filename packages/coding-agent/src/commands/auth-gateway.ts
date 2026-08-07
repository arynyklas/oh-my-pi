/**
 * `omp auth-gateway` — run a forward proxy that injects auth from the broker.
 */

import { Args, Command, Flags, renderCommandHelp } from "@oh-my-pi/pi-utils/cli";
import {
	AUTH_GATEWAY_ACTIONS,
	type AuthGatewayAction,
	type AuthGatewayCommandArgs,
	runAuthGatewayCommand,
} from "../cli/auth-gateway-cli";
import { authGatewayHelp as commandHelp } from "../cli/command-help";
import { initTheme } from "../modes/theme/theme";

export default class AuthGateway extends Command {
	static description = commandHelp.description;
	static args = {
		action: Args.string({
			description: "Sub-command",
			required: false,
			options: [...AUTH_GATEWAY_ACTIONS],
		}),
		subaction: Args.string({
			description: "Group sub-command",
			required: false,
		}),
		target: Args.string({
			description: "Name/id target",
			required: false,
		}),
		value: Args.string({
			description: "Additional value",
			required: false,
		}),
	};

	static flags = {
		json: Flags.boolean({ description: "Output JSON (token/status/check/management)" }),
		bind: Flags.string({ description: "Bind address for `serve` (host:port)", char: "b" }),
		regenerate: Flags.boolean({ description: "Regenerate the gateway bearer token or managed user token" }),
		description: Flags.string({ description: "User description (empty clears on update)" }),
		owner: Flags.string({ description: "User owner (empty clears on update)" }),
		role: Flags.string({ description: "User role (user|admin)" }),
		label: Flags.string({ description: "Managed token label" }),
		provider: Flags.string({ description: "Provider id for ACL" }),
		model: Flags.string({ description: "Model id for ACL" }),
		route: Flags.string({ description: "Gateway route family for ACL" }),
		strategy: Flags.string({ description: "Pool strategy" }),
		since: Flags.string({ description: "Usage lower bound as epoch milliseconds" }),
		limit: Flags.string({ description: "Audit limit (1..1000)" }),
		user: Flags.string({ description: "Audit user name/id filter" }),
		before: Flags.string({ description: "Audit cursor/event id" }),
		connection: Flags.string({ description: "Named remote gateway connection for `tui`" }),
		"no-auth": Flags.boolean({
			description:
				"Disable inbound bearer-token auth (serve). Useful when bound to loopback — any caller is allowed.",
		}),
		strict: Flags.boolean({
			description:
				"For `check`: additionally probe each credential against its provider's chat-completion endpoint. Slower; consumes a tiny amount of quota per credential.",
		}),
	};

	static examples = [
		"# Boot the gateway against the configured broker\n  omp auth-gateway serve",
		"# Boot on a non-default port\n  omp auth-gateway serve --bind=127.0.0.1:4000",
		"# Print the gateway bearer token (creates one on first run)\n  omp auth-gateway token",
		"# Rotate the gateway bearer token\n  omp auth-gateway token --regenerate",
		"# Run on loopback without any bearer (anyone on this host can call)\n  omp auth-gateway serve --no-auth",
		"# Show local gateway + broker config status\n  omp auth-gateway status",
		"# Probe each broker credential to see which one is producing 401s\n  omp auth-gateway check",
		"# Same, machine-readable for scripts\n  omp auth-gateway check --json",
		"# Strict check — also exercises each credential with a real chat-completion ping\n  omp auth-gateway check --strict",
		"# Create a managed gateway user and one-time token\n  omp auth-gateway user create alice --role=user --label=initial",
		"# Add a provider ACL for a user\n  omp auth-gateway user allow alice --provider=anthropic",
		"# Create a neutral credential pool and add broker credential ids\n  omp auth-gateway pool create primary --strategy=round-robin\n  omp auth-gateway pool add-account primary 42",
		"# Reorder a managed user's pool fallback priority\n  omp auth-gateway user reorder-pools alice 2,1",
		"# Show audit events for one user\n  omp auth-gateway audit list --user=alice --limit=25",
		"# Rename a credential pool\n  omp auth-gateway pool rename primary primary-prod",
		"# Show audit events before one event id\n  omp auth-gateway audit list --user=alice --limit=25 --before=12345",
		"# Open the remote admin console for a named connection\n  omp auth-gateway tui --connection=prod",
	];

	async run(): Promise<void> {
		const { args, flags, argv } = await this.parse(AuthGateway);
		if (!args.action) {
			renderCommandHelp("omp", "auth-gateway", AuthGateway);
			return;
		}
		const cmd: AuthGatewayCommandArgs = {
			action: args.action as AuthGatewayAction,
			subaction: args.subaction,
			target: args.target,
			value: args.value,
			positionals: argv,
			flags: {
				json: flags.json,
				bind: flags.bind,
				regenerate: flags.regenerate,
				description: flags.description,
				owner: flags.owner,
				role: flags.role,
				label: flags.label,
				provider: flags.provider,
				model: flags.model,
				route: flags.route,
				strategy: flags.strategy,
				since: flags.since,
				limit: flags.limit,
				user: flags.user,
				before: flags.before,
				connection: flags.connection,
				noAuth: flags["no-auth"],
				strict: flags.strict,
			},
		};
		await initTheme();
		await runAuthGatewayCommand(cmd);
	}
}
