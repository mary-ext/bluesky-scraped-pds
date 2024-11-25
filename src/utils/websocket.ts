import { WebSocket } from 'partysocket';

export const createWebSocketStream = <T = any>(url: () => string) => {
	let ws: WebSocket | undefined;

	return new ReadableStream<T>({
		start(controller) {
			ws = new WebSocket(url, null, { maxRetries: Infinity });

			ws.addEventListener('message', (ev) => {
				controller.enqueue(JSON.parse(ev.data));
			});
		},
		cancel() {
			ws?.close();
		},
	});
};
