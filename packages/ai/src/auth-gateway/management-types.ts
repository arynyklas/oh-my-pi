import type { ModelKind } from "@oh-my-pi/pi-catalog/types";
import type { AuthCredential, ResetCreditRedeemOutcome } from "../auth-storage";
import type { Api } from "../types";
import type { UsageReport } from "../usage";
import type {
	AuthGatewayAclBatchResult,
	AuthGatewayAclRule,
	AuthGatewayAclRuleInput,
	AuthGatewayAuditEvent,
	AuthGatewayPool,
	AuthGatewayPoolStrategy,
	AuthGatewayPrincipal,
	AuthGatewayRole,
	AuthGatewayToken,
	AuthGatewayUsageSummary,
	AuthGatewayUser,
	AuthGatewayUserPoolBinding,
} from "./access-control";

export interface AuthGatewayAdminStatus {
	ok: true;
	version: string;
	serverTime: number;
	principal: Pick<AuthGatewayPrincipal, "kind" | "userId" | "name" | "role" | "tokenId">;
	counts: {
		users: number;
		activeTokens: number;
		pools: number;
		credentials: number;
	};
}

export interface AuthGatewayCredentialSummary {
	id: number;
	provider: string;
	type: "oauth" | "api_key";
	identityKey: string | null;
	email: string | null;
	accountId: string | null;
	projectId: string | null;
	orgId: string | null;
	orgName: string | null;
	enterpriseUrl: string | null;
	apiEndpoint: string | null;
	expiresAt: number | null;
}

export interface AuthGatewayAuditPage {
	events: AuthGatewayAuditEvent[];
	nextBefore: number | null;
}

export interface AuthGatewayIssuedTokenValue {
	id: number;
	value: string;
	label: string | null;
}

export interface AuthGatewayUserDetails {
	user: AuthGatewayUser;
	tokens: AuthGatewayToken[];
	acl: AuthGatewayAclRule[];
	poolBindings: AuthGatewayUserPoolBinding[];
}

export interface CreateUserInput {
	name: string;
	description?: string;
	owner?: string;
	role?: AuthGatewayRole;
}

export interface UpdateUserInput {
	description?: string | null;
	owner?: string | null;
	role?: AuthGatewayRole;
	enabled?: boolean;
}

export type AddAclRuleInput = AuthGatewayAclRuleInput;

export interface AddAclRulesInput {
	rules: AddAclRuleInput[];
}

export interface CreatePoolInput {
	name: string;
	strategy?: AuthGatewayPoolStrategy;
}

export interface UpdatePoolInput {
	name?: string;
	strategy?: AuthGatewayPoolStrategy;
}

export interface SetPoolCredentialOrderInput {
	credentialIds: number[];
}

export interface SetUserPoolOrderInput {
	poolIds: number[];
}

/**
 * Row shape emitted by `GET /v1/models`. Beyond the OpenAI-standard
 * `id`/`object`/`owned_by`, rows advertise the catalog metadata
 * OpenAI-compatible clients read to size and capability-gate discovered models
 * (`supports_tools` is only emitted when the catalog reports `false`; absent
 * means usable).
 *
 * Single source for the field names: the server builds rows against this type
 * and the admin client declares the subset it consumes as a `Pick` of it, so
 * renaming or dropping a consumed field is a compile error on the client. It
 * does NOT constrain the client's runtime validation — whether added metadata
 * is tolerated is a wire-compatibility question, guarded by the client's
 * stripping schema and the live server-to-client model-list test.
 */
export interface AuthGatewayModelListRow {
	id: string;
	object: "model";
	owned_by: string;
	api: Api;
	/**
	 * Catalog kind for non-chat rows (`judge`, `image`, `tts`, `stt`,
	 * `embedding`, `rerank`, `video`), so clients keep them off chat routes;
	 * absent means chat.
	 */
	kind?: ModelKind;
	display_name: string;
	context_length?: number;
	max_output_tokens?: number;
	input_modalities: ("text" | "image")[];
	supports_tools?: boolean;
}

export interface AuthGatewayModelSummary {
	/**
	 * Gateway-qualified selector as advertised by `GET /v1/models` —
	 * `<provider>/<modelId>`, where `<modelId>` may itself contain slashes
	 * (openrouter ids such as `openrouter/~anthropic/claude-fable-latest`).
	 * Usable verbatim as a request `model` and as an exact model ACL pattern.
	 */
	id: string;
	provider: string;
	api: Api;
}

export interface AuthGatewayAdminStatusResponse {
	status: AuthGatewayAdminStatus;
}

export interface AuthGatewayUsersResponse {
	users: AuthGatewayUser[];
}

export interface AuthGatewayUserResponse {
	user: AuthGatewayUser;
}

export interface AuthGatewayUserDetailsResponse extends AuthGatewayUserDetails {}

export interface AuthGatewayTokenResponse {
	token: AuthGatewayIssuedTokenValue;
}

export interface AuthGatewayAclResponse {
	acl: AuthGatewayAclRule[];
}

export interface AuthGatewayAclRuleResponse {
	rule: AuthGatewayAclRule;
}

export interface AuthGatewayUserPoolsResponse {
	bindings: AuthGatewayUserPoolBinding[];
}

export interface AuthGatewayPoolBindResponse {
	binding: AuthGatewayUserPoolBinding;
	created: boolean;
}

export interface AuthGatewayAclBatchResponse {
	results: AuthGatewayAclBatchResult[];
}

export interface AuthGatewayUsageResponse {
	usage: AuthGatewayUsageSummary;
}

export interface AuthGatewaySelfUsageResponse extends AuthGatewayUsageResponse {
	principal: Pick<AuthGatewayPrincipal, "kind" | "userId" | "name" | "role" | "tokenId">;
}

export interface AuthGatewayUsageReportsResponse {
	generatedAt: number;
	reports: UsageReport[];
	principal?: Pick<AuthGatewayPrincipal, "kind" | "userId" | "name" | "role" | "tokenId">;
}

export interface AuthGatewayPoolsResponse {
	pools: AuthGatewayPool[];
}

export interface AuthGatewayPoolResponse {
	pool: AuthGatewayPool;
}

export interface AuthGatewayPoolUsersResponse {
	users: AuthGatewayUser[];
}

export interface AuthGatewayCredentialsResponse {
	credentials: AuthGatewayCredentialSummary[];
}

export interface AuthGatewayCredentialResponse {
	credential: AuthGatewayCredentialSummary;
}

export interface AuthGatewayCredentialResetResponse {
	outcome: ResetCreditRedeemOutcome;
}

export interface AuthGatewayCredentialUploadRequest {
	provider: string;
	credential: AuthCredential;
}

export interface AuthGatewayCredentialInUseDetails {
	credentialId: number;
	pools: Array<{ id: number; name: string }>;
}

export interface AuthGatewayManagementErrorResponse {
	error: {
		code: string;
		message: string;
		details?: AuthGatewayCredentialInUseDetails;
	};
}
