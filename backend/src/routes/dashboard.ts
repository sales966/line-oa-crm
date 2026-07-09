/**
 * routes/dashboard.ts — 总览仪表板 + 到期提醒 API(session 认证;全局 auth hook 已装饰 req.user)。
 * - GET /api/dashboard/stats      → 全站计数(客户数 / 各阶段 / 待处理 / 有总结 / 已完成)
 * - GET /api/dashboard/reminders  → 逾期/临近提醒清单(大貨死線 / 打樣 / 生產),按急迫度排序
 * 皆为只读,经 dashboardService。
 */
import type { FastifyInstance } from 'fastify';
import * as dashboardService from '../services/dashboardService.js';

export default async function dashboardRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/dashboard/stats
  app.get('/api/dashboard/stats', async () => {
    return dashboardService.stats();
  });

  // GET /api/dashboard/reminders
  app.get('/api/dashboard/reminders', async () => {
    return { reminders: dashboardService.reminders() };
  });
}
