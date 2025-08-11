# kanto-fab-event-ical

Flesh and Blood（FaB）のイベント情報を統合し、iCal形式でカレンダーを提供するアプリケーションです。

## 機能

### 公式イベント取得
- FaB公式サイトのEvent Finderから目黒駅周辺50km以内のイベント情報を自動取得
- 1時間毎に自動更新

### 外部カレンダー統合 🆕
以下の店舗カレンダーからイベント情報を自動取得・統合：
- **Fable Tokyo**: `fable.fabtcg@gmail.com`
- **Tokyo FAB**: `tokyofab.info@gmail.com`

## アーキテクチャ

### batch
- TypeScript実装によるイベント情報取得・処理
- Cloudflare Workers上で動作
- `ical-generator`ライブラリを使用したiCal生成
- `linkedom`を使用したDOM解析

## セットアップ

```bash
cd batch
yarn install
wrangler login
yarn dev    # 開発環境での実行
yarn deploy # Cloudflare Workersへのデプロイ
```

## 技術仕様

- **ランタイム**: Cloudflare Workers
- **スケジュール**: Cron（毎時0分）
- **ストレージ**: Cloudflare R2（`kanto-fab-events-ical` バケット）
- **出力**: `calendar.ics` ファイル（text/calendar形式）

## 開発

- **パッケージ管理**: Yarn
- **デプロイ**: Cloudflare Workers
- **データ更新頻度**: 1時間毎の自動実行

## ライセンス

このプロジェクトはMITライセンスの下で公開されています。