import { onMount, onCleanup } from 'solid-js';
import { prepareWithSegments, layoutWithLines } from './lib/pretext/layout';

const WavyTextBackground = () => {
  let canvasRef: HTMLCanvasElement | undefined;
  let animationFrame: number;
  let gl: WebGLRenderingContext | null = null;
  let program: WebGLProgram | null = null;
  
  // Mouse state for interaction
  const mouse = { x: 0, y: 0, targetX: 0, targetY: 0 };

  const onMouseMove = (e: MouseEvent) => {
    mouse.targetX = e.clientX / window.innerWidth;
    mouse.targetY = 1.0 - (e.clientY / window.innerHeight);
  };

  onMount(() => {
    if (!canvasRef) return;
    gl = canvasRef.getContext('webgl');
    if (!gl) return;

    window.addEventListener('mousemove', onMouseMove);

    // --- Shader Sources ---
    const vsSource = `
      attribute vec2 position;
      varying vec2 vUv;
      void main() {
        vUv = position * 0.5 + 0.5;
        gl_Position = vec4(position, 0.0, 1.0);
      }
    `;

    const fsSource = `
      precision highp float;
      varying vec2 vUv;
      uniform sampler2D uTexture;
      uniform float uTime;
      uniform vec2 uMouse;
      uniform vec2 uResolution;

      vec2 hash(vec2 p) {
        p = vec2(dot(p, vec2(127.1, 311.7)), dot(p, vec2(269.5, 183.3)));
        return -1.0 + 2.0 * fract(sin(p) * 43758.5453123);
      }

      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f);
        return mix(mix(dot(hash(i + vec2(0.0, 0.0)), f - vec2(0.0, 0.0)), 
                       dot(hash(i + vec2(1.0, 0.0)), f - vec2(1.0, 0.0)), u.x),
                   mix(dot(hash(i + vec2(0.0, 1.0)), f - vec2(0.0, 1.0)), 
                       dot(hash(i + vec2(1.0, 1.0)), f - vec2(1.0, 1.0)), u.x), u.y);
      }

      float sdRect(vec2 p, vec2 b) {
        vec2 d = abs(p) - b;
        return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
      }

      void main() {
        vec2 uv = vUv;
        vec2 pixelPos = (uv - 0.5) * uResolution;
        vec2 boxHalfSize = vec2(225.0, 125.0);
        float d = sdRect(pixelPos, boxHalfSize);
        float x = clamp((d - 5.0) / 105.0, 0.0, 1.0);
        float stability = pow(x * x * (3.0 - 2.0 * x), 1.2);
        
        // Mouse interaction
        vec2 mousePixel = (uMouse - 0.5) * uResolution;
        vec2 diffPixels = pixelPos - mousePixel;
        float distMouse = length(diffPixels);
        float mouseEffect = smoothstep(700.0, 0.0, distMouse) * 8.0 * stability;
        mouseEffect *= smoothstep(0.0, 80.0, distMouse);
        vec2 mouseDistortion = normalize(diffPixels + 0.0001) * mouseEffect;
        
        // --- Distorted Modulo Gradient Surge ---
        // 1. High-frequency, low-strength noise for "micro-jitter" in the waves
        float jitter = noise((uv + flow) * 15.0 + uTime * 0.8) * 0.05;
        
        // 2. The Modulo Gradient (the main wave structure)
        // We distort the input to fract with the jitter
        float waveInput = (uv.x + uv.y) * 2.5 - uTime * 0.2 + jitter;
        float phase = fract(waveInput);
        
        // 3. Asymmetrical profile (Quick surge 0.15, slow release 0.85)
        float surgeProfile = phase < 0.15 
            ? smoothstep(0.0, 1.0, phase / 0.15) 
            : pow(1.0 - (phase - 0.15) / 0.85, 2.8);
            
        // 4. Modulate the surge intensity with another slow noise layer for patches
        float intensity = noise(uv * 1.5 - uTime * 0.05) * 0.6 + 0.4;
        
        float totalPush = surgeProfile * 40.0 * intensity;
        vec2 noiseDistortion = vec2(totalPush, totalPush);
        
        // Final UV lookup with continuous flow + surge
        // Use fract() for seamless tiling
        vec2 finalUv = fract(uv + flow + (noiseDistortion - mouseDistortion) / uResolution);
        
        vec4 color = texture2D(uTexture, finalUv);
        gl_FragColor = vec4(color.rgb, color.a * 0.45);
      }
    `;

    // --- Initialize WebGL ---
    const createShader = (type: number, source: string) => {
      const s = gl!.createShader(type)!;
      gl!.shaderSource(s, source);
      gl!.compileShader(s);
      return s;
    };

    program = gl.createProgram()!;
    gl.attachShader(program, createShader(gl.VERTEX_SHADER, vsSource));
    gl.attachShader(program, createShader(gl.FRAGMENT_SHADER, fsSource));
    gl.linkProgram(program);
    gl.useProgram(program);

    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
    
    const posAttrib = gl.getAttribLocation(program, 'position');
    gl.enableVertexAttribArray(posAttrib);
    gl.vertexAttribPointer(posAttrib, 2, gl.FLOAT, false, 0, 0);

    const uTexture = gl.getUniformLocation(program, 'uTexture');
    const uTime = gl.getUniformLocation(program, 'uTime');
    const uMouse = gl.getUniformLocation(program, 'uMouse');
    const uResolution = gl.getUniformLocation(program, 'uResolution');

    // --- Pretext Texture Generation ---
    const offscreen = document.createElement('canvas');
    const oCtx = offscreen.getContext('2d')!;
    
    const updateTexture = () => {
      const w = 2048; // Large enough for high quality
      const h = 2048;
      offscreen.width = w;
      offscreen.height = h;
      
      oCtx.fillStyle = '#fcfbf7'; // Background color same as page
      oCtx.clearRect(0, 0, w, h);
      
      const content = `
        research researcher analysis engine pretext library solid signal noise dictionary
        performance metrics layout reflow typography glyph weight variable smoke fluid
        interaction design developer prototype interface system context flow abstract
      `.repeat(30).trim();
      
      const fontSize = 48; // Restored larger text size
      const lineHeight = 64;
      const prepared = prepareWithSegments(content, `${fontSize}px Georgia`, {});
      const { lines } = layoutWithLines(prepared, w - 100, lineHeight);
      
      oCtx.font = `${fontSize}px Georgia`;
      oCtx.fillStyle = '#444'; // Base text color
      lines.forEach((line, i) => {
        oCtx.fillText(line.text, 50, i * lineHeight + fontSize);
      });

      const tex = gl!.createTexture();
      gl!.bindTexture(gl!.TEXTURE_2D, tex);
      gl!.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true); // Fix upside down orientation
      gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, offscreen);
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR);
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.REPEAT);
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.REPEAT);
    };

    updateTexture();

    // Enable proper alpha blending
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    // --- Animation Loop ---
    let startTime = Date.now();
    const render = () => {
      if (!canvasRef || !gl) return;
      
      // Handle resize
      const w = canvasRef.width = window.innerWidth;
      const h = canvasRef.height = window.innerHeight;
      gl.viewport(0, 0, w, h);

      // Smooth mouse follow
      mouse.x += (mouse.targetX - mouse.x) * 0.1;
      mouse.y += (mouse.targetY - mouse.y) * 0.1;

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.useProgram(program);
      gl.uniform1f(uTime, (Date.now() - startTime) / 1000);
      gl.uniform2f(uMouse, mouse.x, mouse.y);
      gl.uniform2f(uResolution, w, h);

      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      
      animationFrame = requestAnimationFrame(render);
    };

    render();

    onCleanup(() => {
      cancelAnimationFrame(animationFrame);
      window.removeEventListener('mousemove', onMouseMove);
    });
  });

  return (
    <canvas 
      ref={canvasRef} 
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100vw',
        height: '100vh',
        'pointer-events': 'none',
        'z-index': 0,
        background: '#fcfbf7' // Matches page background
      }}
    />
  );
};

export default WavyTextBackground;
