const http = require("http");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3021);
const DB_FILE = path.join(__dirname, "data", "db.json");

const initialData = {
  clocks: [
    {
      id: "clock_demo",
      code: "CLK-1890-07",
      escapementType: "瑞士杠杆式",
      balanceFrequency: "18000vph",
      targetDailyRateSeconds: 20,
      note: "怀表机芯，走时偏快",
      createdAt: new Date().toISOString()
    }
  ],
  adjustments: [
    {
      id: "adjustment_demo",
      clockId: "clock_demo",
      currentDailyRateSeconds: 68,
      direction: "慢针方向",
      amount: "游丝快慢针向慢侧微调0.4格",
      note: "初次调校，先保守处理",
      createdAt: new Date().toISOString()
    }
  ],
  retests: [
    {
      id: "retest_demo",
      clockId: "clock_demo",
      adjustmentId: "adjustment_demo",
      testedAt: new Date().toISOString(),
      dailyRateSeconds: 31,
      amplitude: 248,
      qualified: false,
      note: "仍偏快，振幅尚可"
    }
  ]
};

const routes = [
  "GET /health",
  "GET /clocks",
  "POST /clocks",
  "GET /clocks/not-qualified",
  "GET /clocks/:id/history",
  "POST /clocks/:id/adjustments",
  "POST /clocks/:id/retests",
  "GET /clocks/:id/latest-retest",
  "GET /adjustments",
  "GET /retests"
];

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

async function readDb() {
  await ensureDb();
  return JSON.parse(await readFile(DB_FILE, "utf8"));
}

async function writeDb(data) {
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("请求体必须是合法JSON");
    error.status = 400;
    throw error;
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    const error = new Error(`缺少字段：${missing.join(", ")}`);
    error.status = 400;
    throw error;
  }
}

function findClock(db, clockId) {
  const clock = db.clocks.find((item) => item.id === clockId);
  if (!clock) {
    const error = new Error("钟表不存在");
    error.status = 404;
    throw error;
  }
  return clock;
}

function latestRetest(db, clockId) {
  return db.retests
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt))[0] || null;
}

function latestAdjustment(db, clockId) {
  return db.adjustments
    .filter((item) => item.clockId === clockId)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
}

const AMPLITUDE_MIN = 180;
const AMPLITUDE_MAX = 320;

function badRequest(message) {
  const error = new Error(message);
  error.status = 400;
  return error;
}

// 复测指标是否达标：日差绝对值不高于目标值，且振幅在 180–320（含边界）
function retestMeetsTarget(clock, retest) {
  const dailyRate = Number(retest.dailyRateSeconds);
  const amplitude = Number(retest.amplitude);
  return (
    Math.abs(dailyRate) <= Number(clock.targetDailyRateSeconds)
    && amplitude >= AMPLITUDE_MIN
    && amplitude <= AMPLITUDE_MAX
  );
}

// 调校后复测闸门（唯一结论口径）：
// 复测必须关联“当前最新调校”、发生在该调校之后，且指标达标，才算合格。
// 旧调校名下的合格复测不会覆盖新调校。
function retestQualifies(db, clock, retest, latest = latestAdjustment(db, clock.id)) {
  if (!latest) return false;
  if (retest.clockId !== clock.id || retest.adjustmentId !== latest.id) return false;
  if (new Date(retest.testedAt).getTime() < new Date(latest.createdAt).getTime()) return false;
  return retestMeetsTarget(clock, retest);
}

function clockQualified(db, clock) {
  const latest = latestAdjustment(db, clock.id);
  return Boolean(latest) && db.retests.some((retest) => retestQualifies(db, clock, retest, latest));
}

// 复测的 qualified 一律按当前闸门实时计算，不信任历史落库值，保证各接口口径一致
function decorateRetest(db, clock, retest) {
  if (!retest) return null;
  return { ...retest, qualified: retestQualifies(db, clock, retest) };
}

function clockSummary(db, clock) {
  return {
    ...clock,
    latestAdjustment: latestAdjustment(db, clock.id),
    latestRetest: decorateRetest(db, clock, latestRetest(db, clock.id)),
    qualified: clockQualified(db, clock)
  };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "clock-escapement-tuning-api", routes });
  }

  if (req.method === "GET" && pathname === "/clocks") {
    const qualified = url.searchParams.get("qualified");
    let data = db.clocks.map((clock) => clockSummary(db, clock));
    if (qualified !== null) {
      const expected = qualified === "true";
      data = data.filter((clock) => clock.qualified === expected);
    }
    return send(res, 200, { data });
  }

  if (req.method === "POST" && pathname === "/clocks") {
    const body = await parseBody(req);
    required(body, ["code", "escapementType", "balanceFrequency"]);
    const clock = {
      id: makeId("clock"),
      code: body.code,
      escapementType: body.escapementType,
      balanceFrequency: body.balanceFrequency,
      targetDailyRateSeconds: Number(body.targetDailyRateSeconds ?? 30),
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.clocks.push(clock);
    await writeDb(db);
    return send(res, 201, { data: clockSummary(db, clock) });
  }

  if (req.method === "GET" && pathname === "/clocks/not-qualified") {
    const data = db.clocks.map((clock) => clockSummary(db, clock)).filter((clock) => !clock.qualified);
    return send(res, 200, { data });
  }

  const historyMatch = pathname.match(/^\/clocks\/([^/]+)\/history$/);
  if (historyMatch && req.method === "GET") {
    const clock = findClock(db, historyMatch[1]);
    const adjustments = db.adjustments.filter((item) => item.clockId === clock.id);
    const retests = db.retests
      .filter((item) => item.clockId === clock.id)
      .map((retest) => decorateRetest(db, clock, retest));
    const summary = clockSummary(db, clock);
    return send(res, 200, {
      data: {
        clock,
        adjustments,
        retests,
        latestAdjustment: summary.latestAdjustment,
        latestRetest: summary.latestRetest,
        qualified: summary.qualified
      }
    });
  }

  const adjustmentMatch = pathname.match(/^\/clocks\/([^/]+)\/adjustments$/);
  if (adjustmentMatch && req.method === "POST") {
    const clock = findClock(db, adjustmentMatch[1]);
    const body = await parseBody(req);
    required(body, ["currentDailyRateSeconds", "direction", "amount"]);
    const adjustment = {
      id: makeId("adjustment"),
      clockId: clock.id,
      currentDailyRateSeconds: Number(body.currentDailyRateSeconds),
      direction: body.direction,
      amount: body.amount,
      note: body.note || "",
      createdAt: new Date().toISOString()
    };
    db.adjustments.push(adjustment);
    await writeDb(db);
    return send(res, 201, { data: adjustment });
  }

  const retestMatch = pathname.match(/^\/clocks\/([^/]+)\/retests$/);
  if (retestMatch && req.method === "POST") {
    const clock = findClock(db, retestMatch[1]);
    const body = await parseBody(req);
    required(body, ["dailyRateSeconds", "amplitude"]);
    const dailyRateSeconds = Number(body.dailyRateSeconds);
    const amplitude = Number(body.amplitude);
    if (!Number.isFinite(dailyRateSeconds)) throw badRequest("dailyRateSeconds 必须是数字");
    if (!Number.isFinite(amplitude)) throw badRequest("amplitude 必须是数字");
    const testedAt = body.testedAt || new Date().toISOString();
    if (Number.isNaN(new Date(testedAt).getTime())) throw badRequest("testedAt 必须是合法时间");

    // 复测绑定的调校必须属于当前钟表；绑定其他钟表的调校返回 400
    let adjustment;
    if (body.adjustmentId) {
      adjustment = db.adjustments.find((item) => item.id === body.adjustmentId);
      if (!adjustment) throw badRequest("关联的调校不存在");
      if (adjustment.clockId !== clock.id) throw badRequest("复测只能关联当前钟表的调校");
    } else {
      adjustment = latestAdjustment(db, clock.id);
    }

    // 结论由服务端按“当前最新调校”闸门计算，请求方传 qualified 一律忽略；
    // 未达标复测或绑定旧调校的复测仍落库，但结论为不合格
    const retest = {
      id: makeId("retest"),
      clockId: clock.id,
      adjustmentId: adjustment ? adjustment.id : null,
      testedAt,
      dailyRateSeconds,
      amplitude,
      qualified: false,
      note: body.note || ""
    };
    retest.qualified = retestQualifies(db, clock, retest);
    db.retests.push(retest);
    await writeDb(db);
    return send(res, 201, { data: retest, clock: clockSummary(db, clock) });
  }

  const latestMatch = pathname.match(/^\/clocks\/([^/]+)\/latest-retest$/);
  if (latestMatch && req.method === "GET") {
    const clock = findClock(db, latestMatch[1]);
    const retest = decorateRetest(db, clock, latestRetest(db, clock.id));
    // 顶层 qualified 与 /clocks、/history 共用同一闸门结论
    return send(res, 200, { data: retest, qualified: clockQualified(db, clock) });
  }

  if (req.method === "GET" && pathname === "/adjustments") {
    const clockId = url.searchParams.get("clockId");
    return send(res, 200, { data: db.adjustments.filter((item) => !clockId || item.clockId === clockId) });
  }

  if (req.method === "GET" && pathname === "/retests") {
    const clockId = url.searchParams.get("clockId");
    const qualified = url.searchParams.get("qualified");
    let data = db.retests
      .filter((item) => !clockId || item.clockId === clockId)
      .map((item) => {
        const clock = db.clocks.find((candidate) => candidate.id === item.clockId);
        return clock ? decorateRetest(db, clock, item) : { ...item, qualified: false };
      });
    if (qualified !== null) {
      data = data.filter((item) => item.qualified === (qualified === "true"));
    }
    return send(res, 200, { data });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Clock escapement tuning API running at http://127.0.0.1:${PORT}`);
});
