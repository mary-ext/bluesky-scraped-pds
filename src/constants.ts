export const PLC_URL = `https://plc.directory`;
export const RELAY_URL = `https://relay1.us-west.bsky.network`;

export const JETSTREAM_URL = `wss://jetstream1.us-east.bsky.network/subscribe`;

/** If `now` and `errorAt` has passed this amount of days, it should stop tracking. */
export const MAX_FAILURE_DAYS = 14;

export const USER_AGENT = 'github:mary-ext/atproto-scraping';
export const DEFAULT_HEADERS = {
	'user-agent': USER_AGENT,
};

// None of these are either a personal data server or labeler instance.
// - bsky.social is an entryway, not the actual PDS.
export const EXCLUSIONS_RE =
	/^https?:\/\/(?:bsky\.social|bsky\.app|bsky\.network|jetstream\d+\.[a-z-]+\.bsky\.network)\/?$/;

// - eclipse.pub is a nostr bridge
export const DID_WEB_EXCLUSIONS_RE = /\.(?:eclipse\.pub)$/;
