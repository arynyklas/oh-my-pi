import { replaceTabs } from "@oh-my-pi/pi-tui";
import { urlHyperlinkAlways } from "@oh-my-pi/pi-tui/render";
import { theme } from "@oh-my-pi/pi-tui/theme";

/**
 * Minimum column budget for URL wrapping. Below this the terminal is
 * effectively unusable, but we still emit chunks so no character is silently
 * dropped and the user can widen and reflow.
 */
const OAUTH_AUTH_MIN_WRAP_WIDTH = 16;

/**
 * Wrap `url` into rows that each fit inside `width`. When the label + URL fit
 * on one line, returns a single indented row; otherwise puts the label on its
 * own indented row and slices the URL into fixed-width chunks that start at
 * column 0. Continuation chunks carry ZERO leading bytes on purpose: a
 * multi-row terminal selection includes the newline plus any leading indent,
 * and while address bars strip newlines they preserve or percent-encode
 * embedded spaces — an indent would corrupt the URL at every chunk boundary
 * (silently, when the damage lands inside a query value).
 */
function wrapUrlRows(label: string, url: string, width: number): string[] {
	const indent = " ";
	const sanitized = replaceTabs(url);
	const effective = Math.max(OAUTH_AUTH_MIN_WRAP_WIDTH, Math.trunc(width));
	const inlineWidth = indent.length + label.length + 1 + sanitized.length;
	if (inlineWidth <= effective) {
		return [`${indent}${theme.fg("muted", `${label} ${sanitized}`)}`];
	}
	const rows: string[] = [`${indent}${theme.fg("muted", label)}`];
	for (let i = 0; i < sanitized.length; i += effective) {
		rows.push(theme.fg("muted", sanitized.slice(i, i + effective)));
	}
	return rows;
}

export function renderOAuthAuthorizationLink(url: string, launchUrl: string | undefined, width: number): string[] {
	const link = urlHyperlinkAlways(url, "Click here to authorize");
	const lines: string[] = [
		` ${theme.fg("success", "Open authorization URL:")}`,
		` ${theme.fg("accent", link)}`,
		...wrapUrlRows("Copy URL:", url, width),
	];
	if (launchUrl && launchUrl !== url) {
		lines.push(...wrapUrlRows("Local shortcut (this machine only):", launchUrl, width));
	}
	return lines;
}
