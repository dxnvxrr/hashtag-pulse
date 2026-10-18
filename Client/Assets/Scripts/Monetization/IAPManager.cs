using System;
using System.Collections.Generic;
using System.Threading;
using Cysharp.Threading.Tasks;
using OneMoreTap.Analytics;
using OneMoreTap.Security;
using Unity.Services.Core;
using UnityEngine;
using UnityEngine.Purchasing;
using UnityEngine.Purchasing.Extension;

namespace OneMoreTap.Monetization
{
    public enum PurchaseOutcome
    {
        Granted,
        AlreadyOwned,
        Cancelled,
        Failed,
        /// <summary>Store charged the player but our server couldn't be reached; Unity IAP re-delivers on next launch.</summary>
        PendingValidation,
    }

    /// <summary>
    /// Unity IAP 4.x wrapper with server-side validation.
    ///
    /// Nothing is unlocked on the device. ProcessPurchase returns Pending and forwards the store receipt to
    /// /v1/iap/validate, where the backend checks it with the App Store Server API / Google Play Developer API and
    /// credits the wallet in one DB transaction. Only after the server confirms (or permanently rejects) do we call
    /// ConfirmPendingPurchase, so a crash or network loss mid-purchase can never lose or duplicate currency: Unity IAP
    /// re-delivers unconfirmed transactions on the next launch and the server dedupes on the store transaction id.
    /// </summary>
    public sealed class IAPManager : IDetailedStoreListener
    {
        /// <summary>Must match ProductCatalog in Backend/src/services/iap.service.ts.</summary>
        public static readonly string[] ConsumableIds =
        {
            "com.onemoretap.cores.small",
            "com.onemoretap.cores.medium",
            "com.onemoretap.cores.large",
            "com.onemoretap.bundle.streaksaver",
        };

        private readonly NetworkManager _network;
        private readonly TelemetryClient _telemetry;
        private readonly Dictionary<string, UniTaskCompletionSource<PurchaseOutcome>> _pending =
            new Dictionary<string, UniTaskCompletionSource<PurchaseOutcome>>(StringComparer.Ordinal);

        private IStoreController _controller;
        private UniTaskCompletionSource<bool> _initTcs;
        private CancellationToken _lifetime;

        public bool IsInitialized => _controller != null;
        public event Action<WalletView> WalletUpdated;

        public IAPManager(NetworkManager network, TelemetryClient telemetry)
        {
            _network = network;
            _telemetry = telemetry;
        }

        public async UniTask<bool> InitializeAsync(CancellationToken ct)
        {
            if (IsInitialized) return true;
            if (_initTcs != null) return await _initTcs.Task;
            _lifetime = ct;
            _initTcs = new UniTaskCompletionSource<bool>();

            try
            {
                if (UnityServices.State == ServicesInitializationState.Uninitialized) await UnityServices.InitializeAsync();
            }
            catch (Exception e)
            {
                Debug.LogWarning($"[IAP] Unity Services init failed: {e.Message}");
            }

            ConfigurationBuilder builder = ConfigurationBuilder.Instance(StandardPurchasingModule.Instance());
            foreach (string id in ConsumableIds) builder.AddProduct(id, ProductType.Consumable);
            UnityPurchasing.Initialize(this, builder);

            return await _initTcs.Task.AttachExternalCancellation(ct);
        }

        public Product GetProduct(string productId) => _controller?.products.WithID(productId);

        /// <summary>Localised price for store UI, e.g. "$4.99".</summary>
        public string GetLocalizedPrice(string productId) => GetProduct(productId)?.metadata.localizedPriceString ?? string.Empty;

        public async UniTask<PurchaseOutcome> PurchaseAsync(string productId, CancellationToken ct)
        {
            if (!IsInitialized) return PurchaseOutcome.Failed;
            Product product = _controller.products.WithID(productId);
            if (product == null || !product.availableToPurchase) return PurchaseOutcome.Failed;
            if (_pending.ContainsKey(productId)) return PurchaseOutcome.Failed; // one purchase per product at a time

            var tcs = new UniTaskCompletionSource<PurchaseOutcome>();
            _pending[productId] = tcs;
            _telemetry.Track(new TelemetryEvent { Category = TelemetryCategory.Transaction, Name = "iap_initiated", StrKey = "product", StrVal = productId });
            _controller.InitiatePurchase(product);
            try
            {
                return await tcs.Task.AttachExternalCancellation(ct);
            }
            finally
            {
                _pending.Remove(productId);
            }
        }

        // ------------------------------------------------------------------ IStoreListener

        public void OnInitialized(IStoreController controller, IExtensionProvider extensions)
        {
            _controller = controller;
            _initTcs?.TrySetResult(true);
            Debug.Log("[IAP] initialised");
        }

        public void OnInitializeFailed(InitializationFailureReason error) => OnInitializeFailed(error, null);

        public void OnInitializeFailed(InitializationFailureReason error, string message)
        {
            Debug.LogWarning($"[IAP] init failed: {error} {message}");
            _initTcs?.TrySetResult(false);
        }

        public PurchaseProcessingResult ProcessPurchase(PurchaseEventArgs args)
        {
            // Never grant locally. Keep the transaction open until the server has validated it.
            ValidateWithServerAsync(args.purchasedProduct).Forget();
            return PurchaseProcessingResult.Pending;
        }

        public void OnPurchaseFailed(Product product, PurchaseFailureDescription failure)
        {
            Complete(product.definition.id, failure.reason == PurchaseFailureReason.UserCancelled ? PurchaseOutcome.Cancelled : PurchaseOutcome.Failed);
            _telemetry.Track(new TelemetryEvent
            {
                Category = TelemetryCategory.Transaction, Name = "iap_failed", StrKey = "reason", StrVal = failure.reason.ToString(),
            });
        }

        public void OnPurchaseFailed(Product product, PurchaseFailureReason reason)
        {
            Complete(product.definition.id, reason == PurchaseFailureReason.UserCancelled ? PurchaseOutcome.Cancelled : PurchaseOutcome.Failed);
        }

        // ------------------------------------------------------------------ Server validation

        private async UniTaskVoid ValidateWithServerAsync(Product product)
        {
            string productId = product.definition.id;
            try
            {
                // Purchases can be re-delivered at launch before auth finishes; wait for a session.
                await UniTask.WaitUntil(() => _network.HasSession, cancellationToken: _lifetime);

                var req = new IapValidateRequest { productId = productId, receipt = product.receipt };
                IapValidateResponse res = await _network.PostAsync<IapValidateRequest, IapValidateResponse>("/v1/iap/validate", req, AuthMode.Signed, _lifetime);

                _controller.ConfirmPendingPurchase(product);
                if (res.wallet != null) WalletUpdated?.Invoke(res.wallet);
                _telemetry.Track(new TelemetryEvent
                {
                    Category = TelemetryCategory.Transaction, Name = res.granted ? "iap_granted" : "iap_duplicate", StrKey = "product", StrVal = productId,
                });
                Complete(productId, res.granted ? PurchaseOutcome.Granted : PurchaseOutcome.AlreadyOwned);
            }
            catch (ApiException e) when (e.IsClientError && e.StatusCode != 401 && e.StatusCode != 429)
            {
                // Permanently invalid (forged, refunded, wrong product, another account's receipt). Close the transaction so
                // it isn't replayed forever; nothing was granted.
                Debug.LogWarning($"[IAP] receipt rejected by server: {e.Code}");
                _controller.ConfirmPendingPurchase(product);
                _telemetry.Track(new TelemetryEvent
                {
                    Category = TelemetryCategory.Transaction, Name = "iap_rejected", StrKey = "code", StrVal = e.Code,
                });
                Complete(productId, PurchaseOutcome.Failed);
            }
            catch (OperationCanceledException)
            {
                // App shutting down: leave pending, Unity IAP re-delivers next launch.
            }
            catch (Exception e)
            {
                // Network/5xx: leave the transaction pending. The player was charged; the grant arrives on retry.
                Debug.LogWarning($"[IAP] validation deferred: {e.Message}");
                Complete(productId, PurchaseOutcome.PendingValidation);
            }
        }

        private void Complete(string productId, PurchaseOutcome outcome)
        {
            if (_pending.TryGetValue(productId, out UniTaskCompletionSource<PurchaseOutcome> tcs)) tcs.TrySetResult(outcome);
        }
    }
}
