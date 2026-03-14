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

let positionLocation;
let uvLocation;

let projectionMatrixLocation;
let viewMatrixLocation;
let modelMatrixLocation;
let videoTextureLocation;



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

    gl =
        canvas.getContext("webgl2", { xrCompatible: true, alpha: false }) ||
        canvas.getContext("webgl", { xrCompatible: true, alpha: false }) ||
        canvas.getContext("experimental-webgl", { xrCompatible: true, alpha: false });

    if (!gl) {
        throw new Error("Unable to create WebGL context. WebXR requires WebGL support.");
    }

    // Some runtimes expose makeXRCompatible on WebGL contexts and some do not.
    if (typeof gl.makeXRCompatible === "function") {
        await gl.makeXRCompatible();
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
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    positionLocation = gl.getAttribLocation(program, "position");

    gl.enableVertexAttribArray(positionLocation);

    gl.vertexAttribPointer(
        positionLocation,
        3,
        gl.FLOAT,
        false,
        0,
        0
    );


    // UV BUFFER

    uvBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, uvs, gl.STATIC_DRAW);

    uvLocation = gl.getAttribLocation(program, "uv");

    gl.enableVertexAttribArray(uvLocation);

    gl.vertexAttribPointer(
        uvLocation,
        2,
        gl.FLOAT,
        false,
        0,
        0
    );


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

}



// -------------------------
// UPDATE VIDEO TEXTURE
// -------------------------

function updateVideoTexture() {

    if (video.readyState >= 2) {

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
    }

}



// -------------------------
// DRAW
// -------------------------

function draw(view) {

    gl.drawArrays(gl.TRIANGLES, 0, 6);
}



// -------------------------
// XR FRAME LOOP
// -------------------------

function onXRFrame(time, frame) {

    const pose = frame.getViewerPose(refSpace);
    const layer = session.renderState.baseLayer;

    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);

    if (pose) {

        updateVideoTexture();

        // Clear once for the full XR framebuffer.
        // Clearing inside the per-eye loop wipes the previously rendered eye.
        gl.viewport(0, 0, layer.framebufferWidth, layer.framebufferHeight);
        gl.clearColor(0,0,0,1);
        gl.clear(gl.COLOR_BUFFER_BIT);

        for (const view of pose.views) {

            const viewport = layer.getViewport(view);

            gl.viewport(
                viewport.x,
                viewport.y,
                viewport.width,
                viewport.height
            );

            draw(view);
        }
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

    session.updateRenderState({
        baseLayer: new XRWebGLLayer(session, gl)
    });

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
