# カード合成（AI切り抜き） - Vanilla JS

GitHub Pages でそのまま動かせる「静的 Web アプリ」ひな形です。

## できること
- カード枠画像（背景・フレーム・文字込み）を読み込む
- 手描きキャラの写真を読み込む（ファイル or カメラ）
- 前処理（影ムラ補正・明るさ/コントラスト/ガンマ・シャープ・自動トリミング）
- Transformers.js + BRIA RMBG-1.4 で背景除去 → 透過PNG化
- 枠と合成（ドラッグ/ピンチ/回転/左右反転）
- PNG書き出し（保存） / 共有（対応端末）

## 使い方（ローカル）
VS Code でこのフォルダを開いて、Live Server などで `index.html` を開いてください。
（モデルのDLが走るので **file:// 直開きは避ける**のが無難です）

## デプロイ（GitHub Pages）
1. このフォルダ内容を GitHub リポジトリ直下に置く
2. Settings → Pages → Branch を `main` / `/ (root)` に設定
3. 数分待つとURLが発行されます

## 注意
- Webだけだと「写真アプリへ自動保存」は基本できないので、保存は「ダウンロード」になります。
- AI切り抜きは端末性能に依存します（古いスマホは重い場合あり）。
- うまく抜けない時は「影ムラ補正ON」「コントラスト↑」「ガンマ↓」を試してください。

## 参照
- Transformers.js（ブラウザで推論） https://huggingface.co/docs/transformers.js/
- RMBG-1.4 https://huggingface.co/briaai/RMBG-1.4
