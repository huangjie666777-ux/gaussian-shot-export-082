import { INSTANCE_STRIDE } from '../splat/frameBuilder';

const VERT = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec2 iCenter;
layout(location = 2) in vec3 iCov;
layout(location = 3) in vec4 iColor;
uniform vec2 uResolution;
out vec2 vOffset;
out vec4 vColor;
out vec3 vConic;

void main() {
  float a = iCov.x;
  float b = iCov.y;
  float c = iCov.z;
  float det = a * c - b * b;
  // Largest eigenvalue of the 2x2 screen covariance.
  float mid = (a + c) * 0.5;
  float inner = max(mid * mid - det, 0.0);
  float lambda1 = mid + sqrt(inner);
  float radius = 3.0 * sqrt(max(lambda1, 0.0));
  vOffset = aCorner * radius;
  vec2 pos = iCenter + vOffset;
  vec2 ndc = vec2(pos.x / uResolution.x, 1.0 - pos.y / uResolution.y) * 2.0 - 1.0;
  gl_Position = vec4(ndc, 0.5, 1.0);
  vConic = vec3(c, -b, a) / det;
  vColor = iColor;
}
`;

const FRAG = `#version 300 es
precision highp float;
in vec2 vOffset;
in vec4 vColor;
in vec3 vConic;
out vec4 outColor;

void main() {
  vec2 d = vOffset;
  float power = -0.5 * (vConic.x * d.x * d.x + 2.0 * vConic.y * d.x * d.y + vConic.z * d.y * d.y);
  float gaussian = exp(power);
  float alpha = clamp(vColor.a * gaussian, 0.0, 1.0);
  if (alpha < 1.0 / 255.0) discard;
  outColor = vec4(vColor.rgb * alpha, alpha);
}
`;

const CORNERS = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error('无法创建 WebGL 着色器');
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`着色器编译失败: ${log}`);
  }
  return shader;
}

export class SplatRenderer {
  private gl: WebGL2RenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private vao: WebGLVertexArrayObject | null = null;
  private instanceBuffer: WebGLBuffer | null = null;
  private cornerBuffer: WebGLBuffer | null = null;
  private resolutionLoc: WebGLUniformLocation | null = null;
  private capacity = 0;
  private destroyed = false;
  private contextLost = false;
  private lastCssWidth = 1;
  private lastCssHeight = 1;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onRestored?: () => void,
  ) {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error('当前浏览器不支持 WebGL2');
    this.gl = gl;
    this.createResources(gl);

    canvas.addEventListener('webglcontextlost', this.handleContextLost);
    canvas.addEventListener('webglcontextrestored', this.handleContextRestored);
  }

  private handleContextLost = (event: Event): void => {
    event.preventDefault(); // request automatic restore
    this.contextLost = true;
    this.program = null;
    this.vao = null;
    this.instanceBuffer = null;
    this.cornerBuffer = null;
    this.resolutionLoc = null;
  };

  private handleContextRestored = (): void => {
    const gl = this.canvas.getContext('webgl2');
    if (!gl) return;
    this.gl = gl;
    this.capacity = 0;
    this.createResources(gl);
    this.contextLost = false;
    this.resize(this.lastCssWidth, this.lastCssHeight);
    this.onRestored?.();
  };

  private createResources(gl: WebGL2RenderingContext): void {
    const vertexShader = compile(gl, gl.VERTEX_SHADER, VERT);
    const fragmentShader = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    const program = gl.createProgram()!;
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    gl.deleteShader(vertexShader);
    gl.deleteShader(fragmentShader);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      throw new Error(`着色器链接失败: ${gl.getProgramInfoLog(program)}`);
    }
    this.program = program;
    this.resolutionLoc = gl.getUniformLocation(program, 'uResolution')!;

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);

    this.cornerBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.cornerBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, CORNERS, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.instanceBuffer = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, INSTANCE_STRIDE, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 3, gl.FLOAT, false, INSTANCE_STRIDE, 8);
    gl.vertexAttribDivisor(2, 1);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, INSTANCE_STRIDE, 20);
    gl.vertexAttribDivisor(3, 1);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.clearColor(0, 0, 0, 0);
  }

  resize(width: number, height: number): void {
    const gl = this.gl;
    if (!gl || this.contextLost) return;
    this.lastCssWidth = width;
    this.lastCssHeight = height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.applySize(
      gl,
      Math.max(1, Math.round(width * dpr)),
      Math.max(1, Math.round(height * dpr)),
    );
  }

  /** Set an exact drawing-buffer size at dpr 1 (fixed-size offline export). */
  resizePixels(width: number, height: number): void {
    const gl = this.gl;
    if (!gl || this.contextLost) return;
    this.applySize(gl, Math.max(1, Math.round(width)), Math.max(1, Math.round(height)));
  }

  private applySize(
    gl: WebGL2RenderingContext,
    drawingWidth: number,
    drawingHeight: number,
  ): void {
    if (this.canvas.width !== drawingWidth || this.canvas.height !== drawingHeight) {
      this.canvas.width = drawingWidth;
      this.canvas.height = drawingHeight;
    }
    gl.viewport(0, 0, drawingWidth, drawingHeight);
  }

  /** Upload far->near packed splats and draw instanced ellipse quads. */
  draw(packed: ArrayBuffer, visible: number): void {
    const gl = this.gl;
    if (this.destroyed || this.contextLost || !gl || !this.program || !this.vao || !this.instanceBuffer) {
      return;
    }
    if (visible === 0) {
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    gl.bindVertexArray(this.vao);
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    if (visible > this.capacity) {
      this.capacity = Math.max(visible, Math.floor(this.capacity * 1.5));
      gl.bufferData(gl.ARRAY_BUFFER, this.capacity * INSTANCE_STRIDE, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, packed);
    gl.uniform2f(this.resolutionLoc, this.canvas.width, this.canvas.height);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, visible);
  }

  clear(): void {
    const gl = this.gl;
    if (gl && !this.contextLost) gl.clear(gl.COLOR_BUFFER_BIT);
  }

  dispose(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost);
    this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored);
    const gl = this.gl;
    if (gl && !this.contextLost) {
      if (this.cornerBuffer) gl.deleteBuffer(this.cornerBuffer);
      if (this.instanceBuffer) gl.deleteBuffer(this.instanceBuffer);
      if (this.vao) gl.deleteVertexArray(this.vao);
      if (this.program) gl.deleteProgram(this.program);
    }
    this.cornerBuffer = null;
    this.instanceBuffer = null;
    this.vao = null;
    this.program = null;
    this.resolutionLoc = null;
    this.gl = null;
  }
}
