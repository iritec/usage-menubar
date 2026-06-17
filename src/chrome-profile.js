const fs = require("fs");
const path = require("path");

function getChromeLastUsedProfilePath(chromeRoot) {
  try {
    const localState = JSON.parse(fs.readFileSync(path.join(chromeRoot, "Local State"), "utf8"));
    const profileName = localState?.profile?.last_used;
    return profileName ? path.join(chromeRoot, profileName) : null;
  } catch {
    return null;
  }
}

function selectChromeCookieProfile(matches, preferredProfilePath = null, excludedProfilePaths = []) {
  const candidates = Array.isArray(matches) ? matches.filter((match) => match && match.profilePath) : [];
  const excluded = new Set(excludedProfilePaths);
  const availableCandidates = candidates.filter((match) => !excluded.has(match.profilePath));
  if (!availableCandidates.length) {
    return null;
  }

  const preferred = preferredProfilePath
    ? availableCandidates.find((match) => match.profilePath === preferredProfilePath)
    : null;
  if (preferred) {
    return preferred;
  }

  return [...availableCandidates].sort((left, right) => (right.cookies?.length || 0) - (left.cookies?.length || 0))[0];
}

module.exports = {
  getChromeLastUsedProfilePath,
  selectChromeCookieProfile,
};
