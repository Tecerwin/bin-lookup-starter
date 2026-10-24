export async function onRequestGet({ request }) {
  const url = new URL(request.url);
  const bin = (url.searchParams.get("bin") || "").trim();

  if (!/^\d{6}(?:\d{2})?$/.test(bin)) {
    return Response.json(
      { error: "Invalid BIN" },
      { status: 400 }
    );
  }

  try {
    const upstream = await fetch(
      `https://lookup.binlist.net/${bin}`,
      {
        headers: {
          Accept: "application/json"
        }
      }
    );

    const body = await upstream.text();

    if (!upstream.ok) {
      return Response.json(
        {
          error: "Lookup unavailable",
          upstreamStatus: upstream.status
        },
        { status: 502 }
      );
    }

    return new Response(body, {
      headers: {
        "Content-Type": "application/json; charset=utf-8"
      }
    });

  } catch (error) {
    return Response.json(
      { error: "Lookup unavailable" },
      { status: 502 }
    );
  }
}
