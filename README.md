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
npx wrangler secret put GOOGLE_TOKEN_KEY     # Google カレンダー連携を使う場合。`openssl rand -base64 32` の値
npm run deploy
```

Google カレンダー連携を使う場合は、Google Cloud Console で「Google Calendar API」を有効にし、OAuth 同意画面のスコープに `.../auth/calendar.readonly` を追加する。承認済みリダイレクト URI には `https://<デプロイ先>/auth/google/calendar/callback` も登録する。同期は Cron Trigger（30分ごと）と画面の「今すぐ同期」で動く。ローカルでは `wrangler dev --test-scheduled` のうえで `/cdn-cgi/handler/scheduled` を叩くと cron を試せる。

Google Cloud Console の OAuth クライアント（ウェブアプリケーション）には、承認済みリダイレクト URI として `https://<デプロイ先>/auth/google/callback` と `http://localhost:8787/auth/google/callback` を登録する。

## API

仕様は `public/openapi.json`（デプロイ後は `/openapi.json`）。

- ブラウザはセッション Cookie、AI やスクリプトは画面の「AI用APIキー」で発行したキーを `Authorization: Bearer chk_...` で送る
- キーは既定で読み取り専用。書き込みを許可したキーでも、キーの持ち主の予定しか触れない
- キーでの削除は `?confirm=true` が必要（ユーザーに確認してから付ける）。キーでの操作はすべて記録される
- 同時編集は `version` で検出し、古ければ 409 と最新の内容を返す

```bash
curl -H "Authorization: Bearer $CALENDAR_HUB_KEY" \
  "https://<デプロイ先>/api/events?from=2026-11-01&to=2026-12-01"
```

旧 Calendar Hub（ChatGPT Sites 版）のデータは、旧サイトにログインした状態で `/api/events` を開いて JSON を保存し、画面の「旧Calendar Hubから取り込む」で読み込む。同じファイルを何度取り込んでも重複しない。

認可の考え方は `docs/authorization.md`、要件は `docs/requirements.md`。

## Orbit 連携（`tools/orbit-sync.mjs`）

Orbit とは API 同士でゆるくつなぐ（Orbit 側は変更しない）。Calendar Hub の書き込み可能な API キーと Orbit のトークンを環境変数に入れて実行する。

```bash
export CALENDAR_HUB_URL=https://<デプロイ先> CALENDAR_HUB_KEY=chk_... ORBIT_API=... ORBIT_TOKEN=...
node tools/orbit-sync.mjs due --dry-run          # Orbit の TODO 期限を「〆」の終日予定に反映（差分を表示）
node tools/orbit-sync.mjs due                    # 反映。完了・キャンセル・期限なしになった TODO の予定は消える
node tools/orbit-sync.mjs block <todo_id> --minutes 90        # 空き時間から作業枠を提案
node tools/orbit-sync.mjs block <todo_id> --minutes 90 --yes  # 提案どおりに作る
```

何度実行しても重複しない（`client_ref` で対応づけている）。定期実行したい場合はタスクスケジューラ等で `due` を回す。

## MCP（AI エージェントから使う）

`/mcp` がリモート MCP サーバー（Streamable HTTP）。認可は画面で発行した API キー。ツールは内部で REST API を同じキーで呼ぶので、スコープ・監査ログ・削除前の確認がそのまま効く。

```bash
# Claude Code に追加する例
claude mcp add --transport http calendar-hub https://<デプロイ先>/mcp --header "Authorization: Bearer chk_..."
```

ツール: `list_events` `get_event` `find_free_time` `list_groups` `create_event` `update_event` `delete_event`（`confirm: true` が必要）。
