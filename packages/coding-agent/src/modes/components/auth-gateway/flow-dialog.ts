import {
	type Component,
	Input,
	routeSelectListMouse,
	type SelectItem,
	SelectList,
	type SgrMouseEvent,
	truncateToWidth,
} from "@oh-my-pi/pi-tui";
import { getSelectListTheme, theme } from "@oh-my-pi/pi-tui/theme";

export type AuthGatewayFlowStep =
	| {
			id: string;
			kind: "choice";
			title: string;
			items: readonly SelectItem[];
			help: readonly string[];
			initialValue?: string;
			onSelect: (value: string, dialog: AuthGatewayFlowDialog) => void | Promise<void>;
	  }
	| {
			id: string;
			kind: "input";
			title: string;
			label: string;
			value: string;
			help: readonly string[];
			masked?: boolean;
			validate?: (value: string) => string | null;
			onSubmit: (value: string, dialog: AuthGatewayFlowDialog) => void | Promise<void>;
	  };

interface ActiveChoice {
	kind: "choice";
	step: Extract<AuthGatewayFlowStep, { kind: "choice" }>;
	component: SelectList;
	listRowOffset: number;
}

interface ActiveInput {
	kind: "input";
	step: Extract<AuthGatewayFlowStep, { kind: "input" }>;
	component: Input;
}

type ActiveFlowComponent = ActiveChoice | ActiveInput;

export class AuthGatewayFlowDialog implements Component {
	readonly #onClose: () => void;
	readonly #requestRender: () => void;
	#stack: AuthGatewayFlowStep[] = [];
	#active: ActiveFlowComponent | null = null;
	#error: string | null = null;
	#busy: string | null = null;
	#closed = false;

	constructor(options: { onClose: () => void; requestRender: () => void }) {
		this.#onClose = options.onClose;
		this.#requestRender = options.requestRender;
	}

	push(step: AuthGatewayFlowStep): void {
		if (this.#closed) return;
		this.#stack.push(step);
		this.#activate(step);
		this.#error = null;
		this.#requestRender();
	}

	replace(step: AuthGatewayFlowStep): void {
		if (this.#closed) return;
		if (this.#stack.length === 0) this.#stack.push(step);
		else this.#stack[this.#stack.length - 1] = step;
		this.#activate(step);
		this.#error = null;
		this.#requestRender();
	}

	pop(): void {
		if (this.#closed || this.#busy) return;
		this.#stack.pop();
		this.#error = null;
		const step = this.#stack.at(-1);
		if (!step) {
			this.close();
			return;
		}
		this.#activate(step);
		this.#requestRender();
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		this.#stack = [];
		this.#active = null;
		this.#error = null;
		this.#busy = null;
		this.#onClose();
		this.#requestRender();
	}

	setError(message: string | null): void {
		if (this.#closed) return;
		this.#error = message;
		this.#requestRender();
	}

	setBusy(label: string | null): void {
		if (this.#closed) return;
		this.#busy = label;
		this.#requestRender();
	}

	handleInput(data: string): void {
		if (this.#closed) return;
		if (data === "\x03") {
			this.close();
			return;
		}
		if (this.#busy) return;
		this.#active?.component.handleInput?.(data);
		this.#requestRender();
	}

	routeMouse(event: SgrMouseEvent, line: number, _col: number): void {
		if (this.#closed || this.#busy) return;
		if (this.#active?.kind !== "choice") return;
		routeSelectListMouse(this.#active.component, event, line - this.#active.listRowOffset);
		this.#requestRender();
	}

	invalidate(): void {
		this.#active?.component.invalidate?.();
	}

	render(width: number): readonly string[] {
		const active = this.#active;
		if (!active) return [];
		const lines: string[] = [theme.bold(active.step.title)];
		for (const help of active.step.help) lines.push(theme.fg("dim", help));
		if (this.#error) lines.push(theme.fg("error", this.#error));
		if (this.#busy) lines.push(theme.fg("accent", this.#busy));
		if (active.kind === "choice") {
			active.listRowOffset = lines.length;
			lines.push(...active.component.render(width));
		} else {
			lines.push(...active.component.render(width));
		}
		lines.push(theme.fg("dim", "Enter select/continue · Esc back/cancel · Ctrl-C cancel"));
		return lines.map(line => truncateToWidth(line, width));
	}

	#activate(step: AuthGatewayFlowStep): void {
		if (step.kind === "choice") {
			const list = new SelectList(step.items, Math.max(1, Math.min(step.items.length, 12)), getSelectListTheme());
			const initialIndex = step.initialValue ? step.items.findIndex(item => item.value === step.initialValue) : -1;
			if (initialIndex >= 0) list.setSelectedIndex(initialIndex);
			list.onSelect = item => {
				if (this.#busy) return;
				this.#error = null;
				void step.onSelect(item.value, this);
			};
			list.onCancel = () => this.pop();
			this.#active = { kind: "choice", step, component: list, listRowOffset: 0 };
			return;
		}
		const input = new Input();
		input.prompt = step.label;
		input.setValue(step.value);
		if (step.masked) input.setMask("•");
		input.onSubmit = value => {
			if (this.#busy) return;
			const error = step.validate?.(value) ?? null;
			if (error) {
				this.setError(error);
				return;
			}
			this.#error = null;
			void step.onSubmit(value, this);
		};
		input.onEscape = () => this.pop();
		this.#active = { kind: "input", step, component: input };
	}
}
