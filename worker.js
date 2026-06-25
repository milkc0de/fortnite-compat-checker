const API_BASE = "https://prod.api-fortnite.com";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400"
};

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: CORS_HEADERS
      });
    }

    try {
      const response = await handleRequest(request, env);
      return withCors(response);
    } catch (error) {
      return jsonResponse(
        {
          error: error?.message || String(error)
        },
        500
      );
    }
  }
};

async function handleRequest(request, env) {
  if (!env.FORTNITE_API_KEY) {
    return jsonResponse(
      {
        error: "Cloudflare Worker の Secret FORTNITE_API_KEY が未設定です。"
      },
      500
    );
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/g, "") || "/";

  if (path === "/") {
    return jsonResponse({
      ok: true,
      service: "fortnite-compat-worker"
    });
  }

  if (path === "/diagnose") {
    const name1 = cleanName(url.searchParams.get("name1"));
    const name2 = cleanName(url.searchParams.get("name2"));
    const days = cleanDays(url.searchParams.get("days"));

    if (!name1 || !name2) {
      return jsonResponse(
        {
          error: "name1 と name2 を指定してください。"
        },
        400
      );
    }

    const range = makeRange(days);

    const accountA = await resolveAccount(name1, env);
    const accountB = await resolveAccount(name2, env);

    const statsA = await fetchStats(accountA.accountId, range, env);
    const statsB = await fetchStats(accountB.accountId, range, env);

    const metricsA = extractMetrics(statsA);
    const metricsB = extractMetrics(statsB);

    const result = diagnoseCompatibility(
      metricsA,
      metricsB,
      accountA,
      accountB,
      range
    );

    return jsonResponse(result);
  }

  if (path === "/resolve") {
    const name = cleanName(url.searchParams.get("name"));

    if (!name) {
      return jsonResponse(
        {
          error: "name を指定してください。"
        },
        400
      );
    }

    const account = await resolveAccount(name, env);
    return jsonResponse(account);
  }

  if (path === "/stats") {
    const accountId = cleanName(url.searchParams.get("accountId"));
    const days = cleanDays(url.searchParams.get("days"));

    if (!accountId) {
      return jsonResponse(
        {
          error: "accountId を指定してください。"
        },
        400
      );
    }

    const stats = await fetchStats(accountId, makeRange(days), env);
    return jsonResponse(stats);
  }

  return jsonResponse(
    {
      error: "unknown endpoint"
    },
    404
  );
}

function withCors(response) {
  const headers = new Headers(response.headers);

  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function jsonResponse(body, status = 200) {
  return withCors(
    new Response(JSON.stringify(body, null, 2), {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8"
      }
    })
  );
}
