# School Manager — Android and iOS app

This folder wraps the School Manager web app as a real Android and iOS app, using
[Capacitor](https://capacitorjs.com). The app itself still runs on your server (the same one
the browser version uses) — the phone app is a thin native shell with your school's icon, a
splash screen, and no browser address bar. It needs your server to be reachable from the phone
(same Wi-Fi as the school, or a real internet address if you host it online).

## 1. Point it at your server

Edit `server-address.txt` and put your server's address on the one line, for example:

```
http://192.168.1.10:3000
```

Find your server PC's address with `ipconfig` (Windows) or `ip addr` (Linux/Mac) — it's the
same address you already use to open School Manager from a phone's browser. Once you have a
real domain with HTTPS, use that instead (`https://school.example.com`) — plain `http://` only
works for a local network address.

## 2. Install and sync

```
npm install
npm run sync
```

Run `npm run sync` again any time you change `server-address.txt` or the icons in `resources/`.

## 3a. Build the Android app

Requires [Android Studio](https://developer.android.com/studio) (free, Windows/Mac/Linux).

```
npm run android
```

This opens the `android` folder in Android Studio. From there:
- **Try it on your phone**: plug the phone in (USB debugging on), press the green ▶ Run button.
- **Get a real .apk to share**: `Build` → `Build Bundle(s) / APK(s)` → `Build APK(s)`. Android Studio
  shows a link to the finished file when it's done — send that `.apk` to any Android phone to
  install it.
- **Publish it to the Play Store**: `Build` → `Generate Signed Bundle / APK`, following Google's
  usual signing and Play Console steps.

## 3b. Build the iOS app

**Requires a Mac with Xcode** — iOS apps can only be built and signed on a Mac; there is no way
around this, Apple does not allow it on Windows or Linux.

On a Mac, copy this whole `mobile` folder over, then:

```
npm install
sudo gem install cocoapods    # first time only
npx cap sync
npm run ios
```

This opens `ios/App/App.xcworkspace` in Xcode. From there:
- **Try it on your iPhone**: plug it in, choose it as the run target, press ▶. The first time,
  you'll sign in with your Apple ID under Xcode → Settings → Accounts (a free account lets you
  install on your own phone for 7 days at a time; a paid Apple Developer account, $99/year,
  removes that limit and is required to publish to the App Store).
- **Publish it to the App Store**: `Product` → `Archive`, then follow Xcode's Organizer steps to
  upload to App Store Connect.

## Re-branding

- **App icon / splash screen**: replace `resources/icon.png` (a 1024×1024 square) and
  `resources/splash.png`, then run `npx capacitor-assets generate` followed by `npm run sync`.
- **App name**: change `appName` in `capacitor.config.js`, then `npm run sync`.

## Updating after you change the web app

The Android and iOS apps just load your server's address, so most changes (new screens, fixed
bugs) appear automatically the next time the app opens — nothing to rebuild. You only need to
rebuild and reinstall the app itself when you change the **icon, splash screen, name, or the
server address**.
