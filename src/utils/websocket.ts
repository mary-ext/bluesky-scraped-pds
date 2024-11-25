import { WebSocket } from 'partysocket';

export const createWebSocketStream = <T = any>({
	url,
	onOpen,
	onClose,
}: {
	url: () => string;
	onOpen?: () => void;
	onClose?: () => void;
}) => {
	let ws: WebSocket | undefined;
	let closed = false;

	return new ReadableStream<T>({
		start(controller) {
			ws = new WebSocket(url, null, { maxRetries: Infinity });
			closed = false;

			ws.addEventListener('open', () => {
				onOpen?.();
			});
			ws.addEventListener('close', (ev) => {
				onClose?.();

				if (!closed && ev.wasClean) {
					closed = true;
					controller.close();
				}
			});
			ws.addEventListener('message', (ev) => {
				controller.enqueue(JSON.parse(ev.data));
			});
		},
		cancel() {
			closed = true;
			ws?.close();
		},
	});
};
