import { Hono } from 'hono/tiny';
import { decryptM3u8, init } from './dha';

const app = new Hono();

app.post('/', async (c) => {
	const uuid = crypto.randomUUID();
	try {
		const { hash } = await c.req.json();
		const platform = c.req.query('platform');

		await init({ hostname: 'localhost' });
		const decrypted = await decryptM3u8(hash);

		if (platform == 'ios') {
			const base64 = 'data:application/vnd.apple.mpegurl;base64,' + btoa(decrypted);
			return c.newResponse(base64, {
				headers: {
					'Content-Type': 'application/vnd.apple.mpegurl',
				},
			});
		}

		await c.env.PLAY_URL.put(uuid, decrypted, {
			expirationTtl: 60 * 60 * 24 * 1,
			metadata: {
				contentType: 'application/vnd.apple.mpegurl',
			},
		});
		return c.text(`https://decrypt-hls.dph.workers.dev/${uuid}/video.m3u8`);
	} catch (error) {
		await c.env.PLAY_URL.put('error:' + uuid, error.message, {
			metadata: {
				contentType: 'text/plain',
			},
		});
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
