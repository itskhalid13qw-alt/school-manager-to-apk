const { readFileSync, existsSync } = require('fs');
const path = require('path');

/* Set your school's server address once, here — every rebuild picks it up. This is the same
   address you'd type into a phone's browser: http://192.168.1.10:3000, or a real domain once
   you put the server behind one (e.g. https://school.example.com). */
const CONFIG_FILE = path.join(__dirname, 'server-address.txt');
const SERVER_URL = existsSync(CONFIG_FILE)
  ? readFileSync(CONFIG_FILE, 'utf8').trim()
  : 'http://192.168.1.10:3000'; // placeholder — replace via server-address.txt, see README

const isHttp = SERVER_URL.startsWith('http://');

/** @type {import('@capacitor/cli').CapacitorConfig} */
const config = {
  appId: 'com.schoolmanager.app',
  appName: 'School Manager',
  webDir: 'www',
  server: {
    url: SERVER_URL,
    // Plain http:// only works for a LAN address (e.g. the school's own Wi-Fi) — real internet
    // deployments should use https:// instead, which needs no cleartext exception.
    cleartext: isHttp,
  },
  plugins: {
    SplashScreen: { launchShowDuration: 800, backgroundColor: '#14483a' },
  },
};

module.exports = config;
