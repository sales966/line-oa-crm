/**
 * routes/qr.ts — 轻量 QR code 产生(免登入,与 /api/health 同级豁免;见 authHook.ts 豁免清单)。
 * - GET /api/qr?data=<url>&size=<px> → 回传 SVG(image/svg+xml)
 *   用途:登入页显示后端网址/插件下载 QR、后台「📱 手機版 QR」让手机扫码进后台。
 * 安全:免登入端点,故 data 严格校验——只允许 http/https URL、长度 < 2048;
 *   size 夹在 96–1024;svg 由 qrcode 产生(不含外部资源),纯静态回应。
 */
import type { FastifyInstance } from 'fastify';
import QRCode from 'qrcode';

const MAX_DATA_LEN = 2048;
const MIN_SIZE = 96;
const MAX_SIZE = 1024;
const DEFAULT_SIZE = 256;

export default async function qrRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/qr?data=<url>&size=<px>
  app.get('/api/qr', async (req, reply) => {
    const q = req.query as { data?: unknown; size?: unknown };

    const data = typeof q.data === 'string' ? q.data.trim() : '';
    if (!data) return reply.code(400).send({ error: '缺少 data' });
    if (data.length >= MAX_DATA_LEN) return reply.code(400).send({ error: 'data 過長' });

    // 只允许 http/https URL(免登入端点,收窄输入面,避免被拿去编码任意内容)
    let url: URL;
    try {
      url = new URL(data);
    } catch {
      return reply.code(400).send({ error: 'data 必須為合法 URL' });
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return reply.code(400).send({ error: 'data 僅支援 http/https URL' });
    }

    // size:夹在合理范围,非数字则用预设
    let size = DEFAULT_SIZE;
    const rawSize = typeof q.size === 'string' ? Number(q.size) : NaN;
    if (Number.isFinite(rawSize)) {
      size = Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(rawSize)));
    }

    const svg = await QRCode.toString(data, { type: 'svg', width: size, margin: 1 });
    reply
      .header('content-type', 'image/svg+xml; charset=utf-8')
      .header('cache-control', 'public, max-age=86400')
      .send(svg);
    return reply;
  });
}
