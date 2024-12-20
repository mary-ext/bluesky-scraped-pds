import { simpleFetchHandler, XRPC, XRPCError } from '@atcute/client';
import * as v from '@badrap/valita';

import { differenceInDays } from 'date-fns/differenceInDays';

import { DEFAULT_HEADERS, MAX_FAILURE_DAYS } from '../src/constants';
import { serializedState, type LabelerInfo, type PDSInfo, type SerializedState } from '../src/state';

import { PromiseQueue } from '../src/utils/pqueue';

const now = Date.now();

const env = v.object({ STATE_FILE: v.string() }).parse(process.env, { mode: 'passthrough' });

let state: SerializedState | undefined;

// Read existing state file
{
	let json: unknown;

	try {
		json = await Bun.file(env.STATE_FILE).json();
	} catch {}

	if (json !== undefined) {
		state = serializedState.parse(json);
	}
}

// Some schema validations
const pdsDescribeServerResponse = v.object({
	availableUserDomains: v.array(v.string()),
	did: v.string(),

	contact: v.object({ email: v.string().optional() }).optional(),
	inviteCodeRequired: v.boolean().optional(),
	links: v.object({ privacyPolicy: v.string().optional(), termsOfService: v.string().optional() }).optional(),
	phoneVerificationRequired: v.boolean().optional(),
});

const labelerQueryLabelsResponse = v.object({
	cursor: v.string().optional(),
	labels: v.array(
		v.object({
			src: v.string(),
			uri: v.string(),
			val: v.string(),
			cts: v.string(),

			cid: v.string().optional(),
			exp: v.string().optional(),
			neg: v.boolean().optional(),
			sig: v.object({ $bytes: v.string() }).optional(),
			ver: v.number().optional(),
		}),
	),
});

const offHealthResponse = v.object({
	version: v.string().assert((input) => input.length <= 130),
});

const limitedFetch: typeof fetch = async (input, init) => {
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

// Global states
const pdses = new Map<string, PDSInfo>(state ? Object.entries(state.pdses) : []);
const labelers = new Map<string, LabelerInfo>(state ? Object.entries(state.labelers) : []);

const queue = new PromiseQueue();

// Connect to PDSes
console.log(`crawling known pdses`);

await Promise.all(
	Array.from(pdses, ([href, obj]) => {
		return queue.add(async () => {
			const host = new URL(href).host;
			const rpc = new XRPC({ handler: simpleFetchHandler({ service: href, fetch: limitedFetch }) });

			const start = performance.now();

			const signal = AbortSignal.timeout(15_000);
			const meta = await rpc
				.get('com.atproto.server.describeServer', { signal, headers: DEFAULT_HEADERS })
				.then(({ data: rawData }) => {
					const data = pdsDescribeServerResponse.parse(rawData, { mode: 'passthrough' });

					if (data.did !== `did:web:${host}`) {
						throw new Error(`did mismatch`);
					}

					return data;
				})
				.catch(() => null);

			const end = performance.now();

			if (meta === null) {
				const errorAt = obj.errorAt;

				if (errorAt === undefined) {
					obj.errorAt = now;
				} else if (differenceInDays(now, errorAt) > MAX_FAILURE_DAYS) {
					// It's been days without a response, stop tracking.

					pdses.delete(href);
					return;
				}

				console.log(`  ${host}: fail (took ${end - start})`);
				return { host, info: obj };
			}

			const version = await getVersion(rpc, obj.version);

			obj.version = version;
			obj.inviteCodeRequired = meta.inviteCodeRequired;
			obj.errorAt = undefined;

			console.log(`  ${host}: pass (took ${end - start})`);
			return { host, info: obj };
		});
	}),
).then((results) => results.filter((r) => r !== undefined));

// Connect to labelers
console.log(`crawling known labelers`);

await Promise.all(
	Array.from(labelers, async ([href, obj]) => {
		return queue.add(async () => {
			const host = new URL(href).host;
			const rpc = new XRPC({ handler: simpleFetchHandler({ service: href, fetch: limitedFetch }) });

			const start = performance.now();

			const signal = AbortSignal.timeout(15_000);
			const meta = await rpc
				.get('com.atproto.label.queryLabels', {
					signal: signal,
					headers: DEFAULT_HEADERS,
					params: { uriPatterns: ['*'], limit: 1 },
				})
				.then(({ data: rawData }) => labelerQueryLabelsResponse.parse(rawData, { mode: 'passthrough' }))
				.catch(() => null);

			const end = performance.now();

			if (meta === null) {
				const errorAt = obj.errorAt;

				if (errorAt === undefined) {
					obj.errorAt = now;
				} else if (differenceInDays(now, errorAt) > MAX_FAILURE_DAYS) {
					// It's been days without a response, stop tracking.

					labelers.delete(href);
					return;
				}

				console.log(`  ${host}: fail (took ${end - start})`);
				return { host, info: obj };
			}

			const version = await getVersion(rpc, obj.version);

			obj.version = version;
			obj.errorAt = undefined;

			console.log(`  ${host}: pass (took ${end - start})`);
			return { host, info: obj };
		});
	}),
).then((results) => results.filter((r) => r !== undefined));

// Persist the state
{
	const serialized: SerializedState = {
		firehose: {
			cursor: state?.firehose.cursor,
			didWebs: state?.firehose.didWebs || {},
		},
		plc: {
			cursor: state?.plc.cursor,
		},

		pdses: Object.fromEntries(Array.from(pdses)),
		labelers: Object.fromEntries(Array.from(labelers)),
	};

	// Properly sort the JSON state for clarity
	const isPlainObject = (o: any): boolean => {
		if (typeof o !== 'object' || o === null) {
			return false;
		}

		const proto = Object.getPrototypeOf(o);
		return (proto === null || proto === Object.prototype) && Object.isExtensible(o);
	};

	const replacer = (_key: string, value: any): any => {
		if (isPlainObject(value)) {
			const keys = Object.keys(value).sort();
			const obj: any = {};

			for (let i = 0, ilen = keys.length; i < ilen; i++) {
				const key = keys[i];
				obj[key] = value[key];
			}

			return obj;
		}

		return value;
	};

	await Bun.write(env.STATE_FILE, JSON.stringify(serialized, replacer, '\t'));
}

async function getVersion(rpc: XRPC, prev: string | null | undefined) {
	// skip if the response previously returned null (not official distrib)
	if (prev === null) {
		return null;
	}

	try {
		// @ts-expect-error: undocumented endpoint
		const { data: rawData } = await rpc.get('_health', { headers: DEFAULT_HEADERS });
		const { version } = offHealthResponse.parse(rawData, { mode: 'passthrough' });

		return /^[0-9a-f]{40}$/.test(version) ? `git-${version.slice(0, 7)}` : version;
	} catch (err) {
		if (err instanceof XRPCError && (err.status === 404 || err.status === 501)) {
			// Not implemented.
			return null;
		}
	}

	return undefined;
}
