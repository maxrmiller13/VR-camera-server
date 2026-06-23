/**
 * webxr-video.js
 *
 * Grabs the <video id="Video"> element and renders it as a screen-space
 * overlay inside a WebXR immersive-vr session — no model or view matrix used.
 *
 * The quad lives in clip space (NDC). A u_scale vec2 uniform controls its
 * apparent size: (1, 1) = full FOV (feels zoomed in on a headset), smaller
 * values shrink the quad and add black letterbox/pillarbox borders.
 * XR_VIDEO_SCALE below is the tunable default; aspect ratio is corrected
 * automatically using each eye's actual viewport dimensions.
 *
 * For single-camera (mono) sources a u_lens_offset vec2 cancels each eye's
 * frustum asymmetry so both eyes see the image at the same screen position
 * and no double-image / stereo ghost appears.
 *
 * Usage
 * -----
 * 1. Include this script in a page that has a <video id="Video"> element.
 * 2. Call startXR() from a user gesture (e.g. a button click).
 * 3. Call endXR() to stop the session programmatically.
 */

'use strict';

/**
 * How large the video quad appears as a fraction of each eye's full FOV.
 *   1.0 = fills the entire headset FOV (too zoomed-in on most headsets)
 *   0.6 = comfortable "cinema screen" feel  ← default
 *   0.4 = smaller picture-in-picture style
 * Aspect ratio is corrected automatically per eye, so the video won't stretch.
 */
const XR_VIDEO_SCALE = 0.6;

/**
 * Framebuffer resolution relative to the headset's native pixel count.
 *   'native' → XRWebGLLayer.getNativeFramebufferScaleFactor() — true native
 *              resolution, sharpest possible (Quest 2: 1832×1920 per eye).
 *   1.0      → WebXR "recommended" default — often only 50–70 % of native
 *              pixels, which is why the image looks fuzzy out of the box.
 * For a simple video quad there is negligible GPU cost to going native, so we
 * default to it.  Lower to 1.0 only if you add heavy 3D geometry later.
 *
 * @type {'native' | number}
 */
const XR_FRAMEBUFFER_SCALE = 'native';

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Start a WebXR immersive-vr session and display #Video full-screen in it.
 * Resolves when the session ends, rejects on any setup error.
 *
 * @returns {Promise<void>}
 */

// Declare currentOrientation to be used for the camera servos
let latestYaw = 0;
let latestPitch = 0;

let yawOffset = 0;
let pitchOffset = 0;

function checkCalibrationButton(){};

async function startXR() {
  // ── 1. Validate environment ────────────────────────────────────────────────
  if (!navigator.xr) {
    throw new Error('WebXR not supported in this browser.');
  }

  const supported = await navigator.xr.isSessionSupported('immersive-vr');
  if (!supported) {
    throw new Error('immersive-vr session not supported on this device.');
  }

  // ── 2. Grab the video element ─────────────────────────────────────────────
  const video = document.getElementById('video');
  if (!video || !(video instanceof HTMLVideoElement)) {
    throw new Error('No <video id="Video"> element found in the document.');
  }

  if (video.paused) {
    await video.play().catch(err => {
      console.warn('[webxr-video] Could not auto-play video:', err.message);
    });
  }

  // ── 3. Request XR session ─────────────────────────────────────────────────
  const session = await navigator.xr.requestSession('immersive-vr', {
    requiredFeatures: ['local-floor'],
    optionalFeatures: ['bounded-floor', 'hand-tracking'],
  });

  // ── 4. Create WebGL context ───────────────────────────────────────────────
  const canvas = document.createElement('canvas');
  const gl     = canvas.getContext('webgl2', { xrCompatible: true })
              ?? canvas.getContext('webgl',  { xrCompatible: true });

  if (!gl) {
    session.end();
    throw new Error('WebGL not available.');
  }

  await gl.makeXRCompatible();

  // ── 5. Wire GL context to XR session ─────────────────────────────────────
  // Request native framebuffer resolution so the video is as sharp as the
  // headset display allows.  The default WebXR "recommended" scale (1.0) is
  // often only 50–70 % of native pixels, which causes the blurry look.
  const fbScale = XR_FRAMEBUFFER_SCALE === 'native'
    ? XRWebGLLayer.getNativeFramebufferScaleFactor(session)
    : XR_FRAMEBUFFER_SCALE;

  const baseLayer = new XRWebGLLayer(session, gl, { framebufferScaleFactor: fbScale });
  session.updateRenderState({ baseLayer });

  // We still need a reference space to obtain the views (and their viewports).
  const refSpace = await session.requestReferenceSpace('local-floor');

  // ── 6. Compile shaders ────────────────────────────────────────────────────
  const program = buildShaderProgram(gl);
  if (!program) {
    session.end();
    throw new Error('Shader compilation failed.');
  }

  const attribLoc = {
    position: gl.getAttribLocation(program, 'a_position'),
    uv:       gl.getAttribLocation(program, 'a_uv'),
  };
  const samplerLoc    = gl.getUniformLocation(program, 'u_sampler');
  const scaleLoc      = gl.getUniformLocation(program, 'u_scale');
  const lensOffsetLoc = gl.getUniformLocation(program, 'u_lens_offset');

  // ── 7. Full-screen clip-space quad ────────────────────────────────────────
  const { vao, indexCount } = buildFullscreenQuad(gl, attribLoc);

  // ── 8. Video texture ──────────────────────────────────────────────────────
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,     gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,     gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  // 1×1 black placeholder until the first video frame arrives
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0,
                gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));

  // ── 9. Render loop ────────────────────────────────────────────────────────
  function onXRFrame(_time, frame) {
    // Check for calibration button input
    checkCalibrationButton(session);

    // Poll current oriontation
    const pose = frame.getViewerPose(refSpace);

    if (pose) {
      const euler = quaternionToEuler(pose.views[0].transform.orientation);

      latestYaw = euler.yaw;
      latestPitch = euler.pitch;
    }

    session.requestAnimationFrame(onXRFrame);

    // We need pose to access per-eye viewports and projection matrices.
    if (!pose) return;

    // Upload latest video frame to the GPU texture (once per XR frame)
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA,
                    gl.UNSIGNED_BYTE, video);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, baseLayer.framebuffer);

    // Depth testing is irrelevant for a flat screen-space blit
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.uniform1i(samplerLoc, 0);

    // Draw the quad into each eye's viewport with aspect-ratio and lens correction
    for (const view of pose.views) {
      const vp = baseLayer.getViewport(view);
      gl.viewport(vp.x, vp.y, vp.width, vp.height);

      // ── Aspect-ratio correction ──────────────────────────────────────────
      // u_scale makes the video fill the viewport without stretching.
      const vpAspect    = vp.width / vp.height;
      const videoAspect = (video.videoWidth || 16) / (video.videoHeight || 9);
      const fitX = videoAspect / vpAspect;
      gl.uniform2f(
        scaleLoc,
        Math.min(fitX, 1.0) * XR_VIDEO_SCALE,
        Math.min(1.0 / fitX, 1.0) * XR_VIDEO_SCALE,
      );

      // ── Lens-center offset (mono fix) ────────────────────────────────────
      // Each eye's projection matrix encodes an asymmetric frustum: the
      // horizontal and vertical frustum shifts live at indices [8] and [9]
      // (column-major).  An object on the gaze axis projects to NDC
      // (-proj[8], -proj[9]), NOT (0, 0).  Without this correction both eyes
      // see the image at slightly different horizontal positions, producing a
      // double-image for a mono source.  We shift the quad by the negative of
      // that offset so the image is centred on each eye's actual optical axis.
      const proj = view.projectionMatrix;
      gl.uniform2f(lensOffsetLoc, -proj[8], -proj[9]);

      if (vao) {
        gl.bindVertexArray(vao);
        gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0);
        gl.bindVertexArray(null);
      } else {
        gl.drawElements(gl.TRIANGLES, indexCount, gl.UNSIGNED_SHORT, 0);
      }
    }
  }

  // ── 10. Handle session end ────────────────────────────────────────────────
  session.addEventListener('end', () => {
    gl.deleteTexture(texture);
    gl.deleteProgram(program);
    console.log('[webxr-video] XR session ended.');
  });

  session.requestAnimationFrame(onXRFrame);
  startXR.currentSession = session;
}

/** End the active XR session, if any. */
function endXR() {
  if (startXR.currentSession) {
    startXR.currentSession.end();
    startXR.currentSession = null;
  }
}


// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Compile and link shaders.
 *
 * The vertex shader passes clip-space positions straight through — no matrix.
 * The fragment shader samples the video texture.
 *
 * @param {WebGLRenderingContext|WebGL2RenderingContext} gl
 * @returns {WebGLProgram|null}
 */
function buildShaderProgram(gl) {
  // Positions are in clip space; u_scale shrinks the quad, u_lens_offset
  // recentres it on each eye's optical axis to eliminate stereo ghosting.
  const vsSource = /* glsl */`
    attribute vec2 a_position;
    attribute vec2 a_uv;
    uniform   vec2 u_scale;
    uniform   vec2 u_lens_offset;
    varying   vec2 v_uv;
    void main() {
      v_uv        = a_uv;
      gl_Position = vec4(a_position * u_scale + u_lens_offset, 0.0, 1.0);
    }
  `;

  const fsSource = /* glsl */`
    precision mediump float;
    uniform sampler2D u_sampler;
    varying vec2      v_uv;
    void main() {
      gl_FragColor = texture2D(u_sampler, v_uv);
    }
  `;

  const vs = compileShader(gl, gl.VERTEX_SHADER,   vsSource);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
  if (!vs || !fs) return null;

  const program = gl.createProgram();
  gl.attachShader(program, vs);
  gl.attachShader(program, fs);
  gl.linkProgram(program);
  gl.deleteShader(vs);
  gl.deleteShader(fs);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.error('[webxr-video] Program link error:', gl.getProgramInfoLog(program));
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

function compileShader(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const name = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
    console.error(`[webxr-video] ${name} shader error:`, gl.getShaderInfoLog(shader));
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/**
 * Build a unit quad in clip space (-1..1 in X and Y).
 * u_scale in the vertex shader controls the visible size at runtime.
 *
 * @param {WebGLRenderingContext|WebGL2RenderingContext} gl
 * @param {{ position: number, uv: number }} attribLoc
 * @returns {{ vao: WebGLVertexArrayObject|null, indexCount: number }}
 */
function buildFullscreenQuad(gl, attribLoc) {
  // Interleaved: clip-space xy (2 floats) + uv (2 floats)
  const vertices = new Float32Array([
  //  x     y     u    v
    -1.0, -1.0,  0.0, 1.0,   // bottom-left
     1.0, -1.0,  1.0, 1.0,   // bottom-right
     1.0,  1.0,  1.0, 0.0,   // top-right
    -1.0,  1.0,  0.0, 0.0,   // top-left
  ]);

  const indices = new Uint16Array([0, 1, 2,  0, 2, 3]);

  const STRIDE    = 4 * Float32Array.BYTES_PER_ELEMENT;
  const UV_OFFSET = 2 * Float32Array.BYTES_PER_ELEMENT;

  const isGL2 = typeof WebGL2RenderingContext !== 'undefined'
             && gl instanceof WebGL2RenderingContext;
  const vao = isGL2 ? gl.createVertexArray() : null;
  if (vao) gl.bindVertexArray(vao);

  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

  gl.enableVertexAttribArray(attribLoc.position);
  gl.vertexAttribPointer(attribLoc.position, 2, gl.FLOAT, false, STRIDE, 0);

  gl.enableVertexAttribArray(attribLoc.uv);
  gl.vertexAttribPointer(attribLoc.uv, 2, gl.FLOAT, false, STRIDE, UV_OFFSET);

  const ibo = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);

  if (vao) gl.bindVertexArray(null);

  return { vao, indexCount: indices.length };
}

function quaternionToEuler(q) {
    const { x, y, z, w } = q;

    const yaw = Math.atan2(
        2 * (w * y + x * z),
        1 - 2 * (y * y + z * z)
    );

    const pitch = Math.asin(
        Math.max(-1, Math.min(1,
            2 * (w * x - y * z)
        ))
    );

    return {
        yaw: yaw * 180 / Math.PI,
        pitch: pitch * 180 / Math.PI
    };
  }

  function calibrate() {
    yawOffset = latestYaw;
    pitchOffset = latestPitch;

    console.log("Headset calibrated");
  }

  let calibratePressed = false;

  function checkCalibrationButton(session) {

      for (const source of session.inputSources) {

          if (!source.gamepad) continue;

          const pressed = source.gamepad.buttons[0].pressed;

          if (pressed && !calibratePressed) {
              calibrate();
          }

          calibratePressed = pressed;
      }
  }

  const socket = io();

  socket.on("connect", () => {
      console.log("Socket connected:", socket.id);
  });

  setInterval(() => {
    socket.emit("headTracking", {
        yaw: latestYaw - yawOffset,
        pitch: latestPitch - pitchOffset
    });
  }, 20);   // 20 ms = 50 Hz