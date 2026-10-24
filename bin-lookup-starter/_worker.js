function sanitizeUpstreamText(text) {
  return text
    .replace(
      /(["']?)(authorization|api[-_ ]?key|token|password)\1\s*:\s*(["'])[^"']*\3/gi,
      "$1$2$1:$3[redacted]$3"
    )
    .replace(/\b(authorization|api[-_ ]?key|token|password)\b\s*[:=]\s*[^\s,;}]+/gi, "$1=[redacted]")
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[redacted-ip]")
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[redacted-email]")
    .replace(/\b\d{6}(?:\d{2})?\b/g, "[redacted-bin]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
}

const UPSTREAM_TIMEOUT_MS = 5000;

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeFallbackResult(result, bin) {
  const data = result.data || {};

  return {
    number: {
      iin: data.bin || bin,
      length: null,
      luhn: null
    },
    scheme: data.scheme?.toUpperCase() || null,
    type: data.funding?.toUpperCase() || null,
    category: data.segment?.toUpperCase() || null,
    country: {
      alpha2: data.country_code || null,
      name: data.country_name || null
    },
    bank: {
      name: data.issuer || null,
      phone: data.bank_phone || null,
      url: data.bank_url || null
    },
    success: true
  };
}

async function lookupFallback(bin, env, primaryResult) {
  const headers = {};

  if (env.IPNOVA_API_KEY) {
    headers["X-Api-Key"] = env.IPNOVA_API_KEY;
  }

  try {
    const response = await fetchWithTimeout(
      `https://cardbincheck.com/api/bin/${bin}`,
      { headers }
    );

    if (!response.ok) {
      const responseText = sanitizeUpstreamText(await response.text());

      console.error("BIN fallback upstream request failed", {
        status: response.status,
        responseText
      });

      return primaryResult;
    }

    const result = await response.json();
    return result.success === true
      ? normalizeFallbackResult(result, bin)
      : primaryResult;
  } catch {
    console.error("BIN fallback upstream request failed", {
      status: "network_error"
    });
    return primaryResult;
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname !== "/api/bin") {
      return env.ASSETS.fetch(request);
    }

    const bin = url.searchParams.get("bin") || "";

    if (!/^\d{6}(\d{2})?$/.test(bin)) {
      return Response.json({ error: "Invalid BIN" }, { status: 400 });
    }

    try {
      const response = await fetchWithTimeout(`https://binlist.io/lookup/${bin}/`, {
        headers: { "Accept-Version": "3" }
      });

      if (!response.ok) {
        const responseText = sanitizeUpstreamText(await response.text());

        console.error("BIN lookup upstream request failed", {
          status: response.status,
          responseText
        });

        return Response.json(
          {
            error:
              response.status === 404
                ? "BIN not found"
                : response.status === 429
                  ? "Lookup limit reached. Try again later."
                  : "Lookup unavailable"
          },
          { status: response.status }
        );
      }

      const result = await response.json();

      if (result.success === false) {
        const fallbackResult = await lookupFallback(bin, env, result);
        return Response.json(fallbackResult, {
          headers: { "Cache-Control": "public, max-age=86400" }
        });
      }

      return Response.json(result, {
        headers: { "Cache-Control": "public, max-age=86400" }
      });
    } catch {
      return Response.json(
        { error: "Lookup service unavailable" },
        { status: 502 }
      );
    }
  }
};
