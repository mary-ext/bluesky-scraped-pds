export const jsonFetch: typeof fetch = async (input, init) => {
	const MAX_LENGTH = 1 * 1000 * 1000;

	const response = await fetch(input, init);
	const headers = response.headers;

	const type = headers.get('content-type');
	if (type === null || !/\bapplication\/json\b/.test(type)) {
		response.body?.cancel();
		throw new TypeError(`expected 'application/json' as the response type`);
	}

	const rawLength = headers.get('content-length');
	let length: number | undefined;
	if (rawLength !== null) {
		length = Number(rawLength);
		if (!Number.isSafeInteger(length) || length <= 0) {
			response.body?.cancel();
			throw new RangeError(`response length can't be determined`);
		}
		if (length > MAX_LENGTH) {
			response.body?.cancel();
			throw new RangeError(`response length is more than expected`);
		}
	}

	let stream: ReadableStream<Uint8Array>;

	{
		const definedMaxLength = Math.min(MAX_LENGTH, length ?? MAX_LENGTH);
		const reader = response.body!.getReader();

		let totalBytes = 0;

		stream = new ReadableStream({
			async pull(controller) {
				const { done, value } = await reader.read();

				if (done) {
					controller.close();
					return;
				}

				totalBytes += value.byteLength;
				if (totalBytes > definedMaxLength) {
					controller.error(new RangeError(`response length is more than expected (${definedMaxLength})`));
					reader.cancel();
					return;
				}

				controller.enqueue(value);
			},
			cancel() {
				reader.cancel();
			},
		});
	}

	return new Response(stream, {
		headers: response.headers,
		status: response.status,
		statusText: response.statusText,
	});
};
