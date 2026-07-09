# 后端自动化测试套件

零外部依赖:仅用 Node 内建 `node:test` + `tsx`(已是 devDependency)。

## 如何跑

```bash
cd backend
npm test          # = node --test --import tsx test/*.test.ts
npx tsc --noEmit  # 型别检查(仅检查 src/,不含 test/)
```

全绿输出示例:`# pass 37 / # fail 0`。

## 关键安全:绝不碰正式库

`data/app.db` 是长期核心 CRM 的正式资料,测试**永不触碰**它。

- `src/db.ts` 是单例连接,`import` 时即打开 `data/app.db` 并跑 migration。
  因此**凡是 `import db from '../db.js'` 的 service 都不能在测试里 import**。
- `test/helpers.ts` 的 `createTestDb()` 每次在 `os.tmpdir()` 建一个唯一临时档,
  `closeTestDb()` 关闭并删除(含 `-wal`/`-shm`)。`assertNotRealDb()` 兜底断言临时档路径
  绝不等于 `backend/data/app.db`。
- CI 可用 `stat` 比对 `data/app.db` 的 mtime 在 `npm test` 前后不变来验证红线。

### 两类测试

1. **纯函数**(模块不 `import db`,直接 import 真实代码测):
   `stageTemplate.ts`、`llm/index.ts`(normalize*)、`services/summarizeGuard.ts`。
2. **db 不变量**(把 service 里**逐字复制**的 SQL 跑在临时库上):
   不变量本体就在这些 SQL 里(如 `WHERE source != 'manual'`、`ON CONFLICT(contentHash)`),
   所以仍是对真实逻辑的验证。SQL 常量集中在 `helpers.ts`,若 service 的 SQL 改动而未同步,
   对应测试即失效——起到回归护栏作用。

## 覆盖内容

| 档案 | 覆盖不变量 |
|------|-----------|
| `stageTemplate.test.ts` | 5 阶段固定顺序;taskKey→stage/label 映射完整;`isKnownStage/isKnownTaskKey`(简体不算已知) |
| `normalize.test.ts` | docRole 简→繁归一化(报价单→報價單 等);stage 别名归一化;`normalizeSummaryOutput` 容错与过滤 |
| `summarizeGuard.test.ts` | 同 chat 不能并发取得两次总结锁;不同 chat 互不影响;release 幂等 |
| `progress.test.ts` | 手动点灯(source=manual)后 LLM 不覆盖 manual 行(done 与 evidence 都保留);`computeCurrentStage` 取最靠后 done 阶段(全空=洽談);done=0 不参与计算 |
| `orderIsolation.test.ts` | 写 `order_stage_tasks` 不影响整體 `stage_tasks`;`computeOrderStage` 不写回 `customers.currentStage`;不同订单彼此隔离;`UNIQUE(orderId,taskKey)` upsert |
| `deadline.test.ts` | 大貨死線 `daysLeft`:今天=0、未来>0、逾期<0、未设=null(以当天 00:00 为日界) |
| `auth.test.ts` | bcrypt 密码验证;停用用户拒登;session 过期查不到;停用用户既有 session 立即失效;过期 session 惰性清理 |
| `fileDedup.test.ts` | 同 contentHash 去重为单行 + metadata COALESCE;LLM docRole 归一化写入;人工(manual)角色不被 LLM 覆盖;lineMessageId 关联兜底 |

## 加新测试

- 纯函数:直接 `import { fn } from '../src/....js'`(确认该模块**不**传递性 import `db.ts`)。
- db 相关:用 `createTestDb()` + `helpers.ts` 里的 SQL 常量;`beforeEach` 建库、`afterEach` `closeTestDb`。
  若需新表,把 `db.ts` 对应 `CREATE`(含 ALTER 补的列)折进 `helpers.ts` 的 `SCHEMA`。
