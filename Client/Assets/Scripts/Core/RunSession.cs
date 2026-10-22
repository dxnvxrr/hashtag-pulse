using System;
using System.Collections.Generic;

namespace OneMoreTap.Core
{
    public struct RingState
    {
        public int Index;
        public RingArchetype Archetype;
        public sbyte Drift;
        public bool SlowMo;
        /// <summary>All times are microseconds after ring 0's spawn — the exact integers the server re-simulates.</summary>
        public long SpawnUs;
        public long CloseUs;
        public long DeadlineUs;
        public int CloseWindowMs;
    }

    public struct RingResult
    {
        public int Index;
        public Verdict Verdict;
        public bool Tapped;
        public long DeltaUs;
        public int Streak;
        public bool StreakMilestone;
    }

    [Serializable]
    public struct ResumePoint
    {
        public int afterRing;
        public long atUs;
    }

    /// <summary>
    /// Engine-agnostic run state machine (no UnityEngine dependency, so it compiles and tests outside Unity).
    /// Implements the same timeline rule the server re-simulates in evaluateRun:
    ///   ring i+1 spawns gap ms after ring i resolves (tap, or close window expiry), or at a rewarded-ad resume point.
    /// Slow-Mo stretches a ring 2.5x and must be armed before the ring spawns.
    /// All per-ring storage is preallocated; Tap/Advance do not allocate.
    /// </summary>
    public sealed class RunSession
    {
        public const int SlowMoNumerator = 5;   // 2.5x = 5/2, integer-exact
        public const int SlowMoDenominator = 2;
        public const int HumanReactionFloorUs = 80_000;

        private readonly long[] _taps;
        private readonly Verdict[] _verdicts;
        private readonly List<int> _slowMoRings;
        private readonly List<ResumePoint> _resumes;
        private RingSchedule _schedule;
        private RingState _current;
        private bool _hasCurrent;
        private bool _armed;

        public bool Ftue { get; }
        public int MaxRings { get; }
        public int MaxMisses { get; private set; }
        public int SlowMoTickets { get; }
        public int RingsResolved { get; private set; }
        public int Misses { get; private set; }
        public int Streak { get; private set; }
        public int BestStreak { get; private set; }
        public long BestAbsDeltaUs { get; private set; } = -1;
        public bool IsOver { get; private set; }
        /// <summary>True when the last miss used up the lives and no continue has been granted yet.</summary>
        public bool AwaitingContinue { get; private set; }
        public bool SlowMoArmed => _armed;
        public int SlowMoAvailable => SlowMoTickets - _slowMoRings.Count - (_armed ? 1 : 0);
        public RingState Current => _current;
        public bool HasCurrent => _hasCurrent;

        private long _lastResolveUs;

        public RunSession(uint seed, int baseDurationMs, bool ftue, int maxRings, int maxMisses, int slowMoTickets)
        {
            Ftue = ftue;
            MaxRings = maxRings;
            MaxMisses = maxMisses;
            SlowMoTickets = slowMoTickets;
            _schedule = new RingSchedule(seed, baseDurationMs);
            _taps = new long[maxRings];
            _verdicts = new Verdict[maxRings];
            _slowMoRings = new List<int>(Math.Min(maxRings, 64));
            _resumes = new List<ResumePoint>(4);
            SpawnNext(0, -1);
        }

        /// <summary>Arms (or disarms) a Slow-Mo Ticket. If the next ring hasn't spawned yet it applies to that ring.</summary>
        public bool ToggleSlowMo(long nowUs)
        {
            if (IsOver) return false;
            if (_armed)
            {
                _armed = false;
                return true;
            }
            if (SlowMoAvailable <= 0) return false;
            if (_hasCurrent && nowUs < _current.SpawnUs && !_current.SlowMo)
            {
                long durationUs = _current.CloseUs - _current.SpawnUs;
                _current.SlowMo = true;
                _current.CloseUs = _current.SpawnUs + durationUs * SlowMoNumerator / SlowMoDenominator;
                _current.DeadlineUs = _current.CloseUs + WindowRealUs(_current.CloseWindowMs, true);
                _slowMoRings.Add(_current.Index);
                return true;
            }
            _armed = true;
            return true;
        }

        /// <summary>Handles a tap at `tapUs`. Returns true and fills `result` when the tap resolved the current ring.</summary>
        public bool Tap(long tapUs, out RingResult result)
        {
            result = default;
            if (IsOver || AwaitingContinue || !_hasCurrent) return false;
            // Before spawn (in the gap) or within the human reaction floor: ignore, like the server's anti-mash rule.
            if (tapUs < _current.SpawnUs + HumanReactionFloorUs) return false;
            if (tapUs > _current.DeadlineUs)
            {
                result = Resolve(-1);
                return true;
            }
            result = Resolve(tapUs);
            return true;
        }

        /// <summary>Call every frame. Resolves the current ring as a miss once its window has passed.</summary>
        public bool Advance(long nowUs, out RingResult result)
        {
            result = default;
            if (IsOver || AwaitingContinue || !_hasCurrent) return false;
            if (nowUs <= _current.DeadlineUs) return false;
            result = Resolve(-1);
            return true;
        }

        /// <summary>A server-verified rewarded ad granted one more life; play resumes at `resumeAtUs`.</summary>
        public void Continue(long resumeAtUs)
        {
            if (!AwaitingContinue) return;
            AwaitingContinue = false;
            MaxMisses++;
            long at = Math.Max(resumeAtUs, _lastResolveUs);
            _resumes.Add(new ResumePoint { afterRing = RingsResolved - 1, atUs = at });
            SpawnNext(_lastResolveUs, at);
        }

        public void End()
        {
            IsOver = true;
            AwaitingContinue = false;
            _hasCurrent = false;
        }

        // ------------------------------------------------------------------ Submission payload

        public long[] CopyTaps()
        {
            var copy = new long[RingsResolved];
            Array.Copy(_taps, copy, RingsResolved);
            return copy;
        }

        public int[] CopySlowMoRings()
        {
            var list = new List<int>(_slowMoRings.Count);
            foreach (int r in _slowMoRings) if (r < RingsResolved) list.Add(r); // a ticket on an unplayed ring isn't spent
            return list.ToArray();
        }

        public ResumePoint[] CopyResumes() => _resumes.ToArray();

        public Verdict VerdictAt(int index) => _verdicts[index];

        // ------------------------------------------------------------------ Internals

        /// <summary>Real time → game time on a Slow-Mo ring (x2/5, truncated toward zero like the server's Math.trunc).</summary>
        public static long ToGameTimeUs(long realDeltaUs, bool slow) => slow ? realDeltaUs * SlowMoDenominator / SlowMoNumerator : realDeltaUs;

        /// <summary>Real-time length of a close window.</summary>
        public static long WindowRealUs(int windowMs, bool slow) => slow ? windowMs * 1000L * SlowMoNumerator / SlowMoDenominator : windowMs * 1000L;

        private RingResult Resolve(long tapUs)
        {
            int i = _current.Index;
            Verdict verdict;
            long delta = 0;
            if (tapUs < 0)
            {
                verdict = Verdict.Miss;
                _taps[i] = -1;
                _lastResolveUs = _current.DeadlineUs;
            }
            else
            {
                // Slow-Mo rings are scored in game time (0.4x), so every window is 2.5x wider in real time.
                delta = ToGameTimeUs(tapUs - _current.CloseUs, _current.SlowMo);
                long abs = delta < 0 ? -delta : delta;
                verdict = VerdictRules.Classify(abs, Ftue && i == 0);
                _taps[i] = tapUs;
                _lastResolveUs = tapUs;
                // Best tap is a skill record: a purchasable Slow-Mo ring never counts toward it.
                if (!_current.SlowMo && (BestAbsDeltaUs < 0 || abs < BestAbsDeltaUs)) BestAbsDeltaUs = abs;
            }
            _verdicts[i] = verdict;
            RingsResolved = i + 1;

            bool milestone = false;
            if (verdict == Verdict.Miss)
            {
                Misses++;
                Streak = 0;
            }
            else
            {
                Streak++;
                if (Streak > BestStreak) BestStreak = Streak;
                milestone = Streak == 10 || Streak == 25 || Streak == 50 || Streak == 100;
            }

            _hasCurrent = false;
            if (Misses >= MaxMisses) AwaitingContinue = true;
            else if (RingsResolved >= MaxRings) IsOver = true;
            else SpawnNext(_lastResolveUs, -1);

            return new RingResult { Index = i, Verdict = verdict, Tapped = tapUs >= 0, DeltaUs = delta, Streak = Streak, StreakMilestone = milestone };
        }

        private void SpawnNext(long resolveUs, long resumeAtUs)
        {
            RingParams p = _schedule.Next();
            int index = _schedule.NextIndex - 1;
            long spawnUs = index == 0 ? 0 : resolveUs + p.GapMs * 1000L;
            if (resumeAtUs >= 0 && resumeAtUs > spawnUs) spawnUs = resumeAtUs;

            bool slow = _armed;
            if (slow)
            {
                _armed = false;
                _slowMoRings.Add(index);
            }
            long durationUs = slow ? (long)p.DurationMs * 1000L * SlowMoNumerator / SlowMoDenominator : p.DurationMs * 1000L;
            int windowMs = Ftue && index == 0 ? VerdictRules.FtueCloseUs / 1000 : VerdictRules.CloseUs / 1000;

            _current = new RingState
            {
                Index = index,
                Archetype = p.Archetype,
                Drift = p.Drift,
                SlowMo = slow,
                SpawnUs = spawnUs,
                CloseUs = spawnUs + durationUs,
                DeadlineUs = spawnUs + durationUs + WindowRealUs(windowMs, slow),
                CloseWindowMs = windowMs,
            };
            _hasCurrent = true;
        }
    }
}
