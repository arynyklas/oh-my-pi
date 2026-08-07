import type { AuthGatewayIssuedTokenValue } from "@oh-my-pi/pi-ai/auth-gateway";
import { copyToClipboard } from "../../../utils/clipboard";

export interface AuthGatewayOneTimeTokenDialog {
	id: number;
	value: string;
	label: string | null;
	copied: boolean;
}

export function createOneTimeTokenDialog(token: AuthGatewayIssuedTokenValue): AuthGatewayOneTimeTokenDialog {
	return { id: token.id, value: token.value, label: token.label, copied: false };
}

export function closeOneTimeTokenDialog(dialog: AuthGatewayOneTimeTokenDialog): void {
	dialog.value = "";
	dialog.copied = false;
}

export async function copyOneTimeTokenDialogValue(dialog: AuthGatewayOneTimeTokenDialog): Promise<void> {
	const value = dialog.value;
	if (value.length === 0) return;
	dialog.copied = false;
	await copyToClipboard(value);
	dialog.copied = true;
}
