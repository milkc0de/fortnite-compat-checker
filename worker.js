const API_BASE = "https://prod.api-fortnite.com";

export default {
  async fetch(request, env) {
    const headers = corsHeaders(request);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers });
    }

    try {
      if (!env.FORTNITE_API_KEY) {
        return jsonResponse({ error: "Cloudflare Worker の Secret FORTNITE_API_KEY が未設定です。" }, 500, headers);
      }

      const url = new URL(request.url);
      const path = url.pathname.replace(/\/+$/g, "") || "/";

      if (path === "/") {
        return jsonResponse({ ok: true, service: "fortnite-compat-worker" }, 200, headers);
      }

      if (path === "/diagnose") {
        const name1 = cleanName(url.searchParams.get("name1"));
        const name2 = cleanName(url.searchParams.get("name2"));
        const days = cleanDays(url.searchParams.get("days"));

        if (!name1 || !name2) {
          return jsonResponse({ error: "name1 と name2 を指定してください。" }, 400, headers);
        }

        const range = makeRange(days);

        const accountA = await resolveAccount(name1, env);
        const accountB = await resolveAccount(name2, env);

        const statsA = await fetchStats(accountA.accountId, range, env);
        const statsB = await fetchStats(accountB.accountId, range, env);

        const metricsA = extractMetrics(statsA);
        const metricsB = extractMetrics(statsB);
        const result = diagnoseCompatibility(metricsA, metricsB, accountA, accountB, range);

        return jsonResponse(result, 200, headers);
      }

      if (path === "/resolve") {
        const name = cleanName(url.searchParams.get("name"));
        if (!name) return jsonResponse({ error: "name を指定してください。" }, 400, headers);
        const account = await resolveAccount(name, env);
        return jsonResponse(account, 200, headers);
      }

      if (path === "/stats") {
        const accountId = cleanName(url.searchParams.get("accountId"));
        const days = cleanDays(url.searchParams.get("days"));
        if (!accountId) return jsonResponse({ error: "accountId を指定してください。" }, 400, headers);
        const stats = await fetchStats(accountId, makeRange(days), env);
        return jsonResponse(stats, 200, headers);
      }

      return jsonResponse({ error: "unknown endpoint" }, 404, headers);
    } catch (error) {
      return jsonResponse({ error: error.message || String(error) }, 500, headers);
    }
  }
};

function corsHeaders(request) {
  const origin = request.headers.get("Origin") || "*";
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
    "Content-Type": "application/json; charset=utf-8"
  };
}

function jsonResponse(body, status, headers) {
  return new Response(JSON.stringify(body, null, 2), { status, headers });
}

function cleanName(value) {
  if (!value) return "";
  return String(value).trim().slice(0, 80);
}

function cleanDays(value) {
  if (!value || value === "all") return "all";
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return "all";
  return String(clamp(n, 1, 3650));
}

function makeRange(days) {
  if (!days || days === "all") {
    return { days: "all", startTime: null, endTime: null };
  }
  const now = Math.floor(Date.now() / 1000);
  const start = now - Number(days) * 86400;
  return { days: Number(days), startTime: start, endTime: now };
}

async function apiFetch(path, env) {
  const url = API_BASE + path;
  const res = await fetch(url, {
    headers: {
      "x-api-key": env.FORTNITE_API_KEY,
      "Accept": "application/json"
    }
  });

  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }

  if (!res.ok) {
    const detail = typeof body === "string" ? body : JSON.stringify(body);
    throw new Error(`Fortnite API error ${res.status}: ${detail.slice(0, 500)}`);
  }

  return body;
}

async function resolveAccount(displayName, env) {
  const data = await apiFetch(`/api/v1/account/displayName/${encodeURIComponent(displayName)}`, env);
  const accountId =
    data?.accountId ||
    data?.id ||
    data?.account?.accountId ||
    data?.account?.id ||
    data?.data?.accountId ||
    data?.data?.id;

  const resolvedName =
    data?.displayName ||
    data?.name ||
    data?.account?.displayName ||
    data?.data?.displayName ||
    displayName;

  if (!accountId) {
    throw new Error(`${displayName} の accountId を解決できませんでした。APIの返却形式を確認してください。`);
  }

  return { displayName: resolvedName, accountId };
}

async function fetchStats(accountId, range, env) {
  const qs = new URLSearchParams();
  if (range.startTime) qs.set("startTime", String(range.startTime));
  if (range.endTime) qs.set("endTime", String(range.endTime));
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  return apiFetch(`/api/v2/stats/${encodeURIComponent(accountId)}${suffix}`, env);
}

function extractMetrics(stats) {
  const flat = flattenNumbers(stats);
  const modes = {
    solo: modeMetrics(flat, "solo"),
    duo: modeMetrics(flat, "duo"),
    trio: modeMetrics(flat, "trio"),
    squad: modeMetrics(flat, "squad")
  };

  const modeSum = sumModeMetrics(modes);
  const overall = {
    matches: Math.max(pickMax(flat, "matches", null), modeSum.matches),
    wins: Math.max(pickMax(flat, "wins", null), modeSum.wins),
    kills: Math.max(pickMax(flat, "kills", null), modeSum.kills),
    deaths: Math.max(pickMax(flat, "deaths", null), modeSum.deaths),
    minutes: Math.max(pickMax(flat, "minutes", null), modeSum.minutes),
    score: pickMax(flat, "score", null)
  };

  const estimatedDeaths = overall.deaths > 0 ? overall.deaths : Math.max(1, overall.matches - overall.wins);
  const matches = Math.max(0, overall.matches);
  const wins = Math.max(0, overall.wins);
  const kills = Math.max(0, overall.kills);

  const kd = kills / Math.max(1, estimatedDeaths);
  const winRate = matches > 0 ? wins / matches : 0;
  const kpm = matches > 0 ? kills / matches : 0;

  const teamMatchesRaw = modes.duo.matches + modes.trio.matches + modes.squad.matches;
  const modeMatchesRaw = modes.solo.matches + teamMatchesRaw;
  const teamShare = modeMatchesRaw > 0 ? clamp01(teamMatchesRaw / modeMatchesRaw) : 0.5;
  const duoShare = teamMatchesRaw > 0 ? clamp01(modes.duo.matches / teamMatchesRaw) : 0.33;

  const aggression = clamp01((Math.min(kpm, 5) / 5) * 0.70 + (Math.min(kd, 5) / 5) * 0.30);
  const survival = clamp01((Math.min(winRate, 0.30) / 0.30) * 0.75 + (1 - Math.min(kpm, 5) / 5) * 0.25);
  const power = clamp01((Math.min(kd, 5) / 5) * 0.45 + (Math.min(winRate, 0.30) / 0.30) * 0.35 + (Math.min(kpm, 5) / 5) * 0.20);
  const experience = Math.log10(matches + 1);

  return {
    matches: round(matches, 0),
    wins: round(wins, 0),
    kills: round(kills, 0),
    deaths: round(overall.deaths, 0),
    estimatedDeaths: round(estimatedDeaths, 0),
    kd: round(kd, 3),
    winRate: round(winRate, 4),
    kpm: round(kpm, 3),
    teamShare: round(teamShare, 4),
    duoShare: round(duoShare, 4),
    aggression: round(aggression, 4),
    survival: round(survival, 4),
    power: round(power, 4),
    experience: round(experience, 4),
    role: roleName(aggression, survival, teamShare, power),
    modes,
    foundNumericStats: Object.keys(flat).length
  };
}

function modeMetrics(flat, mode) {
  return {
    matches: pickMax(flat, "matches", mode),
    wins: pickMax(flat, "wins", mode),
    kills: pickMax(flat, "kills", mode),
    deaths: pickMax(flat, "deaths", mode),
    minutes: pickMax(flat, "minutes", mode)
  };
}

function sumModeMetrics(modes) {
  const total = { matches: 0, wins: 0, kills: 0, deaths: 0, minutes: 0 };
  for (const mode of Object.keys(modes)) {
    total.matches += modes[mode].matches || 0;
    total.wins += modes[mode].wins || 0;
    total.kills += modes[mode].kills || 0;
    total.deaths += modes[mode].deaths || 0;
    total.minutes += modes[mode].minutes || 0;
  }
  return total;
}

function flattenNumbers(input) {
  const out = {};
  walkNumbers(input, "", out);
  return out;
}

function walkNumbers(value, path, out) {
  if (value === null || value === undefined) return;

  if (typeof value === "number" && Number.isFinite(value)) {
    out[path || "value"] = value;
    return;
  }

  if (typeof value === "string" || typeof value === "boolean") return;

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const nextPath = path ? `${path}.${i}` : String(i);
      walkNumbers(value[i], nextPath, out);
    }
    return;
  }

  if (typeof value === "object") {
    const nameLike = firstString(value, ["statKey", "key", "name", "stat", "id", "field"]);
    const numberLike = firstNumber(value, ["value", "val", "amount", "total", "count"]);
    if (nameLike && Number.isFinite(numberLike)) {
      out[path ? `${path}.${nameLike}` : nameLike] = numberLike;
    }

    const entries = Object.entries(value);
    for (const pair of entries) {
      const nextPath = path ? `${path}.${pair[0]}` : pair[0];
      walkNumbers(pair[1], nextPath, out);
    }
  }
}

function firstString(obj, keys) {
  for (const key of keys) {
    if (typeof obj[key] === "string" && obj[key].trim()) return obj[key].trim();
  }
  return "";
}

function firstNumber(obj, keys) {
  for (const key of keys) {
    if (typeof obj[key] === "number" && Number.isFinite(obj[key])) return obj[key];
  }
  return NaN;
}

function pickMax(flat, metric, mode) {
  let best = 0;
  let found = false;

  for (const pair of Object.entries(flat)) {
    const key = normalizeKey(pair[0]);
    const value = pair[1];

    if (!metricMatches(key, metric)) continue;
    if (mode && !modeMatches(key, mode)) continue;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;

    if (!found || value > best) {
      best = value;
      found = true;
    }
  }

  return found ? best : 0;
}

function metricMatches(key, metric) {
  if (metric === "matches") {
    return (key.includes("matchesplayed") || key.includes("matchplayed") || key.endsWith("matches") || key.includes("matches")) &&
      !key.includes("matchid") &&
      !key.includes("matchmaking");
  }

  if (metric === "wins") {
    return (key.includes("wins") || key.includes("placetop1") || key.includes("victory")) &&
      !key.includes("winrate") &&
      !key.includes("window");
  }

  if (metric === "kills") {
    return key.includes("kills") || key.includes("eliminations");
  }

  if (metric === "deaths") {
    return key.includes("deaths") || key.includes("death");
  }

  if (metric === "minutes") {
    return key.includes("minutesplayed") || key.includes("timeplayed") || key.includes("playtime");
  }

  if (metric === "score") {
    return key.includes("score") && !key.includes("scorediff");
  }

  return false;
}

function modeMatches(key, mode) {
  const words = {
    solo: ["solo", "defaultsolo"],
    duo: ["duo", "defaultduo"],
    trio: ["trio", "defaulttrio"],
    squad: ["squad", "squads", "defaultsquad"]
  };

  const candidates = words[mode] || [];
  for (const word of candidates) {
    if (key.includes(word)) return true;
  }
  return false;
}

function normalizeKey(key) {
  return String(key).toLowerCase().replace(/[^a-z0-9]/g, "");
}

function diagnoseCompatibility(a, b, accountA, accountB, range) {
  const kdSim = ratioSimilarity(a.kd, b.kd, 0.95, 0.08);
  const wrSim = ratioSimilarity(a.winRate, b.winRate, 0.90, 0.01);
  const kpmSim = ratioSimilarity(a.kpm, b.kpm, 0.90, 0.08);
  const powerSim = linearSimilarity(a.power, b.power, 0.70);

  const strength = weighted([
    [kdSim, 0.34],
    [wrSim, 0.22],
    [kpmSim, 0.24],
    [powerSim, 0.20]
  ]);

  const minMatches = Math.min(a.matches, b.matches);
  const maxMatches = Math.max(a.matches, b.matches);
  const sample = 100 * (1 - Math.exp(-minMatches / 90));
  const volumeBalance = maxMatches > 0 ? ratioSimilarity(a.matches, b.matches, 1.10, 1) : 0;
  const stability = weighted([
    [sample, 0.72],
    [volumeBalance, 0.28]
  ]);

  const teamStyle = linearSimilarity(a.teamShare, b.teamShare, 0.75);
  const teamIntent = ((a.teamShare + b.teamShare) / 2) * 100;
  const duoIntent = ((a.duoShare + b.duoShare) / 2) * 100;
  const team = weighted([
    [teamStyle, 0.45],
    [teamIntent, 0.35],
    [duoIntent, 0.20]
  ]);

  const roleDiff = Math.abs(a.aggression - b.aggression);
  const complementPeak = clamp(100 - Math.abs(roleDiff - 0.32) * 210, 0, 100);
  const bothPower = ((a.power + b.power) / 2) * 100;
  const survivalCover = Math.max(a.survival, b.survival) * 100;
  const complement = weighted([
    [complementPeak, 0.52],
    [bothPower, 0.28],
    [survivalCover, 0.20]
  ]);

  const tempo = weighted([
    [kpmSim, 0.55],
    [wrSim, 0.45]
  ]);

  const axes = {
    strength: round(strength, 0),
    stability: round(stability, 0),
    team: round(team, 0),
    complement: round(complement, 0),
    tempo: round(tempo, 0)
  };

  const score = round(weighted([
    [strength, 0.27],
    [stability, 0.18],
    [team, 0.22],
    [complement, 0.23],
    [tempo, 0.10]
  ]), 0);

  return {
    score,
    label: scoreLabel(score),
    range,
    players: [
      { displayName: accountA.displayName, accountId: accountA.accountId, metrics: a },
      { displayName: accountB.displayName, accountId: accountB.accountId, metrics: b }
    ],
    axes,
    comments: makeComments(a, b, axes, score)
  };
}

function makeComments(a, b, axes, score) {
  const comments = [];

  if (Math.min(a.matches, b.matches) < 20) {
    comments.push("サンプル数が少ないため、診断は仮判定寄りです。もう少し試合数が増えると精度が上がります。");
  }

  if (axes.strength >= 78) {
    comments.push("実力帯がかなり近いです。片方だけがキャリーするより、意思決定の速度を合わせやすい組み合わせです。");
  } else if (axes.strength <= 48) {
    comments.push("実力差が大きめです。強い側が前に出すぎると、弱い側が移動とカバーで遅れやすくなります。");
  } else {
    comments.push("実力差はありますが、役割を決めれば十分に噛み合う範囲です。");
  }

  if (axes.complement >= 75) {
    comments.push("役割補完が強めです。前に圧をかける人と、勝ち筋を管理する人に分かれるとかなり良さそうです。");
  } else if (Math.abs(a.aggression - b.aggression) < 0.12) {
    comments.push("プレイ傾向が近いです。同時に詰める、同時に引くなど、テンポ共有を明文化すると安定します。");
  } else {
    comments.push("プレイ傾向には差があります。突撃役とカバー役を先に決めると事故が減ります。");
  }

  if (axes.team <= 45) {
    comments.push("チーム戦への寄り方が少し違います。デュオ用なら、降下場所、移動開始、蘇生優先度を先に決めるのが有効です。");
  }

  if (score >= 85) {
    comments.push("かなり当たりの組み合わせです。大会やランクでも、作戦を固定すると伸びやすいです。");
  }

  return comments;
}

function roleName(aggression, survival, teamShare, power) {
  if (aggression >= 0.68 && power >= 0.45) return "前衛キャリー型";
  if (aggression >= 0.62) return "攻撃テンポ型";
  if (survival >= 0.62 && teamShare >= 0.55) return "勝ち筋管理型";
  if (teamShare >= 0.70) return "チーム戦慣れ型";
  if (power >= 0.55) return "万能型";
  return "バランス型";
}

function scoreLabel(score) {
  if (score >= 90) return "運命のデュオ級";
  if (score >= 82) return "かなり相性良い";
  if (score >= 72) return "普通に強い組み合わせ";
  if (score >= 62) return "役割を決めれば良い";
  if (score >= 50) return "調整が必要";
  return "事故りやすい";
}

function ratioSimilarity(x, y, scale, epsilon) {
  const a = Math.max(0, Number(x)) + epsilon;
  const b = Math.max(0, Number(y)) + epsilon;
  return clamp(100 * Math.exp(-Math.abs(Math.log(a / b)) / scale), 0, 100);
}

function linearSimilarity(x, y, maxDiff) {
  return clamp(100 * (1 - Math.abs(Number(x) - Number(y)) / maxDiff), 0, 100);
}

function weighted(items) {
  let total = 0;
  let weight = 0;
  for (const item of items) {
    total += item[0] * item[1];
    weight += item[1];
  }
  return weight ? total / weight : 0;
}

function clamp01(value) {
  return clamp(value, 0, 1);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value)));
}

function round(value, digits) {
  const m = Math.pow(10, digits);
  return Math.round(Number(value) * m) / m;
}
