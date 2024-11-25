import crypto from 'node:crypto';

import * as v from '@badrap/valita';
import { differenceInDays } from 'date-fns/differenceInDays';
import * as tld from 'tldts';

import {
	serializedState,
	type DidWebInfo,
	type InstanceInfo,
	type LabelerInfo,
	type SerializedState,
} from '../src/state';

import { DEFAULT_HEADERS, EXCLUSIONS_RE, JETSTREAM_URL, MAX_FAILURE_DAYS, PLC_URL } from '../src/constants';
import { didDocument, type DidDocument } from '../src/utils/did';
import { PromiseQueue } from '../src/utils/pqueue';
import { LineBreakStream, TextDecoderStream } from '../src/utils/stream';
import { createWebSocketStream } from '../src/utils/websocket';

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
				const pds = getEndpoint(operation.services.atproto_pds?.endpoint);
				const labeler = getEndpoint(operation.services.atproto_labeler?.endpoint);

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
		services: Record<string, Service>;
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
			setTimeout(() => (throttled = false), 60_000).unref();

			console.log(`  at ${new Date(cursor / 1_000).toISOString()}`);
		}

		const kind = data.kind;
		if (kind === 'account' || kind === 'identity') {
			const did = data.did;

			if (did.startsWith('did:web:')) {
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
					const signal = AbortSignal.timeout(15_000);
					const res = await get(`https://${host}/.well-known/did.json`, signal);

					const contentType = res.headers.get('content-type');
					if (!contentType) {
						throw new Error(`missing content type`);
					}
					if (!contentType.includes('application/json')) {
						throw new Error(`incorrect content-type; got ${contentType}`);
					}

					const text = await res.text();
					const sha256sum = getHash('sha256', text);

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

	await Bun.write(env.STATE_FILE, JSON.stringify(serialized, null, '\t'));
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

function getPdsEndpoint(doc: DidDocument): string | undefined {
	return getServiceEndpoint(doc, '#atproto_pds', 'AtprotoPersonalDataServer');
}

function getLabelerEndpoint(doc: DidDocument): string | undefined {
	return getServiceEndpoint(doc, '#atproto_labeler', 'AtprotoLabeler');
}

function getServiceEndpoint(doc: DidDocument, serviceId: string, serviceType: string): string | undefined {
	const did = doc.id;

	const didServiceId = did + serviceId;
	const found = doc.service?.find((service) => service.id === serviceId || service.id === didServiceId);

	if (!found || found.type !== serviceType || typeof found.serviceEndpoint !== 'string') {
		return undefined;
	}

	return getEndpoint(found.serviceEndpoint);
}
function getEndpoint(urlStr: string | undefined): string | undefined {
	if (urlStr === undefined) {
		return undefined;
	}

	const url = URL.parse(urlStr);

	if (
		!url ||
		!(url.protocol === 'http:' || url.protocol === 'https:') ||
		url.pathname !== '/' ||
		url.search !== '' ||
		url.hash !== '' ||
		url.port !== '' ||
		url.username !== '' ||
		url.password !== ''
	) {
		return undefined;
	}

	const parsed = tld.parse(url.hostname);
	if (!parsed.domain || !(parsed.isIcann || parsed.isIp)) {
		return undefined;
	}

	return url.href;
}

function getHash(algo: string, data: string) {
	const hasher = crypto.createHash(algo);
	hasher.update(data);

	return hasher.digest('base64url');
}
