// The app shell (Capacitor, see App/). In a browser every call here is a no-op, so the web game is unchanged.
// Plugins are reached through the bridge the native runtime injects (window.Capacitor); nothing is bundled.

import { store } from './store.js';

const cap = window.Capacitor;
const isNative = !!cap?.isNativePlatform?.();
const plugin = (name) => (isNative ? cap.registerPlugin(name) : null);

const Haptics = plugin('Haptics');
const Share = plugin('Share');
const Preferences = plugin('Preferences');
const LocalNotifications = plugin('LocalNotifications');
const App = plugin('App');
const AdMob = plugin('AdMob');

const meta = (name) => document.querySelector(`meta[name="${name}"]`)?.content ?? '';
/** AdMob ad units differ per platform; the app build writes both (App/build-www.mjs). */
const rewardedUnit = () => (isNative ? meta(`omt-admob-rewarded-${cap.getPlatform()}`) : '');
const STREAK_REMINDER_ID = 1001;

// iOS can clear a web view's storage under pressure, and the refresh token there is the player's account. The app
// keeps a native copy of every write and restores it before the game reads anything (this module loads first).
if (Preferences) {
  try {
    if (localStorage.getItem('omt.deviceId') === null) {
      const { keys } = await Preferences.keys();
      for (const key of keys.filter((k) => k.startsWith('omt.'))) {
        const { value } = await Preferences.get({ key });
        if (value !== null) localStorage.setItem(key, value);
      }
    }
  } catch {
    // Nothing to restore, or native storage unavailable: start fresh like the web.
  }
  store.mirrorTo((key, value) => Preferences.set({ key, value }).catch(() => {}));
}

let adsReady = null;

/** AdMob once per launch: consent (GDPR/UMP) first, then Apple's tracking prompt, then the SDK. */
function initAds() {
  if (!AdMob || !rewardedUnit()) return Promise.resolve(false);
  adsReady ??= (async () => {
    try {
      const consent = await AdMob.requestConsentInfo();
      if (consent.isConsentFormAvailable && consent.status === 'REQUIRED') await AdMob.showConsentForm();
      if (cap.getPlatform() === 'ios') {
        const { status } = await AdMob.trackingAuthorizationStatus();
        if (status === 'notDetermined') await AdMob.requestTrackingAuthorization();
      }
      await AdMob.initialize({ initializeForTesting: meta('omt-admob-testing') === 'true' });
      return true;
    } catch {
      return false;
    }
  })();
  return adsReady;
}

/** The hour the player usually plays (median of recent sessions), for reminders that land at a familiar time. */
function habitualHour() {
  const hours = store.get('playHours', []).filter((h) => Number.isInteger(h) && h >= 0 && h < 24);
  if (hours.length === 0) return 19;
  const sorted = [...hours].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export const native = {
  isNative,
  platform: isNative ? cap.getPlatform() : 'web',

  /** kind: 'tap' | 'perfect' | 'miss' | 'big'. Returns false when the caller should fall back to the web API. */
  haptic(kind) {
    if (!Haptics) return false;
    const call =
      kind === 'miss' ? Haptics.notification({ type: 'ERROR' })
      : kind === 'big' ? Haptics.notification({ type: 'SUCCESS' })
      : Haptics.impact({ style: kind === 'perfect' ? 'HEAVY' : 'LIGHT' });
    call.catch(() => {});
    return true;
  },

  /** The native share sheet. Resolves false when unavailable (the caller copies to the clipboard instead). */
  async share(text, url) {
    if (!Share) return false;
    try {
      await Share.share({ text, url, dialogTitle: 'Challenge a friend' });
      return true;
    } catch {
      return true; // the player closed the sheet: still handled, don't fall back to the clipboard
    }
  },

  /** Erases the app's native copy of saved data (account deletion). */
  async clearSaved() {
    await Preferences?.clear().catch(() => {});
  },

  /** Rewarded ads come from AdMob in the app. */
  adsAvailable() {
    return !!AdMob && !!rewardedUnit();
  },

  /**
   * Shows one rewarded ad. AdMob reports the reward to our server directly (server-side verification carries the
   * grant id), so the client only learns whether the player watched to the end.
   */
  async rewardedAd({ grantId, userId }) {
    if (!(await initAds())) return false;
    const handles = [];
    try {
      const rewarded = new Promise((resolve) => {
        const listen = (event, value) => AdMob.addListener(event, () => resolve(value)).then((h) => handles.push(h));
        listen('onRewardedVideoAdReward', true);
        listen('onRewardedVideoAdDismissed', false);
        listen('onRewardedVideoAdFailedToShow', false);
      });
      await AdMob.prepareRewardVideoAd({
        adId: rewardedUnit(),
        isTesting: meta('omt-admob-testing') === 'true',
        ssv: { userId, customData: grantId },
      });
      await AdMob.showRewardVideoAd();
      return await rewarded;
    } catch {
      return false;
    } finally {
      for (const h of handles) h.remove?.();
    }
  },

  notifications: {
    /** 'granted' | 'denied' | 'prompt' | 'unsupported'. */
    async status() {
      if (!LocalNotifications) return 'unsupported';
      try {
        const { display } = await LocalNotifications.checkPermissions();
        return display === 'granted' ? 'granted' : display === 'denied' ? 'denied' : 'prompt';
      } catch {
        return 'unsupported';
      }
    },
    async request() {
      if (!LocalNotifications) return false;
      try {
        return (await LocalNotifications.requestPermissions()).display === 'granted';
      } catch {
        return false;
      }
    },
    /**
     * After a Ranked run: remember when the player plays, and set tomorrow's reminder at that hour. Playing again
     * before then moves it on a day, so only a player who hasn't played yet gets it.
     */
    async afterRankedRun(streak) {
      const hours = [...store.get('playHours', []), new Date().getHours()].slice(-20);
      store.set('playHours', hours);
      if (!LocalNotifications || (await native.notifications.status()) !== 'granted') return;
      const at = new Date();
      at.setDate(at.getDate() + 1);
      at.setHours(habitualHour(), 0, 0, 0);
      try {
        await LocalNotifications.cancel({ notifications: [{ id: STREAK_REMINDER_ID }] });
        await LocalNotifications.schedule({
          notifications: [
            {
              id: STREAK_REMINDER_ID,
              title: streak > 1 ? `Your ${streak}-day streak is waiting` : 'One more tap?',
              body: streak > 1 ? 'One Ranked run today keeps it alive.' : 'Your rings are ready when you are.',
              // Inexact on purpose: exact alarms need a permission Google Play reserves for alarm apps.
              schedule: { at },
            },
          ],
        });
      } catch {
        // Scheduling failed (permission revoked mid-session): nothing to do.
      }
    },
  },

  /** Challenge links (https://…/play/#c-…) that open the app: on launch and while running. */
  async onDeepLink(fn) {
    if (!App) return;
    const hashOf = (url) => {
      const i = url?.indexOf('#') ?? -1;
      return i >= 0 ? url.slice(i) : '';
    };
    App.addListener('appUrlOpen', ({ url }) => fn(hashOf(url))).catch(() => {});
    try {
      const launch = await App.getLaunchUrl();
      if (launch?.url) fn(hashOf(launch.url));
    } catch {
      // No launch URL.
    }
  },

  onPause(fn) {
    App?.addListener('pause', fn).catch(() => {});
  },

  /** Android back button: `fn` returns true when it handled the press; otherwise the app closes. */
  onBack(fn) {
    App?.addListener('backButton', () => {
      if (!fn()) App.exitApp();
    }).catch(() => {});
  },
};
