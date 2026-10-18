import { SignJWT, decodeJwt, importPKCS8 } from 'jose';
import { Prisma, type Store } from '@prisma/client';
import { config } from '../config.js';
import { prisma } from '../lib/prisma.js';
import { redis, RedisKeys } from '../lib/redis.js';
import { Errors } from '../lib/errors.js';
import { audit } from '../lib/audit.js';
import { applyLedgerEntries, toWalletView, type LedgerEntry, type WalletView } from './wallet.service.js';

/** Server-side catalog. The client never tells the server what a product is worth. */
export const ProductCatalog: Record<string, { grants: Array<{ currency: LedgerEntry['currency']; amount: bigint }> }> = {
  'com.onemoretap.cores.small': { grants: [{ currency: 'CORES', amount: 100n }] },
  'com.onemoretap.cores.medium': { grants: [{ currency: 'CORES', amount: 550n }] },
  'com.onemoretap.cores.large': { grants: [{ currency: 'CORES', amount: 1200n }] },
  'com.onemoretap.bundle.streaksaver': {
    grants: [
      { currency: 'ANCHORS', amount: 1n },
      { currency: 'SLOWMO_TICKETS', amount: 5n },
    ],
  },
};

/** Unity IAP's unified receipt envelope. */
interface UnityReceipt {
  Store: string;
  TransactionID: string;
  Payload: string;
}

interface VerifiedPurchase {
  store: Store;
  productId: string;
  storeTransactionId: string;
  environment: string;
  payload: Prisma.InputJsonValue;
}

function parseUnityReceipt(raw: string): UnityReceipt {
  try {
    const r = JSON.parse(raw) as Partial<UnityReceipt>;
    if (typeof r.Store !== 'string' || typeof r.TransactionID !== 'string' || typeof r.Payload !== 'string') throw new Error();
    return r as UnityReceipt;
  } catch {
    throw Errors.badRequest('bad_receipt', 'Malformed Unity IAP receipt');
  }
}

// ------------------------------------------------------------------ App Store Server API

async function appStoreBearer(): Promise<string> {
  if (!config.APPSTORE_ISSUER_ID || !config.APPSTORE_KEY_ID || !config.APPSTORE_PRIVATE_KEY || !config.APPLE_BUNDLE_ID) {
    throw Errors.unavailable('appstore_not_configured', 'App Store validation not configured');
  }
  const key = await importPKCS8(config.APPSTORE_PRIVATE_KEY, 'ES256');
  return new SignJWT({ bid: config.APPLE_BUNDLE_ID })
    .setProtectedHeader({ alg: 'ES256', kid: config.APPSTORE_KEY_ID, typ: 'JWT' })
    .setIssuer(config.APPSTORE_ISSUER_ID)
    .setIssuedAt()
    .setExpirationTime('5m')
    .setAudience('appstoreconnect-v1')
    .sign(key);
}

async function fetchAppStoreTransaction(transactionId: string, environment: 'sandbox' | 'production'): Promise<Response> {
  const host = environment === 'production' ? 'https://api.storekit.itunes.apple.com' : 'https://api.storekit-sandbox.itunes.apple.com';
  return fetch(`${host}/inApps/v1/transactions/${encodeURIComponent(transactionId)}`, {
    headers: { authorization: `Bearer ${await appStoreBearer()}` },
    signal: AbortSignal.timeout(8_000),
  });
}

/**
 * Looks the transaction up directly with Apple (authenticated, over TLS). Because the data comes straight
 * from Apple's API rather than from the client, decoding the signedTransactionInfo payload is sufficient.
 * TestFlight/sandbox receipts are retried against the sandbox host, per Apple's guidance.
 */
async function verifyAppStore(receipt: UnityReceipt, expectedProductId: string): Promise<VerifiedPurchase> {
  let env: 'sandbox' | 'production' = config.APPSTORE_ENVIRONMENT;
  let res = await fetchAppStoreTransaction(receipt.TransactionID, env);
  if (res.status === 404 && env === 'production') {
    env = 'sandbox';
    res = await fetchAppStoreTransaction(receipt.TransactionID, env);
  }
  if (!res.ok) throw Errors.badRequest('appstore_rejected', `App Store lookup failed (${res.status})`);

  const body = (await res.json()) as { signedTransactionInfo?: string };
  if (!body.signedTransactionInfo) throw Errors.badRequest('appstore_rejected', 'No transaction info');
  const tx = decodeJwt(body.signedTransactionInfo) as {
    bundleId?: string;
    productId?: string;
    transactionId?: string;
    revocationDate?: number;
    environment?: string;
  };

  if (tx.bundleId !== config.APPLE_BUNDLE_ID) throw Errors.badRequest('bundle_mismatch', 'Receipt is for another app');
  if (tx.productId !== expectedProductId) throw Errors.badRequest('product_mismatch', 'Receipt is for another product');
  if (tx.revocationDate) throw Errors.badRequest('purchase_revoked', 'Purchase was refunded/revoked');
  if (!tx.transactionId) throw Errors.badRequest('appstore_rejected', 'Missing transactionId');

  return {
    store: 'APP_STORE',
    productId: tx.productId,
    storeTransactionId: tx.transactionId,
    environment: tx.environment ?? env,
    payload: tx as Prisma.InputJsonValue,
  };
}

// ------------------------------------------------------------------ Google Play Developer API

async function googlePlayAccessToken(): Promise<string> {
  const cached = await redis.get(RedisKeys.googleAccessToken());
  if (cached) return cached;
  if (!config.GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL || !config.GOOGLE_PLAY_SERVICE_ACCOUNT_KEY || !config.GOOGLE_PLAY_PACKAGE_NAME) {
    throw Errors.unavailable('googleplay_not_configured', 'Google Play validation not configured');
  }
  const key = await importPKCS8(config.GOOGLE_PLAY_SERVICE_ACCOUNT_KEY, 'RS256');
  const assertion = await new SignJWT({ scope: 'https://www.googleapis.com/auth/androidpublisher' })
    .setProtectedHeader({ alg: 'RS256', typ: 'JWT' })
    .setIssuer(config.GOOGLE_PLAY_SERVICE_ACCOUNT_EMAIL)
    .setAudience('https://oauth2.googleapis.com/token')
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(key);

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
    signal: AbortSignal.timeout(8_000),
  });
  if (!res.ok) throw Errors.unavailable('googleplay_auth_failed', 'Could not authenticate to Google Play');
  const json = (await res.json()) as { access_token: string; expires_in: number };
  await redis.set(RedisKeys.googleAccessToken(), json.access_token, 'EX', Math.max(60, json.expires_in - 300));
  return json.access_token;
}

async function verifyGooglePlay(receipt: UnityReceipt, expectedProductId: string): Promise<VerifiedPurchase> {
  // Unity's Google payload: {"json": "<purchase JSON string>", "signature": "..."}
  let purchaseToken: string;
  let productId: string;
  try {
    const payload = JSON.parse(receipt.Payload) as { json: string };
    const purchase = JSON.parse(payload.json) as { purchaseToken: string; productId: string; packageName: string };
    if (purchase.packageName !== config.GOOGLE_PLAY_PACKAGE_NAME) throw Errors.badRequest('package_mismatch', 'Receipt is for another app');
    purchaseToken = purchase.purchaseToken;
    productId = purchase.productId;
  } catch (err) {
    if (err instanceof Error && err.name === 'AppError') throw err;
    throw Errors.badRequest('bad_receipt', 'Malformed Google Play payload');
  }
  if (productId !== expectedProductId) throw Errors.badRequest('product_mismatch', 'Receipt is for another product');

  const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(config.GOOGLE_PLAY_PACKAGE_NAME)}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(purchaseToken)}`;
  const token = await googlePlayAccessToken();
  const res = await fetch(base, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(8_000) });
  if (!res.ok) throw Errors.badRequest('googleplay_rejected', `Google Play lookup failed (${res.status})`);

  const p = (await res.json()) as { purchaseState?: number; consumptionState?: number; orderId?: string; purchaseType?: number };
  // purchaseState: 0 purchased, 1 canceled, 2 pending.
  if (p.purchaseState !== 0) throw Errors.badRequest('purchase_not_completed', 'Purchase is not in PURCHASED state');
  if (!p.orderId) throw Errors.badRequest('googleplay_rejected', 'Missing orderId');

  return {
    store: 'GOOGLE_PLAY',
    productId,
    storeTransactionId: p.orderId,
    environment: p.purchaseType === 0 ? 'sandbox' : 'production',
    payload: { ...p, purchaseToken } as Prisma.InputJsonValue,
  };
}

// ------------------------------------------------------------------ Entry point

export interface PurchaseResult {
  granted: boolean;
  alreadyProcessed: boolean;
  productId: string;
  wallet: WalletView;
}

/**
 * Validates with the store, then records the purchase and grants currency in one DB transaction.
 * Idempotent on (store, storeTransactionId): retries after a lost response return the same result, which
 * lets the client safely call ConfirmPendingPurchase.
 */
export async function validateAndGrant(userId: string, input: { productId: string; receipt: string }, ip: string): Promise<PurchaseResult> {
  const product = ProductCatalog[input.productId];
  if (!product) throw Errors.badRequest('unknown_product', 'Unknown product');

  const receipt = parseUnityReceipt(input.receipt);
  let verified: VerifiedPurchase;
  if (receipt.Store === 'AppleAppStore') verified = await verifyAppStore(receipt, input.productId);
  else if (receipt.Store === 'GooglePlay') verified = await verifyGooglePlay(receipt, input.productId);
  else throw Errors.badRequest('unsupported_store', `Unsupported store ${receipt.Store}`);

  const result = await prisma.$transaction(async (tx) => {
    const prior = await tx.purchase.findUnique({
      where: { store_storeTransactionId: { store: verified.store, storeTransactionId: verified.storeTransactionId } },
    });
    if (prior) {
      if (prior.userId !== userId) {
        await audit('iap.receipt_reuse_cross_account', { userId, ip, severity: 'critical', metadata: { owner: prior.userId, tx: verified.storeTransactionId } }, tx);
        throw Errors.conflict('receipt_already_used', 'Receipt belongs to another account');
      }
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { userId } });
      return { applied: false, wallet };
    }

    await tx.purchase.create({
      data: {
        userId,
        store: verified.store,
        productId: verified.productId,
        storeTransactionId: verified.storeTransactionId,
        status: 'VERIFIED',
        environment: verified.environment,
        verifiedPayload: verified.payload,
      },
    });
    const entries: LedgerEntry[] = product.grants.map((g) => ({
      currency: g.currency,
      amount: g.amount,
      reason: 'IAP_PURCHASE',
      idempotencyKey: `iap:${verified.store}:${verified.storeTransactionId}:${g.currency}`,
      metadata: { productId: verified.productId },
    }));
    const applied = await applyLedgerEntries(tx, userId, entries);
    await audit('iap.granted', { userId, ip, metadata: { productId: verified.productId, store: verified.store, env: verified.environment } }, tx);
    return applied;
  });

  return { granted: result.applied, alreadyProcessed: !result.applied, productId: verified.productId, wallet: toWalletView(result.wallet) };
}
