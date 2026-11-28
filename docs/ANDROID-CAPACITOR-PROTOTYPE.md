# Android Capacitor prototype

This branch contains an experimental Android shell for the reader. It opens the existing site at `https://news.myecity.ir`; it does not bundle the reader or backend. The intended future web host is `https://news.pnu.ac.ir`.

## Fixed app identity

- Android application ID: `ir.realdream.news`
- Display name: `اخبار پیام‌نور`
- The application ID is independent of the Cafe Bazaar developer account ID (`realdream`) and should not change after publishing.

## Important prototype limitation

`capacitor.config.json` uses Capacitor's `server.url` to load the remote site. This is convenient for a first proof of concept, but Capacitor documents this option as intended for live reload and not as the normal production packaging strategy. The signed release APK from this branch is only for testing signing and installation; it is not a Cafe Bazaar release. Before production, decide whether to use a supported remote-WebView shell or bundle the reader, and test authentication, navigation, service-worker behavior, offline behavior, and Android location permission handling.

The prototype uses the current hostname only. When the site is actually moved, update both `server.url` and `server.allowNavigation` to `news.pnu.ac.ir`, after DNS, HTTPS, and server configuration are ready.

## Build locally

Requirements: Node.js 22+, Android Studio with Android SDK, and the JDK supported by the Android Gradle project (JDK 21 for this Capacitor 8 setup).

```sh
npm ci
npx cap sync android
cd android
./gradlew assembleDebug
```

The debug APK is written to `android/app/build/outputs/apk/debug/app-debug.apk`. It uses Android's debug signing key. For a signed release build, set `ANDROID_KEYSTORE_PATH`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD` in the build environment, then run `./gradlew assembleRelease` from `android/`. Never commit the release keystore or its passwords.

## GitHub Actions

Pushing to `main` runs `.github/workflows/android-capacitor-sample.yml` and builds a signed release APK. Configure these repository Actions secrets first: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`. The workflow decodes the keystore only in the temporary runner directory and removes it after the build. Download the `PnuNews-android-release-<commit>` artifact from the run. It uses the run number as Android `versionCode` and the project version as `versionName`.

The artifact is signed for testing, but the remote-WebView approach still needs a production decision and validation before any Bazaar release.
