import { onMount, onCleanup } from 'solid-js';
import { prepareWithSegments, layoutWithLines } from './lib/pretext/layout';

const WavyTextBackground = () => {
  let canvasRef: HTMLCanvasElement | undefined;
  let animationFrame: number;
  let gl: WebGLRenderingContext | null = null;
  let program: WebGLProgram | null = null;
  
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
      uniform sampler2D uAnchor;
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
        vec2 pixelPos = (vUv - 0.5) * uResolution;
        float flowPixels = uTime * 30.0;
        vec2 textureSize = vec2(2048.0, 2048.0);
        
        // --- 1. Identify Character Anchor ---
        vec2 baseUv = fract((pixelPos + flowPixels) / textureSize);
        vec4 anchorData = texture2D(uAnchor, baseUv);
        // Decode +/- 128px offset
        vec2 charOffset = (anchorData.rg - 0.5) * 256.0;
        vec2 anchorPos = (pixelPos + flowPixels) - charOffset;
        
        // --- 2. Masking & Stability (Absolute Pixels) ---
        vec2 mainBoxHalf = vec2(225.0, 125.0);
        float d1 = sdRect(pixelPos, mainBoxHalf);
        
        vec2 shadowHalf = vec2(180.0, 120.0);
        vec2 shadowOffset = vec2(-10.0, -5.0);
        vec2 shadowPos = pixelPos - shadowOffset;
        vec2 sq = shadowPos + shadowHalf; 
        sq.y -= sq.x * 0.45; sq.x -= sq.y * 1.2; 
        float d2 = sdRect(sq - shadowHalf, shadowHalf);
        
        float d = min(d1, d2);
        float stabilityEdge = clamp(d / 120.0, 0.0, 1.0);
        vec2 relPosBL = shadowPos + shadowHalf;
        float distBL = length((relPosBL - vec2(0.0, 50.0)) / vec2(500.0, 250.0));
        float fadeOut = 1.0 - pow(smoothstep(0.0, 1.0, distBL), 2.5);
        float stability = mix(1.0, mix(0.55, 1.0, pow(stabilityEdge * stabilityEdge * (3.0 - 2.0 * stabilityEdge), 1.2)), fadeOut);

        // --- 3. Whole-Character Physics (Surge & Mouse) ---
        float waveInput = (anchorPos.x + anchorPos.y) * 0.004 - uTime * 0.25;
        float waveJitter = noise(anchorPos * 0.008 + uTime * 0.5) * 0.15;
        float phase = fract(waveInput + waveJitter);
        float surgeProfile = phase < 0.95 ? pow(phase / 0.95, 6.0) : 1.0 - (phase - 0.95) / 0.05;
        
        vec2 mousePixel = (uMouse - 0.5) * uResolution;
        vec2 diffPixels = pixelPos - mousePixel;
        float distMouse = length(diffPixels);
        float mousePush = smoothstep(1200.0, 0.0, distMouse) * 15.0 * stability;
        vec2 mousePushVec = normalize(diffPixels + 0.0001) * mousePush * smoothstep(0.0, 200.0, distMouse);
        
        float mouseBoost = smoothstep(800.0, 0.0, distMouse) * 50.0 * stability;
        float totalSurge = surgeProfile * (17.5 + mouseBoost);
        
        // --- 4. Character-Box Collision (Subtle & Super Cool) ---
        vec2 distortedAnchor = anchorPos - flowPixels + vec2(totalSurge) - mousePushVec;
        float boxDist = sdRect(distortedAnchor, mainBoxHalf);
        vec2 collisionPush = vec2(0.0);
        if (boxDist < 40.0) {
           collisionPush = normalize(distortedAnchor) * smoothstep(40.0, -10.0, boxDist) * 35.0;
        }

        // --- 5. Final Lookup & Chromatic Aberration ---
        vec2 pushDir = normalize(vec2(1.0, 1.0));
        vec2 finalOffset = pushDir * totalSurge - mousePushVec + collisionPush;
        vec2 finalUv = fract((pixelPos + flowPixels + finalOffset) / textureSize);
        
        float bScale = smoothstep(0.8, 1.0, surgeProfile) * 30.0;
        vec2 bDir = pushDir / uResolution;
        
        // Chromatic Aberration: R, G, B sampled at slightly different positions during surge
        float ca = surgeProfile * 0.002;
        vec4 color;
        color.r = texture2D(uTexture, finalUv + vec2(ca, 0.0)).r;
        color.g = texture2D(uTexture, finalUv).g;
        color.b = texture2D(uTexture, finalUv - vec2(ca, 0.0)).b;
        color.a = texture2D(uTexture, finalUv).a;
        
        // 7-tap blur for performance
        for(float i=1.0; i<=3.0; i++) {
          color += texture2D(uTexture, finalUv + bDir * i * bScale);
          color += texture2D(uTexture, finalUv - bDir * i * bScale);
        }
        color /= 7.0;

        float dynamicOpacity = mix(0.25, 0.85, pow(surgeProfile, 0.5));
        gl_FragColor = vec4(color.rgb * 0.8, color.a * dynamicOpacity);
      }
    `;

    const createShader = (type: number, source: string) => {
      const s = gl!.createShader(type)!;
      gl!.shaderSource(s, source);
      gl!.compileShader(s);
      if (!gl!.getShaderParameter(s, gl!.COMPILE_STATUS)) {
        console.error(gl!.getShaderInfoLog(s));
      }
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
    const uAnchor = gl.getUniformLocation(program, 'uAnchor');
    const uTime = gl.getUniformLocation(program, 'uTime');
    const uMouse = gl.getUniformLocation(program, 'uMouse');
    const uResolution = gl.getUniformLocation(program, 'uResolution');

    gl.uniform1i(uTexture, 0);
    gl.uniform1i(uAnchor, 1);

    const textCanvas = document.createElement('canvas');
    const anchorCanvas = document.createElement('canvas');
    const tCtx = textCanvas.getContext('2d')!;
    const aCtx = anchorCanvas.getContext('2d', { alpha: false })!;
    
    const generateTextures = () => {
      const size = 2048;
      textCanvas.width = anchorCanvas.width = size;
      textCanvas.height = anchorCanvas.height = size;
      
      tCtx.clearRect(0, 0, size, size);
      aCtx.fillStyle = 'rgb(128, 128, 0)'; // Neutral 0 offset
      aCtx.fillRect(0, 0, size, size);
      
      const content = `
        research researcher analysis engine pretext library solid signal noise dictionary
        performance metrics layout reflow typography glyph weight variable smoke fluid
        interaction design developer prototype interface system context flow abstract
      `.repeat(100).trim();
      
      const fontSize = 16;
      const lineHeight = 22;
      const prepared = prepareWithSegments(content, `${fontSize}px Georgia`, {});
      const { lines } = layoutWithLines(prepared, size - 100, lineHeight);
      
      tCtx.font = `${fontSize}px Georgia`;
      tCtx.fillStyle = '#111';
      tCtx.textBaseline = 'top';
      
      lines.forEach((line, li) => {
        const y = li * lineHeight;
        let x = 50;
        const chars = Array.from(line.text);
        
        chars.forEach(char => {
          const metrics = tCtx.measureText(char);
          const w = metrics.width;
          if (char !== ' ') {
            const centerX = x + w / 2;
            const centerY = y + fontSize / 2;
            
            // Draw Anchor Map (local offsets)
            for (let py = Math.floor(y); py < y + lineHeight; py++) {
              for (let px = Math.floor(x); px < x + w; px++) {
                const ox = Math.max(0, Math.min(255, (px - centerX) + 128));
                const oy = Math.max(0, Math.min(255, (py - centerY) + 128));
                // We could use putImageData for speed, but this is a one-time build
                aCtx.fillStyle = `rgb(${ox}, ${oy}, 0)`;
                aCtx.fillRect(px, py, 1, 1);
              }
            }
            tCtx.fillText(char, x, y);
          }
          x += w;
        });
      });

      const createTex = (src: HTMLCanvasElement) => {
        const tex = gl!.createTexture();
        gl!.bindTexture(gl!.TEXTURE_2D, tex);
        gl!.pixelStorei(gl!.UNPACK_FLIP_Y_WEBGL, true);
        gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGBA, gl!.RGBA, gl!.UNSIGNED_BYTE, src);
        gl!.generateMipmap(gl!.TEXTURE_2D);
        gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR_MIPMAP_LINEAR);
        gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR);
        gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.REPEAT);
        gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.REPEAT);
        return tex;
      };

      const textTex = createTex(textCanvas);
      const anchorTex = createTex(anchorCanvas);
      return { textTex, anchorTex };
    };

    const { textTex, anchorTex } = generateTextures();

    const resizeCanvas = () => {
      if (!canvasRef || !gl) return;
      canvasRef.width = window.innerWidth;
      canvasRef.height = window.innerHeight;
      gl.viewport(0, 0, canvasRef.width, canvasRef.height);
    };
    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    let startTime = Date.now();
    const render = () => {
      if (!canvasRef || !gl) return;
      mouse.x += (mouse.targetX - mouse.x) * 0.1;
      mouse.y += (mouse.targetY - mouse.y) * 0.1;
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(program!);
      gl.uniform1f(uTime, (Date.now() - startTime) / 1000);
      gl.uniform2f(uMouse, mouse.x, mouse.y);
      gl.uniform2f(uResolution, canvasRef.width, canvasRef.height);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, textTex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, anchorTex);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      animationFrame = requestAnimationFrame(render);
    };
    render();

    onCleanup(() => {
      cancelAnimationFrame(animationFrame);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('resize', resizeCanvas);
    });
  });

  return (
    <canvas ref={canvasRef} style={{
      position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
      'pointer-events': 'none', 'z-index': 0, background: '#fcfbf7'
    }}/>
  );
};

export default WavyTextBackground;
