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

## 调校后复测闸门

钟表是否合格只有一个口径：**最新一次调校之后**，存在一条同时满足下列条件的复测：

- `adjustmentId` 关联的正是该钟表当前最新的调校；
- `testedAt` 不早于该调校的 `createdAt`；
- `|dailyRateSeconds| ≤ clock.targetDailyRateSeconds`；
- `amplitude` 在 `180–320`（含边界）。

旧调校名下曾经合格的复测，在新调校产生后立即失效，不能继续覆盖新调校；
结论由服务端按闸门实时计算，请求方传入的 `qualified` 一律忽略。
复测绑定**其他钟表**的调校返回 `400`；未达标的复测（含振幅越界）仍然落库，但 `qualified=false`。

`GET /clocks`（含 `?qualified=` 与 `/clocks/not-qualified`）、`GET /clocks/:id/history`、
`GET /clocks/:id/latest-retest` 共用同一闸门函数：`latest-retest` 与 `history` 的顶层
`qualified` 为钟表结论，记录内的 `qualified` 为该复测在当前闸门下的结论，三处完全一致。

## 闭环示例

```bash
curl http://127.0.0.1:3021/clocks/not-qualified
curl -X POST http://127.0.0.1:3021/clocks/clock_demo/retests \
  -H 'Content-Type: application/json' \
  -d '{"dailyRateSeconds":12,"amplitude":252,"note":"复测进入目标范围"}'
```
