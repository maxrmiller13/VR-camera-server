// webxr-video.js

export class WebXRVideoPlayer {
    constructor(videoElement) {
        this.video = videoElement;

        this.xrSession = null;
        this.gl = null;
        this.xrRefSpace = null;

        this.program = null;
        this.texture = null;

        this.positionBuffer = null;
        this.texcoordBuffer = null;
    }

    async start() {
        if (!navigator.xr) {
            throw new Error("WebXR not supported");
        }

        this.xrSession = await navigator.xr.requestSession("immersive-vr");

        const canvas = document.createElement("canvas");
        this.gl = canvas.getContext("webgl", {
            xrCompatible: true
        });

        await this.gl.makeXRCompatible();

        this.xrSession.updateRenderState({
            baseLayer: new XRWebGLLayer(this.xrSession, this.gl)
        });

        this.xrRefSpace =
            await this.xrSession.requestReferenceSpace("local");

        this.initGL();

        this.xrSession.requestAnimationFrame(
            this.onXRFrame.bind(this)
        );
    }

    initGL() {
        const gl = this.gl;

        const vs = `
            attribute vec3 position;
            attribute vec2 texcoord;

            uniform mat4 projectionMatrix;
            uniform mat4 viewMatrix;
            uniform mat4 modelMatrix;

            varying vec2 vTexcoord;

            void main() {
                vTexcoord = texcoord;
                gl_Position =
                    projectionMatrix *
                    viewMatrix *
                    modelMatrix *
                    vec4(position, 1.0);
            }
        `;

        const fs = `
            precision mediump float;

            varying vec2 vTexcoord;
            uniform sampler2D videoTexture;

            void main() {
                gl_FragColor =
                    texture2D(videoTexture, vTexcoord);
            }
        `;

        const vertexShader =
            this.compileShader(gl.VERTEX_SHADER, vs);

        const fragmentShader =
            this.compileShader(gl.FRAGMENT_SHADER, fs);

        this.program = this.createProgram(
            vertexShader,
            fragmentShader
        );

        // Quad vertices
        const positions = new Float32Array([
            -1,  0.56, -3,
             1,  0.56, -3,
            -1, -0.56, -3,

             1,  0.56, -3,
             1, -0.56, -3,
            -1, -0.56, -3
        ]);

        const texcoords = new Float32Array([
            0,0,
            1,0,
            0,1,

            1,0,
            1,1,
            0,1
        ]);

        this.positionBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.positionBuffer);
        gl.bufferData(
            gl.ARRAY_BUFFER,
            positions,
            gl.STATIC_DRAW
        );

        this.texcoordBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.texcoordBuffer);
        gl.bufferData(
            gl.ARRAY_BUFFER,
            texcoords,
            gl.STATIC_DRAW
        );

        this.texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, this.texture);

        gl.texParameteri(
            gl.TEXTURE_2D,
            gl.TEXTURE_MIN_FILTER,
            gl.LINEAR
        );

        gl.texParameteri(
            gl.TEXTURE_2D,
            gl.TEXTURE_MAG_FILTER,
            gl.LINEAR
        );
    }

    onXRFrame(time, frame) {
        const session = frame.session;
        const gl = this.gl;

        session.requestAnimationFrame(
            this.onXRFrame.bind(this)
        );

        const pose =
            frame.getViewerPose(this.xrRefSpace);

        if (!pose) return;

        const layer = session.renderState.baseLayer;

        gl.bindFramebuffer(
            gl.FRAMEBUFFER,
            layer.framebuffer
        );

        gl.clearColor(0, 0, 0, 1);
        gl.clear(
            gl.COLOR_BUFFER_BIT |
            gl.DEPTH_BUFFER_BIT
        );

        gl.useProgram(this.program);

        // Update video texture
        gl.bindTexture(gl.TEXTURE_2D, this.texture);

        if (this.video.readyState >= 2) {
            gl.texImage2D(
                gl.TEXTURE_2D,
                0,
                gl.RGBA,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                this.video
            );
        }

        for (const view of pose.views) {
            const viewport =
                layer.getViewport(view);

            gl.viewport(
                viewport.x,
                viewport.y,
                viewport.width,
                viewport.height
            );

            const projectionLoc =
                gl.getUniformLocation(
                    this.program,
                    "projectionMatrix"
                );

            const viewLoc =
                gl.getUniformLocation(
                    this.program,
                    "viewMatrix"
                );

            const modelLoc =
                gl.getUniformLocation(
                    this.program,
                    "modelMatrix"
                );

            gl.uniformMatrix4fv(
                projectionLoc,
                false,
                view.projectionMatrix
            );

            gl.uniformMatrix4fv(
                viewLoc,
                false,
                view.transform.inverse.matrix
            );

            gl.uniformMatrix4fv(
                modelLoc,
                false,
                new Float32Array([
                    1,0,0,0,
                    0,1,0,0,
                    0,0,1,0,
                    0,0,0,1
                ])
            );

            const posLoc =
                gl.getAttribLocation(
                    this.program,
                    "position"
                );

            gl.bindBuffer(
                gl.ARRAY_BUFFER,
                this.positionBuffer
            );

            gl.vertexAttribPointer(
                posLoc,
                3,
                gl.FLOAT,
                false,
                0,
                0
            );

            gl.enableVertexAttribArray(posLoc);

            const texLoc =
                gl.getAttribLocation(
                    this.program,
                    "texcoord"
                );

            gl.bindBuffer(
                gl.ARRAY_BUFFER,
                this.texcoordBuffer
            );

            gl.vertexAttribPointer(
                texLoc,
                2,
                gl.FLOAT,
                false,
                0,
                0
            );

            gl.enableVertexAttribArray(texLoc);

            gl.drawArrays(gl.TRIANGLES, 0, 6);
        }
    }

    compileShader(type, source) {
        const shader = this.gl.createShader(type);

        this.gl.shaderSource(shader, source);
        this.gl.compileShader(shader);

        return shader;
    }

    createProgram(vs, fs) {
        const program = this.gl.createProgram();

        this.gl.attachShader(program, vs);
        this.gl.attachShader(program, fs);
        this.gl.linkProgram(program);

        return program;
    }
}