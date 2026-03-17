const { execSync } = require("child_process");
const path = require("path");

exports.default = async function notarize(context) {
  const { electronPlatformName, appOutDir } = context;

  if (electronPlatformName !== "darwin") {
    console.log("Skipping notarization: not macOS");
    return;
  }

  const keychainProfile = process.env.APPLE_KEYCHAIN_PROFILE;
  if (!keychainProfile) {
    console.log(
      "Skipping notarization: APPLE_KEYCHAIN_PROFILE is not set"
    );
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  console.log(`Notarizing ${appPath} …`);

  // Create a temporary zip for submission
  const zipPath = path.join(appOutDir, `${appName}-notarize.zip`);
  execSync(
    `ditto -c -k --keepParent "${appPath}" "${zipPath}"`,
    { stdio: "inherit" }
  );

  try {
    execSync(
      `xcrun notarytool submit "${zipPath}" --keychain-profile "${keychainProfile}" --wait`,
      { stdio: "inherit" }
    );

    // Staple the notarization ticket
    execSync(`xcrun stapler staple "${appPath}"`, { stdio: "inherit" });
    console.log("Notarization complete");
  } finally {
    // Clean up temporary zip
    try {
      require("fs").unlinkSync(zipPath);
    } catch (_) {}
  }
};
