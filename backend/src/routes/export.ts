/**
 * routes/export.ts — 客户清单导出 CSV(session 认证;全局 auth hook 已挡未登入)。
 * - GET /api/export/customers.csv → text/csv(UTF-8 BOM,Excel 直接开中文不乱码)
 *   栏位:客戶名稱、聊天類型、目前階段、大貨死線、訊息數、檔案數、待處理、
 *         最後訊息時間、最新總結(去换行、截断200字)、標籤(逗号分隔)。
 * 只读,经 chatService(listCustomers + tagsByChatId 组装),不直接碰 db。
 */
import type { FastifyInstance } from 'fastify';
import * as chatService from '../services/chatService.js';

// CSV 栏位转义:
// 1) 公式注入防御:首字为 = + - @(或 tab/CR)者前置单引号,避免 Excel 把
//    外部来源文字(如 LINE 显示名、总结)当公式执行。
// 2) 含逗号/引号/换行(CR 或 LF)者用双引号包裹,内部双引号翻倍。
function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

const pad = (n: number): string => String(n).padStart(2, '0');

// 本机时区格式化(单机 24×7 部署,本地时区即业务时区)
function fmtDate(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function fmtDateTime(ms: number | null | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '';
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// 最新总结:去所有换行(压成单行)、截断 200 字
function fmtSummary(text: string | null | undefined): string {
  if (typeof text !== 'string' || !text) return '';
  const oneLine = text.replace(/[\r\n]+/g, ' ').trim();
  return oneLine.length > 200 ? oneLine.slice(0, 200) : oneLine;
}

const HEADERS = [
  '客戶名稱',
  '聊天類型',
  '目前階段',
  '大貨死線',
  '訊息數',
  '檔案數',
  '待處理',
  '最後訊息時間',
  '最新總結',
  '標籤',
];

export default async function exportRoutes(app: FastifyInstance): Promise<void> {
  // GET /api/export/customers.csv — 依目前客户列表篩選匯出(与 GET /api/customers 同参数)
  app.get('/api/export/customers.csv', async (req, reply) => {
    const qy = (req.query ?? {}) as {
      q?: string;
      stage?: string;
      followedUp?: string;
      build?: string;
      hasDeadline?: string;
      tagId?: string;
    };
    const customers = chatService.listCustomers({
      q: qy.q,
      stage: qy.stage,
      followedUp: qy.followedUp,
      build: qy.build,
      hasDeadline: qy.hasDeadline,
      tagId: qy.tagId,
    }) as Array<{
      lineChatId: string;
      lineName: string | null;
      chatType: string | null;
      currentStage: string | null;
      followedUp: number;
      lastMessageAt: number | null;
      msgCount: number;
      fileCount: number;
      deadlineAt?: number | null;
      latestSummary: { summaryText: string | null } | null;
    }>;
    const tagMap = chatService.tagsByChatId();

    const lines: string[] = [];
    lines.push(HEADERS.map(csvCell).join(','));
    for (const c of customers) {
      const tags = tagMap.get(c.lineChatId) ?? [];
      const row = [
        c.lineName ?? '',
        c.chatType ?? '',
        c.currentStage ?? '',
        fmtDate(c.deadlineAt),
        c.msgCount,
        c.fileCount,
        c.followedUp === 1 ? '是' : '否',
        fmtDateTime(c.lastMessageAt),
        fmtSummary(c.latestSummary?.summaryText),
        tags.join(', '),
      ];
      lines.push(row.map(csvCell).join(','));
    }

    // CRLF 行结束(Excel/CSV 惯例)+ UTF-8 BOM(﻿,Excel 正确识别中文)
    const csv = '﻿' + lines.join('\r\n') + '\r\n';

    reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', 'attachment; filename=customers.csv');
    return csv;
  });
}
