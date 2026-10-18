using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Threading;
using Cysharp.Threading.Tasks;
using UnityEngine;

namespace OneMoreTap.Security
{
    /// <summary>
    /// AES-256 encrypted key/value store for sensitive persistent values (refresh token, linked-account ids,
    /// local ad cool-downs, COPPA answer).
    ///
    /// Format: [version:1][iv:16][AES-256-CBC ciphertext][HMAC-SHA256:32] — encrypt-then-MAC, verified in
    /// constant time before decryption. (AES-GCM is not available on Unity's .NET Standard 2.1 profile.)
    ///
    /// Threat model, stated honestly: the key is derived (PBKDF2-SHA256) from device-bound inputs plus a random
    /// per-install salt, so the file is useless when copied to another device and can't be edited in place
    /// without detection. It does NOT stop an attacker with root + a debugger on their own device — nothing
    /// client-side can. That is why every currency and score value is server-authoritative; this store only
    /// guards secrets and convenience state.
    /// </summary>
    public sealed class SecureStorage
    {
        private const string FileName = "omt.secure";
        private const string SaltPrefKey = "omt.ss.salt";
        private const byte FormatVersion = 1;
        private const int Pbkdf2Iterations = 20000;
        private const int IvSize = 16;
        private const int MacSize = 32;

        private readonly Dictionary<string, string> _values = new Dictionary<string, string>(32, StringComparer.Ordinal);
        private byte[] _encKey;
        private byte[] _macKey;
        private string _path;
        private bool _dirty;
        private int _saveGeneration;

        public bool IsLoaded { get; private set; }

        /// <summary>Raised when the file failed authentication and was reset. Server state remains the source of truth.</summary>
        public event Action TamperDetected;

        public async UniTask LoadAsync(CancellationToken ct)
        {
            if (IsLoaded) return;

            // Unity APIs must be read on the main thread; the expensive KDF + file I/O run on the thread pool.
            string password = SystemInfo.deviceUniqueIdentifier + "|" + Application.identifier;
            byte[] salt = GetOrCreateSalt();
            _path = Path.Combine(Application.persistentDataPath, FileName);
            string path = _path;

            LoadResult result = await UniTask.RunOnThreadPool(() => LoadOffThread(password, salt, path), cancellationToken: ct);

            _encKey = result.EncKey;
            _macKey = result.MacKey;
            _values.Clear();
            if (result.Values != null)
            {
                foreach (KeyValuePair<string, string> kv in result.Values) _values[kv.Key] = kv.Value;
            }
            IsLoaded = true;

            if (result.Tampered)
            {
                Debug.LogWarning("[SecureStorage] integrity check failed; local secure store reset.");
                TamperDetected?.Invoke();
                _dirty = true;
                await SaveAsync(ct);
            }
        }

        // ------------------------------------------------------------------ Accessors

        public bool HasKey(string key) => _values.ContainsKey(key);

        public string GetString(string key, string fallback = null)
        {
            EnsureLoaded();
            return _values.TryGetValue(key, out string v) ? v : fallback;
        }

        public void SetString(string key, string value)
        {
            EnsureLoaded();
            if (value == null)
            {
                Delete(key);
                return;
            }
            if (_values.TryGetValue(key, out string existing) && existing == value) return;
            _values[key] = value;
            _dirty = true;
        }

        public long GetLong(string key, long fallback = 0)
        {
            string s = GetString(key);
            return s != null && long.TryParse(s, NumberStyles.Integer, CultureInfo.InvariantCulture, out long v) ? v : fallback;
        }

        public void SetLong(string key, long value) => SetString(key, value.ToString(CultureInfo.InvariantCulture));

        public bool GetBool(string key, bool fallback = false)
        {
            string s = GetString(key);
            return s == null ? fallback : s == "1";
        }

        public void SetBool(string key, bool value) => SetString(key, value ? "1" : "0");

        public void Delete(string key)
        {
            EnsureLoaded();
            if (_values.Remove(key)) _dirty = true;
        }

        /// <summary>Wipes everything (account deletion / sign-out).</summary>
        public void Clear()
        {
            EnsureLoaded();
            _values.Clear();
            _dirty = true;
        }

        // ------------------------------------------------------------------ Persistence

        /// <summary>Encrypts and atomically writes the store off the main thread. No-op when nothing changed.</summary>
        public async UniTask SaveAsync(CancellationToken ct = default)
        {
            if (!IsLoaded || !_dirty) return;
            _dirty = false;
            int generation = ++_saveGeneration;
            byte[] plaintext = Serialize(_values);
            byte[] enc = _encKey, mac = _macKey;
            string path = _path;
            await UniTask.RunOnThreadPool(() =>
            {
                // A newer save superseded this one while it was queued; skip the stale write.
                if (generation != Volatile.Read(ref _saveGeneration)) return;
                WriteAtomic(path, Encrypt(plaintext, enc, mac));
            }, cancellationToken: ct);
        }

        /// <summary>Synchronous save for OnApplicationPause/Quit, where the process may be killed right after.</summary>
        public void SaveImmediate()
        {
            if (!IsLoaded || !_dirty) return;
            _dirty = false;
            ++_saveGeneration;
            WriteAtomic(_path, Encrypt(Serialize(_values), _encKey, _macKey));
        }

        private void EnsureLoaded()
        {
            if (!IsLoaded) throw new InvalidOperationException("SecureStorage.LoadAsync must complete before use.");
        }

        // ------------------------------------------------------------------ Crypto (thread-pool safe, no Unity APIs)

        private struct LoadResult
        {
            public byte[] EncKey;
            public byte[] MacKey;
            public Dictionary<string, string> Values;
            public bool Tampered;
        }

        private static LoadResult LoadOffThread(string password, byte[] salt, string path)
        {
            var result = new LoadResult();
            using (var kdf = new Rfc2898DeriveBytes(password, salt, Pbkdf2Iterations, HashAlgorithmName.SHA256))
            {
                result.EncKey = kdf.GetBytes(32);
                result.MacKey = kdf.GetBytes(32);
            }

            if (!File.Exists(path)) return result;

            try
            {
                byte[] blob = File.ReadAllBytes(path);
                byte[] plaintext = Decrypt(blob, result.EncKey, result.MacKey);
                if (plaintext == null)
                {
                    result.Tampered = true;
                    return result;
                }
                result.Values = Deserialize(plaintext);
            }
            catch (Exception)
            {
                result.Tampered = true;
                result.Values = null;
            }
            return result;
        }

        private static byte[] Encrypt(byte[] plaintext, byte[] encKey, byte[] macKey)
        {
            byte[] iv = new byte[IvSize];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(iv);

            byte[] cipher;
            using (Aes aes = Aes.Create())
            {
                aes.KeySize = 256;
                aes.Mode = CipherMode.CBC;
                aes.Padding = PaddingMode.PKCS7;
                aes.Key = encKey;
                aes.IV = iv;
                using (ICryptoTransform enc = aes.CreateEncryptor())
                {
                    cipher = enc.TransformFinalBlock(plaintext, 0, plaintext.Length);
                }
            }

            byte[] blob = new byte[1 + IvSize + cipher.Length + MacSize];
            blob[0] = FormatVersion;
            Buffer.BlockCopy(iv, 0, blob, 1, IvSize);
            Buffer.BlockCopy(cipher, 0, blob, 1 + IvSize, cipher.Length);
            using (var hmac = new HMACSHA256(macKey))
            {
                byte[] tag = hmac.ComputeHash(blob, 0, 1 + IvSize + cipher.Length);
                Buffer.BlockCopy(tag, 0, blob, 1 + IvSize + cipher.Length, MacSize);
            }
            Array.Clear(plaintext, 0, plaintext.Length);
            return blob;
        }

        /// <summary>Returns null when the version or MAC is wrong.</summary>
        private static byte[] Decrypt(byte[] blob, byte[] encKey, byte[] macKey)
        {
            if (blob.Length < 1 + IvSize + 16 + MacSize || blob[0] != FormatVersion) return null;
            int cipherLen = blob.Length - 1 - IvSize - MacSize;

            byte[] expected;
            using (var hmac = new HMACSHA256(macKey))
            {
                expected = hmac.ComputeHash(blob, 0, 1 + IvSize + cipherLen);
            }
            if (!ConstantTimeEquals(expected, 0, blob, 1 + IvSize + cipherLen, MacSize)) return null;

            byte[] iv = new byte[IvSize];
            Buffer.BlockCopy(blob, 1, iv, 0, IvSize);
            using (Aes aes = Aes.Create())
            {
                aes.KeySize = 256;
                aes.Mode = CipherMode.CBC;
                aes.Padding = PaddingMode.PKCS7;
                aes.Key = encKey;
                aes.IV = iv;
                using (ICryptoTransform dec = aes.CreateDecryptor())
                {
                    return dec.TransformFinalBlock(blob, 1 + IvSize, cipherLen);
                }
            }
        }

        private static bool ConstantTimeEquals(byte[] a, int aOffset, byte[] b, int bOffset, int length)
        {
            int diff = 0;
            for (int i = 0; i < length; i++) diff |= a[aOffset + i] ^ b[bOffset + i];
            return diff == 0;
        }

        private static byte[] Serialize(Dictionary<string, string> values)
        {
            using (var ms = new MemoryStream(256))
            using (var w = new BinaryWriter(ms))
            {
                w.Write(values.Count);
                foreach (KeyValuePair<string, string> kv in values)
                {
                    w.Write(kv.Key);
                    w.Write(kv.Value);
                }
                w.Flush();
                return ms.ToArray();
            }
        }

        private static Dictionary<string, string> Deserialize(byte[] data)
        {
            using (var ms = new MemoryStream(data))
            using (var r = new BinaryReader(ms))
            {
                int count = r.ReadInt32();
                if (count < 0 || count > 10000) throw new InvalidDataException("bad entry count");
                var values = new Dictionary<string, string>(count, StringComparer.Ordinal);
                for (int i = 0; i < count; i++) values[r.ReadString()] = r.ReadString();
                return values;
            }
        }

        private static void WriteAtomic(string path, byte[] data)
        {
            string tmp = path + ".tmp";
            File.WriteAllBytes(tmp, data);
            if (File.Exists(path)) File.Replace(tmp, path, null);
            else File.Move(tmp, path);
        }

        private static byte[] GetOrCreateSalt()
        {
            string existing = PlayerPrefs.GetString(SaltPrefKey, null);
            if (!string.IsNullOrEmpty(existing))
            {
                try
                {
                    byte[] decoded = Convert.FromBase64String(existing);
                    if (decoded.Length == 16) return decoded;
                }
                catch (FormatException)
                {
                    // fall through and regenerate
                }
            }
            byte[] salt = new byte[16];
            using (var rng = RandomNumberGenerator.Create()) rng.GetBytes(salt);
            PlayerPrefs.SetString(SaltPrefKey, Convert.ToBase64String(salt));
            PlayerPrefs.Save();
            return salt;
        }
    }

    /// <summary>
    /// Memory-obfuscated long for values displayed or used locally (cached balances, rating, streak). Defeats
    /// "search for the number, change it" memory scanners (GameGuardian, Cheat Engine). Zero allocation.
    /// The server still owns the real values; a tamper here only fires <see cref="TamperDetected"/> for telemetry.
    /// </summary>
    public struct ObscuredLong
    {
        public static event Action TamperDetected;

        private static ulong _seed = (ulong)DateTime.UtcNow.Ticks | 1UL;

        private long _key;
        private long _encrypted;
        private long _check;

        public ObscuredLong(long value)
        {
            _key = NextKey();
            _encrypted = value ^ _key;
            _check = Checksum(value, _key);
        }

        public long Value
        {
            get
            {
                if (_key == 0) return 0; // default(ObscuredLong)
                long v = _encrypted ^ _key;
                if (Checksum(v, _key) != _check) TamperDetected?.Invoke();
                return v;
            }
            set
            {
                _key = NextKey();
                _encrypted = value ^ _key;
                _check = Checksum(value, _key);
            }
        }

        public static implicit operator long(ObscuredLong o) => o.Value;
        public static implicit operator ObscuredLong(long v) => new ObscuredLong(v);

        private static long Checksum(long value, long key)
        {
            unchecked
            {
                ulong x = (ulong)(value * 0x5DEECE66DL) ^ (ulong)key;
                x ^= x >> 29;
                return (long)(x * 0xBF58476D1CE4E5B9UL);
            }
        }

        private static long NextKey()
        {
            // xorshift64*: cheap, non-cryptographic — only needs to be unpredictable to a memory scanner.
            unchecked
            {
                ulong x = _seed;
                x ^= x >> 12;
                x ^= x << 25;
                x ^= x >> 27;
                _seed = x;
                long k = (long)(x * 0x2545F4914F6CDD1DUL);
                return k == 0 ? 1 : k;
            }
        }
    }
}
