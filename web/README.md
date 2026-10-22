# Deploy Bao on Vercel

Eight clicks. This repo does not deploy itself. From `web/`, `npx vercel@65.0.0 build --yes` writes `.vercel/output` and does not deploy. Logged out, that command asks to pull project settings. A local `web/.vercel/project.json` with `settings.framework` set to `nextjs` lets the build finish without a login.

1. Open [vercel.com/new](https://vercel.com/new) and import the GitHub repository `aaalexliu/bao-browser`.
2. Root Directory: click **Edit**, enter `web`, then Continue. Framework Preset: **Next.js**. Leave the build command as `npm run build`.
3. Environment Variables: add `BAO_AUTH_STUB` = `1` so the sign-in API returns the email link. Leave it unset once a real mailer exists. The GitHub button stays a stub and returns 501 in production without `BAO_AUTH_STUB`. Do not type `DATABASE_URL`, `BLOB_STORE_ID`, `BLOB_READ_WRITE_TOKEN`, `BAO_PG_DIR`, or `BAO_BLOB_DIR`. The last two are local directories only.
4. Click **Deploy**. When the deployment is Ready, copy the URL with no trailing slash and no path. Example: `https://bao-browser.vercel.app`.
5. In the project, open **Storage**, then **Create**, then **Blob**. Choose **Private**. Create the store and connect it to this project. That sets `BLOB_STORE_ID` for the redacted PNGs. Do not choose a public store.
6. Open [Neon on the Marketplace](https://vercel.com/marketplace/neon). Install it, choose the **Free** plan, read the plan, and accept. Connect the database to this project. Neon sets `DATABASE_URL`. Do not install Vercel Postgres or Vercel KV. Those products are sunset.
7. Open **Deployments**, open the menu on the latest deployment, and click **Redeploy**. The new deployment has to see `DATABASE_URL` and `BLOB_STORE_ID`.
8. On the Mac, open **Settings → Sync**. Server: paste the URL from step 4. On the site, open **Devices**, copy the pairing code, and type it under Pairing code. Name the device, then **Pair**, then **Sync**.
