/**
 * Entry for the browser bundle of Circle's Onramp Kit. The kit's client
 * imports zod and pino by name, which a plain page can't load, so
 * `npm run build:onramp` bundles this into app/public/vendor/onramp-kit.js,
 * exposed as `window.CircleOnramp`.
 */
export { createOnrampKit, fetchOnrampSession } from "@circle-fin/onramp-kit";
