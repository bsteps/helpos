import assert from "node:assert/strict";
import { test } from "node:test";
import { responseBody } from "./response.mjs";

for (const text of ["", "plain text", "<html>Bad gateway</html>", "{broken"]) {
  test(`non-JSON response stays visible: ${text}`, () => {
    assert.deepEqual(responseBody(text), { shown: text, json: {} });
  });
}
test("JSON objects preserve created IDs and format the output", () => {
  const value = { conversationId: "conversation-1", token: "test-token" };
  assert.deepEqual(responseBody(JSON.stringify(value)), {
    shown: JSON.stringify(value, null, 2),
    json: value,
  });
});
for (const value of [null, true, 42, "text"]) {
  test(`JSON scalar cannot crash created-ID lookup: ${value}`, () => {
    assert.deepEqual(responseBody(JSON.stringify(value)), {
      shown: JSON.stringify(value),
      json: {},
    });
  });
}
