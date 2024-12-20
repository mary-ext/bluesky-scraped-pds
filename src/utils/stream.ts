export class LineBreakStream extends TransformStream<string, string> {
	constructor() {
		let current = '';

		super({
			transform(chunk, controller) {
				const lines = chunk.split('\n');
				const length = lines.length;

				if (length === 0) {
					// shouldn't be possible
				} else if (length === 1) {
					current = current + lines[0];
				} else if (length === 2) {
					controller.enqueue(current + lines[0]);
					current = lines[1];
				} else {
					controller.enqueue(current + lines[0]);

					for (let i = 1, il = length - 1; i < il; i++) {
						controller.enqueue(lines[i]);
					}

					current = lines[length - 1];
				}
			},
			flush(controller) {
				if (current.length > 0) {
					controller.enqueue(current);
				}
			},
		});
	}
}
