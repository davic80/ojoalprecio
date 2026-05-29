import { signRequest, systemParams } from './sign';
import type { AliExpressProduct, AliExpressListResponse } from './types';
import { canonicalUrl } from './url';

/**
 * Thin client for the AliExpress Affiliate Open Platform (TOP).
 *
 * Endpoint base:   https://api-sg.aliexpress.com/sync
 * Auth:            HMAC-SHA256 signature over sorted params (see sign.ts)
 * Permissions:
 *   - productdetail.get / product.query : default — granted on app approval
 *   - product.smartmatch / hotproduct.query : extra — requested separately,
 *     1-3 day approval typically. Methods that need them throw
 *     `AliExpressPermissionError` until the App has the perm.
 */

const ENDPOINT = 'https://api-sg.aliexpress.com/sync';

export class AliExpressError extends Error {
  code?: string;
  raw?: unknown;
  constructor(message: string, code?: string, raw?: unknown) {
    super(message);
    this.name = 'AliExpressError';
    this.code = code;
    this.raw = raw;
  }
}
export class AliExpressPermissionError extends AliExpressError {
  constructor(message: string, raw?: unknown) {
    super(message, 'permission_denied', raw);
    this.name = 'AliExpressPermissionError';
  }
}

export interface AliExpressClientConfig {
  appKey:      string;
  appSecret:   string;
  trackingId:  string;        // your affiliate Portal tracking id
  targetCurrency?: string;    // ISO 4217, default 'EUR'
  targetLanguage?: string;    // ISO 639-1, default 'ES'
  shipToCountry?:  string;    // ISO 3166-1 alpha-2, default 'ES'
}

export class AliExpressClient {
  constructor(private readonly cfg: AliExpressClientConfig) {
    if (!cfg.appKey)     throw new Error('AliExpressClient: appKey required');
    if (!cfg.appSecret)  throw new Error('AliExpressClient: appSecret required');
    if (!cfg.trackingId) throw new Error('AliExpressClient: trackingId required');
  }

  private async call<T = unknown>(method: string, businessParams: Record<string, string | number | boolean | null | undefined>): Promise<T> {
    const sys = systemParams(this.cfg.appKey, method);
    // Defensive filter: any null / undefined / NaN value would otherwise
    // become the literal string "null" / "undefined" / "NaN" in URLSearchParams,
    // and the AE API rejects those as "<value>#<param> not valid" errors.
    // Conditional spreads at the call sites SHOULD prevent leaks, but the
    // filter here makes the client robust against any future caller
    // forgetting that pattern.
    const all: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...sys, ...businessParams })) {
      if (v == null) continue;
      if (typeof v === 'number' && !Number.isFinite(v)) continue;
      all[k] = String(v);
    }
    const sign = signRequest(all, this.cfg.appSecret);
    const body = new URLSearchParams({ ...all, sign }).toString();

    const res = await fetch(ENDPOINT, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    return this.parseResponse<T>(method, res);
  }

  /**
   * multipart/form-data variant. Required for TOP methods that take binary
   * (`*_bytes`) parameters — `aliexpress.ds.image.search` is the only one
   * we use. AE's TOP convention: the signature is computed over the TEXT
   * params only (byte fields excluded), then the request is sent as
   * multipart with text fields + binary parts side by side. Sign over the
   * urlencoded shape would not match; sign over `all` after filling in the
   * bytes-as-base64 also wouldn't (and exceeds practical URL length).
   */
  private async multipartCall<T = unknown>(
    method: string,
    businessParams: Record<string, string | number | boolean | null | undefined>,
    byteParams: Record<string, { buffer: Buffer; filename: string; contentType?: string }>,
  ): Promise<T> {
    const sys = systemParams(this.cfg.appKey, method);
    const all: Record<string, string> = {};
    for (const [k, v] of Object.entries({ ...sys, ...businessParams })) {
      if (v == null) continue;
      if (typeof v === 'number' && !Number.isFinite(v)) continue;
      all[k] = String(v);
    }
    const sign = signRequest(all, this.cfg.appSecret);

    const form = new FormData();
    for (const [k, v] of Object.entries(all)) form.append(k, v);
    form.append('sign', sign);
    for (const [k, { buffer, filename, contentType }] of Object.entries(byteParams)) {
      const blob = new Blob([new Uint8Array(buffer)], { type: contentType ?? 'application/octet-stream' });
      form.append(k, blob, filename);
    }

    const res = await fetch(ENDPOINT, { method: 'POST', body: form });
    return this.parseResponse<T>(method, res);
  }

  private async parseResponse<T>(method: string, res: Response): Promise<T> {
    if (!res.ok) throw new AliExpressError(`HTTP ${res.status} from ${method}`, String(res.status));
    const json = await res.json() as Record<string, any>;
    // TOP API wraps every response in <method-with-underscores>_response.
    // Errors come back as { error_response: { code, msg, sub_msg } }.
    if (json.error_response) {
      const e = json.error_response;
      const msg = `${e.msg ?? 'AliExpress error'}${e.sub_msg ? ' — ' + e.sub_msg : ''}`;
      if (e.code === 25 || e.code === '25' || /permission/i.test(String(e.sub_code ?? ''))) {
        throw new AliExpressPermissionError(msg, e);
      }
      throw new AliExpressError(msg, String(e.code ?? 'unknown'), e);
    }
    const wrapperKey = method.replace(/\./g, '_') + '_response';
    const payload = json[wrapperKey];
    if (!payload) throw new AliExpressError(`Missing ${wrapperKey} in response`, undefined, json);
    return payload as T;
  }

  // ── Public methods ─────────────────────────────────────────────────────────

  /** Detail for a single productId. Default permission. */
  async productDetail(productId: string): Promise<AliExpressProduct | null> {
    const r = await this.call<any>('aliexpress.affiliate.productdetail.get', {
      product_ids:      productId,
      tracking_id:      this.cfg.trackingId,
      fields:           'product_id,product_title,product_main_image_url,product_video_url,product_detail_url,target_sale_price,target_sale_price_currency,target_original_price,discount,evaluate_rate,lastest_volume,first_level_category_id,first_level_category_name,shop_id,shop_url,promotion_link',
      target_currency:  this.cfg.targetCurrency ?? 'EUR',
      target_language:  this.cfg.targetLanguage ?? 'ES',
      country:          this.cfg.shipToCountry ?? 'ES',
    });
    const list = r?.resp_result?.result?.products?.product ?? [];
    return list[0] ? mapProduct(list[0]) : null;
  }

  /** Keyword search (strategy A: brand + model). Default permission. */
  async productQuery(opts: {
    keywords: string;
    minSalePrice?: number;
    maxSalePrice?: number;
    pageNo?: number;
    pageSize?: number;
  }): Promise<AliExpressListResponse> {
    const r = await this.call<any>('aliexpress.affiliate.product.query', {
      keywords:         opts.keywords,
      tracking_id:      this.cfg.trackingId,
      ...(opts.minSalePrice != null ? { min_sale_price: opts.minSalePrice } : {}),
      ...(opts.maxSalePrice != null ? { max_sale_price: opts.maxSalePrice } : {}),
      page_no:          opts.pageNo   ?? 1,
      page_size:        opts.pageSize ?? 20,
      target_currency:  this.cfg.targetCurrency ?? 'EUR',
      target_language:  this.cfg.targetLanguage ?? 'ES',
      ship_to_country:  this.cfg.shipToCountry ?? 'ES',
      sort:             'SALE_PRICE_ASC',
    });
    const items = r?.resp_result?.result?.products?.product ?? [];
    return {
      products:   items.map(mapProduct),
      totalCount: Number(r?.resp_result?.result?.total_record_count ?? items.length),
      pageNo:     Number(r?.resp_result?.result?.current_page_no ?? opts.pageNo ?? 1),
      pageSize:   Number(r?.resp_result?.result?.page_size ?? opts.pageSize ?? 20),
    };
  }

  /**
   * Top trending products in the AE catalog. Requires the Advanced API
   * permission (approved 2026-05-21). Sorting defaults to LAST_VOLUME_DESC
   * — i.e. "most-ordered first", the closest proxy AE exposes for
   * popularity-driven discovery. Optional category + price filters keep
   * the feed relevant.
   */
  async hotProductQuery(opts: {
    pageSize?:     number;
    pageNo?:       number;
    categoryIds?:  string;       // CSV of AE category ids
    keywords?:     string;
    minSalePrice?: number;
    maxSalePrice?: number;
    sort?:         'LAST_VOLUME_DESC' | 'LAST_VOLUME_ASC' | 'SALE_PRICE_DESC' | 'SALE_PRICE_ASC';
  } = {}): Promise<AliExpressListResponse> {
    const r = await this.call<any>('aliexpress.affiliate.hotproduct.query', {
      tracking_id:     this.cfg.trackingId,
      page_no:         opts.pageNo   ?? 1,
      page_size:       opts.pageSize ?? 50,
      ...(opts.keywords     ? { keywords:        opts.keywords    } : {}),
      ...(opts.categoryIds  ? { category_ids:    opts.categoryIds } : {}),
      ...(opts.minSalePrice != null ? { min_sale_price: Math.floor(opts.minSalePrice) } : {}),
      ...(opts.maxSalePrice != null ? { max_sale_price: Math.ceil(opts.maxSalePrice)  } : {}),
      target_currency: this.cfg.targetCurrency ?? 'EUR',
      target_language: this.cfg.targetLanguage ?? 'ES',
      ship_to_country: this.cfg.shipToCountry  ?? 'ES',
      sort:            opts.sort ?? 'LAST_VOLUME_DESC',
    });
    const items = r?.resp_result?.result?.products?.product ?? [];
    return {
      products:   items.map(mapProduct),
      totalCount: Number(r?.resp_result?.result?.total_record_count ?? items.length),
      pageNo:     Number(r?.resp_result?.result?.current_page_no ?? opts.pageNo ?? 1),
      pageSize:   Number(r?.resp_result?.result?.page_size ?? opts.pageSize ?? 50),
    };
  }

  /** "You may also like" given a productId (strategy C fallback). EXTRA permission. */
  async smartMatch(productId: string, pageSize = 10): Promise<AliExpressProduct[]> {
    // device_id is documented as optional ("supply product_id OR device_id")
    // but the API actually demands it on every call — bombs with
    // "The input parameter 'device_id' that is mandatory…" if absent.
    // We derive a stable per-product id from the productId so AE's
    // personalisation layer (whatever it does with the field) at least
    // varies output per master rather than always seeing the same
    // sentinel. Also pass app/device so AE knows we're a web caller.
    const r = await this.call<any>('aliexpress.affiliate.product.smartmatch', {
      app:              'web',
      device:           'web',
      device_id:        `oap-${productId}`,
      product_id:       productId,
      tracking_id:      this.cfg.trackingId,
      page_size:        pageSize,
      target_currency:  this.cfg.targetCurrency ?? 'EUR',
      target_language:  this.cfg.targetLanguage ?? 'ES',
      country:          this.cfg.shipToCountry  ?? 'ES',
    });
    const items = r?.resp_result?.result?.products?.product ?? [];
    return items.map(mapProduct);
  }

  /**
   * Image-based product discovery. Takes raw image bytes (jpg/png), returns
   * AE products that visually match. Used to improve Amazon→AE equivalents
   * matching where the keyword-based productQuery/smartMatch struggle —
   * especially for accessories, clothing, generic items whose titles are
   * too ambiguous to score reliably.
   *
   * Permission tier: "SKU Dimension API" group (one of the methods AE
   * grants under that umbrella to Affiliates-category apps, alongside
   * ds.text.search and ds.commissionorder.listbyindex; the namesake
   * ds.product.get itself remains gated to Drop Shipping apps).
   *
   * Transport: multipart/form-data — TOP rejects this method via the
   * normal urlencoded body shape with `MissingParameter: image_file_bytes`
   * regardless of payload size, because the file content is supposed to
   * sit in its own multipart part. The text params (and only those) form
   * the signature.
   */
  async dsImageSearch(
    image: Buffer,
    accessToken: string,
    opts: { pageSize?: number; pageNo?: number; sort?: string; filename?: string; mimeType?: string } = {},
  ): Promise<AliExpressProduct[]> {
    if (!accessToken) throw new AliExpressError('dsImageSearch: accessToken required', 'missing_access_token');
    if (!image?.length) throw new AliExpressError('dsImageSearch: image buffer is empty', 'missing_image');
    const r = await this.multipartCall<any>(
      'aliexpress.ds.image.search',
      {
        shpt_to:         this.cfg.shipToCountry  ?? 'ES',
        target_currency: this.cfg.targetCurrency ?? 'EUR',
        target_language: this.cfg.targetLanguage ?? 'ES',
        page_size:       opts.pageSize ?? 10,
        page_no:         opts.pageNo   ?? 1,
        sort:            opts.sort     ?? 'orders,desc',
        access_token:    accessToken,
      },
      {
        image_file_bytes: {
          buffer:      image,
          filename:    opts.filename ?? 'query.jpg',
          contentType: opts.mimeType ?? 'image/jpeg',
        },
      },
    );
    const items = r?.resp_result?.result?.products?.product
              ?? r?.result?.products?.product
              ?? r?.products?.product
              ?? [];
    return Array.isArray(items) ? items.map(mapProduct) : [];
  }
}

/** Map snake_case wire shape → camelCase domain type. Tolerant of missing fields. */
function mapProduct(p: any): AliExpressProduct {
  const productId = String(p.product_id ?? '');
  return {
    productId,
    title:         String(p.product_title ?? ''),
    imageUrl:      p.product_main_image_url ?? null,
    productUrl:    p.product_detail_url ?? canonicalUrl(productId),
    promotionUrl:  p.promotion_link ?? null,
    salePrice:     toFloat(p.target_sale_price ?? p.sale_price ?? p.app_sale_price),
    originalPrice: maybeFloat(p.target_original_price ?? p.original_price),
    discountPct:   p.discount != null ? parseInt(String(p.discount).replace(/[^\d]/g, ''), 10) || null : null,
    currency:      String(p.target_sale_price_currency ?? p.sale_price_currency ?? 'EUR'),
    rating:        maybeFloat(p.evaluate_rate),
    ordersCount:   maybeInt(p.lastest_volume ?? p.orders),
    categoryId:    maybeInt(p.first_level_category_id),
    categoryName:  p.first_level_category_name ?? null,
    shopId:        maybeInt(p.shop_id),
    shopName:      p.shop_name ?? null,
  };
}

function toFloat(v: unknown): number {
  const n = parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : 0;
}
function maybeFloat(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}
function maybeInt(v: unknown): number | null {
  if (v == null || v === '') return null;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
}
