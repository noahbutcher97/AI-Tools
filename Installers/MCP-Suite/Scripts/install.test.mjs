import assert from "node:assert/strict";
import { test } from "node:test";

import { buildValidationHeaders } from "./install.mjs";

test("buildValidationHeaders supports explicit auth headers with interpolation", () => {
  const headers = buildValidationHeaders(
    { type: "header", header: "Authorization", value: "Bot {DISCORD_BOT_TOKEN}" },
    { DISCORD_BOT_TOKEN: "abc123" },
  );

  assert.equal(headers.Authorization, "Bot abc123");
});

test("buildValidationHeaders rejects invalid auth header names", () => {
  assert.throws(
    () => buildValidationHeaders(
      { type: "header", header: "Bad Header", value: "Bot {DISCORD_BOT_TOKEN}" },
      { DISCORD_BOT_TOKEN: "abc123" },
    ),
    /Invalid auth header name/,
  );
});
