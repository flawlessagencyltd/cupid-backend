// Container entrypoint — wraps the 6 onRequest handlers into one Express app.
const express = require("express");
const handlers = require("./index.js");

const app = express();
app.use(express.json({ limit: "1mb" }));

app.all(["/config", "/api/config"], handlers.config);
app.all(["/chat", "/api/chat"], handlers.chat);
app.all(["/visited", "/api/visited"], handlers.visited);
app.all(["/report", "/api/report"], handlers.report);
app.all(["/geo", "/api/geo"], handlers.geo);
app.all(["/pixel", "/api/pixel"], handlers.pixel);
app.get("/", (req, res) => res.status(200).send("ok"));

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`cupid backend listening on ${port}`));
