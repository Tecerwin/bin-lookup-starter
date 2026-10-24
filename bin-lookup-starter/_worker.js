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
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 500);
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
      const response = await fetch(`https://binlist.io/lookup/${bin}/`, {
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

      return Response.json(await response.json(), {
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
