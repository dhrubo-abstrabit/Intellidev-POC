---
name: deploy
description: Deploy this project to Vercel and verify the deploy actually succeeded. Use when asked to deploy, ship, push to production, or release a change.
---

- `git push origin main` auto-deploys via Vercel's GitHub integration — no manual `vercel --prod` needed.
- Vercel project is on the **Hobby plan**: cron jobs can only run once/day (a `*/15 * * * *` schedule fails deployment outright), and function `maxDuration` caps at 60s — set `export const maxDuration = 60` on any route that calls Slack or Anthropic.
- New Vercel env vars are **write-only by default** ("sensitive") — once set, they can never be read back via CLI or dashboard, not even by the owner. If a value needs to be reused later (e.g. a generated secret), it has to be remembered from when it was generated, not fetched back from Vercel.
- After deploying, confirm with a real check (`curl` the live URL, or a Playwright run against it) — don't infer success from the CLI's exit code alone.
