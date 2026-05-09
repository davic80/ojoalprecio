import { db } from '../db/client';
import { categories } from '../db/schema';

/**
 * Auto-categorisation by product name. Each rule is a list of patterns; the
 * first rule that matches the (accent-stripped, lowercased) product name
 * wins. Order matters — most specific categories must come first so that,
 * e.g., a Kindle product isn't classified as generic Informática.
 *
 * Patterns are written without accents because we strip diacritics on the
 * input. Word-boundary `\b` is used wherever the keyword could appear inside
 * a longer noun and produce false positives.
 */

interface CategoryRule {
  slug: string;
  patterns: RegExp[];
}

const RULES: CategoryRule[] = [
  // ── Most specific dominions first ─────────────────────────────────────────
  { slug: 'kindle',          patterns: [/\bkindle\b/i, /paperwhite/i, /\bscribe\b/i, /\boasis\b.*lect/i] },
  { slug: 'piscina',         patterns: [/piscin/i, /\bcloro\b/i, /hipoclorit/i, /\bskimmer\b/i, /\bph\b\s*\+?-?/i, /clarificante/i, /alguicida/i, /salinidad/i] },
  { slug: 'drones',          patterns: [/\bdron\b/i, /\bdrones?\b/i, /\bdji\s+(neo|mini|air|mavic|avata|spark|inspire|tello)/i, /quadricopter/i, /quadcopter/i] },
  { slug: 'videojuegos',     patterns: [
      /\bplaystation\b/i, /\bps[3-5]\b/i, /\bxbox\b/i, /\bnintendo\b/i, /\bswitch\s*2?\b/i,
      /\bvideojuego/i, /\bgame ?pass\b/i, /\bgta\s*[ivx]+\b/i, /elden ring/i, /\bfortnite\b/i,
      /\bfifa\s?\d{2}/i, /\bfc\s?\d{2}\b/i, /mario kart/i, /\bzelda\b/i, /pokemon/i, /hollow knight/i,
      /spider-?man/i, /minecraft/i, /\bea sports\b/i, /\bcontroller\b/i, /\bgamepad\b/i,
    ] },
  { slug: 'foto',            patterns: [
      /camara fotografica/i, /\breflex\b/i, /\bmirrorless\b/i, /\bdslr\b/i,
      /objetivo (?:de\s+)?(?:focal|fija|teleobjetivo)/i, /\bsony alpha\b/i, /\bcanon eos\b/i, /\bnikon\b/i,
      /tripode.*camara/i,
    ] },
  { slug: 'audio',           patterns: [
      /\baltavoz/i, /\bsonos\b/i, /barra de sonido/i, /\bsoundbar\b/i,
      /\bairpods?\b/i, /auriculares/i, /\bcascos\b/i, /\bheadphones?\b/i, /earbuds?/i,
      /home theater/i, /amplificador.*audio/i,
    ] },
  // ── Apple-product disambiguation BEFORE the generic informatica/electronica catch-alls
  { slug: 'informatica',     patterns: [/\bipad\b/i, /\bmacbook\b/i, /\bmagic trackpad\b/i, /\bmagic mouse\b/i, /\bmagic keyboard\b/i, /\bimac\b/i, /\bmac mini\b/i, /\bmac pro\b/i, /\bmac studio\b/i] },
  { slug: 'electronica',     patterns: [/\biphone\b/i, /apple watch/i, /\bairtag\b/i, /apple tv\b/i] },
  // ── Generic dominions ─────────────────────────────────────────────────────
  { slug: 'informatica',     patterns: [
      /portatil/i, /\blaptop\b/i, /\bnotebook\b/i, /teclado/i, /\braton\b/i, /\bmouse\b/i,
      /monitor\b/i, /impresora/i, /escaner/i, /webcam/i, /memoria ram/i,
      /disco duro/i, /\bssd\b/i, /\bnvme\b/i, /pendrive/i, /\busb\s*c\b.*hub/i,
      /\brouter\b/i, /\bwifi\b.*(?:router|repetidor|extensor)/i, /switch ethernet/i, /\bnas\b/i,
      /servidor\b/i, /tarjeta grafica/i, /\bgpu\b/i, /\bcpu\b/i, /procesador (?:intel|amd)/i,
      /amd ryzen/i, /\bplaca base\b/i, /fuente de alimentacion/i, /carcasa pc/i,
    ] },
  { slug: 'electronica',     patterns: [
      /smartphone/i, /\bmovil\b/i, /tablet/i, /smartwatch/i, /reloj inteligente/i,
      /\bgarmin\b.*(?:watch|reloj|fenix|forerunner)/i, /huawei watch/i, /xiaomi.*band/i, /wearable/i,
      /cargador inalambrico/i, /power\s*bank/i, /\bcarplay\b/i, /\bandroid auto\b/i,
      /televisor/i, /smart tv/i, /\bqled\b/i, /\boled\b/i, /\bhdmi\b/i,
      /despertador/i, /radio digital/i, /\benchufe inteligente\b/i, /\bbombilla\b.*(?:wifi|smart)/i,
    ] },
  { slug: 'automocion',      patterns: [
      /\bcoche\b/i, /automovil/i, /parasol.*(?:coche|parabrisas)/i, /aspirador.*coche/i,
      /\bmoto\b(?!cicl)/i, /aceite motor/i, /neumatic/i, /\bllanta\b/i, /\bbujias\b/i,
      /\binflador\b.*(?:rueda|coche|moto)/i, /caja de herramientas.*coche/i,
    ] },
  { slug: 'hogar-y-cocina',  patterns: [
      /aspirador(?!.*coche)/i, /lavavajillas/i, /lavadora/i, /nevera/i, /frigorifico/i,
      /microondas/i, /cafetera/i, /tostador/i, /freidora/i, /\bolla\b/i, /sarten/i,
      /cuchillo (?:cocina|jamonero)/i, /sabana/i, /edredon/i, /colchon/i, /almohada/i,
      /cuberteria/i, /vajilla/i, /\bcocina\b/i, /robot.*cocina/i, /batidora/i, /licuadora/i,
      /toalla.*(?:bano|playa|microfibra)/i,
    ] },
  { slug: 'bebe',            patterns: [
      /\bbebe\b/i, /\bcuna\b/i, /biberon/i, /chupete/i, /\bpanal\b/i, /carrito.*bebe/i,
      /silla.*coche.*(?:nino|bebe)/i, /\btrona\b/i, /maxi-?cosi/i, /babyzen/i, /chicco\b/i,
    ] },
  { slug: 'juguetes',        patterns: [
      /\blego\b/i, /\bplaymobil\b/i, /\bpeluche\b/i, /\bmuneca\b/i, /\bjuguete/i,
      /\bbarbie\b/i, /hot wheels/i, /\bfunko\b/i, /\bnerf\b/i, /pista.*coches/i,
    ] },
  { slug: 'mascotas',        patterns: [
      /(?:para|de) (?:perro|gato)\b/i, /\bmascota/i, /\bpienso\b/i, /comedero/i, /bebedero/i,
      /arenero/i, /\bjaula\b/i, /acuario/i, /\bpez\b.*acuario/i, /collar.*perro/i,
      /correa.*perro/i, /transportin/i,
    ] },
  { slug: 'jardin',          patterns: [
      /cesped/i, /cortacesped/i, /\bmaceta\b/i, /fertilizante/i, /\bsemillas?\b/i,
      /herbicida/i, /insecticida/i, /\bhormigas?\b/i, /cucaracha/i, /raticid/i, /\branas?\b.*plaga/i,
    ] },
  { slug: 'deporte',         patterns: [
      /zapatill.*(?:running|deportiv|trail)/i, /raqueta/i, /\bpelota\b/i, /\bbalon\b/i,
      /mancuern/i, /\bfitness\b/i, /\byoga\b/i, /esterilla/i, /bicicleta/i,
      /\brodillera\b/i, /tobillera/i, /coderas?/i, /trail.*running/i, /\bpadel\b/i,
    ] },
  { slug: 'alimentacion',    patterns: [
      /aceite oliva/i, /\bchocolate\b/i, /\bcafe\b/i, /\binfusion/i, /\bte\b\s+(?:verde|negro|rojo|matcha)/i,
      /\bsnack/i, /galletas/i, /cereales/i, /legumbres/i, /pasta seca/i, /\bharina\b/i,
      /\bazucar\b/i, /\bmiel\b/i, /\bconserva/i, /\batun\b/i, /sardinas/i,
    ] },
  { slug: 'salud-y-belleza', patterns: [
      /\bchampu\b/i, /\bcrema\b.*(?:facial|corporal|hidratante|antiarrugas)/i,
      /maquillaje/i, /perfume/i, /\bcolonia\b/i, /cosmet/i,
      /electroestimulador/i, /plancha (?:de )?pelo/i, /\bsecador\b/i, /cepillo dental/i,
      /irrigador dental/i, /protector solar/i,
    ] },
];

let _slugToIdCache: Map<string, number> | null = null;

/** Drop the cache — call after categories are inserted/deleted at runtime. */
export function invalidateCategoryCache(): void {
  _slugToIdCache = null;
}

async function getSlugMap(): Promise<Map<string, number>> {
  if (_slugToIdCache) return _slugToIdCache;
  const rows = await db.select({ id: categories.id, slug: categories.slug }).from(categories);
  _slugToIdCache = new Map(rows.map(r => [r.slug, r.id]));
  return _slugToIdCache;
}

/** Strip Spanish diacritics so regex patterns can be written without accents. */
function normalize(name: string): string {
  return name.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/** Returns the matching category slug (or null) for a given product name. */
export function autoCategorizeSlug(name: string | null | undefined): string | null {
  if (!name) return null;
  const n = normalize(name);
  for (const rule of RULES) {
    for (const p of rule.patterns) {
      if (p.test(n)) return rule.slug;
    }
  }
  return null;
}

/** Returns the category id (or null) for a given product name. */
export async function autoCategorizeId(name: string | null | undefined): Promise<number | null> {
  const slug = autoCategorizeSlug(name);
  if (!slug) return null;
  const map = await getSlugMap();
  return map.get(slug) ?? null;
}
