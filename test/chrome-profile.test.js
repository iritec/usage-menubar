const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const {
  getChromeLastUsedProfilePath,
  selectChromeCookieProfile,
} = require("../src/chrome-profile");

test("selectChromeCookieProfile prefers the last used Chrome profile over raw cookie count", () => {
  const defaultProfile = {
    profilePath: "/Users/example/Library/Application Support/Google/Chrome/Default",
    cookies: [{ name: "session" }],
  };
  const staleProfile = {
    profilePath: "/Users/example/Library/Application Support/Google/Chrome/Profile 9",
    cookies: [{ name: "a" }, { name: "b" }, { name: "c" }],
  };

  assert.equal(
    selectChromeCookieProfile(
      [staleProfile, defaultProfile],
      "/Users/example/Library/Application Support/Google/Chrome/Default",
    ),
    defaultProfile,
  );
});

test("selectChromeCookieProfile falls back to the profile with the most cookies", () => {
  const sparseProfile = {
    profilePath: "/Users/example/Library/Application Support/Google/Chrome/Default",
    cookies: [{ name: "session" }],
  };
  const populatedProfile = {
    profilePath: "/Users/example/Library/Application Support/Google/Chrome/Profile 9",
    cookies: [{ name: "a" }, { name: "b" }],
  };

  assert.equal(selectChromeCookieProfile([sparseProfile, populatedProfile]), populatedProfile);
});

test("selectChromeCookieProfile skips excluded profiles when retrying auth", () => {
  const preferredProfile = {
    profilePath: "/Users/example/Library/Application Support/Google/Chrome/Default",
    cookies: [{ name: "session" }],
  };
  const fallbackProfile = {
    profilePath: "/Users/example/Library/Application Support/Google/Chrome/Profile 9",
    cookies: [{ name: "a" }, { name: "b" }],
  };

  assert.equal(
    selectChromeCookieProfile(
      [preferredProfile, fallbackProfile],
      preferredProfile.profilePath,
      [preferredProfile.profilePath],
    ),
    fallbackProfile,
  );
});

test("getChromeLastUsedProfilePath resolves Chrome Local State profile.last_used", (t) => {
  const chromeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "usage-menubar-chrome-"));
  t.after(() => fs.rmSync(chromeRoot, { recursive: true, force: true }));
  fs.writeFileSync(
    path.join(chromeRoot, "Local State"),
    JSON.stringify({ profile: { last_used: "Profile 9" } }),
  );

  assert.equal(getChromeLastUsedProfilePath(chromeRoot), path.join(chromeRoot, "Profile 9"));
});
