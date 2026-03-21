const https = require("https");

function httpsGetJson(urlStr, headers) {
  return new Promise(function (resolve, reject) {
    const u = new URL(urlStr);
    const opts = {
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: "GET",
      headers: headers,
    };
    const req = https.request(opts, function (res) {
      var data = "";
      res.on("data", function (c) {
        data += c;
      });
      res.on("end", function () {
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          text: function () {
            return Promise.resolve(data);
          },
        });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

/**
 * GET JSON a api.mercadopago.com con código HTTP explícito.
 */
async function mpGetJsonWithStatus(urlStr, token) {
  const headers = {
    Authorization: "Bearer " + token,
    "Content-Type": "application/json",
  };
  let res;
  if (typeof fetch === "function") {
    res = await fetch(urlStr, { method: "GET", headers: headers });
  } else {
    res = await httpsGetJson(urlStr, headers);
  }
  const text = await res.text();
  const status = res.status;
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (_) {
    json = { parseError: true, rawPreview: text.slice(0, 500) };
  }
  if (!res.ok) {
    const err = new Error("Mercado Pago API HTTP " + status);
    err.status = status;
    err.body = json;
    throw err;
  }
  return { status: status, json: json };
}

module.exports = {
  mpGetJsonWithStatus,
};
