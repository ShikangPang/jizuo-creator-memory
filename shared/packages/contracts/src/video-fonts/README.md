# Bundled video fonts

These modules contain unmodified upstream TTF files encoded as gzip/base64, their SHA-256 digests, upstream URLs and complete OFL 1.1 licenses (including copyright notices). Downloaded from the official Google Fonts repository on 2026-09-21.

- ZCOOL KuaiLe: https://github.com/google/fonts/tree/main/ofl/zcoolkuaile
- ZCOOL QingKe HuangYou: https://github.com/google/fonts/tree/main/ofl/zcoolqingkehuangyou
- Ma Shan Zheng: https://github.com/google/fonts/tree/main/ofl/mashanzheng

Both the browser FontFace loader and the export fonts directory use these same bytes. Embedding the payload and license in the JS bundles keeps desktop/runtime packaging self-contained; no network or system font installation is required. Only selected font families are decoded. Do not export the payload from the general contracts index.
