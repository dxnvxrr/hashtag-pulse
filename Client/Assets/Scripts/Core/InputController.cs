using System;
using UnityEngine;
using UnityEngine.InputSystem;
#if UNITY_IOS && !UNITY_EDITOR
using System.Runtime.InteropServices;
#endif

namespace OneMoreTap.Core
{
    /// <summary>A single pointer event. Value type: raising it never allocates.</summary>
    public readonly struct PointerSample
    {
        /// <summary>Raw screen position in pixels.</summary>
        public readonly Vector2 Screen;
        /// <summary>0..1 across the full screen (bottom-left origin).</summary>
        public readonly Vector2 Normalized;
        /// <summary>-1..1 relative to the safe-area centre, scaled by its short side — aspect-independent gameplay space.</summary>
        public readonly Vector2 SafeCentered;
        /// <summary>
        /// Hardware event timestamp on the Time.realtimeSinceStartupAsDouble timeline. This is when the finger
        /// touched the glass, not when the frame processed it — it removes up to a full frame of quantisation error,
        /// which matters when PERFECT is ±5 ms.
        /// </summary>
        public readonly double EventTime;

        public PointerSample(Vector2 screen, Vector2 normalized, Vector2 safeCentered, double eventTime)
        {
            Screen = screen;
            Normalized = normalized;
            SafeCentered = safeCentered;
            EventTime = eventTime;
        }
    }

    /// <summary>
    /// Single-tap-anywhere input (GDD Pillar 1) on the New Input System.
    ///
    /// Tap fires on press-down, never on release: waiting for release would add the whole contact time to every
    /// tap's error. That makes the GDD's long-press Slow-Mo gesture impossible without breaking taps (every long
    /// press starts as a tap), so Slow-Mo is a dedicated corner button: presses inside <see cref="_slowMoZone"/>
    /// raise <see cref="SlowMoPressed"/> and never count as ring taps.
    /// </summary>
    [DisallowMultipleComponent]
    public sealed class InputController : MonoBehaviour
    {
        [SerializeField] private bool _hapticsEnabled = true;
        [Tooltip("Slow-Mo button area in normalized screen space (0..1, bottom-left origin). Presses here never tap the ring.")]
        [SerializeField] private Rect _slowMoZone = new Rect(0.72f, 0.0f, 0.28f, 0.12f);

        /// <summary>Press-down. The gameplay layer resolves the verdict from <see cref="PointerSample.EventTime"/>.</summary>
        public event Action<PointerSample> Tapped;
        public event Action<PointerSample> Released;
        /// <summary>The Slow-Mo button zone was pressed.</summary>
        public event Action<PointerSample> SlowMoPressed;
        /// <summary>Fires once per app session: the trigger for deferred SDK/audio initialisation.</summary>
        public event Action FirstTap;

        public bool IsPressed => _pressed;
        public bool InputEnabled { get; set; } = true;

        private InputAction _press;
        private InputAction _position;
        private bool _pressed;
        private bool _firstTapRaised;
        private Rect _safeArea;
        private Vector2Int _screenSize;

        private void Awake()
        {
            _press = new InputAction("Press", InputActionType.Button);
            _press.AddBinding("<Touchscreen>/primaryTouch/press");
            _press.AddBinding("<Mouse>/leftButton");
            _press.AddBinding("<Pen>/tip");

            // <Pointer> covers touch, mouse and pen.
            _position = new InputAction("Position", InputActionType.PassThrough, "<Pointer>/position");

            _press.performed += OnPressPerformed;
            _press.canceled += OnPressCanceled;

            RefreshScreenMetrics();
            HapticEngine.Initialize();
        }

        private void OnEnable()
        {
            _position.Enable();
            _press.Enable();
        }

        private void OnDisable()
        {
            _press.Disable();
            _position.Disable();
            _pressed = false;
        }

        private void OnDestroy()
        {
            _press.performed -= OnPressPerformed;
            _press.canceled -= OnPressCanceled;
            _press.Dispose();
            _position.Dispose();
        }

        private void Update()
        {
            if (Screen.width != _screenSize.x || Screen.height != _screenSize.y) RefreshScreenMetrics();
        }

        public Rect SlowMoZone
        {
            get => _slowMoZone;
            set => _slowMoZone = value;
        }

        public void SetHapticsEnabled(bool enabled) => _hapticsEnabled = enabled;

        public void PlayHaptic(HapticPattern pattern)
        {
            if (_hapticsEnabled) HapticEngine.Play(pattern);
        }

        private void OnPressPerformed(InputAction.CallbackContext ctx)
        {
            if (!InputEnabled) return;
            _pressed = true;

            PointerSample sample = Sample(_position.ReadValue<Vector2>(), ctx.time);
            if (_slowMoZone.Contains(sample.Normalized))
            {
                SlowMoPressed?.Invoke(sample);
                return;
            }
            if (!_firstTapRaised)
            {
                _firstTapRaised = true;
                FirstTap?.Invoke();
            }
            Tapped?.Invoke(sample);
        }

        private void OnPressCanceled(InputAction.CallbackContext ctx)
        {
            if (!_pressed) return;
            _pressed = false;
            if (!InputEnabled) return;
            Released?.Invoke(Sample(_position.ReadValue<Vector2>(), ctx.time));
        }

        private PointerSample Sample(Vector2 screen, double time)
        {
            float w = _screenSize.x > 0 ? _screenSize.x : 1f;
            float h = _screenSize.y > 0 ? _screenSize.y : 1f;
            var normalized = new Vector2(screen.x / w, screen.y / h);

            float shortSide = Mathf.Max(1f, Mathf.Min(_safeArea.width, _safeArea.height));
            Vector2 centre = _safeArea.center;
            var safeCentered = new Vector2((screen.x - centre.x) * 2f / shortSide, (screen.y - centre.y) * 2f / shortSide);

            return new PointerSample(screen, normalized, safeCentered, time);
        }

        private void RefreshScreenMetrics()
        {
            _screenSize = new Vector2Int(Screen.width, Screen.height);
            _safeArea = Screen.safeArea;
        }
    }

    public enum HapticPattern
    {
        /// <summary>±5 ms: sharp heavy pop.</summary>
        Perfect = 0,
        /// <summary>6–15 ms: crisp light tick.</summary>
        Clean = 1,
        /// <summary>16–40 ms near miss: soft tap.</summary>
        Close = 2,
        /// <summary>Clean miss: muted descending buzz.</summary>
        Miss = 3,
        /// <summary>Streak 10/25/50/100: triple pulse.</summary>
        StreakMilestone = 4,
        /// <summary>Ring spawn: barely-there tick (haptic-only accessibility mode).</summary>
        RingSpawn = 5,
    }

    /// <summary>
    /// Platform haptics without per-call managed allocation.
    /// Android: VibrationEffect (API 26+) through raw JNI with cached method ids, global refs and argument arrays.
    /// iOS: UIImpactFeedbackGenerator / Core Haptics via the native bridge in Plugins/iOS/OMTHaptics.mm.
    /// </summary>
    public static class HapticEngine
    {
        private static bool _initialized;

#if UNITY_IOS && !UNITY_EDITOR
        [DllImport("__Internal")] private static extern void OMTHaptics_Prepare();
        [DllImport("__Internal")] private static extern void OMTHaptics_Play(int pattern);

        public static void Initialize()
        {
            if (_initialized) return;
            _initialized = true;
            OMTHaptics_Prepare();
        }

        public static void Play(HapticPattern pattern) => OMTHaptics_Play((int)pattern);

#elif UNITY_ANDROID && !UNITY_EDITOR
        private static IntPtr _vibrator;
        private static IntPtr _effectClass;
        private static IntPtr _createOneShot;
        private static IntPtr _createWaveform;
        private static IntPtr _vibrateMethod;
        private static bool _hasAmplitude;
        private static bool _supportsEffects;

        private static readonly jvalue[] OneShotArgs = new jvalue[2];
        private static readonly jvalue[] WaveformArgs = new jvalue[3];
        private static readonly jvalue[] VibrateArgs = new jvalue[1];

        // Waveform patterns are converted to Java arrays once and pinned as global refs.
        private static IntPtr _streakTimings;
        private static IntPtr _streakAmplitudes;
        private static IntPtr _missTimings;
        private static IntPtr _missAmplitudes;

        public static void Initialize()
        {
            if (_initialized) return;
            _initialized = true;
            try
            {
                using (var version = new AndroidJavaClass("android.os.Build$VERSION"))
                {
                    _supportsEffects = version.GetStatic<int>("SDK_INT") >= 26;
                }

                using (var unityPlayer = new AndroidJavaClass("com.unity3d.player.UnityPlayer"))
                using (var activity = unityPlayer.GetStatic<AndroidJavaObject>("currentActivity"))
                using (var vibrator = activity.Call<AndroidJavaObject>("getSystemService", "vibrator"))
                {
                    if (vibrator == null) return;
                    _vibrator = AndroidJNI.NewGlobalRef(vibrator.GetRawObject());
                }

                if (!_supportsEffects) return;

                IntPtr effectClass = AndroidJNI.FindClass("android/os/VibrationEffect");
                _effectClass = AndroidJNI.NewGlobalRef(effectClass);
                AndroidJNI.DeleteLocalRef(effectClass);
                _createOneShot = AndroidJNI.GetStaticMethodID(_effectClass, "createOneShot", "(JI)Landroid/os/VibrationEffect;");
                _createWaveform = AndroidJNI.GetStaticMethodID(_effectClass, "createWaveform", "([J[II)Landroid/os/VibrationEffect;");

                IntPtr vibratorClass = AndroidJNI.GetObjectClass(_vibrator);
                _vibrateMethod = AndroidJNI.GetMethodID(vibratorClass, "vibrate", "(Landroid/os/VibrationEffect;)V");
                IntPtr hasAmp = AndroidJNI.GetMethodID(vibratorClass, "hasAmplitudeControl", "()Z");
                _hasAmplitude = AndroidJNI.CallBooleanMethod(_vibrator, hasAmp, new jvalue[0]);
                AndroidJNI.DeleteLocalRef(vibratorClass);

                _streakTimings = GlobalLongArray(new long[] { 0, 30, 60, 30, 60, 45 });
                _streakAmplitudes = GlobalIntArray(new[] { 0, 200, 0, 220, 0, 255 });
                _missTimings = GlobalLongArray(new long[] { 0, 40, 30, 60 });
                _missAmplitudes = GlobalIntArray(new[] { 0, 90, 0, 50 });
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[Haptics] init failed, falling back to Handheld.Vibrate: {e.Message}");
                _supportsEffects = false;
            }
        }

        public static void Play(HapticPattern pattern)
        {
            if (_vibrator == IntPtr.Zero) return;
            if (!_supportsEffects)
            {
                // Pre-Oreo: only a fixed-length buzz exists. Reserve it for the moments that matter.
                if (pattern == HapticPattern.Perfect || pattern == HapticPattern.StreakMilestone) Handheld.Vibrate();
                return;
            }

            switch (pattern)
            {
                case HapticPattern.Perfect: OneShot(18, 255); break;
                case HapticPattern.Clean: OneShot(10, 160); break;
                case HapticPattern.Close: OneShot(12, 80); break;
                case HapticPattern.RingSpawn: OneShot(5, 40); break;
                case HapticPattern.Miss: Waveform(_missTimings, _missAmplitudes); break;
                case HapticPattern.StreakMilestone: Waveform(_streakTimings, _streakAmplitudes); break;
            }
        }

        private static void OneShot(long ms, int amplitude)
        {
            OneShotArgs[0].j = ms;
            OneShotArgs[1].i = _hasAmplitude ? amplitude : -1; // -1 = DEFAULT_AMPLITUDE
            IntPtr effect = AndroidJNI.CallStaticObjectMethod(_effectClass, _createOneShot, OneShotArgs);
            Vibrate(effect);
        }

        private static void Waveform(IntPtr timings, IntPtr amplitudes)
        {
            WaveformArgs[0].l = timings;
            WaveformArgs[1].l = amplitudes;
            WaveformArgs[2].i = -1; // no repeat
            IntPtr effect = AndroidJNI.CallStaticObjectMethod(_effectClass, _createWaveform, WaveformArgs);
            Vibrate(effect);
        }

        private static void Vibrate(IntPtr effect)
        {
            if (effect != IntPtr.Zero)
            {
                VibrateArgs[0].l = effect;
                AndroidJNI.CallVoidMethod(_vibrator, _vibrateMethod, VibrateArgs);
                AndroidJNI.DeleteLocalRef(effect);
            }
            // A pending Java exception would poison every later JNI call on this thread.
            IntPtr pending = AndroidJNI.ExceptionOccurred();
            if (pending != IntPtr.Zero)
            {
                AndroidJNI.ExceptionClear();
                AndroidJNI.DeleteLocalRef(pending);
            }
        }

        private static IntPtr GlobalLongArray(long[] values)
        {
            IntPtr local = AndroidJNI.ToLongArray(values);
            IntPtr global = AndroidJNI.NewGlobalRef(local);
            AndroidJNI.DeleteLocalRef(local);
            return global;
        }

        private static IntPtr GlobalIntArray(int[] values)
        {
            IntPtr local = AndroidJNI.ToIntArray(values);
            IntPtr global = AndroidJNI.NewGlobalRef(local);
            AndroidJNI.DeleteLocalRef(local);
            return global;
        }

#else
        public static void Initialize()
        {
            _initialized = true;
        }

        public static void Play(HapticPattern pattern)
        {
            // Editor / desktop: no haptic hardware.
        }
#endif
    }
}
