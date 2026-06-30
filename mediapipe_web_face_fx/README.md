# MediaPipe Web Face FX Studio

VS Code の Go Live でそのまま動かせる、静的な JavaScript 版 MediaPipe 顔加工デモ。
友人へ送る場合は、この `mediapipe_web_face_fx` フォルダごと渡せばよい。

## 何を作ったか

Python の `run_vision_demo.py` / `run_all_in_one_demo.py` は、MediaPipe を触るためのローカル実験コードだった。
チーム用途では Web アプリ化が前提なので、このフォルダでは顔加工アプリ寄りに寄せて作り直している。

今回は用途に合わせて、`Face Landmarker` と `Image Segmenter` を使っている。
SNOW 系の土台として、顔の基準点取得、頭部マスク取得、Canvas 上のエフェクト差し込み、一時保存ギャラリーをまとめて確認できる。

## 機能

- Web カメラのライブ顔トラッキング
- 画像アップロードに対する頭部加工確認
- Face Landmarker による顔ランドマーク取得
- Image Segmenter による頭部マスク取得
- PNG ステッカー貼り付け
- スクエア頭部変形
- 三角頭部変形
- blendshape の円グラフ表示
- 撮影結果の一時ギャラリー保存
- 選択した一時保存画像の PNG 保存
- `effects` 配列によるエフェクト管理

## 友人側で必要なもの

- VS Code
- VS Code 拡張機能の Live Server / Go Live
- Chrome または Edge などのカメラ対応ブラウザ
- インターネット接続

MediaPipe 本体、WASM、顔モデル、セグメンテーションモデルは CDN / Google Storage から読む。
そのため、初回起動時やネットがない環境では動かない。

## Go Live での起動

1. VS Code で `mediapipe_web_face_fx` フォルダを開く
2. [index.html](/C:/Users/yagir/Desktop/AI/mediapipe_web_face_fx/index.html) を表示する
3. Go Live を実行する
4. ブラウザで開かれたページ上で `カメラ開始` を押す

`localhost` / `127.0.0.1` 上で開かれるので、カメラ権限もそのまま扱いやすい。
`index.html` をダブルクリックして直接開く方法は、ブラウザの制限でカメラや ES module が不安定になるため避ける。

## 送るときの注意

- `mediapipe_web_face_fx` フォルダを ZIP にして送る
- 友人側で ZIP を展開してから VS Code で開く
- `index.html` を Go Live で起動する
- ブラウザでカメラ許可を求められたら許可する
- 起動直後に少し待つ。MediaPipe モデルの読み込みが終わるまで時間がかかることがある

## ファイル構成

- [index.html](/C:/Users/yagir/Desktop/AI/mediapipe_web_face_fx/index.html)
  画面構成と UI
- [styles.css](/C:/Users/yagir/Desktop/AI/mediapipe_web_face_fx/styles.css)
  見た目
- [app.js](/C:/Users/yagir/Desktop/AI/mediapipe_web_face_fx/app.js)
  MediaPipe 初期化、カメラ処理、画像解析、エフェクト登録、ギャラリー保存、Canvas 描画

## 実装方針

- ビルド不要
- CDN の `@mediapipe/tasks-vision` を利用
- 公式 Face Landmarker モデルを直接読む
- 公式 Image Segmenter モデルを直接読む
- 1 face 前提で、顔加工の試作に必要な構成へ絞る
- MediaPipe は顔の基準点取得に使い、加工は Canvas エフェクトとして追加する

## 新しいエフェクトの追加手順

`app.js` では、エフェクトを `effects` 配列で管理している。
基本は「エフェクト関数を作る」「`createEffect(...)` で登録する」の2段階。

```js
function blushEffect(effectContext) {
  effectContext.trackedFaces.forEach(({ bounds }) => {
    const cheekY = bounds.centerY + bounds.faceH * 0.12;
    effectContext.ctx.fillStyle = "rgba(239, 71, 111, 0.28)";
    effectContext.ctx.beginPath();
    effectContext.ctx.arc(bounds.centerX - bounds.faceW * 0.28, cheekY, 24, 0, Math.PI * 2);
    effectContext.ctx.arc(bounds.centerX + bounds.faceW * 0.28, cheekY, 24, 0, Math.PI * 2);
    effectContext.ctx.fill();
  });
}

const effects = [
  createEffect({
    id: "squareHead",
    run: squareHeadEffect,
    enabledParam: "squareHeadEnabled",
  }),
  createEffect({
    id: "blush",
    run: blushEffect,
    enabledParam: "blushEnabled",
  }),
  createEffect({
    id: "debugRoi",
    run: debugRoiEffect,
    enabledParam: "debugRoiEnabled",
  }),
];
```

UI で ON/OFF やスライダーを追加したい場合は、HTML の input に `data-effect-param` を付ける。
すると `app.js` の `currentParams()` と再描画イベントに自動で入る。

```html
<input type="checkbox" data-effect-param="blushEnabled" checked />
<input type="range" min="0" max="1" step="0.05" value="0.5" data-effect-param="blushPower" />
```

## 次に足しやすいもの

- PNG 素材を外部ファイルとして読み込むステッカー
- `FaceStylizer` を使った画像専用のスタイル変換
- 複数顔対応
- Web Worker 化による UI ブロック軽減

## 参照

- Face Landmarker Web ガイド:
  [Google AI Edge](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker/web_js?hl=ja)
- Image Segmenter Web ガイド:
  [Google AI Edge](https://ai.google.dev/edge/mediapipe/solutions/vision/image_segmenter/web_js?hl=ja)
- tasks-vision JS API:
  [Google AI Edge API](https://ai.google.dev/edge/api/mediapipe/js/tasks-vision)
