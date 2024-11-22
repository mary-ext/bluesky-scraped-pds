export const PLC_URL = `https://plc.directory`;
export const RELAY_URL = `https://relay1.us-west.bsky.network`;

/** If `now` and `errorAt` has passed this amount of days, it should stop tracking. */
export const MAX_FAILURE_DAYS = 14;

export const USER_AGENT = 'github:mary-ext/atproto-scraping';
export const DEFAULT_HEADERS = {
	'user-agent': USER_AGENT,
};
