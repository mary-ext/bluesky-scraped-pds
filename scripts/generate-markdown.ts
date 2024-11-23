import * as v from '@badrap/valita';

import { serializedState, type SerializedState } from '../src/state';

const env = v
	.object({ STATE_FILE: v.string(), RESULT_FILE: v.string() })
	.parse(process.env, { mode: 'passthrough' });

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

// Markdown stuff
{
	const PDS_BSKY_TABLE = /(?<=<!-- bsky-pds-start -->)[^]*(?=<!-- bsky-pds-end -->)/;
	const PDS_3P_TABLE = /(?<=<!-- 3p-pds-start -->)[^]*(?=<!-- 3p-pds-end -->)/;
	const LABELER_BSKY_RE = /(?<=<!-- bsky-labeler-start -->)[^]*(?=<!-- bsky-labeler-end -->)/;
	const LABELER_3P_RE = /(?<=<!-- 3p-labeler-start -->)[^]*(?=<!-- 3p-labeler-end -->)/;

	const template = `# Scraped AT Protocol instances

Last updated: {{time}}[^1]

Found by enumerating plc.directory and bsky.network, some instances might not be
part of mainnet.

Instances that have not been active for more than 14 days gets dropped off from this list.

## Personal data servers

{{pdsSummary}}

### Bluesky-hosted servers

<!-- bsky-pds-start --><!-- bsky-pds-end -->

### Third-party servers

<!-- 3p-pds-start --><!-- 3p-pds-end -->

## Labelers

{{labelerSummary}}

### Bluesky labelers

<!-- bsky-labeler-start --><!-- bsky-labeler-end -->

### Third-party labelers

<!-- 3p-labeler-start --><!-- 3p-labeler-end -->

---

[^1]: Reflecting actual changes, not when the scraper was last run
`;

	let pds3pTable = `
| PDS | Open? | Version |
| --- | --- | --- |
`;

	let pdsBskyTable = `
| PDS | Open? | Version |
| --- | --- | --- |
`;

	let labeler3pTable = `
| Labeler | Version |
| --- | --- |
`;

	let labelerBskyTable = `
| Labeler | Version |
| --- | --- |
`;

	const pdses = Object.entries(state?.pdses ?? {});
	const labelers = Object.entries(state?.labelers ?? {});

	// Generate the PDS table
	for (const [href, info] of pdses) {
		const host = new URL(href).host;
		const { errorAt, inviteCodeRequired, version } = info;

		const on = errorAt === undefined ? '✅' : '❌';
		const v = version ? sanitize(version) : version === null ? 'N/A' : '???';
		const invites = inviteCodeRequired === false ? 'Yes' : 'No';

		if (isBlueskyHost(host)) {
			pdsBskyTable += `| ${on} ${host} | ${invites} | ${v} |\n`;
		} else {
			pds3pTable += `| ${on} ${host} | ${invites} | ${v} |\n`;
		}
	}

	// Generate the labeler table
	for (const [href, info] of labelers) {
		const host = new URL(href).host;
		const { errorAt, version } = info;

		const on = errorAt === undefined ? '✅' : '❌';
		const v = version ? sanitize(version) : version === null ? 'N/A' : '???';

		if (isBlueskyHost(host)) {
			labelerBskyTable += `| ${on} ${host} | ${v} |\n`;
		} else {
			labeler3pTable += `| ${on} ${host} | ${v} |\n`;
		}
	}

	// Read existing Markdown file, check if it's equivalent
	let shouldWrite = true;

	try {
		const source = await Bun.file(env.RESULT_FILE).text();

		if (
			PDS_3P_TABLE.exec(source)?.[0] === pds3pTable &&
			PDS_BSKY_TABLE.exec(source)?.[0] === pdsBskyTable &&
			LABELER_3P_RE.exec(source)?.[0] === labeler3pTable &&
			LABELER_BSKY_RE.exec(source)?.[0] === labelerBskyTable
		) {
			shouldWrite = false;
		}
	} catch {}

	// Write the markdown file
	if (shouldWrite) {
		const final = template
			.replace('{{time}}', new Date().toISOString())
			.replace('{{pdsSummary}}', getPdsSummary())
			.replace('{{labelerSummary}}', getLabelerSummary())
			.replace(PDS_3P_TABLE, pds3pTable)
			.replace(PDS_BSKY_TABLE, pdsBskyTable)
			.replace(LABELER_3P_RE, labeler3pTable)
			.replace(LABELER_BSKY_RE, labelerBskyTable);

		await Bun.write(env.RESULT_FILE, final);
		console.log(`wrote to ${env.RESULT_FILE}`);
	} else {
		console.log(`writing skipped`);
	}

	function getPdsSummary() {
		let totalCount = 0;
		let onlineCount = 0;
		let offlineCount = 0;
		let blueskyHostedCount = 0;
		let nonBlueskyHostedCount = 0;

		for (const [href, info] of pdses) {
			const host = new URL(href).host;
			const { errorAt } = info;

			// `bsky.social` mainly acts as an authorization server for PDSes hosted
			// under *.host.bsky.network.
			if (host === 'bsky.social') {
				continue;
			}

			totalCount++;

			if (errorAt === undefined) {
				onlineCount++;
			} else {
				offlineCount++;
			}

			if (isBlueskyHost(host)) {
				blueskyHostedCount++;
			} else {
				nonBlueskyHostedCount++;
			}
		}

		return (
			`**${totalCount}** instances active  \n` +
			`**${onlineCount}** online  \n` +
			`**${offlineCount}** offline  \n` +
			`**${blueskyHostedCount}** hosted by Bluesky  \n` +
			`**${nonBlueskyHostedCount}** hosted by third-parties`
		);
	}

	function getLabelerSummary() {
		let totalCount = 0;
		let onlineCount = 0;
		let offlineCount = 0;

		for (const [href, info] of labelers) {
			const { errorAt } = info;

			totalCount++;

			if (errorAt === undefined) {
				onlineCount++;
			} else {
				offlineCount++;
			}
		}

		return (
			`**${totalCount}** instances active  \n` +
			`**${onlineCount}** online  \n` +
			`**${offlineCount}** offline`
		);
	}

	function isBlueskyHost(host: string): boolean {
		return /(?:^|\.)(?:bsky\.network|bsky\.app|bsky\.dev|bsky\.social)$/.test(host);
	}

	function sanitize(str: string): string {
		return str
			.replace(/[^ a-zA-Z0-9-_=+.,:;!`'"<>()\[\]/\\]/g, '')
			.replace(/([<\\\[!`]|(?<=\s)[_])/g, '\\$1')
			.slice(0, 65);
	}
}
