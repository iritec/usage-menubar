#!/usr/bin/env node

const https = require("node:https");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const packageJson = JSON.parse(
  readFileSync(join(__dirname, "..", "package.json"), "utf8")
);

const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;

if (!token) {
  console.error("GH_TOKEN or GITHUB_TOKEN is required to remove blockmap assets.");
  process.exit(1);
}

function getGithubPublishConfig() {
  const publish = packageJson.build && packageJson.build.publish;
  const configs = Array.isArray(publish) ? publish : publish ? [publish] : [];
  const config = configs.find((item) => item && item.provider === "github");

  if (!config || !config.owner || !config.repo) {
    throw new Error("GitHub publish config must include owner and repo.");
  }

  return config;
}

const { owner, repo } = getGithubPublishConfig();
const tag = `v${packageJson.version}`;

function request(method, path) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: "api.github.com",
        method,
        path,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "User-Agent": "usage-menubar-release",
          "X-GitHub-Api-Version": "2022-11-28"
        }
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          const statusCode = res.statusCode || 0;

          if (statusCode >= 200 && statusCode < 300) {
            if (!body) {
              resolve(null);
              return;
            }

            try {
              resolve(JSON.parse(body));
            } catch {
              resolve(body);
            }
            return;
          }

          const error = new Error(
            `GitHub API request failed: ${method} ${path} (${statusCode})`
          );
          error.statusCode = statusCode;
          error.responseBody = body;
          reject(error);
        });
      }
    );

    req.on("error", reject);
    req.end();
  });
}

async function getRelease() {
  try {
    return await request(
      "GET",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/tags/${encodeURIComponent(tag)}`
    );
  } catch (error) {
    if (error.statusCode !== 404) {
      throw error;
    }
  }

  const releases = await request(
    "GET",
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=100`
  );
  const release = releases.find((item) => item.tag_name === tag);

  if (!release) {
    throw new Error(`Release ${tag} was not found.`);
  }

  return release;
}

async function main() {
  const release = await getRelease();
  const blockmapAssets = (release.assets || []).filter((asset) =>
    asset.name.endsWith(".blockmap")
  );

  if (blockmapAssets.length === 0) {
    console.log(`No blockmap assets found on ${tag}.`);
    return;
  }

  for (const asset of blockmapAssets) {
    await request(
      "DELETE",
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/assets/${asset.id}`
    );
    console.log(`Removed release blockmap asset: ${asset.name}`);
  }
}

main().catch((error) => {
  console.error(error.message);
  if (error.responseBody) {
    console.error(error.responseBody);
  }
  process.exit(1);
});
