# Android Capacitor prototype

This branch contains an experimental Android shell for the reader. It opens the existing site at `https://news.myecity.ir`; it does not bundle the reader or backend. The intended future web host is `https://news.pnu.ac.ir`.

## Fixed app identity

- Android application ID: `ir.realdream.news`
- Display name: `اخبار پیام‌نور`
- The application ID is independent of the Cafe Bazaar developer account ID (`realdream`) and should not change after publishing.

## Important prototype limitation

`capacitor.config.json` uses Capacitor's `server.url` to load the remote site. This is convenient for a first proof of concept, but Capacitor documents this option as intended for live reload and not as the normal production packaging strategy. Do not treat the debug APK from this branch as a Cafe Bazaar release. Before production, decide whether to use a supported remote-WebView shell or bundle the reader, and test authentication, navigation, service-worker behavior, offline behavior, and Android location permission handling.

The prototype uses the current hostname only. When the site is actually moved, update both `server.url` and `server.allowNavigation` to `news.pnu.ac.ir`, after DNS, HTTPS, and server configuration are ready.

## Build locally

Requirements: Node.js 22+, Android Studio with Android SDK, and the JDK supported by the Android Gradle project (JDK 21 for this Capacitor 8 setup).

```sh
npm ci
npx cap sync android
cd android
./gradlew assembleDebug
```

The debug APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`. It is debug-signed and for testing only; it is not the Cafe Bazaar release artifact.

## GitHub Actions

Pushing to `android-capacitor-prototype` runs `.github/workflows/android-capacitor-sample.yml`. When it succeeds, download the `PnuNews-android-debug-<commit>` artifact from that workflow run. The workflow uses the run number as the Android `versionCode` and the project version as `versionName`.

This workflow is intentionally scoped to the prototype branch. After the approach is accepted, update the trigger and add release signing with a separately protected keystore before producing any Bazaar-ready APK.
