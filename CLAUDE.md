# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## プロジェクト概要

Flesh and Blood（FaB）のイベント情報を統合し、iCal形式でカレンダーを提供するCloudflare Workersアプリケーション。

## 開発コマンド

```bash
# セットアップ
cd batch
yarn install

# ローカル開発（scheduled eventをテスト可能）
yarn dev

# ローカルでのiCal生成テスト（Cloudflare環境不要）
yarn tsx src/local.ts

# Cloudflare Workersへのデプロイ
yarn deploy
```

## アーキテクチャ

### データフロー
1. **scheduled event** (毎時0分) → Cloudflare Workerが起動
2. **公式イベント取得**: `gem.fabtcg.com` APIから品川区周辺のイベント情報を取得
3. **外部カレンダー統合**: Fable Tokyo・Tokyo FABのGoogle Calendar (iCal形式) を取得
4. **重複削除**: 時刻・場所・フォーマットを比較して重複イベントを除去（外部イベント優先）
5. **iCal生成**: 統合されたイベントからiCalファイルを生成
6. **R2保存**: `calendar.ics` をCloudflare R2バケット (`kanto-fab-events-ical`) に保存

### 主要コンポーネント (`batch/src/index.ts`)

- `scrapeEventFinder()`: 公式API (`gem.fabtcg.com/api/v1/locator/events/`) からイベント情報を取得
- `fetchExternalEvents()`: 外部iCalフィードから繰り返しイベントを展開して取得
- `removeDuplicateEvents()`: 重複削除ロジック（時刻30分以内・同一店舗・同一フォーマット）
- `generateIcal()`: ical-generatorを使用してiCal形式に変換

### タイムゾーン処理の重要な注意点

- 公式APIから取得した日時はJSTとして扱う（`new Date()` で直接パース）
- 外部iCalの日時はCloudflare環境では9時間加算が必要（`ENV=cloudflare`時）
- ical-generatorに渡す際は `timezone: 'Asia/Tokyo'` を指定

### ローカル開発とCloudflare環境の違い

- `local.ts`: R2バケット不要でローカルファイル (`calendar.ics`) に出力
- Cloudflare環境: `ENV=cloudflare` 環境変数が設定され、タイムゾーン変換が適用される
- `yarn dev` でCloudflare Workers環境をエミュレート（scheduled eventのテスト可能）

## Cloudflare設定

- **Cron**: `0 * * * *` (毎時0分実行)
- **R2バケット**: `kanto-fab-events-ical` (binding名: `BUCKET`)
- **環境変数**: `ENV=cloudflare`

## デプロイフロー

PRマージ時、Cloudflare PagesのCIが自動的にデプロイ環境を作成してコメントに投稿します。動作確認後、mainブランチにマージすることで本番環境に反映されます。