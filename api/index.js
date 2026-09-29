/**
 * The app's API as one Vercel function: the same Express app `npm run app`
 * serves locally (app/server.js), minus the static pages, which Vercel serves
 * from app/public. See vercel.json.
 */
import { createApp, loadDeployment } from "../app/server.js";

export default createApp({ deployment: loadDeployment(), rpcUrl: process.env.APP_RPC });
