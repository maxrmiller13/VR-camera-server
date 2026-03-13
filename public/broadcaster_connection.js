// Connect client (socket) to server
const socket = io();
// Get video element
const video = document.getElementById("video");

// create viewers array
const peers = {};

// tell server this client is the broadcaster
socket.emit("broadcaster");

// get camera (change to raspberry pi)
navigator.mediaDevices.getUserMedia({
        video: {
            width: { ideal: 1920 },
            height: { ideal: 1080 },
            frameRate: { ideal: 30 }
        },
        audio: false
    })
.then(stream => {
    // assign video object the camera stream to ensure it's working
    video.srcObject = stream;

    console.log(stream.getVideoTracks()[0].getSettings());

    // when server forwards viewer id
    socket.on("viewer", id => {

        const pc = new RTCPeerConnection({
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
        });

        peers[id] = pc;

        stream.getTracks().forEach(track => {
            pc.addTrack(track, stream);
            console.log("adding track", track.kind);
        });

        pc.onicecandidate = event => {
            if (event.candidate) {
                socket.emit("candidate", id, event.candidate);
            }
        };

        pc.createOffer()
        .then(sdp => pc.setLocalDescription(sdp))
        .then(() => {
            socket.emit("offer", id, pc.localDescription);
        });

    });

});

// when server forwards viewer answer, connect the remote description
socket.on("answer", (id, description) => {
    peers[id].setRemoteDescription(description);
});

socket.on("candidate", (id, candidate) => {
    peers[id].addIceCandidate(new RTCIceCandidate(candidate));
});