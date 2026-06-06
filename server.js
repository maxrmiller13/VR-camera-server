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

    socket.on("offer", (id, description) => {
        io.to(id).emit("offer", socket.id, description);
    });

    socket.on("answer", (id, description) => {
        io.to(id).emit("answer", socket.id, description);
    });

    socket.on("candidate", (id, candidate) => {
        io.to(id).emit("candidate", socket.id, candidate);
    });

    socket.on("disconnect", () => {
        socket.broadcast.emit("disconnectPeer", socket.id);
        console.log("client disconnected");
    });
});

server.listen(3000, () => {
    console.log("Server running on https://localhost:3000");
});