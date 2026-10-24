// Writes the store-required native settings into the generated iOS and Android projects. Idempotent: run it after
// `npx cap add ios|android` (or any time app.config.json changes). Values come from app.config.json.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cfg = JSON.parse(readFileSync(join(here, 'app.config.json'), 'utf8'));
const done = [];

// ---------------------------------------------------------------- iOS
const plistPath = join(here, 'ios/App/App/Info.plist');
if (existsSync(plistPath)) {
  let plist = readFileSync(plistPath, 'utf8');
  /** Sets a top-level key (replacing any existing value) just before the closing </dict>. */
  const setKey = (key, valueXml) => {
    const re = new RegExp(`\\s*<key>${key}</key>\\s*(<string>[^<]*</string>|<true/>|<false/>|<array>[\\s\\S]*?</array>)`);
    plist = plist.replace(re, '');
    plist = plist.replace(/\n<\/dict>\s*<\/plist>\s*$/, `\n\t<key>${key}</key>\n\t${valueXml}\n</dict>\n</plist>\n`);
  };
  setKey('GADApplicationIdentifier', `<string>${cfg.admob.iosAppId}</string>`);
  setKey('NSUserTrackingUsageDescription', '<string>Allowing this lets the ads you choose to watch be more relevant to you. The game works the same either way.</string>');
  // Google's SKAdNetwork id (ad attribution without tracking). Add your other ad networks' ids here if you use them.
  setKey('SKAdNetworkItems', '<array>\n\t\t<dict>\n\t\t\t<key>SKAdNetworkIdentifier</key>\n\t\t\t<string>cstr6suwn9.skadnetwork</string>\n\t\t</dict>\n\t</array>');
  // HTTPS only: exempt from export-compliance paperwork.
  setKey('ITSAppUsesNonExemptEncryption', '<false/>');
  // Portrait game; full screen so iPad accepts portrait-only.
  setKey('UISupportedInterfaceOrientations', '<array>\n\t\t<string>UIInterfaceOrientationPortrait</string>\n\t</array>');
  setKey('UISupportedInterfaceOrientations~ipad', '<array>\n\t\t<string>UIInterfaceOrientationPortrait</string>\n\t\t<string>UIInterfaceOrientationPortraitUpsideDown</string>\n\t</array>');
  setKey('UIRequiresFullScreen', '<true/>');
  setKey('UIStatusBarHidden', '<true/>');
  setKey('UIViewControllerBasedStatusBarAppearance', '<false/>');
  setKey('UIRequiredDeviceCapabilities', '<array>\n\t\t<string>arm64</string>\n\t</array>');
  writeFileSync(plistPath, plist);

  // Universal links: challenge links on your domain open the app.
  writeFileSync(
    join(here, 'ios/App/App/App.entitlements'),
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>com.apple.developer.associated-domains</key>
\t<array>
\t\t<string>applinks:${cfg.linkDomain}</string>
\t</array>
</dict>
</plist>
`,
  );
  const pbxPath = join(here, 'ios/App/App.xcodeproj/project.pbxproj');
  let pbx = readFileSync(pbxPath, 'utf8');
  pbx = pbx.replace(/\t*CODE_SIGN_ENTITLEMENTS = [^;]*;\n/g, '');
  pbx = pbx.replace(/(\t+)PRODUCT_BUNDLE_IDENTIFIER = [^;]*;\n/g, (m, tabs) => `${tabs}CODE_SIGN_ENTITLEMENTS = App/App.entitlements;\n${tabs}PRODUCT_BUNDLE_IDENTIFIER = ${cfg.appId};\n`);
  writeFileSync(pbxPath, pbx);
  done.push('iOS');
}

// ---------------------------------------------------------------- Android
const manifestPath = join(here, 'android/app/src/main/AndroidManifest.xml');
if (existsSync(manifestPath)) {
  let m = readFileSync(manifestPath, 'utf8');
  m = m.replace(/\s*<!-- omt:begin -->[\s\S]*?<!-- omt:end -->/g, '');
  m = m.replace(/\s*android:screenOrientation="[^"]*"/g, '');
  m = m.replace('android:name=".MainActivity"', 'android:name=".MainActivity"\n            android:screenOrientation="portrait"');
  m = m.replace(
    /(<\/intent-filter>)(\s*<\/activity>)/,
    `$1
            <!-- omt:begin -->
            <intent-filter android:autoVerify="true">
                <action android:name="android.intent.action.VIEW" />
                <category android:name="android.intent.category.DEFAULT" />
                <category android:name="android.intent.category.BROWSABLE" />
                <data android:scheme="https" android:host="${cfg.linkDomain}" android:pathPrefix="/play" />
            </intent-filter>
            <!-- omt:end -->$2`,
  );
  m = m.replace(
    /(\s*<\/application>)/,
    `
        <!-- omt:begin -->
        <meta-data android:name="com.google.android.gms.ads.APPLICATION_ID" android:value="${cfg.admob.androidAppId}" />
        <!-- omt:end -->$1`,
  );
  m = m.replace(
    '<uses-permission android:name="android.permission.INTERNET" />',
    `<uses-permission android:name="android.permission.INTERNET" />
    <!-- omt:begin -->
    <uses-permission android:name="android.permission.POST_NOTIFICATIONS" />
    <!-- omt:end -->`,
  );
  writeFileSync(manifestPath, m);
  done.push('Android');
}

console.log(done.length ? `Configured: ${done.join(', ')}` : 'No native projects yet: run `npx cap add ios` / `npx cap add android` first.');
