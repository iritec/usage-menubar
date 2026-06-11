const fs = require("fs");
const path = require("path");

const DEFAULT_REQUIRED_STORAGE_KEYS = ["authToken", "refreshToken"];
const STORAGE_KEY_SCAN_EXTENSIONS = new Set([".ldb", ".log"]);

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

function selectChromeStorageProfile(matches, preferredProfilePath = null, excludedProfilePaths = []) {
  const candidates = Array.isArray(matches) ? matches.filter((match) => match && match.profilePath) : [];
  const excluded = new Set(excludedProfilePaths);
  const availableCandidates = candidates.filter((match) => !excluded.has(match.profilePath));
  if (!availableCandidates.length) {
    return null;
  }

  const score = (match) => {
    const foundKeys = new Set(Array.isArray(match.foundKeys) ? match.foundKeys : []);
    const requiredKeys = Array.isArray(match.requiredKeys) ? match.requiredKeys : DEFAULT_REQUIRED_STORAGE_KEYS;
    const requiredKeyScore = requiredKeys.filter((key) => foundKeys.has(key)).length * 1000;
    return requiredKeyScore + (match.score || 0);
  };

  return [...availableCandidates].sort((left, right) => {
    const scoreDelta = score(right) - score(left);
    if (scoreDelta) {
      return scoreDelta;
    }
    if (preferredProfilePath) {
      if (left.profilePath === preferredProfilePath) {
        return -1;
      }
      if (right.profilePath === preferredProfilePath) {
        return 1;
      }
    }
    return 0;
  })[0];
}

function getChromeIndexedDbStoragePaths(profilePath, indexedDbName) {
  const indexedDbPath = path.join(profilePath, "IndexedDB");
  return {
    levelDbPath: path.join(indexedDbPath, `${indexedDbName}.leveldb`),
    blobPath: path.join(indexedDbPath, `${indexedDbName}.blob`),
  };
}

function readStorageKeyMatches(levelDbPath, requiredKeys = DEFAULT_REQUIRED_STORAGE_KEYS) {
  const keys = Array.isArray(requiredKeys) ? requiredKeys : DEFAULT_REQUIRED_STORAGE_KEYS;
  if (!levelDbPath || !fs.existsSync(levelDbPath)) {
    return [];
  }

  const foundKeys = new Set();
  const files = fs.readdirSync(levelDbPath, { withFileTypes: true });
  for (const file of files) {
    if (!file.isFile() || !STORAGE_KEY_SCAN_EXTENSIONS.has(path.extname(file.name))) {
      continue;
    }

    const buffer = fs.readFileSync(path.join(levelDbPath, file.name));
    for (const key of keys) {
      if (!foundKeys.has(key) && buffer.includes(Buffer.from(key))) {
        foundKeys.add(key);
      }
    }
  }

  return keys.filter((key) => foundKeys.has(key));
}

module.exports = {
  getChromeIndexedDbStoragePaths,
  getChromeLastUsedProfilePath,
  readStorageKeyMatches,
  selectChromeCookieProfile,
  selectChromeStorageProfile,
};
