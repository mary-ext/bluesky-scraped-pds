import { differenceInDays } from 'date-fns/differenceInDays';

import {
	type DidWebInfo,
	type InstanceInfo,
	type LabelerInfo,
	type SerializedState,
	serializedState,
} from '../src/state.ts';

import {
	DEFAULT_HEADERS,
	DID_WEB_EXCLUSIONS_RE,
	EXCLUSIONS_RE,
	JETSTREAM_URL,
	MAX_FAILURE_DAYS,
	PLC_URL,
} from '../src/constants.ts';
import {
	coerceAtprotoServiceEndpoint,
	didDocument,
	getLabelerEndpoint,
	getPdsEndpoint,
} from '../src/utils/did.ts';
import { jsonFetch } from '../src/utils/json-fetch.ts';
import { PromiseQueue } from '../src/utils/pqueue.ts';
import { LineBreakStream } from '../src/utils/stream.ts';
import { createWebSocketStream } from '../src/utils/websocket.ts';

const now = Date.now();

const STATE_FILE = Deno.env.get('STATE_FILE')!;

let state: SerializedState | undefined;

// Read existing state file
{
	let json: unknown;

	try {
		const source = await Deno.readTextFile(STATE_FILE);
		json = JSON.parse(source);
	} catch {
		/* empty */
	}

	if (json !== undefined) {
		state = serializedState.parse(json);
	}
}

// Global states
const didWebs = new Map<string, DidWebInfo>(state ? Object.entries(state.firehose.didWebs) : []);
const pdses = new Map<string, InstanceInfo>(state ? Object.entries(state.pdses) : []);
const labelers = new Map<string, LabelerInfo>(state ? Object.entries(state.labelers) : []);

const queue = new PromiseQueue();

let plcCursor: string | undefined = state?.plc.cursor;
let firehoseCursor: number | undefined = state?.firehose.cursor;

// Iterate through PLC events
{
	const limit = 1000;
	let after: string | undefined = plcCursor;

	console.log(`crawling plc.directory`);
	console.log(`  starting ${plcCursor || '<root>'}`);

	do {
		const url = `${PLC_URL}/export` + `?count=${limit}` + (after ? `&after=${after}` : '');

		const response = await get(url);
		const stream = response.body!.pipeThrough(new TextDecoderStream()).pipeThrough(new LineBreakStream());

		after = undefined;

		let count = 0;

		for await (const raw of stream) {
			const json = JSON.parse(raw) as ExportEntry;
			const { did, operation, createdAt } = json;

			if (operation.type === 'plc_operation') {
				const pds = coerceAtprotoServiceEndpoint(operation.services.atproto_pds?.endpoint);
				const labeler = coerceAtprotoServiceEndpoint(operation.services.atproto_labeler?.endpoint);

				jump: if (pds) {
					if (EXCLUSIONS_RE.test(pds)) {
						console.log(`  found excluded pds: ${pds}`);
						break jump;
					}

					const info = pdses.get(pds);

					if (info === undefined) {
						console.log(`  found pds: ${pds}`);
						pdses.set(pds, {});
					} else if (info.errorAt !== undefined) {
						// reset `errorAt` if we encounter this PDS
						console.log(`  found pds: ${pds} (errored)`);
						info.errorAt = undefined;
					}
				}

				jump: if (labeler) {
					if (EXCLUSIONS_RE.test(labeler)) {
						console.log(`  found excluded labeler: ${labeler}`);
						break jump;
					}

					const info = labelers.get(labeler);

					if (info === undefined) {
						console.log(`  found labeler: ${labeler}`);
						labelers.set(labeler, { did });
					} else {
						if (info.errorAt !== undefined) {
							// reset `errorAt` if we encounter this labeler
							console.log(`  found labeler: ${labeler} (errored)`);
							info.errorAt = undefined;
						}

						info.did = did;
					}
				}
			}

			count++;
			after = createdAt;
		}

		if (after) {
			plcCursor = after;
		}

		if (count < limit) {
			break;
		}
	} while (after !== undefined);

	console.log(`  ending ${plcCursor || '<root>'}`);

	interface ExportEntry {
		did: string;
		operation: PlcOperation;
		cid: string;
		nullified: boolean;
		createdAt: string;
	}

	type PlcOperation = LegacyGenesisOp | OperationOp | TombstoneOp;

	interface OperationOp {
		type: 'plc_operation';
		/** did:key[] */
		rotationKeys: string[];
		/** Record<string, did:key> */
		verificationMethods: Record<string, string>;
		alsoKnownAs: string[];
		services: Record<string, Service | undefined>;
		prev: string | null;
		sig: string;
	}

	interface TombstoneOp {
		type: 'plc_tombstone';
		prev: string;
		sig: string;
	}

	interface LegacyGenesisOp {
		type: 'create';
		/** did:key */
		signingKey: string;
		/** did:key */
		recoveryKey: string;
		handle: string;
		service: string;
		prev: string | null;
		sig: string;
	}

	interface Service {
		type: string;
		endpoint: string;
	}
}

// Watch the relay to find any did:web identities
{
	// run it 5 seconds back
	let cursor: number | undefined = Math.max(0, (firehoseCursor ?? 0) - 5 * 1_000_000);
	let throttled = false;

	console.log(`listening to relay`);
	console.log(`  connecting to ${JETSTREAM_URL}`);
	console.log(`  starting ${cursor || `<root>`}`);

	const url = JETSTREAM_URL + `?cursor=${cursor}` + `&wantedCollections=invalid.nsid.record`;

	for await (const data of createWebSocketStream<JetstreamEvent>(url)) {
		if (data.time_us > cursor) {
			cursor = data.time_us;
		}

		if (cursor / 1_000_000 > Date.now() / 1_000 - 3) {
			break;
		}

		if (!throttled) {
			throttled = true;
			Deno.unrefTimer(setTimeout(() => (throttled = false), 60_000));

			console.log(`  at ${new Date(cursor / 1_000).toISOString()}`);
		}

		const kind = data.kind;
		if (kind === 'account' || kind === 'identity') {
			const did = data.did;

			if (did.startsWith('did:web:')) {
				if (DID_WEB_EXCLUSIONS_RE.test(did)) {
					console.log(`  found excluded did: ${did}`);
					continue;
				}

				const info = didWebs.get(did);

				if (info === undefined) {
					console.log(`  found ${did}`);
					didWebs.set(did, {});
				} else if (info.errorAt !== undefined) {
					// reset `errorAt` if we encounter this did:web
					console.log(`  found ${did} (errored)`);
					info.errorAt = undefined;
				}
			}
		}
	}

	console.log(`  ending ${cursor || `<root>`}`);

	firehoseCursor = cursor;

	type JetstreamEvent = AccountEvent | IdentityEvent;

	interface AccountEvent {
		kind: 'account';
		did: string;
		time_us: number;
		account: {
			seq: number;
			did: string;
			time: string;
			active: boolean;
		};
	}

	interface IdentityEvent {
		kind: 'identity';
		did: string;
		time_us: number;
		identity: {
			seq: number;
			did: string;
			time: string;
			handle?: string;
		};
	}
}

// Retrieve PDS information from known did:web identities
{
	console.log(`crawling known did:web identities`);
	const dids = Array.from(didWebs.keys());

	await Promise.all(
		dids.map((did) => {
			return queue.add(async () => {
				const host = did.slice(8);
				const obj = didWebs.get(did)!;

				try {
					const signal = AbortSignal.timeout(5_000);

					const res = await jsonFetch(`https://${host}/.well-known/did.json`, { signal });
					if (!res.ok) {
						throw new Error(`got ${res.status}`);
					}

					const text = await res.text();
					const sha256sum = await getSha256Hash(text);

					if (obj.hash !== sha256sum) {
						const json = JSON.parse(text);
						const doc = didDocument.parse(json, { mode: 'passthrough' });

						const pds = getPdsEndpoint(doc);
						const labeler = getLabelerEndpoint(doc);

						console.log(`  ${did}: pass (updated)`);

						jump: if (pds) {
							if (EXCLUSIONS_RE.test(pds)) {
								console.log(`  found excluded pds: ${pds}`);
								break jump;
							}

							const info = pdses.get(pds);

							if (info === undefined) {
								console.log(`    found pds: ${pds}`);
								pdses.set(pds, {});
							} else if (info.errorAt !== undefined) {
								// reset `errorAt` if we encounter this PDS
								console.log(`    found pds: ${pds} (errored)`);
								info.errorAt = undefined;
							}
						}

						jump: if (labeler) {
							if (EXCLUSIONS_RE.test(labeler)) {
								console.log(`  found excluded labeler: ${labeler}`);
								break jump;
							}

							const info = labelers.get(labeler);

							if (info === undefined) {
								console.log(`    found labeler: ${labeler}`);
								labelers.set(labeler, { did });
							} else {
								if (info.errorAt !== undefined) {
									// reset `errorAt` if we encounter this labeler
									console.log(`    found labeler: ${labeler} (errored)`);
									info.errorAt = undefined;
								}

								info.did = did;
							}
						}

						obj.hash = sha256sum;

						obj.pds = pds;
						obj.labeler = labeler;
					} else {
						console.log(`  ${did}: pass`);
					}

					obj.errorAt = undefined;
				} catch (err) {
					const errorAt = obj.errorAt;

					if (errorAt === undefined) {
						obj.errorAt = now;
					} else if (differenceInDays(now, errorAt) > MAX_FAILURE_DAYS) {
						// It's been days without a response, stop tracking.

						didWebs.delete(did);
					}

					console.log(`  ${did}: fail (${err})`);
				}
			});
		}),
	);
}

// Persist the state
{
	const serialized: SerializedState = {
		firehose: {
			cursor: firehoseCursor,
			didWebs: Object.fromEntries(Array.from(didWebs)),
		},
		plc: {
			cursor: plcCursor,
		},

		pdses: Object.fromEntries(Array.from(pdses)),
		labelers: Object.fromEntries(Array.from(labelers)),
	};

	await Deno.writeTextFile(STATE_FILE, JSON.stringify(serialized, null, '\t'));
}

async function get(url: string, signal?: AbortSignal): Promise<Response> {
	const response = await fetch(url, { signal, headers: DEFAULT_HEADERS });

	if (response.status === 429) {
		const delay = 90_000;

		console.log(`[-] ratelimited, waiting ${delay} ms`);

		await sleep(delay);
		return get(url, signal);
	}

	if (!response.ok) {
		throw new Error(`got ${response.status} from ${url}`);
	}

	return response;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getSha256Hash(data: string) {
	const encoder = new TextEncoder();
	const bytes = encoder.encode(data);

	const hash = await crypto.subtle.digest('SHA-256', bytes);

	return toBase64Url(new Uint8Array(hash));
}

function toBase64Url(array: Uint8Array) {
	const BASE64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
	const len = array.length;

	let result = '';
	let idx = 0;
	let triplet: number;

	const at = (shift: number): string => {
		return BASE64_ALPHABET[(triplet >> (6 * shift)) & 63];
	};

	for (; idx + 2 < len; idx += 3) {
		triplet = (array[idx] << 16) + (array[idx + 1] << 8) + array[idx + 2];
		result += at(3) + at(2) + at(1) + at(0);
	}

	if (idx + 2 === len) {
		triplet = (array[idx] << 16) + (array[idx + 1] << 8);
		result += at(3) + at(2) + at(1);
	} else if (idx + 1 === len) {
		triplet = array[idx] << 16;
		result += at(3) + at(2);
	}

	return result;
}
