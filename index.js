const express = require("express");
const app = express();

const SECRET = process.env.PROXY_SECRET || "";

app.get("/fetch", async (req, res) => {
  try {
    if (SECRET) {
      const token = req.headers["x-proxy-secret"] || req.query.token;
      if (!token || token !== SECRET) return res.status(401).send("Unauthorized");
    }

    const url = req.query.url;
    if (!url) return res.status(400).send("Missing url");

    const upstream = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Referer": "https://www.acbl.org/"
      }
    });

    const text = await upstream.text();
    res.status(upstream.status).send(text);
  } catch (e) {
    res.status(500).send(String(e));
  }
});

app.get("/", (_req, res) => {
  res.type("text/plain").send("OK. Use /fetch?url=https%3A%2F%2Fexample.com");
});

const port = process.env.PORT || 8080;
// Important for Cloud Run: listen on 0.0.0.0
app.listen(port, "0.0.0.0", () => console.log("Proxy listening on", port));
