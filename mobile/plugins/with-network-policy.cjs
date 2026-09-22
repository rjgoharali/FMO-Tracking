const { withAndroidManifest, withProjectBuildGradle } = require('expo/config-plugins');
const withInstalledNdk = config => withProjectBuildGradle(config, result => {
  // React Native 0.85 defaults to NDK 27.1. This Windows SDK has an incomplete
  // copy of that revision but a complete NDK 28.2 installation. Keep this local
  // build fallback explicit and regenerate native files from this plugin.
  const marker = "ext.ndkVersion = '28.2.13676358'";
  if (!result.modResults.contents.includes(marker)) {
    result.modResults.contents = result.modResults.contents.replace('apply plugin: "expo-root-project"', `${marker}\n\napply plugin: "expo-root-project"`);
  }
  return result;
});
module.exports = config => withAndroidManifest(withInstalledNdk(config), result => {
  const application = result.modResults.manifest.application?.[0];
  if (application) {
    application.$['android:usesCleartextTraffic'] = process.env.APP_VARIANT === 'production' ? 'false' : 'true';
    application.$['android:allowBackup'] = 'false';
  }
  return result;
});
