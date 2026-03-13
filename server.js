const express = require("express");
const https = require("https");
const fs = require("fs");
const { Server } = require("socket.io");

const httpsOptions = {
  key: fs.readFileSync("key.pem"),
  cert: fs.readFileSync("cert.pem")
};

const app = express();
const server = https.createServer(httpsOptions, app);
const io = new Server(server);

app.use(express.static("public"));

let broadcaster;

// Connect a client
io.on("connection", socket => {

    // assign broadcaster (cam) it's id
    socket.on("broadcaster", () => {
        broadcaster = socket.id;
        console.log("Broadcaster connected")
    });

    // when viewer connects, pass it's ID to broadcaster
    socket.on("viewer", () => {
        if (broadcaster) {
            io.to(broadcaster).emit("viewer", socket.id);
            console.log("Viewer connected")
        }
    });

    // Forward offer to target id with message
    socket.on("offer", (id, message) => {
        io.to(id).emit("offer", socket.id, message);
        console.log("Offer sent")
    });

    // Forward answer to target id with message
    socket.on("answer", (id, message) => {
        io.to(id).emit("answer", socket.id, message);
        console.log("Answer sent")
    });

    // Forward candidate to target id with message
    socket.on("candidate", (id, message) => {
        io.to(id).emit("candidate", socket.id, message);
        console.log("candidate sent")
    });

    // Forward disconnect to target id with message
    socket.on("disconnect", () => {
        socket.broadcast.emit("disconnectPeer", socket.id);
        console.log("client disconnected")
    });

});

server.listen(3000, () => {
    console.log("Server running on https://localhost:3000");
});