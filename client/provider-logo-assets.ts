/** Official monochrome provider marks; sources and terms are in THIRD_PARTY_NOTICES.md. */
const providerLogoSvgs: Record<string, string> = {
  claude: "<svg width=\"92\" height=\"64\" viewBox=\"0 0 92 64\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\">\n<path d=\"M65.92 0H51.9314L77.44 64H91.4286L65.92 0Z\" fill=\"#FAF9F5\"/>\n<path d=\"M25.5086 0L0 64H14.2629L19.4798 50.56H46.166L51.3829 64H65.6457L40.1371 0H25.5086ZM24.0933 38.6743L32.8229 16.1829L41.5525 38.6743H24.0933Z\" fill=\"#FAF9F5\"/>\n</svg>\n",
  codex: "<svg width=\"716\" height=\"716\" viewBox=\"0 0 716 716\" fill=\"none\" xmlns=\"http://www.w3.org/2000/svg\">\n<path d=\"M508.749 317.399C516.777 287.314 508.991 253.884 485.389 230.282C461.788 206.681 428.36 198.895 398.273 206.923C376.231 184.928 343.39 174.956 311.148 183.596C278.906 192.234 255.45 217.292 247.36 247.361C217.291 255.451 192.233 278.91 183.595 311.149C174.957 343.391 184.927 376.232 206.924 398.274C198.896 428.359 206.683 461.789 230.284 485.391C253.885 508.992 287.313 516.779 317.401 508.75C339.442 530.745 372.286 540.717 404.525 532.079C436.767 523.441 460.223 498.384 468.313 468.315C498.383 460.224 523.44 436.766 532.078 404.526C540.716 372.285 530.747 339.443 508.749 317.402V317.399ZM470.899 244.776C486.892 260.77 493.488 282.601 490.687 303.412L415.577 260.046C412.411 258.218 408.509 258.218 405.345 260.046L317.401 310.82V277.526C317.401 275.191 318.652 273.005 320.676 271.837L387.644 233.174C414.178 218.353 448.346 222.223 470.901 244.776H470.899ZM357.837 311.144L398.275 334.491V381.185L357.837 404.532L317.398 381.185V334.491L357.837 311.144ZM264.776 269.693C265.207 239.305 285.644 211.649 316.453 203.393C338.3 197.54 360.505 202.744 377.127 215.573L302.014 258.937C298.848 260.764 296.898 264.144 296.898 267.798V369.346L268.065 352.699C266.043 351.531 264.776 349.353 264.776 347.017V269.691V269.693ZM203.391 316.454C209.244 294.608 224.854 277.978 244.276 269.999V356.73C244.276 360.384 246.226 363.763 249.392 365.591L337.337 416.365L308.503 433.013C306.481 434.181 303.961 434.188 301.939 433.02L234.971 394.357C208.868 378.789 195.138 347.261 203.391 316.454ZM244.775 470.9C228.781 454.906 222.186 433.075 224.986 412.264L300.096 455.63C303.263 457.457 307.164 457.457 310.328 455.63L398.273 404.856V438.149C398.273 440.485 397.022 442.671 394.997 443.839L328.029 482.502C301.495 497.322 267.327 493.452 244.772 470.9H244.775ZM450.897 445.982C450.466 476.371 430.029 504.027 399.22 512.283C377.373 518.136 355.168 512.932 338.547 500.102L413.659 456.738C416.826 454.911 418.775 451.532 418.775 447.877V346.329L447.609 362.977C449.631 364.145 450.897 366.323 450.897 368.659V445.985V445.982ZM512.282 399.221C506.429 421.068 490.819 437.697 471.397 445.676V358.946C471.397 355.292 469.448 351.912 466.281 350.085L378.336 299.311L407.17 282.663C409.192 281.495 411.712 281.487 413.734 282.655L480.702 321.318C506.805 336.887 520.536 368.415 512.282 399.221Z\" fill=\"white\"/>\n</svg>\n",
  grok: "<svg viewBox=\"0 0 512 512\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M210.484 312.759L343.465 210.383C349.984 205.364 359.302 207.322 362.408 215.117C378.758 256.231 371.454 305.64 338.925 339.563C306.397 373.487 261.137 380.927 219.768 363.983L174.577 385.803C239.394 432.008 318.104 420.581 367.289 369.251C406.303 328.564 418.386 273.104 407.088 223.091L407.19 223.198C390.807 149.726 411.218 120.359 453.03 60.3072C454.02 58.8833 455.01 57.4595 456 56L400.978 113.382V113.204L210.45 312.794\" fill=\"#FCFCFC\"/><path d=\"M183.042 337.641C136.519 291.294 144.54 219.567 184.236 178.203C213.59 147.59 261.683 135.096 303.666 153.464L348.755 131.75C340.632 125.627 330.221 119.042 318.275 114.414C264.277 91.2407 199.63 102.774 155.735 148.516C113.513 192.549 100.236 260.254 123.036 318.027C140.069 361.206 112.148 391.748 84.0229 422.575C74.0561 433.503 64.0553 444.431 56 456L183.007 337.677\" fill=\"#FCFCFC\"/></svg>",
};

const sourceCache = new Map<string, string>();

/** The root `<svg>` tag: the fill it declares is what every unpainted child inherits. */
const rootTag = /<svg\b[^>]*>/i;
/** A fill that paints: `none` (and the empty value) leaves the shape unpainted. */
const paints = (value: string) => !/^(?:none)?$/i.test(value.trim());

/**
 * Recolour the whole monochrome mark to the theme text colour, and only the mark:
 * the pressure state keeps its own colour. The fill goes on the root `<svg>` — the
 * vendor assets declare their own child fills (and a root `fill="none"`), and a
 * child fill the vendor hard-codes would otherwise win over the inherited one and
 * render the mark in the asset's own colour, invisible on the dark theme
 * (nucleus#1123). Every painted child fill is rewritten, and `currentColor` — which
 * a renderer may resolve to black — becomes the same colour.
 */
export function themedProviderSvg(svg: string, color: string): string {
  const root = rootTag.exec(svg);
  if (!root) throw new Error("provider mark has no root <svg>");
  const paint = (match: string, value: string) =>
    paints(value) ? `fill="${color}"` : match;
  const rootWithFill = (/\sfill="[^"]*"/i.test(root[0])
    ? root[0].replace(/(\sfill=")[^"]*(")/i, (_match, open: string, close: string) => `${open}${color}${close}`)
    : root[0].replace(/^<svg/i, () => `<svg fill="${color}"`)
  ).replace(/currentColor/g, () => color);
  const body = svg
    .slice(root[0].length)
    .replace(/fill="([^"]*)"/gi, paint)
    .replace(/currentColor/g, () => color);
  return `${rootWithFill}${body}`;
}

/** The mark as a data URI, recoloured to `color`. Unknown providers have no bundle entry. */
export function providerLogoSource(provider: string, color: string): string | null {
  const svg = providerLogoSvgs[provider];
  if (!svg) return null;
  const cacheKey = `${provider}:${color}`;
  const cached = sourceCache.get(cacheKey);
  if (cached) return cached;
  const themed = themedProviderSvg(svg, color);
  const source = `data:image/svg+xml;utf8,${encodeURIComponent(themed)}`;
  sourceCache.set(cacheKey, source);
  return source;
}
