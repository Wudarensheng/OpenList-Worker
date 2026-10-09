/**
 * 回归测试：请求级存储上下文必须始终携带 `env`（singleflight 视角）。
 *
 * 背景（真实缺陷）：`getStorageRequestContext()` 早期实现在缺少
 * `executionCtx.waitUntil` 时直接返回 `undefined`，把 `env` 一起丢了。
 * singleflight 依赖 `requestContext.env` 解析协调用的 SQL 驱动：拿不到 env 时
 * `getStorageBackend(undefined)` 会解析成**内存驱动**，`supportsSql()` 为假，
 * 于是 `auto` 静默退回内存级 —— 单飞退化成仅进程内合并，**跨实例协调能力被
 * 静默丢弃**，日志里看不到任何异常。
 *
 * 这里刻意**不传** `app.request()` 的第 4 个参数（executionCtx），
 * 用 SQL 后端断言 singleflight 仍然进入 `db` 模式。
 */
import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdirSync, writeFileSync, rmSync } from "node:fs"
import app from "../index"

const JWT_SECRET = "jwt-secret-32-characters-long!!"
const ORIGIN = "http://localhost"
const SANDBOX = process.cwd() + "/.tmp-sf-ctx"
const ROOT = SANDBOX + "/root"

let DatabaseSync: any = null
try {
  // node:sqlite 自 Node 22.5 起提供（实验性）；不可用时跳过本用例
  ;({ DatabaseSync } = await import("node:sqlite"))
} catch {
  DatabaseSync = null
}

/** D1 兼容垫片（node:sqlite 后端） */
function makeD1(file: string) {
  const db = new DatabaseSync(file)
  const wrap = (sql: string) => {
    let params: any[] = []
    const api: any = {
      bind(...p: any[]) {
        params = p
        return api
      },
      async first() {
        const r = db.prepare(sql).get(...params)
        return r === undefined ? null : r
      },
      async run() {
        return { success: true, meta: db.prepare(sql).run(...params) }
      },
      async all() {
        return { results: db.prepare(sql).all(...params), success: true }
      },
    }
    return api
  }
  return {
    prepare: (sql: string) => wrap(sql),
    async batch(stmts: any[]) {
      const out = []
      for (const s of stmts) out.push(await s.all())
      return out
    },
    async exec(sql: string) {
      db.exec(sql)
    },
    __db: db,
  }
}

test(
  "缺少 executionCtx 时，singleflight 仍必须进入 db 模式（而非静默退回内存级）",
  { skip: DatabaseSync ? false : "node:sqlite 不可用，跳过" },
  async () => {
    const d1 = makeD1(":memory:")
    const env: any = {
      DB_DRIVER: "d1",
      DB_FORMAT: "sql",
      DB: d1,
      JWT_SECRET,
      ADMIN_PASS: "admin",
      __requestOrigin: ORIGIN,
    }

    rmSync(SANDBOX, { recursive: true, force: true })
    mkdirSync(ROOT + "/sub", { recursive: true })
    writeFileSync(ROOT + "/sub/c.txt", "gamma")

    try {
      const post = (path: string, body: any, token?: string) =>
        // 注意：刻意省略第 4 个参数（executionCtx）
        app.request(
          path,
          {
            method: "POST",
            headers: token
              ? { "Content-Type": "application/json", Authorization: `Bearer ${token}` }
              : { "Content-Type": "application/json" },
            body: JSON.stringify(body ?? {}),
          },
          env,
        )

      const login: any = await (await post("/api/auth/login", {
        username: "admin",
        password: "admin",
      })).json()
      const token = login?.data?.token
      assert.ok(token, `login failed: ${JSON.stringify(login)}`)

      const created: any = await (await post(
        "/api/admin/storage/create",
        {
          mount_path: "/sf",
          driver: "Local",
          addition: JSON.stringify({ root_folder_path: ROOT }),
          order: 0,
        },
        token,
      )).json()
      assert.equal(created?.code, 200, `create storage failed: ${JSON.stringify(created)}`)

      // 触发一次 fs.list（内部走 singleflight）
      const listed: any = await (await post(
        "/api/fs/list",
        { path: "/sf/sub", page: 1, per_page: 0 },
        token,
      )).json()
      assert.equal(listed?.code, 200, `list failed: ${JSON.stringify(listed)}`)
      assert.deepEqual(
        (listed?.data?.content || []).map((i: any) => i.name),
        ["c.txt"],
      )

      // 核心断言：singleflight 必须解析到 SQL 驱动并进入 db 模式。
      // 修复前 env 丢失 → 解析成内存驱动 → mode 静默变成 "memory"。
      const debug: any = await (
        await app.request(
          "/api/debug/info",
          { method: "GET", headers: { Authorization: `Bearer ${token}` } },
          env,
        )
      ).json()
      assert.equal(debug?.code, 200, `debug/info failed: ${JSON.stringify(debug)}`)
      const sf = debug?.data?.singleflight
      assert.equal(
        sf?.mode,
        "db",
        `expected singleflight mode "db" (env was lost?), got ${JSON.stringify(sf)}`,
      )

      // 协调表应被真实创建
      const rows = d1.__db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%singleflight%'")
        .all() as any[]
      assert.ok(rows.length >= 1, `singleflight coordination table missing: ${JSON.stringify(rows)}`)
    } finally {
      rmSync(SANDBOX, { recursive: true, force: true })
    }
  },
)
