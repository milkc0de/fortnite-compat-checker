# Fortnite 相性診断

GitHub Pages と Cloudflare Workers で動かす構成です。

## 構成

- GitHub Pages: index.html を配信
- Cloudflare Workers: APIキーを隠して Fortnite API を呼び出す
- Fortnite API: Epic ID から accountId を解決し、戦績を取得する

## セットアップ

1. Cloudflare Workers に worker.js を貼ってデプロイします。
2. Worker の Settings から Secret を追加します。
   - Name: FORTNITE_API_KEY
   - Value: 自分のAPIキー
3. 発行された Workers URL をコピーします。
4. index.html の WORKER_URL を自分の Workers URL に変更します。
5. GitHub Pages に index.html を置いて公開します。

## 注意

APIキーを index.html に直書きしないでください。
GitHub Pages は静的ファイルがそのまま公開されるため、キーが見えてしまいます。
