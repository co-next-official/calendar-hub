# 運用：バックアップと復旧

## 1. まずは D1 Time Travel（30日以内の時点に戻す）

D1 は書き込みの履歴を30日間持っていて、任意の時点に戻せる。誤削除や不具合でデータが壊れたときはこれが一番早い。

```bash
# 戻したい時刻を確認（UNIX時刻 or RFC3339）
npx wrangler d1 time-travel info calendar-hub --timestamp "2026-11-20T09:00:00+09:00"
# その時点に戻す（今のデータは上書きされる。戻す前のブックマークが表示されるので控えておく）
npx wrangler d1 time-travel restore calendar-hub --timestamp "2026-11-20T09:00:00+09:00"
```

戻した後に「やっぱり戻す前がよかった」となったら、表示されたブックマークで `--bookmark` 指定して戻し直せる。

## 2. 手元への定期バックアップ（30日より前、または Cloudflare の外に置く用）

```bash
npx wrangler d1 export calendar-hub --remote --no-schema --output backup-$(date +%Y%m%d).sql
```

スキーマはマイグレーション（`drizzle/`）が正なので、データだけ書き出す。**中身は予定・メールアドレス・暗号化済みトークンを含む個人データ**なので、暗号化した場所に置き、Git には入れない。

## 3. 書き出したデータからの復旧

`wrangler d1 export` はテーブルを依存関係の順に並べないため、スキーマごと書き出したファイルをそのまま流すと `no such table: main.users` で失敗する。次の順で行う。

```bash
# 1) 空の D1 を用意（本番を作り直す場合は新しいDBを作って wrangler.jsonc の database_id を差し替える）
npx wrangler d1 create calendar-hub-restore
# 2) マイグレーションでスキーマを作る
npx wrangler d1 migrations apply calendar-hub-restore --remote
# 3) d1_migrations の行は 2) で入っているので除いてからデータを流す
grep -v d1_migrations backup-YYYYMMDD.sql > data.sql
npx wrangler d1 execute calendar-hub-restore --remote --file data.sql
```

### 実地検証（2026-11-06、ローカル D1）

上の 2) 3) をローカルの別ディレクトリ（`--local --persist-to`）で実施。元と復旧先で件数（users 2 / events 5 / groups 1 / group_members 2 / event_participants 1 / api_tokens 1 / d1_migrations 5）と予定タイトルの一覧が一致した。

## 4. 鍵・シークレットの扱い

| シークレット | 失ったとき | 漏れたとき |
| --- | --- | --- |
| `SESSION_SECRET` | 進行中のログイン（10分以内）が失敗するだけ | 作り直して `wrangler secret put`。セッションCookie自体はDBのハッシュ照合なので影響は限定的 |
| `GOOGLE_TOKEN_KEY` | 保存済みのGoogleトークンが復号できない → 各ユーザーに連携し直してもらう | 作り直し、全連携を解除（`DELETE FROM google_connections`）して連携し直してもらう |
| `GOOGLE_CLIENT_SECRET` | Google Cloud Console で再発行 | 同左。再発行後 `wrangler secret put` |

バックアップの `.sql` には `GOOGLE_TOKEN_KEY` で暗号化したトークンしか入らないため、鍵とバックアップは別の場所に保管する。

## 5. 不正利用が疑われるとき

- APIキー：画面の「AI用APIキー」から失効。操作履歴は `GET /api/tokens/audit`
- 全セッションを切る：`DELETE FROM sessions;`（全員ログインし直しになる）
- ゲストリンク：予定の詳細から失効（API: `DELETE /api/events/:id/invites/:inviteId`）
