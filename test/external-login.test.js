const test = require("node:test");
const assert = require("node:assert/strict");
const { getExternalLoginCommand } = require("../src/external-login");

test("external login opens Google Chrome explicitly on macOS", () => {
  assert.deepEqual(getExternalLoginCommand("https://claude.ai/new#settings/usage", "darwin"), {
    command: "open",
    args: ["-a", "Google Chrome", "https://claude.ai/new#settings/usage"],
  });
});

test("external login command falls back to shell handling on non-macOS", () => {
  assert.equal(getExternalLoginCommand("https://claude.ai/new#settings/usage", "linux"), null);
});
