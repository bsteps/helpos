import { expect, it } from "vitest";
import { webHref } from "./web-href.ts";

it.each([
  ["javascript:alert(1)", null],
  ["java\nscript:alert(1)", null],
  ["data:text/html,hello", null],
  ["HTTPS://EXAMPLE.COM/path", "https://example.com/path"],
  [" https://example.com/path", "https://example.com/path"],
  ["http://", null],
  ["https://", null],
  ["https://example.com/path?q=1#part", "https://example.com/path?q=1#part"],
  ["http://example.com", "http://example.com/"],
  ["/relative", null],
  ["//example.com", null],
  ["", null],
  ["mailto:owner@example.com", null],
])("webHref(%j) returns %j", (url, expected) => {
  expect(webHref(url)).toBe(expected);
});
