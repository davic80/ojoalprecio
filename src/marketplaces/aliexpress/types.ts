/**
 * Typed shapes for AliExpress Affiliate API responses.
 *
 * NOTE: the official API returns fields in `snake_case` and wraps every
 * response in `<method>_response.resp_result.result.<list>`. We map to
 * `camelCase` and flatten at the client boundary so the rest of the app
 * never sees the wire shape.
 */

/** Single product as returned by productdetail.get / product.query / smartmatch. */
export interface AliExpressProduct {
  productId:        string;        // canonical numeric id (we cast to string for stability)
  title:            string;
  imageUrl:         string | null;
  productUrl:       string;        // canonical es-locale URL
  promotionUrl:     string | null; // affiliate URL (with our tracking id), null if none
  salePrice:        number;        // current sale price in `currency`
  originalPrice:    number | null; // RRP / pre-discount price, if exposed
  discountPct:      number | null; // 0-100
  currency:         string;        // e.g. "EUR", "USD"
  /** % positive feedback (0-100, e.g. 90.2). NOT a 0-5 score — that's an
      Amazon convention. AE only exposes `evaluate_rate`, which is the
      shop/seller satisfaction percentage. */
  rating:           number | null;
  ordersCount:      number | null; // lifetime orders
  categoryId:       number | null;
  categoryName:     string | null;
  shopId:           number | null;
  shopName:         string | null;
}

/** Generic envelope around any list endpoint. */
export interface AliExpressListResponse<T = AliExpressProduct> {
  products:   T[];
  totalCount: number;     // server-reported, may be capped (typical 10k)
  pageNo:     number;
  pageSize:   number;
}

/**
 * Discriminator for where a given similar-product candidate came from.
 *   - 'query'       : aliexpress.affiliate.product.query (default-perm) with
 *                     brand+model keywords from the master title (strategy A).
 *   - 'smartmatch'  : aliexpress.affiliate.product.smartmatch (extra-perm)
 *                     given the master productId (strategy C fallback).
 */
export type SimilarSource = 'query' | 'smartmatch';

export interface SimilarCandidate {
  product:    AliExpressProduct;
  source:     SimilarSource;
  /** 0-1 text-similarity score vs the master title (Jaccard on tokens). */
  textScore:  number;
}
