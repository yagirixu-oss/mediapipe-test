import { createWriteStream } from "node:fs";
import { copyFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { get } from "node:https";

// ---------------------------------------------------------------------------
// MediaPipe ローカル同梱アセット同期
// ---------------------------------------------------------------------------
// 実行時の Electron アプリは CDN / Google Storage へ接続しない。
// そのため、開発時または make 前にこのスクリプトで必要な JS / WASM / model を
// renderer 配下へ揃えておく。
// ---------------------------------------------------------------------------

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = dirname(SCRIPT_DIR);
const TASKS_VISION_ROOT = join(PROJECT_ROOT, "node_modules", "@mediapipe", "tasks-vision");
const RENDERER_DIR = join(PROJECT_ROOT, "renderer");
const VENDOR_DIR = join(RENDERER_DIR, "vendor", "tasks-vision");
const VENDOR_WASM_DIR = join(VENDOR_DIR, "wasm");
const MODELS_DIR = join(RENDERER_DIR, "models");

const TASKS_VISION_FILES = [
  {
    from: join(TASKS_VISION_ROOT, "vision_bundle.mjs"),
    to: join(VENDOR_DIR, "vision_bundle.mjs"),
  },
  {
    from: join(TASKS_VISION_ROOT, "wasm", "vision_wasm_internal.js"),
    to: join(VENDOR_WASM_DIR, "vision_wasm_internal.js"),
  },
  {
    from: join(TASKS_VISION_ROOT, "wasm", "vision_wasm_internal.wasm"),
    to: join(VENDOR_WASM_DIR, "vision_wasm_internal.wasm"),
  },
  {
    from: join(TASKS_VISION_ROOT, "wasm", "vision_wasm_module_internal.js"),
    to: join(VENDOR_WASM_DIR, "vision_wasm_module_internal.js"),
  },
  {
    from: join(TASKS_VISION_ROOT, "wasm", "vision_wasm_module_internal.wasm"),
    to: join(VENDOR_WASM_DIR, "vision_wasm_module_internal.wasm"),
  },
  {
    from: join(TASKS_VISION_ROOT, "wasm", "vision_wasm_nosimd_internal.js"),
    to: join(VENDOR_WASM_DIR, "vision_wasm_nosimd_internal.js"),
  },
  {
    from: join(TASKS_VISION_ROOT, "wasm", "vision_wasm_nosimd_internal.wasm"),
    to: join(VENDOR_WASM_DIR, "vision_wasm_nosimd_internal.wasm"),
  },
];

const MODEL_FILES = [
  {
    name: "face_landmarker.task",
    url: "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task",
  },
  {
    name: "selfie_multiclass_256x256.tflite",
    url: "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite",
  },
];

// ---------------------------------------------------------------------------
// ファイル存在確認
// ---------------------------------------------------------------------------
// stat() はファイルが無いと例外を投げるため、この関数で true / false に変換する。
// 「モデルが無いときだけ初回ダウンロードする」判定の根幹になる。
// ---------------------------------------------------------------------------
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

// ---------------------------------------------------------------------------
// node_modules 側の必須ファイル確認
// ---------------------------------------------------------------------------
// @mediapipe/tasks-vision のバージョンやファイル構成が変わった場合、
// 何が足りないかを早い段階で分かるように明示的なエラーにする。
// ---------------------------------------------------------------------------
async function assertSourceExists(path) {
  if (!(await exists(path))) {
    throw new Error(`Required MediaPipe source file is missing: ${path}`);
  }
}

// ---------------------------------------------------------------------------
// MediaPipe Tasks Vision 本体 / WASM のコピー
// ---------------------------------------------------------------------------
// ここが「CDN から読む構成」から「アプリ内のローカルファイルを読む構成」へ
// 切り替えるための根幹部分。
// ---------------------------------------------------------------------------
async function copyTasksVisionRuntime() {
  // npm 依存に固定した @mediapipe/tasks-vision から、実行時に読むファイルだけを
  // renderer/vendor/tasks-vision へコピーする。
  await mkdir(VENDOR_WASM_DIR, { recursive: true });

  for (const file of TASKS_VISION_FILES) {
    await assertSourceExists(file.from);
    await mkdir(dirname(file.to), { recursive: true });
    await copyFile(file.from, file.to);
    console.log(`copied ${file.to}`);
  }
}

// ---------------------------------------------------------------------------
// 開発時モデル取得
// ---------------------------------------------------------------------------
// この関数は npm run sync:mediapipe 実行時だけ使う。
// renderer/app.js からは呼ばないため、配布済みアプリの実行中に
// Google Storage へアクセスすることはない。
// ---------------------------------------------------------------------------
function downloadFile(url, destination) {
  return new Promise((resolve, reject) => {
    const request = get(url, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error(`Failed to download ${url}: HTTP ${response.statusCode}`));
        return;
      }

      pipeline(response, createWriteStream(destination)).then(resolve, reject);
    });

    request.on("error", reject);
  });
}

// ---------------------------------------------------------------------------
// モデルファイル準備
// ---------------------------------------------------------------------------
// 既に renderer/models に保存済みなら何もしない。
// 無い場合だけ開発PCで一度取得し、以後は make / start 時に同じローカルファイルを使う。
// ---------------------------------------------------------------------------
async function ensureModelFiles() {
  // モデルは開発時に一度だけ取得する。
  // renderer/app.js にはダウンロード処理を入れず、配布済みアプリはここで保存済みの
  // renderer/models/* だけを読む。
  await mkdir(MODELS_DIR, { recursive: true });

  for (const model of MODEL_FILES) {
    const destination = join(MODELS_DIR, model.name);
    if (await exists(destination)) {
      console.log(`exists ${destination}`);
      continue;
    }

    console.log(`downloading ${model.name}`);
    await downloadFile(model.url, destination);
    console.log(`saved ${destination}`);
  }
}

await copyTasksVisionRuntime();
await ensureModelFiles();
