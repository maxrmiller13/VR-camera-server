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

varying vec2 vUV;

void main() {
    vUV = uv;
    gl_Position = vec4(position, 1.0);
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



// -------------------------
// INITIALIZE WEBGL
// -------------------------

async function initGL() {
    if (!canvas) {
        throw new Error("xrCanvas not found in DOM");
    }

    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;

    gl = canvas.getContext("webgl", { xrCompatible: true });

    await gl.makeXRCompatible();

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
        -1,-1,0,
         1,-1,0,
         1, 1,0,

        -1,-1,0,
         1, 1,0,
        -1, 1,0
    ]);

    const uvs = new Float32Array([
        0,1,
        1,1,
        1,0,

        0,1,
        1,0,
        0,0
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


    // VIDEO TEXTURE

    videoTexture = gl.createTexture();

    gl.bindTexture(gl.TEXTURE_2D, videoTexture);

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

}



// -------------------------
// UPDATE VIDEO TEXTURE
// -------------------------

function updateVideoTexture() {

    if (video.readyState >= 2) {

        gl.bindTexture(gl.TEXTURE_2D, videoTexture);

        gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.RGB,
            gl.RGB,
            gl.UNSIGNED_BYTE,
            video
        );
    }

}



// -------------------------
// DRAW
// -------------------------

function draw() {

    updateVideoTexture();

    gl.clearColor(0,0,0,1);
    gl.clear(gl.COLOR_BUFFER_BIT);

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

        for (const view of pose.views) {

            const viewport = layer.getViewport(view);

            gl.viewport(
                viewport.x,
                viewport.y,
                viewport.width,
                viewport.height
            );

            draw();
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