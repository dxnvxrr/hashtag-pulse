namespace OneMoreTap.Core
{
    public enum RingArchetype : byte
    {
        Standard = 0,
        Drifter = 1,
    }

    public struct RingParams
    {
        public int DurationMs;
        /// <summary>Gap between the previous ring resolving and this ring spawning (0 for ring 0).</summary>
        public int GapMs;
        public RingArchetype Archetype;
        /// <summary>-1 left, 0 none, +1 right (visual only).</summary>
        public sbyte Drift;
    }

    /// <summary>
    /// mulberry32 PRNG. MUST stay bit-identical to Backend/src/services/ringSchedule.ts — the server
    /// re-simulates every run from the same seed, so any divergence turns honest runs into rejected ones.
    /// </summary>
    public struct Mulberry32
    {
        private uint _state;

        public Mulberry32(uint seed)
        {
            _state = seed;
        }

        public uint NextUint()
        {
            unchecked
            {
                _state += 0x6D2B79F5u;
                uint t = _state;
                t = (t ^ (t >> 15)) * (t | 1u);
                t ^= t + (t ^ (t >> 7)) * (t | 61u);
                return t ^ (t >> 14);
            }
        }

        /// <summary>Inclusive range. Draws exactly one value.</summary>
        public int NextRange(int min, int maxInclusive)
        {
            uint span = (uint)(maxInclusive - min + 1);
            return min + (int)(NextUint() % span);
        }
    }

    /// <summary>
    /// Deterministic, allocation-free ring generator. Call <see cref="Next"/> once per ring, in order.
    /// Integer milliseconds only, so C# and JavaScript cannot diverge on floating-point rounding.
    /// </summary>
    public struct RingSchedule
    {
        public const int MinDurationMs = 800;
        public const int MaxDurationMs = 2500;
        public const int DecayPerRingMs = 12;
        public const int DecayCapRings = 40;
        public const int JitterMs = 150;
        public const int GapMinMs = 300;
        public const int GapMaxMs = 550;
        public const int StandardOnlyRings = 5;

        private Mulberry32 _rng;
        private readonly int _baseDurationMs;
        private int _index;

        public RingSchedule(uint seed, int baseDurationMs)
        {
            _rng = new Mulberry32(seed);
            _baseDurationMs = baseDurationMs;
            _index = 0;
        }

        public int NextIndex => _index;

        public RingParams Next()
        {
            // Always draw exactly four values per ring, in this order, regardless of branch.
            int jitter = _rng.NextRange(-JitterMs, JitterMs);
            int gap = _rng.NextRange(GapMinMs, GapMaxMs);
            uint archetypeRoll = _rng.NextUint() % 4u;
            uint driftRoll = _rng.NextUint() % 2u;

            int decay = (_index < DecayCapRings ? _index : DecayCapRings) * DecayPerRingMs;
            int duration = _baseDurationMs - decay + jitter;
            if (duration < MinDurationMs) duration = MinDurationMs;
            if (duration > MaxDurationMs) duration = MaxDurationMs;

            RingArchetype archetype = _index >= StandardOnlyRings && archetypeRoll == 0u ? RingArchetype.Drifter : RingArchetype.Standard;
            sbyte drift = archetype == RingArchetype.Drifter ? (driftRoll == 0u ? (sbyte)-1 : (sbyte)1) : (sbyte)0;

            var ring = new RingParams
            {
                DurationMs = duration,
                GapMs = _index == 0 ? 0 : gap,
                Archetype = archetype,
                Drift = drift,
            };
            _index++;
            return ring;
        }

        /// <summary>Base ring duration from precision rating (0–3000). Mirrors baseDurationForRating on the server.</summary>
        public static int BaseDurationForRating(int rating)
        {
            if (rating < 0) rating = 0;
            if (rating > 3000) rating = 3000;
            return 2500 - (rating * 1200) / 3000;
        }
    }

    public enum Verdict : byte
    {
        Perfect,
        Clean,
        Close,
        Miss,
    }

    public static class VerdictRules
    {
        public const int PerfectUs = 5000;
        public const int CleanUs = 15000;
        public const int CloseUs = 40000;
        public const int FtueCloseUs = 60000;

        /// <summary>Client-side prediction for instant juice. The server's verdict is authoritative.</summary>
        public static Verdict Classify(long absDeltaUs, bool ftueFirstRing)
        {
            if (absDeltaUs <= PerfectUs) return Verdict.Perfect;
            if (absDeltaUs <= CleanUs) return Verdict.Clean;
            if (absDeltaUs <= (ftueFirstRing ? FtueCloseUs : CloseUs)) return Verdict.Close;
            return Verdict.Miss;
        }
    }
}
