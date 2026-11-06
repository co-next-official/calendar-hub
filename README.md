# Calendar Hub

予定をひとつにまとめる個人・身内向けカレンダー。Cloudflare Workers + D1 で動き、Google アカウントでログインする。

もとは ChatGPT Sites 上のアプリだったが、2026-11-06 に Claude Code へ移管し、Sites 依存（ChatGPT 認証・Sites の D1・ビルドスクリプト）を外して自前の Workers 構成に作り直した。

## 構成

| 場所 | 役割 |
| --- | --- |
| `src/` | Worker（Hono）。`/api/*` と `/auth/*` を処理し、それ以外は `public/` の静的 UI を返す |
| `public/` | カレンダー UI（素の HTML / CSS / JS） |
| `drizzle/` | D1 マイグレーション（`drizzle-kit generate` で生成し、`wrangler d1 migrations apply` で適用） |
| `test/` | Vitest（`@cloudflare/vitest-plugin` で Workers ランタイム上で実行） |

## 開発

```bash
npm install
cp .dev.vars.example .dev.vars   # Google OAuth のクライアント ID などを記入
npm run db:migrate:local
npm run dev
```

チェック: `npm run check`（型チェック + テスト）。CI でも同じものと `wrangler deploy --dry-run` が走る。

## 初回デプロイ

```bash
npx wrangler d1 create calendar-hub          # 出力された database_id を wrangler.jsonc に書く
npm run db:migrate:remote
npx wrangler secret put GOOGLE_CLIENT_ID
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put SESSION_SECRET
npm run deploy
```

Google Cloud Console の OAuth クライアント（ウェブアプリケーション）には、承認済みリダイレクト URI として `https://<デプロイ先>/auth/google/callback` と `http://localhost:8787/auth/google/callback` を登録する。
