export const PLC_URL = `https://plc.directory`;
export const RELAY_URL = `https://relay1.us-west.bsky.network`;

export const JETSTREAM_URLS = [
	`wss://jetstream1.us-east.bsky.network/subscribe`,
	`wss://jetstream2.us-east.bsky.network/subscribe`,
	`wss://jetstream1.us-west.bsky.network/subscribe`,
	`wss://jetstream2.us-west.bsky.network/subscribe`,
];
export const JETSTREAM_URL = JETSTREAM_URLS[(Math.random() * JETSTREAM_URLS.length) | 0];

/** If `now` and `errorAt` has passed this amount of days, it should stop tracking. */
export const MAX_FAILURE_DAYS = 14;

export const USER_AGENT = 'github:mary-ext/atproto-scraping';
export const DEFAULT_HEADERS = {
	'user-agent': USER_AGENT,
};

// None of these are either a personal data server or labeler instance.
// - bsky.social is an entryway, not the actual PDS.
export const EXCLUSIONS_RE =
	/^https?:\/\/(?:bsky\.social|bsky\.network|jetstream\d+\.[a-z-]+\.bsky\.network)$/;
