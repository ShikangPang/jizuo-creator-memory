import { userErrorMessage } from "@jizuo/contracts";
/** Angles are degrees. Yaw 0 faces the source center, positive yaw looks right;
 * positive pitch looks up. hfov is the horizontal perspective field of view. */
export type PanoramaView = { yaw: number; pitch: number; hfov: number };
export type PanoramaFrameRatio = "16:9" | "9:16" | "1:1";
export type PanoramaFrameSize = { width: number; height: number };

export const DEFAULT_PANORAMA_VIEW: PanoramaView = { yaw: 0, pitch: 0, hfov: 90 };

export function normalizePanoramaView(view: PanoramaView): PanoramaView {
  if (![view.yaw, view.pitch, view.hfov].every(Number.isFinite)) throw new Error("环景视角必须是有效角度");
  return {
    yaw: ((view.yaw + 180) % 360 + 360) % 360 - 180,
    pitch: Math.max(-90, Math.min(90, view.pitch)),
    hfov: Math.max(30, Math.min(120, view.hfov)),
  };
}

export function panoramaFrameSize(ratio: PanoramaFrameRatio): PanoramaFrameSize {
  if (ratio === "16:9") return { width: 1280, height: 720 };
  if (ratio === "9:16") return { width: 720, height: 1280 };
  return { width: 1024, height: 1024 };
}

export function validatePanoramaDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width !== height * 2) {
    throw new Error("环景原图必须是宽高比 2:1 的等距柱状投影图片，请重新导入有效全景图。");
  }
}

/** Column-major camera basis, including horizontal/vertical perspective scale.
 * Both the CPU reference projection and GPU shader use this exact matrix. */
function cameraMatrix(input: PanoramaView, aspect: number): [number, number, number, number, number, number, number, number, number] {
  if (!Number.isFinite(aspect) || aspect <= 0) throw new Error("取景比例无效");
  const view = normalizePanoramaView(input);
  const yaw = view.yaw * Math.PI / 180, pitch = view.pitch * Math.PI / 180;
  const sy = Math.sin(yaw), cy = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch);
  const horizontal = Math.tan(view.hfov * Math.PI / 360), vertical = horizontal / aspect;
  return [cy * horizontal, 0, -sy * horizontal,
    -sy * sp * vertical, cp * vertical, -cy * sp * vertical,
    sy * cp, sp, cy * cp];
}

/** A normalized viewport point (x from left, y from top) to source UV.
 * Source u wraps at the longitude seam; source v=0 is the north pole. */
export function projectPanoramaPoint(x: number, y: number, view: PanoramaView, aspect: number): { u: number; v: number } {
  if (![x, y].every(Number.isFinite)) throw new Error("取景坐标无效");
  const matrix = cameraMatrix(view, aspect), sx = x * 2 - 1, sy = 1 - y * 2;
  const dx = matrix[0] * sx + matrix[3] * sy + matrix[6];
  const dy = matrix[1] * sx + matrix[4] * sy + matrix[7];
  const dz = matrix[2] * sx + matrix[5] * sy + matrix[8];
  const longitude = Math.atan2(dx, dz) / (2 * Math.PI) + 0.5;
  return { u: ((longitude % 1) + 1) % 1, v: Math.acos(Math.max(-1, Math.min(1, dy / Math.hypot(dx, dy, dz)))) / Math.PI };
}

export interface PanoramaRenderer {
  draw(view: PanoramaView, size: PanoramaFrameSize): void;
  /** Renders the same perspective view and returns PNG bytes as plain base64. */
  capture(view: PanoramaView, size: PanoramaFrameSize): string;
  dispose(): void;
}

const VERTEX_SHADER = `
attribute vec2 position;
varying vec2 screenPoint;
void main() {
  screenPoint = position;
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
uniform sampler2D panorama;
uniform mat3 camera;
uniform float textureWidth;
varying vec2 screenPoint;
const float PI = 3.141592653589793;
void main() {
  vec3 ray = normalize(camera * vec3(screenPoint, 1.0));
  float u = fract(atan(ray.x, ray.z) / (2.0 * PI) + 0.5);
  float v = acos(clamp(ray.y, -1.0, 1.0)) / PI;
  // WebGL 1 NPOT textures require CLAMP_TO_EDGE. Interpolate adjacent columns
  // explicitly so longitude wraps across the seam for arbitrary image sizes.
  float column = u * textureWidth - 0.5;
  float left = floor(column);
  float u0 = (mod(left, textureWidth) + 0.5) / textureWidth;
  float u1 = (mod(left + 1.0, textureWidth) + 0.5) / textureWidth;
  gl_FragColor = mix(texture2D(panorama, vec2(u0, v)), texture2D(panorama, vec2(u1, v)), fract(column));
}`;

export function panoramaErrorMessage(cause: unknown, fallback: string): string {
  // DOMException need not inherit this realm's Error (e.g. WebViews/iframes).
  if (cause && typeof cause === "object" && "name" in cause && cause.name === "SecurityError") {
    return "图片的跨域（CORS）权限不允许读取像素，无法保存取景图。请导入本地环景图片后重试。";
  }
  return userErrorMessage(cause, fallback, { operation: "panorama-projection" });
}

/** The original image is only uploaded to a texture, never modified or cropped. */
export function createPanoramaRenderer(canvas: HTMLCanvasElement, image: HTMLImageElement): PanoramaRenderer {
  validatePanoramaDimensions(image.naturalWidth, image.naturalHeight);
  const gl = canvas.getContext("webgl", { alpha: false, antialias: false, preserveDrawingBuffer: true });
  if (!gl) throw new Error("当前设备无法启用 WebGL 环景预览。请开启图形加速或更换支持 WebGL 的浏览器后重试。");
  let texture: WebGLTexture | null = null, buffer: WebGLBuffer | null = null, program: WebGLProgram | null = null;
  const shaders: WebGLShader[] = [];
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (texture) gl.deleteTexture(texture);
    if (buffer) gl.deleteBuffer(buffer);
    if (program) gl.deleteProgram(program);
    for (const shader of shaders) gl.deleteShader(shader);
  };
  try {
    const maximum = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    if (image.naturalWidth > maximum || image.naturalHeight > maximum) {
      throw new Error(`环景图片超过当前设备的纹理尺寸上限（${maximum} 像素），请导入尺寸较小的 2:1 全景图。`);
    }
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error("无法分配环景图形资源，请关闭其他图形页面后重试。");
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error("当前设备无法编译 WebGL 环景投影，请更换支持 WebGL 的浏览器后重试。");
      return shader;
    };
    program = gl.createProgram();
    if (!program) throw new Error("无法创建环景图形程序，请重试。");
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERTEX_SHADER));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error("当前设备无法启用 WebGL 环景投影，请重试。");
    gl.useProgram(program);
    buffer = gl.createBuffer();
    texture = gl.createTexture();
    if (!buffer || !texture) throw new Error("无法分配环景图形资源，请关闭其他图形页面后重试。");
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    if (gl.getError() !== gl.NO_ERROR) throw new Error("环景纹理加载失败，可能是图片过大或设备图形资源不足，请重试。");
    gl.uniform1i(gl.getUniformLocation(program, "panorama"), 0);
    gl.uniform1f(gl.getUniformLocation(program, "textureWidth"), image.naturalWidth);
    const camera = gl.getUniformLocation(program, "camera");
    const draw = (view: PanoramaView, size: PanoramaFrameSize) => {
      if (disposed || gl.isContextLost()) throw new Error("环景图形连接已中断，请重新加载环景。");
      if (![size.width, size.height].every((value) => Number.isSafeInteger(value) && value > 0 && value <= 1280)) throw new Error("取景图片尺寸无效");
      if (canvas.width !== size.width) canvas.width = size.width;
      if (canvas.height !== size.height) canvas.height = size.height;
      gl.viewport(0, 0, size.width, size.height);
      gl.uniformMatrix3fv(camera, false, cameraMatrix(view, size.width / size.height));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    };
    return {
      draw,
      capture(view, size) {
        draw(view, size);
        try {
          const encoded = canvas.toDataURL("image/png");
          if (!encoded.startsWith("data:image/png;base64,")) throw new Error("取景图导出失败，请重新加载环景后重试。");
          return encoded.slice("data:image/png;base64,".length);
        } catch (cause) { throw new Error(panoramaErrorMessage(cause, "取景图导出失败，请重试。")); }
      },
      dispose,
    };
  } catch (cause) {
    dispose();
    throw new Error(panoramaErrorMessage(cause, "环景渲染失败，请重试。"));
  }
}
