import assert from "node:assert/strict";
import test from "node:test";

import worker from "./_worker.js";

const originalFetch = globalThis.fetch;

function jsonResponse(body, status = 200) {
  return Response.json(body, { status });
}

async function requestBin(bin, env = {}) {
  return worker.fetch(
    new Request(`https://example.test/api/bin?bin=${bin}`),
    env
  );
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("returns a primary success without calling the fallback", async () => {
  const calls = [];
  const primaryResult = {
    scheme: "VISA",
    type: "CREDIT",
    success: true
  };

  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return jsonResponse(primaryResult);
  };

  const response = await requestBin("414720");

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), primaryResult);
  assert.deepEqual(calls, ["https://binlist.io/lookup/414720/"]);
});

test("normalizes a fallback success and sends an optional key server-side", async () => {
  const calls = [];
  const primaryResult = { success: false };

  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), headers: options.headers || {} });

    if (calls.length === 1) {
      return jsonResponse(primaryResult);
    }

    return jsonResponse({
      success: true,
      data: {
        bin: "543229",
        scheme: "Mastercard",
        funding: "Debit",
        segment: "Standard",
        issuer: "Example Bank",
        country_code: "US",
        country_name: "United States",
        bank_url: "example.test",
        bank_phone: "555-0100"
      }
    });
  };

  const response = await requestBin("543229", {
    IPNOVA_API_KEY: "test-secret"
  });
  const result = await response.json();

  assert.equal(response.status, 200);
  assert.equal(calls[1].url, "https://cardbincheck.com/api/bin/543229");
  assert.equal(calls[1].headers["X-Api-Key"], "test-secret");
  assert.deepEqual(result, {
    number: { iin: "543229", length: null, luhn: null },
    scheme: "MASTERCARD",
    type: "DEBIT",
    category: "STANDARD",
    country: { alpha2: "US", name: "United States" },
    bank: {
      name: "Example Bank",
      phone: "555-0100",
      url: "example.test"
    },
    success: true
  });
});

test("returns the primary not-found result when both providers miss", async () => {
  const primaryResult = { success: false };
  let callCount = 0;

  const originalConsoleError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);

  globalThis.fetch = async (_url, options = {}) => {
    callCount += 1;

    if (callCount === 1) {
      return jsonResponse(primaryResult);
    }

    assert.equal(options.headers["X-Api-Key"], undefined);
    return jsonResponse(
      { success: false, reason: "not_found", bin: "999999" },
      404
    );
  };

  try {
    const response = await requestBin("999999");

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), primaryResult);
    assert.equal(JSON.stringify(logs).includes("999999"), false);
    assert.equal(JSON.stringify(logs).includes("[redacted-bin]"), true);
  } finally {
    console.error = originalConsoleError;
  }
});

test("returns the primary not-found result when the fallback fails", async () => {
  const primaryResult = { success: false };
  let callCount = 0;

  globalThis.fetch = async () => {
    callCount += 1;

    if (callCount === 1) {
      return jsonResponse(primaryResult);
    }

    throw new Error("network failure containing a secret that must not be logged");
  };

  const originalConsoleError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args);

  try {
    const response = await requestBin("999999");

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), primaryResult);
    assert.deepEqual(logs, [
      ["BIN fallback upstream request failed", { status: "network_error" }]
    ]);
  } finally {
    console.error = originalConsoleError;
  }
});

test("rejects full card numbers before contacting either provider", async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("unexpected fetch");
  };

  const response = await requestBin("4111111111111111");

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "Invalid BIN" });
  assert.equal(called, false);
});
