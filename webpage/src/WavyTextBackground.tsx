import { onMount, onCleanup } from 'solid-js';
import { prepareWithSegments, layoutWithLines } from './lib/pretext/layout';

const WavyTextBackground = () => {
  let canvasRef: HTMLCanvasElement | undefined;
  let animationFrame: number;
  let gl: WebGLRenderingContext | null = null;
  let program: WebGLProgram | null = null;
  
  // Mouse state for interaction
  const mouse = { x: 0.5, y: 0.5, targetX: 0.5, targetY: 0.5 };

  const onMouseMove = (e: MouseEvent) => {
    if (e.clientX >= 0 && e.clientX <= window.innerWidth && 
        e.clientY >= 0 && e.clientY <= window.innerHeight) {
      mouse.targetX = e.clientX / window.innerWidth;
      mouse.targetY = 1.0 - (e.clientY / window.innerHeight);
    }
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
        // --- ABSOLUTE PIXEL COORDINATES (Locked to screen center) ---
        vec2 pixelPos = (vUv - 0.5) * uResolution;
        
        // --- STABILITY ZONE (Absolute Pixels) ---
        // 1. Main Dictionary Box (450x250 pixels, centered)
        vec2 mainBoxHalf = vec2(225.0, 125.0);
        float d1 = sdRect(pixelPos, mainBoxHalf);
        
        // 2. Skewed Interference Shadow (Absolute Pixels)
        vec2 shadowHalf = vec2(180.0, 120.0);
        vec2 shadowOffset = vec2(-30.0, -10.0); 
        vec2 shadowPos = pixelPos - shadowOffset;
        
        // --- Skewed Shape Logic (Angled IN towards box) ---
        vec2 q = shadowPos + shadowHalf; 
        // Slant bottom edge UP strongly as we move right
        q.y -= q.x * 0.45; 
        // Much stronger left slant (0.75) towards the box
        q.x -= q.y * 0.75; 
        float d2 = sdRect(q - shadowHalf, shadowHalf);
        
        // Combine shapes
        float d = min(d1, d2);
        float stabilityEdge = clamp(d / 120.0, 0.0, 1.0);
        
        // Oval Fade (Absolute Pixels)
        // Center shifted up (offsetY + 50) and vertical divisor tightened (350 to 250) for faster top fade
        vec2 relPosBL = shadowPos + shadowHalf;
        float distBL = length((relPosBL - vec2(0.0, 50.0)) / vec2(500.0, 250.0));
        float fadeOut = 1.0 - pow(smoothstep(0.0, 1.0, distBL), 2.5);
        
        float maskStrength = mix(0.4, 1.0, pow(stabilityEdge * stabilityEdge * (3.0 - 2.0 * stabilityEdge), 1.2));
        float stability = mix(1.0, maskStrength, fadeOut);
        
        // --- WAVE PHYSICS (Absolute Pixels) ---
        float flowPixels = uTime * 30.0; // 30 pixels per second
        float waveInput = (pixelPos.x + pixelPos.y) * 0.004 - uTime * 0.25;
        
        // Mouse warp (Absolute Pixels)
        vec2 mousePixel = (uMouse - 0.5) * uResolution;
        vec2 diffPixels = pixelPos - mousePixel;
        float distMouse = length(diffPixels);
        
        float mouseWaveWarp = smoothstep(1500.0, 0.0, distMouse) * 2.0 * stability;
        float waveJitter = noise((pixelPos + flowPixels) * 0.008 + uTime * 0.5) * 0.15;
        
        float phase = fract(waveInput + waveJitter - mouseWaveWarp);
        float surgeProfile = phase < 0.95 ? pow(phase / 0.95, 6.0) : 1.0 - (phase - 0.95) / 0.05;
        float crestMask = 1.0 - smoothstep(0.9, 1.0, surgeProfile);
        
        // --- TEXTURE LOOKUP (1:1 Pixel Mapping) ---
        float mousePush = smoothstep(1200.0, 0.0, distMouse) * 15.0 * stability;
        mousePush *= smoothstep(0.0, 200.0, distMouse);
        vec2 mousePushVec = normalize(diffPixels + 0.0001) * mousePush;
        
        float mouseBoost = smoothstep(800.0, 0.0, distMouse) * 50.0 * stability;
        float totalPush = surgeProfile * (17.5 + mouseBoost) * crestMask;
        
        // Fixed texture mapping (Tiling every 2048 pixels)
        vec2 textureSize = vec2(2048.0, 2048.0);
        vec2 texCoords = (pixelPos + flowPixels + totalPush - mousePushVec) / textureSize;
        vec2 finalUv = fract(texCoords);

        // --- Crest Blur (Absolute Pixels) ---
        float bScale = smoothstep(0.8, 1.0, surgeProfile) * 30.0;
        vec2 bDir = vec2(1.0, 1.0) / uResolution;
        
        vec4 color = texture2D(uTexture, finalUv);
        color += texture2D(uTexture, finalUv + bDir * bScale);
        color += texture2D(uTexture, finalUv - bDir * bScale);
        color += texture2D(uTexture, finalUv + bDir * 2.0 * bScale);
        color += texture2D(uTexture, finalUv - bDir * 2.0 * bScale);
        color += texture2D(uTexture, finalUv + bDir * 3.0 * bScale);
        color += texture2D(uTexture, finalUv - bDir * 3.0 * bScale);
        color += texture2D(uTexture, finalUv + bDir * 4.0 * bScale);
        color += texture2D(uTexture, finalUv - bDir * 4.0 * bScale);
        color += texture2D(uTexture, finalUv + bDir * 5.0 * bScale);
        color += texture2D(uTexture, finalUv - bDir * 5.0 * bScale);
        color += texture2D(uTexture, finalUv + bDir * 6.0 * bScale);
        color += texture2D(uTexture, finalUv - bDir * 6.0 * bScale);
        color /= 13.0;
        
        float dynamicOpacity = mix(0.25, 0.85, pow(surgeProfile, 0.5));
        vec3 finalColor = color.rgb * 0.8;
        gl_FragColor = vec4(finalColor, color.a * dynamicOpacity);
      }
    `;

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

    // --- Fixed 2048x2048 Texture ---
    const offscreen = document.createElement('canvas');
    const oCtx = offscreen.getContext('2d')!;
    
    const generateTexture = () => {
      const w = 2048; 
      const h = 2048; 
      offscreen.width = w;
      offscreen.height = h;
      oCtx.clearRect(0, 0, w, h);
      
      const content = `
        research researcher analysis engine pretext library solid signal noise dictionary
        performance metrics layout reflow typography glyph weight variable smoke fluid
        interaction design developer prototype interface system context flow abstract
      `.repeat(250).trim();
      
      const fontSize = 16; // 3x smaller than 48
      const lineHeight = 22;
      const prepared = prepareWithSegments(content, `${fontSize}px Georgia`, {});
      const { lines } = layoutWithLines(prepared, w - 100, lineHeight);
      
      oCtx.font = `${fontSize}px Georgia`;
      oCtx.fillStyle = '#111';
      oCtx.textBaseline = 'top'; 
      lines.forEach((line, i) => {
        oCtx.fillText(line.text, 50, i * lineHeight);
      });

      const tex = gl!.createTexture();
      gl!.bindTexture(gl!.TEXTURE_2D, tex);
      gl!.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, offscreen);
      gl!.generateMipmap(gl!.TEXTURE_2D);
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR_MIPMAP_LINEAR);
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR);
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.REPEAT);
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.REPEAT);
    };

    generateTexture();

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    let startTime = Date.now();
    const render = () => {
      if (!canvasRef || !gl) return;
      
      const w = canvasRef.width = window.innerWidth;
      const h = canvasRef.height = window.innerHeight;
      gl.viewport(0, 0, w, h);

      mouse.x += (mouse.targetX - mouse.x) * 0.1;
      mouse.y += (mouse.targetY - mouse.y) * 0.1;

      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);

      gl.useProgram(program!);
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
        background: '#fcfbf7'
      }}
    />
  );
};

export default WavyTextBackground;
