# Meeting Minutes

Record an in-person meeting in the browser, get an AI-generated transcript and structured minutes.

## Deploy on Vercel

**Option A — no GitHub needed (fastest)**
1. Install the CLI once: `npm i -g vercel`
2. From inside this folder, run: `vercel`
3. Answer the prompts (link/create project, defaults are fine)
4. Run `vercel --prod` to get your live URL

**Option B — via GitHub (recommended if you'll keep editing this)**
1. Push this folder to a new GitHub repo
2. Go to vercel.com → Add New → Project → import that repo
3. Vercel auto-detects Vite — leave build settings as default
4. Click Deploy

Either way, no environment variables are needed — you'll paste your AssemblyAI and Anthropic API keys directly into the app each time you use it (they stay in your browser only, never sent anywhere but those two services).

## Important — this deploys as a public URL

Anyone with the link can open the app. They can't see your API keys (you type those in per-session, they're never stored in the code), but they *could* use your app's interface if they had their own keys. If you want it private, the simplest option is Vercel's password protection (Project Settings → Deployment Protection), available on Vercel Pro.

## Local development

```bash
npm install
npm run dev
```

## Notes

- Recording requires microphone access — the browser will prompt for it on first use, and it must be served over HTTPS (Vercel does this by default).
- Transcription uses AssemblyAI (https://www.assemblyai.com — free tier available).
- Minutes generation uses the Anthropic API (https://console.anthropic.com) with the `claude-sonnet-4-6` model.
