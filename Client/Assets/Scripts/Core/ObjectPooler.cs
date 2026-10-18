using System;
using System.Collections.Generic;
using UnityEngine;

namespace OneMoreTap.Core
{
    /// <summary>Optional hooks for pooled components. Implemented by particles, ring visuals, verdict labels, etc.</summary>
    public interface IPoolable
    {
        void OnSpawned();
        void OnDespawned();
    }

    /// <summary>
    /// Generic fixed-capacity pool for any reference type (UI Toolkit VisualElements, plain C# objects).
    /// All storage is preallocated in the constructor; Get/Release never allocate. If the pool is exhausted
    /// and expansion is disabled, Get returns false instead of allocating mid-gameplay.
    /// </summary>
    public sealed class ObjectPool<T> where T : class
    {
        private readonly Func<T> _factory;
        private readonly Action<T> _onGet;
        private readonly Action<T> _onRelease;
        private readonly bool _allowExpand;

        private T[] _free;
        private int _freeCount;
        private T[] _active;
        private int _activeCount;
        // Maps an instance to its slot in _active for O(1) release. Reference-equality comparer: no boxing, no GetHashCode overrides.
        private readonly Dictionary<T, int> _activeIndex;

        public int CountFree => _freeCount;
        public int CountActive => _activeCount;
        public int Capacity => _free.Length;

        public ObjectPool(Func<T> factory, int capacity, Action<T> onGet = null, Action<T> onRelease = null, bool allowExpand = false)
        {
            if (factory == null) throw new ArgumentNullException(nameof(factory));
            if (capacity <= 0) throw new ArgumentOutOfRangeException(nameof(capacity));
            _factory = factory;
            _onGet = onGet;
            _onRelease = onRelease;
            _allowExpand = allowExpand;
            _free = new T[capacity];
            _active = new T[capacity];
            _activeIndex = new Dictionary<T, int>(capacity, ReferenceEqualityComparer.Instance);
        }

        /// <summary>Instantiate everything up front — call during boot/loading, never during play.</summary>
        public void Prewarm()
        {
            while (_freeCount + _activeCount < _free.Length)
            {
                T item = _factory();
                _onRelease?.Invoke(item);
                _free[_freeCount++] = item;
            }
        }

        public bool TryGet(out T item)
        {
            if (_freeCount == 0)
            {
                if (!_allowExpand)
                {
                    item = null;
                    return false;
                }
                Grow();
                _free[_freeCount++] = _factory();
            }

            item = _free[--_freeCount];
            _free[_freeCount] = null;
            _active[_activeCount] = item;
            _activeIndex[item] = _activeCount;
            _activeCount++;
            _onGet?.Invoke(item);
            return true;
        }

        public void Release(T item)
        {
            if (item == null) return;
            if (!_activeIndex.TryGetValue(item, out int slot)) return; // double release or foreign object: ignore

            // Swap-remove from the active list.
            int last = --_activeCount;
            T moved = _active[last];
            _active[slot] = moved;
            _active[last] = null;
            if (!ReferenceEquals(moved, item)) _activeIndex[moved] = slot;
            _activeIndex.Remove(item);

            _onRelease?.Invoke(item);
            _free[_freeCount++] = item;
        }

        /// <summary>Returns every active item to the pool (end of run, scene reset).</summary>
        public void ReleaseAll()
        {
            while (_activeCount > 0) Release(_active[_activeCount - 1]);
        }

        private void Grow()
        {
            // Only reachable when allowExpand is true. Allocates — log it so capacity can be tuned.
            int newSize = _free.Length * 2;
            Debug.LogWarning($"[ObjectPool<{typeof(T).Name}>] expanding {_free.Length} -> {newSize}; raise prewarm capacity.");
            Array.Resize(ref _free, newSize);
            Array.Resize(ref _active, newSize);
        }

        private sealed class ReferenceEqualityComparer : IEqualityComparer<T>
        {
            public static readonly ReferenceEqualityComparer Instance = new ReferenceEqualityComparer();
            public bool Equals(T x, T y) => ReferenceEquals(x, y);
            public int GetHashCode(T obj) => System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(obj);
        }
    }

    /// <summary>
    /// Component pool for prefabs (particle bursts, ring visuals, gameplay entities). Pooled objects are parented under
    /// a single inactive-safe root, toggled with SetActive, and their IPoolable hooks are cached at creation time so
    /// spawning never calls GetComponent.
    /// </summary>
    public sealed class ObjectPooler<T> where T : Component
    {
        private readonly ObjectPool<T> _pool;
        private readonly Dictionary<T, IPoolable> _hooks;
        private readonly Transform _root;

        public int CountActive => _pool.CountActive;
        public int CountFree => _pool.CountFree;

        public ObjectPooler(T prefab, int capacity, Transform root, bool allowExpand = false)
        {
            if (prefab == null) throw new ArgumentNullException(nameof(prefab));
            _root = root;
            _hooks = new Dictionary<T, IPoolable>(capacity);
            _pool = new ObjectPool<T>(
                () =>
                {
                    T instance = UnityEngine.Object.Instantiate(prefab, _root);
                    instance.gameObject.SetActive(false);
                    IPoolable hook = instance.GetComponent<IPoolable>();
                    if (hook != null) _hooks[instance] = hook;
                    return instance;
                },
                capacity,
                OnGet,
                OnRelease,
                allowExpand);
        }

        public void Prewarm() => _pool.Prewarm();

        public bool TrySpawn(Vector3 position, Quaternion rotation, out T instance)
        {
            if (!_pool.TryGet(out instance)) return false;
            Transform t = instance.transform;
            t.SetPositionAndRotation(position, rotation);
            instance.gameObject.SetActive(true);
            if (_hooks.TryGetValue(instance, out IPoolable hook)) hook.OnSpawned();
            return true;
        }

        public void Despawn(T instance) => _pool.Release(instance);

        public void DespawnAll() => _pool.ReleaseAll();

        private static void OnGet(T instance)
        {
            // Activation happens in TrySpawn after the transform is positioned, avoiding a one-frame flash at the old position.
        }

        private void OnRelease(T instance)
        {
            if (instance == null) return;
            if (_hooks.TryGetValue(instance, out IPoolable hook)) hook.OnDespawned();
            instance.gameObject.SetActive(false);
        }
    }
}
