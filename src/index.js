import { Hono } from 'hono/tiny';
import { decryptM3u8, init } from './dha';

const app = new Hono();

const MAX_RETRIES = 3;
const RETRY_DELAY = 500; // ms

const buildInsertOrUpdateQuery = ({ table, cols, values }) => {
	return `INSERT OR REPLACE INTO ${table} (${cols}) VALUES (${values});`;
};

const buildSelectQuery = ({ col, table, where, distinct }) => {
	return `SELECT${distinct ? ' DISTINCT' : ' '} ${col} FROM ${table} WHERE ${where}`;
};

async function retryOperation(operation, maxRetries = MAX_RETRIES) {
	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			return await operation();
		} catch (error) {
			if (attempt >= maxRetries) {
				throw error;
			}
			await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
		}
	}
}

async function initAndDecrypt(hash) {
	await init({ hostname: 'localhost' });
	return await decryptM3u8(hash);
}

async function setPlayUrl(c, uuid, decrypted) {
	const base64Content = btoa(decrypted);

	await c.env.DB.exec(
		buildInsertOrUpdateQuery({
			table: 'link',
			cols: ['uuid', 'content'],
			values: `'${uuid}', '${base64Content}'`,
		})
	);
}

app.post('/', async (c) => {
	try {
		const { hash } = await c.req.json();

		const decrypted = await retryOperation(() => initAndDecrypt(hash));
		const uuid = crypto.randomUUID();

		await retryOperation(() => setPlayUrl(c, uuid, decrypted));

		return c.text(`https://decrypt-hls.dph.workers.dev/${uuid}/video.m3u8`);
	} catch (error) {
		return c.text('Internal Server Error', 500);
	}
});

app.get('/:uuid/video.m3u8', async (c) => {
	try {
		const { uuid } = c.req.param();
		const query = buildSelectQuery({
			col: '*',
			table: 'link',
			where: `uuid = ?`,
		});

		const data = await c.env.DB.prepare(query).bind(uuid).first();

		if (!data) {
			return c.text('Not found', 404);
		}

		const content = atob(data.content);

		c.executionCtx.waitUntil(c.env.DB.exec(`DELETE FROM link WHERE uuid = '${uuid}'`));

		return c.newResponse(content, {
			headers: {
				'Content-Type': 'application/vnd.apple.mpegurl',
			},
		});
	} catch (error) {
		return c.text('Internal Server Error', 500);
	}
});

export default app;
