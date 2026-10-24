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

function mockProviders(primaryResult, fallbackResult, calls = []) {
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), headers: options.headers || {} });
    return calls.length === 1
      ? jsonResponse(primaryResult)
      : jsonResponse(fallbackResult);
  };
}

test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("enriches an incomplete successful primary result for BIN 47414721", async () => {
  const calls = [];
  const primaryResult = {
    number: { iin: "47414721", length: 16, luhn: true },
    scheme: "VISA",
    type: "Unknown",
    category: "",
    country: { alpha2: "GB", name: null },
    bank: { name: "Primary Bank", phone: "N/A", url: null },
    success: true
  };

  mockProviders(primaryResult, {
    success: true,
    data: {
      bin: "474147",
      scheme: "Visa",
      funding: "Debit",
      segment: "Platinum",
      country_code: "US",
      country_name: "United Kingdom",
      issuer: "Fallback Bank",
      bank_phone: "+44 20 0000 0000",
      bank_url: "fallback.example"
    }
  }, calls);

  const response = await requestBin("47414721");

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    number: { iin: "47414721", length: 16, luhn: true },
    scheme: "VISA",
    type: "DEBIT",
    category: "PLATINUM",
    country: { alpha2: "GB", name: "United Kingdom" },
    bank: {
      name: "Primary Bank",
      phone: "+44 20 0000 0000",
      url: "fallback.example"
    },
    success: true
  });
  assert.deepEqual(calls.map(({ url }) => url), [
    "https://binlist.io/lookup/47414721/",
    "https://cardbincheck.com/api/bin/47414721"
  ]);
});

test("turns a primary failure into success when fallback has a genuine record", async () => {
  const calls = [];
  const primaryResult = {
    number: { iin: "543229", length: 16, luhn: false },
    success: false,
    reason: "not_found"
  };

  mockProviders(primaryResult, {
    success: true,
    data: {
      bin: "543229",
      funding: "Debit",
      segment: "Standard",
      issuer: "Example Bank",
      country_code: "US",
      country_name: "United States"
    }
  }, calls);

  const response = await requestBin("543229", {
    IPNOVA_API_KEY: "test-secret"
  });

  assert.equal(calls[1].headers["X-Api-Key"], "test-secret");
  assert.deepEqual(await response.json(), {
    number: { iin: "543229", length: 16, luhn: false },
    type: "DEBIT",
    category: "STANDARD",
    country: { alpha2: "US", name: "United States" },
    bank: { name: "Example Bank" },
    success: true,
    reason: "not_found"
  });
});

test("preserves conflicting nonblank primary values and fills only gaps", async () => {
  const primaryResult = {
    type: "CREDIT",
    category: null,
    country: { alpha2: "CA", name: "Canada" },
    bank: { name: "Primary Bank", phone: "555-0100", url: "primary.example" },
    success: true
  };

  mockProviders(primaryResult, {
    success: true,
    data: {
      funding: "Debit",
      segment: "Gold",
      country_code: "US",
      country_name: "United States",
      issuer: "Fallback Bank",
      bank_phone: "555-9999",
      bank_url: "fallback.example"
    }
  });

  const response = await requestBin("414720");

  assert.deepEqual(await response.json(), {
    type: "CREDIT",
    category: "GOLD",
    country: { alpha2: "CA", name: "Canada" },
    bank: { name: "Primary Bank", phone: "555-0100", url: "primary.example" },
    success: true
  });
});

test("does not fill gaps with placeholder fallback values", async () => {
  const primaryResult = {
    type: null,
    category: "Unknown",
    country: { alpha2: "", name: "N/A" },
    bank: { name: null, phone: "null", url: " " },
    success: false
  };

  mockProviders(primaryResult, {
    success: true,
    data: {
      funding: "Unknown",
      segment: "N/A",
      country_code: "null",
      country_name: " ",
      issuer: "Unknown",
      bank_phone: "N/A",
      bank_url: "null"
    }
  });

  const response = await requestBin("999999");

  assert.deepEqual(await response.json(), primaryResult);
});

test("never downgrades an eight-digit IIN or overwrites primary number metadata", async () => {
  const primaryResult = {
    number: { iin: "47414721", length: 19, luhn: false },
    type: null,
    category: "CLASSIC",
    country: { alpha2: "GB", name: "United Kingdom" },
    bank: { name: "Primary Bank", phone: "555-0100", url: "primary.example" },
    success: true
  };

  mockProviders(primaryResult, {
    success: true,
    data: { bin: "474147", funding: "Debit" }
  });

  const response = await requestBin("47414721");
  const result = await response.json();

  assert.deepEqual(result.number, {
    iin: "47414721",
    length: 19,
    luhn: false
  });
  assert.equal(result.type, "DEBIT");
});

test("returns the untouched primary result when fallback fails", async () => {
  const primaryResult = {
    number: { iin: "999999", length: 16, luhn: null },
    type: null,
    success: false
  };
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

    assert.deepEqual(await response.json(), primaryResult);
    assert.deepEqual(logs, [
      ["BIN fallback upstream request failed", { status: "network_error" }]
    ]);
  } finally {
    console.error = originalConsoleError;
  }
});

test("does not call fallback when every selected primary field is present", async () => {
  const calls = [];
  const primaryResult = {
    type: "CREDIT",
    category: "CLASSIC",
    country: { alpha2: "US", name: "United States" },
    bank: { name: "Example Bank", phone: "555-0100", url: "example.test" },
    success: true
  };

  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return jsonResponse(primaryResult);
  };

  const response = await requestBin("414720");

  assert.deepEqual(await response.json(), primaryResult);
  assert.deepEqual(calls, ["https://binlist.io/lookup/414720/"]);
});

test("rejects values other than strict six- or eight-digit BINs", async () => {
  let called = false;
  globalThis.fetch = async () => {
    called = true;
    throw new Error("unexpected fetch");
  };

  for (const bin of ["12345", "1234567", "123456789", "4111111111111111"]) {
    const response = await requestBin(bin);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "Invalid BIN" });
  }

  assert.equal(called, false);
});
