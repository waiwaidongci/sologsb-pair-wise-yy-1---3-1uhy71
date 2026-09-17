# 机械钟表擒纵调校API

纯后端零依赖Node服务，使用 `data/db.json` 持久化钟表档案、调校记录和复测记录。

## 启动

```bash
PORT=3021 node server.js
```

## 主要接口

- `GET /health`
- `GET /clocks`
- `POST /clocks`
- `GET /clocks/not-qualified`
- `GET /clocks/:id/history`
- `POST /clocks/:id/adjustments`
- `POST /clocks/:id/retests`
- `GET /clocks/:id/latest-retest`
- `GET /adjustments?clockId=`
- `GET /retests?clockId=&qualified=`

## 合格判定（服务端统一计算，各接口一致）

- **复测合格**：`|dailyRateSeconds| ≤ 钟表的 targetDailyRateSeconds` 且 `180 ≤ amplitude ≤ 320`。`qualified` 由服务端判定，请求体中传入的 `qualified` 一律忽略；未达标的复测仍会落库（`qualified:false`，HTTP 201）。
- **钟表合格（调校后复测闸门）**：最新一次调校（按 `createdAt`）之后，存在一条**关联该调校**（`adjustmentId` 指向它）且复测结论合格的记录。旧调校上的合格复测不能让钟表在新调校后继续保持合格。
- 复测必须绑定调校：`adjustmentId` 显式传入不存在的记录或属于其他钟表的记录时返回 **400**；不传时默认绑定该钟表的最新调校，没有任何调校记录时返回 **400**。
- `GET /clocks`（含 `?qualified=` 筛选与 `/clocks/not-qualified`）、`GET /clocks/:id/history`、`GET /clocks/:id/latest-retest`、`GET /retests?qualified=` 使用同一套判定，结论始终一致。列表摘要中的 `qualifyingRetestId` 指向触发闸门的那条复测（无则为 `null`）。

## 闭环示例

```bash
curl http://127.0.0.1:3021/clocks/not-qualified
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/retests \
  -H 'Content-Type: application/json' \
  -d '{"adjustmentId":"adjustment_demo","dailyRateSeconds":12,"amplitude":252,"note":"复测进入目标范围"}'
```
