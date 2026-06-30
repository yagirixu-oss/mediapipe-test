import vision from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/vision_bundle.js";

const { FaceLandmarker, FilesetResolver, ImageSegmenter } = vision;

// ---------------------------------------------------------------------------
// MediaPipe / 永続化の基本設定
// このファイル全体の根幹となる定数群。
// どの推論モデルを使うか、どのストレージへ一時保存するかをここで固定する。
// ---------------------------------------------------------------------------

const WASM_ROOT = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm";
const FACE_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";
const SEGMENTATION_MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite";

const GALLERY_DB_NAME = "face-fx-studio";
const GALLERY_STORE_NAME = "temporary-captures";
const BLENDSHAPE_COLORS = ["#ef476f", "#f78c6b", "#ffb703", "#0ea5e9", "#7c3aed"];

// ---------------------------------------------------------------------------
// セグメンテーションカテゴリ定義
// Image Segmenter の categoryMask は 0 始まりで返る。
// 頭部変形では hair + faceSkin を「頭部」、background 以外を「人物」として扱う。
// ---------------------------------------------------------------------------

const SEGMENTATION_CATEGORY = {
  background: 0,
  hair: 1,
  bodySkin: 2,
  faceSkin: 3,
  clothes: 4,
  others: 5,
};

// ---------------------------------------------------------------------------
// MediaPipe の顔ランドマークで、今回の MVP に必要な基準点だけを抜き出すための番号定義
// ここを共通化しておくことで、他のエフェクト関数が「どの点を見ているのか」を追いやすくする。
// ---------------------------------------------------------------------------

const FACE_LANDMARK_INDEX = {
  noseTip: 1,
  leftEyeOuter: 33,
  leftEyeInner: 133,
  rightEyeInner: 362,
  rightEyeOuter: 263,
  mouthUpper: 13,
  mouthLower: 14,
};

// ---------------------------------------------------------------------------
// エフェクトメタ情報
// 実際の描画処理とは分けて、UI に見せるタイトルや説明だけを持たせる。
// 後から他班のエフェクトを足すときも、まずここへ 1 件追加すれば画面側へ出しやすい。
// ---------------------------------------------------------------------------

const EFFECT_METADATA = {
  faceSticker: {
    title: "PNG ステッカー貼り付け",
    shortLabel: "PNG ステッカー",
    description:
      "顔の目元を基準に PNG ステッカーを重ねる。画像素材を貼るタイプのエフェクトを足すときの土台。",
  },
  squareHead: {
    title: "スクエア頭部変形",
    shortLabel: "スクエア頭部",
    description:
      "hair + face-skin の頭部マスクを使い、代表中心から左右へ四角く引き延ばす。",
  },
  triangleHead: {
    title: "三角頭部変形",
    shortLabel: "三角頭部",
    description:
      "hair + face-skin の頭部マスクを使い、上を広く下を細くして三角形に変形する。",
  },
};

// ---------------------------------------------------------------------------
// アプリ状態
// 現在の入力ソース、MediaPipe の準備状況、ギャラリー内容、選択中エフェクトなど、
// 画面全体で共有する情報をここへまとめる。
// ---------------------------------------------------------------------------

const state = {
  appScreen: "capture",
  detectors: {
    face: null,
    hand: null,
    pose: null,
    segmentation: null,
  },
  runningMode: "IMAGE",
  lastVideoTime: -1,
  animationFrameId: 0,
  webcamStream: null,
  sourceMode: "idle",
  currentImage: null,
  currentImageObjectUrl: null,
  isCameraActive: false,
  activeEffectId: "faceSticker",
  assets: {
    faceSticker: null,
  },
  galleryDbPromise: null,
  temporaryCaptures: [],
  selectedCaptureId: null,
  lastDetectionSnapshot: null,
  captureFeedbackTimerId: 0,
  isCaptureFeedbackActive: false,
};

// ---------------------------------------------------------------------------
// DOM 参照
// 画面部品を毎回 query し直さないためのキャッシュ。
// UI 制御と描画制御の接点になるため、どの id が何の役割かを追いやすくしておく。
// ---------------------------------------------------------------------------

const elements = {
  startCameraButton: document.getElementById("startCameraButton"),
  stopCameraButton: document.getElementById("stopCameraButton"),
  saveToGalleryButton: document.getElementById("saveToGalleryButton"),
  openGalleryButton: document.getElementById("openGalleryButton"),
  downloadSelectedShotButton: document.getElementById("downloadSelectedShotButton"),
  deleteSelectedShotButton: document.getElementById("deleteSelectedShotButton"),
  backToCaptureButton: document.getElementById("backToCaptureButton"),
  imageInput: document.getElementById("imageInput"),
  activeEffectSelect: document.getElementById("activeEffectSelect"),
  effectRail: document.getElementById("effectRail"),
  activeEffectTitle: document.getElementById("activeEffectTitle"),
  activeEffectDescription: document.getElementById("activeEffectDescription"),
  sourceModeLabel: document.getElementById("sourceModeLabel"),
  faceCountLabel: document.getElementById("faceCountLabel"),
  handCountLabel: document.getElementById("handCountLabel"),
  poseCountLabel: document.getElementById("poseCountLabel"),
  segmentationLabel: document.getElementById("segmentationLabel"),
  trackingEffectLabel: document.getElementById("trackingEffectLabel"),
  statusLabel: document.getElementById("statusLabel"),
  galleryStatusLabel: document.getElementById("galleryStatusLabel"),
  temporaryGallery: document.getElementById("temporaryGallery"),
  captureScreen: document.getElementById("captureScreen"),
  galleryScreen: document.getElementById("galleryScreen"),
  galleryPreviewImage: document.getElementById("galleryPreviewImage"),
  galleryPreviewEmpty: document.getElementById("galleryPreviewEmpty"),
  galleryPreviewTitle: document.getElementById("galleryPreviewTitle"),
  galleryPreviewDescription: document.getElementById("galleryPreviewDescription"),
  blendshapeChart: document.getElementById("blendshapeChart"),
  blendshapeList: document.getElementById("blendshapeList"),
  cameraFeed: document.getElementById("cameraFeed"),
  uploadedPreview: document.getElementById("uploadedPreview"),
  captureFreezeOverlay: document.getElementById("captureFreezeOverlay"),
  captureFlashOverlay: document.getElementById("captureFlashOverlay"),
  outputCanvas: document.getElementById("outputCanvas"),
};

// ---------------------------------------------------------------------------
// UI パラメータ読み取り
// data-effect-param を付けた input は、描画側のパラメータ辞書へ自動で入る。
// これによりエフェクト追加時の HTML / JS の結線を最小限にできる。
// ---------------------------------------------------------------------------

const effectControlElements = [...document.querySelectorAll("[data-effect-param]")];
const effectPanelElements = [...document.querySelectorAll("[data-effect-panel]")];
const effectChoiceElements = [...document.querySelectorAll("[data-effect-choice]")];

const canvasContext = elements.outputCanvas.getContext("2d");
const blendshapeChartContext = elements.blendshapeChart?.getContext("2d") || null;
const frameBufferCanvas = document.createElement("canvas");
const frameBufferContext = frameBufferCanvas.getContext("2d");
const personLayerCanvas = document.createElement("canvas");
const personLayerContext = personLayerCanvas.getContext("2d");
const stageFrameElement = elements.outputCanvas.closest(".stage-frame");

// ---------------------------------------------------------------------------
// 基本 UI ヘルパー
// 画面文言の更新や、共通的な数値補助だけを置く。
// 「見た目の更新」と「推論 / 描画そのもの」を分けて追えるようにするための層。
// ---------------------------------------------------------------------------

function setStatus(message) {
  if (elements.statusLabel) {
    elements.statusLabel.textContent = message;
  }
}

function setSourceModeLabel(label) {
  if (elements.sourceModeLabel) {
    elements.sourceModeLabel.textContent = label;
  }
}

function setTrackingEffectLabel(label) {
  if (elements.trackingEffectLabel) {
    elements.trackingEffectLabel.textContent = label;
  }
}

function setAppScreen(screen) {
  // ここが画面遷移の根幹。
  // 撮影画面とギャラリー画面を hidden 切り替えだけで入れ替え、
  // 後から Editor 画面を足す場合も同じ考え方で増やせるようにしている。
  state.appScreen = screen;
  elements.captureScreen.hidden = screen !== "capture";
  elements.galleryScreen.hidden = screen !== "gallery";
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function lerp(start, end, amount) {
  return start + (end - start) * amount;
}

function formatCaptureTime(isoString) {
  const date = new Date(isoString);
  return `${date.getMonth() + 1}/${date.getDate()} ${date.getHours().toString().padStart(2, "0")}:${date
    .getMinutes()
    .toString()
    .padStart(2, "0")}`;
}

function createCaptureId() {
  if (globalThis.crypto?.randomUUID) {
    return crypto.randomUUID();
  }
  return `capture-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function readEffectControlValue(control) {
  if (control.type === "checkbox") {
    return control.checked;
  }

  if (control.type === "range" || control.type === "number") {
    return Number(control.value);
  }

  return control.value;
}

function currentParams() {
  return effectControlElements.reduce((params, control) => {
    params[control.dataset.effectParam] = readEffectControlValue(control);
    return params;
  }, {});
}

function resizeCanvas(width, height) {
  if (elements.outputCanvas.width !== width || elements.outputCanvas.height !== height) {
    elements.outputCanvas.width = width;
    elements.outputCanvas.height = height;
  }

  if (frameBufferCanvas.width !== width || frameBufferCanvas.height !== height) {
    frameBufferCanvas.width = width;
    frameBufferCanvas.height = height;
  }

  if (personLayerCanvas.width !== width || personLayerCanvas.height !== height) {
    personLayerCanvas.width = width;
    personLayerCanvas.height = height;
  }
}

function drawBaseSource(source, mirror) {
  const { width, height } = elements.outputCanvas;
  canvasContext.save();
  canvasContext.clearRect(0, 0, width, height);
  if (mirror) {
    canvasContext.translate(width, 0);
    canvasContext.scale(-1, 1);
  }
  canvasContext.drawImage(source, 0, 0, width, height);
  canvasContext.restore();

  frameBufferContext.clearRect(0, 0, width, height);
  frameBufferContext.drawImage(elements.outputCanvas, 0, 0);
}

function updateStageVisibility() {
  elements.cameraFeed.style.opacity = state.sourceMode === "camera" ? "1" : "0";
  elements.uploadedPreview.style.opacity = state.sourceMode === "image" ? "1" : "0";
}

function clearCaptureFeedback() {
  if (state.captureFeedbackTimerId) {
    clearTimeout(state.captureFeedbackTimerId);
    state.captureFeedbackTimerId = 0;
  }

  state.isCaptureFeedbackActive = false;
  elements.saveToGalleryButton.disabled = false;
  elements.captureFreezeOverlay.removeAttribute("src");
  elements.captureFreezeOverlay.style.opacity = "0";
  stageFrameElement.classList.remove("is-capturing");
}

function playCaptureFeedback() {
  // 撮影時の視覚フィードバック。
  // 現在のプレビューを一瞬固定表示し、その上から白フラッシュを重ねることで
  // 「今撮れた」とユーザーが即座に分かるようにする。
  if (!elements.outputCanvas.width || !elements.outputCanvas.height) {
    return;
  }

  clearCaptureFeedback();
  state.isCaptureFeedbackActive = true;
  elements.saveToGalleryButton.disabled = true;
  elements.captureFreezeOverlay.src = elements.outputCanvas.toDataURL("image/png");
  elements.captureFreezeOverlay.style.opacity = "1";
  stageFrameElement.classList.add("is-capturing");
  state.captureFeedbackTimerId = window.setTimeout(() => {
    clearCaptureFeedback();
  }, 240);
}

function resetTrackingUi() {
  if (elements.faceCountLabel) {
    elements.faceCountLabel.textContent = "0";
  }
  if (elements.handCountLabel) {
    elements.handCountLabel.textContent = "0";
  }
  if (elements.poseCountLabel) {
    elements.poseCountLabel.textContent = "0";
  }
  if (elements.segmentationLabel) {
    elements.segmentationLabel.textContent = "off";
  }
  drawBlendshapeChart([]);
  if (elements.blendshapeList) {
    elements.blendshapeList.innerHTML = "<li>入力待ち</li>";
  }
}

// ---------------------------------------------------------------------------
// blendshape 表示
// 顔が今どんな表情に近いかを数値で確認するための補助表示。
// AI / エフェクト班が口開きなどの条件を見るときの観察口にもなる。
// ---------------------------------------------------------------------------

function topBlendshapeItems(faceResult, limit = 5) {
  if (!faceResult.faceBlendshapes?.length) {
    return [];
  }

  return [...faceResult.faceBlendshapes[0].categories]
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
    .map((item) => ({
      name: item.categoryName,
      score: item.score,
    }));
}

function drawBlendshapeChart(items) {
  if (!elements.blendshapeChart || !blendshapeChartContext) {
    return;
  }

  const { width, height } = elements.blendshapeChart;
  const centerX = width / 2;
  const centerY = height / 2;
  const radius = 96;
  const innerRadius = 52;

  blendshapeChartContext.clearRect(0, 0, width, height);

  if (!items.length) {
    blendshapeChartContext.save();
    blendshapeChartContext.fillStyle = "rgba(31, 39, 33, 0.08)";
    blendshapeChartContext.beginPath();
    blendshapeChartContext.arc(centerX, centerY, radius, 0, Math.PI * 2);
    blendshapeChartContext.fill();
    blendshapeChartContext.fillStyle = "rgba(31, 39, 33, 0.14)";
    blendshapeChartContext.beginPath();
    blendshapeChartContext.arc(centerX, centerY, innerRadius, 0, Math.PI * 2);
    blendshapeChartContext.fill();
    blendshapeChartContext.fillStyle = "#5d665f";
    blendshapeChartContext.font = '600 15px "Segoe UI", "Yu Gothic UI", sans-serif';
    blendshapeChartContext.textAlign = "center";
    blendshapeChartContext.fillText("No face", centerX, centerY + 5);
    blendshapeChartContext.restore();
    return;
  }

  const total = items.reduce((sum, item) => sum + item.score, 0) || 1;
  let startAngle = -Math.PI / 2;
  items.forEach((item, index) => {
    const sliceAngle = (item.score / total) * Math.PI * 2;
    blendshapeChartContext.save();
    blendshapeChartContext.beginPath();
    blendshapeChartContext.moveTo(centerX, centerY);
    blendshapeChartContext.arc(centerX, centerY, radius, startAngle, startAngle + sliceAngle);
    blendshapeChartContext.closePath();
    blendshapeChartContext.fillStyle = BLENDSHAPE_COLORS[index % BLENDSHAPE_COLORS.length];
    blendshapeChartContext.fill();
    blendshapeChartContext.restore();
    startAngle += sliceAngle;
  });

  blendshapeChartContext.save();
  blendshapeChartContext.beginPath();
  blendshapeChartContext.arc(centerX, centerY, innerRadius, 0, Math.PI * 2);
  blendshapeChartContext.fillStyle = "#fffaf2";
  blendshapeChartContext.fill();
  blendshapeChartContext.fillStyle = "#1f2721";
  blendshapeChartContext.textAlign = "center";
  blendshapeChartContext.font = '700 14px "Segoe UI", "Yu Gothic UI", sans-serif';
  blendshapeChartContext.fillText("Top", centerX, centerY - 8);
  blendshapeChartContext.font = '700 18px "Segoe UI", "Yu Gothic UI", sans-serif';
  blendshapeChartContext.fillText(items[0].score.toFixed(2), centerX, centerY + 18);
  blendshapeChartContext.restore();
}

function renderBlendshapeList(items) {
  drawBlendshapeChart(items);

  if (!elements.blendshapeList) {
    return;
  }

  if (!items.length) {
    elements.blendshapeList.innerHTML = "<li>顔未検出、または blendshape 無効</li>";
    return;
  }

  elements.blendshapeList.innerHTML = items
    .map(
      (item, index) =>
        `<li><span style="display:inline-block;width:10px;height:10px;border-radius:999px;background:${BLENDSHAPE_COLORS[index % BLENDSHAPE_COLORS.length]};margin-right:8px;"></span>${item.name}: ${item.score.toFixed(3)}</li>`
    )
    .join("");
}

// ---------------------------------------------------------------------------
// 認識層
// MediaPipe の生データを、そのままエフェクト関数へ投げるのではなく、
// 描画側が使いやすい detection snapshot に整形する。
// この分離が、将来 hand / pose / segmentation を足すときの要になる。
// ---------------------------------------------------------------------------

function pointFromLandmark(landmark, mirror, width, height) {
  const x = landmark.x * width;
  return {
    x: mirror ? width - x : x,
    y: landmark.y * height,
  };
}

function landmarkPointAt(landmarks, index, mirror, width, height) {
  return pointFromLandmark(landmarks[index], mirror, width, height);
}

function averagePoints(points) {
  const total = points.reduce(
    (sum, point) => ({
      x: sum.x + point.x,
      y: sum.y + point.y,
    }),
    { x: 0, y: 0 }
  );

  return {
    x: total.x / Math.max(1, points.length),
    y: total.y / Math.max(1, points.length),
  };
}

function computeFaceBounds(landmarks, width, height, mirror) {
  let faceMinX = Number.POSITIVE_INFINITY;
  let faceMaxX = Number.NEGATIVE_INFINITY;
  let faceMinY = Number.POSITIVE_INFINITY;
  let faceMaxY = Number.NEGATIVE_INFINITY;

  landmarks.forEach((landmark) => {
    const point = pointFromLandmark(landmark, mirror, width, height);
    faceMinX = Math.min(faceMinX, point.x);
    faceMaxX = Math.max(faceMaxX, point.x);
    faceMinY = Math.min(faceMinY, point.y);
    faceMaxY = Math.max(faceMaxY, point.y);
  });

  const faceW = Math.max(1, faceMaxX - faceMinX);
  const faceH = Math.max(1, faceMaxY - faceMinY);
  const centerX = (faceMinX + faceMaxX) / 2;
  const centerY = (faceMinY + faceMaxY) / 2;

  return {
    faceMinX,
    faceMaxX,
    faceMinY,
    faceMaxY,
    faceW,
    faceH,
    centerX,
    centerY,
  };
}

function computeFaceAnchors(landmarks, width, height, mirror) {
  const leftEyeOuter = landmarkPointAt(landmarks, FACE_LANDMARK_INDEX.leftEyeOuter, mirror, width, height);
  const leftEyeInner = landmarkPointAt(landmarks, FACE_LANDMARK_INDEX.leftEyeInner, mirror, width, height);
  const rightEyeInner = landmarkPointAt(landmarks, FACE_LANDMARK_INDEX.rightEyeInner, mirror, width, height);
  const rightEyeOuter = landmarkPointAt(landmarks, FACE_LANDMARK_INDEX.rightEyeOuter, mirror, width, height);
  const noseTip = landmarkPointAt(landmarks, FACE_LANDMARK_INDEX.noseTip, mirror, width, height);
  const mouthUpper = landmarkPointAt(landmarks, FACE_LANDMARK_INDEX.mouthUpper, mirror, width, height);
  const mouthLower = landmarkPointAt(landmarks, FACE_LANDMARK_INDEX.mouthLower, mirror, width, height);

  const leftEyeCenter = averagePoints([leftEyeOuter, leftEyeInner]);
  const rightEyeCenter = averagePoints([rightEyeOuter, rightEyeInner]);
  const mouthCenter = averagePoints([mouthUpper, mouthLower]);

  return {
    leftEyeOuter,
    leftEyeInner,
    rightEyeInner,
    rightEyeOuter,
    leftEyeCenter,
    rightEyeCenter,
    noseTip,
    mouthUpper,
    mouthLower,
    mouthCenter,
  };
}

function computeSquareRoi(faceBounds, params) {
  const intensityBoost = lerp(0.96, 1.08, clamp(params.intensity / 1.3, 0, 1));
  const squareSize =
    Math.max(faceBounds.faceW, faceBounds.faceH) * (params.squareScale || 1.8) * intensityBoost;
  const squareX = faceBounds.centerX + faceBounds.faceW * (params.headXOffset || 0) - squareSize / 2;
  const squareY = faceBounds.faceMinY - faceBounds.faceH * (params.topOffset || 0.35);

  return {
    squareSize,
    squareX,
    squareY,
    centerX: faceBounds.centerX + faceBounds.faceW * (params.headXOffset || 0),
    centerY: squareY + squareSize / 2,
  };
}

function clampSourceRect(x, y, width, height, frameWidth, frameHeight) {
  const clampedWidth = Math.min(width, frameWidth);
  const clampedHeight = Math.min(height, frameHeight);
  const clampedX = clamp(x, 0, frameWidth - clampedWidth);
  const clampedY = clamp(y, 0, frameHeight - clampedHeight);

  return {
    x: clampedX,
    y: clampedY,
    width: clampedWidth,
    height: clampedHeight,
  };
}

function computeSourceRect(faceBounds, squareRoi, params, frameWidth, frameHeight) {
  const intensityT = clamp((params.intensity || 0.8) / 1.3, 0, 1);
  const baseSourceW = faceBounds.faceW * lerp(1.06, 0.82, intensityT);
  const baseSourceH = faceBounds.faceH * lerp(1.18, 0.9, intensityT);

  const sourceTopBias = faceBounds.faceH * (0.18 + (params.topOffset || 0.35) * 0.55);
  const sourceBottomBias = faceBounds.faceH * 0.08;
  const sourceCenterY =
    (faceBounds.faceMinY - sourceTopBias + faceBounds.faceMaxY + sourceBottomBias) / 2;

  const sourceWidth = baseSourceW / Math.max(0.01, params.stretchX || 1.25);
  const sourceHeight =
    (baseSourceH + sourceTopBias + sourceBottomBias) / Math.max(0.01, params.stretchY || 0.9);

  const rawSourceX = faceBounds.centerX - sourceWidth / 2;
  const rawSourceY = sourceCenterY - sourceHeight / 2;
  const clampedRect = clampSourceRect(
    rawSourceX,
    rawSourceY,
    sourceWidth,
    sourceHeight,
    frameWidth,
    frameHeight
  );

  return {
    ...clampedRect,
    sourceCenterY,
    debugFillRateX: squareRoi.squareSize / Math.max(1, clampedRect.width),
    debugFillRateY: squareRoi.squareSize / Math.max(1, clampedRect.height),
  };
}

function buildTrackedFaces(faceLandmarks, sourceWidth, sourceHeight, mirror, params) {
  return faceLandmarks.map((landmarks) => {
    const bounds = computeFaceBounds(landmarks, sourceWidth, sourceHeight, mirror);
    const anchors = computeFaceAnchors(landmarks, sourceWidth, sourceHeight, mirror);
    const squareRoi = computeSquareRoi(bounds, params);
    const sourceRect = computeSourceRect(bounds, squareRoi, params, sourceWidth, sourceHeight);

    return {
      landmarks,
      bounds,
      anchors,
      squareRoi,
      sourceRect,
    };
  });
}

function categoryFromMaskValue(value) {
  return Math.round(value);
}

function isHeadCategory(category) {
  return category === SEGMENTATION_CATEGORY.hair || category === SEGMENTATION_CATEGORY.faceSkin;
}

function isPersonCategory(category) {
  return category !== SEGMENTATION_CATEGORY.background;
}

function createEmptyRowBounds(rowCount, frameWidth) {
  const minX = new Int32Array(rowCount);
  const maxX = new Int32Array(rowCount);
  minX.fill(frameWidth);
  maxX.fill(-1);
  return { minX, maxX };
}

function markRowBounds(rowBounds, rowIndex, x) {
  rowBounds.minX[rowIndex] = Math.min(rowBounds.minX[rowIndex], x);
  rowBounds.maxX[rowIndex] = Math.max(rowBounds.maxX[rowIndex], x);
}

function rowHasMask(rowBounds, rowIndex) {
  return rowBounds.maxX[rowIndex] >= rowBounds.minX[rowIndex];
}

function readCategoryMaskData(categoryMask) {
  // MediaPipe の categoryMask は環境により Uint8 / Float32 のどちらでも読めるため、
  // 描画層へ渡す前に 0-5 のカテゴリ値へ正規化する。
  if (!categoryMask) {
    return null;
  }

  if (typeof categoryMask.getAsUint8Array === "function") {
    return categoryMask.getAsUint8Array();
  }

  if (typeof categoryMask.getAsFloat32Array === "function") {
    return categoryMask.getAsFloat32Array();
  }

  return null;
}

function createEmptySegmentationSnapshot() {
  return {
    enabled: false,
    masks: [],
    categoryMask: null,
    frameCategories: null,
    headMask: {
      valid: false,
      rowBounds: createEmptyRowBounds(0, 0),
      center: { x: 0, y: 0 },
      bounds: null,
      height: 0,
      representativeHalfWidth: 0,
      pixelCount: 0,
    },
    personMask: {
      valid: false,
      rowBounds: createEmptyRowBounds(0, 0),
      bounds: null,
      pixelCount: 0,
    },
  };
}

function buildSegmentationSnapshot(segmentationResult, frameWidth, frameHeight, mirror) {
  const categoryMask = segmentationResult?.categoryMask;
  const maskData = readCategoryMaskData(categoryMask);

  if (!categoryMask || !maskData || !frameWidth || !frameHeight) {
    return createEmptySegmentationSnapshot();
  }

  const maskWidth = categoryMask.width || frameWidth;
  const maskHeight = categoryMask.height || Math.max(1, Math.floor(maskData.length / maskWidth));
  const frameCategories = new Uint8Array(frameWidth * frameHeight);
  const headRows = createEmptyRowBounds(frameHeight, frameWidth);
  const personRows = createEmptyRowBounds(frameHeight, frameWidth);

  let headPixelCount = 0;
  let personPixelCount = 0;
  let headSumX = 0;
  let headSumY = 0;
  let headMinX = frameWidth;
  let headMaxX = -1;
  let headMinY = frameHeight;
  let headMaxY = -1;
  let personMinX = frameWidth;
  let personMaxX = -1;
  let personMinY = frameHeight;
  let personMaxY = -1;

  for (let y = 0; y < frameHeight; y += 1) {
    const maskY = clamp(Math.floor((y / frameHeight) * maskHeight), 0, maskHeight - 1);

    for (let x = 0; x < frameWidth; x += 1) {
      const sourceX = mirror ? frameWidth - 1 - x : x;
      const maskX = clamp(Math.floor((sourceX / frameWidth) * maskWidth), 0, maskWidth - 1);
      const category = categoryFromMaskValue(maskData[maskY * maskWidth + maskX]);
      const frameIndex = y * frameWidth + x;
      frameCategories[frameIndex] = category;

      if (isPersonCategory(category)) {
        markRowBounds(personRows, y, x);
        personPixelCount += 1;
        personMinX = Math.min(personMinX, x);
        personMaxX = Math.max(personMaxX, x);
        personMinY = Math.min(personMinY, y);
        personMaxY = Math.max(personMaxY, y);
      }

      if (isHeadCategory(category)) {
        markRowBounds(headRows, y, x);
        headPixelCount += 1;
        headSumX += x;
        headSumY += y;
        headMinX = Math.min(headMinX, x);
        headMaxX = Math.max(headMaxX, x);
        headMinY = Math.min(headMinY, y);
        headMaxY = Math.max(headMaxY, y);
      }
    }
  }

  const headCenter = headPixelCount
    ? {
        x: headSumX / headPixelCount,
        y: headSumY / headPixelCount,
      }
    : { x: 0, y: 0 };
  const headHeight = headPixelCount ? headMaxY - headMinY + 1 : 0;
  const representativeHalfWidth = headPixelCount
    ? Math.max(headCenter.x - headMinX, headMaxX - headCenter.x, 1)
    : 0;

  return {
    enabled: true,
    masks: [categoryMask],
    categoryMask: {
      width: maskWidth,
      height: maskHeight,
    },
    frameCategories,
    headMask: {
      valid: headPixelCount > 0,
      rowBounds: headRows,
      center: headCenter,
      bounds: headPixelCount
        ? {
            minX: headMinX,
            maxX: headMaxX,
            minY: headMinY,
            maxY: headMaxY,
          }
        : null,
      height: headHeight,
      representativeHalfWidth,
      pixelCount: headPixelCount,
    },
    personMask: {
      valid: personPixelCount > 0,
      rowBounds: personRows,
      bounds: personPixelCount
        ? {
            minX: personMinX,
            maxX: personMaxX,
            minY: personMinY,
            maxY: personMaxY,
          }
        : null,
      pixelCount: personPixelCount,
    },
  };
}

function buildDetectionSnapshot(source, faceResult, segmentationResult, params, mirror) {
  const sourceWidth = source.videoWidth || source.naturalWidth || source.width;
  const sourceHeight = source.videoHeight || source.naturalHeight || source.height;
  const faceLandmarks = faceResult.faceLandmarks || [];
  const trackedFaces = buildTrackedFaces(faceLandmarks, sourceWidth, sourceHeight, mirror, params);
  const segmentation = buildSegmentationSnapshot(segmentationResult, sourceWidth, sourceHeight, mirror);

  return {
    sourceWidth,
    sourceHeight,
    face: {
      rawResult: faceResult,
      count: faceLandmarks.length,
      trackedFaces,
      blendshapeItems: topBlendshapeItems(faceResult),
    },
    hand: {
      count: 0,
      trackedHands: [],
    },
    pose: {
      count: 0,
      trackedPoses: [],
    },
    segmentation,
  };
}

function updateTrackingSummary(detectionSnapshot) {
  if (elements.faceCountLabel) {
    elements.faceCountLabel.textContent = String(detectionSnapshot.face.count);
  }
  if (elements.handCountLabel) {
    elements.handCountLabel.textContent = String(detectionSnapshot.hand.count);
  }
  if (elements.poseCountLabel) {
    elements.poseCountLabel.textContent = String(detectionSnapshot.pose.count);
  }
  if (elements.segmentationLabel) {
    elements.segmentationLabel.textContent = detectionSnapshot.segmentation.enabled ? "on" : "off";
  }
  renderBlendshapeList(detectionSnapshot.face.blendshapeItems);
}

// ---------------------------------------------------------------------------
// 描画層用アセット
// 「PNG を貼る系」の MVP を成立させるため、透過画像をコードで生成して読み込む。
// 実運用では他班の PNG ファイルへ差し替えればそのまま再利用できる構成にする。
// ---------------------------------------------------------------------------

function imageFromDataUrl(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = reject;
    image.src = dataUrl;
  });
}

async function createFaceStickerAsset() {
  const stickerCanvas = document.createElement("canvas");
  stickerCanvas.width = 512;
  stickerCanvas.height = 240;
  const stickerContext = stickerCanvas.getContext("2d");

  const leftLensX = 144;
  const rightLensX = 368;
  const lensY = 118;
  const lensWidth = 170;
  const lensHeight = 112;
  const bridgeWidth = 54;

  stickerContext.clearRect(0, 0, stickerCanvas.width, stickerCanvas.height);

  function drawLens(centerX) {
    stickerContext.save();
    stickerContext.fillStyle = "rgba(239, 71, 111, 0.52)";
    stickerContext.strokeStyle = "rgba(255, 255, 255, 0.88)";
    stickerContext.lineWidth = 8;
    stickerContext.beginPath();
    stickerContext.roundRect(centerX - lensWidth / 2, lensY - lensHeight / 2, lensWidth, lensHeight, 36);
    stickerContext.fill();
    stickerContext.stroke();

    stickerContext.fillStyle = "rgba(255, 255, 255, 0.16)";
    stickerContext.beginPath();
    stickerContext.roundRect(centerX - lensWidth / 2 + 16, lensY - lensHeight / 2 + 14, lensWidth * 0.42, 24, 12);
    stickerContext.fill();
    stickerContext.restore();
  }

  drawLens(leftLensX);
  drawLens(rightLensX);

  stickerContext.save();
  stickerContext.strokeStyle = "rgba(255, 255, 255, 0.92)";
  stickerContext.lineWidth = 10;
  stickerContext.lineCap = "round";
  stickerContext.beginPath();
  stickerContext.moveTo(leftLensX + lensWidth / 2 - 2, lensY);
  stickerContext.lineTo(rightLensX - lensWidth / 2 + 2, lensY);
  stickerContext.stroke();

  stickerContext.fillStyle = "rgba(255, 255, 255, 0.9)";
  stickerContext.beginPath();
  stickerContext.roundRect(
    stickerCanvas.width / 2 - bridgeWidth / 2,
    lensY - 10,
    bridgeWidth,
    20,
    10
  );
  stickerContext.fill();
  stickerContext.restore();

  function drawSparkle(x, y, scale, hue) {
    stickerContext.save();
    stickerContext.translate(x, y);
    stickerContext.scale(scale, scale);
    stickerContext.fillStyle = hue;
    stickerContext.beginPath();
    stickerContext.moveTo(0, -18);
    stickerContext.lineTo(8, -6);
    stickerContext.lineTo(20, 0);
    stickerContext.lineTo(8, 6);
    stickerContext.lineTo(0, 18);
    stickerContext.lineTo(-8, 6);
    stickerContext.lineTo(-20, 0);
    stickerContext.lineTo(-8, -6);
    stickerContext.closePath();
    stickerContext.fill();
    stickerContext.restore();
  }

  drawSparkle(64, 64, 1.3, "rgba(255, 183, 3, 0.92)");
  drawSparkle(456, 56, 1, "rgba(14, 165, 233, 0.92)");
  drawSparkle(420, 188, 0.9, "rgba(255, 255, 255, 0.86)");

  return imageFromDataUrl(stickerCanvas.toDataURL("image/png"));
}

async function ensureEffectAssets() {
  if (!state.assets.faceSticker) {
    state.assets.faceSticker = await createFaceStickerAsset();
  }
}

// ---------------------------------------------------------------------------
// 描画層
// 認識層が返した detection snapshot と、エフェクト定義を受けて実際に canvas へ描く。
// エフェクトは必ず run(effectContext) で統一し、UI 層から直接 canvas を触らせない。
// ---------------------------------------------------------------------------

function drawRoiDebug(squareRoi, sourceRect) {
  const { squareX, squareY, squareSize } = squareRoi;

  canvasContext.save();
  canvasContext.lineWidth = 3;
  canvasContext.strokeStyle = "rgba(255, 80, 80, 0.95)";
  canvasContext.setLineDash([12, 8]);
  canvasContext.strokeRect(squareX, squareY, squareSize, squareSize);

  canvasContext.fillStyle = "rgba(255, 80, 80, 0.14)";
  canvasContext.fillRect(squareX, squareY, squareSize, squareSize);

  canvasContext.setLineDash([6, 6]);
  canvasContext.strokeStyle = "rgba(255, 255, 255, 0.9)";
  canvasContext.strokeRect(sourceRect.x, sourceRect.y, sourceRect.width, sourceRect.height);

  canvasContext.fillStyle = "rgba(12, 16, 20, 0.68)";
  canvasContext.beginPath();
  canvasContext.roundRect(squareX, Math.max(8, squareY - 44), 228, 34, 12);
  canvasContext.fill();
  canvasContext.fillStyle = "#ffffff";
  canvasContext.font = '600 13px "Segoe UI", "Yu Gothic UI", sans-serif';
  canvasContext.fillText(
    `fill x${sourceRect.debugFillRateX.toFixed(2)} / y${sourceRect.debugFillRateY.toFixed(2)}`,
    squareX + 12,
    Math.max(30, squareY - 22)
  );
  canvasContext.restore();
}

function drawLandmarkBadge(faceBounds, label) {
  const boxWidth = Math.max(164, faceBounds.faceW * 0.96);
  const boxHeight = 34;
  const x = Math.max(16, faceBounds.centerX - boxWidth / 2);
  const y = Math.max(16, faceBounds.faceMinY - faceBounds.faceH * 0.42);

  canvasContext.save();
  canvasContext.fillStyle = "rgba(13, 18, 21, 0.58)";
  canvasContext.strokeStyle = "rgba(255, 255, 255, 0.18)";
  canvasContext.beginPath();
  canvasContext.roundRect(x, y, boxWidth, boxHeight, 16);
  canvasContext.fill();
  canvasContext.stroke();
  canvasContext.fillStyle = "#f8fafc";
  canvasContext.font = '600 14px "Segoe UI", "Yu Gothic UI", sans-serif';
  canvasContext.fillText(label, x + 14, y + 22);
  canvasContext.restore();
}

function createEffect({ id, requiredDetections, run }) {
  return {
    id,
    requiredDetections,
    ...EFFECT_METADATA[id],
    run,
  };
}

function faceStickerEffect(effectContext) {
  const stickerImage = effectContext.assets.faceSticker;
  const stickerScale = effectContext.params.stickerScale || 1.25;
  const stickerXOffset = effectContext.params.stickerXOffset || 0;
  const stickerYOffset = effectContext.params.stickerYOffset || -0.04;
  const stickerOpacity = effectContext.params.stickerOpacity || 0.92;

  effectContext.detections.face.trackedFaces.forEach(({ bounds, anchors }) => {
    const eyeDistance = Math.hypot(
      anchors.rightEyeCenter.x - anchors.leftEyeCenter.x,
      anchors.rightEyeCenter.y - anchors.leftEyeCenter.y
    );
    const drawWidth = Math.max(bounds.faceW * stickerScale, eyeDistance * 2.6);
    const drawHeight = drawWidth * (stickerImage.height / stickerImage.width);
    const centerX = (anchors.leftEyeCenter.x + anchors.rightEyeCenter.x) / 2 + bounds.faceW * stickerXOffset;
    const centerY = (anchors.leftEyeCenter.y + anchors.rightEyeCenter.y) / 2 + bounds.faceH * stickerYOffset;

    effectContext.ctx.save();
    effectContext.ctx.globalAlpha = stickerOpacity;
    effectContext.ctx.drawImage(
      stickerImage,
      centerX - drawWidth / 2,
      centerY - drawHeight / 2,
      drawWidth,
      drawHeight
    );
    effectContext.ctx.restore();
  });
}

function fallbackSquareHeadEffect(effectContext) {
  effectContext.detections.face.trackedFaces.forEach(({ squareRoi, sourceRect }) => {
    effectContext.ctx.drawImage(
      effectContext.frameBufferCanvas,
      sourceRect.x,
      sourceRect.y,
      sourceRect.width,
      sourceRect.height,
      squareRoi.squareX,
      squareRoi.squareY,
      squareRoi.squareSize,
      squareRoi.squareSize
    );
  });
}

function copyPixel(sourceData, targetData, sourceIndex, targetIndex) {
  targetData[targetIndex] = sourceData[sourceIndex];
  targetData[targetIndex + 1] = sourceData[sourceIndex + 1];
  targetData[targetIndex + 2] = sourceData[sourceIndex + 2];
  targetData[targetIndex + 3] = sourceData[sourceIndex + 3];
}

function copyNearestPixel(sourceData, targetData, frameWidth, frameHeight, sourceX, sourceY, targetIndex) {
  const clampedX = clamp(Math.round(sourceX), 0, frameWidth - 1);
  const clampedY = clamp(Math.round(sourceY), 0, frameHeight - 1);
  const sourceIndex = (clampedY * frameWidth + clampedX) * 4;
  copyPixel(sourceData, targetData, sourceIndex, targetIndex);
}

function targetHeadHalfWidth(headMask, rowBounds, rowIndex, params) {
  // 各行の元の頭部幅を、頭部全体の高さに近い「四角い幅」へ寄せる。
  // intensity は元形状からスクエア形状へどれだけ近づけるかを決める。
  const centerX = headMask.center.x;
  const originalHalfWidth = Math.max(centerX - rowBounds.minX[rowIndex], rowBounds.maxX[rowIndex] - centerX, 1);
  const intensity = clamp((params.intensity || 0.8) / 1.3, 0, 1);
  const squareScale = clamp((params.squareScale || 1.8) * 0.66, 0.7, 1.6);
  const stretchX = clamp((params.stretchX || 1.25) / 1.25, 0.65, 1.6);
  const squareHalfWidth = Math.max(
    headMask.height * 0.5 * squareScale * stretchX,
    headMask.representativeHalfWidth
  );
  return Math.max(originalHalfWidth, lerp(originalHalfWidth, squareHalfWidth, intensity));
}

function targetTriangleHeadHalfWidth(headMask, rowBounds, rowIndex, params) {
  // 三角頭部用の目標幅。
  // 頭部マスク上端を広く、下端を細くすることで、顎方向へ尖った形に寄せる。
  const centerX = headMask.center.x;
  const originalHalfWidth = Math.max(centerX - rowBounds.minX[rowIndex], rowBounds.maxX[rowIndex] - centerX, 1);
  const intensity = clamp((params.intensity || 0.8) / 1.3, 0, 1);
  const stretchX = clamp((params.stretchX || 1.25) / 1.25, 0.65, 1.6);
  const verticalT = clamp(
    (rowIndex - headMask.bounds.minY) / Math.max(1, headMask.bounds.maxY - headMask.bounds.minY),
    0,
    1
  );
  const topHalfWidth = Math.max(headMask.height * 0.52 * stretchX, headMask.representativeHalfWidth);
  const bottomHalfWidth = Math.max(headMask.representativeHalfWidth * 0.16, headMask.height * 0.08);
  const triangleHalfWidth = lerp(topHalfWidth, bottomHalfWidth, verticalT);
  return Math.max(1, lerp(originalHalfWidth, triangleHalfWidth, intensity));
}

function backgroundColorAroundHead(sourceData, frameWidth, frameHeight, segmentation) {
  // 元の頭部を細くする系の変形では、背面に元の頭部が残ると破綻しやすい。
  // ここでは頭部周辺の「人物ではない画素」を平均し、簡易的な背景色として使う。
  const { headMask, frameCategories } = segmentation;
  const padding = Math.max(12, Math.round(headMask.height * 0.16));
  const minX = clamp(headMask.bounds.minX - padding, 0, frameWidth - 1);
  const maxX = clamp(headMask.bounds.maxX + padding, 0, frameWidth - 1);
  const minY = clamp(headMask.bounds.minY - padding, 0, frameHeight - 1);
  const maxY = clamp(headMask.bounds.maxY + padding, 0, frameHeight - 1);
  let totalR = 0;
  let totalG = 0;
  let totalB = 0;
  let count = 0;

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const category = frameCategories[y * frameWidth + x];
      if (isPersonCategory(category)) {
        continue;
      }

      const pixelIndex = (y * frameWidth + x) * 4;
      totalR += sourceData[pixelIndex];
      totalG += sourceData[pixelIndex + 1];
      totalB += sourceData[pixelIndex + 2];
      count += 1;
    }
  }

  if (!count) {
    return "rgba(20, 26, 24, 1)";
  }

  return `rgb(${Math.round(totalR / count)}, ${Math.round(totalG / count)}, ${Math.round(totalB / count)})`;
}

function coverOriginalHeadArea(ctx, segmentation, frameWidth, frameHeight, fillStyle) {
  // 変形後に細くなった部分から元の頭部が見えないよう、頭部マスクの元領域を先に埋める。
  // 厳密な背景復元ではなく、MVP 用の簡易カバーとして分離合成の破綻を抑える。
  const { headMask } = segmentation;
  ctx.save();
  ctx.fillStyle = fillStyle;

  for (let y = headMask.bounds.minY; y <= headMask.bounds.maxY; y += 1) {
    if (!rowHasMask(headMask.rowBounds, y)) {
      continue;
    }

    const width = headMask.rowBounds.maxX[y] - headMask.rowBounds.minX[y] + 1;
    ctx.fillRect(clamp(headMask.rowBounds.minX[y], 0, frameWidth - 1), clamp(y, 0, frameHeight - 1), width, 1);
  }

  ctx.restore();
}

function createPersonLayerWithoutHead(sourceData, frameWidth, frameHeight, segmentation) {
  // 人物カテゴリのうち、頭部カテゴリ以外だけを透明レイヤーへコピーする。
  // 頭部は各エフェクトが別形状で描き直すため、ここでは意図的に空けておく。
  const personImage = new ImageData(frameWidth, frameHeight);
  const personData = personImage.data;
  const { frameCategories, headMask, personMask } = segmentation;

  for (let y = 0; y < frameHeight; y += 1) {
    if (!rowHasMask(personMask.rowBounds, y)) {
      continue;
    }

    for (let x = personMask.rowBounds.minX[y]; x <= personMask.rowBounds.maxX[y]; x += 1) {
      const category = frameCategories[y * frameWidth + x];
      if (!isPersonCategory(category) || isHeadCategory(category)) {
        continue;
      }

      const pixelIndex = (y * frameWidth + x) * 4;
      copyPixel(sourceData, personData, pixelIndex, pixelIndex);
    }
  }

  return {
    personImage,
    personData,
    headMask,
  };
}

function drawWarpedHeadRows(sourceData, personData, frameWidth, frameHeight, headMask, params, targetHalfWidthForRow) {
  // 頭部マスクの各行を、代表中心から見た相対位置で再サンプリングする。
  // 四角・三角の違いは targetHalfWidthForRow だけに閉じ込める。
  // headXOffset は元の頭部を読む位置ではなく、変形後の頭部を置く位置だけを左右に動かす。
  const targetCenterX = clamp(
    headMask.center.x + headMask.width * (params.headXOffset || 0),
    0,
    frameWidth - 1
  );

  for (let y = headMask.bounds.minY; y <= headMask.bounds.maxY; y += 1) {
    if (!rowHasMask(headMask.rowBounds, y)) {
      continue;
    }

    const targetHalfWidth = targetHalfWidthForRow(headMask, headMask.rowBounds, y, params);
    const targetMinX = clamp(Math.floor(targetCenterX - targetHalfWidth), 0, frameWidth - 1);
    const targetMaxX = clamp(Math.ceil(targetCenterX + targetHalfWidth), 0, frameWidth - 1);
    const sourceHalfWidth = Math.max(
      headMask.center.x - headMask.rowBounds.minX[y],
      headMask.rowBounds.maxX[y] - headMask.center.x,
      1
    );

    for (let x = targetMinX; x <= targetMaxX; x += 1) {
      const normalizedX = (x - targetCenterX) / Math.max(1, targetHalfWidth);
      const sampleX = headMask.center.x + normalizedX * sourceHalfWidth;
      const targetIndex = (y * frameWidth + x) * 4;
      copyNearestPixel(sourceData, personData, frameWidth, frameHeight, sampleX, y, targetIndex);
    }
  }
}

function drawSegmentationDebug(headMask) {
  if (!headMask.valid || !headMask.bounds) {
    return;
  }

  canvasContext.save();
  canvasContext.lineWidth = 3;
  canvasContext.strokeStyle = "rgba(255, 80, 80, 0.95)";
  canvasContext.setLineDash([12, 8]);
  canvasContext.strokeRect(
    headMask.bounds.minX,
    headMask.bounds.minY,
    headMask.bounds.maxX - headMask.bounds.minX + 1,
    headMask.bounds.maxY - headMask.bounds.minY + 1
  );
  canvasContext.fillStyle = "rgba(255, 80, 80, 0.95)";
  canvasContext.beginPath();
  canvasContext.arc(headMask.center.x, headMask.center.y, 6, 0, Math.PI * 2);
  canvasContext.fill();
  canvasContext.restore();
}

function squareHeadEffect(effectContext) {
  const { detections, params } = effectContext;
  const { segmentation } = detections;

  if (!segmentation.enabled || !segmentation.headMask.valid || !segmentation.personMask.valid) {
    fallbackSquareHeadEffect(effectContext);
    return;
  }

  const frameWidth = effectContext.frameBufferCanvas.width;
  const frameHeight = effectContext.frameBufferCanvas.height;
  const sourceImage = frameBufferContext.getImageData(0, 0, frameWidth, frameHeight);
  const sourceData = sourceImage.data;
  const backgroundFill = backgroundColorAroundHead(sourceData, frameWidth, frameHeight, segmentation);
  const { personImage, personData, headMask } = createPersonLayerWithoutHead(
    sourceData,
    frameWidth,
    frameHeight,
    segmentation
  );

  // 頭部は、頭部マスク全体の代表中心を軸にして横方向だけを四角く引き伸ばす。
  coverOriginalHeadArea(effectContext.ctx, segmentation, frameWidth, frameHeight, backgroundFill);
  drawWarpedHeadRows(sourceData, personData, frameWidth, frameHeight, headMask, params, targetHeadHalfWidth);

  personLayerContext.clearRect(0, 0, frameWidth, frameHeight);
  personLayerContext.putImageData(personImage, 0, 0);
  effectContext.ctx.drawImage(personLayerCanvas, 0, 0);
}

function triangleHeadEffect(effectContext) {
  const { detections, params } = effectContext;
  const { segmentation } = detections;

  if (!segmentation.enabled || !segmentation.headMask.valid || !segmentation.personMask.valid) {
    fallbackSquareHeadEffect(effectContext);
    return;
  }

  const frameWidth = effectContext.frameBufferCanvas.width;
  const frameHeight = effectContext.frameBufferCanvas.height;
  const sourceImage = frameBufferContext.getImageData(0, 0, frameWidth, frameHeight);
  const sourceData = sourceImage.data;
  const backgroundFill = backgroundColorAroundHead(sourceData, frameWidth, frameHeight, segmentation);
  const { personImage, personData, headMask } = createPersonLayerWithoutHead(
    sourceData,
    frameWidth,
    frameHeight,
    segmentation
  );

  coverOriginalHeadArea(effectContext.ctx, segmentation, frameWidth, frameHeight, backgroundFill);
  drawWarpedHeadRows(sourceData, personData, frameWidth, frameHeight, headMask, params, targetTriangleHeadHalfWidth);

  personLayerContext.clearRect(0, 0, frameWidth, frameHeight);
  personLayerContext.putImageData(personImage, 0, 0);
  effectContext.ctx.drawImage(personLayerCanvas, 0, 0);
}

const effects = [
  createEffect({
    id: "faceSticker",
    requiredDetections: ["face"],
    run: faceStickerEffect,
  }),
  createEffect({
    id: "squareHead",
    requiredDetections: ["face", "segmentation"],
    run: squareHeadEffect,
  }),
  createEffect({
    id: "triangleHead",
    requiredDetections: ["face", "segmentation"],
    run: triangleHeadEffect,
  }),
];

const effectMap = new Map(effects.map((effect) => [effect.id, effect]));

function activeEffect() {
  return effectMap.get(state.activeEffectId) || effects[0];
}

function updateEffectPanels() {
  effectPanelElements.forEach((panel) => {
    const supportedEffects = panel.dataset.effectPanel.split(/\s+/);
    panel.hidden = !supportedEffects.includes(state.activeEffectId);
  });
}

function updateActiveEffectUi() {
  const effect = activeEffect();
  elements.activeEffectTitle.textContent = effect.title;
  elements.activeEffectDescription.textContent = effect.description;
  elements.activeEffectSelect.value = effect.id;
  setTrackingEffectLabel(effect.shortLabel);
  effectChoiceElements.forEach((button) => {
    button.classList.toggle("is-active", button.dataset.effectChoice === effect.id);
  });
  updateEffectPanels();
}

function drawNoFaceOverlay() {
  canvasContext.save();
  canvasContext.fillStyle = "rgba(10, 10, 10, 0.55)";
  canvasContext.beginPath();
  canvasContext.roundRect(18, 18, 228, 42, 20);
  canvasContext.fill();
  canvasContext.fillStyle = "rgba(255,255,255,0.92)";
  canvasContext.font = '600 15px "Segoe UI", "Yu Gothic UI", sans-serif';
  canvasContext.fillText("Face not detected", 34, 45);
  canvasContext.restore();
}

function buildEffectContext(source, detections, params) {
  return {
    source,
    params,
    mirror: state.sourceMode === "camera",
    ctx: canvasContext,
    frameBufferCanvas,
    assets: state.assets,
    detections,
    helpers: {
      clamp,
      lerp,
    },
  };
}

function runActiveEffect(effectContext) {
  const effect = activeEffect();
  effect.run(effectContext);

  if (effect.requiredDetections.includes("segmentation") && effectContext.params.debugRoiEnabled) {
    if (effectContext.detections.segmentation.headMask.valid) {
      drawSegmentationDebug(effectContext.detections.segmentation.headMask);
    } else {
      effectContext.detections.face.trackedFaces.forEach(({ squareRoi, sourceRect }) => {
        drawRoiDebug(squareRoi, sourceRect);
      });
    }
  }
}

function renderProcessedFrame(source, detectionSnapshot) {
  const isCamera = state.sourceMode === "camera";

  resizeCanvas(detectionSnapshot.sourceWidth, detectionSnapshot.sourceHeight);
  drawBaseSource(source, isCamera);
  updateTrackingSummary(detectionSnapshot);

  if (!detectionSnapshot.face.count) {
    drawNoFaceOverlay();
    state.lastDetectionSnapshot = detectionSnapshot;
    return;
  }

  const params = currentParams();
  const effectContext = buildEffectContext(source, detectionSnapshot, params);
  runActiveEffect(effectContext);

  drawLandmarkBadge(detectionSnapshot.face.trackedFaces[0].bounds, `${activeEffect().shortLabel} tracked`);
  state.lastDetectionSnapshot = detectionSnapshot;
}

// ---------------------------------------------------------------------------
// Temporary Gallery
// 今回の保存フローの根幹。
// 撮影結果をいったん IndexedDB へため、後から選んで PNG 保存する。
// ここを描画ロジックと分けることで、スマホ保存導線へ差し替えるときも影響範囲を狭める。
// ---------------------------------------------------------------------------

function isIndexedDbAvailable() {
  return typeof indexedDB !== "undefined";
}

function openGalleryDatabase() {
  if (!isIndexedDbAvailable()) {
    return Promise.resolve(null);
  }

  if (!state.galleryDbPromise) {
    state.galleryDbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(GALLERY_DB_NAME, 1);

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(GALLERY_STORE_NAME)) {
          database.createObjectStore(GALLERY_STORE_NAME, { keyPath: "id" });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch((error) => {
      console.error(error);
      return null;
    });
  }

  return state.galleryDbPromise;
}

async function readAllTemporaryCaptures() {
  const database = await openGalleryDatabase();
  if (!database) {
    return [...state.temporaryCaptures];
  }

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(GALLERY_STORE_NAME, "readonly");
    const store = transaction.objectStore(GALLERY_STORE_NAME);
    const request = store.getAll();

    request.onsuccess = () => {
      const captures = [...request.result].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
      resolve(captures);
    };
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    console.error(error);
    return [...state.temporaryCaptures];
  });
}

async function saveTemporaryCapture(capture) {
  const database = await openGalleryDatabase();
  if (!database) {
    return;
  }

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(GALLERY_STORE_NAME, "readwrite");
    const store = transaction.objectStore(GALLERY_STORE_NAME);
    const request = store.put(capture);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    console.error(error);
  });
}

async function removeTemporaryCapture(captureId) {
  const database = await openGalleryDatabase();
  if (!database) {
    return;
  }

  return new Promise((resolve, reject) => {
    const transaction = database.transaction(GALLERY_STORE_NAME, "readwrite");
    const store = transaction.objectStore(GALLERY_STORE_NAME);
    const request = store.delete(captureId);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  }).catch((error) => {
    console.error(error);
  });
}

function selectedCapture() {
  return state.temporaryCaptures.find((capture) => capture.id === state.selectedCaptureId) || null;
}

function syncGalleryActionButtons() {
  const capture = selectedCapture();
  const hasCapture = Boolean(capture);
  elements.downloadSelectedShotButton.disabled = !hasCapture;
  elements.deleteSelectedShotButton.disabled = !hasCapture;
  elements.openGalleryButton.disabled = !state.temporaryCaptures.length;

  if (!state.temporaryCaptures.length) {
    elements.galleryStatusLabel.textContent = "一時保存はまだありません。";
    return;
  }

  if (!capture) {
    elements.galleryStatusLabel.textContent = `一時保存 ${state.temporaryCaptures.length} 件。保存したい画像を選択してください。`;
    return;
  }

  elements.galleryStatusLabel.textContent = `${formatCaptureTime(capture.createdAt)} / ${EFFECT_METADATA[capture.effectId]?.shortLabel || capture.effectId} / ${capture.sourceMode}`;
}

function renderGalleryPreview() {
  // 一覧で選んだ画像を大きく確認するための表示更新。
  // 将来の落書きや再編集は、このプレビュー枠にレイヤーを重ねる想定。
  const capture = selectedCapture();

  if (!capture) {
    elements.galleryPreviewImage.style.display = "none";
    elements.galleryPreviewImage.removeAttribute("src");
    elements.galleryPreviewEmpty.hidden = false;
    elements.galleryPreviewTitle.textContent = "選択中の画像はありません";
    elements.galleryPreviewDescription.textContent =
      "左の一覧から画像をクリックすると、保存や削除の対象を切り替えられます。";
    return;
  }

  const effectLabel = EFFECT_METADATA[capture.effectId]?.shortLabel || capture.effectId;
  elements.galleryPreviewImage.src = capture.dataUrl;
  elements.galleryPreviewImage.style.display = "block";
  elements.galleryPreviewEmpty.hidden = true;
  elements.galleryPreviewTitle.textContent = `${effectLabel} / ${formatCaptureTime(capture.createdAt)}`;
  elements.galleryPreviewDescription.textContent =
    `${capture.sourceMode} で保存した画像です。ここで大きく確認してから保存や削除を選べます。`;
}

function renderTemporaryGallery() {
  if (!state.temporaryCaptures.length) {
    elements.temporaryGallery.innerHTML = '<p class="gallery-empty">一時保存はまだありません。</p>';
    syncGalleryActionButtons();
    renderGalleryPreview();
    return;
  }

  elements.temporaryGallery.innerHTML = state.temporaryCaptures
    .map((capture) => {
      const isSelected = capture.id === state.selectedCaptureId;
      const effectLabel = EFFECT_METADATA[capture.effectId]?.shortLabel || capture.effectId;

      return `
        <article
          class="gallery-card ${isSelected ? "is-selected" : ""}"
          data-gallery-action="select"
          data-capture-id="${capture.id}"
          role="button"
          tabindex="0"
          aria-pressed="${isSelected ? "true" : "false"}"
        >
          <button class="gallery-thumb-button" type="button" data-gallery-action="select" data-capture-id="${capture.id}">
            <img class="gallery-thumb" src="${capture.dataUrl}" alt="一時保存 ${formatCaptureTime(capture.createdAt)}" />
          </button>
          <div class="gallery-meta">
            <strong>${effectLabel}</strong>
            <span>${formatCaptureTime(capture.createdAt)}</span>
            <span>${capture.sourceMode}</span>
          </div>
        </article>
      `;
    })
    .join("");

  syncGalleryActionButtons();
  renderGalleryPreview();
}

function selectTemporaryCapture(captureId) {
  state.selectedCaptureId = captureId;
  renderTemporaryGallery();
}

function downloadCaptureAsPng(capture) {
  const link = document.createElement("a");
  const safeEffectId = capture.effectId.replace(/[^a-z0-9_-]/gi, "-");
  link.download = `${safeEffectId}-${capture.createdAt.replace(/[:.]/g, "-")}.png`;
  link.href = capture.dataUrl;
  link.click();
}

async function hydrateTemporaryGallery() {
  state.temporaryCaptures = await readAllTemporaryCaptures();
  state.selectedCaptureId = state.temporaryCaptures[0]?.id || null;
  renderTemporaryGallery();
}

async function addCurrentFrameToTemporaryGallery() {
  if (state.isCaptureFeedbackActive) {
    return;
  }

  if (!elements.outputCanvas.width || !elements.outputCanvas.height) {
    setStatus("保存できる結果がまだありません");
    return;
  }

  playCaptureFeedback();

  const capture = {
    id: createCaptureId(),
    createdAt: new Date().toISOString(),
    effectId: state.activeEffectId,
    sourceMode: state.sourceMode,
    dataUrl: elements.outputCanvas.toDataURL("image/png"),
  };

  state.temporaryCaptures = [capture, ...state.temporaryCaptures.filter((item) => item.id !== capture.id)];
  state.selectedCaptureId = capture.id;
  renderTemporaryGallery();
  await saveTemporaryCapture(capture);
  setStatus("一時保存へ追加しました");
}

async function deleteSelectedTemporaryCapture() {
  const capture = selectedCapture();
  if (!capture) {
    return;
  }

  state.temporaryCaptures = state.temporaryCaptures.filter((item) => item.id !== capture.id);
  await removeTemporaryCapture(capture.id);
  state.selectedCaptureId = state.temporaryCaptures[0]?.id || null;
  renderTemporaryGallery();
  setStatus("選択中の一時保存を削除しました");
}

// ---------------------------------------------------------------------------
// MediaPipe 初期化と入力処理
// 認識層の実行タイミングをここで制御する。
// 画像モードとカメラモードで detect / detectForVideo を切り替えるのが重要な分岐。
// ---------------------------------------------------------------------------

async function setRunningMode(mode) {
  if (state.runningMode === mode) {
    return;
  }
  await state.detectors.face.setOptions({ runningMode: mode });
  if (state.detectors.segmentation) {
    await state.detectors.segmentation.setOptions({ runningMode: mode });
  }
  state.runningMode = mode;
}

async function createFaceDetector() {
  setStatus("FaceLandmarker 初期化中");
  const fileset = await FilesetResolver.forVisionTasks(WASM_ROOT);
  const options = {
    baseOptions: {
      modelAssetPath: FACE_MODEL_URL,
      delegate: "GPU",
    },
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
    runningMode: "IMAGE",
    numFaces: 1,
  };

  try {
    state.detectors.face = await FaceLandmarker.createFromOptions(fileset, options);
  } catch (gpuError) {
    state.detectors.face = await FaceLandmarker.createFromOptions(fileset, {
      ...options,
      baseOptions: {
        modelAssetPath: FACE_MODEL_URL,
      },
    });
  }

  setStatus("初期化完了");
}

async function createSegmentationDetector() {
  setStatus("ImageSegmenter 初期化中");
  try {
    const fileset = await FilesetResolver.forVisionTasks(WASM_ROOT);
    const options = {
      baseOptions: {
        modelAssetPath: SEGMENTATION_MODEL_URL,
      },
      outputCategoryMask: true,
      outputConfidenceMasks: false,
      runningMode: "IMAGE",
    };

    try {
      state.detectors.segmentation = await ImageSegmenter.createFromOptions(fileset, {
        ...options,
        baseOptions: {
          ...options.baseOptions,
          delegate: "GPU",
        },
      });
    } catch (gpuError) {
      // GPU delegate が使えない環境でも、スクエア頭部以外の機能まで止めない。
      state.detectors.segmentation = await ImageSegmenter.createFromOptions(fileset, options);
    }

    setStatus("初期化完了");
  } catch (error) {
    state.detectors.segmentation = null;
    setStatus("Segmentation 初期化失敗");
    console.error(error);
  }
}

function activeEffectNeedsSegmentation() {
  return activeEffect().requiredDetections.includes("segmentation");
}

function segmentSource(source, timestampMs = performance.now()) {
  return new Promise((resolve) => {
    if (!state.detectors.segmentation || !activeEffectNeedsSegmentation()) {
      resolve(null);
      return;
    }

    const callback = (result) => resolve(result);
    try {
      if (state.runningMode === "VIDEO") {
        state.detectors.segmentation.segmentForVideo(source, timestampMs, callback);
        return;
      }

      state.detectors.segmentation.segment(source, callback);
    } catch (error) {
      console.error(error);
      resolve(null);
    }
  });
}

function stopCameraStream() {
  if (state.animationFrameId) {
    cancelAnimationFrame(state.animationFrameId);
    state.animationFrameId = 0;
  }

  if (state.webcamStream) {
    state.webcamStream.getTracks().forEach((track) => track.stop());
    state.webcamStream = null;
  }

  elements.cameraFeed.srcObject = null;
  state.isCameraActive = false;
  state.lastVideoTime = -1;
}

async function startCamera() {
  if (!state.detectors.face) {
    return;
  }

  stopCameraStream();
  setStatus("カメラ許可待ち");

  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: "user",
      width: { ideal: 1280 },
      height: { ideal: 720 },
    },
    audio: false,
  });

  elements.cameraFeed.srcObject = stream;
  await elements.cameraFeed.play();

  state.webcamStream = stream;
  state.sourceMode = "camera";
  state.isCameraActive = true;
  state.currentImage = null;
  setSourceModeLabel("camera");
  setStatus("カメラ実行中");
  elements.uploadedPreview.removeAttribute("src");

  await setRunningMode("VIDEO");
  updateStageVisibility();
  predictCameraFrame();
}

async function detectFromCurrentCameraFrame() {
  const params = currentParams();
  const timestampMs = performance.now();
  const faceResult = state.detectors.face.detectForVideo(elements.cameraFeed, timestampMs);
  const segmentationResult = await segmentSource(elements.cameraFeed, timestampMs);
  return buildDetectionSnapshot(elements.cameraFeed, faceResult, segmentationResult, params, true);
}

async function predictCameraFrame() {
  if (!state.isCameraActive) {
    return;
  }

  if (elements.cameraFeed.currentTime !== state.lastVideoTime) {
    state.lastVideoTime = elements.cameraFeed.currentTime;
    const detectionSnapshot = await detectFromCurrentCameraFrame();
    if (state.isCameraActive) {
      renderProcessedFrame(elements.cameraFeed, detectionSnapshot);
    }
  }

  state.animationFrameId = requestAnimationFrame(predictCameraFrame);
}

async function renderUploadedImage() {
  if (!state.currentImage || !state.detectors.face) {
    return;
  }

  await setRunningMode("IMAGE");
  const params = currentParams();
  const faceResult = state.detectors.face.detect(state.currentImage);
  const segmentationResult = await segmentSource(state.currentImage);
  const detectionSnapshot = buildDetectionSnapshot(state.currentImage, faceResult, segmentationResult, params, false);
  renderProcessedFrame(state.currentImage, detectionSnapshot);
}

async function handleImageUpload(file) {
  if (!file) {
    return;
  }

  stopCameraStream();

  if (state.currentImageObjectUrl) {
    URL.revokeObjectURL(state.currentImageObjectUrl);
  }

  const objectUrl = URL.createObjectURL(file);
  const image = new Image();
  image.onload = async () => {
    state.currentImage = image;
    state.currentImageObjectUrl = objectUrl;
    state.sourceMode = "image";
    setSourceModeLabel("image");
    setStatus("画像解析完了");
    elements.uploadedPreview.src = objectUrl;
    updateStageVisibility();
    await renderUploadedImage();
  };
  image.src = objectUrl;
}

// ---------------------------------------------------------------------------
// UI イベント
// ここでは「何を押したらどの層を呼ぶか」だけを管理する。
// エフェクト処理そのものはこの層へ書かないことで、コードの役割を混ぜないようにする。
// ---------------------------------------------------------------------------

async function rerenderCurrentSourceIfNeeded() {
  if (state.sourceMode === "image") {
    await renderUploadedImage();
  }
}

function bindUiEvents() {
  elements.startCameraButton.addEventListener("click", async () => {
    try {
      await startCamera();
    } catch (error) {
      setStatus("カメラ開始失敗");
      console.error(error);
    }
  });

  elements.stopCameraButton.addEventListener("click", () => {
    stopCameraStream();
    state.sourceMode = "idle";
    state.lastDetectionSnapshot = null;
    setSourceModeLabel("stopped");
    setStatus("停止中");
    resetTrackingUi();
    canvasContext.clearRect(0, 0, elements.outputCanvas.width, elements.outputCanvas.height);
    updateStageVisibility();
  });

  elements.imageInput.addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    try {
      await handleImageUpload(file);
    } catch (error) {
      setStatus("画像読込失敗");
      console.error(error);
    }
  });

  elements.activeEffectSelect.addEventListener("change", async (event) => {
    state.activeEffectId = event.target.value;
    updateActiveEffectUi();
    await rerenderCurrentSourceIfNeeded();
  });

  elements.effectRail.addEventListener("click", async (event) => {
    const choiceButton = event.target.closest("[data-effect-choice]");
    if (!choiceButton) {
      return;
    }

    state.activeEffectId = choiceButton.dataset.effectChoice;
    updateActiveEffectUi();
    await rerenderCurrentSourceIfNeeded();
  });

  elements.saveToGalleryButton.addEventListener("click", async () => {
    await addCurrentFrameToTemporaryGallery();
  });

  elements.openGalleryButton.addEventListener("click", () => {
    if (!state.temporaryCaptures.length) {
      setStatus("一時保存がまだありません");
      return;
    }
    setAppScreen("gallery");
  });

  elements.backToCaptureButton.addEventListener("click", () => {
    setAppScreen("capture");
  });

  elements.downloadSelectedShotButton.addEventListener("click", () => {
    const capture = selectedCapture();
    if (!capture) {
      return;
    }
    downloadCaptureAsPng(capture);
    setStatus("選択中の一時保存を PNG 出力しました");
  });

  elements.deleteSelectedShotButton.addEventListener("click", async () => {
    await deleteSelectedTemporaryCapture();
  });

  elements.temporaryGallery.addEventListener("click", (event) => {
    const target = event.target.closest("[data-gallery-action]");
    if (!target) {
      return;
    }

    if (target.dataset.galleryAction === "select") {
      selectTemporaryCapture(target.dataset.captureId);
    }
  });

  elements.temporaryGallery.addEventListener("keydown", (event) => {
    const target = event.target.closest("[data-gallery-action]");
    if (!target) {
      return;
    }

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (target.dataset.galleryAction === "select") {
        selectTemporaryCapture(target.dataset.captureId);
      }
    }
  });

  effectControlElements.forEach((element) => {
    element.addEventListener("input", async () => {
      await rerenderCurrentSourceIfNeeded();
    });
  });
}

// ---------------------------------------------------------------------------
// 起動
// アプリ全体の立ち上げ順をここで固定する。
// アセット準備 -> UI 準備 -> MediaPipe 初期化 -> ギャラリー復元の順で揃えるのが根幹。
// ---------------------------------------------------------------------------

async function bootstrap() {
  state.activeEffectId = elements.activeEffectSelect.value;
  setAppScreen("capture");
  setSourceModeLabel("idle");
  updateStageVisibility();
  updateActiveEffectUi();
  resetTrackingUi();
  bindUiEvents();
  await ensureEffectAssets();
  await createFaceDetector();
  await createSegmentationDetector();
  await hydrateTemporaryGallery();
  syncGalleryActionButtons();
  setStatus(state.detectors.segmentation ? "初期化完了" : "Segmentationなしで初期化完了");
  if (elements.blendshapeList) {
    elements.blendshapeList.innerHTML = "<li>入力待ち</li>";
  }
}

bootstrap().catch((error) => {
  setStatus("初期化失敗");
  if (elements.blendshapeList) {
    elements.blendshapeList.innerHTML = "<li>初期化エラー</li>";
  }
  console.error(error);
});
