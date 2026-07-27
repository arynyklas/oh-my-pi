import { VERSION } from "@oh-my-pi/pi-utils";
import { isTimeoutError, withTimeoutSignal } from "../utils/fetch-timeout";

export const UPSTREAM_RELEASE_REPO = "can1357/oh-my-pi";
const AUTH_GATEWAY_BETA_REPO = "arynyklas/oh-my-pi";
const AUTH_GATEWAY_BETA_VERSION_RE = /^auth-gateway-v(\d+\.\d+\.\d+)-beta\.(\d+)$/;
const AUTH_GATEWAY_BETA_MARKER = "-authgw.";
const PACKAGE = "@oh-my-pi/pi-coding-agent";
const RELEASE_METADATA_TIMEOUT_MS = 30_000;

export interface ReleaseInfo {
	repo: string;
	tag: string;
	version: string;
}

interface GitHubReleaseInfo {
	tag_name: string;
	draft: boolean;
	prerelease: boolean;
}

export function isAuthGatewayBetaVersion(version: string = VERSION): boolean {
	return version.includes(AUTH_GATEWAY_BETA_MARKER);
}

export function buildBinaryDownloadUrl(repo: string, tag: string, binaryName: string): string {
	return `https://github.com/${repo}/releases/download/${tag}/${binaryName}`;
}

export async function getLatestReleaseForVersion(
	currentVersion: string = VERSION,
	timeoutMs = RELEASE_METADATA_TIMEOUT_MS,
): Promise<ReleaseInfo> {
	return isAuthGatewayBetaVersion(currentVersion)
		? await getLatestAuthGatewayBetaRelease(timeoutMs)
		: await getLatestUpstreamRelease(timeoutMs);
}

export async function getLatestUpstreamRelease(timeoutMs = RELEASE_METADATA_TIMEOUT_MS): Promise<ReleaseInfo> {
	let response: Response;
	try {
		response = await fetch(`https://registry.npmjs.org/${PACKAGE}/latest`, {
			signal: withTimeoutSignal(timeoutMs),
		});
	} catch (err) {
		if (isTimeoutError(err)) {
			throw new Error(`Timed out fetching release info after ${Math.round(timeoutMs / 1000)}s`, { cause: err });
		}
		throw err;
	}
	if (!response.ok) {
		throw new Error(`Failed to fetch release info: ${response.statusText}`);
	}
	const data = (await response.json()) as { version?: string };
	const version = data.version;
	if (!version) {
		throw new Error("No version found in release info");
	}
	return {
		repo: UPSTREAM_RELEASE_REPO,
		tag: `v${version}`,
		version,
	};
}

function versionFromAuthGatewayBetaTag(tag: string): string | undefined {
	const match = AUTH_GATEWAY_BETA_VERSION_RE.exec(tag);
	if (!match) return undefined;
	return `${match[1]}-authgw.beta.${match[2]}`;
}

function selectAuthGatewayBetaRelease(releases: GitHubReleaseInfo[]): ReleaseInfo | undefined {
	let latest: ReleaseInfo | undefined;
	for (const release of releases) {
		if (release.draft || !release.prerelease) continue;
		const version = versionFromAuthGatewayBetaTag(release.tag_name);
		if (!version) continue;
		const candidate = { repo: AUTH_GATEWAY_BETA_REPO, tag: release.tag_name, version };
		if (!latest || Bun.semver.order(candidate.version, latest.version) > 0) {
			latest = candidate;
		}
	}
	return latest;
}

export async function getLatestAuthGatewayBetaRelease(timeoutMs = RELEASE_METADATA_TIMEOUT_MS): Promise<ReleaseInfo> {
	let response: Response;
	try {
		response = await fetch(`https://api.github.com/repos/${AUTH_GATEWAY_BETA_REPO}/releases?per_page=20`, {
			signal: withTimeoutSignal(timeoutMs),
		});
	} catch (err) {
		if (isTimeoutError(err)) {
			throw new Error(`Timed out fetching auth-gateway beta release info after ${Math.round(timeoutMs / 1000)}s`, {
				cause: err,
			});
		}
		throw err;
	}
	if (!response.ok) {
		throw new Error(`Failed to fetch auth-gateway beta release info: ${response.statusText}`);
	}

	const release = selectAuthGatewayBetaRelease((await response.json()) as GitHubReleaseInfo[]);
	if (!release) {
		throw new Error(`No auth-gateway beta releases found in ${AUTH_GATEWAY_BETA_REPO}`);
	}
	return release;
}
