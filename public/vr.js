// vr.js
// WebXR + WebGL renderer for WebRTC video

const canvas = document.getElementById("xrCanvas");
const video = document.getElementById("video");

let gl;
let session;
let refSpace;

let program;
let videoTexture;

let positionBuffer;
let uvBuffer;
let indexBuffer;
let indexCount = 0;

let positionLocation;
let uvLocation;

let projectionMatrixLocation;
let viewMatrixLocation;
let modelMatrixLocation;
let videoTextureLocation;

let hasLoggedFirstFrame = false;
let hasLoggedFirstVideoFrame = false;
let hasLoggedVideoNotReady = false;

function logGLErrors(stage) {
    if (!gl) return;

    let err = gl.getError();

    while (err !== gl.NO_ERROR) {
        console.error(`[GL ERROR] ${stage}: 0x${err.toString(16)}`);
        err = gl.getError();
    }
}


const CURVE_SEGMENTS = 24;
const CURVE_DEPTH_RATIO = 0.08;
const PANEL_DISTANCE_METERS = 2.0;
const SAFE_FOV_MARGIN = 0.94;

let hasLoggedFirstFrame = false;
let hasLoggedFirstVideoFrame = false;
let hasLoggedVideoNotReady = false;

function logGLErrors(stage) {
    if (!gl) return;

    let err = gl.getError();

    while (err !== gl.NO_ERROR) {
        console.error(`[GL ERROR] ${stage}: 0x${err.toString(16)}`);
        err = gl.getError();
    }
}

// -------------------------
// XR SUPPORT CHECK
// -------------------------

if (!navigator.xr) {
    console.error("WebXR not supported on this browser");
} else {
    navigator.xr.isSessionSupported("immersive-vr").then((supported) => {
        console.log("immersive-vr supported:", supported);
    });
}

// -------------------------
// SHADERS
// -------------------------

const vertexShaderSource = `
attribute vec3 position;
attribute vec2 uv;

uniform mat4 projectionMatrix;
uniform mat4 viewMatrix;
uniform mat4 modelMatrix;

varying vec2 vUV;

void main() {
    vUV = uv;
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0);
}
`;

const fragmentShaderSource = `
precision mediump float;

uniform sampler2D videoTexture;

varying vec2 vUV;

void main() {
    gl_FragColor = texture2D(videoTexture, vUV);
}
`;

function createShader(type, source) {
    const shader = gl.createShader(type);

    gl.shaderSource(shader, source);
    gl.compileShader(shader);

    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        console.error("Shader compile error:", gl.getShaderInfoLog(shader));
    }

    return shader;
}

function getVideoAspectRatio() {
    if (video && video.videoWidth > 0 && video.videoHeight > 0) {
        return video.videoWidth / video.videoHeight;
    }

    return 16 / 9;
}

function getVideoQuadModelMatrix() {
    const distanceMeters = 2.0;
    const heightMeters = 1.0;
    const widthMeters = heightMeters * getVideoAspectRatio();

    const sx = widthMeters / 2;
    const sy = heightMeters / 2;

    // Column-major transform: translate in front of user, then scale unit quad.
    return new Float32Array([
        sx, 0, 0, 0,
        0, sy, 0, 0,
        0, 0, 1, 0,
        0, 0, -distanceMeters, 1
    ]);
}


function getFacingPanelModelMatrix(viewerTransform, panelWidth, panelHeight) {
    const orientation = viewerTransform.orientation;
    const position = viewerTransform.position;

    const forward = normalizeVec3(quatRotateVec3(orientation, [0, 0, -1]));

    const centerX = position.x + forward[0] * PANEL_DISTANCE_METERS;
    const centerY = position.y + forward[1] * PANEL_DISTANCE_METERS;
    const centerZ = position.z + forward[2] * PANEL_DISTANCE_METERS;

    const sx = panelWidth / 2;
    const sy = panelHeight / 2;

    const x = orientation.x;
    const y = orientation.y;
    const z = orientation.z;
    const w = orientation.w;

    const xx = x * x;
    const yy = y * y;
    const zz = z * z;
    const xy = x * y;
    const xz = x * z;
    const yz = y * z;
    const wx = w * x;
    const wy = w * y;
    const wz = w * z;

    const r00 = 1 - 2 * (yy + zz);
    const r01 = 2 * (xy + wz);
    const r02 = 2 * (xz - wy);

    const r10 = 2 * (xy - wz);
    const r11 = 1 - 2 * (xx + zz);
    const r12 = 2 * (yz + wx);

    const r20 = 2 * (xz + wy);
    const r21 = 2 * (yz - wx);
    const r22 = 1 - 2 * (xx + yy);

    // model = T * R * S (column-major)
    return new Float32Array([
        r00 * sx, r10 * sx, r20 * sx, 0,
        r01 * sy, r11 * sy, r21 * sy, 0,
        r02,      r12,      r22,      0,
        centerX,  centerY,  centerZ,  1
    ]);
}

// -------------------------
// INITIALIZE WEBGL
// -------------------------

async function initGL() {
    if (!canvas) {
        throw new Error("xrCanvas not found in DOM");
    }

    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;

    if (!canvas) {
        throw new Error("Canvas element #xrCanvas was not found");
    }

    // Prefer WebGL1 for maximum XRWebGLLayer compatibility on mobile headsets.
    // Some runtimes expose WebGL2 but fail internally when binding XR swapchains.
    gl =
        canvas.getContext("webgl", { xrCompatible: true, alpha: false, antialias: false }) ||
        canvas.getContext("experimental-webgl", { xrCompatible: true, alpha: false, antialias: false }) ||
        canvas.getContext("webgl2", { xrCompatible: true, alpha: false, antialias: false });

    if (!gl) {
        throw new Error("Unable to create WebGL context. WebXR requires WebGL support.");
    }

    console.log("GL context created:", {
        type: gl instanceof WebGL2RenderingContext ? "webgl2" : "webgl",
        renderer: gl.getParameter(gl.RENDERER),
        version: gl.getParameter(gl.VERSION)
    });

    // Some runtimes expose makeXRCompatible on WebGL contexts and some do not.
    if (typeof gl.makeXRCompatible === "function") {
        await gl.makeXRCompatible();
        console.log("makeXRCompatible() completed");
    } else {
        console.log("makeXRCompatible() not available on this context");
    }

    const vertexShader = createShader(gl.VERTEX_SHADER, vertexShaderSource);
    const fragmentShader = createShader(gl.FRAGMENT_SHADER, fragmentShaderSource);

    program = gl.createProgram();
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        console.error("Program link error:", gl.getProgramInfoLog(program));
    }

    gl.useProgram(program);


    // QUAD VERTICES

    const vertices = new Float32Array([
        -1, -1, 0,
         1, -1, 0,
         1,  1, 0,

        -1, -1, 0,
         1,  1, 0,
        -1,  1, 0
    ]);

    const uvs = new Float32Array([
        0, 1,
        1, 1,
        1, 0,

        0, 1,
        1, 0,
        0, 0
    ]);


    // POSITION BUFFER
    positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.positions, gl.STATIC_DRAW);

    positionLocation = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(positionLocation);
    gl.vertexAttribPointer(positionLocation, 3, gl.FLOAT, false, 0, 0);

    // UV BUFFER
    uvBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.uvs, gl.STATIC_DRAW);

    uvLocation = gl.getAttribLocation(program, "uv");
    gl.enableVertexAttribArray(uvLocation);
    gl.vertexAttribPointer(uvLocation, 2, gl.FLOAT, false, 0, 0);

    // INDEX BUFFER
    indexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);

    // UNIFORMS
    projectionMatrixLocation = gl.getUniformLocation(program, "projectionMatrix");
    viewMatrixLocation = gl.getUniformLocation(program, "viewMatrix");
    modelMatrixLocation = gl.getUniformLocation(program, "modelMatrix");
    videoTextureLocation = gl.getUniformLocation(program, "videoTexture");

    // UNIFORMS

    projectionMatrixLocation = gl.getUniformLocation(program, "projectionMatrix");
    viewMatrixLocation = gl.getUniformLocation(program, "viewMatrix");
    modelMatrixLocation = gl.getUniformLocation(program, "modelMatrix");
    videoTextureLocation = gl.getUniformLocation(program, "videoTexture");


    // VIDEO TEXTURE
    videoTexture = gl.createTexture();

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, videoTexture);

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    gl.uniform1i(videoTextureLocation, 0);

    gl.enable(gl.DEPTH_TEST);

    console.log("initGL complete");
    logGLErrors("initGL complete");

}

    gl.uniform1i(videoTextureLocation, 0);
    gl.enable(gl.DEPTH_TEST);

    console.log("initGL complete", { indexCount, curveSegments: CURVE_SEGMENTS });
    logGLErrors("initGL complete");
}

// -------------------------
// UPDATE VIDEO TEXTURE
// -------------------------

function updateVideoTexture() {
    if (video.readyState >= 2) {
        if (!hasLoggedFirstVideoFrame) {
            hasLoggedFirstVideoFrame = true;
            console.log("First video frame ready:", {
                readyState: video.readyState,
                width: video.videoWidth,
                height: video.videoHeight,
                currentTime: video.currentTime
            });
        }

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, videoTexture);

        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGBA,
            gl.RGBA,
            gl.UNSIGNED_BYTE,
            video
        );

        logGLErrors("updateVideoTexture");
    } else {
        if (!hasLoggedVideoNotReady) {
            hasLoggedVideoNotReady = true;
            console.log("Video not ready for texture upload yet:", {
                readyState: video.readyState,
                paused: video.paused,
                muted: video.muted
            });
        }
    }

        logGLErrors("updateVideoTexture");
    } else if (!hasLoggedVideoNotReady) {
        hasLoggedVideoNotReady = true;
        console.log("Video not ready for texture upload yet:", {
            readyState: video.readyState,
            paused: video.paused,
            muted: video.muted
        });
    }
}

// -------------------------
// DRAW
// -------------------------

function draw(view) {

    gl.uniformMatrix4fv(projectionMatrixLocation, false, view.projectionMatrix);
    gl.uniformMatrix4fv(viewMatrixLocation, false, view.transform.inverse.matrix);
    gl.uniformMatrix4fv(modelMatrixLocation, false, getVideoQuadModelMatrix());

    gl.drawArrays(gl.TRIANGLES, 0, 6);

    logGLErrors(`draw eye=${view.eye}`);
}

// -------------------------
// XR FRAME LOOP
// -------------------------

function onXRFrame(time, frame) {
    const pose = frame.getViewerPose(refSpace);

    if (pose) {
        if (!hasLoggedFirstFrame) {
            hasLoggedFirstFrame = true;
            console.log("First XR frame:", {
                viewCount: pose.views.length,
                framebufferWidth: layer.framebufferWidth,
                framebufferHeight: layer.framebufferHeight
            });
        }

        updateVideoTexture();

        // Clear once for the full XR framebuffer.
        gl.viewport(0, 0, layer.framebufferWidth, layer.framebufferHeight);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        updateVideoTexture();

        // Clear once for the full XR framebuffer.
        // Clearing inside the per-eye loop wipes the previously rendered eye.
        gl.viewport(0, 0, layer.framebufferWidth, layer.framebufferHeight);
        gl.clearColor(0,0,0,1);
        gl.clear(gl.COLOR_BUFFER_BIT);

        // Upload video texture before binding XR framebuffer to avoid driver quirks.
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        updateVideoTexture();

        gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);

        gl.viewport(0, 0, layer.framebufferWidth, layer.framebufferHeight);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        const { panelWidth, panelHeight } = getPanelSizeForViews(pose.views);
        const modelMatrix = getFacingPanelModelMatrix(pose.transform, panelWidth, panelHeight);

            draw(view);
        }
    } else {
        console.warn("No viewer pose for XR frame");
    }

    session.requestAnimationFrame(onXRFrame);
}

// -------------------------
// START VR
// -------------------------

async function startVR() {
    session = await navigator.xr.requestSession("immersive-vr", {
        requiredFeatures: ["local"]
    });

    console.log("XR session acquired");

    session.addEventListener("end", () => {
        console.log("XR session ended");
    });

    session.updateRenderState({
        baseLayer: new XRWebGLLayer(session, gl, {
            antialias: false,
            alpha: false,
            depth: true,
            stencil: false,
            framebufferScaleFactor: 1.0
        })
    });

    logGLErrors("after session.updateRenderState");

    refSpace = await session.requestReferenceSpace("local");

    refSpace = await session.requestReferenceSpace("local");
    session.requestAnimationFrame(onXRFrame);

    console.log("VR session started");
}

// -------------------------
// BUTTON
// -------------------------

document.getElementById("startVR").onclick = async () => {
    try {
        console.log("Start VR pressed");
        await initGL();
        await startVR();
    } catch (err) {
        console.error("Failed to start VR:", err);
    }

};
