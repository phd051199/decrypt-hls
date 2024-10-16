import { Hono } from 'hono/tiny';
import { decryptM3u8, init } from './dha';

interface Env {
	PLAY_URL: KVNamespace;
}

const app = new Hono<{ Bindings: Env }>();

app.post('/bulk', async (c) => {
	const { list } = await c.req.json();
	await init({ hostname: 'localhost' });
	const result = await Promise.all(
		list.map(async (hash: string) => {
			const decrypted = await decryptM3u8(hash);
			const base64 = 'data:application/vnd.apple.mpegurl;base64,' + btoa(decrypted);
			return base64;
		}),
	);

	return c.json(result);
});

app.post('/', async (c) => {
	const uuid = crypto.randomUUID();
	try {
		const { hash } = await c.req.json();
		const platform = c.req.query('platform');
		await init({ hostname: 'localhost' });

		const decrypted = await decryptM3u8(hash);

		if (platform === 'ios') {
			const base64 = 'data:application/vnd.apple.mpegurl;base64,' + btoa(decrypted);
			return c.newResponse(base64, {
				headers: {
					'Content-Type': 'application/vnd.apple.mpegurl',
				},
			});
		}

		await c.env.PLAY_URL.put(uuid, decrypted, {
			expirationTtl: 60 * 60 * 24,
			metadata: {
				contentType: 'application/vnd.apple.mpegurl',
			},
		});
		return c.text(`https://decrypt-hls.dph.workers.dev/${uuid}/video.m3u8`);
	} catch (error) {
		console.log(error);

		if (error instanceof Error) {
			await c.env.PLAY_URL.put('error:' + uuid, error.message, {
				metadata: {
					contentType: 'text/plain',
				},
			});
		}
		return c.text('Internal Server Error', 500);
	}
});

app.get('/:uuid/video.m3u8', async (c) => {
	try {
		const { uuid } = c.req.param();

		const data = await c.env.PLAY_URL.get(uuid);
		if (!data) {
			return c.text('Not found', 404);
		}

		return c.newResponse(data, {
			headers: {
				'Content-Type': 'application/vnd.apple.mpegurl',
			},
		});
	} catch (error) {
		return c.text('Internal Server Error', 500);
	}
});

export default app;
