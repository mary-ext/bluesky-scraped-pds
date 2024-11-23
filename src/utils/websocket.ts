export const createWebSocketStream = <T = any>(url: string | URL) => {
	let ws: WebSocket | undefined;
	let closed = false;

	return new ReadableStream<T>({
		start(controller) {
			ws = new WebSocket(url);
			closed = false;

			ws.onclose = (ev) => {
				if (!closed) {
					closed = true;

					if (ev.wasClean) {
						controller.close();
					} else {
						controller.error(new Error(`websocket error ${ev.code}`));
					}
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
