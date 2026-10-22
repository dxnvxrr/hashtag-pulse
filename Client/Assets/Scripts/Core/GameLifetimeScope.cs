using OneMoreTap.Analytics;
using OneMoreTap.Monetization;
using OneMoreTap.Security;
using UnityEngine;
using UnityEngine.UIElements;
using VContainer;
using VContainer.Unity;

namespace OneMoreTap.Core
{
    /// <summary>
    /// Composition root for the single-scene architecture (GDD Pillar 3). Put this on one GameObject in the boot scene,
    /// assign the InputController and the UIDocument, and VContainer builds the graph and runs <see cref="Bootstrapper"/>.
    /// </summary>
    public sealed class GameLifetimeScope : LifetimeScope
    {
        [SerializeField] private ApiConfig _api = new ApiConfig();
        [SerializeField] private BootConfig _boot = new BootConfig();
        [SerializeField] private InputController _input;
        [SerializeField] private UIDocument _ui;
        [SerializeField] private GameplayController _gameplay;

        [Header("LevelPlay (only used when ONEMORETAP_LEVELPLAY is defined)")]
        [SerializeField] private string _levelPlayAppKey = "";
        [SerializeField] private string _levelPlayRewardedAdUnitId = "";

        protected override void Configure(IContainerBuilder builder)
        {
            builder.RegisterInstance(_api);
            builder.RegisterInstance(_boot);
            builder.RegisterComponent(_input);
            builder.RegisterComponent(_ui);
            builder.RegisterComponent(_gameplay);

            builder.Register<SecureStorage>(Lifetime.Singleton);
            builder.Register<NetworkManager>(Lifetime.Singleton);
            builder.Register(r => AuthManager.CreatePlatformProviders(r.Resolve<SecureStorage>()), Lifetime.Singleton);
            builder.Register<AuthManager>(Lifetime.Singleton);

            builder.Register<TelemetryClient>(Lifetime.Singleton).AsSelf().As<ITickable>();

            builder.Register<IAPManager>(Lifetime.Singleton);
#if ONEMORETAP_LEVELPLAY && !UNITY_EDITOR
            builder.RegisterInstance<IRewardedAdProvider>(new LevelPlayRewardedAdProvider(_levelPlayAppKey, _levelPlayRewardedAdUnitId));
#else
            builder.Register<IRewardedAdProvider, SimulatedRewardedAdProvider>(Lifetime.Singleton);
#endif
            builder.Register<AdManager>(Lifetime.Singleton);

            builder.RegisterEntryPoint<Bootstrapper>().AsSelf();
        }
    }
}
