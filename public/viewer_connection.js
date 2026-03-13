const socket = io();
const video = document.getElementById("video");
video.muted = true;

let pc;

// Tell server a viewer has connected
socket.emit("viewer");

// When broadcaster sends a connection offer through server
socket.on("offer", (id, description) => {
    // create a connection between broadcaster and viewer
    pc = new RTCPeerConnection({
        iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });

    pc.ontrack = event => {
        video.srcObject = event.streams[0];
        console.log("track received");
    };

    pc.onicecandidate = event => {
        if (event.candidate) {
            socket.emit("candidate", id, event.candidate);
        }
    };

    pc.setRemoteDescription(description)
    .then(() => pc.createAnswer())
    .then(sdp => pc.setLocalDescription(sdp))
    .then(() => {
        socket.emit("answer", id, pc.localDescription);
    });

});

socket.on("candidate", (id, candidate) => {
    pc.addIceCandidate(new RTCIceCandidate(candidate));
});