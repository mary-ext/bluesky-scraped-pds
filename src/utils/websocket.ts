export const createWebSocketStream = <T = any>(url: string | URL) => {
	let ws: WebSocket | undefined;
	let closed = false;

	return new ReadableStream<T>({
		start(controller) {
			ws = new WebSocket(url);
			closed = false;

			ws.onclose = () => {
				if (!closed) {
					closed = true;
					controller.close();
				}
			};
			ws.onmessage = (ev) => {
				controller.enqueue(JSON.parse(ev.data));
			};
		},
		cancel() {
			closed = true;
			ws?.close();
		},
	});
};
