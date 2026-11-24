import { useEffect, useRef, useState } from "react";
import { Modal } from "../prototype/ui.tsx";

interface Confirmation {
	title: string;
	message?: string;
	confirmLabel?: string;
	destructive?: boolean;
}

/** Keep application confirmations in the current theme and focus Cancel by default. */
export function useConfirmation() {
	const [request, setRequest] = useState<Confirmation>();
	const resolver = useRef<((confirmed: boolean) => void) | undefined>(undefined);

	useEffect(() => () => {
		resolver.current?.(false);
		resolver.current = undefined;
	}, []);

	const confirm = (next: Confirmation): Promise<boolean> => {
		if (resolver.current) return Promise.resolve(false);
		return new Promise((resolve) => {
			resolver.current = resolve;
			setRequest(next);
		});
	};

	const answer = (confirmed: boolean) => {
		const resolve = resolver.current;
		resolver.current = undefined;
		setRequest(undefined);
		resolve?.(confirmed);
	};

	const confirmation = request && (
		<Modal title={request.title} close={() => answer(false)}>
			<div className="simple-dialog cc-confirmation">
				{request.message && <p>{request.message}</p>}
				<div className="dialog-actions">
					<button type="button" className="secondary-button" data-autofocus onClick={() => answer(false)}>取消</button>
					<button type="button" className={request.destructive ? "secondary-button cc-confirm-danger" : "primary-button"} onClick={() => answer(true)}>
						{request.confirmLabel ?? "确认"}
					</button>
				</div>
			</div>
		</Modal>
	);

	return { confirm, confirmation };
}
