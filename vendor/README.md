# Vendored libraries

Chrome MV3 extensions may not load remote code, so these run from the extension package.

| File | Library | Version | License |
| --- | --- | --- | --- |
| `transformers.min.js` | [Transformers.js](https://github.com/huggingface/transformers.js) (`@huggingface/transformers`) | 4.3.1 | Apache-2.0 (`LICENSE.transformers`) |
| `ort/ort-wasm-simd-threaded.asyncify.{mjs,wasm}` | [ONNX Runtime Web](https://github.com/microsoft/onnxruntime) | 1.31.0-dev.20260914 (the build Transformers.js 4.3.1 pins) | MIT |
| `pdfjs/pdf.min.mjs`, `pdfjs/pdf.worker.min.mjs` | [pdf.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist`) | 6.4.299 | Apache-2.0 (`LICENSE.pdfjs`) |
| `mediapipe/vision_bundle.mjs`, `mediapipe/vision_wasm_internal.{js,wasm}` | [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) (`@mediapipe/tasks-vision`) | 1.1.0 | Apache-2.0 |
| `mediapipe/blaze_face_short_range.tflite` | BlazeFace short-range face detector (Google MediaPipe models) | float16 / latest | Apache-2.0 |

The small BlazeFace model (230 KB) is bundled. The large FastVLM weights are **not**: `onnx-community/FastVLM-0.5B-ONNX` (~670 MB with the
dtypes chosen in `sidepanel/local/vlm-worker.js`) is downloaded from Hugging Face on first
use and cached in the browser's Cache Storage.
