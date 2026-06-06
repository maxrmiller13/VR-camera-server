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

let cameraSender;

io.on("connection", socket => {

    console.log("Connected:", socket.id);

    socket.on("cameraSender", () => {
        cameraSender = socket.id;
        console.log("Camera sender connected");
    });

    socket.on("viewer", () => {
        console.log("Viewer connected");

        if (cameraSender) {
            io.to(cameraSender).emit("viewer", socket.id);
        }
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