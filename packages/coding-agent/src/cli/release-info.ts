import { isRecord, VERSION } from "@oh-my-pi/pi-utils";
import { isTimeoutError, withTimeoutSignal } from "../utils/fetch-timeout";

export const UPSTREAM_RELEASE_REPO = "can1357/oh-my-pi";
const FORK_RELEASE_REPO = "arynyklas/oh-my-pi";
const FORK_TAG_RE = /^v(\d+\.\d+\.\d+)-fork\.(\d+)$/;
const FORK_MARKER = "-fork.";
const PACKAGE = "@oh-my-pi/pi-coding-agent";
const RELEASE_METADATA_TIMEOUT_MS = 30_000;

/** Distribution channel advertised by a release's published npm manifest. */
export type ReleaseDist = "npm" | "binary";

export interface ReleaseInfo {
	repo: string;
	tag: string;
	version: string;
	/** Parsed `omp.dist` from the registry manifest; undefined when absent. */
	dist?: ReleaseDist;
}

interface GitHubReleaseInfo {
	tag_name: string;
	draft: boolean;
	prerelease: boolean;
}

/** Whether this build came from the fork's `vX.Y.Z-fork.N` release line. */
export function isForkVersion(version: string = VERSION): boolean {
	return version.includes(FORK_MARKER);
}

export function buildBinaryDownloadUrl(repo: string, tag: string, binaryName: string): string {
	return `https://github.com/${repo}/releases/download/${tag}/${binaryName}`;
}

/**
 * Parse the `omp.dist` field from a published package manifest.
 *
 * Forward-compatibility contract with future releases: a release that is not
 * installable as an npm package (e.g. a native rewrite) publishes
 * `"omp": { "dist": "binary" }` in its package.json. Any value other than
 * "npm" — including values this updater does not know yet — maps to "binary"
 * so already-deployed updaters never run a package-manager install against a
 * release that no longer supports it.
 */
export function resolveReleaseDist(manifest: unknown): ReleaseDist | undefined {
	if (!isRecord(manifest) || !isRecord(manifest.omp)) return undefined;
	const dist = manifest.omp.dist;
	if (dist === undefined) return undefined;
	return dist === "npm" ? "npm" : "binary";
}

export async function getLatestReleaseForVersion(
	currentVersion: string = VERSION,
	timeoutMs = RELEASE_METADATA_TIMEOUT_MS,
): Promise<ReleaseInfo> {
	return isForkVersion(currentVersion)
		? await getLatestForkRelease(timeoutMs)
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
	const data: unknown = await response.json();
	if (!isRecord(data) || typeof data.version !== "string") {
		throw new Error("No version found in release info");
	}
	const version = data.version;
	return {
		repo: UPSTREAM_RELEASE_REPO,
		tag: `v${version}`,
		version,
		dist: resolveReleaseDist(data),
	};
}

function versionFromForkTag(tag: string): string | undefined {
	const match = FORK_TAG_RE.exec(tag);
	if (!match) return undefined;
	return `${match[1]}-fork.${match[2]}`;
}

function selectForkRelease(releases: GitHubReleaseInfo[]): ReleaseInfo | undefined {
	let latest: ReleaseInfo | undefined;
	for (const release of releases) {
		if (release.draft || release.prerelease) continue;
		const version = versionFromForkTag(release.tag_name);
		if (!version) continue;
		const candidate = { repo: FORK_RELEASE_REPO, tag: release.tag_name, version };
		if (!latest || Bun.semver.order(candidate.version, latest.version) > 0) {
			latest = candidate;
		}
	}
	return latest;
}

export async function getLatestForkRelease(timeoutMs = RELEASE_METADATA_TIMEOUT_MS): Promise<ReleaseInfo> {
	let response: Response;
	try {
		response = await fetch(`https://api.github.com/repos/${FORK_RELEASE_REPO}/releases?per_page=20`, {
			signal: withTimeoutSignal(timeoutMs),
		});
	} catch (err) {
		if (isTimeoutError(err)) {
			throw new Error(`Timed out fetching fork release info after ${Math.round(timeoutMs / 1000)}s`, {
				cause: err,
			});
		}
		throw err;
	}
	if (!response.ok) {
		throw new Error(`Failed to fetch fork release info: ${response.statusText}`);
	}

	const release = selectForkRelease((await response.json()) as GitHubReleaseInfo[]);
	if (!release) {
		throw new Error(`No releases found in ${FORK_RELEASE_REPO}`);
	}
	return release;
}
