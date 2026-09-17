const http = require("http");
const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");

const PORT = Number(process.env.PORT || 3021);
const DB_FILE = path.join(__dirname, "data", "db.json");

const AMPLITUDE_MIN = 180;
const AMPLITUDE_MAX = 320;

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

// 复测结论只能由服务端按实测数据判定，请求方不得自定义
function isRetestQualified(retest, clock) {
  return (
    Number.isFinite(Number(retest.dailyRateSeconds)) &&
    Math.abs(Number(retest.dailyRateSeconds)) <= Number(clock.targetDailyRateSeconds) &&
    Number(retest.amplitude) >= AMPLITUDE_MIN &&
    Number(retest.amplitude) <= AMPLITUDE_MAX
  );
}

// 调校后复测闸门：钟表仅当最新调校之后存在关联该调校且复测合格时才合格；
// 旧调校上的合格复测不得覆盖新调校
function qualifyingRetest(db, clock) {
  const adjustment = latestAdjustment(db, clock.id);
  if (!adjustment) return null;
  const adjustedAt = new Date(adjustment.createdAt).getTime();
  return (
    db.retests
      .filter(
        (item) =>
          item.clockId === clock.id &&
          item.adjustmentId === adjustment.id &&
          new Date(item.testedAt).getTime() >= adjustedAt &&
          isRetestQualified(item, clock)
      )
      .sort((a, b) => new Date(b.testedAt) - new Date(a.testedAt))[0] || null
  );
}

// 对外返回复测记录时，结论一律按当前规则重新计算，保证各接口一致
function presentRetest(db, retest) {
  const clock = db.clocks.find((item) => item.id === retest.clockId);
  return { ...retest, qualified: clock ? isRetestQualified(retest, clock) : false };
}

function clockSummary(db, clock) {
  const retest = latestRetest(db, clock.id);
  const adjustment = latestAdjustment(db, clock.id);
  const qualifying = qualifyingRetest(db, clock);
  return {
    ...clock,
    latestAdjustment: adjustment,
    latestRetest: retest ? presentRetest(db, retest) : null,
    qualifyingRetestId: qualifying ? qualifying.id : null,
    qualified: Boolean(qualifying)
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
      .map((retest) => presentRetest(db, retest));
    const latest = latestRetest(db, clock.id);
    return send(res, 200, {
      data: {
        clock: clockSummary(db, clock),
        adjustments,
        retests,
        latestRetest: latest ? presentRetest(db, latest) : null
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
    if (!Number.isFinite(dailyRateSeconds)) {
      const error = new Error("dailyRateSeconds 必须是数字");
      error.status = 400;
      throw error;
    }
    if (!Number.isFinite(amplitude)) {
      const error = new Error("amplitude 必须是数字");
      error.status = 400;
      throw error;
    }

    // 复测必须绑定一次调校；显式绑定其他钟表/不存在的调校返回400，
    // 未指定时默认绑定该钟表的最新调校，没有任何调校时同样拒绝
    let adjustment;
    if (body.adjustmentId !== undefined && body.adjustmentId !== null && body.adjustmentId !== "") {
      adjustment = db.adjustments.find((item) => item.id === body.adjustmentId);
      if (!adjustment) {
        const error = new Error("调校记录不存在");
        error.status = 400;
        throw error;
      }
      if (adjustment.clockId !== clock.id) {
        const error = new Error("复测只能绑定属于该钟表的调校记录");
        error.status = 400;
        throw error;
      }
    } else {
      adjustment = latestAdjustment(db, clock.id);
      if (!adjustment) {
        const error = new Error("该钟表尚无调校记录，复测必须绑定一次调校");
        error.status = 400;
        throw error;
      }
    }

    let testedAt;
    if (body.testedAt !== undefined && body.testedAt !== null && body.testedAt !== "") {
      testedAt = body.testedAt;
      if (Number.isNaN(new Date(testedAt).getTime())) {
        const error = new Error("testedAt 必须是合法的时间");
        error.status = 400;
        throw error;
      }
    } else {
      testedAt = new Date().toISOString();
    }

    // 未达标复测仍落库，但结论由服务端按目标日差和振幅区间判定，请求方不得自定义
    const retest = {
      id: makeId("retest"),
      clockId: clock.id,
      adjustmentId: adjustment.id,
      testedAt,
      dailyRateSeconds,
      amplitude,
      qualified: false,
      note: body.note || ""
    };
    retest.qualified = isRetestQualified(retest, clock);
    db.retests.push(retest);
    await writeDb(db);
    return send(res, 201, { data: presentRetest(db, retest), clock: clockSummary(db, clock) });
  }

  const latestMatch = pathname.match(/^\/clocks\/([^/]+)\/latest-retest$/);
  if (latestMatch && req.method === "GET") {
    const clock = findClock(db, latestMatch[1]);
    const latest = latestRetest(db, clock.id);
    return send(res, 200, {
      data: latest ? presentRetest(db, latest) : null,
      clock: clockSummary(db, clock)
    });
  }

  if (req.method === "GET" && pathname === "/adjustments") {
    const clockId = url.searchParams.get("clockId");
    return send(res, 200, { data: db.adjustments.filter((item) => !clockId || item.clockId === clockId) });
  }

  if (req.method === "GET" && pathname === "/retests") {
    const clockId = url.searchParams.get("clockId");
    const qualified = url.searchParams.get("qualified");
    const data = db.retests
      .filter((item) => !clockId || item.clockId === clockId)
      .map((retest) => presentRetest(db, retest))
      .filter((retest) => qualified === null || retest.qualified === (qualified === "true"));
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
