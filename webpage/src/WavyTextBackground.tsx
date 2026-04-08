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
    // Only update if mouse is within window boundaries
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
        vec2 uv = vUv;
        vec2 pixelPos = (uv - 0.5) * uResolution;
        // Use normalized distance units (0.0 - 1.0) anchored to the center
        // This works consistently across different resolution monitors
        vec2 fromCenter = uv - 0.5;
        
        // Correct X by aspect ratio to keep distance units "square" (based on height)
        float aspect = uResolution.x / uResolution.y;
        vec2 distPos = fromCenter;
        distPos.x *= aspect;
        
        // Offset in normalized distance units relative to center
        // Closer to center (from -0.15, -0.08)
        vec2 maskOffset = vec2(-0.1, -0.05); 
        vec2 interferencePos = distPos - maskOffset;
        
        // Relative size units
        vec2 boxHalfSize = vec2(0.18, 0.12);
        
        // 1. Main Dictionary Box Mask (centered)
        vec2 mainBoxHalfSize = vec2(0.2, 0.12);
        float d1 = sdRect(distPos, mainBoxHalfSize);
        
        // 2. Skewed Shadow Mask (offset and angled)
        vec2 q = interferencePos + boxHalfSize; 
        q.y -= q.x * 0.25; 
        q.x -= q.y * 0.35; 
        float d2 = sdRect(q - boxHalfSize, boxHalfSize);
        
        // Combine them (Union of both shapes)
        float d = min(d1, d2);
        
        float x = clamp(d / 0.15, 0.0, 1.0);
        
        // --- Oval Gradient (in distance units) ---
        // Anchored at bottom-left corner
        vec2 relPosDist = interferencePos + boxHalfSize;
        // Softer power (2.5) and slightly larger divisors for a gentler transition
        float distFromBL = length(relPosDist / vec2(0.5, 0.35)); 
        float fadeOut = 1.0 - pow(smoothstep(0.0, 1.0, distFromBL), 2.5); 
        
        // Adjusted overall strength: base 0.4 (meaning it masks 60% at peak)
        float maskStrength = mix(0.4, 1.0, pow(x * x * (3.0 - 2.0 * x), 1.2));
        float stability = mix(1.0, maskStrength, fadeOut);
        
        // Base constant flow
        float flowSpeed = 0.015;
        vec2 flow = vec2(uTime * flowSpeed, uTime * flowSpeed);
        
        // Mouse interaction
        vec2 mousePixel = (uMouse - 0.5) * uResolution;
        vec2 diffPixels = pixelPos - mousePixel;
        float distMouse = length(diffPixels);
        
        // Much stronger: 35.0 max push
        float mouseEffect = smoothstep(800.0, 0.0, distMouse) * 35.0 * stability;
        mouseEffect *= smoothstep(0.0, 100.0, distMouse);
        vec2 mouseDistortion = normalize(diffPixels + 0.0001) * mouseEffect;

        // 1. Mouse wave warp: The mouse physically "dents" the wave timing
        // Stronger warp: 1.5 phase shift
        float mouseWaveWarp = smoothstep(1000.0, 0.0, distMouse) * 1.5 * stability;
        
        // 2. High-frequency noise
        float waveJitter = noise((uv + flow) * 8.0 + uTime * 0.5) * 0.15;
        
        // 3. Wave Input
        float waveInput = (uv.x + uv.y) * 4.0 - uTime * 0.25 + waveJitter - mouseWaveWarp;
        float phase = fract(waveInput);

        // Organic Falloff
        float surgeProfile = phase < 0.95 
            ? pow(phase / 0.95, 6.0) 
            : 1.0 - (phase - 0.95) / 0.05;
            
        float crestMask = 1.0 - smoothstep(0.9, 1.0, surgeProfile);
        
        float nPatches = noise(uv * 1.8 - uTime * 0.06);
        float intensity = mix(0.4, 1.2, nPatches * 0.5 + 0.5);
        
        // --- Localized Mouse Boost ---
        // Reduced mouse boost (+60.0 instead of +150.0)
        float mouseBoost = smoothstep(800.0, 0.0, distMouse) * 60.0 * stability;
        float totalPush = surgeProfile * (35.0 + mouseBoost) * intensity * crestMask;
        vec2 noiseDistortion = vec2(totalPush, totalPush);
        
        // Final UV lookup
        vec2 finalUv = fract(uv + flow + (noiseDistortion - mouseDistortion) / uResolution);
        
        // --- Drastic Crest Blur (9-tap, 15px radius) ---
        float bScale = smoothstep(0.8, 1.0, surgeProfile) * 15.0;
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
        color /= 9.0;
        
        // Dynamic opacity: 
        // Much darker: base 0.25, max 0.85, broader reach (pow 0.5)
        float dynamicOpacity = mix(0.25, 0.85, pow(surgeProfile, 0.5));
        
        // Sharpening contrast boost
        vec3 finalColor = color.rgb * 0.8; // Darken the color itself
        gl_FragColor = vec4(finalColor, color.a * dynamicOpacity);
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
      const w = 2048; 
      const h = 2048; 
      
      offscreen.width = w;
      offscreen.height = h;
      oCtx.clearRect(0, 0, w, h);
      
      const content = `
        research researcher analysis engine pretext library solid signal noise dictionary
        performance metrics layout reflow typography glyph weight variable smoke fluid
        interaction design developer prototype interface system context flow abstract
      `.repeat(60).trim();
      
      const fontSize = 48;
      const lineHeight = 64;
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

    updateTexture();

    const onResize = () => {
      updateTexture();
    };
    window.addEventListener('resize', onResize);

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
      window.removeEventListener('resize', onResize);
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
