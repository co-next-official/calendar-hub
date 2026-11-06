# セキュリティ・品質検証（TODO 11）

2026-11-06 時点。「テスト」は `npm test`（Workers ランタイム上で実行、CI でも毎回実行）、「実ブラウザ」はローカル `wrangler dev` を実際に操作して確認したもの。

| 観点 | 対策 | 確認方法 |
| --- | --- | --- |
| 他人の予定への越境（D1 上のサーバー認可） | 予定の読み書きは `ownerId` 必須のリポジトリ経由。共有閲覧は `canSee()` で所有者・承諾済みグループ・参加者に限定。権限外は 404 | テスト：`db-events` `events-api` `sharing`（取得・一覧・更新・削除・回答・再共有・リンク作成のすべて） |
| busy-only の詳細漏れ | 他人には時間枠だけ返し、タイトル・メモ・参加者を空に。タイトル検索も当たらない。ICS も同じ表示 | テスト：`sharing`（レスポンス本文に元タイトル・メモが含まれないことを全経路で確認）、実ブラウザ |
| 空き時間検索での漏れ | 合算した空き枠だけを返す。誰の予定か・個別の埋まりは返さない。非メンバーは 404 | テスト：`availability` |
| ゲストリンクの漏れ | トークンは SHA-256 のみ保存、URL フラグメントで渡す（サーバーログ・Referer に乗らない）、期限・失効あり、ゲストにはメールアドレスを出さない、IP ごとのレート制限 | テスト：`sharing` `security`、実ブラウザ |
| APIキーの失効・スコープ | ハッシュのみ保存、read/write、失効即時反映、キー経由の操作は全件監査ログ、削除は `confirm=true` 必須 | テスト：`tokens` |
| 権限昇格 | Bearer キーとセッション Cookie を混ぜない／キーでキー管理・グループ操作・共有設定・ゲストリンク作成はできない／閲覧者は編集・再共有不可／グループ管理はオーナーのみ | テスト：`tokens` `groups` `sharing` |
| ログイン | OIDC 認可コード + PKCE、署名付き state Cookie、ID トークンの iss/aud/exp/email_verified 検証、`ALLOWED_EMAILS`、戻り先はサイト内の相対パスのみ | テスト：`auth` |
| CSRF | セッション Cookie は SameSite=Lax、状態を変える API は Origin が異なれば 403 | テスト：`auth` |
| XSS | 画面は `textContent` だけで描画（`innerHTML` 不使用）、CSP で外部スクリプトとインラインスクリプトを禁止 | コード確認、実ブラウザで CSP 違反なし |
| クリックジャッキング等 | `frame-ancestors 'none'` / `X-Frame-Options: DENY` / `nosniff` / `Referrer-Policy: no-referrer` | テスト：`security`、ヘッダー実測 |
| 総当たり・乱用 | Workers Rate Limiting：ログイン・ゲストは IP ごと 30回/分、API はユーザーまたはキーごと 300回/分 | テスト：`security` |
| 日時・夏時間・終日 | 終日は日付で終了排他、時刻付きは UTC + IANA TZ。旧データ取り込みと空き時間の時間帯は夏時間を考慮して UTC に変換 | テスト：`validate` `events-api`（America/New_York の夏時間切替） `availability` |
| 同期の重複・削除反映 | Google の予定は（接続, Google の予定ID）で一意。差分同期、410 時は ID を保ったまま全件再同期、消えた予定は削除 | テスト：`google` |
| Google トークン | AES-256-GCM で暗号化保存、改ざん検出、解除時に Google 側で revoke | テスト：`google` |
| 同時編集 | `version` による楽観ロック、古い版での更新は 409 と最新を返す | テスト、実ブラウザ |
| スマホ UI | 旧版のスマホ用 CSS を維持、ゲストページもスマホ幅で確認 | 実ブラウザ（390×844） |
| バックアップ・復旧 | Time Travel と書き出し・復旧手順 | `docs/operations.md`、ローカルで実地復旧し件数一致を確認 |

## 残っているもの（本番環境が必要）

- 本番での Google ログイン・Google カレンダー同期の実アカウント確認
- 本番 D1 での Time Travel 復旧の実地確認
- レート制限の値の調整（実際の利用状況を見て）
