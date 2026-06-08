const socket = io();   // auto-connects to the Pi server that served this page
const video = document.getElementById("video");
video.muted = true;

let pc;

// Announce ourselves to the server so the Pi knows to send us an offer
socket.emit("viewer");

// ─────────────────────────────────────────────────────────────────
// Incoming offer from the Pi (via server relay)
// ─────────────────────────────────────────────────────────────────
socket.on("offer", (id, description) => {

    pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });

    // ── Display the incoming video stream ──
    pc.ontrack = event => {
        if (event.streams?.[0]) {
            video.srcObject = event.streams[0];
            console.log("Video stream attached");
        }
    };

    // ── Optional: Pi may also open a data channel ──
    pc.ondatachannel = event => {
        event.channel.onopen = () => console.log("Data channel open");
        event.channel.onmessage = msg => console.log("Pi says:", msg.data);
    };

    // ── Send our ICE candidates to the Pi via the server ──
    pc.onicecandidate = event => {
        if (event.candidate) {
            socket.emit("candidate", id, event.candidate);
        }
    };

    // NOTE: these are the correct browser WebRTC property names.
    // (onGatheringStateChange / onSignalingStateChange are node-datachannel
    //  APIs and will throw in a browser.)
    pc.oniceconnectionstatechange = () =>
        console.log("ICE state:", pc.iceConnectionState);

    pc.onsignalingstatechange = () =>
        console.log("Signaling state:", pc.signalingState);

    // ── Accept offer → build answer → send back ──
    pc.setRemoteDescription(new RTCSessionDescription(description))
        .then(() => pc.createAnswer())
        .then(sdp => pc.setLocalDescription(sdp))
        .then(() => {
            socket.emit("answer", id, pc.localDescription);
            console.log("Answer sent");
        })
        .catch(err => console.error("SDP negotiation failed:", err));
});

// ─────────────────────────────────────────────────────────────────
// ICE candidates trickling in from the Pi
// ─────────────────────────────────────────────────────────────────
socket.on("candidate", async (id, candidate) => {
    if (!pc) return;
    try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
        console.error("addIceCandidate failed:", err);
    }
});

// ─────────────────────────────────────────────────────────────────
// Pi disconnected
// ─────────────────────────────────────────────────────────────────
socket.on("disconnectPeer", () => {
    if (pc) {
        pc.close();
        pc = null;
        video.srcObject = null;
        console.log("Camera disconnected");
    }
});