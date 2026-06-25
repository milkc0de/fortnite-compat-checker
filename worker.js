const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

    const url = new URL(request.url);

    if (url.pathname === "/") {
      return json({
        ok: true,
        message: "worker root ok"
      });
    }

    if (url.pathname === "/diagnose") {
      return json({
        ok: true,
        message: "diagnose route ok",
        name1: url.searchParams.get("name1"),
        name2: url.searchParams.get("name2"),
        days: url.searchParams.get("days")
      });
    }

    return json(
      {
        ok: false,
        error: "not found",
        path: url.pathname
      },
      404
    );
  }
};

function json(body, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...CORS_HEADERS
    }
  });
}
